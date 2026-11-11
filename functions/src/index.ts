import { app, InvocationContext, Timer } from "@azure/functions";
import { DefaultAzureCredential } from "@azure/identity";
import { TableClient } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";
import { QueueClient } from "@azure/storage-queue";
import archiver from "archiver";
import { Readable } from "node:stream";
import { createWorkbook } from "../../packages/shared/src/excel.js";
import { resultBlobName } from "./result-blob.js";

const apiVersion = process.env.DOCUMENT_INTELLIGENCE_API_VERSION ?? "2024-11-30";
const accountUrl = process.env.AZURE_STORAGE_ACCOUNT_URL!;
const credential = new DefaultAzureCredential();
const blobs = new BlobServiceClient(accountUrl, credential);
const jobs = new TableClient(tableUrl(), "Jobs", credential);
const documents = new TableClient(tableUrl(), "Documents", credential);
const archives = new TableClient(tableUrl(), "Archives", credential);

type JobMessage = { jobId: string; ownerId: string; tenantId: string };
type DiResult = { status?: string; resultUrl?: string; sourceUrl?: string; error?: { message?: string } };

app.storageQueue("processDocumentJob", {
  queueName: process.env.QUEUE_NAME ?? "document-jobs",
  connection: "AzureWebJobsStorage",
  handler: async (message: JobMessage, context: InvocationContext) => {
    await submitJob(message, context);
  }
});

app.storageQueue("generateArchive", {
  queueName: process.env.ARCHIVE_QUEUE_NAME ?? "archive-jobs",
  connection: "AzureWebJobsStorage",
  handler: async (message: { archiveId: string; ownerId: string }, context: InvocationContext) => {
    await generateArchive(message, context);
  }
});

app.timer("reconcileOcr", {
  schedule: "*/10 * * * * *",
  handler: async (_timer: Timer, context: InvocationContext) => {
    await enqueueWaitingJobs(context);
    await reconcile(context);
    await cleanupArchives(context);
  }
});

