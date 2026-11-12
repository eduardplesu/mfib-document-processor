import { NextRequest } from "next/server";
import { forbidden, getUser, hasProcessorRole, unauthorized } from "@/lib/auth";
import { ensureStorage, getBlobService } from "@/lib/azure";
import { config } from "@/lib/config";
import { getOwnedDocument } from "@/lib/ownership";

export const runtime = "nodejs";
type Context = { params: Promise<{ documentId: string }> };
const formats = new Set(["content.md"]);
const contentTypes: Record<string, string> = {
  "content.md": "text/markdown; charset=utf-8"
};

export async function GET(request: NextRequest, { params }: Context) {
  const user = getUser(request);
  if (!user) return unauthorized();
  if (!hasProcessorRole(user)) return forbidden();
  await ensureStorage();
  const { documentId } = await params;
  const document = await getOwnedDocument(documentId, user.objectId, user.tenantId);
  if (!document) return Response.json({ error: "Documentul nu a fost găsit." }, { status: 404 });
  if (document.status !== "completed" && document.status !== "review") return Response.json({ error: "Rezultatul nu este disponibil." }, { status: 409 });
  const format = request.nextUrl.searchParams.get("format") ?? "";
  if (!formats.has(format) || !document.outputs?.includes(format)) return Response.json({ error: "Format indisponibil." }, { status: 404 });
  const blob = getBlobService().getContainerClient(config.outputsContainer).getBlobClient(`${document.jobId}/${document.documentId}/document.${format}`);
  const buffer = await blob.downloadToBuffer();
  const baseName = document.originalName.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9._-]/g, "_") || document.documentId;
  const headers = new Headers({
    "content-type": contentTypes[format] ?? "application/octet-stream",
    "content-length": String(buffer.byteLength),
    "content-disposition": `attachment; filename="${baseName}.${format.replaceAll('"', "")}"`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff"
  });
  return new Response(new Uint8Array(buffer), { headers });
}
