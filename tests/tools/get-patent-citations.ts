import type { ToolTestSuite } from "../helpers.js";
import { TEST_PATENT } from "../helpers.js";

/** Integration tests for src/tools/get-patent-citations.ts */
export const testGetPatentCitations: ToolTestSuite = async (_client, test) => {
  await test(
    "Citations (backward)",
    "get_patent_citations",
    { document_number: TEST_PATENT },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (data.totalCitations === undefined) return "Missing totalCitations field";
      if (!Array.isArray(data.patentCitations)) return "Missing patentCitations array";
      if (!Array.isArray(data.nplCitations)) return "Missing nplCitations array";
      if (data.totalCitations === 0) return "Expected at least one citation in a CRISPR patent";
      if (data.patentCitations.length === 0 && data.nplCitations.length === 0)
        return "totalCitations > 0 but both citation arrays are empty";
      return null;
    }
  );
};
