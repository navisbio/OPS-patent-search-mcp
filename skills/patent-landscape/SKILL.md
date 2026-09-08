---
description: |
  Guides Claude through a patent landscape analysis using the Espacenet
  patent tools. Teaches exhaustive retrieval with auto_paginate and year
  decomposition, landscape statistics (top applicants, filing trends,
  classification clusters), and progressive drill-down from summary to
  detail. Produces a structured landscape report with quantitative
  analytics. Triggers on: patent landscape, landscape analysis, patent
  map, technology landscape, competitive landscape, who is filing in,
  patent trends, filing trends, top applicants, patent analytics,
  technology mapping, white space analysis, patent portfolio analysis.
---

# Patent Landscape Analysis Skill

You are conducting a patent landscape analysis using the Espacenet patent
tools. A landscape analysis maps the patent activity across a technology
field to reveal who is filing, where the technology is heading, and where
gaps exist.

## Workflow Overview

```
Technology field definition
  --> Build scoping CQL queries
    --> Count results (size the landscape)
      --> Exhaustive retrieval with auto_paginate + summary
        --> Analyze: top applicants, year trends, classifications
          --> Narrow into sub-segments for deeper analysis
            --> Drill down on key patents/applicants
              --> Structured landscape report
```

## Step 1: Define the Technology Field

Work with the user to define the scope:

1. **Core technology** — the central technology or product type
2. **Boundaries** — what to include/exclude (e.g., include drug delivery, exclude diagnostics)
3. **Time frame** — typically 5-20 years depending on the field's maturity
4. **Geographic scope** — worldwide (default) or specific offices

Translate these into CQL building blocks:
- **Keywords**: title/abstract terms (`ta=`)
- **Classifications**: IPC/CPC codes for the technology area
- **Applicant scope**: all applicants (default) or specific competitors

> For CQL field codes, operators, and examples, load the reference:
> [CQL Syntax Reference](../prior-art-search/references/cql-syntax.md)

## Step 2: Build Scoping Queries

Create 2-3 queries that define the landscape boundaries:

1. **Core query**: The tightest definition of the technology
2. **Broad query**: Wider scope to catch adjacent innovation
3. **Classification query**: IPC/CPC based (catches different terminology)

Example for "mRNA vaccine delivery":
```
Core:  ta="mRNA" AND ta="vaccine" AND ta="lipid nanoparticle"
Broad: ta="mRNA" AND (ta="vaccine" OR ta="immunization") AND ta="delivery"
Class: ic="A61K48/" AND ta="mRNA" AND ta="nanoparticle"
```

## Step 3: Size the Landscape

Count each query first with `count_only=true`:

```
search_patents(query='ta="mRNA" AND ta="vaccine" AND ta="lipid nanoparticle"', count_only=true)
```

This tells you:
- **< 25**: Small landscape — can retrieve everything in full detail
- **25-2000**: Medium landscape — use `detail_level="compact"` with `auto_paginate=true`
- **2000+**: Large landscape — use `detail_level="summary"` with `auto_paginate=true` for statistics, then narrow into segments

**Always report the counts to the user before proceeding** — the landscape size determines the entire analysis strategy.

## Step 4: Exhaustive Retrieval with Landscape Statistics

This is where the `auto_paginate` and `detail_level` features shine.

### For any landscape size — start with summary statistics:

```
search_patents(
  query='ta="mRNA" AND ta="vaccine" AND ta="lipid nanoparticle"',
  auto_paginate=true,
  detail_level="summary",
  max_results=5000
)
```

This returns aggregated statistics without flooding context:
- **Top applicants** with filing counts
- **Year distribution** — filing volume by year
- **Top classifications** — technology sub-areas

### For medium landscapes (200-2000) — add compact results:

```
search_patents(
  query='ta="mRNA" AND ta="vaccine" AND ta="lipid nanoparticle"',
  auto_paginate=true,
  detail_level="compact",
  max_results=2000
)
```

Returns title + applicant + date for every patent — enough for manual scanning.

### For large landscapes (2000+) — segment by time or sub-topic:

Auto_paginate with year decomposition handles this automatically, but for
better analysis, consider explicit segmentation:

```
# Recent 3 years in detail
search_patents(query='...', auto_paginate=true, detail_level="compact",
  published_after="2023", max_results=1000)

# Earlier years in summary only
search_patents(query='...', auto_paginate=true, detail_level="summary",
  published_after="2018", published_before="2022", max_results=5000)
```

## Step 5: Analyze the Landscape Statistics

From the summary/compact data, extract insights in these categories:

### 5a. Applicant Analysis
- **Top 10-20 applicants** by filing volume
- **Market share** — what percentage of total filings does each top applicant hold?
- **Applicant type** — corporate vs. academic vs. government
- **Emerging filers** — new entrants in recent 2-3 years

Note: Applicant names vary (e.g., "MODERNA INC", "MODERNA TX INC", "MODERNATX INC"). The tool normalizes common variants, but flag any suspected duplicates.

