import { describe, expect, it } from "vitest";
import { hasSupportedSignature, sanitizeFilename, validateFileMetadata } from "../../src/lib/files";

describe("file validation", () => {
  it("removes path components and dangerous filename characters", () => {
    expect(sanitizeFilename("../../Factura: 01.pdf")).toBe("Factura_ 01.pdf");
  });

  it("accepts supported, size-bounded metadata and rejects unsupported formats", () => {
    expect(validateFileMetadata({ name: "scan.pdf", size: 500, contentType: "text/plain" }).name).toBe("scan.pdf");
    expect(() => validateFileMetadata({ name: "report.exe", size: 10 })).toThrow("nu este acceptat");
    expect(() => validateFileMetadata({ name: "large.pdf", size: 11_000 }, 0.01)).toThrow("depășește");
  });

  it("checks actual file signatures rather than the client MIME type", () => {
    expect(hasSupportedSignature(".pdf", Buffer.from("%PDF-1.7"))).toBe(true);
    expect(hasSupportedSignature(".pdf", Buffer.from("not pdf"))).toBe(false);
    expect(hasSupportedSignature(".png", Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
  });
});
