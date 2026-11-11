import { DefaultAzureCredential } from "@azure/identity";
import { getBlobService, getDocumentsTable, getJobQueue, getJobsTable } from "./azure";
import { config } from "./config";
import { createWorkbook } from "./excel";

const credential = new DefaultAzureCredential();

class FallbackToQueueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FallbackToQueueError";
  }
}

type StoredDoc = Record<string, unknown> & {
  partitionKey?: string;
  rowKey?: string;
};

export async function runDirectOcrJob(jobId: string, ownerId: string, tenantId: string): Promise<void> {
  const endpoint = process.env.DOCUMENT_INTELLIGENCE_ENDPOINT;
  if (!endpoint) {
    await fallbackToQueue(jobId, ownerId, tenantId);
    return;
  }

  const jobsTable = getJobsTable();
  const documentsTable = getDocumentsTable();
  const blobService = getBlobService();
  const incomingContainer = blobService.getContainerClient(config.documentsContainer);
  const outputsContainer = blobService.getContainerClient(config.outputsContainer);
  const apiVersion = process.env.DOCUMENT_INTELLIGENCE_API_VERSION ?? "2024-11-30";
  const modelId = process.env.DOCUMENT_INTELLIGENCE_MODEL_ID ?? "prebuilt-layout";

  try {
    const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
    if (!token?.token) throw new FallbackToQueueError("Could not acquire Document Intelligence token.");

    const docs: StoredDoc[] = [];
    const safeJobId = jobId.replaceAll("'", "''");
    const safeOwner = ownerId.replaceAll("'", "''");
    const safeTenant = tenantId.replaceAll("'", "''");
    for await (const doc of documentsTable.listEntities<StoredDoc>({
      queryOptions: { filter: `PartitionKey eq '${safeJobId}' and OwnerId eq '${safeOwner}' and TenantId eq '${safeTenant}'` }
    })) {
      docs.push(doc);
    }

    let completed = 0;
    let failed = 0;

    for (let offset = 0; offset < docs.length; offset += 3) {
      const batch = docs.slice(offset, offset + 3);
      await Promise.all(batch.map(async (doc) => {
        const documentId = String(doc.DocumentId ?? doc.rowKey ?? "");
        const blobName = String(doc.BlobName ?? "");
        const originalName = String(doc.OriginalName ?? "document");
        try {
          await documentsTable.updateEntity({
            partitionKey: jobId,
            rowKey: documentId,
            Status: "processing"
          }, "Merge");

          const sourceBytes = await incomingContainer.getBlobClient(blobName).downloadToBuffer();
          const analyze = await analyzeDocumentWithContentUnderstandingOrDi(
            endpoint,
            modelId,
            apiVersion,
            sourceBytes,
            token.token
          );

          const pageCount = Array.isArray(analyze.pages) ? analyze.pages.length : 0;
          const tableData = Array.isArray(analyze.tables) ? analyze.tables as Array<Record<string, unknown>> : [];
          const warnings = evaluateQualityWarnings(analyze, tableData);
          const workbook = await createWorkbook(tableData, originalName);
          const allWarnings = [...new Set([...warnings, ...workbook.warnings])];
          const rawMarkdown = String(analyze.content ?? "");
          const markdown = await refineMarkdownWithLlm(endpoint, rawMarkdown, token.token);
          const prefix = `${jobId}/${documentId}`;

          const entries: Array<[string, Buffer | string, string]> = [
            ["tables.xlsx", workbook.buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
            ["content.md", markdown, "text/markdown; charset=utf-8"]
          ];

          await Promise.all(entries.map(([name, content, contentType]) =>
            outputsContainer.getBlockBlobClient(`${prefix}/document.${name}`).upload(content, Buffer.byteLength(content), {
              blobHTTPHeaders: { blobContentType: contentType }
            })
          ));

          const status = allWarnings.length ? "review" : "completed";
          await documentsTable.updateEntity({
            partitionKey: jobId,
            rowKey: documentId,
            Status: status,
            PageCount: pageCount,
            TableCount: tableData.length,
            Warning: allWarnings.join("; "),
            Outputs: JSON.stringify(entries.map(([name]) => name)),
            CompletedAt: new Date().toISOString()
          }, "Merge");
          completed++;
        } catch (error) {
          if (error instanceof FallbackToQueueError) throw error;
          failed++;
          await documentsTable.updateEntity({
            partitionKey: jobId,
            rowKey: documentId,
            Status: "failed",
            Warning: error instanceof Error ? error.message.slice(0, 500) : "Eroare la procesarea OCR."
          }, "Merge");
        }
      }));
    }

    await jobsTable.updateEntity({
      partitionKey: "owner",
      rowKey: `${ownerId}:${jobId}`,
      Status: failed ? (completed ? "review" : "failed") : "completed",
       SubmissionState: "completed",
      CompletedCount: completed,
      FailedCount: failed,
      LastActivityAt: new Date().toISOString()
    }, "Merge");
  } catch (error) {
    if (error instanceof FallbackToQueueError) {
      await fallbackToQueue(jobId, ownerId, tenantId);
      return;
    }
    await jobsTable.updateEntity({
      partitionKey: "owner",
      rowKey: `${ownerId}:${jobId}`,
      Status: "failed",
      SubmissionError: error instanceof Error ? error.message.slice(0, 500) : "Direct OCR processing failed.",
      LastActivityAt: new Date().toISOString()
    }, "Merge");
  }
}

type CuContentItem = {
  markdown?: string;
  pages?: Array<Record<string, unknown>>;
  tables?: Array<Record<string, unknown>>;
};

type CuAnalyzeResponse = {
  status?: string;
  result?: {
    warnings?: Array<{ code?: string }>;
    contents?: CuContentItem[];
  };
  error?: { message?: string };
};

async function analyzeDocumentWithContentUnderstandingOrDi(
  endpoint: string,
  modelId: string,
  diApiVersion: string,
  sourceBytes: Buffer,
  accessToken: string
): Promise<Record<string, unknown>> {
  const baseEndpoint = endpoint.replace(/\/$/, "");
  const cuApiVersion = process.env.CONTENT_UNDERSTANDING_API_VERSION ?? "2026-06-01-preview";

  try {
    const inlineUrl = new URL(`${baseEndpoint}/contentunderstanding/analyzers/${modelId}:analyzeBinaryInline`);
    inlineUrl.searchParams.set("api-version", cuApiVersion);

    const inlineResponse = await fetch(inlineUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/octet-stream"
      },
      body: new Uint8Array(sourceBytes)
    });

    if (inlineResponse.status === 401 || inlineResponse.status === 403) {
      throw new FallbackToQueueError(`Content Understanding returned HTTP ${inlineResponse.status}.`);
    }

    if (inlineResponse.ok) {
      const cuPayload = await inlineResponse.json() as CuAnalyzeResponse;
      const truncated = cuPayload.result?.warnings?.some((w) => w.code === "InputExceededLimit");
      const normalized = normalizeCuResult(cuPayload);
      if (!truncated && (String(normalized.content ?? "").trim() || (Array.isArray(normalized.tables) && normalized.tables.length > 0))) {
        return normalized;
      }
    }

    const asyncCuUrl = new URL(`${baseEndpoint}/contentunderstanding/analyzers/${modelId}:analyzeBinary`);
    asyncCuUrl.searchParams.set("api-version", cuApiVersion);
    const asyncCuResponse = await fetch(asyncCuUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/octet-stream"
      },
      body: new Uint8Array(sourceBytes)
    });
    if (asyncCuResponse.status === 202) {
      const cuOpLocation = asyncCuResponse.headers.get("operation-location");
      if (cuOpLocation) {
        return await pollCuOperation(cuOpLocation, accessToken);
      }
    }
  } catch (error) {
    if (error instanceof FallbackToQueueError) throw error;
  }

  const analyzeUrl = new URL(`${baseEndpoint}/documentintelligence/documentModels/${modelId}:analyze`);
  analyzeUrl.searchParams.set("api-version", diApiVersion);
  analyzeUrl.searchParams.set("outputContentFormat", "markdown");

  const submitResponse = await fetch(analyzeUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({ base64Source: sourceBytes.toString("base64") })
  });

  if (submitResponse.status === 401 || submitResponse.status === 403) {
    throw new FallbackToQueueError(`Document Intelligence returned HTTP ${submitResponse.status}.`);
  }
  if (submitResponse.status !== 202) {
    throw new Error(`Serviciul OCR a respins documentul (HTTP ${submitResponse.status}).`);
  }

  const operationLocation = submitResponse.headers.get("operation-location");
  if (!operationLocation) {
    throw new Error("Răspunsul OCR nu conține Operation-Location.");
  }

  return await pollSingleDocumentOperation(operationLocation, accessToken);
}

