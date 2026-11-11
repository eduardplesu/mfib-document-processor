import { afterEach, describe, expect, it, vi } from "vitest";
import { getGraphDisplayName } from "../../src/lib/graph-profile";

afterEach(() => vi.unstubAllGlobals());

describe("Microsoft Graph profile", () => {
  it("uses the signed-in user's given name and surname", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      id: "user-id", givenName: "  Ana ", surname: " Popescu ", displayName: "Different display name"
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGraphDisplayName("delegated-token", "user-id")).resolves.toBe("Ana Popescu");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.microsoft.com/v1.0/me?$select=id,givenName,surname,displayName,mail,userPrincipalName",
      expect.objectContaining({
        headers: { authorization: "Bearer delegated-token" },
        cache: "no-store"
      })
    );
  });

  it("uses the directory display name or guest email when name parts are missing", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(Response.json({
        id: "user-id", givenName: null, surname: "Popescu", displayName: "Ana Popescu"
      }))
      .mockResolvedValueOnce(Response.json({
        id: "guest-id", givenName: null, surname: null, displayName: null, mail: "guest@partner.ro"
      })));
    await expect(getGraphDisplayName("delegated-token", "USER-ID")).resolves.toBe("Ana Popescu");
    await expect(getGraphDisplayName("delegated-token", "guest-id")).resolves.toBe("guest@partner.ro");
  });

  it("surfaces Graph authorization failures and missing profile names", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ id: "user-id", givenName: null, surname: null, displayName: null }))
      .mockResolvedValueOnce(Response.json({ id: "another-user", givenName: "Ana", surname: "Popescu" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getGraphDisplayName("delegated-token", "user-id")).rejects.toMatchObject({ status: 403 });
    await expect(getGraphDisplayName("delegated-token", "user-id")).rejects.toThrow("does not contain a name");
    await expect(getGraphDisplayName("delegated-token", "user-id")).rejects.toThrow("does not match the authenticated user");
  });
});
