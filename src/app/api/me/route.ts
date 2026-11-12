import { NextRequest } from "next/server";
import { forbidden, getUser, hasProcessorRole, unauthorized } from "@/lib/auth";
import { getGraphDisplayName, GraphProfileError } from "@/lib/graph-profile";

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) return unauthorized();
  if (!hasProcessorRole(user)) return forbidden();

  const token = request.headers.get("x-ms-token-aad-access-token");
  let name = user.name;
  if (token) {
    try {
      name = await getGraphDisplayName(token, user.objectId);
    } catch (error) {
      const status = error instanceof GraphProfileError ? error.status : undefined;
      console.warn("Microsoft Graph profile fallback to ID token claims.", {
        status, kind: error instanceof Error ? error.name : "UnknownError"
      });
    }
  }

  return Response.json({
    name,
    roles: user.roles,
    appDisplayName: process.env.APP_DISPLAY_NAME ?? "Document Processor",
    organizationName: process.env.ORGANIZATION_NAME ?? "MFIB",
    logoPath: process.env.BRANDING_LOGO_PATH ?? "/branding/ministry-logo.jpeg"
  }, { headers: { "cache-control": "no-store" } });
}
