# ops-patent-search

Unofficial MCP server for exploring patents via the [EPO Open Patent Services (OPS)](https://www.epo.org/en/searching-for-patents/data/web-services/ops) API. **Not affiliated with the EPO.** Covers the full global patent database (EP, US, WO, JP, CN, and more).

This is an **exploratory tool** — useful for quick searches, reading individual patents, checking legal status, and getting an initial sense of a technology area. It works well in Claude Desktop and other consumer MCP clients, but these environments have limited context windows and are subject to API rate limits, so results for broad queries will be incomplete.

For exhaustive patent landscape analysis, systematic FTO assessments, or large-scale prior art searches, use specialised frameworks designed for parallel retrieval and structured knowledge bases.

## Tools

| Tool | Description |
|---|---|
| `search_patents` | CQL search across title, abstract, applicant, inventor, IPC/CPC, dates, and forward citations. Supports auto-pagination for landscape searches. |
| `get_patent_details` | Title, abstract, applicants, inventors, classifications, dates, priorities. Batch mode up to 100 patents. |
| `get_patent_claims` | Paginated claims text. Auto-falls back to EP/WO family equivalent if needed. |
| `get_patent_description` | Paginated specification text. Same family fallback as claims. |
| `search_in_patent_text` | Keyword search within claims + description. Returns snippets with paragraph indexes for targeted reading. |
| `search_and_filter_fulltext` | Search, then keep only the hits whose claims or description actually contain your terms. One call instead of a search plus one full-text call per hit. |
| `get_patent_family` | INPADOC patent family members across jurisdictions. |
| `get_patent_legal_status` | Grant, opposition, lapse, withdrawal events. Determines whether a patent is in force. |
| `get_patent_citations` | Backward citations (prior art) split into patent and non-patent literature. |

## Setup

1. Register at [developers.epo.org](https://developers.epo.org/) for a Consumer Key and Secret (free tier available).

2. Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "ops-patent-search": {
      "command": "npx",
      "args": ["-y", "ops-patent-search"],
      "env": {
        "PATENT_CONSUMER_KEY": "your_consumer_key",
        "PATENT_CONSUMER_SECRET_KEY": "your_consumer_secret"
      }
    }
  }
}
```

## CQL query syntax

The `search_patents` tool uses EPO's [CQL (Contextual Query Language)](https://worldwide.espacenet.com/help?topic=smartsearch&locale=en_EP). Key fields:

`ta` (title+abstract), `ti` (title), `ab` (abstract), `pa` (applicant), `in` (inventor), `cl` (IPC+CPC), `ic` (IPC), `cpc` (CPC), `pd` (publication date), `pn` (publication number), `ct` (forward citations).

Operators: `AND`, `OR`, `NOT` (uppercase). Wildcards: `*` (right truncation, on `ta`/`ti`/`ab`/`pa`/`in` only).

```
ta="CRISPR" AND pd>=2023
pa="Novartis*" AND ta="cancer" AND ic="A61K"
ta="antibody drug conjugate" AND pa="Roche*"
ct="EP3750919"
```

> Full-text fields (`claims`, `desc`, `ftxt`) are unreliable for phrase searches and don't support wildcards. Use `ta=` for CQL filtering, then `search_in_patent_text` for keyword analysis within specific patents.

## Examples

```
Search for CRISPR patents by the Broad Institute since 2020 and summarise the top 5.
```
```
Is EP3750919 currently in force? Check its legal status.
```
```
Find prior art on antibody-drug conjugates targeting HER2 by Roche. Search the most relevant result for 'linker' and summarise the key claims.
```

## Skills (Claude Code plugin)

When installed as a Claude Code plugin, guided workflow skills become available. These provide structured starting points for common patent tasks — but keep in mind this is an exploratory tool, not a substitute for professional patent search platforms.

| Skill | Description |
|---|---|
| **Prior Art Search** | Guided CQL query construction, result triage, keyword search in full text |
| **Patent Landscape** | Sample-based overview of a technology area — top applicants, filing trends, classification clusters |
| **FTO Analysis** | Spot-check in-force patents and map claims against product features (not exhaustive) |
| **Citation Network** | Explore backward/forward citations and identify key patents in a citation chain |
| **LOE Analysis** | Look up patent family coverage, legal status, and expiry timelines for a compound |

## Development

```bash
npm install
npm run build              # Compile TypeScript → dist/
npm test                   # Integration tests (requires PATENT_CONSUMER_KEY and PATENT_CONSUMER_SECRET_KEY in .env)
```

**Scenario tests:**
```bash
npx tsx integration_tests/run-all.ts
```

**Smoketest** (end-to-end eval harness via headless Claude Code):
```bash
./smoketest/run.sh                    # all tests
./smoketest/run.sh basic-search       # single test
```

Each smoketest runs a 3-message conversation: execute the task using the MCP tools, verify entities against the database (hallucination check), then collect structured feedback on what worked and what should be improved. Results land in `smoketest/results/` as `.task.txt`, `.hallucination.txt`, and `.feedback.txt` per test.

The feedback is used to guide development — a human reviews the feedback files and decides what to act on. This step is intentionally manual: the eval agents tend to flag non-issues when they run out of real problems, so triage requires human sign-off.

**Run as Claude Code plugin (local dev):**
```bash
claude --plugin-dir /path/to/ops-patent-search
```

`.mcp.json` is the *plugin* server manifest: its `${CLAUDE_PLUGIN_ROOT}` path is only expanded when the server is loaded as a plugin. Enabling it as a plain project MCP server instead leaves the variable unexpanded and the server exits with `Cannot find module '.../${CLAUDE_PLUGIN_ROOT}/dist/index.js'`. Use `--plugin-dir` as above, or register a separate absolute-path server with `claude mcp add`.

## What must never be committed

This is a **public** repository. The following stay local and are enforced by
both `.gitignore` and a `pre-commit` hook in `.githooks/`:

| Path | Why |
|---|---|
| `.env` | EPO OPS credentials |
| `.claude/` | local permission grants and machine paths |
| `.beads/`, `.dolt/` | issue tracker database — never synced to this remote |
| `docs/` | internal write-ups and client-adjacent analyses |
| `smoketest/results/` | full evaluator transcripts naming real companies |
| `*.mcpb`, `dist/`, `server/` | build output |

`.claude-plugin/` is **not** in this list — it ships with the plugin.

The hook also scans staged content for credential-shaped strings and for
client-identifying terms, so scenario prompts and examples stay generic. The
term list itself is **not** in the repo — a curated list of client names would
be the disclosure. Put it in `.githooks/client-terms.local` (gitignored), one
regex per line; without that file the term check is inactive and the hook says
so. The hook is enabled automatically by `npm install`; to enable it by hand:

```bash
git config core.hooksPath .githooks
```

A deliberate exception for one commit: `ALLOW_SENSITIVE=1 git commit ...`

## Privacy

This server communicates only with the EPO OPS API (`ops.epo.org`) using your credentials. No data is collected or sent to third parties.

## License

MIT
