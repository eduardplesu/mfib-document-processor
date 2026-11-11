import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type TestContext = { log: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> };
type Handler = (message: unknown, context: TestContext) => Promise<void>;

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  jobs: { listEntities: vi.fn(), updateEntity: vi.fn() },
  documents: { listEntities: vi.fn(), updateEntity: vi.fn() },
  archives: { listEntities: vi.fn(), deleteEntity: vi.fn() },
  sendMessage: vi.fn(),
  deleteBlob: vi.fn()
}));

vi.mock("@azure/functions", () => ({
  app: {
    storageQueue: (name: string, options: { handler: Handler }) => { mocks.handlers[name] = options.handler; },
    timer: (name: string, options: { handler: Handler }) => { mocks.handlers[name] = options.handler; }
  }
}));

vi.mock("@azure/data-tables", () => ({
  TableClient: vi.fn().mockImplementation((_url: string, name: string) => {
    const tables: Record<string, unknown> = {
      Jobs: mocks.jobs, Documents: mocks.documents, Archives: mocks.archives
    };
    if (!tables[name]) throw new Error(`Unexpected table: ${name}`);
    return tables[name];
  })
}));

vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: vi.fn().mockImplementation(() => ({
    getToken: vi.fn().mockResolvedValue({ token: "test-token" })
  }))
}));

vi.mock("@azure/storage-blob", () => ({
  BlobServiceClient: vi.fn().mockImplementation(() => ({
    getContainerClient: () => ({ deleteBlob: mocks.deleteBlob })
  }))
}));

vi.mock("@azure/storage-queue", () => ({
  QueueClient: vi.fn().mockImplementation(() => ({ sendMessage: mocks.sendMessage }))
}));

vi.mock("archiver", () => ({ default: vi.fn() }));
vi.mock("../../packages/shared/src/excel.js", () => ({ createWorkbook: vi.fn() }));

async function* entities<T>(...items: T[]) {
  yield* items;
}

describe("document worker table keys", () => {
  const job = {
    partitionKey: "owner", rowKey: "user-1:job-1", etag: "etag-1",
    JobId: "job-1", OwnerId: "user-1", TenantId: "tenant-1", Status: "queued"
  };
  const context = { log: vi.fn(), error: vi.fn() };

  beforeAll(async () => {
    vi.stubEnv("AZURE_STORAGE_ACCOUNT_URL", "https://example.blob.core.windows.net");
    vi.stubEnv("DOCUMENT_INTELLIGENCE_ENDPOINT", "https://example.cognitiveservices.azure.com");
    await import("../../functions/src/index");
  }, 30_000);

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.jobs.listEntities.mockReset();
    mocks.documents.listEntities.mockReset();
    mocks.archives.listEntities.mockReset();
  });

  afterEach(() => vi.unstubAllGlobals());
  afterAll(() => vi.unstubAllEnvs());

  it("uses the returned job and document keys when submitting OCR", async () => {
    mocks.jobs.listEntities.mockReturnValue(entities(job));
    mocks.documents.listEntities.mockReturnValue(entities({
      partitionKey: "job-1", rowKey: "document-1", Status: "queued"
    }));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, {
      status: 202, headers: { "operation-location": "https://example.cognitiveservices.azure.com/operation" }
    })));

    await mocks.handlers.processDocumentJob({ jobId: "job-1", ownerId: "user-1", tenantId: "tenant-1" }, context);

    expect(mocks.jobs.updateEntity).toHaveBeenNthCalledWith(1, expect.objectContaining({
      partitionKey: "owner", rowKey: "user-1:job-1", Status: "processing", SubmissionState: "submitting"
    }), "Merge", { etag: "etag-1" });
    expect(mocks.jobs.updateEntity).toHaveBeenNthCalledWith(2, expect.objectContaining({
      partitionKey: "owner", rowKey: "user-1:job-1", SubmissionState: "submitted"
    }), "Merge");
    expect(mocks.documents.updateEntity).toHaveBeenCalledWith(
      { partitionKey: "job-1", rowKey: "document-1", Status: "processing" }, "Merge"
    );
  });

  it("fails explicitly when a returned job is missing its keys", async () => {
    mocks.jobs.listEntities.mockReturnValue(entities({ ...job, rowKey: undefined }));
    vi.stubGlobal("fetch", vi.fn());

    await expect(mocks.handlers.processDocumentJob(
      { jobId: "job-1", ownerId: "user-1", tenantId: "tenant-1" }, context
    )).rejects.toThrow("Table entity is missing its partition or row key.");
    expect(mocks.jobs.updateEntity).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses returned keys when recovering queued jobs and removing expired archives", async () => {
    mocks.jobs.listEntities.mockReturnValueOnce(entities(job)).mockReturnValueOnce(entities());
    mocks.archives.listEntities.mockReturnValue(entities({
      partitionKey: "user-1", rowKey: "archive-1", ArchiveId: "archive-1",
      ExpiresAt: "2000-01-01T00:00:00Z", BlobName: "archives/archive-1.zip"
    }));

    await mocks.handlers.reconcileOcr(undefined, context);

    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.jobs.updateEntity).toHaveBeenCalledWith(expect.objectContaining({
      partitionKey: "owner", rowKey: "user-1:job-1"
    }), "Merge");
    expect(mocks.deleteBlob).toHaveBeenCalledWith("archives/archive-1.zip");
    expect(mocks.archives.deleteEntity).toHaveBeenCalledWith("user-1", "archive-1");
  });
});
