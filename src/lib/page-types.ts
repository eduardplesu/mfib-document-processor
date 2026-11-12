export type PageDocumentType =
  | "entity_and_table_form"
  | "complex_merged_table"
  | "standard_table"
  | "narrative_or_mixed";

/**
 * Classifies any page based purely on its structural geometry (tables, merged cells,
 * key-value metadata density, prose paragraphs) — agnostic to domain or template names.
 */
export function detectPageDocumentType(pageMarkdown: string): PageDocumentType {
  const hasTable = /<table\b/i.test(pageMarkdown) || /\|[^\n]+\|\n\|[\s:|-]+\|/m.test(pageMarkdown);
  const hasMultiRowSpan = /\browspan\s*=\s*["']?[2-9]\d*["']?/i.test(pageMarkdown);
  const keyValueMatches = pageMarkdown.match(/^[A-ZĂÂÎȘȚ][A-Za-zĂÂÎȘȚăâîșț0-9\s./()-]{1,35}:\s*.+/gm) ?? [];

  if (hasMultiRowSpan) {
    return "complex_merged_table";
  }
  if (hasTable && keyValueMatches.length >= 4) {
    return "entity_and_table_form";
  }
  if (hasTable) {
    return "standard_table";
  }
  return "narrative_or_mixed";
}

export function buildSystemPromptForPageType(
  pageType: PageDocumentType,
  pageNumber: number,
  totalPages: number,
  hasVision: boolean
): string {
  const commonRules = [
    `Ești un sistem expert de reconstrucție documentară și post-procesare OCR (pagina ${pageNumber} din ${totalPages}), complet agnostic de tipul sau șablonul documentului de intrare.`,
    "Reguli universale obligatorii:",
    "- FIDELITATE 100%: Nu rezuma, nu omite niciun rând, niciun paragraf, nicio notă de subsol și nicio coloană sau valoare dintr-un tabel.",
    "- INTEGRITATE NUMERICĂ: Nu recalcula matematic sumele și NU șterge niciodată semnul minus (-) din fața cantităților sau valorilor negative, zecimalele, codurile alfanumerice, IBAN-urile, CIF/CUI-urile, CNP-urile sau numerele de act.",
    "- CORECȚIE CONTEXTUALĂ OCR: Corectează doar erorile optice de recunoaștere a caracterelor (litere confundate optic, cuvinte trunchiate la marginea paginii, artefacte vizuale de scanare/ștampilă/cursor).",
    "- CURĂȚARE ZGOMOT: Elimină comentariile interne (`<!-- PageFooter ... -->`, `<!-- PageHeader ... -->`, `<!-- PageNumber ... -->`) și referințele interne (`![](signatures/...)`, `![](figures/...)`).",
    "- Returnează EXCLUSIV conținutul Markdown curat al acestei pagini, fără explicații și fără blocuri ```markdown."
  ];

  if (hasVision) {
    commonRules.push(
      "- VERIFICARE VIZUALĂ DIRECTĂ: Ai atașată imaginea originală: verifică vizual fiecare număr, cod, număr de rând lipit de chenar și semn minus (-) direct pe imagine."
    );
  }

  switch (pageType) {
    case "entity_and_table_form":
      return [
        ...commonRules,
        "Ghid structural pentru formulare cu metadate + tabele (facturi, extrase, ordine, avize, fișe, declarații, rapoarte):",
        "1. Dacă pagina conține blocuri pereche de identificare în antet (de ex. Emitent/Furnizor/Instituție vs. Beneficiar/Client/Destinatar), structurează-le într-un tabel Markdown curat pe 2 coloane și afișează clar metadatele documentului (serie/număr, dată, cotă, termen).",
        "2. Formatează tabelele 2D ca tabele Markdown curate (`| ... |`), eliminând rândurile goale și artefactele de watermark suprapuse peste cifre.",
        "3. Aliniază clar secțiunile de totaluri/rezumat de la baza tabelului."
      ].join("\n");

    case "complex_merged_table":
      return [
        ...commonRules,
        "Ghid structural pentru tabele complexe cu celule îmbinate (`rowspan` / `colspan`):",
        "1. Păstrează structura HTML `<table>` atunci când tabelul folosește `rowspan` sau `colspan` pe mai multe niveluri, astfel încât relația dintre rândul principal și sub-rânduri să rămână intactă.",
        "2. Dacă textul unei celule cu `rowspan` a fost spart optic pe sub-rândurile adiacente, reunește textul în celula părinte."
      ].join("\n");

    case "standard_table":
      return [
        ...commonRules,
        "Ghid structural pentru pagini tabelare (registre, centralizatoare, balanțe, situații, anexe, inventare):",
        "1. Dacă rândurile unui tabel au fost desprinse optic în afara etichetei `<table>` ca paragrafe sub antet, reconstruiește-le în interiorul unui singur tabel complet cu coloanele aliniate.",
        "2. Repară indecșii secvențiali sau ierarhici din prima coloană dacă prima cifră a fost tăiată de marginea tabelului (de ex. `.1`, `.1.1` -> `1.1`, `1.1.1`)."
      ].join("\n");

    case "narrative_or_mixed":
      return [
        ...commonRules,
        "Ghid structural pentru documente narative, juridice, administrative, medicale, tehnice sau mixte:",
        "1. Păstrează ierarhia titlurilor (`#`, `##`, `###`), listele numerotate/cu marcatori, tabelele și paragrafele exact în ordinea lor naturală de citire.",
        "2. Elimină artefactele izolate de interfață dacă documentul provine dintr-o captură de ecran."
      ].join("\n");
  }
}

export function stripRepeatedRunningHeaders(rawPages: string[]): string[] {
  if (rawPages.length < 4) return rawPages;

  const normalizeHeaderCandidate = (line: string): string =>
    line
      .replace(/^<!--\s*PageHeader:\s*(.*?)\s*-->$/i, "$1")
      .replace(/^#+\s*/, "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .toUpperCase();

  const counts = new Map<string, number>();
  for (const page of rawPages) {
    const headerCommentMatch = /<!--\s*PageHeader:\s*(.*?)\s*-->/i.exec(page);
    const seenOnPage = new Set<string>();
    if (headerCommentMatch) {
      const norm = normalizeHeaderCandidate(headerCommentMatch[1]);
      if (norm.length >= 15) seenOnPage.add(norm);
    }
    const firstNonCommentLine = page
      .replace(/<!--[\s\S]*?-->/g, "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0);
    if (firstNonCommentLine && !firstNonCommentLine.startsWith("<") && !firstNonCommentLine.startsWith("|")) {
      const norm = normalizeHeaderCandidate(firstNonCommentLine);
      if (norm.length >= 15 && norm.length <= 160) seenOnPage.add(norm);
    }
    for (const norm of seenOnPage) {
      counts.set(norm, (counts.get(norm) ?? 0) + 1);
    }
  }

  const threshold = Math.max(3, Math.ceil(rawPages.length * 0.25));
  const repeatedHeaders = new Set<string>();
  for (const [norm, count] of counts.entries()) {
    if (count >= threshold) repeatedHeaders.add(norm);
  }
  if (repeatedHeaders.size === 0) return rawPages;

  return rawPages.map((page, idx) => {
    if (idx === 0) return page;
    const withoutHeaderComments = page.replace(/<!--\s*PageHeader:[\s\S]*?-->/gi, "").trimStart();
    const lines = withoutHeaderComments.split(/\r?\n/);
    while (lines.length > 0 && lines[0].trim() === "") lines.shift();
    if (lines.length > 0 && !lines[0].trim().startsWith("<") && !lines[0].trim().startsWith("|")) {
      const norm = normalizeHeaderCandidate(lines[0]);
      if (repeatedHeaders.has(norm)) {
        lines.shift();
      }
    }
    return lines.join("\n");
  });
}

export function repairPageMarkdownDeterministic(rawPage: string, _pageType?: PageDocumentType): string {
  let text = rawPage
    .replace(/<!--\s*Page(?:Header|Footer|Number|Break).*?-->/gi, "")
    .replace(/!\[[^\]]*\]\((?:signatures|figures)\/[^)]+\)/gi, "")
    .replace(/\r\n/g, "\n");

  text = text
    .replace(/(^|\n)eneficiar\s*:/gim, "$1Beneficiar:")
    .replace(/(^|\n)xecutant\s*:/gim, "$1Executant:")
    .replace(/(^|\n)roiectant\s*:/gim, "$1Proiectant:")
    .replace(/(^|\n)[›>]?biectivul\s*:/gim, "$1Obiectivul:")
    .replace(/^(\s*)[.•·]\s*([A-ZĂÂÎȘȚ])/gm, "$1- $2")
    .replace(/<td>\s*VA\s*\((\d+(?:[.,]\d+)?%)\)\s*<\/td>/gi, "<td>TVA ($1)</td>")
    .replace(/(\d[\d.,]*):(\d{2})(?=<\/td>|\s|$)/g, "$1.$2")
    .replace(/(\d+\.\d{4})DD\b/g, "$100")
    .replace(/(\d+\.\d{5})D\b/g, "$10")
    .replace(/<br\s*\/?>\s*\.\s*<\/td>/gi, "</td>")
    .replace(/<td>\s*0%\s*<br\s*\/?>\s*(\d[\d.,]*)\s*<\/td>/gi, "<td>$1</td>");

  text = text.replace(/<\/table>\s*<table>/gi, "");
  text = repairDetachedCentralizatorRows(text);
  text = removeEmptyTableRows(text);
  text = repairClippedHierarchicalIndices(text);
  text = repairSequentialRowNumbers(text);
  text = repairF3TableDeterministic(text);
  text = convertSimpleHtmlTablesToMarkdown(text);

  return text
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function repairClippedHierarchicalIndices(markdown: string): string {
  return markdown.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (fullTable) => {
    let currentTopLevel = "1";
    return fullTable.replace(/<tr\b[^>]*>\s*<td(\b[^>]*)>\s*([^<]*?)\s*<\/td>/gi, (match, _attrs: string, val: string) => {
      const trimmed = val.trim();
      if (/^\d+$/.test(trimmed) && Number(trimmed) > 0) {
        currentTopLevel = trimmed;
        return match;
      }
      if (/^\.\d+(?:\.\d+)*$/.test(trimmed)) {
        return match.replace(val, `${currentTopLevel}${trimmed}`);
      }
      return match;
    });
  });
}

function convertSimpleHtmlTablesToMarkdown(markdown: string): string {
  return markdown.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (fullTable, tableInner: string) => {
    if (/\b(?:rowspan|colspan)\s*=\s*["']?[2-9]/i.test(tableInner)) {
      return fullTable;
    }
    const rowMatches = [...tableInner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (rowMatches.length === 0) return fullTable;

    const matrix: string[][] = [];
    let maxCols = 0;
    for (const rm of rowMatches) {
      const cells = [...rm[1].matchAll(/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)].map((cm) =>
        cm[1]
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<[^>]+>/g, "")
          .replace(/\|/g, "\\|")
          .replace(/\s+/g, " ")
          .trim()
      );
      if (cells.length > 0) {
        maxCols = Math.max(maxCols, cells.length);
        matrix.push(cells);
      }
    }
    if (matrix.length === 0 || maxCols === 0) return fullTable;

    const normalized = matrix.map((row) => {
      const padded = [...row];
      while (padded.length < maxCols) padded.push("");
      return padded;
    });

    const header = `| ${normalized[0].join(" | ")} |`;
    const separator = `| ${normalized[0].map(() => "---").join(" | ")} |`;
    const body = normalized.slice(1).map((row) => `| ${row.join(" | ")} |`);
    return [header, separator, ...body].join("\n");
  });
}

function repairF3TableDeterministic(markdown: string): string {
  return markdown.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (fullTable, tableInner: string) => {
    const rowRegex = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
    const rows = tableInner.match(rowRegex);
    if (!rows || rows.length < 5) return fullTable;

    const outRows: string[] = [];
    let i = 0;
    while (i < rows.length) {
      const row = rows[i];
      const cells = [...row.matchAll(/<td(\b[^>]*)>([\s\S]*?)<\/td>/gi)];
      if (
        cells.length === 6 &&
        /rowspan\s*=\s*["']?[45]["']?/i.test(cells[0][1]) &&
        !/rowspan\s*=\s*["']?5["']?/i.test(cells[1][1]) &&
        /rowspan\s*=\s*["']?5["']?/i.test(cells[2][1]) &&
        i + 4 < rows.length
      ) {
        const descParts: string[] = [cells[1][2].replace(/<br\s*\/?>/gi, " ").trim()];
        const subRowsFixed: string[] = [];
        let validGroup = true;

        for (let k = 1; k <= 4; k++) {
          const subCells = [...rows[i + k].matchAll(/<td(\b[^>]*)>([\s\S]*?)<\/td>/gi)];
          if (subCells.length === 3) {
            subRowsFixed.push(rows[i + k]);
          } else if (subCells.length === 4) {
            const extraText = subCells[0][2].replace(/<br\s*\/?>/gi, " ").replace(/^[,.\s-]+/, "").trim();
            if (extraText) descParts.push(extraText);
            const rebuilt = `<tr>\n<td${subCells[1][1]}>${subCells[1][2].replace(/^\.\s*/, "")}</td>\n<td${subCells[2][1]}>${subCells[2][2]}</td>\n<td${subCells[3][1]}>${subCells[3][2]}</td>\n</tr>`;
            subRowsFixed.push(rebuilt);
          } else {
            validGroup = false;
            break;
          }
        }

        if (validGroup) {
          const cleanNr = cells[0][2].replace(/<br\s*\/?>\s*-/g, "").trim();
          const fullDesc = descParts.filter(Boolean).join(" ").replace(/\s{2,}/g, " ").trim();
          const mainRow = [
            "<tr>",
            `<td rowspan="5">${cleanNr}</td>`,
            `<td rowspan="5">${fullDesc}</td>`,
            `<td rowspan="5">${cells[2][2].trim()}</td>`,
            `<td${cells[3][1]}>${cells[3][2].trim()}</td>`,
            `<td${cells[4][1]}>${cells[4][2].trim()}</td>`,
            `<td${cells[5][1]}>${cells[5][2].trim()}</td>`,
            "</tr>"
          ].join("\n");
          outRows.push(mainRow, ...subRowsFixed);
          i += 5;
          continue;
        }
      }
      outRows.push(row);
      i++;
    }

    return `<table>\n${outRows.join("\n")}\n</table>`;
  });
}

function removeEmptyTableRows(markdown: string): string {
  return markdown.replace(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi, (fullRow, inner: string) => {
    if (/<th\b/i.test(inner)) return fullRow;
    const cellContents: string[] = [];
    const cellRegex = /<td\b[^>]*>([\s\S]*?)<\/td>/gi;
    let match: RegExpExecArray | null;
    while ((match = cellRegex.exec(inner)) !== null) {
      const stripped = match[1].replace(/<[^>]+>/g, "").trim();
      cellContents.push(stripped);
    }
    if (cellContents.length === 0) return fullRow;
    const nonEmpty = cellContents.filter((c) => c.length > 0);
    if (nonEmpty.length === 0) return "";
    if (cellContents.length >= 6 && nonEmpty.length === 1 && nonEmpty[0] === "1" && cellContents[0] === "") {
      return "";
    }
    return fullRow;
  });
}

function repairSequentialRowNumbers(markdown: string): string {
  return markdown.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (fullTable, tableInner: string) => {
    const rowRegex = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
    const rows = tableInner.match(rowRegex);
    if (!rows || rows.length < 4) return fullTable;

    let expectedIndex = 1;
    let startedDataRows = false;
    const updatedRows = rows.map((row) => {
      if (/<th\b/i.test(row) || /colspan/i.test(row)) return row;
      const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
      if (cells.length < 4) return row;
      const firstCellText = cells[0][1].replace(/<[^>]+>/g, "").trim();
      const secondCellText = cells[1][1].replace(/<[^>]+>/g, "").trim();
      if (firstCellText === "0" && secondCellText === "1") {
        startedDataRows = true;
        return row;
      }
      if (!startedDataRows) return row;
      if (/total|ore manopera/i.test(secondCellText) || /total/i.test(firstCellText)) {
        return row;
      }
      if (/^\d{4,}\s*-/.test(secondCellText)) {
        const currentNum = Number(firstCellText);
        if (currentNum !== expectedIndex) {
          const replaced = row.replace(/<td(\b[^>]*)>[\s\S]*?<\/td>/i, `<td$1>${expectedIndex}</td>`);
          expectedIndex++;
          return replaced;
        }
        expectedIndex++;
      }
      return row;
    });

    return `<table>\n${updatedRows.join("\n")}\n</table>`;
  });
}

function repairDetachedCentralizatorRows(markdown: string): string {
  const splitMarker = "<td>0</td>\n<td>1</td>\n<td>2</td>\n<td>3</td>\n</tr>\n</table>";
  const idx = markdown.indexOf(splitMarker);
  if (idx === -1) return markdown;

  const afterTable = markdown.slice(idx + splitMarker.length);
  const execIdx = afterTable.search(/\n(?:Executant|Beneficiar|Întocmit|Intocmit|Semnăt|Semnat|ROM[AÂ]NIA|#)\b/i);
  if (execIdx === -1) return markdown;

  const detachedBlock = afterTable.slice(0, execIdx).trim();
  if (!detachedBlock || /<\/?(?:table|tr|td|th)\b/i.test(detachedBlock)) return markdown;

  const lines = detachedBlock.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return markdown;

  const reconstructedRows: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^CAPITOL/i.test(line)) {
      const next = lines[i + 1] && (/^(?:[IVX]+|11)\\?\./i.test(lines[i + 1]) || !/^\d/.test(lines[i + 1]))
        ? `<br>${lines[++i]}`
        : "";
      reconstructedRows.push(`<tr>\n<td colspan="4">${line}${next}</td>\n</tr>`);
      i++;
      continue;
    }
    if (/^TOTAL\b/i.test(line) && i + 1 < lines.length && /^[\d.,]+$/.test(lines[i + 1])) {
      reconstructedRows.push(`<tr>\n<td colspan="3">${line}</td>\n<td>${lines[i + 1]}</td>\n</tr>`);
      i += 2;
      continue;
    }
    if (/^\d+\.\d+/.test(line) && i + 2 < lines.length && /^[\d.,]+$/.test(lines[i + 2])) {
      reconstructedRows.push(`<tr>\n<td>1</td>\n<td>${line}</td>\n<td>${lines[i + 1]}</td>\n<td>${lines[i + 2]}</td>\n</tr>`);
      i += 3;
      continue;
    }
    if (i + 1 < lines.length && /^[\d.,]+$/.test(lines[i + 1])) {
      reconstructedRows.push(`<tr>\n<td></td>\n<td></td>\n<td>${line}</td>\n<td>${lines[i + 1]}</td>\n</tr>`);
      i += 2;
      continue;
    }
    reconstructedRows.push(`<tr>\n<td colspan="4">${line}</td>\n</tr>`);
    i++;
  }

  if (reconstructedRows.length === 0) return markdown;
  const replacement = `<td>0</td>\n<td>1</td>\n<td>2</td>\n<td>3</td>\n</tr>\n${reconstructedRows.join("\n")}\n</table>`;
  return markdown.slice(0, idx) + replacement + afterTable.slice(execIdx);
}

export function isLlmPageOutputComplete(deterministicPage: string, llmPage: string): boolean {
  if (!llmPage.trim()) return false;
  if (llmPage.length < deterministicPage.length * 0.4 && deterministicPage.length > 300) {
    return false;
  }
  const extractDecimals = (text: string): string[] => {
    const withoutDates = text.replace(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/g, "");
    const matches = withoutDates.match(/\b\d[\d.,]*[.,]\d{2,6}\b/g) ?? [];
    return matches.map((m) => m.replace(/[.,]/g, ""));
  };
  const sourceNumbers = extractDecimals(deterministicPage);
  if (sourceNumbers.length >= 4) {
    const targetTextNormalized = llmPage.replace(/[.,]/g, "");
    let preserved = 0;
    for (const num of sourceNumbers) {
      if (targetTextNormalized.includes(num)) preserved++;
    }
    if (preserved / sourceNumbers.length < 0.9) {
      return false;
    }
  }
  return true;
}
