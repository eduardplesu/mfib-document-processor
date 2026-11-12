import { DefaultAzureCredential } from "@azure/identity";
import { getBlobService, getDocumentsTable, getJobQueue, getJobsTable } from "./azure";
import { config } from "./config";
import {
  buildSystemPromptForPageType,
  detectPageDocumentType,
  isLlmPageOutputComplete,
  repairPageMarkdownDeterministic,
  stripRepeatedRunningHeaders
} from "./page-types";

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
          const contentType = String(doc.ContentType ?? "").toLowerCase();
          const analyze = await analyzeDocumentWithContentUnderstandingOrDi(
            endpoint,
            modelId,
            apiVersion,
            sourceBytes,
            contentType,
            originalName,
            token.token
          );

          const pageCount = Array.isArray(analyze.pages) ? analyze.pages.length : 0;
          const rawTables = Array.isArray(analyze.tables) ? analyze.tables as Array<Record<string, unknown>> : [];
          const rawMarkdown = String(analyze.content ?? "");
          const markdown = await refineMarkdownWithLlm(endpoint, rawMarkdown, sourceBytes, contentType, originalName, token.token);
          const warnings = evaluateQualityWarnings(analyze, rawTables);
          const prefix = `${jobId}/${documentId}`;

          const entries: Array<[string, Buffer | string, string]> = [
            ["content.md", markdown, "text/markdown; charset=utf-8"]
          ];

          await Promise.all(entries.map(([name, content, mime]) =>
            outputsContainer.getBlockBlobClient(`${prefix}/document.${name}`).upload(content, Buffer.byteLength(content), {
              blobHTTPHeaders: { blobContentType: mime }
            })
          ));

          const status = warnings.length ? "review" : "completed";
          await documentsTable.updateEntity({
            partitionKey: jobId,
            rowKey: documentId,
            Status: status,
            PageCount: pageCount,
            TableCount: rawTables.length,
            Warning: warnings.join("; "),
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
  contentType: string,
  originalName: string,
  accessToken: string
): Promise<Record<string, unknown>> {
  const baseEndpoint = endpoint.replace(/\/$/, "");
  const cuApiVersion = process.env.CONTENT_UNDERSTANDING_API_VERSION ?? "2026-06-01-preview";
  const isSingleImage = Boolean(resolveVisionMimeType(contentType, originalName));

  try {
    if (isSingleImage) {
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
        const normalized = normalizeCuResult(cuPayload);
        if (String(normalized.content ?? "").trim() || (Array.isArray(normalized.tables) && normalized.tables.length > 0)) {
          return normalized;
        }
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
    if (asyncCuResponse.status === 401 || asyncCuResponse.status === 403) {
      throw new FallbackToQueueError(`Content Understanding returned HTTP ${asyncCuResponse.status}.`);
    }
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
  for (let attempt = 0; attempt < 750; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 20 ? 1000 : 2000));
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
  sourceBytes?: Buffer,
  contentType?: string,
  originalName?: string,
  accessToken?: string
): Promise<string> {
  if (!rawMarkdown.trim()) return rawMarkdown;
  const deployment = process.env.OPENAI_DEPLOYMENT_NAME;
  const splitPages = rawMarkdown
    .split(/<!--\s*PageBreak\s*-->/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const rawPages = stripRepeatedRunningHeaders(splitPages);

  if (!deployment || !accessToken) {
    return rawPages
      .map((p) => repairPageMarkdownDeterministic(p, detectPageDocumentType(p)))
      .filter((p) => p.length > 0)
      .join("\n\n---\n\n");
  }

  const imageMime = resolveVisionMimeType(contentType ?? "", originalName ?? "");
  const includeVision = Boolean(
    rawPages.length === 1 &&
    imageMime &&
    sourceBytes &&
    sourceBytes.byteLength > 0 &&
    sourceBytes.byteLength <= 15 * 1024 * 1024
  );

  const refinedPages = new Array<string>(rawPages.length);
  const concurrency = 4;

  for (let offset = 0; offset < rawPages.length; offset += concurrency) {
    const indexes = Array.from(
      { length: Math.min(concurrency, rawPages.length - offset) },
      (_, idx) => offset + idx
    );
    await Promise.all(
      indexes.map(async (pageIndex) => {
        const pageText = rawPages[pageIndex];
        refinedPages[pageIndex] = await refineSinglePageWithLlm(
          endpoint,
          deployment,
          pageText,
          pageIndex + 1,
          rawPages.length,
          includeVision ? { mime: imageMime!, bytes: sourceBytes! } : undefined,
          accessToken
        );
      })
    );
  }

  return refinedPages.filter((p) => p.trim().length > 0).join("\n\n---\n\n");
}

async function refineSinglePageWithLlm(
  endpoint: string,
  deployment: string,
  rawPage: string,
  pageNumber: number,
  totalPages: number,
  visionImage: { mime: string; bytes: Buffer } | undefined,
  accessToken: string
): Promise<string> {
  const pageType = detectPageDocumentType(rawPage);
  const deterministicPage = repairPageMarkdownDeterministic(rawPage, pageType);
  if (!deterministicPage) return "";

  const shouldCallLlm =
    Boolean(visionImage) ||
    (pageType !== "complex_merged_table" &&
      deterministicPage.length <= 3500 &&
      (totalPages <= 6 ||
        (pageType === "entity_and_table_form" && pageNumber <= 3)));

  if (!shouldCallLlm) {
    return deterministicPage;
  }

  const systemPrompt = buildSystemPromptForPageType(pageType, pageNumber, totalPages, Boolean(visionImage));
  const openAiApiVersion = process.env.OPENAI_API_VERSION ?? "2024-10-21";
  const url = new URL(`${endpoint.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`);
  url.searchParams.set("api-version", openAiApiVersion);

  const userContent = visionImage
    ? [
        {
          type: "image_url",
          image_url: {
            url: `data:${visionImage.mime};base64,${visionImage.bytes.toString("base64")}`,
            detail: "high"
          }
        },
        {
          type: "text",
          text: deterministicPage
        }
      ]
    : deterministicPage;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent }
        ]
      }),
      signal: AbortSignal.timeout(45_000)
    });

    if (!response.ok) return deterministicPage;
    const data = await response.json() as {
      choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
    };
    const choice = data.choices?.[0];
    if (choice?.finish_reason === "length") {
      return deterministicPage;
    }
    const cleaned = choice?.message?.content?.trim();
    if (!cleaned) return deterministicPage;
    const normalized = cleanRawPageMarkdown(
      cleaned
        .replace(/^```(?:markdown|md|html)?\r?\n/i, "")
        .replace(/\r?\n```$/i, "")
    );
    if (!visionImage && !isLlmPageOutputComplete(deterministicPage, normalized)) {
      return deterministicPage;
    }
    return normalized;
  } catch {
    return deterministicPage;
  }
}

