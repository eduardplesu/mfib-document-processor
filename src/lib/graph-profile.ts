import { z } from "zod";

const profileSchema = z.object({
  id: z.string().min(1),
  givenName: z.string().nullish(),
  surname: z.string().nullish(),
  displayName: z.string().nullish()
});

export class GraphProfileError extends Error {
  constructor(public readonly status: number) {
    super(`Microsoft Graph returned HTTP ${status}.`);
    this.name = "GraphProfileError";
  }
}

export async function getGraphDisplayName(accessToken: string, userObjectId: string): Promise<string> {
  const response = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,givenName,surname,displayName", {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new GraphProfileError(response.status);

  const profile = profileSchema.safeParse(await response.json());
  if (!profile.success) throw new Error("Microsoft Graph returned an invalid user profile.");
  if (profile.data.id.toLowerCase() !== userObjectId.toLowerCase()) {
    throw new Error("The Microsoft Graph profile does not match the authenticated user.");
  }

  const givenName = profile.data.givenName?.trim();
  const surname = profile.data.surname?.trim();
  const name = givenName && surname
    ? `${givenName} ${surname}`
    : profile.data.displayName?.trim() || givenName || surname;
  if (!name) throw new Error("The Microsoft Graph user profile does not contain a name.");
  return name;
}
