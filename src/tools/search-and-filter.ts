import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type EpoClient, type OpsApiError, interruptionMetadata } from "../epo-client.js";
import { parseSearchResults, searchKeywordsInParagraphs } from "../parsers.js";
import { createHelpers } from "../helpers.js";
import { retrieveTextSections } from "../text-retrieval.js";
import { fallbackToFamilyParam, searchTermsParam } from "./params.js";
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
      filter_terms: searchTermsParam
        .describe('Terms that must appear in the full text, e.g. ["guide RNA", "Cas9"]'),
      match_mode: z
        .enum(["any", "all"])
        .default("any")
        .describe('"any" keeps a patent if any term appears (default); "all" requires every term.'),
      section_filter: z
        .array(z.enum(["claims", "description"]))
        .min(1)
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

      // Fetch a wider window than we will scan. OPS returns newest publications first,
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

      // Stable partition: keep OPS order inside each group.
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
      let checked = 0;
      let fullyChecked = 0;
      let incompleteCount = 0;
      let retrievalFailed = false;
      let remainingDocuments: string[] = [];
      const unknown: Record<string, unknown>[] = [];
      const nonMatches: Record<string, unknown>[] = [];
      let truncated = false;
      let rateLimitError: OpsApiError | undefined;
      let interruptedDocument: string | undefined;

      for (const item of candidates) {
        if (client.timeRemaining < RESERVE_MS) {
          truncated = true;
          break;
        }
        scanned++;
        const doc = item.publicationNumber;

        const retrieval = await retrieveTextSections(client, doc, "epodoc",
          section_filter ?? ["claims", "description"], fallback_to_family, RESERVE_MS);
        const allParagraphs = retrieval.paragraphs;
        if (allParagraphs.length) checked++;
        if (retrieval.complete) fullyChecked++;
        else incompleteCount++;
        if (retrieval.stopped) {
          truncated = true;
          interruptedDocument = doc;
          remainingDocuments = candidates.slice(scanned - 1).map(item => item.publicationNumber);
          rateLimitError = retrieval.interruption;
          retrievalFailed = retrieval.retrievalError !== undefined;
        }
        const evidence = {
          publicationNumber: doc, title: item.title,
          sectionStatus: retrieval.sectionStatus,
          resolvedDocuments: retrieval.resolvedDocuments,
          textLanguage: retrieval.textLanguage,
          ...(retrieval.substituted && {
            note: `Results cover family text: ${Object.entries(retrieval.resolvedDocuments).map(([section, source]) => `${section} from ${source}`).join(", ")}. They do not establish the requested publication's claim scope or the absence of terms in it.`,
          }),
        };

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

        if (!keep) {
          if (retrieval.complete) nonMatches.push(evidence);
          else unknown.push(evidence);
          if (!allParagraphs.length && !retrieval.stopped) skipped.push({
            publicationNumber: doc, title: item.title,
            reason: "No readable text was available; contents are unknown. See unknown[].sectionStatus.",
          });
          if (retrieval.stopped) break;
          continue;
        }

        const claimsCount = retrieval.claimsCount;
        const entry: Record<string, unknown> = {
          ...evidence,
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
        if (!retrieval.complete) entry.partial = true;
        matched.push(entry);
        if (retrieval.stopped) break;
      }
      if (truncated && !remainingDocuments.length) {
        remainingDocuments = candidates.slice(scanned).map(item => item.publicationNumber);
      }

      const notes: string[] = [];
      if (truncated) {
        notes.push(
          `Stopped after ${scanned} of ${candidates.length} patents because retrieval stopped or the tool time budget ran out. Re-run with a narrower query or a smaller max_patents_to_scan. Follow any retryAfterSeconds before resuming.`
        );
      }
      if (totalCount > candidates.length) {
        notes.push(
          `The CQL query matched ${totalCount} publications; ${scanned} retrievals were attempted and ${checked} documents had text checked. Publications beyond those attempts were not examined.`
        );
      }
      if (deprioritised) {
        notes.push(
          `${unlikely.length} result(s) from CN/JP/KR or other offices whose full text OPS rarely indexes were ranked below the ones checked. They may still be relevant — retrieve them with search_patents if needed.`
        );
      }
      if (skipped.length > 0) {
        notes.push(
          `${skipped.length} patent(s) had no readable text and were not checked — see "skipped" and "unknown". Their contents are unknown, not absent.`
        );
      }

      const response = jsonResult(
        {
          query: cql,
          totalCount,
          scanned,
          checked,
          fullyChecked,
          unknownCount: unknown.length,
          unknown,
          noMatchCount: nonMatches.length,
          nonMatches,
          unattemptedCount: candidates.length - scanned,
          unexaminedCount: Math.max(0, totalCount - scanned),
          truncated,
          ...((truncated || incompleteCount > 0) && { partial: true }),
          ...(remainingDocuments.length > 0 && {
            remainingDocuments,
            resumeHint: "Use search_in_patent_text on remainingDocuments with the same terms and sections. Rerunning this filter starts over.",
          }),
          ...(rateLimitError && {
            partial: true,
            ...interruptionMetadata(rateLimitError),
            interruptedDocument,
          }),
          matchMode: match_mode,
          sectionsRequested: section_filter ?? ["claims", "description"],
          filterTerms: filter_terms,
          matchedCount: matched.length,
          matched,
          skipped,
          ...(notes.length > 0 ? { notes } : {}),
          hint: `${matched.length} publications matched the retrieved text; ${nonMatches.length} had no keyword match across all requested sections. ${unknown.length} attempted publications remain unknown, and ${candidates.length - scanned} selected candidates were not attempted. Missing or failed text does not establish absence. See sectionStatus and resolvedDocuments for coverage and source publications.`,
        },
        { grounding: true }
      );
      return rateLimitError || retrievalFailed ? { ...response, isError: true } : response;
    } catch (e) {
      return errorResult(e);
    }
  }
);
}
