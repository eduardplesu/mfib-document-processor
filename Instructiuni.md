# MASTER IMPLEMENTATION PROMPT — MFIB Document Processor

## ROLE AND EXECUTION MODE

You are a Principal Azure Solutions Architect, Senior Full-Stack Engineer, Cloud Security Architect, and DevOps Engineer.

Your mission is to DESIGN, IMPLEMENT, TEST, DOCUMENT, and PREPARE FOR DEPLOYMENT a complete, production-oriented Azure application named:

**MFIB Document Processor**

Subtitle: **Secure Batch OCR & Document Extraction**

This must be a real, functioning application with a complete GitHub repository, infrastructure-as-code, deployment automation, and comprehensive documentation.

Do not produce only an architecture proposal, UI prototype, or pseudocode. Create the actual source files, infrastructure definitions, scripts, tests, and documentation.

Work autonomously, making reasonable engineering decisions while keeping the solution simple, secure, and maintainable.

If you have access to Azure, verify the tenant and subscription before performing any deployment. Never deploy to an unintended subscription.

Do not create billable Azure resources without explicit deployment approval.

---

# 1. BUSINESS OBJECTIVE

Build a secure document-processing portal for auditors and public-sector employees.

Users must be able to upload multiple scanned documents, including poor-quality scanned PDF files and photographs, automatically extract text and complex tables using Azure AI Document Intelligence, and download the processed results individually or in bulk as ZIP archives.

The application is a **document preprocessing and extraction platform**, not an AI chatbot.

Do not implement:
- Copilot Studio integration.
- Azure AI Search or RAG.
- Azure OpenAI or LLM-based interpretation.
- Conversational agents.
- SharePoint integrations.
- Complex document management workflows.
- Unnecessary databases or microservices.

The objective is to produce reliable, reusable, structured document outputs that may subsequently be consumed by other systems.

## Typical input

Scanned PDFs, JPG, PNG, TIFF, and other formats explicitly supported by the selected Azure Document Intelligence API.

Documents may contain:
- Poor-quality or low-resolution scans.
- Skewed pages.
- Small text and low contrast.
- Romanian diacritics.
- Complex tables with multiple header levels.
- Merged cells and nested visual structures.
- Financial values and decimal quantities.
- Negative numbers and financial corrections.
- Tables continuing across multiple pages.
- Material, labor, transportation, and equipment cost breakdowns.

A typical Romanian document is an F3 construction payment statement containing item codes, descriptions, units of measurement, quantities, unit prices, financial totals, and multiline cost breakdowns.

Data integrity matters more than visual presentation.

Never silently invent, modify, correct, or discard OCR values.

---

# 2. AZURE ENVIRONMENT

## Initial deployment

Azure tenant:

`Ministerul Fericirii și Ideilor Bune`

Azure subscription display name:

`mfib-ops`

Deployment location: configurable, with a supported EU Azure region as the default.

Suggested resource group:

`rg-mfib-document-processor`

Suggested resource naming prefix:

`mfib-docproc`

Use configurable names and Azure-generated unique suffixes where globally unique resource names are required.

Resolve the actual subscription ID and tenant ID through Azure CLI. Never assume them or embed placeholder GUIDs as real values.

## Portability requirement

The application MUST be tenant-agnostic.

A different organization must be able to fork or clone this GitHub repository, authenticate to its own Azure tenant, select its own subscription, and deploy a fully independent instance.

All tenant-specific and environment-specific settings must be configurable.

Do not hardcode:
- Tenant IDs.
- Subscription IDs.
- Resource IDs.
- App registration IDs.
- Storage account names.
- Azure endpoints.
- User object IDs.
- Group object IDs.
- Secrets or access tokens.
- Domain names.
- MFIB-specific infrastructure dependencies.

Use reusable Bicep parameters and configuration.

The architecture must support deployments in multiple independent Azure tenants without sharing storage, identities, data, or processing resources.

---

# 3. TECHNOLOGY STACK

Use a modern, lightweight TypeScript architecture.

## Frontend and backend

Preferred stack:
- Next.js with TypeScript and App Router.
- React.
- Tailwind CSS.
- Accessible UI components, preferably shadcn/ui.
- Lucide icons.
- Zod for API and input validation.
- Azure SDK for JavaScript/TypeScript.
- Node.js LTS runtime.

Host the web frontend and its authenticated API routes together on Azure App Service.

This keeps the architecture simple and avoids maintaining a separate public API infrastructure.

## Background processing