async function submitJob(message: JobMessage, context: InvocationContext): Promise<void> {
  const job = await getJob(message);
  if (!job || job.Status !== "queued") return;
  const jobKeys = requireEntityKeys(job);
  if (!job.etag) throw new Error("Queued job has no ETag; refusing duplicate OCR submission.");
  try {
    await jobs.updateEntity({
      ...jobKeys, Status: "processing",
      SubmissionState: "submitting", ProcessingStartedAt: new Date().toISOString(), LastActivityAt: new Date().toISOString()
    }, "Merge", { etag: job.etag });
  } catch (error) {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 412) return;
    throw error;
  }
  const endpoint = process.env.DOCUMENT_INTELLIGENCE_ENDPOINT;
  if (!endpoint) throw new Error("DOCUMENT_INTELLIGENCE_ENDPOINT is required.");
  const inputContainer = process.env.DOCUMENTS_CONTAINER ?? "incoming";
  const resultsContainer = process.env.RESULTS_CONTAINER ?? "results";
  const url = new URL(`${endpoint.replace(/\/$/, "")}/documentintelligence/documentModels/${process.env.DOCUMENT_INTELLIGENCE_MODEL_ID ?? "prebuilt-layout"}:analyzeBatch`);
  url.searchParams.set("api-version", apiVersion);
  url.searchParams.set("outputContentFormat", "markdown");
  const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
  if (!token) throw new Error("Could not acquire a Document Intelligence access token.");

  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: { authorization: `Bearer ${token.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      azureBlobSource: { containerUrl: containerBase(inputContainer), prefix: `incoming/${message.jobId}/` },
      resultContainerUrl: containerBase(resultsContainer),
      resultPrefix: `${message.jobId}/`,
      overwriteExisting: false
    })
  });
  if (response.status !== 202) {
    const uncertain = response.status >= 500;
    await jobs.updateEntity({
      ...jobKeys, Status: "failed",
      SubmissionState: uncertain ? "uncertain" : "rejected",
      SubmissionError: uncertain
        ? `Submission outcome is uncertain after HTTP ${response.status}; verify Azure operation history before retrying.`
        : `Document Intelligence rejected the request (HTTP ${response.status}).`,
      LastActivityAt: new Date().toISOString()
    }, "Merge");
    await markDocumentsSubmissionFailed(message.jobId, uncertain
      ? "Trimiterea OCR are un rezultat incert; verificați operațiunile Azure înainte de reluare."
      : `Document Intelligence a respins cererea (HTTP ${response.status}).`);
    throw new Error(`Document Intelligence batch submission failed with HTTP ${response.status}.`);
  }
  const operationLocation = response.headers.get("operation-location");
  if (!operationLocation) {
    await jobs.updateEntity({
      ...jobKeys, Status: "failed",
      SubmissionState: "uncertain", SubmissionError: "Accepted response lacked Operation-Location; manual review is required.",
      LastActivityAt: new Date().toISOString()
    }, "Merge");
    await markDocumentsSubmissionFailed(message.jobId, "Răspunsul OCR nu conține identificatorul operației; verificarea manuală este necesară.");
    throw new Error("Document Intelligence accepted a request without returning Operation-Location.");
  }
  await jobs.updateEntity({
    ...jobKeys, Status: "processing",
    SubmissionState: "submitted", OperationLocation: operationLocation, LastActivityAt: new Date().toISOString()
  }, "Merge");
  const docIterator = documents.listEntities({ queryOptions: { filter: `PartitionKey eq '${message.jobId}'` } });
  for await (const doc of docIterator) {
    if (doc.Status !== "failed") {
      await documents.updateEntity({ ...requireEntityKeys(doc), Status: "processing" }, "Merge");
    }
  }
  context.log(`Submitted OCR job ${message.jobId}`);
  await pollSubmittedJob({ ...job, ...jobKeys, JobId: message.jobId, OperationLocation: operationLocation }, operationLocation, token.token, context);
}

type OperationPayload = { status?: string; result?: { details?: DiResult[] }; error?: { message?: string } };

async function pollSubmittedJob(
  job: Record<string, unknown> & { partitionKey?: string; rowKey?: string },
  operationLocation: string,
  accessToken: string,
  context: InvocationContext
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try {
      const response = await fetchWithRetry(operationLocation, { headers: { authorization: `Bearer ${accessToken}` } }, 2);
      if (response.status !== 200) return;
      const text = await response.text();
      if (!text) return;
      const operation = JSON.parse(text) as OperationPayload;
      const state = (operation.status ?? "").toLowerCase();
      if (["succeeded", "failed", "canceled"].includes(state)) {
        await reconcileJobOperation(job, operation, context);
        return;
      }
    } catch {
      return;
    }
  }
}

async function reconcile(context: InvocationContext): Promise<void> {
  const pending = jobs.listEntities({ queryOptions: { filter: "Status eq 'processing'" } });
  for await (const job of pending) {
    const jobKeys = requireEntityKeys(job);
    const operationLocation = String(job.OperationLocation ?? "");
    if (!operationLocation) {
      const started = Date.parse(String(job.ProcessingStartedAt ?? ""));
      if (Number.isFinite(started) && Date.now() - started > 30 * 60 * 1000) {
        await jobs.updateEntity({
          ...jobKeys, Status: "failed",
          SubmissionState: "uncertain", SubmissionError: "No operation status was recorded; verify with Azure before retrying to avoid duplicate OCR charges."
        }, "Merge");
        await markDocumentsSubmissionFailed(String(job.JobId), "Starea operației OCR nu a fost salvată; verificați Azure înainte de reluare.");
      }
      continue;
    }
    try {
      const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
      if (!token) throw new Error("Could not acquire a Document Intelligence access token.");
      const response = await fetchWithRetry(operationLocation, { headers: { authorization: `Bearer ${token.token}` } });
      if (!response.ok) throw new Error(`OCR polling failed (${response.status}).`);
      const operation = await response.json() as OperationPayload;
      if (!["succeeded", "failed", "canceled"].includes((operation.status ?? "").toLowerCase())) continue;
      await reconcileJobOperation(job, operation, context);
    } catch (error) {
      context.error(`Reconciliation failed for ${String(job.JobId)}:`, error);
    }
  }
}

async function reconcileJobOperation(
  job: Record<string, unknown> & { partitionKey?: string; rowKey?: string },
  operation: OperationPayload,
  context: InvocationContext
): Promise<void> {
  const jobKeys = requireEntityKeys(job);
  const results = operation.result?.details ?? [];
  const jobId = String(job.JobId);
  const jobDocs = documents.listEntities({ queryOptions: { filter: `PartitionKey eq '${jobId}'` } });
  let completed = 0;
  let failed = 0;
  for await (const doc of jobDocs) {
    const docKeys = requireEntityKeys(doc);
    if (doc.Status === "completed" || doc.Status === "review") {
      completed++;
      continue;
    }
    const match = results.find((result) => result.sourceUrl?.includes(String(doc.DocumentId)) || result.resultUrl?.includes(String(doc.DocumentId)));
    try {
      if (!match || match.status?.toLowerCase() !== "succeeded" || !match.resultUrl) throw new Error(match?.error?.message ?? "Rezultatul OCR lipsește.");
      const resultsContainer = blobs.getContainerClient(process.env.RESULTS_CONTAINER ?? "results");
      const blobName = resultBlobName(match.resultUrl, resultsContainer.url, jobId);
      const resultBytes = await resultsContainer.getBlobClient(blobName).downloadToBuffer();
      const raw = JSON.parse(resultBytes.toString("utf8")) as Record<string, unknown>;
      const analyze = (raw.analyzeResult ?? raw) as Record<string, unknown>;
      const pageCount = Array.isArray(analyze.pages) ? analyze.pages.length : 0;
      const tableData = Array.isArray(analyze.tables) ? analyze.tables as Array<Record<string, unknown>> : [];
      const warnings = qualityWarnings(analyze, tableData);
      const exported = await writeOutputs(doc, jobId, analyze, tableData, warnings);
      const status = exported.warnings.length ? "review" : "completed";
      await documents.updateEntity({
        ...docKeys, Status: status, PageCount: pageCount,
        TableCount: tableData.length, Warning: exported.warnings.join("; "), Outputs: JSON.stringify(exported.outputs),
        CompletedAt: new Date().toISOString()
      }, "Merge");
      completed++;
    } catch (error) {
      failed++;
      await documents.updateEntity({
        ...docKeys, Status: "failed",
        Warning: error instanceof Error ? error.message.slice(0, 500) : "Eroare necunoscută."
      }, "Merge");
    }
  }
  await jobs.updateEntity({
    ...jobKeys,
    Status: failed ? (completed ? "review" : "failed") : "completed", CompletedCount: completed,
    FailedCount: failed, LastActivityAt: new Date().toISOString()
  }, "Merge");
  context.log(`Reconciled OCR job ${jobId}: ${completed} complete, ${failed} failed`);
}

async function writeOutputs(
  doc: Record<string, unknown>, jobId: string, analyze: Record<string, unknown>,
  tables: Array<Record<string, unknown>>, warnings: string[]
): Promise<{ outputs: string[]; warnings: string[] }> {
  const container = blobs.getContainerClient(process.env.OUTPUTS_CONTAINER ?? "outputs");
  const prefix = `${jobId}/${String(doc.DocumentId)}`;
  const rawMarkdown = String(analyze.content ?? "");
  const markdown = await refineWorkerMarkdownWithLlm(rawMarkdown);
  const workbook = await createWorkbook(tables, String(doc.OriginalName));
  const allWarnings = [...new Set([...warnings, ...workbook.warnings])];
  const entries: Array<[string, Buffer | string, string]> = [
    ["tables.xlsx", workbook.buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    ["content.md", markdown, "text/markdown; charset=utf-8"]
  ];
  await Promise.all(entries.map(([name, content, contentType]) =>
    container.getBlockBlobClient(`${prefix}/document.${name}`).upload(content, Buffer.byteLength(content), {
      blobHTTPHeaders: { blobContentType: contentType }
    })
  ));
  return { outputs: entries.map(([name]) => name), warnings: allWarnings };
}

async function refineWorkerMarkdownWithLlm(rawMarkdown: string): Promise<string> {
  const endpoint = process.env.DOCUMENT_INTELLIGENCE_ENDPOINT;
  const deployment = process.env.OPENAI_DEPLOYMENT_NAME;
  if (!endpoint || !deployment || !rawMarkdown.trim() || rawMarkdown.length > 60_000) {
    return rawMarkdown;
  }
  try {
    const token = await credential.getToken("https://cognitiveservices.azure.com/.default");
    if (!token?.token) return rawMarkdown;
    const openAiApiVersion = process.env.OPENAI_API_VERSION ?? "2024-10-21";
    const url = new URL(`${endpoint.replace(/\/$/, "")}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions`);
    url.searchParams.set("api-version", openAiApiVersion);
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: [
              "Ești un auditor expert în post-procesare OCR și reconstrucție fidelă de documente în limba română (și engleză).",
              "Primești textul Markdown extras prin OCR dintr-un document scanat sau dintr-o captură de ecran.",
              "Corectează erorile optice de recunoaștere a cuvintelor și elimină artefactele izolate de butoane/pictograme UI, dar NU rezuma, NU omite paragrafe, NU recalcula matematic valorile și NU șterge niciodată semnele minus (-) din fața cantităților sau sumelor financiare.",
              "Returnează EXCLUSIV conținutul Markdown curățat, fără blocuri ```markdown."
            ].join("\n")
          },
          { role: "user", content: rawMarkdown }
        ]
      }),
      signal: AbortSignal.timeout(45_000)
    });
    if (!response.ok) return rawMarkdown;
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const cleaned = data.choices?.[0]?.message?.content?.trim();
    if (!cleaned) return rawMarkdown;
    return cleaned.replace(/^```(?:markdown|md)?\r?\n/i, "").replace(/\r?\n```$/i, "").trim();
  } catch {
    return rawMarkdown;
  }
}

