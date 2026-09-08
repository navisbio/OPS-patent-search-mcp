---
description: |
  Guides Claude through a Loss-of-Exclusivity (LOE) patent analysis
  using the Espacenet patent tools. Teaches how to identify all relevant
  patents protecting a drug (compound, formulation, method-of-use),
  check legal status and expiry across target jurisdictions, detect
  patent term extensions (PTE/SPC), and produce an LOE timeline.
  Triggers on: loss of exclusivity, LOE analysis, patent expiry,
  generic entry, biosimilar entry, when does patent expire, patent
  cliff, SPC, supplementary protection certificate, patent term
  extension, drug patent expiry, orange book, patent life cycle.
---

# Loss-of-Exclusivity (LOE) Analysis Skill

You are conducting a Loss-of-Exclusivity analysis using the Espacenet
patent tools. LOE analysis determines when patent protection for a drug
expires across target markets, enabling generic/biosimilar entry planning
or portfolio lifecycle management.

## Workflow Overview

```
Drug / active ingredient identification
  --> Search for all relevant patents (compound, formulation, method-of-use)
    --> Classify patents by type and strength
      --> Get legal status for each (grant, expiry, SPC/PTE)
        --> Check family coverage across target jurisdictions
          --> Estimate expiry dates per jurisdiction
            --> Build LOE timeline
              --> LOE report with earliest entry windows
```

## Step 1: Identify the Drug and Target Markets

Extract from the user's request:

1. **Drug name** — brand name, INN (generic name), and any known synonyms
2. **Active ingredient** — chemical/biological name
3. **Originator company** — who markets the drug
4. **Target markets** — jurisdictions of interest (typically US, EP, JP, CN)
5. **Drug type** — small molecule, biologic (antibody, protein), gene therapy, etc.

Example: "When can a biosimilar to Keytruda enter the market?"
- Brand: Keytruda
- INN: pembrolizumab
- Active: anti-PD-1 monoclonal antibody
- Originator: Merck (MSD)
- Markets: US, EP, JP
- Type: biologic (monoclonal antibody)

## Step 2: Search for All Relevant Patents

LOE analysis requires finding ALL patent families protecting the drug,
not just the main compound patent. Search in layers:

### Layer 1: Compound / composition-of-matter patents
The strongest form of protection — covers the molecule itself.

```
search_patents(query='ta="pembrolizumab" OR ta="Keytruda" OR ta="MK-3475"',
  auto_paginate=true, detail_level="compact")
```

Also search by applicant + target:
```
search_patents(query='pa="MERCK*" AND (ta="anti-PD-1" OR ta="anti-PD1") AND ta="antibod*"',
  published_after="2005", auto_paginate=true, detail_level="compact")
```

### Layer 2: Formulation / dosage patents
Cover specific formulations, dosage forms, concentrations, stabilizers.

```
search_patents(query='(ta="pembrolizumab" OR ta="MK-3475") AND (ta="formulation" OR ta="composition" OR ta="stable" OR ta="lyophil*")',
  detail_level="full")
```

### Layer 3: Method-of-use / indication patents
Cover specific therapeutic uses — can block specific indications even after compound patent expires.

```
search_patents(query='(ta="pembrolizumab" OR ta="anti-PD-1") AND pa="MERCK*" AND (ta="method" OR ta="treatment" OR ta="cancer")',
  auto_paginate=true, detail_level="compact")
```

### Layer 4: Manufacturing / process patents
Cover production methods — relevant for biologics especially.

```
search_patents(query='pa="MERCK*" AND (ta="pembrolizumab" OR ta="anti-PD-1") AND (ta="process" OR ta="manufacturing" OR ta="purif*" OR ta="cell line")',
  detail_level="full")
```

### Layer 5: Combination therapy patents
Cover the drug in combination with other agents.

```
search_patents(query='(ta="pembrolizumab" OR ta="anti-PD-1") AND ta="combination" AND pa="MERCK*"',
  detail_level="compact", auto_paginate=true)
```

## Step 3: Classify Patents by Type and Strength

Organize found patents into categories:

