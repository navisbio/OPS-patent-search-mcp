---
description: |
  Guides Claude through a Freedom-to-Operate (FTO) patent claim analysis
  using the Espacenet patent tools. Teaches how to identify relevant
  in-force patents, read and map claims against product features, check
  legal status as a gatekeeper, and assess jurisdictional coverage via
  patent families. Produces a structured FTO risk assessment. Triggers on:
  freedom to operate, FTO analysis, patent infringement risk, claim
  analysis, patent clearance, design around, patent risk assessment,
  do we infringe, is this patented.
---

# Freedom-to-Operate (FTO) Analysis Skill

You are conducting a Freedom-to-Operate analysis using the Espacenet patent tools.
FTO analysis determines whether a product or process can be commercialized
without infringing active patent claims in the target markets.

**This is the highest-stakes patent workflow.** Be thorough and precise.
Every claim element matters — a patent is only infringed if ALL elements
of at least one independent claim are met.

## Workflow Overview

```
Product/process description
  --> Identify key features + target markets
    --> Search for relevant patents (CQL)
      --> Filter by legal status (in force only)
        --> Read independent claims of active patents
          --> Map claim elements to product features
            --> Check family coverage (jurisdictions)
              --> Assess risk level per patent
                --> FTO risk report
```

## Step 1: Define the Product and Markets

Before searching, extract from the user's description:

1. **Product features** — every technical element of the product/process
2. **Target markets** — jurisdictions where the product will be sold/used (e.g., US, EP, JP, CN)
3. **Technology classification** — IPC/CPC classes that cover this technology
4. **Key competitors** — known companies in the space whose patents to check

Example: "We want to launch an antibody-drug conjugate with a cleavable linker and a topoisomerase-I inhibitor payload for HER2-positive breast cancer in the US and EU"
- Features: antibody-drug conjugate, cleavable linker, topoisomerase-I inhibitor payload, HER2 target
- Markets: US, EP (and individual EU states)
- Classes: A61K47/68 (antibody conjugates), C07K16/32 (anti-HER2 antibodies), A61P35/00 (antineoplastics)
- Competitors: Daiichi Sankyo, AstraZeneca, Roche, etc.

## Step 2: Search for Potentially Relevant Patents

Build targeted CQL queries covering:

1. **Feature-based search**: core product features in claims
2. **Competitor patents**: known competitor + technology area
3. **Classification search**: relevant IPC/CPC + key terms

> For CQL syntax details, see the prior-art-search skill's CQL reference.

```
search_patents(query='ta="antibody drug conjugate" AND ta="linker"', count_only=true)
search_patents(query='pa="DAIICHI*" AND ta="antibody drug conjugate"', count_only=true)
search_patents(query='ic="A61K47/68" AND ta="topoisomerase"', count_only=true)
```

**For FTO, what matters is what's claimed, not what's described.** However, CQL full-text fields (`claims=`, `ftxt=`) are unreliable for phrase searches and don't support wildcards. Use `ta=` for CQL queries, then `search_in_patent_text` to search within claims of specific patents. Note: `cl=` searches IPC+CPC classification, NOT claims text.

Focus on patents published in the last 20 years (patents expire ~20 years from filing).

## Step 3: Legal Status Gatekeeper

**This is the critical filter.** Before reading claims in detail, check legal status:

```
get_patent_legal_status(document_number="EP1000000")
```

Classify each patent into:

| Status | Action | Why |
|--------|--------|-----|
| **Granted + In Force** | Full claim analysis required | Active legal risk |
| **Granted + Lapsed/Expired** | Low priority — note but skip deep analysis | No longer enforceable |
| **Pending Application** | Monitor — check claims but flag as uncertain | May never grant; claims may narrow |
| **Withdrawn/Refused** | Skip | No legal risk |

**Skip expired and withdrawn patents early** — they cannot be infringed regardless of claim scope. This saves significant API calls on full-text reading.

### Legal status interpretation

- Look for grant events (B1/B2 kind codes in family)
- Look for lapse/withdrawal events
- If no clear lapse event after grant, the patent is likely still in force
- SPC (Supplementary Protection Certificate) events can extend protection beyond 20 years for pharmaceuticals

## Step 4: Read Independent Claims

For each in-force patent, read the claims:

```
get_patent_claims(document_number="EP1000000", max_characters=15000)
```

**Important: Granted claims (B1/B2) are often not available via OPS full text.** The tool will warn you if no claims are found. In that case:
- Try the A1/A2 (application) version — these are as-filed claims, which may be broader than granted claims
- Use `get_patent_family` to find a WO equivalent with full text
- For definitive granted claims, recommend the user check Espacenet web or USPTO PAIR
- **Always flag in the report** when you're analyzing as-filed claims rather than granted claims

Focus on **independent claims only** (typically claims 1, ~10-15, and ~20-25 depending on the patent). Independent claims define the broadest scope of protection.

How to identify independent claims:
- They do NOT reference another claim number
- They typically start with "A method for...", "A composition comprising...", "A device for..."
- Dependent claims start with "The method of claim 1, wherein..." — these narrow scope and are less important for FTO

