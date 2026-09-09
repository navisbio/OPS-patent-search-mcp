---
description: |
  Guides Claude through building a patent citation network and
  technology genealogy using the Espacenet patent tools. Teaches
  backward citation retrieval, forward citation search via CQL,
  seminal patent identification, and technology evolution mapping.
  Produces a citation tree and technology timeline. Triggers on:
  citation network, patent citations, citation analysis, technology
  genealogy, citation tree, seminal patents, key patents in field,
  who cites this patent, prior art tree, patent influence, technology
  evolution, citation mapping.
---

# Citation Network & Technology Genealogy Skill

You are building a patent citation network to trace the evolution of a
technology and identify the most influential patents in a field. This
uses both backward citations (what a patent cites) and forward citations
(what cites a patent) to reveal the structure of innovation.

## Workflow Overview

```
Seed patent(s)
  --> Backward citations (prior art references)
    --> Forward citations (who cites this patent)
      --> Identify hub patents (most cited)
        --> Expand hubs (their citations in both directions)
          --> Read abstracts of key nodes
            --> Map technology evolution timeline
              --> Citation network report
```

## Concepts

- **Backward citations**: Patents and literature cited IN a patent (its prior art references). Retrieved via `get_patent_citations`.
- **Forward citations**: Patents that CITE a given patent. Retrieved via `search_patents` with CQL `ct="EP1000000"`.
- **Hub patent / seminal patent**: A patent with an unusually high number of forward citations — indicates foundational importance.
- **Citation depth**: How many generations of citations you trace (depth 1 = direct citations only, depth 2 = citations of citations).


## Step 0: Identify Patent Family Context

**Before any citation analysis**, run `get_patent_family` on the seed patent to determine if it is a WO (PCT), EP divisional, US continuation, or national phase entry. This is critical because:

- Forward citations concentrate on the **parent WO/PCT publication**, not divisionals or national phase entries
- EP3401400 (a divisional) has a handful of forward citations while its parent WO2013176772 has hundreds; the exact numbers grow over time, so always measure with count_only rather than quoting a figure
- If the seed is a divisional/national phase, **redirect forward citation analysis to the parent WO** for meaningful results

```
get_patent_family(document_number="EP3401400")
```

Identify the WO publication in the family, and use that as the primary seed for forward citation counts.

## Step 1: Select Seed Patent(s)

The analysis starts from one or more seed patents. These can come from:
- A patent the user provides directly
- Top results from a prior art search
- A known foundational patent in the field

If the user describes a technology area rather than specific patents, run a targeted search first:

```
search_patents(query='ta="CRISPR" AND ta="Cas9" AND ta="gene editing"', detail_level="compact")
```

Pick 1-3 highly relevant patents as seeds. Prefer patents that are:
- From the core time period of interest
- From major applicants in the field
- Frequently discussed in the technology area

## Step 2: Retrieve Backward Citations

For each seed patent, get its backward citations (prior art):

```
get_patent_citations(document_number="EP3401400")
```

This returns:
- **Patent citations**: Publication numbers and titles of cited patents
- **NPL citations**: Non-patent literature (journal articles, conference papers)
- **Citation categories**: Some citations are marked as "X" (particularly relevant), "Y" (relevant in combination), "A" (general background) by the examiner

Note the total count. Typical ranges:
- **5-20 citations**: Normal for a focused patent
- **50-100+ citations**: Common for US patents (broader duty of disclosure)
- **Very few citations**: May be an early/pioneering patent in the field

## Step 3: Retrieve Forward Citations

For each seed patent, find patents that cite it:

```
search_patents(query='ct="EP3401400"', count_only=true)
```

Then retrieve the results:

```
search_patents(query='ct="EP3401400"', detail_level="compact", auto_paginate=true, max_results=200)
```

The forward citation count is a key measure of influence:
- **0-5 forward citations**: Limited influence (niche patent or very recent)
- **10-50**: Significant patent in the field
- **100+**: Seminal / foundational patent
- **500+**: Field-defining (rare)

## Step 4: Identify Hub Patents

From both backward and forward citation data, identify hub patents:

1. **Backward hubs**: Patents that appear in multiple seed patents' backward citations — the shared prior art foundation
2. **Forward hubs**: Patents with the highest forward citation counts — the most influential

To check if a backward citation is itself highly cited:

```
search_patents(query='ct="US5580859"', count_only=true)
```

Rank patents by combined importance:
- Forward citation count (primary signal)
- Appearance in multiple citation lists (network centrality)
- Applicant/inventor prominence
- Priority date (earlier = more foundational)

## Step 5: Expand Key Hubs (Depth 2)

For the top 3-5 hub patents, retrieve their citations in both directions:

