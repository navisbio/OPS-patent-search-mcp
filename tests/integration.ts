/**
 * Integration tests for ops-patent-search
 *
 * Spawns the actual server bundle and connects via MCP stdio transport.
 * Tests all 8 tools against the live EPO OPS API and reports timing.
 *
 * Usage:
 *   npx tsx tests/integration.ts
 *
 * Requires env vars:
 *   PATENT_CONSUMER_KEY
 *   PATENT_CONSUMER_SECRET_KEY
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "child_process";
import { resolve } from "path";

/* ------------------------------------------------------------------ */
/*  Test fixtures — well-known stable patents                          */
/* ------------------------------------------------------------------ */

const TEST_PATENT = "EP3750919"; // Referenced in code examples — CRISPR-related
const TEST_SEARCH_QUERY = 'ta="CRISPR" AND pa="Broad*" AND pd>=2018';

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

interface TestResult {
  name: string;
  tool: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  preview?: string;
}

async function callTool(
  client: Client,
  tool: string,
  args: Record<string, unknown>
): Promise<{ result: ToolResult; durationMs: number }> {
  const start = performance.now();
  const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
  const durationMs = Math.round(performance.now() - start);
  return { result, durationMs };
}

function preview(result: ToolResult, maxChars = 120): string {
  const text = result.content?.[0]?.text ?? "";
  const trimmed = text.slice(0, maxChars);
  return trimmed.length < text.length ? trimmed + "…" : trimmed;
}

function isError(result: ToolResult): boolean {
  return result.isError === true || result.content?.[0]?.text?.startsWith("Error:") === true;
}

/* ------------------------------------------------------------------ */
/*  Test definitions                                                    */
/* ------------------------------------------------------------------ */

