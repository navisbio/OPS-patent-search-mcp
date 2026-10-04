import type { ToolTestSuite } from "../helpers.js";
import { TEST_PATENT } from "../helpers.js";

/** Integration tests for src/tools/get-patent-details.ts */
export const testGetPatentDetails: ToolTestSuite = async (_client, test) => {
  await test(
    "Biblio (epodoc)",
    "get_patent_details",
    { document_number: TEST_PATENT },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (!Array.isArray(data) || data.length === 0) return "Expected array of biblio records";
      if (!data[0].title) return "Missing title in biblio";
      return null;
    }
  );

  await test(
    "Biblio (docdb format)",
    "get_patent_details",
    { document_number: "EP.3750919.A1", input_format: "docdb" },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      return Array.isArray(data) && data.length > 0 ? null : "Expected biblio records";
    }
  );

  await test(
    "Abstract",
    "get_patent_details",
    { document_number: TEST_PATENT },
    (r) => {
      const text = r.content[0].text;
      return text.length > 50 && !text.includes("no abstract") ? null : "Abstract too short or missing";
    }
  );
};
