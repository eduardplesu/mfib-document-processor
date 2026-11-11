# Data formats

Each successful document has these private Blob outputs under `{jobId}/{documentId}/`:

- `document.layout.json` — original Document Intelligence result JSON.
- `document.tables.xlsx` — Summary, one worksheet per detected table, and Warnings when the converter detects structural issues. Source cell values remain strings.
- `document.content.md` — native Markdown content from Document Intelligence.
- `document.manifest.json` — document/job IDs, source checksum, model/API version, counts, output names, and warnings.

An archive contains a collision-safe directory per document and a root `manifest.json`. OCR text and filenames are untrusted input. Excel values are written as text, and archive paths are created from sanitized basenames rather than source paths.

Negative and localized number text is not normalized or rounded. Page-spanning tables remain separate unless the source service itself reports them as one table. Searchable PDF is not generated.
