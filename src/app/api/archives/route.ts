import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import archiver from "archiver";
import { NextRequest } from "next/server";
import { z } from "zod";
import { ensureStorage, getArchiveQueue, getArchivesTable, getBlobService } from "@/lib/azure";
import { forbidden, getUser, hasProcessorRole, rejectCrossOrigin, unauthorized } from "@/lib/auth";
import { config } from "@/lib/config";
import { getOwnedDocument } from "@/lib/ownership";

export const runtime = "nodejs";
const schema = z.object({ documentIds: z.array(z.string().uuid()).min(1).max(100) });

export async function POST(request: NextRequest) {
  const user = getUser(request);
  if (!user) return unauthorized();
  if (!hasProcessorRole(user)) return forbidden();
  const originError = rejectCrossOrigin(request);
  if (originError) return originError;
  try {
    await ensureStorage();
    const archivesTable = getArchivesTable();
    const { documentIds } = schema.parse(await request.json());
    const uniqueIds = [...new Set(documentIds)];
    const selected = await Promise.all(uniqueIds.map((id) => getOwnedDocument(id, user.objectId, user.tenantId)));
    if (selected.some((doc) => !doc)) return Response.json({ error: "Selecția conține documente inaccesibile." }, { status: 404 });
    const ready = selected.filter((doc) => doc && ["completed", "review"].includes(doc.status));
    if (ready.length !== selected.length) return Response.json({ error: "Sunt selectate documente fără rezultate disponibile." }, { status: 409 });
    const archiveId = randomUUID();
    const documentList = ready.map((doc) => ({
      documentId: doc!.documentId,
      jobId: doc!.jobId,
      originalName: doc!.originalName,
      outputs: (doc!.outputs ?? []).filter((f) => f === "content.md")
    }));

    if (documentList.length <= 25) {
      const container = getBlobService().getContainerClient(config.outputsContainer);
      const zip = archiver("zip", { zlib: { level: 6 } });
      const archiveBlob = container.getBlockBlobClient(`archives/${archiveId}.zip`);
      const uploadPromise = archiveBlob.uploadStream(zip, 4 * 1024 * 1024, 4, {
        blobHTTPHeaders: { blobContentType: "application/zip" }
      });
      const directoryCounts = new Map<string, number>();
      let includedFileCount = 0;

      for (const doc of documentList) {
        const base = safeArchiveName(doc.originalName);
        const count = (directoryCounts.get(base) ?? 0) + 1;
        directoryCounts.set(base, count);
        const directory = count === 1 ? base : `${base}-${count}`;
        for (const filename of doc.outputs) {
          const safeOutput = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
          const blobName = `${doc.jobId}/${doc.documentId}/document.${safeOutput}`;
          const source = await container.getBlobClient(blobName).download();
          if (!source.readableStreamBody) throw new Error(`Rezultatul ${safeOutput} lipsește pentru ${doc.originalName}.`);
          const archivePath = `${directory}/document.${safeOutput}`;
          zip.append(Readable.from(source.readableStreamBody as AsyncIterable<Uint8Array>), { name: archivePath });
          includedFileCount++;
        }
      }

      await zip.finalize();
      await uploadPromise;

      const now = new Date();
      await archivesTable.createEntity({
        partitionKey: user.objectId, rowKey: archiveId, ArchiveId: archiveId, OwnerId: user.objectId,
        TenantId: user.tenantId, Status: "completed", CreatedAt: now.toISOString(), CompletedAt: now.toISOString(),
        BlobName: `archives/${archiveId}.zip`,
        ExpiresAt: new Date(now.getTime() + Number(process.env.ARCHIVE_RETENTION_HOURS ?? 24) * 60 * 60 * 1000).toISOString(),
        IncludedFileCount: includedFileCount,
        DocumentIds: JSON.stringify(documentList)
      });

      return Response.json(
        { archiveId, status: "completed", downloadUrl: `/api/archives/${archiveId}/download` },
        { status: 201, headers: { "cache-control": "private, no-store" } }
      );
    }

    await archivesTable.createEntity({
      partitionKey: user.objectId, rowKey: archiveId, ArchiveId: archiveId, OwnerId: user.objectId,
      TenantId: user.tenantId, Status: "queued", CreatedAt: new Date().toISOString(),
      DocumentIds: JSON.stringify(documentList)
    });
    await getArchiveQueue().sendMessage(JSON.stringify({ archiveId, ownerId: user.objectId }));
    return Response.json({ archiveId, status: "queued" }, { status: 202, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Cerere invalidă.";
    return Response.json({ error: message }, { status: 400 });
  }
}

function safeArchiveName(filename: string): string {
  const basename = filename.replaceAll("\\", "/").split("/").at(-1) ?? "document";
  const withoutExtension = basename.replace(/\.[^.]+$/, "");
  const safe = withoutExtension.normalize("NFKC").replace(/[^\p{L}\p{N}._-]/gu, "_").replace(/^\.+/, "").slice(0, 100);
  return safe || "document";
}
