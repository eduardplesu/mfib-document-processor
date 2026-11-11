import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  jobs: { listEntities: vi.fn(), deleteEntity: vi.fn(), getEntity: vi.fn() },
  documents: { listEntities: vi.fn(), deleteEntity: vi.fn() },
  archives: { listEntities: vi.fn(), deleteEntity: vi.fn() },
  containers: new Map<string, {
    deleted: string[];
    listed: string[];
    getBlobClient: (name: string) => { deleteIfExists: () => Promise<void> };
    listBlobsFlat: (options?: { prefix?: string }) => AsyncGenerator<{ name: string }>;
  }>()
}));

function getOrCreateContainer(name: string) {
  let container = mocks.containers.get(name);
  if (!container) {
    const deleted: string[] = [];
    const listed: string[] = [];
    container = {
      deleted,
      listed,
      getBlobClient: (blobName: string) => ({
        deleteIfExists: async () => { deleted.push(blobName); }
      }),
      listBlobsFlat: async function* (options?: { prefix?: string }) {
        const prefix = options?.prefix ?? "";
        for (const item of listed) {
          if (item.startsWith(prefix)) yield { name: item };
        }
      }
    };
    mocks.containers.set(name, container);
  }
  return container;
}

vi.mock("../../src/lib/azure", () => ({
  getJobsTable: () => mocks.jobs,
  getDocumentsTable: () => mocks.documents,
  getArchivesTable: () => mocks.archives,
  getBlobService: () => ({
    getContainerClient: (name: string) => getOrCreateContainer(name)
  })
}));

async function* entities<T>(...items: T[]) {
  yield* items;
}

import { clearUserSession, SessionBusyError } from "../../src/lib/session-cleanup";
import { getOwnedDocument, getOwnedJob } from "../../src/lib/ownership";