- Azure Functions using the supported Node.js programming model.
- Azure Storage Queue for job execution messages.
- Timer-based reconciliation for asynchronous batch status.
- Azure Table Storage for persistent job and document metadata.
- Azure Blob Storage for documents and generated outputs.
- Azure AI Document Intelligence S0, using the `prebuilt-layout` model.
- Application Insights for monitoring.

Prefer a straightforward worker and queue architecture over Durable Functions for the initial release.

Do not introduce Service Bus, Cosmos DB, SQL Server, Kubernetes, Redis, or API Management without a demonstrated functional requirement.

## OCR API

Use the supported Azure AI Document Intelligence v4.0 REST API:

`2024-11-30`

Primary operation:

`POST /documentintelligence/documentModels/prebuilt-layout:analyzeBatch`

Use the batch API whenever supported and appropriate.

Request Markdown content using:

`outputContentFormat=markdown`

Keep the full structured JSON output, including table information.

Before implementation, verify the exact current API schema, SDK support, polling endpoints, result structures, and supported options against official Microsoft documentation.

---

# 4. HIGH-LEVEL ARCHITECTURE

Implement the following processing pipeline:

User Browser
→ Microsoft Entra ID Authentication
→ Azure App Service / Next.js
→ Azure Blob Storage
→ Azure Storage Queue
→ Azure Functions Worker
→ Azure AI Document Intelligence Batch API
→ Azure Blob Storage (OCR results)
→ Azure Functions Export Processor
→ Azure Blob Storage (XLSX / JSON / Markdown)
→ App Service Download API
→ Browser Downloads / ZIP Archives

Use Azure Table Storage to maintain the persistent state of jobs and individual documents.

The system must remain asynchronous.

Users must not be required to keep their browser open while OCR is running.

---

# 5. USER INTERFACE AND EXPERIENCE

Create a polished, professional, responsive web application.

Design characteristics:
- Modern Microsoft Fluent-inspired enterprise appearance.
- Clean, minimalist layout.
- White or subtle neutral background.
- Appropriate spacing and typography.
- Professional status indicators.
- Accessible controls and keyboard navigation.
- Responsive desktop, tablet, and mobile layouts.
- Light theme by default.
- Optional dark theme.
- All user-facing text in Romanian.

Avoid excessive dashboards, unnecessary visual effects, and complex navigation.

## 5.1 Ministry branding

The top-left corner must display the official Ministry of Happiness logo.

The original branding assets are available in the existing project:

`https://github.com/eduardplesu/copilotmfib`

Inspect:

`Assets/Branding/`

Known files include:

`logo-dark.jpeg`

`logo-white.jpeg`

`logo_ministerulfericirii.jpeg`

Use the original logo asset when accessible.

Do not regenerate or redesign the logo.

Do not distort its aspect ratio.

Select the appropriate logo version based on the application header background.

Copy an authorized original asset into the new repository's public branding assets, for example:

`public/branding/ministry-logo.jpeg`

The header must contain:
- Official Ministry logo, top-left.
- Application title: `Document Processor`.
- Optional subtitle: `Procesarea inteligentă a documentelor`.
- Current authenticated user's name.
- Account menu.
- Logout action.

The logo should link to the application home page.

For deployments in other Azure tenants, make the organization name, application title, and logo configurable.

If the original logo is not accessible, create a documented asset placeholder and request the genuine file. Do not substitute an invented official-looking emblem.

## 5.2 Main dashboard

Create a page titled:

`Procesare documente`

Include a short description:

`Încarcă documente scanate și transformă-le automat în date structurate, pregătite pentru analiză.`

Show summary statistics:
- Documente încărcate.
- În procesare.
- Finalizate.
- Necesită verificare.
- Erori.

Statistics must come from real backend data, not hardcoded UI values.

## 5.3 Upload component

Implement a prominent drag-and-drop upload area.

Text:

`Trage documentele aici sau selectează fișiere`

Support multiple simultaneous file selection.

Display accepted file formats.

After selecting files, show:
- File name.
- File size.
- File type.
- Upload progress.
- Validation errors.
- Remove from selection.
- Retry on failure.

Primary action:

`Începe procesarea`

Support upload batches containing tens or hundreds of files.

Handle larger document batches without loading all file contents into browser memory.

Use bounded upload concurrency and resumable or retryable transfer where practical.

Never expose storage account keys to the browser.

## 5.4 Processing dashboard

After submission, display individual documents in a searchable and sortable table.

Columns:

1. Document.
2. Type.
3. Size.
4. Pages.
5. Upload date.
6. Processing status.
7. Progress.
8. Available formats.
9. Actions.

Statuses in Romanian:

