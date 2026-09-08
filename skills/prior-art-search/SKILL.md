---
description: |
  Guides Claude through a structured prior art search workflow using the
  Espacenet patent tools. Teaches progressive drill-down: CQL query
  construction, result triage by abstract, keyword search in full text,
  paginated claim/description reading, and family expansion. Produces a
  structured prior art report. Triggers on: prior art search, patent
  novelty search, patentability search, find prior art, search patents
  for prior art, invalidate patent, anticipation search.
---

# Prior Art Search Skill

You are conducting a prior art search using the Espacenet patent tools.
Follow this structured workflow to find the most relevant prior art
efficiently without flooding context with full patent texts.

## Workflow Overview

```
Invention description
  --> Extract key concepts + classifications
    --> Build CQL queries (broad + narrow)
      --> Count results (size the landscape)
        --> Triage by title/abstract (compact view)
          --> Keyword search in top candidates' full text
            --> Paginated deep-read of relevant sections
              --> Family expansion for key hits
                --> Structured prior art report
```

## Step 1: Decompose the Invention

Before searching, break the user's invention description into:

1. **Core technical features** — the novel elements that distinguish this invention
2. **Broader field terms** — general technology area for landscape context
3. **Alternative terminology** — synonyms, abbreviations, related concepts
4. **Relevant IPC/CPC classes** — if known or inferable from the technology

For example, an invention described as "a bispecific antibody targeting PD-1 and LAG-3 for cancer treatment" decomposes to:
- Core: bispecific antibody, PD-1, LAG-3
- Broader: immunotherapy, checkpoint inhibitor, cancer
- Alternatives: PD1, PDCD1, CD279 (for PD-1); LAG3, CD223 (for LAG-3); bispecific, bifunctional
- Classes: C07K16/ (immunoglobulins), A61P35/ (antineoplastics)

## Step 2: Build CQL Queries

Construct 2-4 CQL queries of decreasing specificity:

1. **Narrow query**: All core features combined — targets closest prior art
2. **Medium query**: Core features with OR alternatives — catches variant terminology
3. **Broad query**: Broader field terms + key feature — maps the landscape
4. **Classification query**: IPC/CPC class + key terms — catches non-obvious wording

> Load the CQL syntax reference for detailed field codes, operators, and examples:
> [CQL Syntax Reference](references/cql-syntax.md)

### Query construction rules

- Use `ta=` (title + abstract) for concept searches — broader than `ti=` alone
- **Do NOT rely on `claims=` or `ftxt=` for phrase-level filtering** — these CQL full-text fields are unreliable for phrases and don't support wildcards. Use `ta=` for CQL filtering, then `search_in_patent_text` for full-text keyword search in specific patents.
- Wildcards: `*` for right truncation only (`antibod*` matches antibody, antibodies) — only works on `ta=`, `ti=`, `ab=`, `pa=`, `in=` fields, NOT on full-text or classification fields
- Phrases: double quotes (`ta="bispecific antibody"`)
- Operators: `AND`, `OR`, `NOT` — MUST be uppercase
- Applicant search: use wildcards (`pa="ROCHE*"` catches Roche, Roche Holding, etc.)
- Date filtering: use `published_after`/`published_before` parameters, not CQL `pd=`

## Step 3: Size the Landscape

For each query, start with `count_only=true`:

```
search_patents(query="ta=\"bispecific antibody\" AND ta=\"PD-1\" AND ta=\"LAG-3\"", count_only=true)
```

This costs only 1 API call and tells you:
- **0 results**: Query too narrow — relax terms
- **1-50 results**: Perfect for full detail retrieval
- **50-500 results**: Use `detail_level="compact"` to triage
- **500-2000 results**: Use `detail_level="summary"` first for landscape stats, then narrow
- **2000+ results**: Query too broad — add terms or date ranges before retrieving

## Step 4: Triage by Abstract

Retrieve results with appropriate detail level:

- **< 25 results**: `detail_level="full"` — read all titles and abstracts inline
- **25-200 results**: `detail_level="compact"` with `auto_paginate=true` — scan titles to pick candidates, then `get_patent_details` for promising ones
- **200+ results**: `detail_level="summary"` with `auto_paginate=true` — review landscape stats (top applicants, year distribution, classifications), then narrow query

From the results, identify **5-15 top candidates** based on title/abstract relevance.

## Step 5: Keyword Search in Full Text

For each top candidate, use `search_in_patent_text` before reading full text:

```
search_in_patent_text(
  document_number="EP3750919",
  search_terms=["bispecific", "PD-1", "LAG-3", "binding domain"]
)
```

This returns:
- Match count and locations with `sectionOffset` (the offset to use with the reading tools)
- Context snippets around each match
- Which section (claims vs description) contains each match