function qualityWarnings(analyze: Record<string, unknown>, tables: Array<Record<string, unknown>>): string[] {
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
    const rows = Number(table.rowCount ?? 0), columns = Number(table.columnCount ?? 0);
    const cells = (table.cells ?? []) as Array<Record<string, unknown>>;
    if (!rows || !columns || cells.some((cell) => Number(cell.rowIndex) >= rows || Number(cell.columnIndex) >= columns)) {
      warnings.push(`Structură de tabel incorectă la tabelul ${index + 1}.`);
    }
  }
  return warnings;
}

function containerBase(name: string): string {
  return `${accountUrl.replace(/\/$/, "")}/${name}`;
}

async function getJob(message: JobMessage) {
  const iterator = jobs.listEntities({ queryOptions: { filter: `JobId eq '${message.jobId}' and OwnerId eq '${message.ownerId}'` } });
  for await (const job of iterator) return job;
  return null;
}

async function fetchWithRetry(url: string | URL, init: RequestInit, maxRetries = 5): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, init);
    const safeToRetry = !init.method || ["GET", "HEAD"].includes(init.method.toUpperCase());
    if (!(response.status === 429 || (safeToRetry && [500, 502, 503, 504].includes(response.status))) || attempt >= maxRetries) return response;
    const seconds = Number(response.headers.get("retry-after"));
    await new Promise((resolve) => setTimeout(resolve, Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Math.min(30000, 1000 * 2 ** attempt)));
  }
}