- În așteptare.
- Se încarcă.
- Încărcat.
- În curs de procesare.
- Se generează rezultatele.
- Finalizat.
- Necesită verificare.
- Eroare.
- Anulat.

Use honest progress reporting.

If Azure Document Intelligence does not provide reliable per-document percentage completion, use clearly labeled processing stages or a batch counter rather than inventing a continuous percentage.

Show aggregate batch progress:

`42 din 75 documente finalizate`

Refresh status through lightweight polling, with appropriate backoff.

The UI must recover correctly after refreshing or reopening the page.

## 5.5 Individual document view

Clicking a document should open a details page or side panel.

Display:
- Original file name.
- Upload date.
- Processing status.
- Number of pages.
- Number of extracted tables.
- Processing duration.
- File format.
- Extraction warnings.
- Available output files.

Provide a simple document preview when practical.

The preview must not expose another user's files.

Users should be able to download each generated format separately.

## 5.6 Bulk selection and ZIP download

Allow users to select:
- One document.
- Several documents.
- All completed documents from a job.
- All completed documents on the filtered view, with explicit selection scope.

Provide an action:

`Descarcă selecția ca ZIP`

If the archive takes time to generate, create an asynchronous archive job.

Show:

`Se pregătește arhiva`

When ready:

`Arhiva este gata pentru descărcare`

Do not use a synchronous HTTP request to construct very large ZIP files in memory.

---

# 6. DOCUMENT PROCESSING WORKFLOW

Implement a persistent job-based workflow.

## Step 1 — Create processing job

When users start processing, create a unique job ID.

Persist:
- jobId.
- Tenant ID.
- Owner Entra object ID.
- Creation timestamp.
- Job status.
- Document count.
- Completion count.
- Failure count.
- Processing options.
- Storage references.

Every document must have its own document ID.

## Step 2 — Upload originals

Upload documents to private Azure Blob Storage.

Use unique, non-guessable storage paths, for example:

`incoming/{jobId}/{documentId}/{sanitizedFilename}`

Store the original filename separately from the internal blob path.

Preserve the original document unchanged.

Calculate a SHA-256 checksum where practical.

Validate file type, actual content signature, file size, and supported extensions.

Do not trust the client-provided MIME type.

Reject unsupported or potentially malicious file types.

## Step 3 — Submit job

Once all selected documents are uploaded successfully, finalize the job.

Publish a message to Azure Storage Queue.

The backend worker receives the message and starts processing.

Make job submission idempotent.

Avoid creating duplicate paid OCR jobs if queue messages are delivered more than once.

## Step 4 — Batch OCR

Use Azure AI Document Intelligence Batch API with `prebuilt-layout`.

Use either:
- A unique per-job storage prefix.
- An explicit JSONL file list for precisely identifying the documents in a batch.

Prefer an explicit file list if it provides safer deterministic document selection.

Use separate input and result containers.

Configure a unique result prefix for each job.

Set overwrite behavior deliberately to avoid unintentionally replacing previous results.

Capture and persist the operation-location or equivalent batch operation identifier.

Implement bounded retry logic for transient errors and HTTP 429 responses.

Respect `Retry-After` when provided.

Allow retry of failed documents without unnecessarily reprocessing successful ones.

Split oversized jobs into smaller batches based on supported API limits.

## Step 5 — Background reconciliation

Implement a timer-triggered Azure Function that checks the status of pending OCR operations.

Persist progress and failures to Azure Table Storage.

Do not depend on the browser to track batch completion.

Do not rely on Document Intelligence retaining operation status indefinitely.

Retrieve results promptly and retain application metadata independently.

Handle:
- Complete success.
- Partial success.
- Individual document failures.
- Operation timeout.
- Malformed response.
- Missing result blobs.
- Temporary Azure service outages.

Record per-document errors without blocking successful documents from being downloaded.

## Step 6 — Generate processed outputs

When OCR results become available, transform each document into downloadable formats.

Persist the generated files in a private output container.

Update metadata only after verifying successful output creation.

---

# 7. DOCUMENT OUTPUT REQUIREMENTS

For each successfully processed document, generate the following outputs.

## 7.1 Complete layout JSON

Filename:

`document.layout.json`

Preserve the original Azure Document Intelligence analysis result as faithfully as possible.

Include:
- Pages.
- Paragraphs.
- OCR text.
- Tables.
- Cells.
- Row indices.
- Column indices.
- Row spans.
- Column spans.
- Bounding regions.
- Available confidence information.
- Reading order and relevant structural metadata.

Do not discard useful information.

Add separate application metadata rather than altering the raw OCR response.

## 7.2 Excel workbook

Filename:

`document.tables.xlsx`

This is one of the most important application features.