```
get_patent_citations(document_number="US5580859")
search_patents(query='ct="US5580859"', detail_level="compact", auto_paginate=true, max_results=100)
```

This reveals:
- **Predecessors of predecessors**: The deepest roots of the technology
- **Second-generation derivatives**: How the technology branched and evolved

**Limit depth to 2** for practical analysis. Depth 3+ grows exponentially and adds diminishing value.

## Step 6: Read Key Abstracts and Biblio

For the most important nodes in the network (hubs, seeds, and notable outliers), retrieve abstracts:

```
get_patent_details(document_number="US5580859")
```

This gives you:
- Title and abstract (for understanding the technical contribution)
- Applicant (for mapping the competitive landscape)
- Filing/priority dates (for the timeline)
- Classifications (for technology clustering)

## Step 7: Build the Technology Timeline

Organize the citation network chronologically:

1. **Sort all identified patents by priority date** (earliest filing)
2. **Group into technology generations/eras**
3. **Map citation relationships** to show how each generation built on the previous
4. **Identify branching points** where the technology diverged into sub-fields

Example timeline structure:
```
1990-1995: Foundational work
  US5580859 (1990) — First demonstration of DNA vaccination
  ↓ cited by 847 patents

1996-2005: Core development
  US6110898 (1997) — mRNA optimization for in vivo delivery
  WO0011140 (1999) — Lipid nanoparticle delivery
  ↓ ↓

2006-2015: Platform maturation
  US8278036 (2008) — Modified nucleosides in mRNA
  EP2459231 (2010) — Self-amplifying RNA vaccines
  ↓ ↓ ↓

2016-present: Therapeutic applications
  WO2017070626 (2016) — mRNA cancer vaccine
  EP3718565 (2020) — SARS-CoV-2 mRNA vaccine
```

## Step 8: Compile the Citation Network Report

### Report Structure

1. **Network Summary**
   - Seed patent(s) analyzed
   - Total unique patents in network (backward + forward)
   - Depth of analysis
   - Date range covered

2. **Seminal Patents** (ranked by influence)
   For each hub patent:
   - Publication number, title, applicant, priority date
   - Forward citation count
   - Technical contribution (from abstract)
   - Position in the technology genealogy

3. **Technology Evolution Timeline**
   - Chronological mapping as described in Step 7
   - Key branching points and sub-fields
   - Recent trends (what's being built on now)

4. **Applicant / Competitive Landscape**
   - Top citing applicants (who is building on this technology)
   - Top cited applicants (who laid the foundation)
   - Collaboration patterns (co-citation clusters)

5. **Network Visualization** (text-based)
   - Citation flow diagram showing key patents and their relationships
   - Use arrows (→) to show citation direction
   - Group by technology era or sub-field

6. **Observations and Insights**
   - Technology maturity assessment (growing, plateau, declining based on citation trends)
   - White spaces (areas with few citations — potential opportunity)
   - Key inventor lineages (research group evolution)

## Important Notes

- **Forward citations via search**: The `ct=` CQL operator is the only way to get forward citations. It returns patents that cite the specified document. This is a `search_patents` query, not a dedicated endpoint.
- **Citation counts grow over time**: A 2023 patent will have fewer forward citations than a 2010 patent simply due to age. Normalize by publication year when comparing influence.
- **Examiner vs applicant citations**: European patents distinguish between citations added by the examiner (more relevant) and applicant (broader). US patents include all applicant-disclosed prior art, inflating backward citation counts.
- **NPL citations matter**: Non-patent literature citations (journal articles) often point to foundational scientific work. They can't be followed via patent tools but should be noted in the report.
- **Patent families**: Multiple publications of the same invention (EP, US, WO versions) are different documents but represent ONE invention. Use `get_patent_family` to deduplicate when counting unique inventions in the network.
- **Rate limits**: Each forward citation search is a separate API call. For networks with many nodes, prioritize the most-cited patents rather than exhaustively expanding every node.
- **NEVER characterize a patent's subject matter without retrieving its biblio.** Do not describe backward citations based on training knowledge — always call `get_patent_details` first. This is the #1 source of errors in citation network analysis. Use the `document_numbers` array parameter to verify up to 100 patents in one batch call.
- **NEVER describe companies from training knowledge.** Do not add phrases like "a pioneer in mRNA technology" or "a leading gene therapy company" — these are hallucination-prone. Only state what the patent data shows (e.g., "applicant on 5 patents in the network").
- **Distinguish family members from forward citations.** Before including a patent in the timeline, verify it is not in the same family as an already-listed patent by checking shared priority claims. EP divisionals, US continuations, and national phase entries of the same PCT are family members, not independent citations.
