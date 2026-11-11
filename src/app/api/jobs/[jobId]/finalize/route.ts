import { Readable } from "node:stream";
import { NextRequest } from "next/server";
import { BlobClient } from "@azure/storage-blob";
import { forbidden, getUser, hasProcessorRole, rejectCrossOrigin, unauthorized } from "@/lib/auth";
import { ensureStorage, getBlobService, getDocumentsTable, getJobQueue, getJobsTable } from "@/lib/azure";
import { config } from "@/lib/config";
import { runDirectOcrJob } from "@/lib/direct-ocr";
import { hasSupportedSignature } from "@/lib/files";

export const runtime = "nodejs";
type Context = { params: Promise<{ jobId: string }> };

export async function POST(request: NextRequest, { params }: Context) {
  const user = getUser(request);
  if (!user) return unauthorized();
  if (!hasProcessorRole(user)) return forbidden();
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;
  await ensureStorage();
  const blobService = getBlobService();
  const documentsTable = getDocumentsTable();
  const jobsTable = getJobsTable();
  const jobQueue = getJobQueue();
  const { jobId } = await params;
  let job;
  try {
    job = await jobsTable.getEntity("owner", `${user.objectId}:${jobId}`);
  } catch (error) {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 404) {
      return Response.json({ error: "Jobul nu a fost găsit." }, { status: 404 });
    }
    throw error;
  }
  if (job.OwnerId !== user.objectId || job.TenantId !== user.tenantId) return Response.json({ error: "Jobul nu a fost găsit." }, { status: 404 });
  if (job.Status !== "uploading") return Response.json({ status: job.Status });

  const docs = documentsTable.listEntities({ queryOptions: { filter: `PartitionKey eq '${jobId.replaceAll("'", "''")}' and OwnerId eq '${user.objectId.replaceAll("'", "''")}' and TenantId eq '${user.tenantId.replaceAll("'", "''")}'` } });
  const uploadContainer = blobService.getContainerClient(config.uploadsContainer);
  const documentsContainer = blobService.getContainerClient(config.documentsContainer);
  let count = 0;
  for await (const doc of docs) {
    const uploadBlob = uploadContainer.getBlobClient(String(doc.UploadBlobName));
    const documentBlob = documentsContainer.getBlockBlobClient(String(doc.BlobName));
    let uploadProps: Awaited<ReturnType<typeof uploadBlob.getProperties>> | undefined;
    try {
      uploadProps = await uploadBlob.getProperties();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    let documentProps: Awaited<ReturnType<typeof documentBlob.getProperties>> | undefined;
    try {
      documentProps = await documentBlob.getProperties();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    const sourceProps = uploadProps ?? documentProps;
    if (sourceProps?.contentLength !== Number(doc.Size)) {
      await documentsTable.updateEntity({ partitionKey: jobId, rowKey: String(doc.DocumentId), Status: "failed", Warning: "Dimensiunea fișierului încărcat nu corespunde." }, "Merge");
      throw new Error(`Fișierul ${String(doc.OriginalName)} este incomplet.`);
    }
    const extension = String(doc.OriginalName).toLowerCase().slice(String(doc.OriginalName).lastIndexOf("."));
    const validationBlob = uploadProps ? uploadBlob : documentBlob;
    if (!sourceProps?.etag || !await hasValidSignature(validationBlob, extension, sourceProps.etag)) {
      await documentsTable.updateEntity({ partitionKey: jobId, rowKey: String(doc.DocumentId), Status: "failed", Warning: "Semnătura fișierului nu corespunde extensiei." }, "Merge");
      throw new Error(`Tipul real al fișierului ${String(doc.OriginalName)} nu este acceptat.`);
    }
    if (uploadProps) {
      if (documentProps) {
        if (documentProps.contentLength !== Number(doc.Size) ||
            !documentProps.etag ||
            !await hasValidSignature(documentBlob, extension, documentProps.etag)) {
          throw new Error(`Documentul ${String(doc.OriginalName)} există deja într-o stare invalidă.`);
        }
      } else {
        const source = await uploadBlob.download(0, undefined, { conditions: { ifMatch: uploadProps.etag } });
        if (!source.readableStreamBody) throw new Error(`Fișierul ${String(doc.OriginalName)} nu poate fi copiat.`);
        await documentBlob.uploadStream(Readable.from(source.readableStreamBody as AsyncIterable<Uint8Array>), 4 * 1024 * 1024, 4, {
          blobHTTPHeaders: { blobContentType: String(doc.ContentType ?? "application/octet-stream") },
          conditions: { ifNoneMatch: "*" }
        });
      }
      await uploadBlob.deleteIfExists();
    }
    await documentsTable.updateEntity({ partitionKey: jobId, rowKey: String(doc.DocumentId), Status: "queued" }, "Merge");
    count++;
  }
  if (!count) return Response.json({ error: "Jobul nu conține fișiere încărcate." }, { status: 400 });
  if (!job.etag) throw new Error("Jobul nu are un ETag valid pentru finalizare idempotentă.");

  const useDirectOcr = Boolean(process.env.DOCUMENT_INTELLIGENCE_ENDPOINT) && count <= 10;
  const initialStatus = useDirectOcr ? "processing" : "queued";

  try {
    await jobsTable.updateEntity({
      partitionKey: "owner",
      rowKey: `${user.objectId}:${jobId}`,
      Status: initialStatus,
      SubmissionState: useDirectOcr ? "direct" : "",
      ProcessingStartedAt: useDirectOcr ? new Date().toISOString() : "",
      QueueMessageSentAt: ""
    }, "Merge", { etag: job.etag });
  } catch (error) {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 412) {
      return Response.json({ status: initialStatus }, { status: 202 });
    }
    throw error;
  }

  if (useDirectOcr) {
    void runDirectOcrJob(jobId, user.objectId, user.tenantId);
    return Response.json({ jobId, status: "processing", documentCount: count });
  }

  await jobQueue.sendMessage(JSON.stringify({ jobId, ownerId: user.objectId, tenantId: user.tenantId }));
  await jobsTable.updateEntity({
    partitionKey: "owner", rowKey: `${user.objectId}:${jobId}`, QueueMessageSentAt: new Date().toISOString()
  }, "Merge");
  return Response.json({ jobId, status: "queued", documentCount: count });
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "statusCode" in error && error.statusCode === 404;
}

async function hasValidSignature(
  blob: BlobClient,
  extension: string,
  etag: string
): Promise<boolean> {
  const downloaded = await blob.download(0, 16, { conditions: { ifMatch: etag } });
  if (!downloaded.readableStreamBody) return false;
  const chunks: Buffer[] = [];
  for await (const chunk of downloaded.readableStreamBody) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return hasSupportedSignature(extension, Buffer.concat(chunks));
}