Create a robust converter from Document Intelligence structured table results to XLSX.

Use a reliable maintained library, such as ExcelJS.

Requirements:
- Preserve table row and column positioning.
- Handle merged cells.
- Handle rowSpan and columnSpan.
- Preserve multiline cell content.
- Preserve Romanian diacritics.
- Preserve negative signs.
- Preserve decimal separators.
- Avoid shifting values into neighboring columns.
- Do not silently infer missing cells.
- Detect invalid or overlapping merge ranges.
- Handle multiple tables per page.
- Handle multiple pages per document.
- Create unique, valid Excel worksheet names.
- Preserve literal source values by default.

For ambiguous numeric values, preserve the OCR text rather than silently converting it.

Optional numeric normalization may be implemented separately, with explicit labeling and validation.

Treat extracted text as untrusted. Protect Excel exports against formula injection, including cell strings beginning with formula-triggering characters.

Preferred workbook organization:
- `Summary` worksheet with document metadata and table references.
- Separate worksheet for each extracted table, within Excel naming limits.
- `Warnings` worksheet for uncertain or structurally problematic extractions.

When a table continues across multiple pages, do not assume that independently detected tables should automatically be merged.

Preserve page associations and offer an explicit, validated merging strategy if implemented.

## 7.3 Markdown output

Filename:

`document.content.md`

Preserve:
- Headings.
- Paragraphs.
- Reading order.
- Lists.
- Tables.
- Page boundaries or references where useful.

Use the native Document Intelligence Markdown output when available.

Do not reduce complex tables to lossy plain-text approximations.

Preserve HTML table structures embedded in Markdown where needed for merged cells.

## 7.4 Extraction manifest

Filename:

`document.manifest.json`

Include:
- Document ID.
- Original filename.
- Source SHA-256.
- Job ID.
- Processing timestamp.
- OCR model.
- API version.
- Page count.
- Extracted table count.
- Output filenames.
- Processing warnings.
- Processing status.
- Application version.

The manifest must make it possible to trace exported outputs to their original document.

## 7.5 Searchable PDF

Do not automatically promise searchable PDF output from the `prebuilt-layout` model.

Implement this as an optional feature only if a verified supported Document Intelligence operation or separate processing path can produce it.

For MVP, searchable PDF is not mandatory.

Do not add another paid OCR pass by default.

---

# 8. EXTRACTION QUALITY AND INTEGRITY

Accuracy is a core requirement.

Create an extraction quality assessment module.

Detect:
- Empty OCR results.
- Documents with no recognizable text.
- Tables with unexpected structural gaps.
- Invalid merged-cell positioning.
- Missing output files.
- Conversion failures.
- Numeric fields containing suspicious characters.
- Negative values potentially affected by OCR.
- Missing expected table headers when a recognizable template is configured.
- Disagreement between available table dimensions and exported Excel dimensions.

Do not invent numeric confidence values when Document Intelligence does not expose appropriate confidence information.

Separate:
- Service-provided confidence.
- Structural validation warnings.
- Business-rule validation results.

Mark questionable documents as:

`Necesită verificare`

Do not block access to their results unless they are unsafe or unusable.

Provide warnings explaining why manual verification is appropriate.

For Romanian financial tables, specifically test:
- `-233.270000` as an extracted quantity.
- `1.426,500000`.
- `40.729,78`.
- Negative totals.
- Zero quantities.
- Long descriptions spanning multiple lines.
- Merged table headers.

Never round or reformat source data silently.

---

# 9. BULK DOWNLOAD AND ARCHIVING

Implement two downloading workflows.

## Individual document download

Allow downloading:
- JSON.
- XLSX.
- Markdown.
- Manifest.
- Optionally a ZIP containing all formats of that document.

## Multiple document download

When multiple documents are selected, create a ZIP archive.

Suggested structure:

    Audit_Export_2026-11-11.zip
      manifest.json
      Situatie_plata_001/
        document.layout.json
        document.tables.xlsx
        document.content.md
        document.manifest.json
      Factura_002/
        document.layout.json
        document.tables.xlsx
        document.content.md
        document.manifest.json

Use stable, collision-safe filenames.

Include an archive manifest listing every selected document and its processing status.

For partially successful jobs, allow exporting completed documents and clearly identify excluded or failed documents in the user interface.

Create large archives asynchronously with streaming.

Avoid loading complete archives into application memory.

Persist generated archives in private Blob Storage.

Provide secure, authorized download through the application.

Use configurable archive expiration and Blob lifecycle policies.

Prevent path traversal and ZIP-slip vulnerabilities.

---

# 10. SECURITY ARCHITECTURE

