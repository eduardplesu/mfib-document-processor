import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { getUser, hasProcessorRole, rejectCrossOrigin } from "../../src/lib/auth";

function requestWithRole(type: string, value: string): NextRequest {
  const principal = {
    claims: [
      { typ: "oid", val: "user-id" },
      { typ: "tid", val: "tenant-id" },
      { typ: type, val: value }
    ]
  };
  return new NextRequest("https://example.test/api/me", {
    headers: { "x-ms-client-principal": Buffer.from(JSON.stringify(principal)).toString("base64") }
  });
}

describe("Entra application roles", () => {
  it.each(["roles", "http://schemas.microsoft.com/ws/2008/06/identity/claims/role"])(
    "accepts the processor role in the %s claim",
    (type) => {
      const user = getUser(requestWithRole(type, "Processor.User"));
      expect(user && hasProcessorRole(user)).toBe(true);
    }
  );

  it("rejects users without a processor role", () => {
    const user = getUser(requestWithRole("roles", "Other.Role"));
    expect(user && hasProcessorRole(user)).toBe(false);
  });
});

describe("same-origin mutations", () => {
  it("accepts a direct request from the same origin", () => {
    const request = new NextRequest("https://portal.example.test/api/jobs", {
      headers: { origin: "https://portal.example.test" }
    });
    expect(rejectCrossOrigin(request)).toBeNull();
  });

  it("accepts the public origin when App Service terminates TLS", () => {
    const request = new NextRequest("http://127.0.0.1:8080/api/jobs", {
      headers: {
        host: "portal.example.test",
        origin: "https://portal.example.test",
        "x-forwarded-proto": "https"
      }
    });
    expect(rejectCrossOrigin(request)).toBeNull();
  });

  it.each(["https://attacker.example", "http://127.0.0.1:8080", ""])(
    "rejects foreign, internal, or missing origins behind the proxy",
    (origin) => {
      const request = new NextRequest("http://127.0.0.1:8080/api/jobs", {
        headers: {
          host: "portal.example.test",
          origin,
          "x-forwarded-proto": "https",
          "x-forwarded-host": "attacker.example"
        }
      });
      expect(rejectCrossOrigin(request)?.status).toBe(403);
    }
  );
});
