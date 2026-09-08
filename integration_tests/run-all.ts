/**
 * Run all integration test scenarios sequentially.
 *
 * Usage:
 *   npx tsx integration_tests/run-all.ts
 *   npx tsx integration_tests/run-all.ts pembrolizumab   # filter by name
 */

import { execSync } from "child_process";
import { readdirSync } from "fs";
import { resolve } from "path";

const dir = resolve(__dirname);
const filter = process.argv[2]?.toLowerCase();

const scenarios = readdirSync(dir)
  .filter((f) => f.endsWith(".ts") && f !== "harness.ts" && f !== "run-all.ts")
  .filter((f) => !filter || f.toLowerCase().includes(filter))
  .sort();

if (scenarios.length === 0) {
  console.log(`No scenarios found${filter ? ` matching "${filter}"` : ""}`);
  process.exit(1);
}

console.log(`Running ${scenarios.length} scenario(s):\n  ${scenarios.join("\n  ")}\n`);

let totalPassed = 0;
let totalFailed = 0;

for (let i = 0; i < scenarios.length; i++) {
  // Wait between scenarios to avoid EPO rate limiting (they throttle rapid bursts)
  if (i > 0) {
    const wait = 60;
    process.stdout.write(`\n⏳ Waiting ${wait}s for EPO rate limit cooldown…\n`);
    execSync(`sleep ${wait}`);
  }

  const path = resolve(dir, scenarios[i]);
  try {
    execSync(`npx tsx "${path}"`, {
      stdio: "inherit",
      env: process.env,
    });
    totalPassed++;
  } catch {
    totalFailed++;
  }
}

console.log(`\n${"═".repeat(78)}`);
console.log(`  All scenarios: ${totalPassed} passed, ${totalFailed} failed`);
console.log(`${"═".repeat(78)}`);

process.exit(totalFailed > 0 ? 1 : 0);
