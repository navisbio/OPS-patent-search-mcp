# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run build      # Compile TypeScript → dist/
npm run dev        # Run directly with tsx (no build required)
npm run start      # Run compiled dist/index.js
npm test           # Run integration tests against live EPO OPS API (requires credentials in .env)
```

Tests require valid `PATENT_CONSUMER_KEY` and `PATENT_CONSUMER_SECRET_KEY` env vars and make real API calls.

## Architecture

This is a 3-file MCP server published as `ops-patent-search` on npm.

**[src/epo-client.ts](src/epo-client.ts)** — HTTP client for the EPO OPS REST API (`https://ops.epo.org/3.2/rest-services`). Handles OAuth2 `client_credentials` token acquisition and caching (with 60s pre-expiry refresh). Throws `OpsApiError` with human-readable messages parsed from OPS XML error responses instead of raw XML.

**[src/parsers.ts](src/parsers.ts)** — Transforms deeply nested/inconsistent OPS JSON into clean typed objects. Key exports:
- `parseSearchResults` / `parseBiblio` / `parseFamilyMembers` — structured metadata
- `parseFulltextParagraphs` — converts claims/description JSON into `Paragraph[]` with character offsets (`startChar`/`endChar`) for positional navigation
- `paginateParagraphs` — slices a paragraph array by offset+limit+maxCharacters, returns `nextOffset` for continuation
- `searchKeywordsInParagraphs` — regex-based keyword search across paragraphs, returns snippets with `paragraphIndex` usable as `offset` in the reading tools

**[src/index.ts](src/index.ts)** — MCP server wiring. Defines 8 tools using `@modelcontextprotocol/sdk` and `zod` for parameter schemas. Runs on stdio transport. Tool descriptions contain the LLM-facing instructions for when/how to use each tool.

Tools: `search_patents`, `get_patent_details`, `get_patent_claims`, `get_patent_description`, `search_in_patent_text`, `get_patent_family`, `get_patent_legal_status`, `get_patent_citations`.

## Key design constraints

- **Pagination everywhere**: Full patent descriptions can be 50K–100K+ characters. `get_patent_claims` and `get_patent_description` always paginate via `offset`/`limit`/`max_characters`. The `search_in_patent_text` tool exists so the LLM can locate relevant paragraphs before doing expensive full reads.
- **Family fallback**: `get_patent_claims`, `get_patent_description`, and `search_in_patent_text` have `fallback_to_family=true` by default. On a 404, `fetchWithFamilyFallback` (in `index.ts`) looks up the INPADOC family and retries against EP/WO/GB/DE/FR members in priority order using docdb format.
- **404 = no results, not an error**: `search_patents` catches `OpsApiError` with status 404 and returns `{totalCount: 0, results: []}` instead of propagating.
- **Document number formats**: EPO OPS accepts `epodoc` (e.g. `EP1000000`), `docdb` (e.g. `EP.1000000.A1` with kind code), and `original`. Full text often requires `docdb` with an explicit kind code.
- **Environment variables**: `PATENT_CONSUMER_KEY` and `PATENT_CONSUMER_SECRET_KEY` — the server exits immediately on startup if either is missing. Optional: `OPS_TOOL_TIMEOUT_MS` (default 55000) — total time budget per tool call. The server tracks the clock and bails with an actionable error before the MCP client timeout hits. Raise to e.g. 120000 for Claude Code or other clients with longer timeouts.
- **Forward citations via search**: Forward citations (patents citing a document) are retrieved via `search_patents` with CQL `ct="EP1000000"`, not a dedicated endpoint. `get_patent_citations` covers backward citations only.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


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
