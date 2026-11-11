import { describe, expect, it } from "vitest";
import { resultBlobName } from "../../functions/src/result-blob";

describe("OCR result blob location", () => {
  const container = "https://example.blob.core.windows.net/results";

  it("extracts a decoded blob name from the expected job", () => {
    expect(resultBlobName(`${container}/job-1/input/Fisa%20%231.pdf.ocr.json`, container, "job-1"))
      .toBe("job-1/input/Fisa #1.pdf.ocr.json");
  });

  it.each([
    "https://other.blob.core.windows.net/results/job-1/file.json",
    "https://example.blob.core.windows.net/other/job-1/file.json",
    "https://example.blob.core.windows.net/results/job-10/file.json"
  ])("rejects a result outside the container or job: %s", (result) => {
    expect(() => resultBlobName(result, container, "job-1")).toThrow();
  });
});
