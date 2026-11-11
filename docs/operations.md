# Operations

Monitor App Service and Functions through Application Insights. Use job/document IDs as correlation identifiers; do not log document text, access tokens, or SAS URLs.

The queue worker claims jobs before submitting OCR to avoid duplicate paid requests. A missing operation location or uncertain POST outcome is marked for manual review rather than automatically resubmitted. A rejected request is visible as a failed job/document; automatic per-document retry is not yet implemented.

The timer polls pending operations and removes expired completed archives. The Blob lifecycle policy deletes abandoned staging uploads after two days and input, OCR result, and generated output blobs after `documentRetentionDays`; confirm these retention periods are appropriate before deployment. Archive expiry is controlled independently by `archiveRetentionHours`.

For private mode, confirm DNS resolution from both App Service and Functions and ensure users have private network access to Blob Storage. For queue backlogs, inspect Function host health, queue role assignments, Table state, and Functions logs. Do not reprocess an uncertain OCR submission until its operation status has been checked in Azure.