## Step 5: Element-by-Element Claim Mapping

For each independent claim, break it into individual elements and map against your product:

| Claim Element | Product Feature | Match? |
|---------------|-----------------|--------|
| "An antibody-drug conjugate" | Our ADC | Yes |
| "wherein the payload is an auristatin" | Our payload is a topoisomerase-I inhibitor | **No** |
| "for treating gastric cancer" | Our indication is HER2-positive breast cancer | **No** |

**Key principle: ALL elements must match for infringement.** If even one element of an independent claim doesn't match your product, that claim is NOT infringed. This is called the "all-elements rule."

If you need to verify specific technical terms in the description:

```
search_in_patent_text(
  document_number="EP1000000",
  search_terms=["cleavable linker", "topoisomerase", "auristatin", "maytansinoid"]
)
```

Then read around the matches to understand the patent's intended scope:

```
get_patent_description(document_number="EP1000000", offset=42, max_characters=8000)
```

## Step 6: Check Jurisdictional Coverage

For patents that DO pose a risk (claim elements match), check family coverage:

```
get_patent_family(document_number="EP1000000")
```

A patent only blocks you in jurisdictions where it's been filed AND granted:
- Filed in EP but not US? → No risk in the US market
- Filed in US but lapsed in EP? → No risk in Europe
- National phase entries from a WO application → check each target market

Cross-reference family members with your target markets.

## Step 7: Compile the FTO Report

### Risk Classification

For each analyzed patent, assign a risk level:

| Risk Level | Criteria |
|------------|----------|
| **HIGH** | In force, all independent claim elements match product, covers target market |
| **MEDIUM** | In force, most claim elements match but one element is arguable, or pending application with broad claims |
| **LOW** | In force but clear non-matching element in all independent claims, or only covers non-target markets |
| **NONE** | Expired/withdrawn, or no claim overlap |

### Report Structure

1. **Executive Summary**
   - Overall FTO assessment (clear / proceed with caution / significant risk)
   - Number of patents analyzed and risk distribution

2. **High-Risk Patents** (detailed analysis for each)
   - Publication number, title, applicant, grant date, expiry estimate
   - Independent claim text (quoted from tool)
   - Element-by-element mapping against product
   - Jurisdictional coverage (which target markets)
   - Suggested mitigation (design-around options, licensing, monitoring)

3. **Medium-Risk Patents** (summary analysis)
   - Key details and the arguable claim elements
   - Why the risk is uncertain

4. **Low-Risk / Cleared Patents**
   - Brief explanation of why each was cleared

5. **Search Coverage & Limitations**
   - Queries used and result counts
   - Jurisdictions and date ranges covered
   - Known gaps (e.g., JP/CN patents not fully searchable in full text)

6. **Recommendations**
   - Design-around opportunities for high-risk patents
   - Patents to monitor (pending applications)
   - Additional searches recommended

## Important Notes

- **FTO is not a legal opinion.** This analysis identifies potentially relevant patents and maps claims against product features. A qualified patent attorney should review high-risk findings.
- **Claim interpretation is nuanced.** Patents use specific legal language. Terms may be defined differently in the patent specification than their ordinary meaning. Always check the description for explicit definitions of key terms.
- **Doctrine of equivalents.** Even if a product doesn't literally match all claim elements, it may still infringe under the doctrine of equivalents (similar function, similar way, similar result). Flag cases where elements are close but not identical.
- **Expiry estimation.** Patents generally expire 20 years from the earliest non-provisional filing date. For pharmaceuticals, patent term extensions (PTE/SPC) can add up to 5 years. Legal status events will show these.
- **Pending applications.** Claims in pending applications may change during examination. Current claims are indicative but not final.
- **Granted claims often unavailable.** OPS full text frequently does not index B1/B2 (granted) claims. When the tool returns no claims for a granted patent, it will warn you. Always flag in the report when analysis is based on as-filed (A1) rather than granted claims — the granted claims may be narrower.
- **CQL term gotchas**: Hyphens act as word boundaries, so `ta="PD-1"` and `ta="PD1"` return substantially different result sets and neither is a superset of the other. OR the variants (`ta="PD-1" OR ta="PD1"`, `ta="IL-6" OR ta="IL6"`) or you will silently miss part of the field Drug names in patent titles often use research codes (e.g., MK-3475) more than INN names (pembrolizumab), especially in earlier filings.
- **NEVER describe companies from training knowledge.** Do not add phrases like "a leading pharmaceutical company" or "known for its oncology portfolio" — these are hallucination-prone. Only state what the patent data shows.
- **Mandatory biblio verification.** Before including ANY patent in the FTO report, call `get_patent_details` to verify its title, applicant, and dates. For batch efficiency, use the `document_numbers` array parameter to verify up to 100 patents in one call.
- **Verify inferred data.** If you infer a patent number (e.g., a US grant number from a publication), verify it with `get_patent_details` before citing it in the report.
