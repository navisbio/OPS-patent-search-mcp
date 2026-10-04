import type { ToolTestSuite } from "../helpers.js";

/** Integration tests for src/tools/search-and-filter.ts */
export const testSearchAndFilter: ToolTestSuite = async (_client, test) => {
  await test(
    "search_and_filter_fulltext — returns only patents whose text matches",
    "search_and_filter_fulltext",
    {
      query: 'ta="CRISPR"',
      filter_terms: ["Cas9"],
      section_filter: ["claims"],
      published_before: "20190101",
      max_patents_to_scan: 3,
      max_snippets_per_patent: 1,
    },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (data.matchedCount === undefined) return "Missing matchedCount";
      if (!Array.isArray(data.matched)) return "Missing matched array";
      if (!Array.isArray(data.skipped)) return "Missing skipped array";
      if (data.scanned > 3) return `scanned ${data.scanned} exceeds max_patents_to_scan=3`;
      // Every returned patent must actually carry a hit for a requested term.
      for (const m of data.matched) {
        if (!m.termsFound?.length) return `${m.publicationNumber} returned with no termsFound`;
        if (!m.snippets?.length) return `${m.publicationNumber} returned with no snippets`;
        if (m.snippets.some((s: { section: string }) => s.section !== "claims"))
          return `${m.publicationNumber} returned a non-claims snippet under section_filter=["claims"]`;
      }
      return null;
    }
  );

  await test(
    "search_and_filter_fulltext — match_mode='all' is stricter than 'any'",
    "search_and_filter_fulltext",
    {
      query: 'ta="CRISPR"',
      filter_terms: ["Cas9", "zzzznotarealterm"],
      match_mode: "all",
      published_before: "20190101",
      max_patents_to_scan: 2,
    },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (data.matchedCount === undefined) return "Missing matchedCount";
      // No patent can contain a nonsense term, so 'all' must yield nothing.
      if (data.matchedCount !== 0)
        return `match_mode='all' with an impossible term returned ${data.matchedCount} matches`;
      return null;
    }
  );
};
