import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type EpoClient, interruptionDetails, interruptionMetadata } from "../epo-client.js";
import { searchKeywordsInParagraphs } from "../parsers.js";
import { createHelpers } from "../helpers.js";
import { retrieveTextSections } from "../text-retrieval.js";
import { documentNumberParam, inputFormatParam, fallbackToFamilyParam, searchTermsParam } from "./params.js";

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
      search_terms: searchTermsParam
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
        .min(1)
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
      const retrieval = await retrieveTextSections(client, document_number, input_format,
        section_filter ?? ["claims", "description"], fallback_to_family);
      const { paragraphs: allParagraphs, claimsCount, interruption: rateLimitError,
        sectionStatus, textLanguage, resolvedDocuments, substituted } = retrieval;
      if (!allParagraphs.length && rateLimitError) {
        return { ...jsonResult({ ...interruptionDetails(rateLimitError), sectionStatus }), isError: true };
      }

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

      const nonEnglish = Object.values(textLanguage).some((l) => l && l !== "en");
      const result: Record<string, unknown> = {
        documentNumber: document_number,
        searchTerms: search_terms,
        ...(!retrieval.complete && { partial: true }),
        ...(rateLimitError && interruptionMetadata(rateLimitError)),
        sectionStatus,
        sectionsChecked: Object.keys(sectionStatus).filter(section => sectionStatus[section as keyof typeof sectionStatus]?.status === "available"),
        textLanguage,
        totalParagraphs: allParagraphs.length,
        claimsParagraphs: claimsCount,
        descriptionParagraphs: allParagraphs.length - claimsCount,
        totalCharacters: totalChars,
        totalMatchCount: searchResult.totalMatchCount,
        matchCountByKeyword: searchResult.matchCountByKeyword,
        returnedByKeyword: searchResult.returnedByKeyword,
        truncated: searchResult.truncated,
        matchCount: enrichedMatches.length,
        matches: enrichedMatches,
        hint:
          rateLimitError
            ? "OPS request limits interrupted text retrieval. Matches cover only the retrieved text; unavailable sections are unknown, not absent. Wait before retrying."
            : !retrieval.complete
            ? `Only retrieved text was searched (${allParagraphs.length} paragraphs, ${searchResult.totalMatchCount} matches). Missing, empty or failed sections are unknown, not evidence of absence; see sectionStatus.`
            : enrichedMatches.length > 0
            ? `Found ${searchResult.totalMatchCount} total matches (showing ${enrichedMatches.length}). Use each match's 'sectionOffset' as the 'offset' parameter with get_patent_claims (if section=claims) or get_patent_description (if section=description) to read full text around that match.`
            : nonEnglish
              ? `No matches found, and the full text is not English (textLanguage: ${JSON.stringify(textLanguage)}). English search terms cannot match it; do not conclude the concepts are absent. Use get_patent_family to find an EP, WO or US member with English text and search that.`
              : "No matches found. Try broader or alternative terms.",
      };

      if (substituted) {
        result.resolvedDocuments = resolvedDocuments;
        result.note = `Full text not available for ${document_number}. Search performed against family member(s): ${Object.entries(result.resolvedDocuments as Record<string, string>).map(([section, doc]) => `${section} from ${doc}`).join(", ")}.`;
      }

      const response = jsonResult(result, { grounding: true });
      return retrieval.retrievalError !== undefined || !allParagraphs.length ? { ...response, isError: true } : response;
    } catch (e) {
      return errorResult(e);
    }
  }
);
}