function normalizeCuResult(payload: CuAnalyzeResponse): Record<string, unknown> {
  const contents = Array.isArray(payload.result?.contents) ? payload.result!.contents : [];
  const markdownParts: string[] = [];
  const pages: Array<Record<string, unknown>> = [];
  const tables: Array<Record<string, unknown>> = [];

  for (const item of contents) {
    if (typeof item.markdown === "string" && item.markdown.trim()) {
      markdownParts.push(item.markdown);
    }
    if (Array.isArray(item.pages)) {
      pages.push(...item.pages);
    }
    if (Array.isArray(item.tables)) {
      tables.push(...item.tables);
    }
  }

  return {
    content: markdownParts.join("\n\n"),
    pages,
    tables
  };
}

async function pollCuOperation(operationLocation: string, accessToken: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const response = await fetch(operationLocation, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
      throw new Error(`Interogarea stării Content Understanding a eșuat (HTTP ${response.status}).`);
    }
    const payload = await response.json() as CuAnalyzeResponse;
    const state = (payload.status ?? "").toLowerCase();
    if (state === "succeeded") {
      return normalizeCuResult(payload);
    }
    if (state === "failed" || state === "canceled") {
      throw new Error(payload.error?.message ?? "Analiza Content Understanding a eșuat.");
    }
  }
  throw new Error("Timpul de așteptare pentru analiza Content Understanding a expirat.");
}