async function runTests(client: Client): Promise<TestResult[]> {
  const results: TestResult[] = [];

  async function test(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    validate?: (r: ToolResult) => string | null, // return null = pass, string = failure reason
    ignoreIsError?: boolean // when true, skip isError check and always run validate
  ) {
    process.stdout.write(`  Running: ${name} … `);
    try {
      const { result, durationMs } = await callTool(client, tool, args);
      const errorMsg =
        !ignoreIsError && isError(result)
          ? result.content?.[0]?.text
          : validate?.(result) ?? null;

      const passed = !errorMsg;
      console.log(passed ? `✅ ${durationMs}ms` : `❌ ${durationMs}ms`);
      if (!passed) console.log(`    → ${errorMsg}`);

      results.push({
        name,
        tool,
        passed,
        durationMs,
        error: errorMsg ?? undefined,
        preview: preview(result),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`❌ threw`);
      console.log(`    → ${msg}`);
      results.push({ name, tool, passed: false, durationMs: 0, error: msg });
    }
  }

  /* --- search_patents --- */
  await test(
    "Basic CQL search",
    "search_patents",
    { query: TEST_SEARCH_QUERY, range_end: 10 },
    (r) => {
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      if (data.totalCount === 0) return "Expected results, got 0";
      if (!data.results?.[0]?.publicationNumber) return "Missing publicationNumber in results";
      return null;
    }
  );

  await test(
    "Search pagination metadata (nextOffset)",
    "search_patents",
    { query: TEST_SEARCH_QUERY, range_end: 5 },
    (r) => {
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      if (data.totalCount === undefined) return "Missing totalCount";
      // nextOffset should be present when there are more results beyond range_end
      if (data.totalCount > 5 && data.nextOffset === undefined)
        return "Missing nextOffset when more results exist";
      return null;
    }
  );

  await test(
    "Search with date filter params",
    "search_patents",
    { query: 'ta="antibody drug conjugate"', published_after: "2022", range_end: 5 },
    (r) => {
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      return data.totalCount > 0 ? null : "Expected results, got 0";
    }
  );

  await test(
    "Search auto-paginate (small)",
    "search_patents",
    { query: 'pa="Broad Institute" AND ta="CRISPR"', auto_paginate: true, max_results: 30 },
    (r) => {
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      return data.fetchedCount > 0 ? null : "auto_paginate returned 0 results";
    }
  );

  await test(
    "count_only returns totalCount without results",
    "search_patents",
    { query: TEST_SEARCH_QUERY, count_only: true },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (typeof data.totalCount !== "number") return "Missing totalCount";
      if (data.results !== undefined) return "count_only should not return results array";
      return null;
    }
  );

  await test(
    "Date range (published_after + published_before) — uses pd within syntax",
    "search_patents",
    { query: 'ta="anti-PD-1 antibody"', published_after: "20080101", published_before: "20151231", range_end: 5 },
    (r) => {
      if (r.content[0].text.startsWith("Error:")) return r.content[0].text;
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      return data.totalCount > 0 ? null : "Expected results for two-sided date range";
    }
  );

  await test(
    "auto_paginate decomposes >2000 query by year",
    "search_patents",
    { query: 'ta="KRAS"', published_after: "2023", published_before: "2025", auto_paginate: true, max_results: 50 },
    (r) => {
      const text = r.content[0].text;
      const data = JSON.parse(text.split("\n\n")[0]);
      if (data.fetchedCount === 0) return "Expected results";
      // Should mention year decomposition in the note when total > 2000
      if (data.totalCount > 2000 && !text.includes("year decomposition")) {
        return `totalCount=${data.totalCount} > 2000 but no year decomposition note`;
      }
      return null;
    }
  );

  await test(
    "Search with no results (graceful)",
    "search_patents",
    { query: 'ti="xyzzy_nonexistent_patent_title_zqwerty_12345"' },
    (r) => {
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      return data.totalCount === 0 ? null : "Expected 0 results for nonsense query";
    }
  );

  /* --- get_patent_details --- */
  await test(
    "Biblio (epodoc)",
    "get_patent_details",
    { document_number: TEST_PATENT },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (!Array.isArray(data) || data.length === 0) return "Expected array of biblio records";
      if (!data[0].title) return "Missing title in biblio";
      return null;
    }
  );

  await test(
    "Biblio (docdb format)",
    "get_patent_details",
    { document_number: "EP.3750919.A1", input_format: "docdb" },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      return Array.isArray(data) && data.length > 0 ? null : "Expected biblio records";
    }
  );

  /* --- get_patent_details --- */
  await test(
    "Abstract",
    "get_patent_details",
    { document_number: TEST_PATENT },
    (r) => {
      const text = r.content[0].text;
      return text.length > 50 && !text.includes("no abstract") ? null : "Abstract too short or missing";
    }
  );

  /* --- get_patent_claims --- */
  await test(
    "Claims (first page)",
    "get_patent_claims",
    { document_number: TEST_PATENT, max_characters: 5000 },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (!data.paragraphs?.length) return "No claim paragraphs returned";
      if (data.totalParagraphs === undefined) return "Missing totalParagraphs field";
      if (data.nextOffset === undefined && data.totalParagraphs > data.paragraphs.length)
        return "Missing nextOffset when more paragraphs exist";
      return null;
    }
  );

  await test(
    "Claims pagination (second page)",
    "get_patent_claims",
    { document_number: TEST_PATENT, offset: 5, max_characters: 3000 },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      // offset 5 might be past the end — acceptable; just shouldn't error
      return data.paragraphs !== undefined ? null : "Missing paragraphs field";
    }
  );

  await test(
    "Claims family fallback (US patent)",
    "get_patent_claims",
    { document_number: "US10167457", fallback_to_family: true, max_characters: 3000 },
    (r) => {
      const text = r.content[0].text;
      // Either got claims (JSON with paragraphs) or a graceful no-full-text message
      try {
        const data = JSON.parse(text);
        return data.paragraphs !== undefined ? null : "Missing paragraphs field";
      } catch {
        // A descriptive error message (not a crash/exception) is also acceptable
        return text.length > 20 ? null : "Empty or too-short response";
      }
    },
    true /* ignoreIsError — graceful "no full text" is acceptable for US patents without EP equivalent */
  );

  /* --- get_patent_description --- */
  await test(
    "Description (first page)",
    "get_patent_description",
    { document_number: TEST_PATENT, max_characters: 5000 },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (!data.paragraphs?.length) return "No description paragraphs returned";
      return null;
    }
  );

  await test(
    "Description pagination continuity",
    "get_patent_description",
    { document_number: TEST_PATENT, offset: 10, max_characters: 3000 },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      return data.paragraphs !== undefined ? null : "Missing paragraphs field";
    }
  );

  await test(
    "Full text unavailable (JP patent, graceful error)",
    "get_patent_claims",
    { document_number: "JP2020123456" },
    (r) => {
      const text = r.content[0].text;
      // JP patents typically lack OPS full text — should get a helpful message, not a crash
      return text.length > 10 ? null : "Empty response for unavailable full text";
    },
    true /* ignoreIsError — a descriptive error IS the correct response here */
  );

  /* --- search_in_patent_text --- */
  await test(
    "Keyword search in patent text",
    "search_in_patent_text",
    { document_number: TEST_PATENT, search_terms: ["CRISPR", "nucleic"] },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (data.matchCount === undefined) return "Missing matchCount";
      if (data.matchCount === 0) return "Expected matches for 'CRISPR' in CRISPR patent";
      return null;
    }
  );

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

  await test(
    "Keyword search — claims only filter",
    "search_in_patent_text",
    { document_number: TEST_PATENT, search_terms: ["nucleic acid"], section_filter: ["claims"] },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      const allInClaims = data.matches?.every((m: { section: string }) => m.section === "claims") ?? true;
      return allInClaims ? null : "section_filter='claims' returned description matches";
    }
  );

  await test(
    "Keyword search — description only filter",
    "search_in_patent_text",
    { document_number: TEST_PATENT, search_terms: ["nucleic"], section_filter: ["description"] },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      const allInDesc = data.matches?.every((m: { section: string }) => m.section === "description") ?? true;
      return allInDesc ? null : "section_filter='description' returned claims matches";
    }
  );

  await test(
    "Keyword search — no match (graceful)",
    "search_in_patent_text",
    { document_number: TEST_PATENT, search_terms: ["xyzzy_nonexistent_term"] },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      return data.matchCount === 0 ? null : "Expected 0 matches for nonsense term";
    }
  );

  /* --- get_patent_family --- */
  await test(
    "Patent family",
    "get_patent_family",
    { document_number: TEST_PATENT },
    (r) => {
      const text = r.content[0].text;
      // CRISPR patents may have very large families — accept either results or
      // the "too large, request in chunks" message (both indicate a working endpoint)
      const data = JSON.parse(text);
      // Direct array of members
      if (Array.isArray(data) && data.length > 0) {
        return data[0].publicationNumber ? null : "Missing publicationNumber in family member";
      }
      // Wrapped format from light fallback (large families): { members: [...], note: "..." }
      if (Array.isArray(data?.members) && data.members.length > 0) {
        return data.members[0].publicationNumber ? null : "Missing publicationNumber in family member";
      }
      return "Expected family members";
    },
    true /* ignoreIsError — large-family OPS error is a known limitation, not a test failure */
  );

  /* --- get_patent_legal_status --- */
  await test(
    "Legal status",
    "get_patent_legal_status",
    { document_number: TEST_PATENT },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (!data.legalEvents) return "Missing legalEvents field";
      if (!Array.isArray(data.legalEvents)) return "legalEvents is not an array";
      if (data.legalEvents.length === 0) return "Expected at least one legal event for a granted patent";
      if (!data.legalEvents[0].eventCode) return "Missing eventCode on first legal event";
      return null;
    }
  );

  /* --- get_patent_citations --- */
  await test(
    "Citations (backward)",
    "get_patent_citations",
    { document_number: TEST_PATENT },
    (r) => {
      const data = JSON.parse(r.content[0].text);
      if (data.totalCitations === undefined) return "Missing totalCitations field";
      if (!Array.isArray(data.patentCitations)) return "Missing patentCitations array";
      if (!Array.isArray(data.nplCitations)) return "Missing nplCitations array";
      if (data.totalCitations === 0) return "Expected at least one citation in a CRISPR patent";
      if (data.patentCitations.length === 0 && data.nplCitations.length === 0)
        return "totalCitations > 0 but both citation arrays are empty";
      return null;
    }
  );

  await test(
    "Forward citations via search",
    "search_patents",
    { query: `ct="${TEST_PATENT}"`, range_end: 5 },
    (r) => {
      const data = JSON.parse(r.content[0].text.split("\n\n")[0]);
      // Just check the call succeeds — may be 0 results if no forward citations indexed yet
      return data.totalCount !== undefined ? null : "Missing totalCount";
    }
  );

  return results;
}

