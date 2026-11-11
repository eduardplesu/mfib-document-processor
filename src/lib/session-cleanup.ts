import type { ContainerClient } from "@azure/storage-blob";
import type { TableClient } from "@azure/data-tables";
import { getArchivesTable, getBlobService, getDocumentsTable, getJobsTable } from "./azure";
import { config } from "./config";
import type { AuthenticatedUser } from "./types";

export class SessionBusyError extends Error {
  constructor(message = "Nu se poate curăța sesiunea cât timp există documente sau arhive în curs de procesare.") {
    super(message);
    this.name = "SessionBusyError";
  }
}

type StoredEntity = Record<string, unknown> & {
  partitionKey?: string;
  rowKey?: string;
};

const ACTIVE_STATUSES = new Set(["uploading", "queued", "processing"]);
const SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

export async function clearUserSession(user: AuthenticatedUser): Promise<{
  deletedDocuments: number;
  deletedJobs: number;
  deletedArchives: number;
}> {
  const ownerId = user.objectId.trim();
  const tenantId = user.tenantId.trim();
  if (!ownerId || !tenantId) {
    throw new Error("Identitatea utilizatorului este incompletă.");
  }

  const jobsTable = getJobsTable();
  const documentsTable = getDocumentsTable();
  const archivesTable = getArchivesTable();
  const blobService = getBlobService();

  const safeOwner = escapeOData(ownerId);
  const safeTenant = escapeOData(tenantId);

  const ownedJobs: StoredEntity[] = [];
  for await (const job of jobsTable.listEntities<StoredEntity>({
    queryOptions: { filter: `PartitionKey eq 'owner' and OwnerId eq '${safeOwner}' and TenantId eq '${safeTenant}'` }
  })) {
    if (String(job.OwnerId) === ownerId && String(job.TenantId) === tenantId) {
      ownedJobs.push(job);
    }
  }

  const ownedDocuments: StoredEntity[] = [];
  for await (const doc of documentsTable.listEntities<StoredEntity>({
    queryOptions: { filter: `OwnerId eq '${safeOwner}' and TenantId eq '${safeTenant}'` }
  })) {
    if (String(doc.OwnerId) === ownerId && String(doc.TenantId) === tenantId) {
      ownedDocuments.push(doc);
    }
  }

  const ownedArchives: StoredEntity[] = [];
  for await (const archive of archivesTable.listEntities<StoredEntity>({
    queryOptions: { filter: `PartitionKey eq '${safeOwner}' and OwnerId eq '${safeOwner}' and TenantId eq '${safeTenant}'` }
  })) {
    if (String(archive.OwnerId) === ownerId && String(archive.TenantId) === tenantId) {
      ownedArchives.push(archive);
    }
  }

  const hasActiveDocument = ownedDocuments.some((doc) => ACTIVE_STATUSES.has(String(doc.Status ?? "").toLowerCase()));
  const hasActiveJob = ownedJobs.some((job) => ["queued", "processing"].includes(String(job.Status ?? "").toLowerCase()));
  const hasActiveArchive = ownedArchives.some((archive) => ["queued", "processing"].includes(String(archive.Status ?? "").toLowerCase()));
  if (hasActiveDocument || hasActiveJob || hasActiveArchive) {
    throw new SessionBusyError();
  }

  const uploadsContainer = blobService.getContainerClient(config.uploadsContainer);
  const documentsContainer = blobService.getContainerClient(config.documentsContainer);
  const resultsContainer = blobService.getContainerClient(config.resultsContainer);
  const outputsContainer = blobService.getContainerClient(config.outputsContainer);

  const jobIds = new Set<string>();
  for (const job of ownedJobs) {
    const id = String(job.JobId ?? "");
    if (SAFE_ID_PATTERN.test(id)) jobIds.add(id);
  }
  for (const doc of ownedDocuments) {
    const id = String(doc.JobId ?? "");
    if (SAFE_ID_PATTERN.test(id)) jobIds.add(id);
  }

  for (const doc of ownedDocuments) {
    const jobId = String(doc.JobId ?? "");
    const documentId = String(doc.DocumentId ?? doc.rowKey ?? "");
    const uploadBlobName = String(doc.UploadBlobName ?? "");
    if (uploadBlobName && SAFE_ID_PATTERN.test(jobId) && uploadBlobName.startsWith(`uploads/${jobId}/`)) {
      await uploadsContainer.getBlobClient(uploadBlobName).deleteIfExists();
    }
    const blobName = String(doc.BlobName ?? "");
    if (blobName && SAFE_ID_PATTERN.test(jobId) && blobName.startsWith(`incoming/${jobId}/`)) {
      await documentsContainer.getBlobClient(blobName).deleteIfExists();
    }
    if (SAFE_ID_PATTERN.test(jobId) && SAFE_ID_PATTERN.test(documentId)) {
      for (const format of ["layout.json", "tables.xlsx", "content.md", "manifest.json"]) {
        await outputsContainer.getBlobClient(`${jobId}/${documentId}/document.${format}`).deleteIfExists();
      }
    }
  }

  for (const jobId of jobIds) {
    await Promise.all([
      deleteBlobsByPrefix(uploadsContainer, `uploads/${jobId}/`),
      deleteBlobsByPrefix(documentsContainer, `incoming/${jobId}/`),
      deleteBlobsByPrefix(resultsContainer, `${jobId}/`),
      deleteBlobsByPrefix(outputsContainer, `${jobId}/`)
    ]);
  }

  for (const archive of ownedArchives) {
    const archiveId = String(archive.ArchiveId ?? archive.rowKey ?? "");
    if (SAFE_ID_PATTERN.test(archiveId)) {
      await outputsContainer.getBlobClient(`archives/${archiveId}.zip`).deleteIfExists();
    }
    const blobName = String(archive.BlobName ?? "");
    if (blobName.startsWith("archives/") && !blobName.includes("..")) {
      await outputsContainer.getBlobClient(blobName).deleteIfExists();
    }
  }

  for (const doc of ownedDocuments) {
    const partitionKey = typeof doc.partitionKey === "string" ? doc.partitionKey : String(doc.JobId ?? "");
    const rowKey = typeof doc.rowKey === "string" ? doc.rowKey : String(doc.DocumentId ?? "");
    if (partitionKey && rowKey) {
      await deleteEntityIfExists(documentsTable, partitionKey, rowKey);
    }
  }

  for (const job of ownedJobs) {
    const partitionKey = typeof job.partitionKey === "string" ? job.partitionKey : "owner";
    const rowKey = typeof job.rowKey === "string" ? job.rowKey : `${ownerId}:${String(job.JobId ?? "")}`;
    if (partitionKey && rowKey) {
      await deleteEntityIfExists(jobsTable, partitionKey, rowKey);
    }
  }

  for (const archive of ownedArchives) {
    const partitionKey = typeof archive.partitionKey === "string" ? archive.partitionKey : ownerId;
    const rowKey = typeof archive.rowKey === "string" ? archive.rowKey : String(archive.ArchiveId ?? "");
    if (partitionKey && rowKey) {
      await deleteEntityIfExists(archivesTable, partitionKey, rowKey);
    }
  }

  return {
    deletedDocuments: ownedDocuments.length,
    deletedJobs: ownedJobs.length,
    deletedArchives: ownedArchives.length
  };
}

function escapeOData(value: string): string {
  return value.replaceAll("'", "''");
}

async function deleteBlobsByPrefix(container: ContainerClient, prefix: string): Promise<void> {
  if (!prefix || prefix.includes("..")) return;
  for await (const blob of container.listBlobsFlat({ prefix })) {
    if (blob.name.startsWith(prefix)) {
      await container.getBlobClient(blob.name).deleteIfExists();
    }
  }
}

async function deleteEntityIfExists(table: TableClient, partitionKey: string, rowKey: string): Promise<void> {
  try {
    await table.deleteEntity(partitionKey, rowKey);
  } catch (error) {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 404) return;
    throw error;
  }
}
