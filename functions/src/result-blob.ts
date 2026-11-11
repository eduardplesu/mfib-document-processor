export function resultBlobName(resultUrl: string, containerUrl: string, jobId: string): string {
  const result = new URL(resultUrl);
  const container = new URL(containerUrl);
  const containerPath = `${container.pathname.replace(/\/$/, "")}/`;
  if (result.origin !== container.origin || !result.pathname.startsWith(containerPath)) {
    throw new Error("OCR result is outside the configured results container.");
  }
  const blobName = decodeURIComponent(result.pathname.slice(containerPath.length));
  if (!blobName.startsWith(`${jobId}/`)) {
    throw new Error("OCR result is outside the requested job prefix.");
  }
  return blobName;
}
