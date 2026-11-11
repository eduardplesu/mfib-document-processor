export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required configuration: ${name}`);
  return value;
}

export const config = {
  get storageUrl() {
    return requiredEnv("AZURE_STORAGE_ACCOUNT_URL");
  },
  get documentsContainer() {
    return process.env.DOCUMENTS_CONTAINER ?? "incoming";
  },
  get uploadsContainer() {
    return process.env.UPLOADS_CONTAINER ?? "staging";
  },
  get resultsContainer() {
    return process.env.RESULTS_CONTAINER ?? "results";
  },
  get outputsContainer() {
    return process.env.OUTPUTS_CONTAINER ?? "outputs";
  },
  get jobsTable() {
    return process.env.JOBS_TABLE ?? "Jobs";
  },
  get documentsTable() {
    return process.env.DOCUMENTS_TABLE ?? "Documents";
  },
  get queueName() {
    return process.env.QUEUE_NAME ?? "document-jobs";
  },
  get archiveQueueName() {
    return process.env.ARCHIVE_QUEUE_NAME ?? "archive-jobs";
  },
  get archivesTable() {
    return process.env.ARCHIVES_TABLE ?? "Archives";
  }
};
