# Implementation checklist

## Delivered in this repository

- [x] Next.js/TypeScript portal foundation and Romanian dashboard.
- [x] App Service Authentication configuration, role checks, owner checks, and local-only development identity.
- [x] Private Blob/Queue/Table resources, Managed Identity roles, short-lived blob upload SAS, and file signature checks.
- [x] Persistent job/document metadata and a queue/timer Azure Functions worker.
- [x] Document Intelligence v4.0 `2024-11-30` `prebuilt-layout:analyzeBatch` submission and polling.
- [x] Shared Excel exporter, raw layout JSON, native Markdown content, manifest, and structural warnings.
- [x] Asynchronous streamed ZIP creation and configured archive expiry.
- [x] Bicep resources for standard and private-endpoint profiles, Entra bootstrap, deployment scripts, CI, and manual deployment workflow.
- [x] Synthetic F3 fixture and focused local unit tests.

## Required before production

- [ ] Entra administrator configures the App Service managed-identity federated credential, grants any required consent, and assigns user/group app roles.
- [ ] Run Bicep `what-if` and deploy only after verifying tenant, subscription, region, quotas, and budget approval.
- [ ] Build/deploy app and Functions in a test tenant; verify all managed-identity role assignments and Storage/Document Intelligence access.
- [ ] Validate private DNS, VPN access, and Document Intelligence access to private Storage when hardened mode is enabled.
- [ ] Run live batch OCR tests against representative synthetic files and verify `sourceUrl` to document ID mapping.
- [ ] Add/execute integration, cross-user, retry/recovery, and browser end-to-end tests.
- [ ] Verify CSP, rate limits, malware-scanning decision, storage lifecycle, and security/dependency scans.

See the deployment plan for the current Azure deployment and validation status; infrastructure provisioning alone does not establish that the application works end to end.
