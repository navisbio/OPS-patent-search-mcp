---
allowed-tools:
  - "mcp__plugin_ops-patent-search_ops-patent-search__*"
description: Run a structured prior art search for an invention and produce a report.
user-description: "Search patents for prior art related to an invention description"
argument-description: "Description of the invention to search prior art for"
---

# Prior Art Search

You are conducting a prior art search for the following invention:

$ARGUMENTS

## Instructions

Load and follow the prior-art-search skill workflow. Execute all steps
systematically:

1. **Decompose** the invention into core technical features, broader field
   terms, alternative terminology, and relevant IPC/CPC classifications.

2. **Build 2-4 CQL queries** of decreasing specificity (narrow → broad).

3. **Size each query** with `count_only=true` before retrieving results.

4. **Triage results** — use `detail_level="compact"` or `"summary"` for
   large result sets, `"full"` for small ones. Select 5-15 top candidates
   from title/abstract relevance.

5. **Keyword search** in the full text of top candidates using
   `search_in_patent_text`. Skip patents with 0 matches on core terms.

6. **Deep-read** claims and relevant description sections of the strongest
   matches. Quote specific claim language and description passages.

7. **Expand key hits** via `get_patent_family` to check jurisdictional
   coverage and identify the earliest priority dates.

8. **Compile** a structured prior art report with:
   - Search strategy summary (queries + counts)
   - Most relevant prior art (ranked, with cited claim text)
   - Landscape context (top applicants, filing trends)
   - Novelty assessment (what IS and IS NOT anticipated)
   - Recommendations for further searches

Be thorough but efficient. Use keyword search before full-text reading.
Present all patent data with publication numbers — never fabricate results.
