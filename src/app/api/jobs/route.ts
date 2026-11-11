import { randomUUID } from "node:crypto";
import { generateBlobSASQueryParameters, BlobSASPermissions, SASProtocol, StorageSharedKeyCredential } from "@azure/storage-blob";
import { NextRequest } from "next/server";
import { z } from "zod";
import { forbidden, getUser, hasProcessorRole, rejectCrossOrigin, unauthorized } from "@/lib/auth";
import { ensureStorage, getBlobService, getDocumentsTable, getJobsTable } from "@/lib/azure";
import { config } from "@/lib/config";
import { validateFileMetadata } from "@/lib/files";
import { clearUserSession, SessionBusyError } from "@/lib/session-cleanup";

export const runtime = "nodejs";
const requestSchema = z.object({ files: z.array(z.unknown()).min(1).max(100) });

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) return unauthorized();
  if (!hasProcessorRole(user)) return forbidden();
  await ensureStorage();
  const safeOwner = user.objectId.replaceAll("'", "''");
  const safeTenant = user.tenantId.replaceAll("'", "''");
  const jobs = getJobsTable().listEntities({
    queryOptions: { filter: `PartitionKey eq 'owner' and OwnerId eq '${safeOwner}' and TenantId eq '${safeTenant}'` }
  });
  const jobIds: string[] = [];
  for await (const job of jobs) {
    if (String(job.OwnerId) === user.objectId && String(job.TenantId) === user.tenantId) {
      jobIds.push(String(job.JobId));
    }
  }
  const documents: Record<string, unknown>[] = [];
  for (const jobId of jobIds) {
    const safeJobId = jobId.replaceAll("'", "''");
    const results = getDocumentsTable().listEntities({
      queryOptions: { filter: `PartitionKey eq '${safeJobId}' and OwnerId eq '${safeOwner}' and TenantId eq '${safeTenant}'` }
    });
    for await (const item of results) {
      if (String(item.OwnerId) !== user.objectId || String(item.TenantId) !== user.tenantId) continue;
      let outputs: string[] = [];
      try {
        const parsed: unknown = JSON.parse(String(item.Outputs ?? "[]"));
        if (Array.isArray(parsed)) {
          outputs = parsed.filter((format): format is string => format === "tables.xlsx" || format === "content.md");
        }
      } catch {
        outputs = [];
      }
      documents.push({
        documentId: item.DocumentId, jobId: item.JobId, originalName: item.OriginalName, size: item.Size,
        status: item.Status, createdAt: item.CreatedAt, outputs
      });
    }
  }
  return Response.json({ documents }, { headers: { "cache-control": "private, no-store" } });
}

export async function DELETE(request: NextRequest) {
  const user = getUser(request);
  if (!user) return unauthorized();
  if (!hasProcessorRole(user)) return forbidden();
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;
  try {
    await ensureStorage();
    const summary = await clearUserSession(user);
    return Response.json(summary, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof SessionBusyError) {
      return Response.json({ error: error.message }, { status: 409, headers: { "cache-control": "private, no-store" } });
    }
    const message = error instanceof Error ? error.message : "Nu s-a putut curăța sesiunea.";
    return Response.json({ error: message }, { status: 400, headers: { "cache-control": "private, no-store" } });
  }
}

export async function POST(request: NextRequest) {
  const user = getUser(request);
  if (!user) return unauthorized();
  if (!hasProcessorRole(user)) return forbidden();
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;
  try {
    await ensureStorage();
    const jobsTable = getJobsTable();
    const documentsTable = getDocumentsTable();
    const blobService = getBlobService();
    const { files } = requestSchema.parse(await request.json());
    if (files.length > Number(process.env.MAX_BATCH_DOCUMENTS ?? 100)) {
      return Response.json({ error: "Lotul depășește numărul maxim de documente configurat." }, { status: 400 });
    }
    const maxSizeMb = Number(process.env.MAX_UPLOAD_SIZE_MB ?? 100);
    const validated = files.map((file) => validateFileMetadata(file, maxSizeMb));
    const jobId = randomUUID();
    const now = new Date();
    const uploads: Array<{ documentId: string; url: string }> = [];
    for (const file of validated) {
      const blobName = `incoming/${jobId}/${file.documentId}/${file.name}`;
      const uploadBlobName = `uploads/${jobId}/${file.documentId}/${file.name}`;
      const blob = blobService.getContainerClient(config.uploadsContainer).getBlobClient(uploadBlobName);
      const sas = await createUploadSas(uploadBlobName);
      uploads.push({ documentId: file.documentId, url: `${blob.url}?${sas}` });
      await documentsTable.createEntity({
        partitionKey: jobId, rowKey: file.documentId, DocumentId: file.documentId, JobId: jobId,
        OwnerId: user.objectId, TenantId: user.tenantId, OriginalName: file.name, BlobName: blobName, UploadBlobName: uploadBlobName,
        Size: file.size, ContentType: file.contentType, Status: "uploading", CreatedAt: now.toISOString()
      });
    }
    await jobsTable.createEntity({
      partitionKey: "owner", rowKey: `${user.objectId}:${jobId}`, JobId: jobId, OwnerId: user.objectId,
      TenantId: user.tenantId, Status: "uploading", CreatedAt: now.toISOString(), DocumentCount: validated.length,
      CompletedCount: 0, FailedCount: 0
    });
    return Response.json({ jobId, uploads }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cerere invalidă.";
    return Response.json({ error: message }, { status: 400 });
  }
}

async function createUploadSas(blobName: string): Promise<string> {
  const accountName = process.env.AZURE_STORAGE_ACCOUNT_NAME;
  const accountKey = process.env.AZURE_STORAGE_ACCOUNT_KEY;
  if (accountName && accountKey) {
    const credential = new StorageSharedKeyCredential(accountName, accountKey);
    return generateBlobSASQueryParameters({
      containerName: config.uploadsContainer, blobName, permissions: BlobSASPermissions.parse("cw"),
      startsOn: new Date(Date.now() - 2 * 60_000), expiresOn: new Date(Date.now() + 15 * 60_000),
      protocol: SASProtocol.Https
    }, credential).toString();
  }
  const resolvedAccountName = accountName ?? new URL(config.storageUrl).hostname.split(".")[0];
  const delegationKey = await getBlobService().getUserDelegationKey(new Date(Date.now() - 2 * 60_000), new Date(Date.now() + 60 * 60_000));
  return generateBlobSASQueryParameters({
    containerName: config.uploadsContainer, blobName, permissions: BlobSASPermissions.parse("cw"),
    startsOn: new Date(Date.now() - 2 * 60_000), expiresOn: new Date(Date.now() + 60 * 60_000),
    protocol: SASProtocol.Https
  }, delegationKey, resolvedAccountName).toString();
}
