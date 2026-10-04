import type { ToolTestSuite } from "../helpers.js";
import { TEST_PATENT } from "../helpers.js";

/** Integration tests for src/tools/fulltext.ts (claims + description) */
export const testFulltext: ToolTestSuite = async (_client, test) => {
  await test(
    "Claims (first page)",
    "get_patent_claims",
    { document_number: TEST_PATENT, max_characters: 5000 },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (!data.paragraphs?.length) return "No claim paragraphs returned";
      if (data.totalParagraphs === undefined) return "Missing totalParagraphs field";
      if (data.nextOffset === undefined && data.totalParagraphs > data.paragraphs.length)
        return "Missing nextOffset when more paragraphs exist";
      return null;
    }
  );

  await test(
    "Claims pagination (second page)",
    "get_patent_claims",
    { document_number: TEST_PATENT, offset: 5, max_characters: 3000 },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      // offset 5 might be past the end — acceptable; just shouldn't error
      return data.paragraphs !== undefined ? null : "Missing paragraphs field";
    }
  );

  await test(
    "Claims family fallback (US patent)",
    "get_patent_claims",
    { document_number: "US10167457", fallback_to_family: true, max_characters: 3000 },
    (r) => {
      const text = r.content[0].text;
      // Either got claims (JSON with paragraphs) or a graceful no-full-text message
      try {
        const data = JSON.parse(text);
        return data.paragraphs !== undefined ? null : "Missing paragraphs field";
      } catch {
        // A descriptive error message (not a crash/exception) is also acceptable
        return text.length > 20 ? null : "Empty or too-short response";
      }
    },
    true /* ignoreIsError — graceful "no full text" is acceptable for US patents without EP equivalent */
  );

  await test(
    "Description (first page)",
    "get_patent_description",
    { document_number: TEST_PATENT, max_characters: 5000 },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (!data.paragraphs?.length) return "No description paragraphs returned";
      return null;
    }
  );

  await test(
    "Description pagination continuity",
    "get_patent_description",
    { document_number: TEST_PATENT, offset: 10, max_characters: 3000 },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      return data.paragraphs !== undefined ? null : "Missing paragraphs field";
    }
  );

  await test(
    "Full text unavailable (JP patent, graceful error)",
    "get_patent_claims",
    { document_number: "JP2020123456" },
    (r) => {
      const text = r.content[0].text;
      // JP patents typically lack OPS full text — should get a helpful message, not a crash
      return text.length > 10 ? null : "Empty response for unavailable full text";
    },
    true /* ignoreIsError — a descriptive error IS the correct response here */
  );
};
