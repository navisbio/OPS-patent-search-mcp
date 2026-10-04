/**
 * Integration tests for ops-patent-search
 *
 * Spawns the actual server bundle and connects via MCP stdio transport.
 * Tests all tools against the live EPO OPS API and reports timing.
 *
 * Usage:
 *   npx tsx tests/integration.ts
 *
 * Requires env vars:
 *   PATENT_CONSUMER_KEY
 *   PATENT_CONSUMER_SECRET_KEY
 *
 * Test suites live under tests/tools/ mirroring src/tools/.
 */

import {
  TEST_PATENT,
  connectClient,
  createTestRunner,
  type TestResult,
  type ToolTestSuite,
} from "./helpers.js";
import { testSearchPatents } from "./tools/search-patents.js";
import { testGetPatentDetails } from "./tools/get-patent-details.js";
import { testFulltext } from "./tools/fulltext.js";
import { testSearchInPatentText } from "./tools/search-in-patent-text.js";
import { testSearchAndFilter } from "./tools/search-and-filter.js";
import { testGetPatentFamily } from "./tools/get-patent-family.js";
import { testGetPatentLegalStatus } from "./tools/get-patent-legal-status.js";
import { testGetPatentCitations } from "./tools/get-patent-citations.js";

const SUITES: Array<{ label: string; run: ToolTestSuite }> = [
  { label: "search-patents", run: testSearchPatents },
  { label: "get-patent-details", run: testGetPatentDetails },
  { label: "fulltext", run: testFulltext },
  { label: "search-in-patent-text", run: testSearchInPatentText },
  { label: "search-and-filter", run: testSearchAndFilter },
  { label: "get-patent-family", run: testGetPatentFamily },
  { label: "get-patent-legal-status", run: testGetPatentLegalStatus },
  { label: "get-patent-citations", run: testGetPatentCitations },
];

async function main() {
  console.log("ops-patent-search integration tests");
  console.log("=====================================");
  console.log(`Test patent: ${TEST_PATENT}`);
  console.log();

  const connectStart = performance.now();
  const client = await connectClient();
  console.log(`✅ Connected to server in ${Math.round(performance.now() - connectStart)}ms`);
  console.log();

  const results: TestResult[] = [];
  const test = createTestRunner(client, results);

  try {
    for (const suite of SUITES) {
      console.log(`── ${suite.label} ──`);
      await suite.run(client, test);
      console.log();
    }
  } finally {
    await client.close();
  }

  /* --- Summary --- */
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);
  const avgMs = results.length ? Math.round(totalMs / results.length) : 0;

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