async function enqueueWaitingJobs(context: InvocationContext): Promise<void> {
  const waiting = jobs.listEntities({ queryOptions: { filter: "Status eq 'queued'" } });
  const queue = new QueueClient(
    `${accountUrl.replace(".blob.", ".queue.")}/${process.env.QUEUE_NAME ?? "document-jobs"}`,
    credential
  );
  for await (const job of waiting) {
    const lastSent = Date.parse(String(job.QueueMessageSentAt ?? ""));
    if (Number.isFinite(lastSent) && Date.now() - lastSent < 5 * 60 * 1000) continue;
    const jobKeys = requireEntityKeys(job);
    const message = {
      jobId: String(job.JobId),
      ownerId: String(job.OwnerId),
      tenantId: String(job.TenantId)
    };
    await queue.sendMessage(JSON.stringify(message));
    await jobs.updateEntity({
      ...jobKeys, QueueMessageSentAt: new Date().toISOString()
    }, "Merge");
    context.log(`Re-enqueued waiting job ${message.jobId}`);
  }
}

async function markDocumentsSubmissionFailed(jobId: string, warning: string): Promise<void> {
  const pending = documents.listEntities({ queryOptions: { filter: `PartitionKey eq '${jobId}'` } });
  for await (const document of pending) {
    if (document.Status === "completed" || document.Status === "review") continue;
    await documents.updateEntity({
      ...requireEntityKeys(document), Status: "failed", Warning: warning
    }, "Merge");
  }
}

function tableUrl(): string {
  return accountUrl.replace(".blob.", ".table.");
}

function requireEntityKeys(entity: { partitionKey?: string; rowKey?: string }): { partitionKey: string; rowKey: string } {
  if (typeof entity.partitionKey !== "string" || typeof entity.rowKey !== "string") {
    throw new Error("Table entity is missing its partition or row key.");
  }
  return { partitionKey: entity.partitionKey, rowKey: entity.rowKey };
}