export function cleanRawPageMarkdown(pageMarkdown: string): string {
  return repairPageMarkdownDeterministic(pageMarkdown, detectPageDocumentType(pageMarkdown));
}

function resolveVisionMimeType(contentType: string, filename: string): string | null {
  if (contentType === "image/png" || filename.toLowerCase().endsWith(".png")) return "image/png";
  if (contentType === "image/jpeg" || /\.jpe?g$/i.test(filename)) return "image/jpeg";
  return null;
}

export function parseHtmlTablesFromMarkdown(markdown: string): Array<Record<string, unknown>> {
  const tables: Array<Record<string, unknown>> = [];
  const tableRegex = /<table\b[^>]*>([\s\S]*?)<\/table>/gi;
  let tableMatch: RegExpExecArray | null;

  while ((tableMatch = tableRegex.exec(markdown)) !== null) {
    const tableBody = tableMatch[1];
    const rowRegex = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    const rawRows: Array<Array<{ content: string; rowSpan: number; columnSpan: number }>> = [];
    let rowMatch: RegExpExecArray | null;

    while ((rowMatch = rowRegex.exec(tableBody)) !== null) {
      const rowHtml = rowMatch[1];
      const cellRegex = /<(?:td|th)\b([^>]*)>([\s\S]*?)<\/(?:td|th)>/gi;
      const rowCells: Array<{ content: string; rowSpan: number; columnSpan: number }> = [];
      let cellMatch: RegExpExecArray | null;

      while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
        const attrs = cellMatch[1] ?? "";
        const innerHtml = cellMatch[2] ?? "";
        const rowSpanMatch = /\browspan\s*=\s*["']?(\d+)/i.exec(attrs);
        const colSpanMatch = /\bcolspan\s*=\s*["']?(\d+)/i.exec(attrs);
        const rowSpan = rowSpanMatch ? Math.max(1, Number(rowSpanMatch[1])) : 1;
        const columnSpan = colSpanMatch ? Math.max(1, Number(colSpanMatch[1])) : 1;
        const text = decodeHtmlEntities(
          innerHtml
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .trim()
        );
        rowCells.push({ content: text, rowSpan, columnSpan });
      }
      if (rowCells.length > 0) {
        rawRows.push(rowCells);
      }
    }

    if (rawRows.length === 0) continue;

    const occupied = new Set<string>();
    const cells: Array<Record<string, unknown>> = [];
    let maxRow = 0;
    let maxCol = 0;

    for (let r = 0; r < rawRows.length; r++) {
      let c = 0;
      for (const cell of rawRows[r]) {
        while (occupied.has(`${r}:${c}`)) c++;
        for (let dr = 0; dr < cell.rowSpan; dr++) {
          for (let dc = 0; dc < cell.columnSpan; dc++) {
            occupied.add(`${r + dr}:${c + dc}`);
          }
        }
        maxRow = Math.max(maxRow, r + cell.rowSpan);
        maxCol = Math.max(maxCol, c + cell.columnSpan);
        cells.push({
          rowIndex: r,
          columnIndex: c,
          rowSpan: cell.rowSpan,
          columnSpan: cell.columnSpan,
          content: cell.content
        });
        c += cell.columnSpan;
      }
    }

    if (maxRow > 0 && maxCol > 0) {
      tables.push({
        pageNumber: 1,
        rowCount: maxRow,
        columnCount: maxCol,
        cells
      });
    }
  }

  return tables;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/gi, "'");
}

async function pollSingleDocumentOperation(operationLocation: string, accessToken: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 750; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, attempt < 20 ? 1000 : 2000));
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
