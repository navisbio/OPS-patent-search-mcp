import type { SearchResultItem } from "./parsers.js";

/** IPC subclass labels for the most commonly seen codes in patent landscape analysis. */
const IPC_LABELS: Record<string, string> = {
  // A61K — Preparations for medical/dental/toilet purposes
  A61K31: "Small molecule drugs", A61K38: "Peptide/protein drugs", A61K39: "Antibodies & vaccines",
  A61K45: "Combination therapy", A61K47: "Drug delivery / carriers", A61K48: "Gene therapy",
  A61K9: "Drug formulations",
  // A61P — Therapeutic activity
  A61P1: "Digestive system", A61P3: "Metabolism", A61P5: "Endocrine system",
  A61P7: "Blood / hematology", A61P9: "Cardiovascular", A61P11: "Respiratory",
  A61P13: "Urinary / renal", A61P15: "Reproductive", A61P17: "Dermatology",
  A61P19: "Musculoskeletal", A61P21: "Muscular disorders", A61P25: "Neurology",
  A61P27: "Ophthalmology", A61P29: "Anti-inflammatory", A61P31: "Anti-infectives",
  A61P33: "Anti-parasitic", A61P35: "Oncology", A61P37: "Immunology",
  A61P43: "Drugs for specific purposes (NEC)",
  // C07 — Organic chemistry
  C07D: "Heterocyclic compounds", C07K14: "Peptides (>20 aa)", C07K16: "Monoclonal antibodies",
  C07K7: "Peptides (5-20 aa)", C07H: "Sugars / nucleosides",
  // C12N — Biotechnology
  C12N15: "Genetic engineering / vectors", C12N5: "Cell culture", C12N9: "Enzymes",
  C12Q1: "Biological assays",
  // G01N — Testing / analysis
  G01N33: "Immunoassays / diagnostics",
  // G16B — Bioinformatics
  G16B: "Bioinformatics",
};

/** CJK→Latin lookup for top pharma/biotech companies. Partial CJK string matching. */
const CJK_APPLICANT_MAP: [RegExp, string][] = [
  [/中外製薬|中外制药/, "CHUGAI PHARMACEUTICAL"],
  [/武田薬品|武田药品|タケダ/, "TAKEDA PHARMACEUTICAL"],
  [/第一三共|ダイイチサンキョウ/, "DAIICHI SANKYO"],
  [/アステラス|安斯泰来/, "ASTELLAS PHARMA"],
  [/大塚製薬|大冢制药/, "OTSUKA PHARMACEUTICAL"],
  [/エーザイ|卫材/, "EISAI"],
  [/小野薬品|小野药品/, "ONO PHARMACEUTICAL"],
  [/塩野義|盐野义/, "SHIONOGI"],
  [/三菱田辺|田辺三菱/, "MITSUBISHI TANABE PHARMA"],
  [/住友ファーマ|住友制药|大日本住友/, "SUMITOMO PHARMA"],
  [/参天製薬/, "SANTEN PHARMACEUTICAL"],
  [/協和キリン|协和发酵/, "KYOWA KIRIN"],
  [/東レ|东丽/, "TORAY INDUSTRIES"],
  [/恒瑞医药|恒瑞/, "HENGRUI MEDICINE"],
  [/百济神州/, "BEIGENE"],
  [/信达生物/, "INNOVENT BIOLOGICS"],
  [/君实生物/, "JUNSHI BIOSCIENCES"],
  [/再鼎医药/, "ZAILAB"],
  [/复星医药|復星/, "FOSUN PHARMA"],
  [/药明康德|藥明康德/, "WUXI APPTEC"],
  [/药明生物|藥明生物/, "WUXI BIOLOGICS"],
  [/三星バイオ|삼성바이오/, "SAMSUNG BIOLOGICS"],
  [/セルトリオン|셀트리온/, "CELLTRION"],
  [/한미약품/, "HANMI PHARMACEUTICAL"],
  [/유한양행/, "YUHAN"],
  [/绿叶制药/, "LUYE PHARMA"],
  [/石药集团/, "CSPC PHARMACEUTICAL"],
  [/正大天晴/, "CHIA TAI TIANQING"],
  [/齐鲁制药/, "QILU PHARMACEUTICAL"],
  [/豪森药业|翰森制药/, "HANSOH PHARMA"],
];

