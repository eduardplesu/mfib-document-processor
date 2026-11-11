import { NextRequest } from "next/server";
import { getArchivesTable } from "@/lib/azure";
import { forbidden, getUser, hasProcessorRole, unauthorized } from "@/lib/auth";

export const runtime = "nodejs";
type Context = { params: Promise<{ archiveId: string }> };

export async function GET(request: NextRequest, { params }: Context) {
  const user = getUser(request);
  if (!user) return unauthorized();
  if (!hasProcessorRole(user)) return forbidden();
  const { archiveId } = await params;
  try {
    const entity = await getArchivesTable().getEntity(user.objectId, archiveId);
    if (String(entity.OwnerId) !== user.objectId || String(entity.TenantId) !== user.tenantId) {
      return Response.json({ error: "Arhiva nu a fost găsită." }, { status: 404 });
    }
    return Response.json({
      archiveId, status: entity.Status, error: entity.Error,
      downloadUrl: entity.Status === "completed" ? `/api/archives/${archiveId}/download` : undefined
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof Error && "statusCode" in error && error.statusCode === 404) {
      return Response.json({ error: "Arhiva nu a fost găsită." }, { status: 404 });
    }
    throw error;
  }
}
