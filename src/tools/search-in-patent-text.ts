import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EpoClient } from "../epo-client.js";
import { parseFulltextParagraphs, searchKeywordsInParagraphs } from "../parsers.js";
import { createHelpers } from "../helpers.js";
import { fetchWithFamilyFallback } from "../fallback.js";
import { documentNumberParam, inputFormatParam, fallbackToFamilyParam } from "./params.js";

export function registerSearchInPatentText(server: McpServer, client: EpoClient) {
  const { errorResult, jsonResult } = createHelpers(client);

server.registerTool(
  "search_in_patent_text",
  {
    description: `Search for keywords within the full text of a patent (claims + description). Returns matching snippets with surrounding context and paragraph indexes.

IMPORTANT — LEGAL: Only present matches returned by this tool. If matchCount is 0, report that — do not invent matches.

This is the recommended first step before reading full patent text. It tells you exactly where relevant content is, so you can then use get_patent_claims or get_patent_description with the right offset to read in detail.

Returns: keyword matches with context snippets, section (claims/description), and sectionOffset you can pass as offset to get_patent_claims (for section=claims) or get_patent_description (for section=description).

When fallback_to_family is true (default), a 404 will automatically try EP/WO family members — useful for US patents whose full text is not indexed in OPS.

Full text is available primarily for EP, WO, and US patents.`,
    inputSchema: {
      document_number: documentNumberParam,
      search_terms: z
        .array(z.string())
        .min(1)
        .describe('Keywords to search for, e.g. ["kinase", "inhibitor", "pharmaceutical"]'),
      input_format: inputFormatParam,
      context_chars: z
        .number()
        .int()
        .min(20)
        .max(2000)
        .default(150)
        .describe("Characters of context to show around each match (default 150). Increase to 500-2000 to get more surrounding text — may eliminate the need to call get_patent_description."),
      limit: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(30)
        .describe("Max matches to return (default 30). The window is shared fairly across search_terms (round-robin), so a frequent term cannot hide a rare one; matchCountByKeyword still reports every occurrence."),
      case_sensitive: z
        .boolean()
        .default(false)
        .describe("Case-sensitive matching (default false)"),
      section_filter: z
        .array(z.enum(["claims", "description"]))
        .optional()
        .describe('Restrict search to specific sections, e.g. ["claims"]. Omit to search both.'),
      fallback_to_family: fallbackToFamilyParam,
    },
    annotations: { readOnlyHint: true },
  },
  async ({
    document_number,
    search_terms,
    input_format,
    context_chars,
    limit,
    case_sensitive,
    section_filter,
    fallback_to_family,
  }) => {
    client.startToolCall();
    try {
      // Resolve the best available document for fulltext
      let resolvedClaimsDoc = document_number;
      let resolvedDescDoc = document_number;
      let substituted = false;

      // Fetch both claims and description — falling back to family if needed
      let claimsRaw: string | null = null;
      let descRaw: string | null = null;

      if (fallback_to_family) {
        // Try claims with fallback
        try {
          const result = await fetchWithFamilyFallback(client,
            document_number,
            input_format,
            (d, f) => client.getClaims(d, f)
          );
          claimsRaw = result.raw;
          if (result.substituted) {
            resolvedClaimsDoc = result.resolvedDocument;
            substituted = true;
          }
        } catch {
          // claims unavailable
        }

        // Try description — prefer the same resolved document if claims already substituted
        const descDoc = substituted ? resolvedClaimsDoc : document_number;
        const descFmt = substituted ? "docdb" : input_format;
        try {
          const result = await fetchWithFamilyFallback(client,
            descDoc,
            descFmt,
            (d, f) => client.getDescription(d, f)
          );
          descRaw = result.raw;
          if (result.substituted) {
            resolvedDescDoc = result.resolvedDocument;
            substituted = true;
          }
        } catch {
          // description unavailable
        }
      } else {
        claimsRaw = await client.getClaims(document_number, input_format).catch(() => null);
        descRaw = await client.getDescription(document_number, input_format).catch(() => null);
      }

      if (!claimsRaw && !descRaw) {
        return {
          content: [{
            type: "text" as const,
            text: `No full text available for ${document_number}. Full text is only available for EP, WO, US and some other offices. Try docdb format with a kind code (e.g. "EP.1000000.A1"), or enable fallback_to_family to search a family equivalent automatically.`,
          }],
          isError: true,
        };
      }

      const claimsParagraphs = claimsRaw ? parseFulltextParagraphs(claimsRaw) : [];
      const descParagraphs = descRaw ? parseFulltextParagraphs(descRaw) : [];
      const claimsCount = claimsParagraphs.length;
      const allParagraphs = [...claimsParagraphs, ...descParagraphs];

      let idx = 0;
      for (const p of allParagraphs) p.index = idx++;

      const searchResult = searchKeywordsInParagraphs(allParagraphs, search_terms, {
        contextChars: context_chars,
        limit,
        caseSensitive: case_sensitive,
        sectionFilter: section_filter,
      });

      // Add sectionOffset to each match — this is the offset to use with get_patent_claims or get_patent_description
      const enrichedMatches = searchResult.matches.map((m) => ({
        ...m,
        sectionOffset: m.section === "claims" ? m.paragraphIndex : m.paragraphIndex - claimsCount,
      }));

      const totalChars =
        allParagraphs.length > 0 ? allParagraphs[allParagraphs.length - 1].endChar : 0;

      const result: Record<string, unknown> = {
        documentNumber: document_number,
        searchTerms: search_terms,
        totalParagraphs: allParagraphs.length,
        claimsParagraphs: claimsCount,
        descriptionParagraphs: descParagraphs.length,
        totalCharacters: totalChars,
        totalMatchCount: searchResult.totalMatchCount,
        matchCountByKeyword: searchResult.matchCountByKeyword,
        returnedByKeyword: searchResult.returnedByKeyword,
        truncated: searchResult.truncated,
        matchCount: enrichedMatches.length,
        matches: enrichedMatches,
        hint:
          enrichedMatches.length > 0
            ? `Found ${searchResult.totalMatchCount} total matches (showing ${enrichedMatches.length}). Use each match's 'sectionOffset' as the 'offset' parameter with get_patent_claims (if section=claims) or get_patent_description (if section=description) to read full text around that match.`
            : "No matches found. Try broader or alternative terms.",
      };

      if (substituted) {
        result.note = `Full text not available for ${document_number}. Search performed against family member(s): claims from ${resolvedClaimsDoc}, description from ${resolvedDescDoc}.`;
        result.resolvedDocuments = { claims: resolvedClaimsDoc, description: resolvedDescDoc };
      }

      return jsonResult(result, { grounding: true });
    } catch (e) {
      return errorResult(e);
    }
  }
);
}
