import { randomUUID } from "node:crypto";
import { z } from "zod";

const allowedExtensions = new Set([".pdf", ".jpg", ".jpeg", ".png", ".tif", ".tiff"]);
const fileSchema = z.object({
  name: z.string().min(1).max(255),
  size: z.number().int().positive(),
  contentType: z.string().max(120).optional().default("application/octet-stream")
});

export function sanitizeFilename(name: string): string {
  const leaf = name.replaceAll("\\", "/").split("/").at(-1) ?? "document";
  const safe = leaf.normalize("NFKC").replace(/[^\p{L}\p{N}._ -]/gu, "_").replace(/^\.+/, "").trim();
  return safe.slice(0, 150) || "document";
}

export function validateFileMetadata(value: unknown, maxSizeMb = 100) {
  const file = fileSchema.parse(value);
  const extension = file.name.toLowerCase().slice(file.name.lastIndexOf("."));
  if (!allowedExtensions.has(extension)) throw new Error("Formatul fișierului nu este acceptat.");
  if (file.size > maxSizeMb * 1024 * 1024) throw new Error(`Fișierul depășește limita de ${maxSizeMb} MB.`);
  return { ...file, name: sanitizeFilename(file.name), documentId: randomUUID() };
}

export function hasSupportedSignature(extension: string, bytes: Uint8Array): boolean {
  if (extension === ".pdf") return bytes.length >= 5 && String.fromCharCode(...bytes.slice(0, 5)) === "%PDF-";
  if (extension === ".png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v);
  if (extension === ".jpg" || extension === ".jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (extension === ".tif" || extension === ".tiff") {
    return bytes.length >= 4 && ((bytes[0] === 73 && bytes[1] === 73 && bytes[2] === 42 && bytes[3] === 0)
      || (bytes[0] === 77 && bytes[1] === 77 && bytes[2] === 0 && bytes[3] === 42));
  }
  return false;
}