Apply security best practices suitable for a public-sector document-processing application.

## Identity

Use Microsoft Entra ID.

Authentication must be single-tenant for each deployed instance.

Use Azure App Service Authentication / Authorization where feasible.

Block unauthenticated access by default.

Use the authenticated Entra identity as the source of user identity.

Do not trust user identity headers supplied directly by external clients.

The application must not expose public unauthenticated API routes for document upload, listing, or download.

## Authorization

Implement application-level authorization for every document and job.

Users may access only documents they own unless explicitly granted an administrator role.

Configure two roles:
- Processor User.
- Processor Admin.

Use Entra application roles or another documented Entra-based authorization mechanism.

Never treat successful authentication as sufficient permission to access every document.

Use tenant ID and owner object ID consistently.

## Azure identities

Use Managed Identities for Azure resource access.

Avoid storage account keys and Document Intelligence API keys in application code.

Configure appropriate role assignments for:
- App Service.
- Azure Functions.
- Document Intelligence service identity.

Use the minimum supported storage data-plane permissions needed for each resource.

The Document Intelligence service identity must have access to its input and output containers.

Use Microsoft Entra authentication for Document Intelligence API calls where supported.

## Storage security

- Private Blob containers.
- Anonymous access disabled.
- Secure transfer required.
- TLS 1.2 or higher.
- No account keys embedded in source code.
- RBAC authorization.
- Restrict uploaded formats.
- Sanitize filenames.
- Validate file signatures.
- Enforce configurable limits.
- Protect against malicious uploaded content.

Provide optional Microsoft Defender for Storage malware scanning integration for production use.

Explain Defender costs and deployment prerequisites.

## Networking

Support two documented deployment profiles.

**Standard secure profile:** authenticated App Service, private data containers, Microsoft Entra identities, strict RBAC, HTTPS, and no anonymous storage access. Clearly document any remaining public Azure service endpoints.

**Hardened profile:** VNet integration, private endpoints for supported Storage and Document Intelligence resources, required private DNS configuration, and compatible App Service / Functions hosting plans.

Make the hardened profile deployable rather than merely mentioning private networking in documentation.

Do not enable storage access through broadly scoped permanent SAS tokens.

If direct browser upload is used, issue narrowly scoped short-lived user-delegation SAS tokens through an authenticated backend. Otherwise, securely stream uploads through the backend.

## Web application security

Implement:
- CSRF protection suitable for cookie-based sessions.
- Secure session cookies.
- Content Security Policy.
- XSS protection.
- Rate limiting.
- Input validation.
- File size restrictions.
- Safe download headers.
- Secure error handling.
- No PII or document text in telemetry.
- No sensitive credentials in client-side bundles.
- Dependency vulnerability scanning.
- Structured security event logging.

Avoid verbose production errors that expose Azure internals.

---

# 11. INFRASTRUCTURE AS CODE

Infrastructure as Code is MANDATORY.

Use Bicep as the primary IaC format.

Create:

`infra/main.bicep`

Use modular Bicep files where this materially improves maintainability.

Deploy the required resources:
- Resource group or documented resource-group creation step.
- App Service Plan.
- Azure App Service.
- Azure Functions hosting plan and Function App.
- Azure Storage account.
- Required Blob containers.
- Azure Storage Queue.
- Azure Table Storage tables.
- Azure AI Document Intelligence S0.
- Application Insights.
- Log Analytics Workspace where required.
- Managed identities.
- Azure RBAC role assignments.
- Required application settings.
- Optional hardened networking infrastructure.

Use stable, supported ARM/Bicep API versions.

Validate all Bicep definitions before considering implementation complete.

## Configuration parameters

At minimum expose:

    environmentName
    location
    resourcePrefix
    tenantId
    entraApplicationClientId
    allowedUsersGroupObjectId
    appDisplayName
    organizationName
    brandingMode
    documentRetentionDays
    archiveRetentionHours
    maxUploadSizeMB
    maxBatchDocuments
    enablePrivateNetworking
    enableMalwareScanning

Use appropriate types and secure handling.

Avoid asking for values that can be derived from the current Azure deployment context.

Use generated unique suffixes for globally unique Azure resource names.

## Deployment parameter files

Create:

`infra/parameters/mfib.bicepparam`

`infra/parameters/example.bicepparam`

The MFIB parameters file must target the intended configuration but must not contain fabricated or hardcoded tenant/subscription IDs.

The example parameters file must be usable as the basis for any new tenant.

## ARM compatibility

Bicep is preferred.

Optionally generate an ARM JSON template from the Bicep source as a CI artifact, but maintain Bicep as the single source of truth.

