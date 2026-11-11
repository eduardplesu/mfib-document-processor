import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { createWorkbook } from "../../src/lib/excel";

describe("Excel table export", () => {
  it("preserves Romanian and financial text, spans, and negative values", async () => {
    const bytes = await createWorkbook([{
      pageNumber: 1, rowCount: 2, columnCount: 2,
      cells: [
        { rowIndex: 0, columnIndex: 0, rowSpan: 1, columnSpan: 2, content: "Situație de plată" },
        { rowIndex: 1, columnIndex: 0, content: "-233.270000" },
        { rowIndex: 1, columnIndex: 1, content: "1.426,500000" }
      ]
    }], "F3");
    const workbook = new ExcelJS.Workbook();
    const workbookBytes = Buffer.alloc(bytes.buffer.length);
    bytes.buffer.copy(workbookBytes);
    const data = new ArrayBuffer(workbookBytes.byteLength);
    new Uint8Array(data).set(workbookBytes);
    await workbook.xlsx.load(data);
    const sheet = workbook.getWorksheet("T1_P1");
    expect(sheet?.getCell("A2").value).toBe("-233.270000");
    expect(sheet?.getCell("B2").value).toBe("1.426,500000");
    expect(sheet?.getCell("A1").value).toBe("Situație de plată");
    expect(sheet?.model.merges).toContain("A1:B1");
  });

  it("keeps formula-like OCR strings as text cells", async () => {
    const bytes = await createWorkbook([{ rowCount: 1, columnCount: 1, cells: [{ rowIndex: 0, columnIndex: 0, content: "=1+1" }] }], "test");
    const workbook = new ExcelJS.Workbook();
    const workbookBytes = Buffer.alloc(bytes.buffer.length);
    bytes.buffer.copy(workbookBytes);
    const data = new ArrayBuffer(workbookBytes.byteLength);
    new Uint8Array(data).set(workbookBytes);
    await workbook.xlsx.load(data);
    const cell = workbook.getWorksheet("T1_P0")?.getCell("A1");
    expect(cell?.type).not.toBe(ExcelJS.ValueType.Formula);
    expect(cell?.value).toBe("=1+1");
  });

  it("resolves worksheet page number from Document Intelligence boundingRegions", async () => {
    const bytes = await createWorkbook([{
      boundingRegions: [{ pageNumber: 2 }],
      rowCount: 1,
      columnCount: 1,
      cells: [{ rowIndex: 0, columnIndex: 0, content: "Valoare" }]
    }], "test");
    const workbook = new ExcelJS.Workbook();
    const workbookBytes = Buffer.alloc(bytes.buffer.length);
    bytes.buffer.copy(workbookBytes);
    const data = new ArrayBuffer(workbookBytes.byteLength);
    new Uint8Array(data).set(workbookBytes);
    await workbook.xlsx.load(data);
    expect(workbook.getWorksheet("T1_P2")?.getCell("A1").value).toBe("Valoare");
  });
});
