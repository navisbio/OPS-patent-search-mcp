import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EpoClient, OpsApiError } from "../epo-client.js";
import { parseBiblio, type PatentBiblio } from "../parsers.js";
import { createHelpers } from "../helpers.js";

export function registerGetPatentDetails(server: McpServer, client: EpoClient) {
  const { errorResult, jsonResult } = createHelpers(client);

server.registerTool(
  "get_patent_details",
  {
    description: `Retrieve full details for a specific patent: title, abstract, applicants, inventors, IPC/CPC classifications, publication/application dates, and priority claims.

IMPORTANT — LEGAL: Only present data returned by this tool. Never fabricate or guess patent metadata. Always include publication numbers when citing results.

Use this when you already have a publication number and need its details. For searching by topic or applicant, use search_patents instead.

Document number formats:
  epodoc (default): "EP1000000", "US2020001234", "WO2023123456"
  docdb: "EP.1000000.A1" (country.number.kind — more precise)

Response: one record per publication stage of the number, each with kindCode (A1/A2 = application, B1/B2 = grant). A number with an A1 and a B1 publication therefore returns two records with different publicationDate values.

Numbers with a kind suffix, as returned by get_patent_citations and get_patent_family ("US7169874B2"), are accepted and resolved precisely. A number that fails in epodoc format is retried with the common kind codes before it is reported missing.

Batch mode: pass document_numbers (array of up to 100 numbers) to retrieve multiple patents in one call. When using batch mode, document_number is ignored. The batch response is an object: { requested, found, results, notFound }. notFound lists the requested numbers that returned no bibliographic record after all retries, so a missing patent is never silent. Keep batches to about 10 numbers when you need abstracts: 13 full records already exceed the client's 25K-token result limit and get redirected to a file. SPC and certificate numbers (kind I1/I2/C1) have no bibliographic record; look up the basic patent instead.`,
    inputSchema: {
      document_number: z
        .string()
        .default("")
        .describe('Patent publication number, e.g. "EP1000000" or "US2020001234". Ignored when document_numbers is provided.'),
      document_numbers: z
        .array(z.string())
        .max(100)
        .optional()
        .describe('Batch mode: array of patent numbers to retrieve in one call (max 100). More efficient than calling one at a time.'),
      input_format: z
        .enum(["epodoc", "docdb", "original"])
        .default("epodoc")
        .describe('Number format. Use "docdb" (e.g. "EP.1000000.A1") when epodoc returns errors.'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ document_number, document_numbers, input_format }) => {
    client.startToolCall();
    // OPS answers an unknown number with an exchange-document that has no
    // bibliographic content. Returning that as a record made "not found" look
    // like "a patent with no title", which agents then cited.
    const isStub = (b: PatentBiblio) => !b.title && !b.abstract && b.applicants.length === 0 && !b.applicationNumber;
    const dedupe = (records: PatentBiblio[]) => {
      const seen = new Set<string>();
      return records.filter((r) => {
        const key = `${r.publicationNumber}|${r.kindCode ?? ""}|${r.publicationDate ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    };
    // Compare requested and returned numbers without dots, spaces or a kind suffix.
    const baseNumber = (s: string) => s.replace(/[^A-Za-z0-9]/g, "").toUpperCase().replace(/(?<=\d)[A-Z]\d?$/, "");
    // Citation lists and family members carry kind suffixes ("US7169874B2"),
    // which the epodoc endpoint rejects. Route those through docdb instead.
    const normalise = (n: string): { number: string; format: string } => {
      const m = input_format === "epodoc" ? n.trim().match(/^([A-Z]{2})(\d+)([A-Z]\d?)$/) : null;
      return m ? { number: `${m[1]}.${m[2]}.${m[3]}`, format: "docdb" } : { number: n.trim(), format: input_format };
    };
    const fetchOne = async (n: string, fmt: string): Promise<PatentBiblio[]> => {
      try { return parseBiblio(await client.getBiblio(n, fmt)).filter((b) => !isStub(b)); } catch { return []; }
    };
    // Last resort for a number nothing else resolved: docdb with the common kind codes.
    const fetchByKinds = async (n: string): Promise<PatentBiblio[]> => {
      const m = n.match(/^([A-Z]{2})(\d+)$/);
      if (!m) return [];
      for (const kind of ["B2", "B1", "A1", "A2", "A", "B"]) {
        const got = await fetchOne(`${m[1]}.${m[2]}.${kind}`, "docdb");
        if (got.length > 0) return got;
      }
      return [];
    };
    try {
      // Batch mode
      if (document_numbers && document_numbers.length > 0) {
        const allBiblio: PatentBiblio[] = [];
        const entries = document_numbers.map((d) => ({ requested: d, ...normalise(d) }));
        // The multi-number endpoint is unreliable: one unknown number fails the
        // whole request, and pairs of US grants are refused outright. Try it per
        // format in chunks of 20, then recover every missing number individually.
        for (const fmt of [...new Set(entries.map((e) => e.format))]) {
          const nums = entries.filter((e) => e.format === fmt).map((e) => e.number);
          for (let i = 0; i < nums.length; i += 20) {
            const chunk = nums.slice(i, i + 20);
            try {
              allBiblio.push(...parseBiblio(await client.getBiblioMulti(chunk, fmt)).filter((b) => !isStub(b)));
            } catch {
              // recovered per number below
            }
          }
        }
        const have = () => new Set(allBiblio.map((b) => baseNumber(b.publicationNumber)));
        let missing = entries.filter((e) => !have().has(baseNumber(e.requested)));
        for (const e of missing.slice(0, 40)) allBiblio.push(...(await fetchOne(e.number, e.format)));
        missing = entries.filter((e) => !have().has(baseNumber(e.requested)));
        for (const e of missing.slice(0, 15)) {
          if (e.format === "epodoc") allBiblio.push(...(await fetchByKinds(e.number)));
        }
        const results = dedupe(allBiblio);
        const foundKeys = have();
        const notFound = document_numbers.filter((d) => !foundKeys.has(baseNumber(d)));
        return jsonResult({
          requested: document_numbers.length,
          found: document_numbers.length - notFound.length,
          results,
          notFound,
          ...(notFound.length > 0 && {
            note: `${notFound.length} of ${document_numbers.length} numbers returned no bibliographic record in ${input_format} format: ${notFound.join(", ")}. Do not cite them as existing. SPC/certificate numbers (kind I1/I2/C1) and some US grants resolve only with input_format="docdb" and a kind code, e.g. "US.8354509.B2".`,
          }),
        }, { grounding: true });
      }

      // Single mode
      const one = normalise(document_number);
      const raw = await client.getBiblio(one.number, one.format);
      let records = dedupe(parseBiblio(raw).filter((b) => !isStub(b)));
      if (records.length === 0 && one.format === "epodoc") records = dedupe(await fetchByKinds(one.number));
      if (records.length === 0) {
        return jsonResult({
          found: false,
          documentNumber: document_number,
          note: `OPS returned no bibliographic data for ${document_number} in ${input_format} format. Do not cite it as existing. Retry with input_format="docdb" and a kind code (e.g. "${document_number.replace(/^([A-Z]{2})(\d+).*$/, "$1.$2.B2")}"), or verify with search_patents(query='pn="${document_number}"', count_only=true).`,
        }, { grounding: true });
      }
      return jsonResult(records, { grounding: true });
    } catch (e) {
      // On 404 in epodoc mode, retry with docdb format using common kind codes
      if (e instanceof OpsApiError && e.status === 404 && input_format === "epodoc") {
        const m = document_number.match(/^([A-Z]{2})(.+)$/);
        if (m) {
          const [, cc, num] = m;
          for (const kind of ["B2", "B1", "A1", "A2"]) {
            try {
              const raw = await client.getBiblio(`${cc}.${num}.${kind}`, "docdb");
              return jsonResult(parseBiblio(raw), { grounding: true });
            } catch {
              // try next kind code
            }
          }
        }
      }
      return errorResult(e);
    }
  }
);
}