/** Normalize an applicant name for grouping. Merges common variants. */
function normalizeApplicantName(raw: string): string {
  let name = raw
    .replace(/\s*\[.*?\]\s*$/, "")  // [US], [JP] etc.
    .toUpperCase()
    .replace(/[.,;:()]+/g, " ")     // all punctuation → space
    .replace(/\s+/g, " ")           // collapse whitespace
    .trim();

  // CJK→Latin lookup: check if name contains known CJK company strings
  if (/[\u2E80-\u9FFF\uF900-\uFAFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/.test(name)) {
    for (const [pattern, latin] of CJK_APPLICANT_MAP) {
      if (pattern.test(raw)) {
        return latin;
      }
    }
    // Skip unrecognized CJK-only names (they'll merge with their Latin equivalent via per-result dedup)
    if (/^[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\s]+$/.test(name)) {
      return "";
    }
  }

  // Strip common corporate suffixes
  name = name
    .replace(/\b(THE TRUSTEES OF THE |THE BOARD OF TRUSTEES OF THE |THE REGENTS OF THE |REGENTS OF THE |THE )/g, "")
    .replace(/\b(CORP|CORPORATION|INC|INCORPORATED|LTD|LIMITED|LLC|LLP|GMBH|AG|SA|SAS|BV|BVBA|NV|KK|CO|COMPANY|PLC|PTY|AB|OY|AS|APS|SRL|SPA|SE)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Normalize "UNIV X" / "UNIVERSITY OF X" / "X UNIVERSITY"
  name = name
    .replace(/\bUNIVERSITY OF\b/g, "UNIV")
    .replace(/\bUNIVERSITY\b/g, "UNIV")
    .replace(/\s+/g, " ")
    .trim();

  return name;
}

/** Compute aggregated landscape statistics from a set of search results. */
export function computeLandscapeStats(results: SearchResultItem[], totalCount: number) {
  // Top applicants by frequency — deduplicate per result to avoid double-counting
  // when OPS returns both epodoc and original format for same applicant on same patent
  const applicantCounts = new Map<string, number>();
  for (const r of results) {
    // Deduplicate applicants within this result: normalize all, keep unique
    const seenForResult = new Set<string>();
    for (const a of r.applicants) {
      const name = normalizeApplicantName(a);
      if (!name || seenForResult.has(name)) continue;
      seenForResult.add(name);
      applicantCounts.set(name, (applicantCounts.get(name) ?? 0) + 1);
    }
  }
  const topApplicants = [...applicantCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));

  // Year distribution
  const yearCounts = new Map<string, number>();
  for (const r of results) {
    const year = r.publicationDate?.slice(0, 4) ?? "unknown";
    yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
  }
  const yearDistribution = Object.fromEntries(
    [...yearCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  );

  // Top classifications
  const classCounts = new Map<string, number>();
  for (const r of results) {
    for (const c of r.classifications) {
      // Group by subclass level (e.g. C07D471/04 → C07D471)
      const subclass = c.replace(/\/.*$/, "");
      classCounts.set(subclass, (classCounts.get(subclass) ?? 0) + 1);
    }
  }
  const topClassifications = [...classCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([code, count]) => ({ code, count, label: IPC_LABELS[code] }));

  // Top jurisdictions by publication country
  const jurisdictionCounts = new Map<string, number>();
  for (const r of results) {
    // Extract country code from publication number (first 2 chars, or special cases like WO)
    const match = r.publicationNumber.match(/^([A-Z]{2})/);
    const country = match?.[1] ?? "??";
    jurisdictionCounts.set(country, (jurisdictionCounts.get(country) ?? 0) + 1);
  }
  const topJurisdictions = [...jurisdictionCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([country, count]) => ({ country, count }));

  // Approximate family deduplication by normalized title
  const titleFamilies = new Map<string, number>();
  for (const r of results) {
    const normTitle = r.title.toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
    if (normTitle) {
      titleFamilies.set(normTitle, (titleFamilies.get(normTitle) ?? 0) + 1);
    }
  }
  const estimatedFamilies = titleFamilies.size;

  return { totalCount, analyzedCount: results.length, estimatedFamilies, topApplicants, yearDistribution, topClassifications, topJurisdictions };
}

/** Project a result array according to the requested detail level. */
export function projectResults(results: SearchResultItem[], level: "full" | "compact" | "summary") {
  if (level === "summary") return undefined; // no individual results
  if (level === "full") return results;
  // compact: publicationNumber, title, first applicant, date, fulltext indicator
  return results.map((r) => ({
    publicationNumber: r.publicationNumber,
    title: r.title,
    applicant: r.applicants[0] ?? undefined,
    publicationDate: r.publicationDate,
    fulltextLikely: r.fulltextLikely,
  }));
}

/**
 * Append an OPS publication-date filter to a CQL query.
 * Two-sided ranges must use `pd within "X,Y"` (comma). Single-sided `pd>=X` / `pd<=Y` is fine.
 */
export function buildDateCql(query: string, after?: string, before?: string): string {
  if (after && before) return `${query} AND pd within "${after},${before}"`;
  if (after) return `${query} AND pd>=${after}`;
  if (before) return `${query} AND pd<=${before}`;
  return query;
}
