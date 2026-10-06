import { build } from "esbuild";
import { mkdirSync } from "fs";

mkdirSync("server", { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "server/bundle.cjs",
  // Mark nothing as external — bundle everything including the MCP SDK and zod
  external: [],
  minify: false,
  sourcemap: false,
});

console.log("Bundle written to server/bundle.cjs");
