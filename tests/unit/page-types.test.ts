import { describe, expect, it } from "vitest";
import { cleanRawPageMarkdown } from "../../src/lib/direct-ocr";
import {
  buildSystemPromptForPageType,
  detectPageDocumentType,
  isLlmPageOutputComplete,
  repairPageMarkdownDeterministic
} from "../../src/lib/page-types";

describe("page document type detection and specialized prompts", () => {
  it("detects invoices, centralizatoare, cumulative reports, F3 devize, and C6-C9 resource lists", () => {
    expect(detectPageDocumentType("# FACTURA\nFurnizor: ROMAG\nCota TVA: 19%")).toBe("invoice");
    expect(detectPageDocumentType("### CENTRALIZATORUL pe obiect al realizarilor")).toBe("centralizator");
    expect(detectPageDocumentType("# Formular RC - Raport Cumulativ al Situatiilor de Plata")).toBe("raport_cumulativ");
    expect(detectPageDocumentType("## Formular F3 - Situatia de lucrari nr. 3\nSECTIUNEA TEHNICA")).toBe("deviz_f3");
    expect(detectPageDocumentType("### Formular C6 Lista cuprinzand realizarile de resurse materiale")).toBe("resurse_c6_c9");
    expect(detectPageDocumentType("Adresa de inaintare catre primarie")).toBe("general");
  });

  it("includes specialized instructions per page type", () => {
    expect(buildSystemPromptForPageType("invoice", 1, 13, false)).toContain("FACTURĂ");
    expect(buildSystemPromptForPageType("centralizator", 4, 13, false)).toContain("CENTRALIZATOR");
    expect(buildSystemPromptForPageType("raport_cumulativ", 2, 13, false)).toContain("FORMULAR RC");
    expect(buildSystemPromptForPageType("deviz_f3", 5, 13, false)).toContain("FORMULAR F3");
    expect(buildSystemPromptForPageType("resurse_c6_c9", 9, 13, false)).toContain("C6, C7, C8, C9");
  });

  it("strips signature/figure placeholders and page metadata comments", () => {
    const raw = "<!-- PageHeader: Test -->\nText util\n![sig](signatures/1.1)\n<!-- PageFooter: eDevize -->";
    expect(cleanRawPageMarkdown(raw)).toBe("Text util");
  });

  it("deterministically repairs Formular RC hierarchy indices, invoice watermark noise, and detached centralizator rows", () => {
    const rcRaw = "<table><tr><td>.1</td><td>1 Lucrari</td></tr><tr><td>.1.2</td><td>21 Suprastructura</td></tr></table>";
    expect(repairPageMarkdownDeterministic(rcRaw, "raport_cumulativ")).toContain("<td>1.1</td>");
    expect(repairPageMarkdownDeterministic(rcRaw, "raport_cumulativ")).toContain("<td>1.1.2</td>");

    const invRaw = "<table><tr><td>1</td><td>Servicii</td><td>buc</td><td>1</td><td>0%<br>349496.69</td><td>349496.69</td><td>66404.37</td></tr><tr><td></td><td></td><td>1</td><td></td><td></td><td></td><td></td></tr></table>";
    const invCleaned = repairPageMarkdownDeterministic(invRaw, "invoice");
    expect(invCleaned).toContain("<td>349496.69</td>");
    expect(invCleaned).not.toContain("0%<br>");
    expect(invCleaned).not.toContain("<td></td><td></td><td>1</td>");

    const centRaw = [
      "### CENTRALIZATORUL pe obiect",
      "<table>",
      "<tr><th>Nr.</th><th>Cap</th><th>Categorie</th><th>Lei</th></tr>",
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
    const centRepaired = repairPageMarkdownDeterministic(centRaw, "centralizator");
    expect(centRepaired).toContain("<td>4.1.2</td>\n<td>Rezistenta</td>\n<td>1,140,127.02</td>");
    expect(centRepaired).toContain("<td colspan=\"3\">TOTAL CAPITOL I</td>\n<td>1,140,127.02</td>");
  });

  it("rejects truncated LLM page output that loses numeric values", () => {
    const det = "<table><tr><td>355,296.35</td><td>67,506.31</td><td>422,802.66</td><td>1,607,151.30</td></tr></table>";
    expect(isLlmPageOutputComplete(det, "<table><tr><td>355,296.35</td></tr></table>")).toBe(false);
    expect(isLlmPageOutputComplete(det, "<table><tr><td>355,296.35</td><td>67,506.31</td><td>422,802.66</td><td>1,607,151.30</td></tr></table>")).toBe(true);
  });
});
