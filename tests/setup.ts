import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnvFile } from 'node:process';
import { execFileSync } from 'node:child_process';

const root = resolve(__dirname, '..');
const env = resolve(root, '.env');
if (existsSync(env)) loadEnvFile(env);
// Direct invocation and npm scripts must both test the current source revision.
execFileSync(process.execPath, [resolve(root, 'build-bundle.mjs')], { cwd: root, stdio: 'inherit' });
export const bundlePath = resolve(root, 'server/bundle.cjs');
