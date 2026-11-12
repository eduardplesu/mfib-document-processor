import { describe, expect, it } from "vitest";
import { cleanRawPageMarkdown } from "../../src/lib/direct-ocr";
import {
  buildSystemPromptForPageType,
  detectPageDocumentType,
  isLlmPageOutputComplete,
  repairPageMarkdownDeterministic
} from "../../src/lib/page-types";

describe("structure-agnostic page profiling and geometric repair", () => {
  it("classifies pages by structural geometry rather than hardcoded template names", () => {
    expect(detectPageDocumentType("Furnizor: X\nCIF: 123\nIBAN: RO00\nData: 01/01/2026\n<table><tr><td>1</td></tr></table>")).toBe("entity_and_table_form");
    expect(detectPageDocumentType("<table><tr><td rowspan=\"5\">1</td><td>Row</td></tr></table>")).toBe("complex_merged_table");
    expect(detectPageDocumentType("<table><tr><th>Col1</th><th>Col2</th></tr><tr><td>A</td><td>B</td></tr></table>")).toBe("standard_table");
    expect(detectPageDocumentType("Contract de prestări servicii încheiat astăzi între părți.")).toBe("narrative_or_mixed");
  });

  it("builds structure-agnostic instructions per structural profile", () => {
    expect(buildSystemPromptForPageType("entity_and_table_form", 1, 10, false)).toContain("agnostic");
    expect(buildSystemPromptForPageType("complex_merged_table", 2, 10, false)).toContain("rowspan");
    expect(buildSystemPromptForPageType("standard_table", 3, 10, false)).toContain("tabel");
    expect(buildSystemPromptForPageType("narrative_or_mixed", 4, 10, false)).toContain("narative");
  });

  it("strips signature/figure placeholders and page metadata comments", () => {
    const raw = "<!-- PageHeader: Test -->\nText util\n![sig](signatures/1.1)\n<!-- PageFooter: eDevize -->";
    expect(cleanRawPageMarkdown(raw)).toBe("Text util");
  });

  it("deterministically repairs clipped hierarchy indices, watermark noise, orphaned rows, and converts 2D HTML tables to Markdown", () => {
    const rcRaw = "<table><tr><td>1</td><td>Root</td></tr><tr><td>.1</td><td>1 Sub</td></tr><tr><td>.1.2</td><td>21 Leaf</td></tr></table>";
    const rcRepaired = repairPageMarkdownDeterministic(rcRaw);
    expect(rcRepaired).toContain("| 1.1 | 1 Sub |");
    expect(rcRepaired).toContain("| 1.1.2 | 21 Leaf |");

    const invRaw = "<table><tr><td>1</td><td>Servicii</td><td>buc</td><td>1</td><td>0%<br>349496.69</td><td>349496.69</td><td>66404.37</td></tr><tr><td></td><td></td><td>1</td><td></td><td></td><td></td><td></td></tr></table>";
    const invCleaned = repairPageMarkdownDeterministic(invRaw);
    expect(invCleaned).toContain("| 1 | Servicii | buc | 1 | 349496.69 | 349496.69 | 66404.37 |");
    expect(invCleaned).not.toContain("0%");

    const centRaw = [
      "### Tabel generic cu rânduri desprinse",
      "<table>",
      "<tr><th rowspan=\"2\">Nr.</th><th>Cap</th><th>Categorie</th><th>Valoare</th></tr>",
      "<tr>\n<td>0</td>\n<td>1</td>\n<td>2</td>\n<td>3</td>\n</tr>\n</table>",
      "",
      "CAPITOL 1",
      "11. Constructii",
      "4.1.2",
      "Rezistenta",
      "1,140,127.02",
      "TOTAL CAPITOL I",
      "1,140,127.02",
      "",
      "Executant,"
    ].join("\n");
    const centRepaired = repairPageMarkdownDeterministic(centRaw);
    expect(centRepaired).toContain("<td>4.1.2</td>\n<td>Rezistenta</td>\n<td>1,140,127.02</td>");
    expect(centRepaired).toContain("<td colspan=\"3\">TOTAL CAPITOL I</td>\n<td>1,140,127.02</td>");
  });

  it("rejects truncated LLM page output that loses numeric values", () => {
    const det = "<table><tr><td>355,296.35</td><td>67,506.31</td><td>422,802.66</td><td>1,607,151.30</td></tr></table>";
    expect(isLlmPageOutputComplete(det, "<table><tr><td>355,296.35</td></tr></table>")).toBe(false);
    expect(isLlmPageOutputComplete(det, "<table><tr><td>355,296.35</td><td>67,506.31</td><td>422,802.66</td><td>1,607,151.30</td></tr></table>")).toBe(true);
  });
});
