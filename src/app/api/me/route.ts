import { NextRequest } from "next/server";
import { forbidden, getUser, hasProcessorRole, unauthorized } from "@/lib/auth";
import { getGraphDisplayName, GraphProfileError } from "@/lib/graph-profile";

export async function GET(request: NextRequest) {
  const user = getUser(request);
  if (!user) return unauthorized();
  if (!hasProcessorRole(user)) return forbidden();

  const token = request.headers.get("x-ms-token-aad-access-token");
  let name: string;
  if (!token && process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_ENABLED === "true") {
    name = user.name;
  } else if (!token) {
    return Response.json({
      code: "GRAPH_TOKEN_MISSING",
      error: "Reconectați-vă pentru a permite afișarea numelui din Microsoft Graph."
    }, { status: 401, headers: { "cache-control": "no-store" } });
  } else {
    try {
      name = await getGraphDisplayName(token, user.objectId);
    } catch (error) {
      const status = error instanceof GraphProfileError ? error.status : undefined;
      console.error("Microsoft Graph profile retrieval failed.", {
        status, kind: error instanceof Error ? error.name : "UnknownError"
      });
      if (status === 401) {
        return Response.json({
          code: "GRAPH_TOKEN_EXPIRED",
          error: "Sesiunea pentru profil a expirat. Reconectați-vă."
        }, { status: 401, headers: { "cache-control": "no-store" } });
      }
      if (user.name && user.name !== "Utilizator") {
        name = user.name;
      } else {
        return Response.json({
          error: "Numele din Microsoft Graph nu este disponibil. Încercați din nou."
        }, { status: 502, headers: { "cache-control": "no-store" } });
      }
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
