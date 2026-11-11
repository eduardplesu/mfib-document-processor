import { NextRequest } from "next/server";
import { getArchivesTable, getBlobService } from "@/lib/azure";
import { forbidden, getUser, hasProcessorRole, unauthorized } from "@/lib/auth";
import { config } from "@/lib/config";

export const runtime = "nodejs";
type Context = { params: Promise<{ archiveId: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  const user = getUser(request);
  if (!user) return unauthorized();
  if (!hasProcessorRole(user)) return forbidden();
  const { archiveId } = await params;
  try {
    const record = await getArchivesTable().getEntity(user.objectId, archiveId);
    if (String(record.OwnerId) !== user.objectId || String(record.TenantId) !== user.tenantId) {
      return Response.json({ error: "Arhiva nu a fost găsită." }, { status: 404 });
    }
    if (record.Status !== "completed") return Response.json({ error: "Arhiva nu este gata." }, { status: 409 });
    const blob = getBlobService().getContainerClient(config.outputsContainer).getBlobClient(`archives/${archiveId}.zip`);
    const buffer = await blob.downloadToBuffer();
    return new Response(new Uint8Array(buffer), {
      headers: {
        "content-type": "application/zip",
        "content-length": String(buffer.byteLength),
        "content-disposition": `attachment; filename="documente-${archiveId}.zip"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff"
      }
    });
  } catch (error) {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 404) {
      return Response.json({ error: "Arhiva nu a fost găsită." }, { status: 404 });
    }
    throw error;
  }
}
