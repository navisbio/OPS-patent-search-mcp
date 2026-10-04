import type { ToolTestSuite } from "../helpers.js";
import { TEST_PATENT } from "../helpers.js";

/** Integration tests for src/tools/get-patent-legal-status.ts */
export const testGetPatentLegalStatus: ToolTestSuite = async (_client, test) => {
  await test(
    "Legal status",
    "get_patent_legal_status",
    { document_number: TEST_PATENT },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (!data.legalEvents) return "Missing legalEvents field";
      if (!Array.isArray(data.legalEvents)) return "legalEvents is not an array";
      if (data.legalEvents.length === 0) return "Expected at least one legal event for a granted patent";
      if (!data.legalEvents[0].eventCode) return "Missing eventCode on first legal event";
      return null;
    }
  );
};
