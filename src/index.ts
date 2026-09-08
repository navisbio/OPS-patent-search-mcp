#!/usr/bin/env node
/**
 * Patent Search MCP Server v0.3.0
 *
 * Patent search and retrieval via EPO Open Patent Services (OPS) API.
 * Designed for agentic use: keyword search + paginated reading prevent
 * dumping large patent texts into context.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { EpoClient, OpsApiError, type ThrottleStatus } from "./epo-client.js";
import {
  parseSearchResults,
  parseBiblio,
  parseFulltextParagraphs,
  paginateParagraphs,
  searchKeywordsInParagraphs,
  parseFamilyMembers,
  parseLegalEvents,
  parseCitations,
  type LegalEvent,
} from "./parsers.js";

/* ---------- env ---------- */

const CONSUMER_KEY = process.env.PATENT_CONSUMER_KEY;
const CONSUMER_SECRET = process.env.PATENT_CONSUMER_SECRET_KEY;

if (!CONSUMER_KEY || !CONSUMER_SECRET) {
  console.error(
    "Missing PATENT_CONSUMER_KEY or PATENT_CONSUMER_SECRET_KEY environment variables"
  );
  process.exit(1);
}

const client = new EpoClient(CONSUMER_KEY, CONSUMER_SECRET);

/* ---------- helpers ---------- */

function errorResult(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const throttle = client.lastThrottle;
  const parts = [`Error: ${msg}`];
  if (throttle?.isThrottled) {
    parts.push(
      `\nRate limit status: ${throttle.overallStatus}. ` +
      Object.entries(throttle.services)
        .filter(([, s]) => s.color !== "green")
        .map(([name, s]) => `${name}=${s.color}:${s.remaining}`)
        .join(", ") +
      `. Wait 1-2 minutes before retrying.`
    );
  }
  return {
    content: [{ type: "text" as const, text: parts.join("") }],
    isError: true,
  };
}

const GROUNDING_NOTICE =
  "GROUNDING: Only patent numbers, dates, names, and text that appear in this response may be cited in your output. Never supplement with patent numbers from your own knowledge. When quoting patent claims or description passages, use the exact text returned here — do not paraphrase from memory.";

function jsonResult(data: unknown, { grounding = false }: { grounding?: boolean } = {}) {
  // Inject throttle status into response data when available
  const enriched = appendThrottleInfo(data);
  const content: { type: "text"; text: string }[] = [
    { type: "text" as const, text: JSON.stringify(enriched, null, 2) },
  ];
  if (grounding) {
    content.push({ type: "text" as const, text: GROUNDING_NOTICE });
  }
  return { content };
}

/** Append a compact throttle summary to any response object when rate limits are approaching. */
function appendThrottleInfo(data: unknown): unknown {
  const throttle = client.lastThrottle;
  if (!throttle) return data;

  // Only include throttle info when it's actionable (yellow/orange/red/black)
  // or always include a compact summary so callers can plan
  const quota: Record<string, unknown> = {};
  for (const [service, status] of Object.entries(throttle.services)) {
    quota[service] = { remaining: status.remaining, status: status.color };
  }

  const throttleInfo = {
    overallStatus: throttle.overallStatus,
    isThrottled: throttle.isThrottled,
    quota,
    ...(throttle.isThrottled && {
      warning: "EPO OPS rate limits are approaching. Space out requests or wait 1-2 minutes to avoid timeouts.",
    }),
  };

  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    return { ...data, _throttle: throttleInfo };
  }
  // For array responses, don't wrap — callers expect raw arrays.
  // Throttle info is available via the next object-type response.
  return data;
}

/**
 * Try to fetch fulltext (claims or description) for a document.
 * If the initial fetch returns 404, fetch the patent family and try
 * EP/WO members first (most reliably indexed in OPS), then others.
 * Returns the raw JSON, the document that succeeded, and whether a
 * family substitution was made.
 */
/** Compute alternative kind codes to try for a document number before family fallback. */
function computeKindFallbacks(docNumber: string, inputFormat: string): string[] {
  // Only works for epodoc-style numbers where we can extract country+number
  if (inputFormat === "docdb") {
    // docdb format: CC.number.KK — extract parts and try other kind codes
    const parts = docNumber.split(".");
    if (parts.length === 3) {
      const [cc, num, currentKind] = parts;
      // Only try A1/B1 — covers >90% of cases without excessive API calls
      return ["A1", "B1"]
        .filter((k) => k !== currentKind)
        .map((k) => `${cc}.${num}.${k}`);
    }
    return [];
  }
  // epodoc: e.g. EP1000000 — try docdb format with A1/B1 kind codes
  const m = docNumber.match(/^([A-Z]{2})(.+)$/);
  if (!m) return [];
  const [, cc, num] = m;
  return ["A1", "B1"].map((k) => `${cc}.${num}.${k}`);
}