export async function refineMarkdownWithLlm(
  endpoint: string,
  rawMarkdown: string,
  accessToken: string
): Promise<string> {
  const deployment = process.env.OPENAI_DEPLOYMENT_NAME;
  if (!deployment || !rawMarkdown.trim() || rawMarkdown.length > 60_000) {
    return rawMarkdown;
  }
  const openAiApiVersion = process.env.OPENAI_API_VERSION ?? "2024-10-21";
  const url = new URL(`${endpoint.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`);
  url.searchParams.set("api-version", openAiApiVersion);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: [
              "Ești un expert în post-procesare OCR și reconstrucție fidelă de documente în limba română (și engleză).",
              "Primești textul Markdown extras prin OCR dintr-un document scanat sau dintr-o captură de ecran.",
              "Reguli stricte:",
              "1. Corectează erorile tipice de recunoaștere optică a caracterelor (ex. litere confundate optic în cuvinte românești precum 'tranimisă' -> 'transmisă', 'diapăgubirea' -> 'despăgubirea', 'prejuSci caurate' -> 'prejudicii cauzate', 'turnirorul' -> 'furnizorul', 'conversagia și continiaana cencetani' -> 'conversația și continuarea cercetării', diacritice corupte sau ani evident corupți optic în serii cronologice identice).",
              "2. Elimină artefactele parazite izolate provenite din pictograme/butoane UI la capturile de ecran (ex. linii cu un singur simbol fără sens precum '\\* \\+', 'Ø', '®', '<figure>1</figure>'), dar păstrează integral tot conținutul util.",
              "3. NU rezuma, NU omite paragrafe, NU modifica niciodată sumele financiare, codurile de caz, numerele de decizii/legi sau structura și celulele tabelelor Markdown.",
              "4. Returnează EXCLUSIV conținutul Markdown curățat, fără explicații și fără blocuri ```markdown."
            ].join("\n")
          },
          {
            role: "user",
            content: rawMarkdown
          }
        ]
      }),
      signal: AbortSignal.timeout(45_000)
    });

    if (!response.ok) return rawMarkdown;
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const cleaned = data.choices?.[0]?.message?.content?.trim();
    if (!cleaned) return rawMarkdown;
    return cleaned.replace(/^```(?:markdown|md)?\r?\n/i, "").replace(/\r?\n```$/i, "").trim();
  } catch {
    return rawMarkdown;
  }
}

