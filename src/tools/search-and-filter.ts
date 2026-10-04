import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EpoClient } from "../epo-client.js";
import { parseSearchResults, parseFulltextParagraphs, searchKeywordsInParagraphs } from "../parsers.js";
import { createHelpers } from "../helpers.js";
import { fetchWithFamilyFallback } from "../fallback.js";
import { fallbackToFamilyParam } from "./params.js";
import { buildDateCql } from "../search.js";

export function registerSearchAndFilterFulltext(server: McpServer, client: EpoClient) {
  const { errorResult, jsonResult } = createHelpers(client);

server.registerTool(
  "search_and_filter_fulltext",
  {
    description: `Run a CQL search, then keep only the patents whose full text actually contains your terms. Combines search_patents + search_in_patent_text into one call.

IMPORTANT — LEGAL: Only present patents and snippets returned by this tool. Patents listed under "skipped" were NOT checked — never claim they do or do not contain your terms.

Use this when you want "patents matching X whose claims mention Y" — the single most common patent workflow. It replaces an N+1 sequence of one search plus one full-text call per hit, which is slow and burns the OPS rate limit.

CQL title/abstract search finds patents *about* a topic; this tool then confirms the concept appears in the claims or description. Use section_filter=["claims"] when what matters is what is actually claimed, which is the right test for freedom-to-operate.

COST: one API call for the search, then up to two more per patent scanned. Full text is fetched sequentially and max_patents_to_scan is capped deliberately — raise it only when you need to. If the tool runs out of time it returns what it has and sets truncated=true rather than failing.

Full text exists mainly for EP, WO and US. Patents without it are reported under "skipped", not silently dropped.`,
    inputSchema: {
      query: z
        .string()
        .describe('CQL query, e.g. ta="CRISPR" AND pd>=2020'),
      filter_terms: z
        .array(z.string())
        .min(1)
        .describe('Terms that must appear in the full text, e.g. ["guide RNA", "Cas9"]'),
      match_mode: z
        .enum(["any", "all"])
        .default("any")
        .describe('"any" keeps a patent if any term appears (default); "all" requires every term.'),
      section_filter: z
        .array(z.enum(["claims", "description"]))
        .optional()
        .describe('Restrict the text check to a section, e.g. ["claims"]. Omit to check both.'),
      max_patents_to_scan: z
        .number()
        .int()
        .min(1)
        .max(25)
        .default(10)
        .describe("How many search hits to fetch full text for (default 10, max 25). Each one costs up to 2 API calls."),
      published_after: z
        .string()
        .optional()
        .describe('Only patents published on/after this date, YYYYMMDD'),
      published_before: z
        .string()
        .optional()
        .describe('Only patents published on/before this date, YYYYMMDD'),
      context_chars: z
        .number()
        .int()
        .min(20)
        .max(2000)
        .default(150)
        .describe("Characters of context around each snippet (default 150)"),
      max_snippets_per_patent: z
        .number()
        .int()
        .min(1)
        .max(20)
        .default(3)
        .describe("Snippets to return per matching patent (default 3)"),
      case_sensitive: z
        .boolean()
        .default(false)
        .describe("Case-sensitive matching (default false)"),
      fallback_to_family: fallbackToFamilyParam.describe("On a 404, try EP/WO family equivalents for full text. Default true."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({
    query,
    filter_terms,
    match_mode,
    section_filter,
    max_patents_to_scan,
    published_after,
    published_before,
    context_chars,
    max_snippets_per_patent,
    case_sensitive,
    fallback_to_family,
  }) => {
    client.startToolCall();
    try {
      const cql = buildDateCql(query, published_after, published_before);

      // Fetch a wider window than we will scan. OPS orders results by relevance,
      // and the top of that list is often CN/JP/KR or very recent WO documents
      // that have no full text indexed — scanning those wastes the whole budget
      // on skips. Over-fetch, then prefer the ones that plausibly have text.
      const searchWindow = Math.min(Math.max(max_patents_to_scan * 4, max_patents_to_scan), 100);
      const searchRaw = await client.search(cql, 1, searchWindow);
      const { totalCount, results } = parseSearchResults(searchRaw);

      if (results.length === 0) {
        return jsonResult({
          query: cql,
          totalCount: 0,
          scanned: 0,
          matchedCount: 0,
          matched: [],
          skipped: [],
          hint: "No patents matched the CQL query. Broaden the query before adjusting filter_terms.",
        });
      }

      // Stable partition: keep relevance order inside each group.
      const likely = results.filter((r) => r.fulltextLikely !== false);
      const unlikely = results.filter((r) => r.fulltextLikely === false);
      const ordered = [...likely, ...unlikely];
      const candidates = ordered.slice(0, max_patents_to_scan);
      const deprioritised = unlikely.length > 0 && likely.length >= max_patents_to_scan;
      const matched: Record<string, unknown>[] = [];
      const skipped: { publicationNumber: string; title: string; reason: string }[] = [];

      // Reserve enough of the deadline to serialise and return what we have.
      const RESERVE_MS = 8_000;
      let scanned = 0;
      let truncated = false;

      for (const item of candidates) {
        if (client.timeRemaining < RESERVE_MS) {
          truncated = true;
          break;
        }
        scanned++;
        const doc = item.publicationNumber;

        let claimsRaw: string | null = null;
        let descRaw: string | null = null;
        let substitutedFrom: string | undefined;

        const wantClaims = !section_filter || section_filter.includes("claims");
        const wantDesc = !section_filter || section_filter.includes("description");

        if (wantClaims) {
          try {
            if (fallback_to_family) {
              const r = await fetchWithFamilyFallback(client, doc, "epodoc", (d, f) => client.getClaims(d, f));
              claimsRaw = r.raw;
              if (r.substituted) substitutedFrom = r.resolvedDocument;
            } else {
              claimsRaw = await client.getClaims(doc, "epodoc");
            }
          } catch {
            // no claims for this document
          }
        }

        if (wantDesc && client.timeRemaining >= RESERVE_MS) {
          try {
            const srcDoc = substitutedFrom ?? doc;
            const srcFmt = substitutedFrom ? "docdb" : "epodoc";
            if (fallback_to_family) {
              const r = await fetchWithFamilyFallback(client, srcDoc, srcFmt, (d, f) => client.getDescription(d, f));
              descRaw = r.raw;
              if (r.substituted) substitutedFrom = r.resolvedDocument;
            } else {
              descRaw = await client.getDescription(srcDoc, srcFmt);
            }
          } catch {
            // no description for this document
          }
        }

        if (!claimsRaw && !descRaw) {
          skipped.push({
            publicationNumber: doc,
            title: item.title,
            reason: "no full text available in OPS (not indexed for this office/kind code)",
          });
          continue;
        }

        const claimsParagraphs = claimsRaw ? parseFulltextParagraphs(claimsRaw) : [];
        const descParagraphs = descRaw ? parseFulltextParagraphs(descRaw) : [];
        const allParagraphs = [...claimsParagraphs, ...descParagraphs];
        let idx = 0;
        for (const p of allParagraphs) p.index = idx++;

        const found = searchKeywordsInParagraphs(allParagraphs, filter_terms, {
          contextChars: context_chars,
          limit: max_snippets_per_patent,
          caseSensitive: case_sensitive,
          sectionFilter: section_filter,
        });

        const termsHit = filter_terms.filter(
          (t) => (found.matchCountByKeyword?.[t] ?? 0) > 0
        );
        const keep =
          match_mode === "all"
            ? termsHit.length === filter_terms.length
            : termsHit.length > 0;

        if (!keep) continue;

        const claimsCount = claimsParagraphs.length;
        const entry: Record<string, unknown> = {
          publicationNumber: doc,
          title: item.title,
          applicants: item.applicants,
          publicationDate: item.publicationDate,
          termsFound: termsHit,
          totalMatchCount: found.totalMatchCount,
          matchCountByKeyword: found.matchCountByKeyword,
          snippets: found.matches.map((m) => ({
            ...m,
            sectionOffset:
              m.section === "claims" ? m.paragraphIndex : m.paragraphIndex - claimsCount,
          })),
        };
        if (substitutedFrom) {
          entry.note = `Full text taken from family member ${substitutedFrom}.`;
        }
        matched.push(entry);
      }

      const notes: string[] = [];
      if (truncated) {
        notes.push(
          `Stopped after ${scanned} of ${candidates.length} patents to stay inside the tool time budget. Re-run with a narrower query or a smaller max_patents_to_scan, or raise OPS_TOOL_TIMEOUT_MS.`
        );
      }
      if (totalCount > candidates.length) {
        notes.push(
          `The CQL query matched ${totalCount} patents; ${candidates.length} were checked for full text. Patents beyond that were not examined.`
        );
      }
      if (deprioritised) {
        notes.push(
          `${unlikely.length} result(s) from CN/JP/KR or other offices whose full text OPS rarely indexes were ranked below the ones checked. They may still be relevant — retrieve them with search_patents if needed.`
        );
      }
      if (skipped.length > 0) {
        notes.push(
          `${skipped.length} patent(s) had no full text in OPS and were not checked — see "skipped". Their contents are unknown, not absent.`
        );
      }

      return jsonResult(
        {
          query: cql,
          totalCount,
          scanned,
          truncated,
          matchMode: match_mode,
          sectionsChecked: section_filter ?? ["claims", "description"],
          filterTerms: filter_terms,
          matchedCount: matched.length,
          matched,
          skipped,
          ...(notes.length > 0 ? { notes } : {}),
          hint:
            matched.length > 0
              ? `${matched.length} of ${scanned} scanned patents contain the terms. Use a snippet's sectionOffset as the offset for get_patent_claims (section=claims) or get_patent_description (section=description) to read further.`
              : `None of the ${scanned} scanned patents contained ${match_mode === "all" ? "all of" : "any of"} the terms. Try match_mode="any", broader terms, or drop section_filter.`,
        },
        { grounding: true }
      );
    } catch (e) {
      return errorResult(e);
    }
  }
);
}
