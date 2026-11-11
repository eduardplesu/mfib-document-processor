# Security

- App Service Authentication is single-tenant and requires authentication by default. The dashboard shell, static assets (`/_next/static/*`, `/branding/*`), and health route are explicit unauthenticated exceptions; data APIs require an Entra principal and application role.
- All document, job, and archive queries and mutations enforce both `OwnerId` and `TenantId` isolation so users can only view, download, archive, or clear their own session data.
- Users can clear their completed session via `DELETE /api/jobs` (`Curăță sesiunea`), which deletes their input (`staging`, `incoming`), intermediate (`results`), and output (`outputs`, `archives`) blobs and table records.
- The signed-in user's name is read server-side from Microsoft Graph `/me` using delegated `User.Read`. Provider tokens are not returned by the application's profile API or recorded in logs.
- Job/document/archive access is scoped to the signed-in object ID. Storage paths are generated server-side and are not authorization tokens.
- Browser upload SAS grants create/write to one staging blob, uses HTTPS, and expires within one hour. Finalization validates and conditionally copies the blob to the private originals container; the staging SAS cannot modify the OCR input. Abandoned staging blobs expire after two days. Storage shared-key access and anonymous containers are disabled in the Bicep profile.
- App Service and Functions use managed identities. Storage role assignments are data-plane roles; Functions also receives the Blob Data Owner role needed by the Functions host.
- Upload extension, size, and file-signature checks run before OCR. MIME values supplied by the browser are not treated as proof of file content.
- Exports are served with private cache controls and safe content-disposition headers. Mutating API requests require an exact same-origin `Origin`.
- Telemetry must not include source document content. Do not enable development auth outside local development.

The app role assignment, provider credential, admin consent, Defender for Storage, and security scans must be configured/verified by the tenant administrator. Enabling private networking requires client VPN connectivity and validation that Document Intelligence can reach the private Storage endpoints.
