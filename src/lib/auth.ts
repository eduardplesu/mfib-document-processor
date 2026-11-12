import type { NextRequest } from "next/server";
import type { AuthenticatedUser } from "./types";

export function getUser(request: NextRequest): AuthenticatedUser | null {
  const principal = request.headers.get("x-ms-client-principal");
  if (principal) {
    try {
      const parsed = JSON.parse(Buffer.from(principal, "base64").toString("utf8")) as {
        userId?: string;
        identityProvider?: string;
        userDetails?: string;
        claims?: Array<{ typ?: string; val?: string }>;
      };
      const claim = (...names: string[]) => parsed.claims?.find((item) => names.includes(item.typ ?? ""))?.val;
      const objectId = claim("http://schemas.microsoft.com/identity/claims/objectidentifier", "oid") ?? parsed.userId;
      const tenantId = claim("http://schemas.microsoft.com/identity/claims/tenantid", "tid");
      const displayName = claim(
        "name",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
        "preferred_username",
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"
      ) ?? parsed.userDetails;
      if (!objectId || !tenantId) return null;
      const rawRoles = parsed.claims?.filter((item) =>
        item.typ === "roles" || item.typ === "http://schemas.microsoft.com/ws/2008/06/identity/claims/role"
      ).map((item) => item.val ?? "").filter(Boolean) ?? [];
      const roles = rawRoles.length > 0
        ? rawRoles
        : process.env.REQUIRE_EXPLICIT_APP_ROLE === "true"
          ? []
          : ["Processor.User"];
      return {
        objectId,
        tenantId,
        name: displayName?.trim() || "Utilizator",
        roles
      };
    } catch {
      return null;
    }
  }

  if (process.env.NODE_ENV !== "production" && process.env.DEV_AUTH_ENABLED === "true" && process.env.DEV_USER_ID) {
    return {
      objectId: process.env.DEV_USER_ID,
      tenantId: "local-development",
      name: process.env.DEV_USER_NAME ?? "Utilizator local",
      roles: ["Processor.User"]
    };
  }
  return null;
}

export function unauthorized(): Response {
  return Response.json({ error: "Autentificare necesară." }, { status: 401 });
}

export function forbidden(): Response {
  return Response.json({ error: "Este necesar rolul Processor User sau Processor Admin." }, { status: 403 });
}

export function hasProcessorRole(user: AuthenticatedUser): boolean {
  return user.roles.includes("Processor.User") || user.roles.includes("Processor.Admin");
}

export function rejectCrossOrigin(request: NextRequest): Response | null {
  const origin = request.headers.get("origin");
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
  const host = request.headers.get("host");
  const expectedOrigin = forwardedProtocol
    ? host && ["http", "https"].includes(forwardedProtocol) ? `${forwardedProtocol}://${host}` : null
    : request.nextUrl.origin;
  if (!origin || origin !== expectedOrigin) {
    return Response.json({ error: "Originea cererii nu este permisă." }, { status: 403 });
  }
  return null;
}
