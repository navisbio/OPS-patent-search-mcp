import type { ToolTestSuite } from "../helpers.js";
import { TEST_PATENT, TEST_SEARCH_QUERY } from "../helpers.js";

/** Integration tests for src/tools/search-patents.ts */
export const testSearchPatents: ToolTestSuite = async (_client, test) => {
  await test(
    "Basic CQL search",
    "search_patents",
    { query: TEST_SEARCH_QUERY, range_end: 10 },
    (r) => {
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      if (data.totalCount === 0) return "Expected results, got 0";
      if (!data.results?.[0]?.publicationNumber) return "Missing publicationNumber in results";
      return null;
    }
  );

  await test(
    "Search pagination metadata (nextOffset)",
    "search_patents",
    { query: TEST_SEARCH_QUERY, range_end: 5 },
    (r) => {
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      if (data.totalCount === undefined) return "Missing totalCount";
      // nextOffset should be present when there are more results beyond range_end
      if (data.totalCount > 5 && data.nextOffset === undefined)
        return "Missing nextOffset when more results exist";
      return null;
    }
  );

  await test(
    "Search with date filter params",
    "search_patents",
    { query: 'ta="antibody drug conjugate"', published_after: "2022", range_end: 5 },
    (r) => {
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      return data.totalCount > 0 ? null : "Expected results, got 0";
    }
  );

  await test(
    "Search auto-paginate (small)",
    "search_patents",
    { query: 'pa="Broad Institute" AND ta="CRISPR"', auto_paginate: true, max_results: 30 },
    (r) => {
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      return data.fetchedCount > 0 ? null : "auto_paginate returned 0 results";
    }
  );

  await test(
    "count_only returns totalCount without results",
    "search_patents",
    { query: TEST_SEARCH_QUERY, count_only: true },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (typeof data.totalCount !== "number") return "Missing totalCount";
      if (data.results !== undefined) return "count_only should not return results array";
      return null;
    }
  );

  await test(
    "Date range (published_after + published_before) — uses pd within syntax",
    "search_patents",
    { query: 'ta="anti-PD-1 antibody"', published_after: "20080101", published_before: "20151231", range_end: 5 },
    (r) => {
      if (r.content[0].text.startsWith("Error:")) return r.content[0].text;
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      return data.totalCount > 0 ? null : "Expected results for two-sided date range";
    }
  );

  await test(
    "auto_paginate decomposes >2000 query by year",
    "search_patents",
    { query: 'ta="KRAS"', published_after: "2023", published_before: "2025", auto_paginate: true, max_results: 50 },
    (r) => {
      const text = r.content[0].text;
      const data = JSON.parse(text.split("\n\n")[0]);
      if (data.fetchedCount === 0) return "Expected results";
      // Should mention year decomposition in the note when total > 2000
      if (data.totalCount > 2000 && !text.includes("year decomposition")) {
        return `totalCount=${data.totalCount} > 2000 but no year decomposition note`;
      }
      return null;
    }
  );

  await test(
    "Search with no results (graceful)",
    "search_patents",
    { query: 'ti="xyzzy_nonexistent_patent_title_zqwerty_12345"' },
    (r) => {
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      return data.totalCount === 0 ? null : "Expected 0 results for nonsense query";
    }
  );

  await test(
    "Forward citations via search",
    "search_patents",
    { query: `ct="${TEST_PATENT}"`, range_end: 5 },
    (r) => {
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      // Just check the call succeeds — may be 0 results if no forward citations indexed yet
      return data.totalCount !== undefined ? null : "Missing totalCount";
    }
  );
};