async function generateArchive(message: { archiveId: string; ownerId: string }, context: InvocationContext): Promise<void> {
  const record = await archives.getEntity(message.ownerId, message.archiveId);
  if (record.Status !== "queued" || !record.etag) return;
  try {
    await archives.updateEntity({ partitionKey: message.ownerId, rowKey: message.archiveId, Status: "processing" }, "Merge", { etag: record.etag });
  } catch (error) {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 412) return;
    throw error;
  }
  try {
    const docs = JSON.parse(String(record.DocumentIds)) as Array<{ documentId: string; jobId: string; originalName: string; outputs: string[] }>;
    const container = blobs.getContainerClient(process.env.OUTPUTS_CONTAINER ?? "outputs");
    const zip = archiver("zip", { zlib: { level: 6 } });
    const archiveBlob = container.getBlockBlobClient(`archives/${message.archiveId}.zip`);
    const uploadPromise = archiveBlob.uploadStream(zip, 4 * 1024 * 1024, 4, {
      blobHTTPHeaders: { blobContentType: "application/zip" }
    });
    const uploadNames: string[] = [];
    const directoryCounts = new Map<string, number>();
    for (const doc of docs) {
      const base = safeArchiveName(doc.originalName);
      const count = (directoryCounts.get(base) ?? 0) + 1;
      directoryCounts.set(base, count);
      const directory = count === 1 ? base : `${base}-${count}`;
      const allowedOutputs = doc.outputs.filter((f) => f === "tables.xlsx" || f === "content.md");
      for (const filename of allowedOutputs) {
        const safeOutput = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
        const blobName = `${doc.jobId}/${doc.documentId}/document.${safeOutput}`;
        const source = await container.getBlobClient(blobName).download();
        if (!source.readableStreamBody) throw new Error(`Missing output ${safeOutput} for ${doc.documentId}`);
        const archivePath = `${directory}/document.${safeOutput}`;
        zip.append(Readable.from(source.readableStreamBody as AsyncIterable<Uint8Array>), { name: archivePath });
        uploadNames.push(archivePath);
      }
    }
    await zip.finalize();
    await uploadPromise;
    await archives.updateEntity({
      partitionKey: message.ownerId, rowKey: message.archiveId, Status: "completed",
      BlobName: `archives/${message.archiveId}.zip`, CompletedAt: new Date().toISOString(),
      ExpiresAt: new Date(Date.now() + Number(process.env.ARCHIVE_RETENTION_HOURS ?? 24) * 60 * 60 * 1000).toISOString(),
      IncludedFileCount: uploadNames.length
    }, "Merge");
  } catch (error) {
    await archives.updateEntity({
      partitionKey: message.ownerId, rowKey: message.archiveId, Status: "failed",
      Error: error instanceof Error ? error.message.slice(0, 500) : "Archive generation failed.",
      CompletedAt: new Date().toISOString()
    }, "Merge");
    throw error;
  }
  context.log(`Archive ${message.archiveId} is ready.`);
}

function safeArchiveName(filename: string): string {
  const basename = filename.replaceAll("\\", "/").split("/").at(-1) ?? "document";
  const withoutExtension = basename.replace(/\.[^.]+$/, "");
  const safe = withoutExtension.normalize("NFKC").replace(/[^\p{L}\p{N}._-]/gu, "_").replace(/^\.+/, "").slice(0, 100);
  return safe || "document";
}

async function cleanupArchives(context: InvocationContext): Promise<void> {
  const completed = archives.listEntities({ queryOptions: { filter: "Status eq 'completed'" } });
  const now = Date.now();
  for await (const archive of completed) {
    const expiresAt = Date.parse(String(archive.ExpiresAt ?? ""));
    if (!Number.isFinite(expiresAt) || expiresAt > now) continue;
    const archiveKeys = requireEntityKeys(archive);
    const blobName = String(archive.BlobName ?? "");
    if (blobName.startsWith("archives/")) {
      await blobs.getContainerClient(process.env.OUTPUTS_CONTAINER ?? "outputs").deleteBlob(blobName);
    }
    await archives.deleteEntity(archiveKeys.partitionKey, archiveKeys.rowKey);
    context.log(`Expired archive ${String(archive.ArchiveId)}`);
  }
}