| Category | Strength | Typical Expiry | Impact |
|----------|----------|----------------|--------|
| **Compound/molecule** | Strongest | 20 yrs from filing + PTE/SPC | Blocks all generic/biosimilar versions |
| **Formulation** | Medium-Strong | 20 yrs from filing | Blocks identical formulation; design-around possible |
| **Method-of-use** | Medium | 20 yrs from filing | Blocks specific indication; other indications may be free |
| **Manufacturing** | Medium-Low | 20 yrs from filing | Blocks specific process; alternative processes possible |
| **Combination** | Low-Medium | 20 yrs from filing | Only blocks specific combination |

For each patent, note the **priority date** — this is needed for expiry estimation.

## Step 4: Legal Status — The Core of LOE Analysis

For each key patent family, check legal status:

```
get_patent_legal_status(document_number="EP2170959")
```

Look for these critical events:

### Grant events
- Patent granted (B1/B2 kind code) — confirms the patent is enforceable
- If still pending (A1/A2) — claims may change; timeline uncertain

### Expiry-related events
- **Lapse/cessation** — patent no longer in force (fees not paid)
- **Withdrawal** — applicant abandoned the patent
- **Expiry** — reached end of term

### Patent term extensions
- **SPC (Supplementary Protection Certificate)** — extends protection for up to 5 years in Europe for pharmaceuticals
- **PTE (Patent Term Extension)** — US equivalent under 35 USC §156, up to 5 years
- **Pediatric extension** — additional 6 months in US/EU for pediatric studies

### Opposition / invalidation
- **Opposition filed** — patent validity challenged (EP patents)
- **Inter partes review (IPR)** — US patent validity challenge
- **Claims amended** — scope may have narrowed

## Step 5: Family Coverage Across Jurisdictions

For each key patent, check where it's filed and granted:

```
get_patent_family(document_number="EP2170959")
```

Build a jurisdiction coverage matrix:

| Patent Family | Priority Date | US | EP | JP | CN | Status |
|--------------|---------------|----|----|----|----|--------|
| Compound (EP2170959) | 2008-07-08 | US8354509 (granted) | EP2170959 (granted) | JP5746174 | CN102245640 | In force |
| Formulation | 2015-03-01 | US10234567 | EP3456789 | — | — | In force |
| Method: NSCLC | 2013-09-13 | US9387247 | EP3043816 | JP pending | — | Mixed |

A patent **only blocks you in jurisdictions where it's granted and in force**.

## Step 6: Estimate Expiry Dates

### Base calculation
```
Expiry = Priority date + 20 years
```

### Adjustments
- **Patent Term Adjustment (PTA)** — US only, compensates for USPTO examination delays. Check legal status events.
- **Patent Term Extension (PTE/SPC)** — adds up to 5 years for regulatory delay. Look for SPC grant events in legal status.
- **Pediatric exclusivity** — adds 6 months after any other extension
- **Patent term disclaimer** — applicant may have disclaimed part of the term (terminal disclaimer in US)

### Example calculation:
```
Compound patent EP2170959:
  Priority date:    2008-07-08
  Base expiry:      2028-07-08
  SPC granted:      +4.5 years → 2033-01-08
  Pediatric ext:    +6 months  → 2033-07-08
  Effective expiry: July 8, 2033
```

## Step 7: Build the LOE Timeline

Organize all expiry dates chronologically per jurisdiction:

### Timeline format:

```
US Market:
  2028 ─── Compound patent expires (base term)
  2029 ─── Manufacturing process patent expires
  2030 ─── Formulation patent expires
  2033 ─── Compound patent + PTE expires ← EFFECTIVE LOE
  2033 ─── Method-of-use (NSCLC) expires
  2035 ─── Method-of-use (melanoma) expires ← FULL LOE

EU Market:
  2028 ─── Compound patent expires (base term)
  2033 ─── Compound patent + SPC + pediatric expires ← EFFECTIVE LOE
  2034 ─── Formulation patent expires
```

**Effective LOE** = when the compound/composition patent expires (including extensions). This is when a generic/biosimilar with the same molecule can enter.

**Full LOE** = when ALL method-of-use patents expire. After this, generics can market for all approved indications.

## Step 8: Compile the LOE Report

### Report Structure

1. **Executive Summary**
   - Drug name, originator, drug type
   - Effective LOE date per jurisdiction (headline finding)
   - Key risk: which patent is the last to expire?

