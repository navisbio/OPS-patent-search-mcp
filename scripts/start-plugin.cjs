#!/usr/bin/env node
// Development checkouts use their build; installed Git plugins use the matching npm release.
const { existsSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawn } = require('node:child_process');
const { name, version } = require('../package.json');

const root = resolve(__dirname, '..');
const entry = resolve(root, 'dist/index.js');
const local = existsSync(entry) && existsSync(resolve(root, 'node_modules/@modelcontextprotocol/sdk/package.json'));
const windows = process.platform === 'win32';
const child = spawn(local ? process.execPath : (windows ? 'npx.cmd' : 'npx'),
  local ? [entry] : ['--yes', `${name}@${version}`],
  { stdio: 'inherit', env: process.env, shell: !local && windows });
child.on('error', error => { console.error(`Unable to start patent MCP: ${error.message}`); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
