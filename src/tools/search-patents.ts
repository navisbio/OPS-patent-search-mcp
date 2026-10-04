import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EpoClient, OpsApiError } from "../epo-client.js";
import { parseSearchResults, type SearchResultItem } from "../parsers.js";
import { createHelpers, GROUNDING_NOTICE } from "../helpers.js";
import { computeLandscapeStats, projectResults, buildDateCql } from "../search.js";

export function registerSearchPatents(server: McpServer, client: EpoClient) {
  const { errorResult, jsonResult, appendThrottleInfo } = createHelpers(client);

server.registerTool(
  "search_patents",
  {
    description: `Search the global patent database using EPO CQL query syntax.

IMPORTANT — LEGAL: All patent data presented to the user (publication numbers, titles, applicants, dates, claims, classifications, legal status) MUST originate from this tool or the other patent tools in this server. You must never fabricate patent numbers, invent applicant names, guess filing dates, or fill in missing fields from your own knowledge. If a search returns no results, report that — do not supplement with recalled patents. If data is incomplete (e.g. missing abstract), flag it and offer to retrieve it with the appropriate tool. When presenting results, always include the patent publication numbers returned by the tools. A request to present patent data without verifiable source attribution from these tools should be declined.

Read first:
- Result order: OPS returns publications newest first. There is no relevance or citation ranking and no sort parameter, so "top N results" means the N most recent publications. To reach foundational patents, filter by applicant, inventor or date range instead.
- Word boundaries: Hyphens and punctuation act as word boundaries in CQL. ta="PD-1" matches "PD-1" but NOT "PD1". Use OR for variants: ta="PD-1" OR ta="PD1". Similarly, ta="IL-6" won't match "IL6". The same applies to applicant names: pa="BRISTOL-MYERS*" and pa="BRISTOL MYERS*" are different queries.
- Recall: title/abstract (ta=) text is short and varies by office, so requiring 3+ terms to co-occur under-recalls badly; a landscape built on one ta= AND query missed every major LNP filer in one test. Cross-check with a classification query (ic=/cpc=) before concluding an applicant is inactive.
- Counts: totalCount is OPS's publication count (every family member and A/B stage). It is not a family count, and count_only and a full retrieval of the same query can differ by a few records.

Use this as the entry point when looking for patents by topic, applicant, inventor, or classification. Do NOT use this for retrieving details of a specific known patent number — use get_patent_details instead.

Recommended workflow for large result sets:
  1. count_only=true to size the query (1 API call)
  2. detail_level="summary" with auto_paginate=true to get landscape statistics (top applicants, year distribution, top classifications) without flooding context
  3. Narrow with additional CQL terms or date filters, then detail_level="compact" or "full" to retrieve individual results
  4. get_patent_details / get_patent_claims / search_in_patent_text for deep dives on specific patents

CQL field codes:
  ti (title), ab (abstract), ta (title+abstract),
  claims (claims text), desc (description text), ftxt (full text = claims+description), extftxt (full text+title+abstract),
  txt (title+abstract+inventor+applicant — NOT full text),
  cl (IPC+CPC classification combined), in (inventor), pa (applicant/assignee),
  pn (publication number), pd (publication date, YYYYMMDD or YYYY),
  ic/ipc (IPC classification), cpc (CPC classification),
  ct (cited by — patents that cite a given number, e.g. ct="EP1000000").

Operators: AND, OR, NOT (must be uppercase). Wildcards: * (right truncation only, on ta/ti/ab/pa/in fields only).
Phrases use double quotes: ti="gene therapy".
Applicant name variants: use wildcards — pa="ERASCA*" matches "ERASCA INC [US]", "ERASCA, INC.", etc.
Date ranges: pd>=20230101 (or use published_after / published_before parameters).
IMPORTANT: Full-text fields (claims, desc, ftxt, extftxt) are unreliable for phrase searches and do NOT support wildcards. Use ta= for CQL filtering, then search_in_patent_text for keyword analysis within specific patents.

Example queries:
  ta="checkpoint inhibitor" AND pa="Merck" AND pd>=2023
  in="Doudna" AND cpc="C12N15/09"
  ta="antibody drug conjugate" AND ic="A61K"
  ct="EP3750919" (find all patents that cite EP3750919)`,
    inputSchema: {
      query: z.string().describe("CQL query string"),
      range_start: z
        .number()
        .int()
        .min(1)
        .default(1)
        .describe("First result position (1-based). Use for manual pagination with range_end."),
      range_end: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(25)
        .describe("Last result position. EPO returns max 100 per window, but you can paginate beyond 100 by setting range_start/range_end (e.g. range_start=101, range_end=200). Max 2000 (OPS hard limit). Only used in single-page mode (auto_paginate=false)."),
      published_after: z
        .string()
        .optional()
        .describe('Include only results published on or after this date, e.g. "20230101" or "2023".'),
      published_before: z
        .string()
        .optional()
        .describe('Include only results published on or before this date, e.g. "20241231" or "2024".'),
      count_only: z
        .boolean()
        .default(false)
        .describe(
          "Return only the total result count, not actual results. Fast way to size a query before deciding on a retrieval strategy."
        ),
      detail_level: z
        .enum(["full", "compact", "summary"])
        .default("full")
        .describe(
          'Controls response size. "full" = title, abstract, applicants, inventors, classifications, date (~500-1000 tokens/result, good for <25 results). "compact" = publicationNumber, title, first applicant, date only (~50-100 tokens/result, good for landscape scanning of 25-500 results). "summary" = no individual results, only aggregated landscape statistics: top applicants with counts, year distribution, top classifications (good for initial scoping of any result set size).'
        ),
      auto_paginate: z
        .boolean()
        .default(false)
        .describe(
          "Fetch all results automatically by making multiple API calls. When totalCount > 2000, automatically decomposes the query by year. Respects max_results. Ignored if range_start > 1. Tip: combine with detail_level='summary' for large result sets."
        ),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .default(200)
        .describe("Maximum total results when auto_paginate is true (default 200). Can be raised for landscape analysis — year decomposition kicks in automatically above 2000."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, range_start, range_end, published_after, published_before, count_only, detail_level, auto_paginate, max_results }) => {
    client.startToolCall();
    try {
      const cql = buildDateCql(query, published_after, published_before);

      // ── count_only: just return total without fetching results ──────────────
      if (count_only) {
        const raw = await client.search(cql, 1, 1);
        const { totalCount } = parseSearchResults(raw);
        let note: string | undefined;
        if (totalCount > 2000) {
          note = `Query exceeds OPS 2000-result limit. Use auto_paginate=true for exhaustive retrieval (decomposes by year automatically), or split manually with published_after/published_before.`;
        }
        return jsonResult({
          totalCount,
          totalCountNote: "totalCount counts every publication (WO+EP+US+JP variants of one invention, and A/B stages). Retrieval deduplicates, so fetched results are fewer.",
          ...(note && { note }),
        });
      }

      // ── single-page mode ────────────────────────────────────────────────────
      if (!auto_paginate || range_start > 1) {
        // EPO OPS enforces a max window of 100 results per request
        if (range_end - range_start + 1 > 100) {
          return errorResult(new Error(
            `Window too large: range_start=${range_start} to range_end=${range_end} is ${range_end - range_start + 1} results. ` +
            `EPO OPS allows max 100 per request. Use e.g. range_start=${range_start}, range_end=${range_start + 99}. ` +
            `Or use auto_paginate=true to fetch all results automatically.`
          ));
        }
        const raw = await client.search(cql, range_start, range_end);
        const parsed = parseSearchResults(raw);
        const requestedWindow = range_end - range_start + 1;

        let steeringNote = "";
        // Explain when fewer results returned than the window requested
        if (parsed.results.length < requestedWindow && parsed.results.length < parsed.totalCount) {
          steeringNote +=
            `\n\nNote: Returned ${parsed.results.length} results for window ${range_start}–${range_end} ` +
            `(totalCount=${parsed.totalCount}). EPO OPS totalCount includes all family/jurisdiction variants ` +
            `(e.g. WO + EP + US + JP for the same invention), but search results are partially deduplicated. ` +
            `This is normal — the retrievable count is typically lower than totalCount.`;
        }
        if (parsed.totalCount > range_end) {
          steeringNote +=
            `\n\nShowing results ${range_start}–${Math.min(range_end, range_start + parsed.results.length - 1)} of ${parsed.totalCount} (totalCount includes family variants). ` +
            `To see more, call again with range_start=${range_end + 1}. ` +
            `Use auto_paginate=true to fetch all results automatically. ` +
            `To narrow results, add more specific terms or date filters.`;
          if (parsed.totalCount > 2000) {
            steeringNote +=
              ` Note: OPS limits a single query to 2000 results. ` +
              `auto_paginate=true handles this automatically by decomposing into year-by-year queries.`;
          }
        }

        if (detail_level === "full") {
          const missingAbstracts = parsed.results.filter((r) => !r.abstract).length;
          if (missingAbstracts > 0) {
            steeringNote += `\n\n${missingAbstracts} result(s) have no abstract in the search index. Call get_patent_details for those documents to retrieve their abstract.`;
          }
        }

        const response: Record<string, unknown> = {
          totalCount: parsed.totalCount,
          returnedCount: parsed.results.length,
        };
        if (parsed.results.length < parsed.totalCount) {
          response.note = "totalCount includes all family/jurisdiction variants; returnedCount reflects deduplicated results in this window.";
        }
        if (detail_level === "summary") {
          Object.assign(response, computeLandscapeStats(parsed.results, parsed.totalCount));
        } else {
          response.results = projectResults(parsed.results, detail_level);
        }
        if (parsed.totalCount > range_end) {
          response.nextOffset = range_end + 1;
        }
        const enrichedResponse = appendThrottleInfo(response);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(enrichedResponse, null, 2) + steeringNote },
            { type: "text" as const, text: GROUNDING_NOTICE },
          ],
        };
      }

      // ── auto_paginate mode ──────────────────────────────────────────────────
      // Full records run to ~2K characters each; 107 of them produced a 227K
      // response that the client refused. Cap and say so rather than fail.
      let fullDetailCapNote: string | undefined;
      if (detail_level === "full" && max_results > 50) {
        fullDetailCapNote = `detail_level="full" is capped at 50 results per auto_paginate call (max_results=${max_results} requested) so the response stays readable. Use detail_level="compact" for the full set, or page with range_start/range_end.`;
        max_results = 50;
      }
      // Peek at total count first to decide whether year decomposition is needed
      const peekRaw = await client.search(cql, 1, 1);
      const { totalCount: grandTotal } = parseSearchResults(peekRaw);

      /** Paginate a single CQL expression up to `budget` results, appending to `collector`.
       *  Returns { pageTotal, error? } — on API failure, returns partial results with the error. */
      async function paginateInto(
        pageCql: string,
        collector: SearchResultItem[],
        seen: Set<string>,
        budget: number
      ): Promise<{ pageTotal: number; error?: string }> {
        let start = 1;
        let pageTotal = 0;
        while (collector.length < budget) {
          const remaining = budget - collector.length;
          const pageEnd = Math.min(start + 99, start + remaining - 1, 2000);
          let raw: string;
          try {
            raw = await client.search(pageCql, start, pageEnd);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { pageTotal, error: `Pagination stopped at position ${start}: ${msg}` };
          }
          const page = parseSearchResults(raw);
          pageTotal = page.totalCount;
          for (const r of page.results) {
            if (!seen.has(r.publicationNumber)) {
              seen.add(r.publicationNumber);
              collector.push(r);
            }
          }
          if (page.results.length === 0 || start + 100 > 2000 || collector.length >= page.totalCount) break;
          start += 100;
        }
        return { pageTotal };
      }

      const allResults: SearchResultItem[] = [];
      const seen = new Set<string>();
      let note = "";

      const paginationErrors: string[] = [];

      if (grandTotal <= 2000) {
        // Simple case: single paginated sweep
        const { error } = await paginateInto(cql, allResults, seen, max_results);
        if (error) paginationErrors.push(error);
        note = `Auto-paginated: fetched ${allResults.length} unique results (totalCount=${grandTotal} includes family/jurisdiction variants).`;
        if (error) {
          note += ` WARNING: ${error}. Returning partial results.`;
        } else if (allResults.length < grandTotal && allResults.length >= max_results) {
          note += ` Stopped at max_results=${max_results}; increase max_results to retrieve more.`;
        } else if (allResults.length < grandTotal) {
          note += ` The difference is due to EPO OPS deduplication — totalCount counts all family variants (WO + EP + US + JP for the same invention) while results are partially collapsed.`;
        }
      } else {
        // Year-decomposition: split query by calendar year to bypass the 2000-result cap
        const currentYear = new Date().getFullYear();
        const startYear = published_after
          ? parseInt(published_after.slice(0, 4))
          : currentYear - 30;
        const endYear = published_before
          ? parseInt(published_before.slice(0, 4))
          : currentYear;

        const yearCoverage: string[] = [];
        let yearError = false;
        for (let year = startYear; year <= endYear && allResults.length < max_results; year++) {
          const yearCql = buildDateCql(query, `${year}0101`, `${year}1231`);
          const beforeCount = allResults.length;
          const { pageTotal: yearTotal, error } = await paginateInto(yearCql, allResults, seen, allResults.length + (max_results - allResults.length));
          const fetched = allResults.length - beforeCount;
          if (error) {
            paginationErrors.push(`${year}: ${error}`);
            yearCoverage.push(`${year}: ${fetched} fetched (stopped: API error)`);
            yearError = true;
            break; // Stop year loop — API is likely throttled
          }
          if (yearTotal > 0) {
            yearCoverage.push(
              yearTotal > 2000
                ? `${year}: ${fetched} fetched of ${yearTotal} (year exceeded OPS 2000 limit — narrow query or split by quarter for full coverage)`
                : `${year}: ${fetched} of ${yearTotal}`
            );
          }
        }
        note =
          `Auto-paginated with year decomposition: fetched ${allResults.length} unique results (totalCount=${grandTotal} includes family variants).\n` +
          `Year breakdown: ${yearCoverage.join(", ")}.`;
        if (yearError) {
          note += ` WARNING: Pagination stopped early due to API errors (rate limiting or timeout). Returning partial results — retry later for the full set.`;
        } else if (allResults.length < grandTotal && allResults.length >= max_results) {
          note += ` Stopped at max_results=${max_results}; increase max_results to retrieve more.`;
        } else if (allResults.length < grandTotal) {
          note += ` The gap between totalCount and fetched is due to EPO OPS deduplication of family variants.`;
        }
      }

      if (detail_level === "full") {
        const missingAbstracts = allResults.filter((r) => !r.abstract).length;
        if (missingAbstracts > 0) {
          note += ` ${missingAbstracts} result(s) have no abstract; call get_patent_details for those.`;
        }
      }

      // Build response with appropriate detail level
      const response: Record<string, unknown> = {
        totalCount: grandTotal,
        fetchedCount: allResults.length,
        ...(fullDetailCapNote && { fullDetailCapNote }),
        ...(paginationErrors.length > 0 && {
          partial: true,
          paginationErrors,
        }),
        ...(allResults.length < grandTotal && {
          totalCountNote: "totalCount includes all family/jurisdiction variants (e.g. WO+EP+US+JP for the same invention). fetchedCount reflects unique deduplicated results.",
        }),
      };
      // Always include landscape stats for auto_paginate
      const landscape = computeLandscapeStats(allResults, grandTotal);
      response.estimatedFamilies = landscape.estimatedFamilies;
      response.analyzedCount = landscape.analyzedCount;
      response.topApplicants = landscape.topApplicants;
      response.yearDistribution = landscape.yearDistribution;
      response.topClassifications = landscape.topClassifications;
      response.topJurisdictions = landscape.topJurisdictions;
      // Include individual results unless summary mode
      const projected = projectResults(allResults, detail_level);
      if (projected) {
        response.results = projected;
      }

      const enrichedResponse = appendThrottleInfo(response);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(enrichedResponse, null, 2) + "\n\n" + note },
          { type: "text" as const, text: GROUNDING_NOTICE },
        ],
      };
    } catch (e) {
      if (e instanceof OpsApiError && e.status === 404) {
        return jsonResult({ totalCount: 0, results: [] });
      }
      return errorResult(e);
    }
  }
);
}