async function fetchWithFamilyFallback(
  docNumber: string,
  inputFormat: string,
  fetcher: (docNum: string, fmt: string) => Promise<string>
): Promise<{ raw: string; resolvedDocument: string; substituted: boolean }> {
  try {
    const raw = await fetcher(docNumber, inputFormat);
    return { raw, resolvedDocument: docNumber, substituted: false };
  } catch (e) {
    if (!(e instanceof OpsApiError) || e.status !== 404) throw e;
  }

  // 404 — try alternative kind codes for the same patent before family lookup
  const kindFallbacks = computeKindFallbacks(docNumber, inputFormat);
  for (const alt of kindFallbacks) {
    try {
      const raw = await fetcher(alt, "docdb");
      return { raw, resolvedDocument: alt, substituted: true };
    } catch {
      // try next kind code
    }
  }

  // Still 404 — try the patent family
  let familyRaw: string;
  try {
    familyRaw = await client.getFamily(docNumber, inputFormat);
  } catch {
    throw new OpsApiError(
      404,
      `Full text not available for ${docNumber} and could not retrieve patent family for fallback.`
    );
  }

  const members = parseFamilyMembers(familyRaw);
  if (members.length === 0) {
    throw new OpsApiError(
      404,
      `Full text not available for ${docNumber} and no family members found.`
    );
  }

  // Prioritise offices most likely to have full text in OPS
  const priority = ["EP", "WO", "GB", "DE", "FR"];
  const sorted = [...members].sort((a, b) => {
    const ai = priority.indexOf(a.country);
    const bi = priority.indexOf(b.country);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  for (const member of sorted) {
    if (!member.kind || !member.rawNumber) continue;
    // Docdb format expected by OPS: CC.number.KK  e.g. EP.3750919.A1
    const docdbNum = `${member.country}.${member.rawNumber}.${member.kind}`;
    try {
      const raw = await fetcher(docdbNum, "docdb");
      return { raw, resolvedDocument: docdbNum, substituted: true };
    } catch {
      // try next member
    }
  }

  throw new OpsApiError(
    404,
    `Full text not available for ${docNumber} or any of its ${members.length} family member(s). ` +
      `Family includes: ${members
        .slice(0, 8)
        .map((m) => m.publicationNumber)
        .join(", ")}${members.length > 8 ? "…" : ""}.`
  );
}

/* ---------- MCP server ---------- */

const server = new McpServer({
  name: "ops-patent-search",
  version: "0.3.0",
});

/* --- search helpers --- */

type SearchResult = ReturnType<typeof parseSearchResults>["results"][number];

/** Compute aggregated landscape statistics from a set of search results. */
/** IPC subclass labels for the most commonly seen codes in patent landscape analysis. */
const IPC_LABELS: Record<string, string> = {
  // A61K — Preparations for medical/dental/toilet purposes
  A61K31: "Small molecule drugs", A61K38: "Peptide/protein drugs", A61K39: "Antibodies & vaccines",
  A61K45: "Combination therapy", A61K47: "Drug delivery / carriers", A61K48: "Gene therapy",
  A61K9: "Drug formulations",
  // A61P — Therapeutic activity
  A61P1: "Digestive system", A61P3: "Metabolism", A61P5: "Endocrine system",
  A61P7: "Blood / hematology", A61P9: "Cardiovascular", A61P11: "Respiratory",
  A61P13: "Urinary / renal", A61P15: "Reproductive", A61P17: "Dermatology",
  A61P19: "Musculoskeletal", A61P21: "Muscular disorders", A61P25: "Neurology",
  A61P27: "Ophthalmology", A61P29: "Anti-inflammatory", A61P31: "Anti-infectives",
  A61P33: "Anti-parasitic", A61P35: "Oncology", A61P37: "Immunology",
  A61P43: "Drugs for specific purposes (NEC)",
  // C07 — Organic chemistry
  C07D: "Heterocyclic compounds", C07K14: "Peptides (>20 aa)", C07K16: "Monoclonal antibodies",
  C07K7: "Peptides (5-20 aa)", C07H: "Sugars / nucleosides",
  // C12N — Biotechnology
  C12N15: "Genetic engineering / vectors", C12N5: "Cell culture", C12N9: "Enzymes",
  C12Q1: "Biological assays",
  // G01N — Testing / analysis
  G01N33: "Immunoassays / diagnostics",
  // G16B — Bioinformatics
  G16B: "Bioinformatics",
};

/** CJK→Latin lookup for top pharma/biotech companies. Partial CJK string matching. */
const CJK_APPLICANT_MAP: [RegExp, string][] = [
  [/中外製薬|中外制药/, "CHUGAI PHARMACEUTICAL"],
  [/武田薬品|武田药品|タケダ/, "TAKEDA PHARMACEUTICAL"],
  [/第一三共|ダイイチサンキョウ/, "DAIICHI SANKYO"],
  [/アステラス|安斯泰来/, "ASTELLAS PHARMA"],
  [/大塚製薬|大冢制药/, "OTSUKA PHARMACEUTICAL"],
  [/エーザイ|卫材/, "EISAI"],
  [/小野薬品|小野药品/, "ONO PHARMACEUTICAL"],
  [/塩野義|盐野义/, "SHIONOGI"],
  [/三菱田辺|田辺三菱/, "MITSUBISHI TANABE PHARMA"],
  [/住友ファーマ|住友制药|大日本住友/, "SUMITOMO PHARMA"],
  [/参天製薬/, "SANTEN PHARMACEUTICAL"],
  [/協和キリン|协和发酵/, "KYOWA KIRIN"],
  [/東レ|东丽/, "TORAY INDUSTRIES"],
  [/恒瑞医药|恒瑞/, "HENGRUI MEDICINE"],
  [/百济神州/, "BEIGENE"],
  [/信达生物/, "INNOVENT BIOLOGICS"],
  [/君实生物/, "JUNSHI BIOSCIENCES"],
  [/再鼎医药/, "ZAILAB"],
  [/复星医药|復星/, "FOSUN PHARMA"],
  [/药明康德|藥明康德/, "WUXI APPTEC"],
  [/药明生物|藥明生物/, "WUXI BIOLOGICS"],
  [/三星バイオ|삼성바이오/, "SAMSUNG BIOLOGICS"],
  [/セルトリオン|셀트리온/, "CELLTRION"],
  [/한미약품/, "HANMI PHARMACEUTICAL"],
  [/유한양행/, "YUHAN"],
  [/绿叶制药/, "LUYE PHARMA"],
  [/石药集团/, "CSPC PHARMACEUTICAL"],
  [/正大天晴/, "CHIA TAI TIANQING"],
  [/齐鲁制药/, "QILU PHARMACEUTICAL"],
  [/豪森药业|翰森制药/, "HANSOH PHARMA"],
];

/** Normalize an applicant name for grouping. Merges common variants. */
function normalizeApplicantName(raw: string): string {
  let name = raw
    .replace(/\s*\[.*?\]\s*$/, "")  // [US], [JP] etc.
    .toUpperCase()
    .replace(/[.,;:()]+/g, " ")     // all punctuation → space
    .replace(/\s+/g, " ")           // collapse whitespace
    .trim();

  // CJK→Latin lookup: check if name contains known CJK company strings
  if (/[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(name)) {
    for (const [pattern, latin] of CJK_APPLICANT_MAP) {
      if (pattern.test(raw)) {
        return latin;
      }
    }
    // Skip unrecognized CJK-only names (they'll merge with their Latin equivalent via per-result dedup)
    if (/^[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\s]+$/.test(name)) {
      return "";
    }
  }

  // Strip common corporate suffixes
  name = name
    .replace(/\b(THE TRUSTEES OF THE |THE BOARD OF TRUSTEES OF THE |THE REGENTS OF THE |REGENTS OF THE |THE )/g, "")
    .replace(/\b(CORP|CORPORATION|INC|INCORPORATED|LTD|LIMITED|LLC|LLP|GMBH|AG|SA|SAS|BV|BVBA|NV|KK|CO|COMPANY|PLC|PTY|AB|OY|AS|APS|SRL|SPA|SE)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Normalize "UNIV X" / "UNIVERSITY OF X" / "X UNIVERSITY"
  name = name
    .replace(/\bUNIVERSITY OF\b/g, "UNIV")
    .replace(/\bUNIVERSITY\b/g, "UNIV")
    .replace(/\s+/g, " ")
    .trim();

  return name;
}

function computeLandscapeStats(results: SearchResult[], totalCount: number) {
  // Top applicants by frequency — deduplicate per result to avoid double-counting
  // when OPS returns both epodoc and original format for same applicant on same patent
  const applicantCounts = new Map<string, number>();
  for (const r of results) {
    // Deduplicate applicants within this result: normalize all, keep unique
    const seenForResult = new Set<string>();
    for (const a of r.applicants) {
      const name = normalizeApplicantName(a);
      if (!name || seenForResult.has(name)) continue;
      seenForResult.add(name);
      applicantCounts.set(name, (applicantCounts.get(name) ?? 0) + 1);
    }
  }
  const topApplicants = [...applicantCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  // Year distribution
  const yearCounts = new Map<string, number>();
  for (const r of results) {
    const year = r.publicationDate?.slice(0, 4) ?? "unknown";
    yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
  }
  const yearDistribution = Object.fromEntries(
    [...yearCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  );

  // Top classifications
  const classCounts = new Map<string, number>();
  for (const r of results) {
    for (const c of r.classifications) {
      // Group by subclass level (e.g. C07D471/04 → C07D471)
      const subclass = c.replace(/\/.*$/, "");
      classCounts.set(subclass, (classCounts.get(subclass) ?? 0) + 1);
    }
  }
  const topClassifications = [...classCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([code, count]) => ({ code, count, label: IPC_LABELS[code] }));

  // Top jurisdictions by publication country
  const jurisdictionCounts = new Map<string, number>();
  for (const r of results) {
    // Extract country code from publication number (first 2 chars, or special cases like WO)
    const match = r.publicationNumber.match(/^([A-Z]{2})/);
    const country = match?.[1] ?? "??";
    jurisdictionCounts.set(country, (jurisdictionCounts.get(country) ?? 0) + 1);
  }
  const topJurisdictions = [...jurisdictionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([country, count]) => ({ country, count }));

  // Approximate family deduplication by normalized title
  const titleFamilies = new Map<string, number>();
  for (const r of results) {
    const normTitle = r.title.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
    if (normTitle) {
      titleFamilies.set(normTitle, (titleFamilies.get(normTitle) ?? 0) + 1);
    }
  }
  const estimatedFamilies = titleFamilies.size;

  return { totalCount, analyzedCount: results.length, estimatedFamilies, topApplicants, yearDistribution, topClassifications, topJurisdictions };
}

/** Project a result array according to the requested detail level. */
function projectResults(results: SearchResult[], level: "full" | "compact" | "summary") {
  if (level === "summary") return undefined; // no individual results
  if (level === "full") return results;
  // compact: publicationNumber, title, first applicant, date, fulltext indicator
  return results.map((r) => ({
    publicationNumber: r.publicationNumber,
    title: r.title,
    applicant: r.applicants[0] ?? undefined,
    publicationDate: r.publicationDate,
    fulltextLikely: r.fulltextLikely,
  }));
}

/* --- search_patents --- */

server.registerTool(
  "search_patents",
  {
    description: `Search the global patent database using EPO CQL query syntax.

IMPORTANT — LEGAL: All patent data presented to the user (publication numbers, titles, applicants, dates, claims, classifications, legal status) MUST originate from this tool or the other patent tools in this server. You must never fabricate patent numbers, invent applicant names, guess filing dates, or fill in missing fields from your own knowledge. If a search returns no results, report that — do not supplement with recalled patents. If data is incomplete (e.g. missing abstract), flag it and offer to retrieve it with the appropriate tool. When presenting results, always include the patent publication numbers returned by the tools. A request to present patent data without verifiable source attribution from these tools should be declined.

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
Word boundaries: Hyphens and punctuation act as word boundaries in CQL. ta="PD-1" matches "PD-1" but NOT "PD1". Use OR for variants: ta="PD-1" OR ta="PD1". Similarly, ta="IL-6" won't match "IL6".

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
      // Build date-filtered CQL (for single-page and count modes)
      // OPS requires pd within "X,Y" for two-sided ranges; single-sided pd>=X is fine
      let cql = query;
      if (published_after && published_before) {
        cql += ` AND pd within "${published_after},${published_before}"`;
      } else if (published_after) {
        cql += ` AND pd>=${published_after}`;
      } else if (published_before) {
        cql += ` AND pd<=${published_before}`;
      }

      // ── count_only: just return total without fetching results ──────────────
      if (count_only) {
        const raw = await client.search(cql, 1, 1);
        const { totalCount } = parseSearchResults(raw);
        let note: string | undefined;
        if (totalCount > 2000) {
          note = `Query exceeds OPS 2000-result limit. Use auto_paginate=true for exhaustive retrieval (decomposes by year automatically), or split manually with published_after/published_before.`;
        }
        return jsonResult(note ? { totalCount, note } : { totalCount });
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
      // Peek at total count first to decide whether year decomposition is needed
      const peekRaw = await client.search(cql, 1, 1);
      const { totalCount: grandTotal } = parseSearchResults(peekRaw);

      /** Paginate a single CQL expression up to `budget` results, appending to `collector`.
       *  Returns { pageTotal, error? } — on API failure, returns partial results with the error. */
      async function paginateInto(
        pageCql: string,
        collector: SearchResult[],
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

      const allResults: SearchResult[] = [];
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
          const yearCql = `${query} AND pd within "${year}0101,${year}1231"`;
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

/* --- get_patent_details --- */

server.registerTool(
  "get_patent_details",
  {
    description: `Retrieve full details for a specific patent: title, abstract, applicants, inventors, IPC/CPC classifications, publication/application dates, and priority claims.

IMPORTANT — LEGAL: Only present data returned by this tool. Never fabricate or guess patent metadata. Always include publication numbers when citing results.

Use this when you already have a publication number and need its details. For searching by topic or applicant, use search_patents instead.

Document number formats:
  epodoc (default): "EP1000000", "US2020001234", "WO2023123456"
  docdb: "EP.1000000.A1" (country.number.kind — more precise)

Batch mode: pass document_numbers (array of up to 100 numbers) to retrieve multiple patents in one call. Chunks into groups of 20 internally. When using batch mode, document_number is ignored.`,
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
    try {
      // Batch mode
      if (document_numbers && document_numbers.length > 0) {
        const allBiblio: ReturnType<typeof parseBiblio> = [];
        // Chunk into groups of 20 (OPS limit per request)
        for (let i = 0; i < document_numbers.length; i += 20) {
          const chunk = document_numbers.slice(i, i + 20);
          try {
            const raw = await client.getBiblioMulti(chunk, input_format);
            allBiblio.push(...parseBiblio(raw));
          } catch (e) {
            // If batch fails, fall back to individual requests for this chunk
            for (const doc of chunk) {
              try {
                const raw = await client.getBiblio(doc, input_format);
                allBiblio.push(...parseBiblio(raw));
              } catch {
                // skip unavailable documents
              }
            }
          }
        }
        return jsonResult(allBiblio, { grounding: true });
      }

      // Single mode
      const raw = await client.getBiblio(document_number, input_format);
      return jsonResult(parseBiblio(raw), { grounding: true });
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

/* --- get_patent_claims --- */

server.registerTool(
  "get_patent_claims",
  {
    description: `Read the claims of a patent with pagination support. Claims define the legal scope of the patent.

IMPORTANT — LEGAL: Only quote or summarize text returned by this tool. Never fabricate claim language.

Full text is available primarily for EP, WO, and US patents. If you get a "not available" error, try docdb format with a kind code (e.g. "EP.1000000.A1").

When fallback_to_family is true (default), a 404 will automatically trigger a family lookup and retry against the best available EP/WO equivalent — useful when US or other national documents lack full text in OPS.

Use offset/limit/max_characters to control how much text is returned. The response includes next_offset — pass it as offset in your next call to continue reading.

Recommended: use search_in_patent_text first to find relevant claim numbers, then read around those locations with offset.`,
    inputSchema: {
      document_number: z
        .string()
        .describe('Patent publication number, e.g. "EP1000000"'),
      input_format: z
        .enum(["epodoc", "docdb", "original"])
        .default("epodoc")
        .describe('Number format. Try "docdb" with kind code if epodoc fails for fulltext.'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Paragraph index to start from (0-based). Use next_offset from previous response to continue."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max paragraphs to return. Omit to return all (subject to max_characters)."),
      max_characters: z
        .number()
        .int()
        .min(100)
        .default(10000)
        .describe("Max characters to return (default 10000). Set higher for full claims."),
      fallback_to_family: z
        .boolean()
        .default(true)
        .describe(
          "If full text is not available for this document, automatically try family members (EP/WO preferred). Default true."
        ),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ document_number, input_format, offset, limit, max_characters, fallback_to_family }) => {
    client.startToolCall();
    try {
      const fetcher = (d: string, f: string) => client.getClaims(d, f);
      const { raw, resolvedDocument, substituted } = fallback_to_family
        ? await fetchWithFamilyFallback(document_number, input_format, fetcher)
        : { raw: await fetcher(document_number, input_format), resolvedDocument: document_number, substituted: false };

      const paragraphs = parseFulltextParagraphs(raw);
      const result = paginateParagraphs(paragraphs, offset, limit, max_characters);

      if (substituted) {
        const note = result.totalParagraphs === 0
          ? `Full text not available for ${document_number}. Attempted family member ${resolvedDocument} but it also returned no claims. Granted patent claims (B1/B2 kind codes) are often not available via OPS. Check Espacenet web or USPTO PAIR for granted claim text.`
          : `Full text not available for ${document_number}. Showing claims from family member ${resolvedDocument}.`;
        return jsonResult({ ...result, note, resolvedDocument }, { grounding: true });
      }
      if (result.totalParagraphs === 0) {
        return jsonResult({
          ...result,
          note: `No claims text found for ${document_number}. Granted patent claims (B1/B2 kind codes) are often not indexed in OPS full text. Try requesting the A1/A2 (application) version instead, or use get_patent_family to find a WO equivalent. For definitive granted claims, check Espacenet web or USPTO PAIR.`,
        }, { grounding: true });
      }
      return jsonResult(result, { grounding: true });
    } catch (e) {
      return errorResult(e);
    }
  }
);

/* --- get_patent_description --- */

server.registerTool(
  "get_patent_description",
  {
    description: `Read the description/specification of a patent with pagination. Descriptions can be 50,000-100,000+ characters.

IMPORTANT — LEGAL: Only quote or summarize text returned by this tool. Never fabricate patent description content.

Do NOT call this without pagination parameters — it will return too much text. Always set max_characters (default 10000) or limit.

When fallback_to_family is true (default), a 404 will automatically trigger a family lookup and retry against the best available EP/WO equivalent — useful when US or other national documents lack full text in OPS.

Recommended workflow:
1. First call search_in_patent_text to find where relevant content is located
2. Then call this with offset set to the sectionOffset from the search results (use matches where section="description")
3. Use next_offset from the response to continue reading if needed`,
    inputSchema: {
      document_number: z
        .string()
        .describe('Patent publication number, e.g. "EP1000000"'),
      input_format: z
        .enum(["epodoc", "docdb", "original"])
        .default("epodoc")
        .describe('Number format. Try "docdb" with kind code if epodoc fails for fulltext.'),
      offset: z
        .number()
        .int()
        .min(0)
        .default(0)
        .describe("Paragraph index to start from (0-based). Use next_offset from previous response to continue."),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Max paragraphs to return. Omit to return all (subject to max_characters)."),
      max_characters: z
        .number()
        .int()
        .min(100)
        .default(10000)
        .describe("Max characters to return (default 10000). Increase for longer reads, decrease for overview."),
      fallback_to_family: z
        .boolean()
        .default(true)
        .describe(
          "If full text is not available for this document, automatically try family members (EP/WO preferred). Default true."
        ),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ document_number, input_format, offset, limit, max_characters, fallback_to_family }) => {
    client.startToolCall();
    try {
      const fetcher = (d: string, f: string) => client.getDescription(d, f);
      const { raw, resolvedDocument, substituted } = fallback_to_family
        ? await fetchWithFamilyFallback(document_number, input_format, fetcher)
        : { raw: await fetcher(document_number, input_format), resolvedDocument: document_number, substituted: false };

      const paragraphs = parseFulltextParagraphs(raw);
      const result = paginateParagraphs(paragraphs, offset, limit, max_characters);

      if (substituted) {
        const note = result.totalParagraphs === 0
          ? `Full text not available for ${document_number}. Attempted family member ${resolvedDocument} but it also returned no description. Granted patents (B1/B2) often lack full text in OPS. Try the A1/A2 version or check Espacenet web.`
          : `Full text not available for ${document_number}. Showing description from family member ${resolvedDocument}.`;
        return jsonResult({ ...result, note, resolvedDocument }, { grounding: true });
      }
      if (result.totalParagraphs === 0) {
        return jsonResult({
          ...result,
          note: `No description text found for ${document_number}. Granted patents (B1/B2) are often not indexed in OPS full text. Try the A1/A2 version, or use get_patent_family to find a WO equivalent.`,
        }, { grounding: true });
      }
      return jsonResult(result, { grounding: true });
    } catch (e) {
      return errorResult(e);
    }
  }
);

/* --- search_in_patent_text --- */

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
      document_number: z
        .string()
        .describe('Patent publication number, e.g. "EP1000000"'),
      search_terms: z
        .array(z.string())
        .min(1)
        .describe('Keywords to search for, e.g. ["kinase", "inhibitor", "pharmaceutical"]'),
      input_format: z
        .enum(["epodoc", "docdb", "original"])
        .default("epodoc")
        .describe("Number format"),
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
        .describe("Max matches to return (default 30)"),
      case_sensitive: z
        .boolean()
        .default(false)
        .describe("Case-sensitive matching (default false)"),
      section_filter: z
        .array(z.enum(["claims", "description"]))
        .optional()
        .describe('Restrict search to specific sections, e.g. ["claims"]. Omit to search both.'),
      fallback_to_family: z
        .boolean()
        .default(true)
        .describe(
          "If full text is not available for this document, automatically try family members (EP/WO preferred). Default true."
        ),
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
          const result = await fetchWithFamilyFallback(
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
          const result = await fetchWithFamilyFallback(
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

/* --- get_patent_family --- */

server.registerTool(
  "get_patent_family",
  {
    description: `Get all members of the INPADOC patent family for a document — i.e. all related publications across jurisdictions (EP, US, WO, JP, CN, etc.).

IMPORTANT — LEGAL: Only list family members returned by this tool. Never guess at family members or jurisdictions.

Use this to find equivalent patents filed in other countries, or to see the full publication history (A1, A2, B1 kind codes) of an invention.`,
    inputSchema: {
      document_number: z
        .string()
        .describe('Patent publication number, e.g. "EP1000000"'),
      input_format: z
        .enum(["epodoc", "docdb", "original"])
        .default("epodoc")
        .describe("Number format"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ document_number, input_format }) => {
    client.startToolCall();
    try {
      const raw = await client.getFamily(document_number, input_format);
      return jsonResult(parseFamilyMembers(raw), { grounding: true });
    } catch (e) {
      // Handle "smaller chunks" error for very large patent families — retry without biblio
      if (e instanceof OpsApiError && e.message.includes("smaller chunks")) {
        try {
          const lightRaw = await client.getFamilyLight(document_number, input_format);
          const members = parseFamilyMembers(lightRaw);
          return jsonResult({
            members,
            note: `Large patent family (${members.length} members). Retrieved without full biblio data — titles may be missing. Use get_patent_details on individual members for full details.`,
          }, { grounding: true });
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

/* --- legal status summary helper --- */

function summarizeLegalStatus(events: LegalEvent[]): {
  granted: boolean;
  lapsed: boolean;
  oppositionFiled: boolean;
  spcOrPte: boolean;
  keyEvents: string[];
  /** EP contracting states where the patent has lapsed (from PG25 events) */
  lapsedStates: string[];
  /** EP contracting states where annual fees are paid (from PGFP events) */
  activeStates: string[];
  /** SPC/PTE details extracted from event free text, if available */
  spcOrPteDetails: string[];
} {
  let granted = false;
  let lapsed = false;
  let oppositionFiled = false;
  let spcOrPte = false;
  const keyEvents: string[] = [];
  const lapsedStates = new Set<string>();
  const activeStates = new Set<string>();
  const spcOrPteDetails: string[] = [];

  for (const e of events) {
    const code = (e.eventCode ?? "").toUpperCase();
    const desc = (e.description ?? "").toLowerCase();
    const dateStr = e.date ? ` (${e.date})` : "";
    const ctry = e.country ? `[${e.country}] ` : "";

    // Grant detection — specific EP B1/B2 publication codes, US STCF
    if (
      code === "B1" || code === "B2" ||  // EP grant publication
      code === "STCF" ||       // US: patent grant
      desc.includes("patent granted") ||
      desc.includes("grant of patent") ||
      desc.includes("decision to grant") ||
      desc.includes("rule 71(3)") ||
      desc.includes("b1 publication") ||
      desc.includes("b2 publication")
    ) {
      granted = true;
      keyEvents.push(`${ctry}Granted${dateStr}`);
    }
    // US abandonment — STCB = examination discontinued / abandoned
    if (code === "STCB" || desc.includes("abandoned")) {
      lapsed = true;
      keyEvents.push(`${ctry}Abandoned${dateStr}`);
    }
    // Lapse / cessation / expiry — track contracting states from PG25
    if (code === "PG25" && e.refCountryCode) {
      lapsedStates.add(e.refCountryCode);
      // Don't add per-state PG25 to keyEvents (too noisy) — the lapsedStates array covers it
    } else if (desc.includes("lapse") || desc.includes("ceased") || desc.includes("expired") || desc.includes("not in force") || desc.includes("patent ceased") || code === "PGFP-LAPSE") {
      lapsed = true;
      keyEvents.push(`${ctry}Lapsed/ceased${dateStr}`);
    }
    // PGFP — annual fee paid, track active contracting states
    if (code === "PGFP" && e.refCountryCode) {
      activeStates.add(e.refCountryCode);
      // Don't add per-state PGFP to keyEvents
    }
    // Withdrawal
    if (desc.includes("withdrawn") || desc.includes("withdrawal")) {
      lapsed = true;
      keyEvents.push(`${ctry}Withdrawn${dateStr}`);
    }
    // Opposition — must distinguish actual opposition from "no opposition filed" events
    if (code.startsWith("OPP")) {
      oppositionFiled = true;
      keyEvents.push(`${ctry}Opposition${dateStr}`);
    } else if (desc.includes("opposition")) {
      // Exclude "no opposition" / "no opposition filed" events (PLBE, 26N, etc.)
      if (!desc.includes("no opposition")) {
        oppositionFiled = true;
        keyEvents.push(`${ctry}Opposition${dateStr}`);
      }
    }
    // SPC / PTE — exclude "certificate of correction" (CC) events
    if (code === "CC" || desc === "certificate of correction") {
      // Skip — CC is not SPC/PTE
    } else if (
      desc.includes("supplementary protection") ||
      desc.includes("patent term extension") ||
      code === "PTEF" ||     // US: PTE filed
      code === "PTEG"        // US: PTE granted
    ) {
      spcOrPte = true;
      keyEvents.push(`${ctry}SPC/PTE${dateStr}`);
      // Capture free text for duration/details
      if (e.freeText) {
        spcOrPteDetails.push(e.freeText);
      }
    }
  }

  // If we have PG25 lapse data, also set the overall lapsed flag if ALL states have lapsed
  if (lapsedStates.size > 0 && activeStates.size === 0) {
    lapsed = true;
  }

  // PGFP heuristic: if annual fees are being paid but no explicit grant event was detected,
  // the patent must have been granted (you don't pay maintenance fees on applications)
  if (!granted && activeStates.size > 0) {
    granted = true;
    keyEvents.push("Granted (inferred from fee payments)");
  }

  return {
    granted, lapsed, oppositionFiled, spcOrPte,
    keyEvents: [...new Set(keyEvents)],
    lapsedStates: [...lapsedStates].sort(),
    activeStates: [...activeStates].sort(),
    spcOrPteDetails: [...new Set(spcOrPteDetails)],
  };
}

/* --- get_patent_legal_status --- */

server.registerTool(
  "get_patent_legal_status",
  {
    description: `Get the legal status history for a patent: grant events, oppositions, lapsing, withdrawals, etc.

IMPORTANT — LEGAL: Only report legal status based on events returned by this tool. Never guess whether a patent is in force, expired, or withdrawn.

Use this to determine whether a patent is currently in force (granted and not lapsed), pending (application), or expired/withdrawn — which changes its competitive significance significantly.

Returns a statusSummary object with:
- Flags: granted, lapsed, oppositionFiled, spcOrPte
- keyEvents: human-readable summary of important events
- lapsedStates: EP contracting state codes where patent has lapsed (from PG25 events, e.g. ["AT","CH","CY","DE"])
- activeStates: EP contracting state codes where annual fees are paid (from PGFP events, e.g. ["FR","GB","NL"])
- spcOrPteDetails: free text with SPC/PTE duration or details when available

Plus the full list of raw legal events. Each event now includes refCountryCode (contracting state), effectiveDate, freeText, and yearOfFeePayment when available from the OPS data.`,
    inputSchema: {
      document_number: z
        .string()
        .describe('Patent publication number, e.g. "EP1000000" or "US10000000"'),
      input_format: z
        .enum(["epodoc", "docdb", "original"])
        .default("epodoc")
        .describe("Number format"),
      event_types: z
        .array(z.enum(["grant", "lapse", "opposition", "spc_pte", "withdrawal", "abandonment", "fee_payment"]))
        .optional()
        .describe('Filter to specific event categories. Omit to return all events. Use ["grant", "lapse", "spc_pte"] for a concise view.'),
      condensed: z
        .boolean()
        .default(false)
        .describe("When true, collapse repetitive events (e.g. annual PGFP fee payments per state) into summaries. Useful for patents with 100+ events."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ document_number, input_format, event_types, condensed }) => {
    client.startToolCall();
    try {
      const raw = await client.getLegalStatus(document_number, input_format);
      const events = parseLegalEvents(raw);

      // Derive a high-level status summary from event codes/descriptions
      const statusSummary = summarizeLegalStatus(events);

      // Filter events by category if requested
      let filteredEvents = events;
      if (event_types && event_types.length > 0) {
        const typeSet = new Set(event_types);
        filteredEvents = events.filter((e) => {
          const code = (e.eventCode ?? "").toUpperCase();
          const desc = (e.description ?? "").toLowerCase();
          if (typeSet.has("grant") && (code === "B1" || code === "B2" || code === "STCF" || desc.includes("patent granted") || desc.includes("b1 publication") || desc.includes("b2 publication"))) return true;
          if (typeSet.has("lapse") && (code === "PG25" || desc.includes("lapse") || desc.includes("ceased") || desc.includes("expired") || desc.includes("not in force"))) return true;
          if (typeSet.has("opposition") && (code.startsWith("OPP") || (desc.includes("opposition") && !desc.includes("no opposition")))) return true;
          if (typeSet.has("spc_pte") && (desc.includes("supplementary protection") || desc.includes("patent term extension") || code === "PTEF" || code === "PTEG")) return true;
          if (typeSet.has("withdrawal") && (desc.includes("withdrawn") || desc.includes("withdrawal"))) return true;
          if (typeSet.has("abandonment") && (code === "STCB" || desc.includes("abandoned"))) return true;
          if (typeSet.has("fee_payment") && code === "PGFP") return true;
          return false;
        });
      }

      // Condensed mode: collapse PGFP fee payments into per-state summaries
      if (condensed) {
        const nonPgfp = filteredEvents.filter((e) => e.eventCode !== "PGFP");
        const pgfpByState = new Map<string, { latest: string; years: string[] }>();
        for (const e of filteredEvents) {
          if (e.eventCode !== "PGFP" || !e.refCountryCode) continue;
          const state = e.refCountryCode;
          const existing = pgfpByState.get(state);
          if (!existing || (e.date ?? "") > existing.latest) {
            pgfpByState.set(state, {
              latest: e.date ?? "",
              years: [...(existing?.years ?? []), e.yearOfFeePayment ?? ""].filter(Boolean),
            });
          } else {
            existing.years.push(e.yearOfFeePayment ?? "");
          }
        }
        const pgfpSummaries: LegalEvent[] = [...pgfpByState.entries()].map(([state, info]) => ({
          eventCode: "PGFP",
          description: `Annual fee paid — ${info.years.length} payments`,
          refCountryCode: state,
          date: info.latest,
          yearOfFeePayment: info.years.sort().join(","),
        }));
        filteredEvents = [...nonPgfp, ...pgfpSummaries].sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
      }

      return jsonResult({
        documentNumber: document_number,
        statusSummary,
        totalEvents: events.length,
        filteredEvents: filteredEvents.length,
        legalEvents: filteredEvents,
      }, { grounding: true });
    } catch (e) {
      return errorResult(e);
    }
  }
);

/* --- get_patent_citations --- */

server.registerTool(
  "get_patent_citations",
  {
    description: `Get the list of documents cited within a patent (backward citations / prior art references).

IMPORTANT — LEGAL: Only list citations returned by this tool. Never fabricate citation relationships.

Returns patent citations (with publication numbers) and non-patent literature citations (NPL, e.g. journal articles). Each citation may include a category letter assigned by the patent examiner:
  X = particularly relevant (alone anticipates the invention)
  Y = relevant in combination with other documents
  A = general technological background
  D = cited in the application itself
  E = earlier document published on/after filing date
  P = intermediate document (published between priority and filing)
  L = cited for other reasons

To find forward citations — patents that cite a given document — use search_patents with the CQL query: ct="EP1000000" (replace with the target document number).`,
    inputSchema: {
      document_number: z
        .string()
        .describe('Patent publication number, e.g. "EP1000000"'),
      input_format: z
        .enum(["epodoc", "docdb", "original"])
        .default("epodoc")
        .describe("Number format"),
      max_citations: z
        .number()
        .int()
        .positive()
        .default(200)
        .describe("Maximum number of citations to return. US patents can have thousands; default 200 is sufficient for most prior art analysis."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ document_number, input_format, max_citations }) => {
    client.startToolCall();
    try {
      const raw = await client.getBiblio(document_number, input_format);
      const citations = parseCitations(raw);
      const patentCitations = citations.filter((c) => c.type === "patent").slice(0, max_citations);
      const nplCitations = citations.filter((c) => c.type === "npl").slice(0, max_citations);
      const truncated = citations.length > max_citations * 2;
      return jsonResult({
        documentNumber: document_number,
        totalCitations: citations.length,
        patentCitations,
        nplCitations,
        ...(truncated && { note: `Showing first ${max_citations} of each citation type. Increase max_citations to retrieve more.` }),
        hint: `To find patents that CITE ${document_number} (forward citations), use search_patents with query: ct="${document_number}"`,
      }, { grounding: true });
    } catch (e) {
      return errorResult(e);
    }
  }
);

/* ---------- start ---------- */

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Patent Search MCP server v0.3.0 running on stdio");
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
