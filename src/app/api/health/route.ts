export function GET() {
  return Response.json({ status: "ok", version: process.env.APP_VERSION ?? "0.1.0" }, {
    headers: { "cache-control": "no-store" }
  });
}
