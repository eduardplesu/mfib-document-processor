export type PageDocumentType =
  | "invoice"
  | "centralizator"
  | "raport_cumulativ"
  | "deviz_f3"
  | "resurse_c6_c9"
  | "general";

export function detectPageDocumentType(pageMarkdown: string): PageDocumentType {
  const text = pageMarkdown.toUpperCase();
  if (
    text.includes("# FACTURA") ||
    (text.includes("FACTURA") && (text.includes("FURNIZOR") || text.includes("VALOAREA TVA") || text.includes("COTA TVA")))
  ) {
    return "invoice";
  }
  if (text.includes("CENTRALIZATORUL")) {
    return "centralizator";
  }
  if (text.includes("FORMULAR C6") || text.includes("FORMULAR C7") || text.includes("FORMULAR C8") || text.includes("FORMULAR C9")) {
    return "resurse_c6_c9";
  }
  if (
    text.includes("FORMULAR F3") ||
    text.includes("SECTIUNEA TEHNICA") ||
    text.includes("SECȚIUNEA TEHNICĂ") ||
    text.includes("CHELTUIELI DIRECTE") ||
    text.includes("RECAPITULATIE") ||
    text.includes("RECAPITULAȚIE")
  ) {
    return "deviz_f3";
  }
  if (text.includes("FORMULAR RC") || text.includes("RAPORT CUMULATIV")) {
    return "raport_cumulativ";
  }
  return "general";
}

export function buildSystemPromptForPageType(pageType: PageDocumentType, pageNumber: number, totalPages: number, hasVision: boolean): string {
  const commonRules = [
    `Ești un auditor tehnic și financiar expert în reconstrucția documentelor românești (pagina ${pageNumber} din ${totalPages}).`,
    "Reguli generale obligatorii:",
    "- NU omite niciun rând, niciun articol și nicio valoare numerică din pagină.",
    "- NU recalcula matematic sumele și NU șterge niciodată semnul minus (-) din fața cantităților sau valorilor negative (stornări).",
    "- Elimină artefactele parazite din ștampile/semnături și comentariile interne (ex. `![](signatures/...)`, `![](figures/...)`, `<!-- PageFooter ... -->`, `<!-- PageHeader ... -->`, `<!-- PageNumber ... -->`, și textul indescifrabil din ștampile rotunde precum `DIRIGINTL SE SWUTER` -> `DIRIGINTE DE ȘANTIER`).",
    "- Corectează denumirile trunchiate optic în anteturi (ex. `eneficiar:` -> `Beneficiar:`, `xecutant:` -> `Executant:`, `SC ROMAG UTHAJE CONSTRUCTI] SAL` -> `SC ROMAG UTILAJE CONSTRUCTII SRL`).",
    "- Returnează EXCLUSIV conținutul Markdown curat al acestei pagini, fără explicații și fără blocuri ```markdown."
  ];

  if (hasVision) {
    commonRules.push(
      "- Ai atașată imaginea originală: verifică vizual fiecare număr, cod de articol (ex. `STI1`), număr de rând lipit de chenar (ex. `8`) și semn minus (`-`) direct pe imagine."
    );
  }

  switch (pageType) {
    case "invoice":
      return [
        ...commonRules,
        "Instrucțiuni specifice pentru FACTURĂ:",
        "1. Structurează datele de identificare într-un tabel Markdown curat cu 2 coloane (`Furnizor` | `Client`) și un bloc clar cu metadatele facturii (`Serie și număr`, `Data`, `Cota TVA`, `Termen de plată`).",
        "2. Formatează tabelul de produse/servicii ca tabel Markdown curat (`| Nr. crt. | Denumirea produselor sau a serviciilor | U.M. | Cant. | Preț unitar (fără TVA) - Lei - | Valoarea - Lei - | Valoarea TVA - Lei - |`).",
        "3. Elimină artefactele parazite lipite în celulele numerice (de ex. `0%<br>349496.69` -> `349496.69`) și elimină rândurile complet goale sau care conțin doar o cifră rătăcită.",
        "4. Include la finalul tabelului sau imediat sub el rândurile de **Total (fără TVA)**, **Total TVA** și **Total de plată (cu TVA)**."
      ].join("\n");

    case "centralizator":
      return [
        ...commonRules,
        "Instrucțiuni specifice pentru CENTRALIZATOR:",
        "1. Dacă OCR-ul a scos rândurile centralizatorului (ex. `CAPITOL 1`, `4.1.2 Rezistenta`, `21 Suprastructura drum`, `31 Drumuri laterale`, `TOTAL CAPITOL I`, `TOTAL 1 Lucrari de drum`) în afara etichetei `<table>` ca paragrafe separate, reconstruiește-le pe toate ÎN INTERIORUL unui singur tabel complet cu toate coloanele aliniate (`Nr. | Nr. cap. Deviz General | Cheltuieli pe categoria de lucrări | Valoare (fără TVA) - Lei -`).",
        "2. Păstrează antetul (Beneficiar, Executant, Obiectiv, Obiect) curat deasupra tabelului."
      ].join("\n");

    case "raport_cumulativ":
      return [
        ...commonRules,
        "Instrucțiuni specifice pentru FORMULAR RC (Raport Cumulativ al Situațiilor de Plată):",
        "1. În coloana `Nr.`, repară indecșii ierarhici cărora le lipsește prima cifră din cauza marginii tabelului (de ex. `.1`, `.1.1`, `.1.2`, `.1.3`, `.2`, `.2.1` devin `1.1`, `1.1.1`, `1.1.2`, `1.1.3`, `1.2`, `1.2.1`).",
        "2. Elimină rândurile complet goale din tabel și păstrează intacte toate cele 11 coloane numerice.",
        "3. Dacă pagina conține doar un antet de tabel repetat fără niciun rând de date și doar semnături/ștampile, păstrează doar mențiunea scurtă de încheiere tabel/semnături fără a lăsa un tabel gol."
      ].join("\n");

    case "deviz_f3":
      return [
        ...commonRules,
        "Instrucțiuni specifice pentru FORMULAR F3 (Lista cu cantități de lucrări / Recapitulație):",
        "1. La articolele de deviz F3, fiecare articol are 5 sub-rânduri financiare: rândul principal cu `Cantitatea`, `Preț unitar`, `TOTALUL`, urmat de `material:`, `manopera:`, `utilaj:`, `transport:`. Dacă OCR-ul a spart descrierea tehnică a articolului (coloana `Capitol de lucrări`) pe rândurile de `material:` / `manopera:`, reunește toată descrierea articolului în celula principală `<td rowspan=\"5\">` a articolului și lasă sub-rândurile doar cu cele 3 celule financiare (`material:`/`manopera:`/`utilaj:`/`transport:`, preț unitar, total).",
        "2. Păstrează cu strictețe toate sub-articolele de materiale (ex. `2.1`, `4.1`, `6.1`, `6.2`, `11.1`, `12.1`) și toate semnele minus (`-`) la stornări.",
        "3. Repară numerele cu spații sau două puncte introduse eronat de OCR (ex. `35 626` -> `35.626`, `25 28` -> `25.28`, `153 82` -> `153.82`, `1.291.181:54` -> `1,291,181.54`, `305.96000D` -> `305.960000`)."
      ].join("\n");

    case "resurse_c6_c9":
      return [
        ...commonRules,
        "Instrucțiuni specifice pentru FORMULARELE C6, C7, C8, C9 (Liste de resurse: materiale, manoperă, utilaje, transport):",
        "1. Verifică secvența coloanei `Nr.` (`1, 2, 3, 4, 5, 6...`): dacă OCR-ul a citit cifra `4` ca `1` sau a lăsat celula `Nr.` goală între `3` și `5`, corectează numărul curent al rândului.",
        "2. Curăță punctele sau caracterele parazite din celulele numerice (ex. `686.62<br>.` -> `686.62`, `1,288,910` -> `1,288.910` la ore manoperă unde suma este `681.728 + 189.814 + 324.679 + 92.684 = 1,288.905`)."
      ].join("\n");

    default:
      return commonRules.join("\n");
  }
}

