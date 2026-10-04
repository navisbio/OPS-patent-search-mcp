import type { ToolTestSuite } from "../helpers.js";
import { TEST_PATENT } from "../helpers.js";

/** Integration tests for src/tools/get-patent-family.ts */
export const testGetPatentFamily: ToolTestSuite = async (_client, test) => {
  await test(
    "Patent family",
    "get_patent_family",
    { document_number: TEST_PATENT },
    (r) => {
      const text = r.content[0].text;
      // CRISPR patents may have very large families — accept either results or
      // the "too large, request in chunks" message (both indicate a working endpoint)
      const data = JSON.parse(text);
      // Direct array of members
      if (Array.isArray(data) && data.length > 0) {
        return data[0].publicationNumber ? null : "Missing publicationNumber in family member";
      }
      // Wrapped format from light fallback (large families): { members: [...], note: "..." }
      if (Array.isArray(data?.members) && data.members.length > 0) {
        return data.members[0].publicationNumber ? null : "Missing publicationNumber in family member";
      }
      return "Expected family members";
    },
    true /* ignoreIsError — large-family OPS error is a known limitation, not a test failure */
  );
};