/* ------------------------------------------------------------------ */
/*  Main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  if (!process.env.PATENT_CONSUMER_KEY || !process.env.PATENT_CONSUMER_SECRET_KEY) {
    console.error("❌  Missing PATENT_CONSUMER_KEY or PATENT_CONSUMER_SECRET_KEY env vars");
    process.exit(1);
  }

  const bundlePath = resolve(__dirname, "../server/bundle.cjs");

  console.log("ops-patent-search integration tests");
  console.log("=====================================");
  console.log(`Server: ${bundlePath}`);
  console.log(`Test patent: ${TEST_PATENT}`);
  console.log();

  const transport = new StdioClientTransport({
    command: "node",
    args: [bundlePath],
    env: {
      ...process.env,
      PATENT_CONSUMER_KEY: process.env.PATENT_CONSUMER_KEY,
      PATENT_CONSUMER_SECRET_KEY: process.env.PATENT_CONSUMER_SECRET_KEY,
      // Use longer tool timeout for integration tests (not constrained by Claude Desktop's 60s)
      OPS_TOOL_TIMEOUT_MS: process.env.OPS_TOOL_TIMEOUT_MS ?? "120000",
    } as Record<string, string>,
  });

  const client = new Client({ name: "integration-test", version: "0.1.0" });

  const connectStart = performance.now();
  await client.connect(transport);
  const connectMs = Math.round(performance.now() - connectStart);
  console.log(`✅ Connected to server in ${connectMs}ms`);
  console.log();

  let results: TestResult[] = [];
  try {
    results = await runTests(client);
  } finally {
    await client.close();
  }

  /* --- Summary --- */
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  const avgMs = results.length ? Math.round(totalMs / results.length) : 0;

  console.log();
  console.log("Results");
  console.log("=======");
  console.log(`Passed: ${passed}/${results.length}   Failed: ${failed}`);
  console.log(`Total time: ${totalMs}ms   Avg per call: ${avgMs}ms`);
  console.log();

  /* Timing table */
  console.log("Timing breakdown (sorted slowest→fastest):");
  const sorted = [...results].sort((a, b) => b.durationMs - a.durationMs);
  const maxNameLen = Math.max(...sorted.map((r) => r.name.length));
  for (const r of sorted) {
    const status = r.passed ? "✅" : "❌";
    const padded = r.name.padEnd(maxNameLen);
    const bar = "█".repeat(Math.round(r.durationMs / 200)).padEnd(15);
    console.log(`  ${status} ${padded}  ${String(r.durationMs).padStart(5)}ms  ${bar}`);
  }

  if (failed > 0) {
    console.log();
    console.log("Failures:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ❌ ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