export function repairPageMarkdownDeterministic(rawPage: string, pageType: PageDocumentType): string {
  let text = rawPage
    .replace(/<!--\s*Page(?:Header|Footer|Number|Break).*?-->/gi, "")
    .replace(/!\[[^\]]*\]\((?:signatures|figures)\/[^)]+\)/gi, "")
    .replace(/\r\n/g, "\n");

  text = text
    .replace(/(^|\n)eneficiar\s*:/gim, "$1Beneficiar:")
    .replace(/(^|\n)xecutant\s*:/gim, "$1Executant:")
    .replace(/(^|\n)roiectant\s*:/gim, "$1Proiectant:")
    .replace(/(^|\n)[›>]?biectivul\s*:/gim, "$1Obiectivul:")
    .replace(/<td>\s*VA\s*\((\d+(?:[.,]\d+)?%)\)\s*<\/td>/gi, "<td>TVA ($1)</td>")
    .replace(/(\d[\d.,]*):(\d{2})(?=<\/td>|\s|$)/g, "$1.$2")
    .replace(/(\d+\.\d{4})DD\b/g, "$100")
    .replace(/(\d+\.\d{5})D\b/g, "$10")
    .replace(/<br\s*\/?>\s*\.\s*<\/td>/gi, "</td>")
    .replace(/<td>\s*0%\s*<br\s*\/?>\s*(\d[\d.,]*)\s*<\/td>/gi, "<td>$1</td>");

  text = removeEmptyTableRows(text);

  if (pageType === "raport_cumulativ") {
    text = text.replace(/<td>\s*\.(\d+(?:\.\d+)*)\s*<\/td>/g, "<td>1.$1</td>");
  }

  if (pageType === "resurse_c6_c9") {
    text = repairSequentialRowNumbers(text);
  }

  if (pageType === "centralizator") {
    text = repairDetachedCentralizatorRows(text);
  }

  if (pageType === "deviz_f3") {
    text = repairF3TableDeterministic(text);
  }

  return text
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  const mergedSplitTable = markdown.replace(
    /(<td>0<\/td>\s*<td>1<\/td>\s*<td>2<\/td>\s*<td>3<\/td>\s*<\/tr>)\s*<\/table>\s*<table>/gi,
    "$1"
  );
  if (mergedSplitTable !== markdown) {
    return mergedSplitTable;
  }

  if (!markdown.includes("CENTRALIZATORUL") || !markdown.includes("<td>0</td>\n<td>1</td>\n<td>2</td>\n<td>3</td>\n</tr>\n</table>")) {
    return markdown;
  }
  const splitMarker = "<td>0</td>\n<td>1</td>\n<td>2</td>\n<td>3</td>\n</tr>\n</table>";
  const idx = markdown.indexOf(splitMarker);
  if (idx === -1) return markdown;

  const afterTable = markdown.slice(idx + splitMarker.length);
  const execIdx = afterTable.search(/\nExecutant\b|\nROM[AÂ]NIA\b/i);
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
