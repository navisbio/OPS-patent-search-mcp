/**
 * Shared helpers for OPS patent-search integration tests.
 *
 * Spawns the server bundle and connects via MCP stdio transport.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { resolve } from "path";

export const TEST_PATENT = "EP3750919"; // Referenced in code examples — CRISPR-related
export const TEST_SEARCH_QUERY = 'ta="CRISPR" AND pa="Broad*" AND pd>=2018';

export type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

export interface TestResult {
  name: string;
  tool: string;
  passed: boolean;
  durationMs: number;
  error?: string;
  preview?: string;
}

export type TestFn = (
  name: string,
  tool: string,
  args: Record<string, unknown>,
  validate?: (r: ToolResult) => string | null, // return null = pass, string = failure reason
  ignoreIsError?: boolean // when true, skip isError check and always run validate
) => Promise<void>;

export type ToolTestSuite = (client: Client, test: TestFn) => Promise<void>;

export async function callTool(
  client: Client,
  tool: string,
  args: Record<string, unknown>
): Promise<{ result: ToolResult; durationMs: number }> {
  const start = performance.now();
  const result = (await client.callTool({ name: tool, arguments: args })) as ToolResult;
  const durationMs = Math.round(performance.now() - start);
  return { result, durationMs };
}

export function preview(result: ToolResult, maxChars = 120): string {
  const text = result.content?.[0]?.text ?? "";
  const trimmed = text.slice(0, maxChars);
  return trimmed.length < text.length ? trimmed + "…" : trimmed;
}

export function isError(result: ToolResult): boolean {
  return result.isError === true || result.content?.[0]?.text?.startsWith("Error:") === true;
}

export function createTestRunner(client: Client, results: TestResult[]): TestFn {
  return async function test(
    name: string,
    tool: string,
    args: Record<string, unknown>,
    validate?: (r: ToolResult) => string | null,
    ignoreIsError?: boolean
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
  };
}

export async function connectClient(): Promise<Client> {
  if (!process.env.PATENT_CONSUMER_KEY || !process.env.PATENT_CONSUMER_SECRET_KEY) {
    console.error("❌  Missing PATENT_CONSUMER_KEY or PATENT_CONSUMER_SECRET_KEY env vars");
    process.exit(1);
  }

  const bundlePath = resolve(__dirname, "../server/bundle.cjs");

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
  await client.connect(transport);
  return client;
}
