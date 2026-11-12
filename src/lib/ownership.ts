import { getDocumentsTable, getJobsTable } from "./azure";
import type { DocumentRecord, DocumentStatus, JobRecord, JobStatus } from "./types";

export async function getOwnedJob(jobId: string, ownerId: string, tenantId?: string): Promise<JobRecord | null> {
  try {
    const entity = await getJobsTable().getEntity("owner", `${ownerId}:${jobId}`);
    if (String(entity.OwnerId) !== ownerId) return null;
    if (tenantId && String(entity.TenantId) !== tenantId) return null;
    return {
      jobId: String(entity.JobId),
      ownerId: String(entity.OwnerId),
      tenantId: String(entity.TenantId),
      status: String(entity.Status) as JobStatus,
      createdAt: String(entity.CreatedAt),
      documentCount: Number(entity.DocumentCount),
      completedCount: Number(entity.CompletedCount),
      failedCount: Number(entity.FailedCount)
    };
  } catch (error) {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 404) return null;
    throw error;
  }
}

export async function getOwnedDocument(documentId: string, ownerId: string, tenantId?: string): Promise<DocumentRecord | null> {
  const tenantFilter = tenantId ? ` and TenantId eq '${tenantId.replaceAll("'", "''")}'` : "";
  const results = getDocumentsTable().listEntities({
    queryOptions: { filter: `RowKey eq '${documentId.replaceAll("'", "''")}' and OwnerId eq '${ownerId.replaceAll("'", "''")}'${tenantFilter}` }
  });
  for await (const entity of results) {
    if (String(entity.OwnerId) !== ownerId) continue;
    if (tenantId && String(entity.TenantId) !== tenantId) continue;
    let outputs: string[] = [];
    try {
      const value: unknown = JSON.parse(String(entity.Outputs ?? "[]"));
      if (Array.isArray(value)) {
        outputs = value.filter((item): item is string => item === "content.md");
      }
    } catch {
      outputs = [];
    }
    return {
      documentId: String(entity.DocumentId),
      jobId: String(entity.JobId),
      ownerId: String(entity.OwnerId),
      originalName: String(entity.OriginalName),
      blobName: String(entity.BlobName),
      size: Number(entity.Size),
      contentType: String(entity.ContentType),
      status: String(entity.Status) as DocumentStatus,
      createdAt: String(entity.CreatedAt),
      pageCount: entity.PageCount === undefined ? undefined : Number(entity.PageCount),
      tableCount: entity.TableCount === undefined ? undefined : Number(entity.TableCount),
      warning: entity.Warning === undefined ? undefined : String(entity.Warning),
      operationId: entity.OperationId === undefined ? undefined : String(entity.OperationId),
      outputs,
      sourceSha256: entity.SourceSha256 === undefined ? undefined : String(entity.SourceSha256)
    } satisfies DocumentRecord;
  }
  return null;
}
