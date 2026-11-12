"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import Link from "next/link";

type Doc = { documentId: string; jobId: string; originalName: string; size: number; status: string; createdAt: string; outputs?: string[] };
type UploadIntent = { jobId: string; fingerprint: string; createdAt: number; uploads: Array<{ documentId: string; url: string }>; uploaded: boolean[] };
type Profile = { name?: string; appDisplayName?: string; organizationName?: string; logoPath?: string; code?: string; error?: string };
const labels: Record<string, string> = {
  uploading: "Se încarcă", queued: "În așteptare", processing: "În curs de procesare",
  completed: "Finalizat", review: "Necesită verificare", failed: "Eroare"
};

export default function Home() {
  const [authState, setAuthState] = useState<"checking" | "authenticated" | "unauthenticated">("checking");
  const [documents, setDocuments] = useState<Doc[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [uploadIntent, setUploadIntent] = useState<UploadIntent | null>(null);
  const [uploadedCount, setUploadedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState("");
  const [sessionNotice, setSessionNotice] = useState("");
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [archive, setArchive] = useState<{ archiveId: string; status: string; downloadUrl?: string } | null>(null);
  const [userName, setUserName] = useState("");
  const [profileError, setProfileError] = useState("");
  const [branding, setBranding] = useState({
    appDisplayName: "Document Processor",
    organizationName: "Ministerul Fericirii și Ideilor Bune",
    logoPath: "/branding/ministry-logo.jpeg"
  });

  async function downloadFile(url: string, fallbackName: string) {
    setError("");
    try {
      const response = await fetch(url, { cache: "no-store", credentials: "same-origin" });
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error ?? `Descărcarea a eșuat (HTTP ${response.status}).`);
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = fallbackName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nu s-a putut descărca fișierul.");
    }
  }

  async function refresh() {
    const response = await fetch("/api/jobs", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json() as { documents: Doc[] };
      setDocuments(data.documents);
      setSelected((current) => current.filter((id) => data.documents.some((doc) => doc.documentId === id)));
      setAuthState("authenticated");
    } else if (response.status === 401) {
      setAuthState("unauthenticated");
    } else if (response.status === 403) {
      setProfileError("Contul nu are rolul Processor.User alocat în Microsoft Entra ID.");
      setAuthState("unauthenticated");
    }
  }
  useEffect(() => {
    void refresh();
    async function loadProfile() {
      try {
        let response = await fetch("/api/me", { cache: "no-store" });
        if (response.status === 401 && !response.headers.get("content-type")?.includes("application/json")) {
          setAuthState("unauthenticated");
          return;
        }
        let profile = await response.json() as Profile;
        if (response.status === 401 && profile.code === "GRAPH_TOKEN_EXPIRED") {
          const renewed = await fetch("/.auth/refresh", { cache: "no-store" });
          if (renewed.ok) {
            response = await fetch("/api/me", { cache: "no-store" });
            profile = await response.json() as Profile;
          }
        }
        if (!response.ok) {
          if (response.status === 401 && !profile.code) {
            setAuthState("unauthenticated");
            return;
          }
          if (response.status !== 401 || profile.code) {
            setProfileError(profile.error ?? "Nu s-a putut încărca profilul.");
          }
          return;
        }
        if (!profile.name?.trim()) throw new Error("Profilul nu conține un nume.");
        setUserName(profile.name);
        setProfileError("");
        setAuthState("authenticated");
        setBranding({
          appDisplayName: profile.appDisplayName ?? "Document Processor",
          organizationName: profile.organizationName ?? "Ministerul Fericirii și Ideilor Bune",
          logoPath: profile.logoPath ?? "/branding/ministry-logo.jpeg"
        });
      } catch (error) {
        console.error("Nu s-a putut încărca profilul.", error);
        setProfileError("Nu s-a putut încărca profilul. Încercați din nou.");
      }
    }
    void loadProfile();
  }, []);

  const hasActiveDocuments = useMemo(
    () => documents.some((d) => ["uploading", "queued", "processing"].includes(d.status)),
    [documents]
  );

  useEffect(() => {
    if (authState !== "authenticated") return;
    const intervalMs = hasActiveDocuments ? 2000 : 10000;
    const timer = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [authState, hasActiveDocuments]);

  useEffect(() => {
    if (!archive || archive.status === "completed" || archive.status === "failed") return;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/archives/${archive.archiveId}`, { cache: "no-store" });
      if (response.ok) {
        const updated = await response.json() as { archiveId: string; status: string; downloadUrl?: string };
        setArchive(updated);
        if (updated.status === "completed" && updated.downloadUrl) {
          void downloadFile(updated.downloadUrl, `documente-${updated.archiveId.slice(0, 8)}.zip`);
        }
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [archive]);

  const visible = useMemo(() => documents.filter((d) => d.originalName.toLowerCase().includes(filter.toLowerCase())), [documents, filter]);
  const selectableVisibleIds = useMemo(
    () => visible.filter((d) => ["completed", "review"].includes(d.status)).map((d) => d.documentId),
    [visible]
  );
  const allVisibleSelected = selectableVisibleIds.length > 0 && selectableVisibleIds.every((id) => selected.includes(id));
  const someVisibleSelected = selectableVisibleIds.some((id) => selected.includes(id));

  function toggleSelectAllVisible(checked: boolean) {
    if (checked) {
      setSelected(Array.from(new Set([...selected, ...selectableVisibleIds])));
    } else {
      setSelected(selected.filter((id) => !selectableVisibleIds.includes(id)));
    }
  }

  const stats: Array<[string, number, string]> = [
    ["Documente încărcate", documents.length, "card-total"],
    ["În procesare", documents.filter((d) => ["queued", "uploading", "processing"].includes(d.status)).length, "card-processing"],
    ["Finalizate", documents.filter((d) => d.status === "completed").length, "card-completed"],
    ["Necesită verificare", documents.filter((d) => d.status === "review").length, "card-review"],
    ["Erori", documents.filter((d) => d.status === "failed").length, "card-failed"]
  ];
  const hasActiveProcessing =
    busy ||
    documents.some((d) => ["uploading", "queued", "processing"].includes(d.status)) ||
    (archive !== null && ["queued", "processing"].includes(archive.status));
  const canClearSession = documents.length > 0 && !hasActiveProcessing && !clearing;

  async function upload() {
    setBusy(true); setError(""); setSessionNotice("");
    try {
      if (!files.length) throw new Error("Selectați cel puțin un document.");
      const fingerprint = files.map((file) => `${file.name}:${file.size}:${file.lastModified}`).join("|");
      let intent = uploadIntent;
      if (!intent || intent.fingerprint !== fingerprint || Date.now() - intent.createdAt > 55 * 60 * 1000) {
        const created = await fetch("/api/jobs", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ files: files.map((f) => ({ name: f.name, size: f.size, contentType: f.type })) })
        });
        const payload = await created.json();
        if (!created.ok) throw new Error(payload.error ?? "Nu s-a putut crea jobul.");
        intent = {
          jobId: payload.jobId, fingerprint, createdAt: Date.now(),
          uploads: payload.uploads, uploaded: files.map(() => false)
        };
        setUploadIntent(intent);
      }
      setUploadedCount(intent.uploaded.filter(Boolean).length);
      for (let offset = 0; offset < files.length; offset += 3) {
        const indexes = Array.from({ length: Math.min(3, files.length - offset) }, (_, n) => offset + n).filter((index) => !intent!.uploaded[index]);
        const results = await Promise.allSettled(indexes.map(async (index) => {
          let lastError: Error | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              const put = await fetch(intent!.uploads[index].url, {
                method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "content-type": files[index].type || "application/octet-stream" },
                body: files[index]
              });
              if (!put.ok) throw new Error(`Încărcarea fișierului ${files[index].name} a eșuat (HTTP ${put.status}).`);
              intent!.uploaded[index] = true;
              setUploadedCount(intent!.uploaded.filter(Boolean).length);
              setUploadIntent({ ...intent!, uploaded: [...intent!.uploaded] });
              return;
            } catch (error) {
              lastError = error instanceof Error ? error : new Error("Încărcarea a eșuat.");
              if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
            }
          }
          throw lastError ?? new Error(`Încărcarea fișierului ${files[index].name} a eșuat.`);
        }));
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
      }
      const finalized = await fetch(`/api/jobs/${intent.jobId}/finalize`, { method: "POST" });
      if (!finalized.ok) {
        const detail = await finalized.json();
        throw new Error(detail.error ?? "Nu s-a putut porni procesarea.");
      }
      setFiles([]);
      setUploadIntent(null);
      setUploadedCount(0);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "A apărut o eroare neașteptată.");
    } finally { setBusy(false); }
  }

  async function createArchive() {
    setArchiving(true);
    setError("");
    setSessionNotice("");
    try {
      const response = await fetch("/api/archives", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentIds: selected })
      });
      const payload = await response.json() as { archiveId?: string; status?: string; downloadUrl?: string; error?: string };
      if (!response.ok || !payload.archiveId || !payload.status) {
        setError(payload.error ?? "Nu s-a putut pregăti arhiva.");
        return;
      }
      setArchive({ archiveId: payload.archiveId, status: payload.status, downloadUrl: payload.downloadUrl });
      if (payload.status === "completed" && payload.downloadUrl) {
        await downloadFile(payload.downloadUrl, `documente-${payload.archiveId.slice(0, 8)}.zip`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nu s-a putut pregăti arhiva.");
    } finally {
      setArchiving(false);
    }
  }

  async function clearSession() {
    setClearing(true);
    setError("");
    setSessionNotice("");
    try {
      const response = await fetch("/api/jobs", { method: "DELETE" });
      const payload = await response.json() as { error?: string; deletedDocuments?: number };
      if (!response.ok) {
        setError(payload.error ?? "Nu s-a putut curăța sesiunea.");
        return;
      }
      setDocuments([]);
      setSelected([]);
      setArchive(null);
      setUploadIntent(null);
      setUploadedCount(0);
      setFiles([]);
      setSessionNotice("Sesiunea a fost curățată. Toate documentele de intrare și rezultatele generate au fost șterse.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nu s-a putut curăța sesiunea.");
    } finally {
      setClearing(false);
    }
  }

  if (authState === "checking") {
    return <main className="gate-loading" role="status">Se verifică sesiunea Microsoft Entra ID…</main>;
  }

  if (authState === "unauthenticated") {
    return (
      <main className="gate">
        <section className="gate-visual" aria-label="Document Processor">
          <div className="gate-visual-content">
            <p className="gate-kicker">Procesare inteligentă de documente</p>
            <h1>Documente scanate, transformate în date structurate.</h1>
            <p className="gate-description">
              Extracție OCR de înaltă precizie cu detectarea automată a tipului de document (facturi,
              centralizatoare, devize F3, rapoarte cumulative, liste C6–C9) și conversie structurată în Markdown.
            </p>
            <div className="gate-capabilities" aria-label="Capabilități">
              <span>Azure Content Understanding 2026</span>
              <span>Foundry LLM (gpt-5.6-terra)</span>
              <span>Markdown structurat</span>
              <span>Sesiune privată</span>
            </div>
          </div>
          <div className="legal-grid" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
        </section>

        <section className="gate-access">
          <div className="gate-access-card">
            <div className="gate-brand">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                className="ministry-logo"
                src="/branding/minister-logo-light.jpeg"
                alt="Ministerul Fericirii și Ideilor Bune"
              />
            </div>
            <div className="gate-copy">
              <p className="eyebrow">Acces securizat</p>
              <h2>Intră în portalul Document Processor</h2>
              <p>
                Autentifică-te cu identitatea organizației pentru a încărca documente, a extrage
                tabele și a descărca rezultatele tale.
              </p>
            </div>
            {profileError && <p className="error" role="alert">{profileError}</p>}
            <a className="signin-button" href="/.auth/login/aad?post_login_redirect_uri=%2F">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3 3h8v8H3V3Zm10 0h8v8h-8V3ZM3 13h8v8H3v-8Zm10 0h8v8h-8v-8Z" />
              </svg>
              Autentificare cu Microsoft
            </a>
            <p className="gate-note">
              Acces protejat prin Microsoft Entra ID · Sesiune privată per utilizator
            </p>
          </div>
        </section>
      </main>
    );
  }

  return <>
    <header className="header">
      <Link href="/" aria-label="Pagina principală"><Image className="brand-mark" src={branding.logoPath} alt={branding.organizationName} width={52} height={52} priority unoptimized /></Link>
      <div><div className="brand-title">{branding.appDisplayName}</div><div className="brand-subtitle">Procesarea inteligentă a documentelor</div></div>
      <div className="user">
        {userName || <a href="/.auth/login/aad?post_login_redirect_uri=%2F">{profileError ? "Reconectare" : "Autentificare"}</a>}
        {userName && <> · <a href="/.auth/logout?post_logout_redirect_uri=%2F">Ieșire</a></>}
        {profileError && <p className="error" role="alert">{profileError}</p>}
      </div>
    </header>
    <main className="shell">
      <h1>Procesare documente</h1>
      <p className="intro">Încarcă documente scanate și transformă-le automat în date structurate, pregătite pentru analiză.</p>
      <div className="notice">Rezultatele OCR pot conține erori, în special pentru scanări de calitate redusă. Verificați manual valorile importante.</div>
      <section className="cards" aria-label="Statistici">{stats.map(([label, value, variant]) => <div className={`card ${variant}`} key={label}><div className="card-label">{label}</div><div className="card-value">{value}</div></div>)}</section>
      <section className="upload" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); setFiles(Array.from(event.dataTransfer.files)); }}>
        <strong>Trage documentele aici sau selectează fișiere</strong>
        <p className="intro">Formate acceptate: PDF, JPG, PNG, TIFF</p>
        <input aria-label="Selectează documente" type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.tif,.tiff" onChange={(e) => setFiles(Array.from(e.target.files ?? []))} />
        {files.length > 0 && <div className="file-list">{files.map((f, i) => <div className="file-row" key={`${f.name}-${i}`}><span>{f.name}</span><span>{(f.size / 1024 / 1024).toFixed(2)} MB</span><button className="button secondary" onClick={() => setFiles(files.filter((_, n) => n !== i))}>Elimină</button></div>)}</div>}
        {error && <p className="error" role="alert">{error}</p>}
        {busy && <p role="status">Documente încărcate: {uploadedCount} din {files.length}</p>}
        <button className="button" disabled={busy || files.length === 0} onClick={() => void upload()}>{busy ? "Se încarcă..." : uploadIntent ? "Reîncearcă încărcarea" : "Începe procesarea"}</button>
      </section>
      <section style={{ marginTop: 28 }}>
        <div className="toolbar"><strong>Documente procesate</strong><input aria-label="Caută documente" placeholder="Caută după nume..." value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="button secondary" type="button" disabled={!selectableVisibleIds.length} onClick={() => toggleSelectAllVisible(!allVisibleSelected)}>{allVisibleSelected ? "Deselectează toate" : "Selectează toate"}</button>
          <button className="button" disabled={!selected.length || archiving} onClick={() => void createArchive()}>{archiving ? "Se descarcă ZIP..." : `Descarcă selecția ca ZIP${selected.length ? ` (${selected.length})` : ""}`}</button>
          <button className="button secondary" type="button" disabled={!canClearSession} onClick={() => void clearSession()}>{clearing ? "Se curăță sesiunea..." : "Curăță sesiunea"}</button></div>
        <p className="intro" style={{ padding: "0 16px" }}>{documents.filter((document) => ["completed", "review"].includes(document.status)).length} din {documents.length} documente finalizate</p>
        {sessionNotice && <div className="notice" role="status">{sessionNotice}</div>}
        {archive && <div className="notice">{archive.status === "completed" && archive.downloadUrl ? <button type="button" className="output-link" onClick={() => void downloadFile(archive.downloadUrl!, `documente-${archive.archiveId.slice(0, 8)}.zip`)}>Arhiva este gata — apasă aici dacă descărcarea nu a pornit automat</button> : archive.status === "failed" ? "Generarea arhivei a eșuat." : "Se pregătește arhiva..."}</div>}
        <div className="panel"><table><thead><tr><th><label style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: selectableVisibleIds.length ? "pointer" : "default" }}><input ref={(el) => { if (el) el.indeterminate = someVisibleSelected && !allVisibleSelected; }} aria-label="Selectează toate documentele disponibile" type="checkbox" disabled={!selectableVisibleIds.length} checked={allVisibleSelected} onChange={(e) => toggleSelectAllVisible(e.target.checked)} /><span>Selectează toate</span></label></th><th>Document</th><th>Dimensiune</th><th>Data încărcării</th><th>Stare</th><th>Rezultate</th></tr></thead>
          <tbody>{visible.map((d) => <tr key={d.documentId}><td><input aria-label={`Selectează ${d.originalName}`} type="checkbox" disabled={!["completed", "review"].includes(d.status)} checked={selected.includes(d.documentId)} onChange={(e) => setSelected(e.target.checked ? [...selected, d.documentId] : selected.filter((id) => id !== d.documentId))} /></td><td>{d.originalName}</td><td>{(d.size / 1024 / 1024).toFixed(2)} MB</td><td>{new Date(d.createdAt).toLocaleString("ro-RO")}</td><td><span className={`status status-${d.status}`}>{labels[d.status] ?? d.status}</span></td><td>{d.outputs?.map((format) => <button key={format} type="button" className="output-link" onClick={() => void downloadFile(`/api/documents/${d.documentId}/download?format=${encodeURIComponent(format)}`, `${d.originalName.replace(/\.[^.]+$/, "")}.${format}`)}>{format}</button>)}</td></tr>)}</tbody>
        </table>{visible.length === 0 && <div className="empty">Nu există documente de afișat.</div>}</div>
      </section>
    </main>
  </>;
}
