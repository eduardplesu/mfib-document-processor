import ExcelJS from "exceljs";

type TableShape = { rowCount?: unknown; columnCount?: unknown; pageNumber?: unknown; boundingRegions?: unknown; cells?: unknown };
type CellShape = { rowIndex?: unknown; columnIndex?: unknown; rowSpan?: unknown; columnSpan?: unknown; content?: unknown };

export async function createWorkbook(tables: readonly unknown[], documentName: string): Promise<{ buffer: Buffer; warnings: string[] }> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "MFIB Document Processor";
  workbook.subject = "Extracție OCR";
  workbook.addWorksheet("Summary").addRows([
    ["Document", documentName],
    ["Tabele extrase", tables.length],
    ["Referință", "Foi separate pentru fiecare tabel"]
  ]);
  const warnings: string[] = [];

  tables.forEach((value, tableIndex) => {
    const table = isRecord(value) ? value as TableShape : {};
    const rowCount = dimension(table.rowCount, 10000, warnings, tableIndex, "rânduri");
    const columnCount = dimension(table.columnCount, 500, warnings, tableIndex, "coloane");
    const pageNumber = resolvePageNumber(table);
    const sheet = workbook.addWorksheet(uniqueSheetName(workbook, `T${tableIndex + 1}_P${pageNumber}`));
    const claimed = new Set<string>();
    const cells = Array.isArray(table.cells) ? table.cells : [];
    for (const rawCell of cells) {
      if (!isRecord(rawCell)) {
        warnings.push(`Tabel ${tableIndex + 1}: celulă cu structură invalidă.`);
        continue;
      }
      const cell = rawCell as CellShape;
      const row = Number(cell.rowIndex);
      const col = Number(cell.columnIndex);
      const rowSpan = span(cell.rowSpan);
      const columnSpan = span(cell.columnSpan);
      if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || col < 0 || row >= rowCount || col >= columnCount
        || row + rowSpan > rowCount || col + columnSpan > columnCount) {
        warnings.push(`Tabel ${tableIndex + 1}: celulă în afara dimensiunilor declarate.`);
        continue;
      }
      let overlaps = false;
      for (let r = row; r < row + rowSpan; r++) {
        for (let c = col; c < col + columnSpan; c++) {
          if (claimed.has(`${r}:${c}`)) overlaps = true;
        }
      }
      if (overlaps) {
        warnings.push(`Tabel ${tableIndex + 1}: celule suprapuse; celula ulterioară a fost omisă.`);
        continue;
      }
      for (let r = row; r < row + rowSpan; r++) {
        for (let c = col; c < col + columnSpan; c++) claimed.add(`${r}:${c}`);
      }
      if (rowSpan > 1 || columnSpan > 1) sheet.mergeCells(row + 1, col + 1, row + rowSpan, col + columnSpan);
      const target = sheet.getCell(row + 1, col + 1);
      target.value = typeof cell.content === "string" ? cell.content : "";
      target.numFmt = "@";
    }
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    sheet.columns = Array.from({ length: columnCount }, () => ({ width: 22 }));
  });

  if (warnings.length) {
    const sheet = workbook.addWorksheet("Warnings");
    warnings.forEach((warning) => sheet.addRow([warning]));
  }
  return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), warnings };
}

function resolvePageNumber(table: TableShape): number {
  if (Number.isInteger(table.pageNumber)) return Number(table.pageNumber);
  if (Array.isArray(table.boundingRegions)) {
    const firstRegion = table.boundingRegions.find(isRecord);
    if (firstRegion && Number.isInteger(firstRegion.pageNumber)) {
      return Number(firstRegion.pageNumber);
    }
  }
  return 0;
}

function dimension(value: unknown, limit: number, warnings: string[], tableIndex: number, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    warnings.push(`Tabel ${tableIndex + 1}: număr de ${name} invalid.`);
    return 0;
  }
  if (parsed > limit) warnings.push(`Tabel ${tableIndex + 1}: ${name} peste limita sigură de export; tabelul a fost trunchiat.`);
  return Math.min(parsed, limit);
}

function span(value: unknown): number {
  const parsed = value === undefined ? 1 : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
}

function uniqueSheetName(workbook: ExcelJS.Workbook, proposed: string): string {
  const base = proposed.replace(/[\\/?*[\]:]/g, "_").slice(0, 31) || "Table";
  let name = base;
  let suffix = 1;
  while (workbook.getWorksheet(name)) {
    const ending = `_${suffix++}`;
    name = `${base.slice(0, 31 - ending.length)}${ending}`;
  }
  return name;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