2. **Patent Portfolio Map**
   - All identified patent families by category
   - Publication numbers, priority dates, grant status
   - Jurisdiction coverage matrix

3. **Expiry Timeline**
   - Chronological expiry dates per jurisdiction
   - Effective LOE vs. full LOE dates
   - Extensions (SPC/PTE) with details

4. **Legal Status Assessment**
   - Granted vs. pending vs. lapsed for each key patent
   - Any opposition or invalidation proceedings
   - Risk of claims narrowing

5. **Generic/Biosimilar Entry Windows**
   - Earliest possible entry date per market
   - Which indications open first (if method-of-use patents stagger)
   - Design-around opportunities (formulation, process)

6. **Risk Factors and Uncertainties**
   - Pending applications that could extend protection
   - Opposition outcomes that could shorten protection
   - Regulatory exclusivities beyond patents (data exclusivity, orphan drug, etc.)
   - Paragraph IV / Bolar provisions for early generic filing

7. **Methodology and Limitations**
   - Search queries used
   - Patents not found in Espacenet (some US-specific patents may need FDA Orange Book cross-reference)
   - Regulatory exclusivities are NOT covered by patent tools — note this gap

## Important Notes

- **Patents are only part of the picture.** Regulatory exclusivities (data exclusivity, orphan drug exclusivity, pediatric exclusivity) are separate from patent protection and are NOT visible in patent databases. Always flag this limitation.
- **Orange Book / patent linkage.** In the US, the FDA Orange Book lists patents associated with approved drugs. These patents may not all appear in a keyword search. If the user knows specific Orange Book patent numbers, search those directly.
- **SPC calculation is complex.** In Europe, SPC duration = (first marketing authorization date − patent filing date) − 5 years, capped at 5 years. The legal status events should show the granted SPC term.
- **Biologics vs. small molecules.** Biosimilar entry has additional regulatory requirements (similarity studies) that delay entry beyond patent expiry. The LOE date is the earliest possible, not the expected market entry.
- **Patent term adjustment (PTA).** US-specific, compensates for examination delays. Can add months to years. Visible in legal status events.
- **Divisional applications.** A single priority filing can spawn multiple divisional patents with the same priority date but different claims. Check the full family for divisionals.
- **Continuation patents.** US-specific — new patents filed claiming priority to earlier applications. Can have the same expiry date as the parent but different claims. These are particularly important for biologics patent thickets.
- **Follow cross-references.** Patents often cite related applications inline (e.g., "as described in US2017/0137537"). When a patent references another document as a primary source of data (e.g., clinical data, formulation details), fetch that document — it may contain extension-relevant information (SPC data, regulatory milestones) not present in the citing patent.
- **CQL full-text field limitations.** The CQL fields `claims=`, `desc=`, `ftxt=` are unreliable for phrase searches and don't support wildcards. Use `ta=` for CQL queries, then `search_in_patent_text` for full-text keyword analysis of specific patents.
- **European SPC data is NOT reliably available from OPS.** National SPCs are filed at national patent offices (DPMA, INPI, UKIPO) and may not appear in OPS legal status events. Flag this limitation prominently in the report. If `spcOrPte` returns false, it may mean "no SPC data available" rather than "no SPC exists."
- **Drug names in patents.** Patent titles/abstracts often use research codes (e.g., MK-3475) more than INN names (pembrolizumab), especially in earlier filings. Search for both. Also try brand names and mechanism descriptions (e.g., "anti-PD-1 antibody").
- **Legal status event filtering.** Use `event_types=["grant", "spc_pte", "lapse"]` and `condensed=true` to get a concise view of patents with many events (EP patents can have 100+ PGFP fee payment entries that obscure the important events).
- **NEVER describe companies from training knowledge.** Do not add phrases like "a leading pharmaceutical company" or "known for its oncology portfolio" — these are hallucination-prone. Only state what the patent data shows.
- **Mandatory biblio verification.** Before including ANY patent in the LOE report, call `get_patent_details` to verify its title, applicant, and dates. For batch efficiency, use the `document_numbers` array parameter to verify up to 100 patents in one call.
- **Priority dates are now structured.** The biblio tool returns priority claims as `{number, date, country}` objects. Use the `date` field for expiry calculations when available.