async function pollSingleDocumentOperation(operationLocation: string, accessToken: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 90; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 800));
    const response = await fetch(operationLocation, {
      headers: { authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) {
      throw new Error(`Interogarea stării OCR a eșuat (HTTP ${response.status}).`);
    }
    const payload = await response.json() as {
      status?: string;
      analyzeResult?: Record<string, unknown>;
      error?: { message?: string };
    };
    const state = (payload.status ?? "").toLowerCase();
    if (state === "succeeded") {
      return payload.analyzeResult ?? {};
    }
    if (state === "failed" || state === "canceled") {
      throw new Error(payload.error?.message ?? "Analiza OCR a eșuat.");
    }
  }
  throw new Error("Timpul de așteptare pentru analiza OCR a expirat.");
}

function evaluateQualityWarnings(analyze: Record<string, unknown>, tables: Array<Record<string, unknown>>): string[] {
  const warnings: string[] = [];
  if (!String(analyze.content ?? "").trim()) warnings.push("Nu a fost recunoscut text.");
  const pages = Array.isArray(analyze.pages) ? analyze.pages as Array<Record<string, unknown>> : [];
  let confidenceSum = 0;
  let confidenceCount = 0;
  for (const page of pages) {
    const words = Array.isArray(page.words) ? page.words as Array<Record<string, unknown>> : [];
    for (const word of words) {
      const conf = Number(word.confidence);
      if (Number.isFinite(conf)) {
        confidenceSum += conf;
        confidenceCount++;
      }
    }
  }
  if (confidenceCount > 0 && confidenceSum / confidenceCount < 0.75) {
    warnings.push("Încredere OCR scăzută; verificați manual valorile extrase.");
  }
  for (const [index, table] of tables.entries()) {
    const rows = Number(table.rowCount ?? 0);
    const columns = Number(table.columnCount ?? 0);
    const cells = (table.cells ?? []) as Array<Record<string, unknown>>;
    if (!rows || !columns || cells.some((cell) => Number(cell.rowIndex) >= rows || Number(cell.columnIndex) >= columns)) {
      warnings.push(`Structură de tabel incorectă la tabelul ${index + 1}.`);
    }
  }
  return warnings;
}

async function fallbackToQueue(jobId: string, ownerId: string, tenantId: string): Promise<void> {
  const jobsTable = getJobsTable();
  const documentsTable = getDocumentsTable();
  const safeJobId = jobId.replaceAll("'", "''");
  for await (const doc of documentsTable.listEntities<StoredDoc>({
    queryOptions: { filter: `PartitionKey eq '${safeJobId}'` }
  })) {
    if (doc.Status === "processing") {
      await documentsTable.updateEntity({
        partitionKey: jobId,
        rowKey: String(doc.DocumentId ?? doc.rowKey ?? ""),
        Status: "queued"
      }, "Merge");
    }
  }
  await jobsTable.updateEntity({
    partitionKey: "owner",
    rowKey: `${ownerId}:${jobId}`,
    Status: "queued",
    SubmissionState: "",
    QueueMessageSentAt: new Date().toISOString()
  }, "Merge");
  await getJobQueue().sendMessage(JSON.stringify({ jobId, ownerId, tenantId }));
}
