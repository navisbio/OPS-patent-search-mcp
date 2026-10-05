// Ask the built MCP server for its tools; source scanning misses dynamic registrations.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

const client = new Client({ name: 'smoketest-discovery', version: '1.0.0' });
try {
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [resolve(process.argv[2])],
    // Listing tools does not call OPS or require real credentials.
    env: { ...process.env, PATENT_CONSUMER_KEY: 'smoketest-discovery', PATENT_CONSUMER_SECRET_KEY: 'smoketest-discovery' },
  }));
  const { tools } = await client.listTools();
  if (!tools.length) throw new Error('No MCP tools registered');
  console.log(tools.map(tool => `mcp__plugin_ops-patent-search_ops-patent-search__${tool.name}`).sort().join(','));
} finally {
  await client.close();
}
