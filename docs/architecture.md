# Architecture

The App Service hosts the Next.js portal and API. App Service Authentication provides the Entra principal using a managed-identity federated credential; API handlers require `Processor.User` or `Processor.Admin` and verify the owner ID for the requested resource.

Uploads use per-blob, short-lived user-delegation SAS permissions scoped to a private staging container. On finalization, the API validates file size and signature, conditionally copies each blob into the private originals container, and queues only that immutable copy; the still-valid upload SAS cannot alter a document during OCR. A lifecycle rule removes abandoned staging blobs after two days. A persistent Table Storage job record is transitioned to queued and a Storage Queue message starts the Functions worker. The worker claims a queued job with a Table Storage ETag before submitting one job-prefix batch to Document Intelligence. The timer function polls `Operation-Location`, retrieves each successful result, calculates source SHA-256, writes exports, and persists per-document status/warnings.

Archive requests are persisted and queued separately. The archive worker streams source blobs into a ZIP and uploads the archive without assembling the complete archive in memory. An authorized API streams the ready archive to its owner.

The optional private profile provisions VNet integration and private endpoints/DNS for Storage and Document Intelligence. Browser upload requires the browser itself to have private network connectivity.
