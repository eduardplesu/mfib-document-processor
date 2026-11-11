import { DefaultAzureCredential } from "@azure/identity";
import { TableClient } from "@azure/data-tables";
import { BlobServiceClient } from "@azure/storage-blob";
import { QueueClient } from "@azure/storage-queue";
import { config } from "./config";

let blobClient: BlobServiceClient | undefined;
let jobsClient: TableClient | undefined;
let documentsClient: TableClient | undefined;
let archivesClient: TableClient | undefined;
let jobQueueClient: QueueClient | undefined;
let archiveQueueClient: QueueClient | undefined;

function storageConnectionString(): string | undefined {
  return process.env.AZURE_STORAGE_CONNECTION_STRING;
}

function credential() {
  return storageConnectionString() ? undefined : new DefaultAzureCredential();
}

export function getBlobService(): BlobServiceClient {
  if (!blobClient) {
    const connectionString = storageConnectionString();
    blobClient = connectionString
      ? BlobServiceClient.fromConnectionString(connectionString)
      : new BlobServiceClient(config.storageUrl, credential()!);
  }
  return blobClient;
}

function tableClient(tableName: string): TableClient {
  const connectionString = storageConnectionString();
  if (connectionString) return TableClient.fromConnectionString(connectionString, tableName);
  const tableUrl = config.storageUrl.replace(".blob.", ".table.");
  return new TableClient(tableUrl, tableName, credential()!);
}

export function getJobsTable(): TableClient {
  return jobsClient ??= tableClient(config.jobsTable);
}

export function getDocumentsTable(): TableClient {
  return documentsClient ??= tableClient(config.documentsTable);
}

export function getArchivesTable(): TableClient {
  return archivesClient ??= tableClient(config.archivesTable);
}

export function getJobQueue(): QueueClient {
  if (!jobQueueClient) {
    const connectionString = storageConnectionString();
    jobQueueClient = connectionString
      ? new QueueClient(connectionString, config.queueName)
      : new QueueClient(`${config.storageUrl.replace(".blob.", ".queue.")}/${config.queueName}`, credential()!);
  }
  return jobQueueClient;
}

export function getArchiveQueue(): QueueClient {
  if (!archiveQueueClient) {
    const connectionString = storageConnectionString();
    archiveQueueClient = connectionString
      ? new QueueClient(connectionString, config.archiveQueueName)
      : new QueueClient(`${config.storageUrl.replace(".blob.", ".queue.")}/${config.archiveQueueName}`, credential()!);
  }
  return archiveQueueClient;
}

export async function ensureStorage(): Promise<void> {
  await Promise.all([
    getJobsTable().createTable().catch(ignoreAlreadyExists),
    getDocumentsTable().createTable().catch(ignoreAlreadyExists),
    getArchivesTable().createTable().catch(ignoreAlreadyExists),
    getJobQueue().createIfNotExists(),
    getArchiveQueue().createIfNotExists(),
    ...[config.uploadsContainer, config.documentsContainer, config.resultsContainer, config.outputsContainer]
      .map((name) => getBlobService().getContainerClient(name).createIfNotExists())
  ]);
}

function ignoreAlreadyExists(error: unknown): void {
  if (error instanceof Error && "statusCode" in error && error.statusCode === 409) return;
  throw error;
}
