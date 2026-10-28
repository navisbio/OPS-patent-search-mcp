import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = file => JSON.parse(readFileSync(join(root, file), 'utf8'));
const pkg = read('package.json');
const manifest = read('manifest.json');
for (const file of ['manifest.json', '.claude-plugin/plugin.json', 'package-lock.json']) {
  assert.equal(read(file).version, pkg.version, `Version mismatch in ${file}`);
}
assert.equal(read('package-lock.json').packages[''].version, pkg.version);
const expected = manifest.tools.map(t => t.name).sort();
assert.equal(expected.length, 9);

async function inspect(entry, extraEnv = {}) {
  const client = new Client({ name: 'release-check', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry],
      env: { ...process.env, PATENT_CONSUMER_KEY: 'release-check', PATENT_CONSUMER_SECRET_KEY: 'release-check', ...extraEnv },
      stderr: 'pipe',
    }));
    assert.equal(client.getServerVersion().version, pkg.version);
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), expected);
    for (const [name, args] of [
      ['search_in_patent_text', { document_number: 'EP1000001', search_terms: [''] }],
      ['search_and_filter_fulltext', { query: 'ta="test"', filter_terms: [' '] }],
    ]) {
      assert.equal((await client.callTool({ name, arguments: args })).isError, true);
    }
  } finally { await client.close(); }
}

for (const entry of ['dist/index.js', 'server/bundle.cjs', 'scripts/start-plugin.cjs']) await inspect(join(root, entry));

const temp = mkdtempSync(join(tmpdir(), 'ops-release-check-'));
try {
  // A Git-installed plugin has no build or node_modules. Verify the npm fallback
  // and its pinned version, then exercise the same MCP handshake through it.
  const plugin = join(temp, 'plugin'); const bin = join(temp, 'bin');
  mkdirSync(join(plugin, 'scripts'), { recursive: true }); mkdirSync(bin);
  copyFileSync(join(root, 'scripts/start-plugin.cjs'), join(plugin, 'scripts/start-plugin.cjs'));
  copyFileSync(join(root, 'package.json'), join(plugin, 'package.json'));
  if (process.platform !== 'win32') {
    writeFileSync(join(bin, 'npx'), `#!${process.execPath}\nrequire('node:assert/strict').deepEqual(process.argv.slice(2), ['--yes', ${JSON.stringify(`${pkg.name}@${pkg.version}`)}]);\nrequire(${JSON.stringify(join(root, 'dist/index.js'))});\n`, { mode: 0o755 });
    await inspect(join(plugin, 'scripts/start-plugin.cjs'), { PATH: `${bin}${delimiter}${process.env.PATH}` });
  }
  const packed = JSON.parse(execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--dry-run', '--ignore-scripts', '--json', '--cache', join(temp, 'npm-cache')], { cwd: root, encoding: 'utf8' }))[0];
  assert.ok(packed.files.some(file => file.path === 'dist/index.js'));
  for (const file of packed.files) assert.ok(file.path.startsWith('dist/') || ['package.json', 'README.md', 'LICENSE'].includes(file.path), `Unexpected npm package file: ${file.path}`);
  console.log(`Release ${pkg.version}: versions, nine tools, stdio startup, blank-term validation, plugin fallback and npm contents passed.`);
} finally { rmSync(temp, { recursive: true, force: true }); }
