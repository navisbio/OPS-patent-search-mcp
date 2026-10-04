import type { ToolTestSuite } from "../helpers.js";
import { TEST_PATENT } from "../helpers.js";

/** Integration tests for src/tools/search-in-patent-text.ts */
export const testSearchInPatentText: ToolTestSuite = async (_client, test) => {
  await test(
    "Keyword search in patent text",
    "search_in_patent_text",
    { document_number: TEST_PATENT, search_terms: ["CRISPR", "nucleic"] },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (data.matchCount === undefined) return "Missing matchCount";
      if (data.matchCount === 0) return "Expected matches for 'CRISPR' in CRISPR patent";
      return null;
    }
  );

  await test(
    "Keyword search — claims only filter",
    "search_in_patent_text",
    { document_number: TEST_PATENT, search_terms: ["nucleic acid"], section_filter: ["claims"] },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      const allInClaims = data.matches?.every((m: { section: string }) => m.section === "claims") ?? true;
      return allInClaims ? null : "section_filter='claims' returned description matches";
    }
  );

  await test(
    "Keyword search — description only filter",
    "search_in_patent_text",
    { document_number: TEST_PATENT, search_terms: ["nucleic"], section_filter: ["description"] },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      const allInDesc = data.matches?.every((m: { section: string }) => m.section === "description") ?? true;
      return allInDesc ? null : "section_filter='description' returned claims matches";
    }
  );

  await test(
    "Keyword search — no match (graceful)",
    "search_in_patent_text",
    { document_number: TEST_PATENT, search_terms: ["xyzzy_nonexistent_term"] },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      return data.matchCount === 0 ? null : "Expected 0 matches for nonsense term";
    }
  );
};
