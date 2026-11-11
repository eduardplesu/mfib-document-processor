export type JobStatus = "uploading" | "queued" | "processing" | "completed" | "review" | "failed";
export type DocumentStatus = "uploading" | "queued" | "processing" | "completed" | "review" | "failed";
export type OutputFormat = "layout.json" | "tables.xlsx" | "content.md" | "manifest.json";

export interface JobRecord {
  jobId: string;
  ownerId: string;
  tenantId: string;
  status: JobStatus;
  createdAt: string;
  documentCount: number;
  completedCount: number;
  failedCount: number;
}

export interface DocumentRecord {
  documentId: string;
  jobId: string;
  ownerId: string;
  originalName: string;
  blobName: string;
  size: number;
  contentType: string;
  status: DocumentStatus;
  createdAt: string;
  pageCount?: number;
  tableCount?: number;
  warning?: string;
  operationId?: string;
  outputs?: string[];
  sourceSha256?: string;
}

export interface AuthenticatedUser {
  objectId: string;
  tenantId: string;
  name: string;
  roles: string[];
}