Do not manually maintain two independent infrastructure definitions.

---

# 12. ENTRA ID BOOTSTRAP

Create a deployment script that configures the Entra ID application registration.

Bicep alone must not be assumed to configure all Microsoft Entra application objects.

Provide:

`scripts/setup-entra.ps1`

Prefer PowerShell 7 and Microsoft Graph PowerShell or supported Azure CLI functionality.

The script must:
1. Verify the active Azure tenant.
2. Check required permissions.
3. Create or reuse the intended application registration.
4. Configure single-tenant authentication.
5. Configure the correct App Service redirect URI.
6. Configure application roles or authorized access groups.
7. Configure the supported credential mechanism for App Service Authentication.
8. Prefer managed identity federation where supported and correctly implemented.
9. Return the application client ID and relevant non-secret configuration values.
10. Avoid displaying or persisting secrets unnecessarily.

Make this bootstrap process idempotent where practical.

If interactive administrator consent or privileged directory permissions are needed, stop and display exact, actionable instructions.

Do not silently weaken security to bypass missing permissions.

---

# 13. AUTOMATED DEPLOYMENT

Create:

`scripts/deploy.ps1`

The script must support selecting an Azure tenant and subscription.

For MFIB, use the subscription display name:

`mfib-ops`

However, do not assume that display names are globally unique.

Resolve and verify the subscription ID.

Perform:
1. Prerequisite checks.
2. Azure CLI version check.
3. Azure authentication check.
4. Subscription verification.
5. Resource group creation.
6. Bicep validation.
7. ARM what-if deployment.
8. Infrastructure deployment.
9. Entra ID configuration.
10. Required post-deployment configuration.
11. Application deployment.
12. Function deployment.
13. Health and authentication checks.
14. Output of the portal URL and deployment summary.

Use clear error handling.

If the deployment fails, display the failed step and recovery instructions.

Never claim a deployment succeeded before all required checks pass.

The deployment script must not execute automatically merely because the repository is cloned.

---

# 14. GITHUB ACTIONS CI/CD

Create GitHub Actions workflows.

Recommended files:

`.github/workflows/ci.yml`

`.github/workflows/deploy.yml`

CI must:
- Install dependencies.
- Run TypeScript checks.
- Run ESLint.
- Run unit tests.
- Run build.
- Validate Bicep.
- Scan dependencies for known vulnerabilities.
- Check for accidentally committed secrets.

Deployment must:
- Use GitHub Actions OIDC with Azure.
- Avoid stored Azure client secrets.
- Support explicit environment configuration.
- Require appropriate approval for production deployment.
- Execute infrastructure deployment.
- Deploy frontend and Functions.
- Execute deployment smoke tests.

Document the required Azure federated identity credential and GitHub repository settings.

Do not assume that another GitHub repository is automatically authorized to deploy to MFIB.

---

# 15. REPOSITORY STRUCTURE

Create a clean and understandable repository.

Suggested structure:

    mfib-document-processor/
      README.md
      LICENSE
      .gitignore
      .env.example
      .github/
        copilot-instructions.md
        workflows/
          ci.yml
          deploy.yml
      app/
        components/
        api/
        lib/
        services/
        styles/
      public/
        branding/
          ministry-logo.jpeg
      functions/
        src/
          jobs/
          ocr/
          exports/
          archives/
          reconciliation/
      packages/
        shared/
          types/
          schemas/
      infra/
        main.bicep
        modules/
        parameters/
          mfib.bicepparam
          example.bicepparam
      scripts/
        setup-entra.ps1
        deploy.ps1
        smoke-test.ps1
      tests/
        unit/
        integration/
        fixtures/
      docs/
        architecture.md
        deployment.md
        security.md
        operations.md
        troubleshooting.md
        data-formats.md

Adapt the structure if a simpler, cleaner organization is justified.

Keep TypeScript types and validation schemas consistent across the frontend, API, and background workers.

Do not duplicate business logic unnecessarily.

---

# 16. APPLICATION API

Create properly authorized APIs for:

- Creating processing jobs.
- Uploading documents.
- Finalizing upload batches.
- Listing user jobs.
- Getting job status.
- Getting document details.
- Listing available export formats.
- Downloading individual processed files.
- Creating archive jobs.
- Getting archive status.
- Downloading completed archives.
- Retrying failed documents.
- Deleting jobs and outputs, subject to authorization and retention policy.