describe("user isolation and session cleanup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.containers.clear();
  });

  it("deletes only the authenticated user's input, result, output, and archive blobs and records", async () => {
    getOrCreateContainer("staging").listed.push("uploads/job-1/doc-1/source.pdf", "uploads/other-job/doc-2/other.pdf");
    getOrCreateContainer("incoming").listed.push("incoming/job-1/doc-1/source.pdf", "incoming/other-job/doc-2/other.pdf");
    getOrCreateContainer("results").listed.push("job-1/incoming/job-1/doc-1/source.pdf.ocr.json", "other-job/file.ocr.json");
    getOrCreateContainer("outputs").listed.push("job-1/doc-1/document.layout.json", "other-job/doc-2/document.layout.json");

    mocks.jobs.listEntities.mockReturnValue(entities(
      { partitionKey: "owner", rowKey: "user-1:job-1", JobId: "job-1", OwnerId: "user-1", TenantId: "tenant-1", Status: "completed" },
      { partitionKey: "owner", rowKey: "user-2:other-job", JobId: "other-job", OwnerId: "user-2", TenantId: "tenant-1", Status: "completed" }
    ));
    mocks.documents.listEntities.mockReturnValue(entities(
      {
        partitionKey: "job-1",
        rowKey: "doc-1",
        DocumentId: "doc-1",
        JobId: "job-1",
        OwnerId: "user-1",
        TenantId: "tenant-1",
        Status: "completed",
        BlobName: "incoming/job-1/doc-1/source.pdf",
        UploadBlobName: "uploads/job-1/doc-1/source.pdf"
      },
      {
        partitionKey: "other-job",
        rowKey: "doc-2",
        DocumentId: "doc-2",
        JobId: "other-job",
        OwnerId: "user-2",
        TenantId: "tenant-1",
        Status: "completed",
        BlobName: "incoming/other-job/doc-2/other.pdf",
        UploadBlobName: "uploads/other-job/doc-2/other.pdf"
      }
    ));
    mocks.archives.listEntities.mockReturnValue(entities(
      {
        partitionKey: "user-1",
        rowKey: "arch-1",
        ArchiveId: "arch-1",
        OwnerId: "user-1",
        TenantId: "tenant-1",
        Status: "completed",
        BlobName: "archives/arch-1.zip"
      }
    ));

    const summary = await clearUserSession({
      objectId: "user-1",
      tenantId: "tenant-1",
      name: "User One",
      roles: ["Processor.User"]
    });

    expect(summary).toEqual({ deletedDocuments: 1, deletedJobs: 1, deletedArchives: 1 });
    expect(getOrCreateContainer("staging").deleted).toContain("uploads/job-1/doc-1/source.pdf");
    expect(getOrCreateContainer("staging").deleted).not.toContain("uploads/other-job/doc-2/other.pdf");
    expect(getOrCreateContainer("incoming").deleted).toContain("incoming/job-1/doc-1/source.pdf");
    expect(getOrCreateContainer("incoming").deleted).not.toContain("incoming/other-job/doc-2/other.pdf");
    expect(getOrCreateContainer("results").deleted).toEqual(["job-1/incoming/job-1/doc-1/source.pdf.ocr.json"]);
    expect(getOrCreateContainer("outputs").deleted).toContain("job-1/doc-1/document.layout.json");
    expect(getOrCreateContainer("outputs").deleted).toContain("archives/arch-1.zip");
    expect(getOrCreateContainer("outputs").deleted).not.toContain("other-job/doc-2/document.layout.json");
    expect(mocks.documents.deleteEntity).toHaveBeenCalledTimes(1);
    expect(mocks.documents.deleteEntity).toHaveBeenCalledWith("job-1", "doc-1");
    expect(mocks.jobs.deleteEntity).toHaveBeenCalledTimes(1);
    expect(mocks.jobs.deleteEntity).toHaveBeenCalledWith("owner", "user-1:job-1");
    expect(mocks.archives.deleteEntity).toHaveBeenCalledTimes(1);
    expect(mocks.archives.deleteEntity).toHaveBeenCalledWith("user-1", "arch-1");
  });

  it("rejects session cleanup while any owned document is still processing", async () => {
    mocks.jobs.listEntities.mockReturnValue(entities(
      { partitionKey: "owner", rowKey: "user-1:job-1", JobId: "job-1", OwnerId: "user-1", TenantId: "tenant-1", Status: "processing" }
    ));
    mocks.documents.listEntities.mockReturnValue(entities(
      { partitionKey: "job-1", rowKey: "doc-1", DocumentId: "doc-1", JobId: "job-1", OwnerId: "user-1", TenantId: "tenant-1", Status: "processing" }
    ));
    mocks.archives.listEntities.mockReturnValue(entities());

    await expect(clearUserSession({
      objectId: "user-1",
      tenantId: "tenant-1",
      name: "User One",
      roles: ["Processor.User"]
    })).rejects.toBeInstanceOf(SessionBusyError);
    expect(mocks.documents.deleteEntity).not.toHaveBeenCalled();
    expect(mocks.jobs.deleteEntity).not.toHaveBeenCalled();
  });

  it("prevents cross-user or cross-tenant document and job access", async () => {
    mocks.jobs.getEntity.mockResolvedValue({
      JobId: "job-1",
      OwnerId: "user-2",
      TenantId: "tenant-1",
      Status: "completed",
      CreatedAt: "2026-11-11T00:00:00Z",
      DocumentCount: 1,
      CompletedCount: 1,
      FailedCount: 0
    });
    mocks.documents.listEntities.mockReturnValue(entities({
      DocumentId: "doc-1",
      JobId: "job-1",
      OwnerId: "user-1",
      TenantId: "other-tenant",
      OriginalName: "secret.pdf",
      BlobName: "incoming/job-1/doc-1/secret.pdf",
      Size: 100,
      ContentType: "application/pdf",
      Status: "completed",
      CreatedAt: "2026-11-11T00:00:00Z"
    }));

    await expect(getOwnedJob("job-1", "user-1", "tenant-1")).resolves.toBeNull();
    await expect(getOwnedDocument("doc-1", "user-1", "tenant-1")).resolves.toBeNull();
  });
});