### 5b. Filing Trends
- **Overall trajectory** — growing, plateauing, or declining?
- **Inflection points** — years where filing volume jumped (correlate with technology breakthroughs or regulatory events)
- **Recent momentum** — are filings accelerating or decelerating in the last 2-3 years?

### 5c. Technology Segmentation
- **Top IPC/CPC subclasses** — what technology sub-areas are most active?
- **Cross-classification** — patents spanning multiple classes indicate convergence
- **Under-represented classes** — potential white space

## Step 6: Deep Dives on Segments of Interest

Based on the landscape overview, drill into specific segments:

### Key applicant portfolios:
```
search_patents(query='pa="MODERNA*" AND ta="mRNA" AND ta="vaccine"',
  auto_paginate=true, detail_level="compact")
```

### Emerging sub-technologies:
```
search_patents(query='ta="mRNA" AND ta="self-amplifying" AND ta="vaccine"',
  detail_level="full")
```

### Recent hot spots:
```
search_patents(query='ta="mRNA" AND ta="vaccine" AND ta="lipid nanoparticle"',
  published_after="2024", detail_level="full")
```

For the most interesting patents, get full bibliographic data:
```
get_patent_details(document_number="WO2023123456")
```

## Step 7: Compile the Landscape Report

### Report Structure

1. **Executive Summary**
   - Technology field and scope
   - Total patents in landscape and time frame
   - Key finding: top 3 insights

2. **Landscape Overview**
   - Total filing volume and growth trajectory
   - Year-over-year filing trend (table or description)
   - Geographic distribution (if relevant)

3. **Applicant Analysis**
   - Top 10-20 applicants with filing counts
   - Market concentration (do top 5 hold >50%?)
   - Applicant categories (pharma, biotech, academic, etc.)
   - New entrants in last 2-3 years

4. **Technology Segmentation**
   - Top classification areas with descriptions
   - Sub-technology trends
   - Convergence areas (multi-class patents)

5. **Temporal Analysis**
   - Filing trend by year
   - Key inflection points and likely causes
   - Forecast direction (based on recent trajectory)

6. **Key Patents**
   - 5-10 notable patents with publication numbers, titles, applicants
   - Why each is significant (earliest, most cited, broadest claims, etc.)

7. **White Spaces and Opportunities**
   - Under-patented sub-areas within the field
   - Technology combinations not yet explored
   - Geographic gaps (filed in US/EP but not CN/JP or vice versa)

8. **Methodology**
   - CQL queries used
   - Date ranges and result counts
   - Known limitations (e.g., recent filings not yet published, non-English patent coverage)

## Important Notes

- **Publication delay**: Patents are typically published 18 months after filing. The most recent 18 months of filing activity is invisible.
- **Applicant normalization**: The tool normalizes common corporate name variants (CORP/CORPORATION, UNIV/UNIVERSITY, strips country suffixes), but check for remaining duplicates (e.g., parent company vs. subsidiary, CJK name variants).
- **Summary applicant counts ≠ pa= verification counts.** The `topApplicants` counts in summary mode come from the search query's scope. If you verify with a separate `pa="X" AND ta="Y"` query, you may get a different count because the query scope differs. Always match the exact same CQL when verifying. This is the most common source of "double counting."
- **Estimated families.** The tool now returns `estimatedFamilies` based on title deduplication. This is approximate — use it as a rough guide, not an exact count. For precise family counts, use `get_patent_family` on individual patents.
- **OPS 2000-result limit**: `auto_paginate` with year decomposition handles this automatically for queries up to ~10,000+ results.
- **Quality over quantity**: A landscape with 500 well-characterized patents is more valuable than 5,000 titles. Use the funnel: summary → compact → full detail on key patents.
- **Classification search complements keyword search**: Some patents use different terminology but the same IPC/CPC classes. Always include at least one classification-based query. Note: `ic="A61K48/"` may not work as a wildcard prefix — use specific subgroups like `ic="A61K48/00"` or combine with `ta=` terms.
- **Pagination caps and incomplete coverage**: When `auto_paginate` retrieves fewer results than the total count (e.g., 200 of 658), the summary statistics are based on the retrieved subset only. Explicitly note this limitation in the report. Check whether non-dominant applicants from the landscape summary were missed by doing targeted `pa=` searches for any applicants with significant filing counts that weren't covered in the deep-dive phase.
- **CQL full-text field limitations**: The full-text CQL fields (`claims=`, `desc=`, `ftxt=`) are unreliable for phrase searches and don't support wildcards. Use `ta=` for CQL filtering. For post-retrieval keyword analysis in specific patents, use `search_in_patent_text`.
- **NEVER describe companies from training knowledge.** Do not add phrases like "a leading pharmaceutical company" or "known for its oncology portfolio" — these are hallucination-prone. Only state what the patent data shows (e.g., "top filer with 45 results").
- **Mandatory biblio verification.** Before including ANY patent in the final report's "Key Patents" section, call `get_patent_details` to verify its title, applicant, and dates. For batch efficiency, use the `document_numbers` array parameter to verify up to 100 patents in one call.
- **Spot-check your results.** After producing the report, verify 5-10 patent numbers with `get_patent_details` and 3-5 applicant counts with targeted `pa=` searches as a quality gate.
