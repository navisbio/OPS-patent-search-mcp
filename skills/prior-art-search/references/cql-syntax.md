# CQL Query Syntax Reference

EPO CQL (Common Query Language) is the query language used by `search_patents`. This reference covers all field codes, operators, and patterns.

## Field Codes

| Code | Searches | Example |
|------|----------|---------|
| `ti` | Title only | `ti="gene therapy"` |
| `ab` | Abstract only | `ab="CRISPR"` |
| `ta` | Title + Abstract (recommended for concept search) | `ta="checkpoint inhibitor"` |
| `claims` | Claims text only | `claims="pharmaceutical composition"` |
| `desc` | Description text only | `desc="embodiment"` |
| `ftxt` | Full text (claims + description) | `ftxt="SEQ ID NO"` |
| `extftxt` | Full text + title + abstract | `extftxt="kinase inhibitor"` |
| `txt` | Title + abstract + inventor + applicant (NOT full text) | `txt="Novartis CRISPR"` |
| `cl` | IPC + CPC classification combined | `cl="C07K16"` |
| `in` | Inventor name | `in="Doudna"` |
| `pa` | Applicant / assignee | `pa="ROCHE*"` |
| `pn` | Publication number | `pn="EP1000000"` |
| `pd` | Publication date (YYYYMMDD or YYYY) | `pd>=20230101` |
| `ap` | Application number | `ap="EP20200001"` |
| `pr` | Priority number | `pr="US20190001"` |
| `ic` / `ipc` | IPC classification | `ic="C07K16/28"` |
| `cpc` | CPC classification | `cpc="A61K39/3955"` |
| `ct` | Cited by (forward citations) | `ct="EP1000000"` |

## Operators

| Operator | Usage | Notes |
|----------|-------|-------|
| `AND` | Both terms required | Must be uppercase |
| `OR` | Either term matches | Must be uppercase |
| `NOT` | Exclude term | Must be uppercase |
| `=` | Equals / contains | Standard comparison |
| `>=` / `<=` | Date comparisons | For `pd` field |
| `within` | Date range | `pd within "20200101,20231231"` |

## Wildcards and Phrases

- **Right truncation**: `antibod*` matches antibody, antibodies, antibodies
- **Phrase search**: `ti="gene therapy"` (double quotes)
- **No left truncation**: `*kinase` is NOT supported
- **No single-character wildcard**: `?` is NOT supported

## Parentheses for Grouping

```
(ta="PD-1" OR ta="PD1" OR ta="PDCD1") AND ta="antibody"
```

Parentheses control operator precedence. Use them whenever mixing AND/OR.

## Common Search Patterns

### Topic Search (Most Common)
```
ta="checkpoint inhibitor" AND ta="cancer"
ta="bispecific antibody" AND (ta="PD-1" OR ta="PD1")
```

### Applicant + Topic
```
pa="MERCK*" AND ta="immunotherapy" AND pd>=2020
pa="NOVARTIS*" AND ic="A61K"
```

### Inventor Search
```
in="Doudna" AND ta="CRISPR"
in="Yamanaka" AND ic="C12N"
```

### Classification Search
```
ic="C07K16/28" AND ta="bispecific"
cpc="A61K39/3955" AND pd>=2022
```

### Forward Citations (Patents Citing a Document)
```
ct="EP3750919"
ct="US10000000" AND pa="PFIZER*"
```

### Combined Date Range
Use the `published_after` and `published_before` parameters instead of CQL date syntax — they handle the formatting automatically.

For CQL date ranges directly:
```
pd within "20200101,20231231"
pd>=2020 AND pd<=2023
```

## IPC/CPC Classification Quick Reference (Life Sciences)

| Class | Technology Area |
|-------|----------------|
| `A61K` | Medicinal preparations |
| `A61K39/` | Medicinal preparations containing antigens/antibodies |
| `A61K31/` | Small molecule drugs |
| `A61K47/` | Drug delivery / carriers |
| `A61P35/` | Antineoplastic agents |
| `C07K16/` | Immunoglobulins (antibodies) |
| `C07K14/` | Peptides / proteins |
| `C12N15/` | Genetic engineering (vectors, recombinant DNA) |
| `C12N5/` | Cell culture / tissue engineering |
| `C12N9/` | Enzymes |
| `C12Q1/` | Diagnostic methods (measuring/testing biological material) |
| `G01N33/` | Immunoassays / biospecific binding assays |
| `G16B` | Bioinformatics |

## Tips

1. **Start with `ta=`** (title + abstract) for concept searches — it's the best balance of precision and recall
2. **Use `ftxt=`** (full text = claims + description) only when `ta=` misses relevant results — full text search is slower and noisier
3. **Use `claims=`** to search only within claims text — useful for FTO analysis where claimed scope matters most
4. **`txt=` is NOT full text** — it searches title + abstract + inventor + applicant names. Use `ftxt=` or `extftxt=` for true full text

## CQL Full-Text Field Limitations

**Important:** The full-text CQL fields (`claims=`, `desc=`, `ftxt=`, `extftxt=`) have significant limitations:

- They work for **simple single terms** (`claims="antibody"`) but **phrase searches are unreliable** (`claims="clinical trial"` often returns 0 results even when claims contain that phrase)
- **Wildcards are not supported** on full-text fields — `claims="pharmacokinetic*"` will error
- Coverage is limited to **EP, WO, and some US patents** — other jurisdictions have no full text indexed

**Recommended approach:** Use `ta=` for initial CQL filtering, then use `search_in_patent_text` for post-retrieval keyword searching within claims and description. This two-step approach is more reliable than CQL full-text fields.
3. **Applicant names vary**: Use wildcards (`pa="ROCHE*"`) to catch variants (Roche, Roche Holding AG, F. Hoffmann-La Roche)
4. **Classification precision**: `ic="C07K16/"` catches all antibody subclasses; `ic="C07K16/28"` is specific to antibodies against receptors
5. **Date filtering**: Prefer `published_after`/`published_before` parameters over CQL `pd=` — they handle edge cases automatically
6. **Combine strategies**: Use broad classification + narrow keywords for best coverage: `ic="A61K39/" AND ta="bispecific"`
