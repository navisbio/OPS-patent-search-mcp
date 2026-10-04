import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { EpoClient } from "../epo-client.js";
import { parseCitations } from "../parsers.js";
import { createHelpers } from "../helpers.js";
import { documentNumberParam, inputFormatParam } from "./params.js";

export function registerGetPatentCitations(server: McpServer, client: EpoClient) {
  const { errorResult, jsonResult } = createHelpers(client);

server.registerTool(
  "get_patent_citations",
  {
    description: `Get the list of documents cited within a patent (backward citations / prior art references).

IMPORTANT — LEGAL: Only list citations returned by this tool. Never fabricate citation relationships.

Returns patent citations (with publication numbers) and non-patent literature citations (NPL, e.g. journal articles). Each citation carries citedBy ("examiner" or "applicant"). Only examiner citations from the search report carry a category letter; applicant-cited references (the majority for EP applications) have none:
  X = particularly relevant (alone anticipates the invention)
  Y = relevant in combination with other documents
  A = general technological background
  D = cited in the application itself
  E = earlier document published on/after filing date
  P = intermediate document (published between priority and filing)
  L = cited for other reasons

To find forward citations — patents that cite a given document — use search_patents with the CQL query: ct="EP1000000" (replace with the target document number).`,
    inputSchema: {
      document_number: documentNumberParam,
      input_format: inputFormatParam,
      max_citations: z
        .number()
        .int()
        .positive()
        .max(2000)
        .default(200)
        .describe("Maximum number of citations to return per type (patent, NPL) in this call. Around 400 patent citations fit in one response; beyond that the client redirects the result to a file. Page with citations_offset instead of raising this."),
      citations_offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Skip this many citations of each type before returning max_citations of them. Use with truncated=true to page through long citation lists."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ document_number, input_format, max_citations, citations_offset }) => {
    client.startToolCall();
    try {
      const raw = await client.getBiblio(document_number, input_format);
      const citations = parseCitations(raw);
      const allPatent = citations.filter((c) => c.type === "patent");
      const allNpl = citations.filter((c) => c.type === "npl");
      const patentCitations = allPatent.slice(citations_offset, citations_offset + max_citations);
      const nplCitations = allNpl.slice(citations_offset, citations_offset + max_citations);
      const truncated = allPatent.length > citations_offset + max_citations || allNpl.length > citations_offset + max_citations;
      return jsonResult({
        documentNumber: document_number,
        totalCitations: citations.length,
        patentCitationCount: allPatent.length,
        nplCitationCount: allNpl.length,
        returnedPatentCitations: patentCitations.length,
        returnedNplCitations: nplCitations.length,
        truncated,
        patentCitations,
        nplCitations,
        ...(citations_offset > 0 && { citationsOffset: citations_offset }),
        ...(truncated && { note: `Truncated: showing ${patentCitations.length} of ${allPatent.length} patent and ${nplCitations.length} of ${allNpl.length} NPL citations. Call again with citations_offset=${citations_offset + max_citations} for the next page.` }),
        hint: `To find patents that CITE ${document_number} (forward citations), use search_patents with query: ct="${document_number}"`,
      }, { grounding: true });
    } catch (e) {
      return errorResult(e);
    }
  }
);
}