Suggested logical endpoints:

    POST   /api/jobs
    GET    /api/jobs
    GET    /api/jobs/{jobId}
    POST   /api/jobs/{jobId}/finalize
    GET    /api/jobs/{jobId}/documents
    GET    /api/documents/{documentId}
    GET    /api/documents/{documentId}/download
    POST   /api/archives
    GET    /api/archives/{archiveId}
    GET    /api/archives/{archiveId}/download

Choose upload endpoint shapes that support large files efficiently.

Document API contracts and error responses.

Every relevant endpoint must enforce authentication and resource ownership.

---

# 17. RELIABILITY AND SCALABILITY

The platform must support many documents and concurrent users without requiring an always-running browser session.

Implement:
- Queue-based processing.
- Persistent states.
- Idempotent job handling.
- Retry policies.
- Timeout handling.
- Dead-letter or poison-message handling.
- Azure service throttling awareness.
- Configurable concurrency.
- Partial batch failures.
- Recovery after Function restarts.
- Recovery from interrupted archive generation.
- Processing activity timestamps.
- Abandoned-job detection.
- Cleanup of temporary artifacts.

Avoid one Function invocation per document when the native Document Intelligence batch capability is more appropriate.

Avoid unbounded parallel processing.

Design for hundreds of documents per user operation and substantially larger workloads within documented service limits.

Use actual Azure service limits rather than invented performance guarantees.

---

# 18. OBSERVABILITY

Integrate Application Insights.

Track:
- Jobs created.
- Documents uploaded.
- OCR batches submitted.
- OCR batches completed.
- OCR failures.
- Extraction warnings.
- Excel export failures.
- ZIP generation duration.
- Azure API throttling.
- Processing latency.
- Number of pages processed.

Use correlation IDs based on job IDs and document IDs.

Never log raw document contents.

Add meaningful health checks and deployment verification.

Provide operational troubleshooting instructions.

---

# 19. TESTING REQUIREMENTS

Implement automated tests, not just manual testing instructions.

## Unit tests

Cover:
- Job creation.
- Authorization.
- Status transitions.
- Filename sanitization.
- File validation.
- OCR response parsing.
- Merged-cell conversion.
- Negative number preservation.
- Romanian numeric formats.
- Multi-page tables.
- Markdown generation.
- Excel formula injection protection.
- ZIP path safety.
- Manifest generation.

## Integration tests

Cover:
- Blob upload.
- Queue job submission.
- Table Storage persistence.
- Worker lifecycle.
- Batch OCR client behavior using controlled mocked responses.
- Successful and partially failed batches.
- Individual downloads.
- Multi-document ZIP download.
- Cross-user access denial.
- Recovery after interrupted processing.

Use safe synthetic fixtures.

Do not commit actual confidential audit documents into the repository.

Include a realistic synthetic F3 Romanian financial table resembling the structural complexity of scanned payment statements.

## End-to-end tests

Verify:
1. User signs in.
2. User uploads multiple documents.
3. Job is created.
4. Processing begins.
5. Status updates correctly.
6. OCR results are persisted.
7. Excel export is generated.
8. Markdown export is generated.
9. Individual files download successfully.
10. Multiple selected documents generate a valid ZIP.
11. Unauthorized access is rejected.

Clearly distinguish mocked tests from live Azure integration tests.

---

# 20. README — MANDATORY

Create an excellent, comprehensive `README.md` in English.

The README must allow an Azure administrator or developer unfamiliar with MFIB to understand and deploy the solution.

Use the project title:

**MFIB Document Processor**

Include the following sections.

### Overview
Explain what the system does, its intended users, and the business problem it solves.

### Features
Describe upload, OCR extraction, Excel generation, Markdown export, status tracking, and ZIP downloads.

### Architecture
Include a Mermaid architecture diagram showing the real implementation.

### Azure Resources
Provide a resource inventory and explain why each resource is needed.

### Prerequisites
Document:
- Required Azure permissions.
- Required Entra ID permissions.
- Azure CLI.
- PowerShell.
- Node.js.
- Git.
- GitHub Actions prerequisites.
- Supported Azure regions.
- Document Intelligence availability.
- Subscription quotas.

### Quick Start
Give a complete, reproducible path from cloning the repository to opening a working portal.

The administrator should not have to reverse-engineer environment variables or discover missing steps.

### Deploy to Your Own Tenant
Provide dedicated step-by-step instructions for another organization.

Explain how to configure its own tenant, subscription, organization name, logo, and Entra application registration.

### MFIB Deployment
Explain the specific configuration for the `mfib-ops` subscription.

Do not expose secrets or actual confidential environment information.

### Configuration
Document every environment variable and deployment parameter.

### Authentication and Authorization
Explain Entra sign-in, roles, and resource isolation.

