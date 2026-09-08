/**
 * Shared test harness for integration test scenarios.
 *
 * Spawns the MCP server bundle, provides helpers for calling tools
 * and asserting results, and prints a timing summary.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "path";

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

export type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

export interface TestResult {
  name: string;
  tool: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export type Validator = (r: ToolResult) => string | null;

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

export function getText(result: ToolResult): string {
  return result.content?.[0]?.text ?? "";
}

export function parseJson(result: ToolResult): any {
  return JSON.parse(getText(result).split("\n\n")[0]);
}

export function isError(result: ToolResult): boolean {
  return result.isError === true || getText(result).startsWith("Error:");
}

/* ------------------------------------------------------------------ */
/*  Test runner                                                         */
/* ------------------------------------------------------------------ */

export interface TestContext {
  client: Client;
  results: TestResult[];
  test: (
    name: string,
    tool: string,
    args: Record<string, unknown>,
    validate?: Validator,
    ignoreIsError?: boolean
  ) => Promise<void>;
}

export async function runScenario(
  scenarioName: string,
  fn: (ctx: TestContext) => Promise<void>
) {
  if (!process.env.PATENT_CONSUMER_KEY || !process.env.PATENT_CONSUMER_SECRET_KEY) {
    console.error("❌  Missing PATENT_CONSUMER_KEY or PATENT_CONSUMER_SECRET_KEY");
    process.exit(1);
  }

  const bundlePath = resolve(__dirname, "../server/bundle.cjs");

  console.log(`\n${"═".repeat(78)}`);
  console.log(`  ${scenarioName}`);
  console.log(`${"═".repeat(78)}`);
  console.log(`Server: ${bundlePath}\n`);

  const transport = new StdioClientTransport({
    command: "node",
    args: [bundlePath],
    env: {
      ...process.env,
      PATENT_CONSUMER_KEY: process.env.PATENT_CONSUMER_KEY,
      PATENT_CONSUMER_SECRET_KEY: process.env.PATENT_CONSUMER_SECRET_KEY,
    } as Record<string, string>,
  });

  const client = new Client({ name: "integration-test", version: "0.1.0" });
  const connectStart = performance.now();
  await client.connect(transport);
  console.log(`✅ Connected in ${Math.round(performance.now() - connectStart)}ms\n`);

  const results: TestResult[] = [];

  let callCount = 0;

  async function test(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    validate?: Validator,
    ignoreIsError?: boolean
  ) {
    // Throttle: pause briefly every few calls to stay under EPO rate limits
    if (callCount > 0 && callCount % 4 === 0) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    callCount++;

    process.stdout.write(`  ${name} … `);
    try {
      const start = performance.now();
      const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
      const durationMs = Math.round(performance.now() - start);

      const errorMsg =
        !ignoreIsError && isError(result)
          ? getText(result)
          : validate?.(result) ?? null;

      const passed = !errorMsg;
      console.log(passed ? `✅ ${durationMs}ms` : `❌ ${durationMs}ms`);
      if (!passed) console.log(`    → ${errorMsg}`);

      results.push({ name, tool, passed, durationMs, error: errorMsg ?? undefined });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`❌ threw`);
      console.log(`    → ${msg}`);
      results.push({ name, tool, passed: false, durationMs: 0, error: msg });
    }
  }

  try {
    await fn({ client, results, test });
  } finally {
    await client.close();
  }

  /* --- Summary --- */
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

  console.log();
  console.log(`${scenarioName}: ${passed}/${results.length} passed, ${failed} failed (${totalMs}ms total)`);

  const sorted = [...results].sort((a, b) => b.durationMs - a.durationMs);
  const maxLen = Math.max(...sorted.map((r) => r.name.length));
  for (const r of sorted) {
    const status = r.passed ? "✅" : "❌";
    console.log(`  ${status} ${r.name.padEnd(maxLen)}  ${String(r.durationMs).padStart(5)}ms`);
  }

  if (failed > 0) {
    console.log("\nFailures:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ❌ ${r.name}: ${r.error}`);
    }
  }

  return { passed, failed, results };
}
