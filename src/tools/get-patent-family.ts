import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { EpoClient, OpsApiError } from "../epo-client.js";
import { parseFamilyMembers, type FamilyMember } from "../parsers.js";
import { createHelpers } from "../helpers.js";
import { getFamilyWithFormatFallback } from "../fallback.js";
import { documentNumberParam, inputFormatParam } from "./params.js";

export function registerGetPatentFamily(server: McpServer, client: EpoClient) {
  const { errorResult, jsonResult } = createHelpers(client);

server.registerTool(
  "get_patent_family",
  {
    description: `Get all members of the INPADOC patent family for a document — i.e. all related publications across jurisdictions (EP, US, WO, JP, CN, etc.).

IMPORTANT — LEGAL: Only list family members returned by this tool. Never guess at family members or jurisdictions.

Use this to find equivalent patents filed in other countries, or to see the full publication history (A1, A2, B1 kind codes) of an invention.

Response: { familySize, countByCountry, returned, members[] }. countByCountry always covers the whole family. Prolific filers have families of 300-700 members, so members are capped by max_members (default 150); use the countries filter (e.g. ["EP","US","WO"]) to see the members you need without raising the cap.`,
    inputSchema: {
      document_number: documentNumberParam,
      input_format: inputFormatParam,
      countries: z
        .array(z.string())
        .optional()
        .describe('Return only members from these offices, e.g. ["EP", "US", "WO"]. countByCountry is still computed over the whole family.'),
      max_members: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(150)
        .describe("Cap on members returned after the countries filter (default 150)."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ document_number, input_format, countries, max_members }) => {
    client.startToolCall();
    const shape = (members: FamilyMember[], resolvedAs: string, extraNote?: string) => {
      const counts = new Map<string, number>();
      for (const m of members) counts.set(m.country || "??", (counts.get(m.country || "??") ?? 0) + 1);
      const countByCountry = Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1]));
      const wanted = countries && countries.length > 0 ? new Set(countries.map((c) => c.toUpperCase())) : null;
      const filtered = wanted ? members.filter((m) => wanted.has((m.country || "").toUpperCase())) : members;
      const shown = filtered.slice(0, max_members);
      const notes: string[] = [];
      if (resolvedAs !== document_number) notes.push(`Resolved ${document_number} as ${resolvedAs} (docdb format); the family endpoint did not accept the epodoc form.`);
      if (wanted) notes.push(`Filtered to ${filtered.length} member(s) in ${[...wanted].join(", ")}.`);
      if (shown.length < filtered.length) notes.push(`Showing ${shown.length} of ${filtered.length} members. Raise max_members or narrow with countries to see the rest.`);
      if (extraNote) notes.push(extraNote);
      return jsonResult({
        documentNumber: document_number,
        familySize: members.length,
        countByCountry,
        returned: shown.length,
        members: shown,
        ...(notes.length > 0 && { note: notes.join(" ") }),
      }, { grounding: true });
    };
    try {
      const { raw, resolvedAs } = await getFamilyWithFormatFallback(client, document_number, input_format);
      return shape(parseFamilyMembers(raw), resolvedAs);
    } catch (e) {
      // Handle "smaller chunks" error for very large patent families — retry without biblio
      if (e instanceof OpsApiError && e.message.includes("smaller chunks")) {
        try {
          const { raw, resolvedAs } = await getFamilyWithFormatFallback(client, document_number, input_format, true);
          return shape(parseFamilyMembers(raw), resolvedAs, "Large family retrieved without biblio data; titles may be missing. Use get_patent_details on individual members.");
        } catch {
          return jsonResult({
            error: "family_too_large",
            documentNumber: document_number,
            note: `This patent has a very large INPADOC family that exceeds the OPS API response limit. Try requesting a specific family member instead (e.g., the WO or EP publication). You can find the WO publication number by searching: search_patents(query='pn="${document_number}"') or checking get_patent_details for priority claims.`,
          });
        }
      }
      return errorResult(e);
    }
  }
);
}