### Data Storage and Retention
Explain containers, outputs, manifests, lifecycle policies, and cleanup.

### Output Formats
Provide example JSON, XLSX, and ZIP structures.

### Security
Explain baseline security and hardened networking.

### Costs
Explain which Azure services generate costs and which parameters have the largest impact.

Provide an estimate methodology rather than fabricated current pricing.

### Troubleshooting
Document common deployment, authentication, OCR, RBAC, and storage errors.

### Limitations
Clearly explain OCR accuracy limitations and why manual verification may be necessary for poor scans.

### Development
Explain local development, tests, formatting, and CI.

### Contributing
Provide a concise contribution guide.

---

# 21. DEPLOYMENT EXPERIENCE

A person who clones this repository must be able to execute a documented deployment process similar to:

    git clone <repository-url>
    cd mfib-document-processor

    az login --tenant <tenant-id>
    az account set --subscription <subscription-id>

    pwsh ./scripts/deploy.ps1 \
      -SubscriptionId <subscription-id> \
      -EnvironmentName prod

The actual script syntax must be tested and accurately documented.

Do not use illustrative commands in the final README that do not match the implementation.

Ideally provide:

**Deploy to Azure**

A convenient repository-level deployment entry point that uses the Bicep source or a generated ARM template.

However, explain that Entra ID directory configuration may require an additional authorized administrator step.

Do not imply that a generic Deploy to Azure button can bypass required Entra permissions.

---

# 22. IMPLEMENTATION PRIORITIES

Implement in phases.

## Phase 1 — Foundation
- Repository setup.
- Architecture.
- TypeScript configuration.
- Shared types.
- Bicep.
- Storage models.
- Entra authentication.

## Phase 2 — User portal
- Branding.
- Responsive UI.
- Upload.
- Document list.
- Job history.
- Status indicators.

## Phase 3 — Processing
- Queue-driven job execution.
- Document Intelligence batch integration.
- Job reconciliation.
- Error handling.

## Phase 4 — Export
- JSON output.
- Markdown.
- Excel reconstruction.
- Document manifests.
- Secure downloads.
- ZIP generation.

## Phase 5 — Production readiness
- Automated tests.
- Monitoring.
- Security review.
- RBAC validation.
- Deployment scripts.
- Documentation.
- CI/CD.

After each phase, run relevant checks and correct implementation errors before proceeding.

Maintain a concise implementation checklist in the repository.

---

# 23. ACCEPTANCE CRITERIA

The project is complete only when:

1. A user can authenticate using Microsoft Entra ID.
2. The original Ministry logo appears correctly in the top-left header.
3. A user can upload multiple real documents.
4. Uploaded documents persist in private Azure Blob Storage.
5. Processing runs asynchronously.
6. The application submits actual batch requests to Document Intelligence.
7. OCR outputs are stored and associated with their documents.
8. Complex tables are exported into real XLSX files.
9. JSON and Markdown outputs are downloadable.
10. Users can download processed files individually.
11. Users can select multiple documents and generate ZIP archives.
12. Processing status survives browser refreshes and application restarts.
13. Users cannot access another user's documents.
14. Azure resource access uses appropriately scoped Managed Identities.
15. Bicep validates and can deploy the actual required resources.
16. Entra registration and application configuration are documented and reproducible.
17. Deployment works without hardcoded MFIB tenant or subscription identifiers.
18. The README contains working deployment instructions for another tenant.
19. Unit and integration tests pass.
20. No hardcoded secrets, fake processing results, or nonfunctional UI actions remain.

A visually complete application with simulated OCR is NOT an acceptable final result.

---

# 24. FINAL INSTRUCTIONS

Build the simplest architecture that satisfies the requirements without compromising data integrity, security, or deployment portability.

Prefer native Azure capabilities over custom infrastructure.

Do not add unnecessary enterprise components.

Do not use an LLM to reconstruct financial values that Document Intelligence failed to recognize.

Do not claim OCR results are perfect.

Do not invent deployment IDs, secrets, resource names, or successful test results.

When an Azure configuration depends on permissions or environmental information not available to you, implement the configuration path and document precisely what the administrator must supply.

Maintain a working, buildable codebase throughout implementation.

Run tests, validate infrastructure, and correct errors wherever the execution environment permits.

At the end, provide:

1. A summary of implemented functionality.
2. Final repository structure.
3. Azure resources required.
4. Required deployment parameters.
5. Exact deployment commands.
6. Test and build results.
7. Known limitations.
8. Any remaining manual Azure/Entra steps.
9. The deployed application URL, only if deployment was actually completed.

**Start implementing the application now. Do not stop after creating a design document or implementation plan.**

:::