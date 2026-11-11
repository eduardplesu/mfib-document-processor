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
          const analyzeUrl = new URL(`${endpoint.replace(/\/$/, "")}/documentintelligence/documentModels/${modelId}:analyze`);
          analyzeUrl.searchParams.set("api-version", apiVersion);
          analyzeUrl.searchParams.set("outputContentFormat", "markdown");

          const submitResponse = await fetch(analyzeUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token.token}`,
              "content-type": "application/json"
            },
            body: JSON.stringify({ base64Source: sourceBytes.toString("base64") })
          });

          if (submitResponse.status === 401 || submitResponse.status === 403) {
            throw new FallbackToQueueError(`Document Intelligence returned HTTP ${submitResponse.status}.`);
          }
          if (submitResponse.status !== 202) {
            throw new Error(`Document Intelligence a respins documentul (HTTP ${submitResponse.status}).`);
          }

          const operationLocation = submitResponse.headers.get("operation-location");
          if (!operationLocation) {
            throw new Error("Răspunsul OCR nu conține Operation-Location.");
          }

          const analyze = await pollSingleDocumentOperation(operationLocation, token.token);
          const pageCount = Array.isArray(analyze.pages) ? analyze.pages.length : 0;
          const tableData = Array.isArray(analyze.tables) ? analyze.tables as Array<Record<string, unknown>> : [];
          const warnings = evaluateQualityWarnings(analyze, tableData);
          const workbook = await createWorkbook(tableData, originalName);
          const allWarnings = [...new Set([...warnings, ...workbook.warnings])];
          const markdown = String(analyze.content ?? "");
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