**Skip full-text reading for patents with 0 matches** on your key terms — they're unlikely to be relevant prior art even if the abstract seemed promising.

**Check all document types:** Don't search only WO publications. Include EP granted patents (B1/B2 kind codes) and US patents — EP granted claims are narrower but legally definitive, and US patents/applications often contain the most detailed experimental data.

## Step 6: Deep-Read Relevant Sections

For patents with keyword matches, read the specific sections:

1. **Claims first** — claims define legal scope; if independent claims don't cover the invention, the patent is weaker prior art
2. **Description at match locations** — use the `sectionOffset` from keyword search matches where `section="description"` as `offset`

```
get_patent_claims(document_number="EP3750919", max_characters=15000)
get_patent_description(document_number="EP3750919", offset=42, max_characters=10000)
```

**Extract actual data, don't just identify existence.** When `search_in_patent_text` finds relevant matches, always follow up with `get_patent_description` at the matched `sectionOffset` to read the actual passage. Report specific numbers, endpoints, and technical details — not just "this patent discusses [topic]".

**Follow cross-references.** Patents frequently cite other documents inline (e.g., "as described in US2017/0137537" or "see US Patent Application No. 15/470,647"). When a passage references another document as the primary source of data, fetch that document too — the cross-referenced document often contains the detailed data.

Focus on:
- Independent claims (claim 1 is always independent)
- Passages discussing the specific combination/mechanism of interest
- Examples and experimental data that demonstrate the invention

## Step 7: Expand via Patent Families

For the most relevant hits, check family coverage:

```
get_patent_family(document_number="EP3750919")
```

This reveals:
- Whether the same invention is filed in multiple jurisdictions
- Different kind codes (A1=application, B1=granted) — granted versions have examined claims
- Priority dates — the earliest filing date establishes the prior art date

**Priority date matters**: A patent published in 2023 may have a priority date in 2020 — that earlier date is what counts for prior art purposes.

## Step 8: Compile the Report

Present findings as a structured prior art report:

### Report Structure

1. **Search Strategy Summary**
   - Queries used and result counts
   - Date range and geographic scope

2. **Most Relevant Prior Art** (ranked by relevance)
   For each patent:
   - Publication number and title
   - Applicant and priority date
   - Key claims that overlap with the invention
   - Specific passages describing similar features
   - How this affects novelty/non-obviousness

3. **Landscape Context**
   - Number of results in the field
   - Top applicants (potential competitors/partners)
   - Technology trend (filing volume by year)
   - Key classification areas

4. **Gaps and Recommendations**
   - What aspects of the invention were NOT found in prior art
   - Suggested additional searches (different terminology, classifications)
   - Jurisdictions to check for additional prior art

## Important Notes

- **NEVER inject training knowledge as fact.** Report ONLY information returned by the patent tools. Do not supplement with drug names (e.g. INN codes like "AZD2936"), clinical trial results, preclinical data, or mechanism details from your training data. If a piece of information isn't in the tool output, say "not available from patent data" rather than filling it in from memory.
- **NEVER describe companies from training knowledge.** Do not add phrases like "a leading pharmaceutical company" or "known for its oncology portfolio" — these are hallucination-prone. Only state what the patent data shows (e.g., "applicant on 12 results in this search").
- **Mandatory biblio verification.** Before including ANY patent in the final report, call `get_patent_details` to verify its title, applicant, and dates. Never rely solely on search result snippets for report-level citations. For batch efficiency, use the `document_numbers` array parameter to verify up to 100 patents in one call.
- **Priority dates are approximate.** The tools return priority claim numbers with filing dates when available. Use the date field if present; otherwise the year prefix in the number (e.g., "2017" in "US201762442642P") gives only the year — do NOT state specific days/months unless the date field confirms them.
- **Full text availability**: EP, WO, and US patents have the best full-text coverage in OPS. For JP, CN, KR patents, only bibliographic data and sometimes abstracts are available. The tools automatically fall back to family members when full text is unavailable.
- **Kind codes**: A1/A2 = published application, B1/B2 = granted patent. Granted patents have examined claims (narrower but legally stronger). Search results typically return the A1 version.
- **Don't over-read**: A patent description can be 100K+ characters. Always use keyword search first, then read targeted sections. Reading entire descriptions wastes context and API calls.
- **Forward citations**: To find patents that cite a known relevant patent, use `search_patents` with `ct="EP1000000"` — this is a powerful way to find related newer art.
- **CQL term gotchas**: Hyphens act as word boundaries, so `ta="PD-1"` and `ta="PD1"` return substantially different result sets and neither is a superset of the other. OR the variants (`ta="PD-1" OR ta="PD1"`, `ta="IL-6" OR ta="IL6"`) or you will silently miss part of the field.
