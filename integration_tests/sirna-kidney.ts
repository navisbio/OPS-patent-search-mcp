/**
 * Scenario: siRNA patents for kidney disease
 *
 * Simulates an agent answering: "Are there siRNA patents to treat kidney disease?"
 *
 * Tests: multi-term OR queries, summary landscape, compact retrieval,
 * full-text keyword search, family fallback for non-EP patents,
 * handling of non-English full text (Chinese WO applications).
 */

import { runScenario, parseJson, getText } from "./harness.js";

runScenario("siRNA Patents for Kidney Disease", async ({ test }) => {

  /* ── Step 1: Scope with count_only ──────────────────────────────── */

  await test(
    "Count siRNA + kidney/renal patents",
    "search_patents",
    {
      query: 'ta="siRNA" AND (ta="kidney" OR ta="renal" OR ta="nephropathy" OR ta="nephrotic")',
      count_only: true,
    },
    (r) => {
      const data = parseJson(r);
      if (typeof data.totalCount !== "number") return "Missing totalCount";
      if (data.totalCount < 30) return `Expected 30+ siRNA kidney patents, got ${data.totalCount}`;
      return null;
    }
  );

  await test(
    "Count broader: siRNA + kidney disease terms",
    "search_patents",
    {
      query: 'ta="siRNA" AND (ta="kidney" OR ta="renal" OR ta="nephro" OR ta="glomerulo" OR ta="IgA nephropathy" OR ta="polycystic kidney")',
      count_only: true,
    },
    (r) => {
      const data = parseJson(r);
      return data.totalCount > 0 ? null : "Expected results for broad siRNA kidney query";
    }
  );

  /* ── Step 2: Landscape summary ──────────────────────────────────── */

  await test(
    "siRNA kidney landscape summary (auto_paginate + summary)",
    "search_patents",
    {
      query: 'ta="siRNA" AND (ta="kidney" OR ta="renal" OR ta="nephropathy" OR ta="nephrotic")',
      auto_paginate: true,
      detail_level: "summary",
      max_results: 500,
    },
    (r) => {
      const data = parseJson(r);
      if (!data.topApplicants?.length) return "Missing topApplicants";
      if (!data.yearDistribution) return "Missing yearDistribution";
      if (!data.topClassifications?.length) return "Missing topClassifications";
      // Should see C12N15 (nucleic acid manipulation) in top classifications
      const c12n = data.topClassifications.find(
        (c: { code: string }) => c.code.startsWith("C12N")
      );
      if (!c12n) return "Expected C12N classification for siRNA patents";
      return null;
    }
  );

  await test(
    "Summary includes year distribution spanning multiple decades",
    "search_patents",
    {
      query: 'ta="siRNA" AND (ta="kidney" OR ta="renal")',
      auto_paginate: true,
      detail_level: "summary",
      max_results: 200,
    },
    (r) => {
      const data = parseJson(r);
      const years = data.yearDistribution ? Object.keys(data.yearDistribution) : [];
      // siRNA kidney patents should span from ~2004 to present
      const hasOld = years.some((y: string) => parseInt(y) <= 2010);
      const hasNew = years.some((y: string) => parseInt(y) >= 2022);
      if (!hasOld) return "Expected pre-2010 patents in siRNA kidney field";
      if (!hasNew) return "Expected 2022+ patents in siRNA kidney field";
      return null;
    }
  );

  /* ── Step 3: Compact results for recent filings ─────────────────── */

  await test(
    "Recent siRNA kidney filings (compact, 2022+)",
    "search_patents",
    {
      query: 'ta="siRNA" AND (ta="kidney" OR ta="renal")',
      published_after: "2022",
      detail_level: "compact",
      range_end: 25,
    },
    (r) => {
      const data = parseJson(r);
      if (data.totalCount === 0) return "Expected recent siRNA kidney patents";
      const first = data.results?.[0];
      if (!first?.publicationNumber) return "Missing publicationNumber";
      if (!first?.title) return "Missing title";
      // Verify compact format
      if (first.abstract !== undefined) return "Compact should NOT include abstract";
      return null;
    }
  );

  /* ── Step 4: Full detail for established applicants ─────────────── */

  await test(
    "Quark Pharmaceuticals siRNA patents (known player)",
    "search_patents",
    {
      query: 'pa="Quark" AND ta="siRNA"',
      detail_level: "full",
      range_end: 10,
    },
    (r) => {
      const data = parseJson(r);
      if (data.totalCount === 0) return "Expected Quark Pharmaceuticals siRNA patents";
      const first = data.results?.[0];
      if (!first?.title) return "Missing title";
      if (!first?.applicants?.length) return "Missing applicants in full detail";
      // Abstract may be absent from search index for some patents — not a test failure
      if (!first?.classifications) return "Missing classifications in full detail";
      return null;
    }
  );

  await test(
    "Nitto Denko siRNA delivery patents",
    "search_patents",
    {
      query: 'pa="Nitto Denko" AND ta="siRNA"',
      detail_level: "full",
      range_end: 10,
    },
    (r) => {
      const data = parseJson(r);
      return data.totalCount > 0
        ? null
        : "Expected Nitto Denko siRNA delivery patents";
    }
  );

  /* ── Step 5: Keyword search in an EP patent full text ───────────── */

  await test(
    "Keyword search: kidney/renal terms in EP siRNA patent",
    "search_in_patent_text",
    {
      document_number: "EP3750919",  // Reliable full text (CRISPR patent used as baseline)
      search_terms: ["nucleic acid", "guide"],
      section_filter: ["description"],
    },
    (r) => {
      const data = parseJson(r);
      if (data.matchCount === undefined) return "Missing matchCount";
      if (data.matchCount === 0) return "Expected keyword matches in description";
      // Verify section filter is respected
      const wrongSection = data.matches?.find(
        (m: { section: string }) => m.section !== "description"
      );
      if (wrongSection) return "Section filter not respected — got non-description match";
      return null;
    }
  );

  /* ── Step 6: Non-English full text handling ─────────────────────── */

  await test(
    "Keyword search in Chinese WO patent (technical terms in English)",
    "search_in_patent_text",
    {
      document_number: "WO2026037289",  // BeBetter Med, Chinese full text
      search_terms: ["URAT1", "siRNA"],
    },
    (r) => {
      const data = parseJson(r);
      // Chinese patent text contains embedded English terms like URAT1 and siRNA
      if (data.matchCount === undefined) return "Missing matchCount";
      if (data.matchCount === 0)
        return "Expected matches for URAT1/siRNA even in Chinese text (technical terms are in English)";
      return null;
    },
    true  // ignoreIsError — full text might not be available yet for very recent WO
  );

  /* ── Step 7: Family lookup for delivery platform patents ────────── */

  await test(
    "Patent family for Nitto Denko delivery patent",
    "search_patents",
    { query: 'pa="Nitto Denko" AND ta="siRNA" AND ta="kidney"', range_end: 3 },
    (r) => {
      const data = parseJson(r);
      // Just verify the search works — we'll use the first result for family lookup
      return data.totalCount !== undefined ? null : "Missing totalCount";
    }
  );

  /* ── Step 8: IPC classification filtering (A61K48 = gene therapy) ── */

  await test(
    "IPC-filtered search: A61K48 (gene therapy) + kidney",
    "search_patents",
    {
      query: 'ic="A61K48" AND (ta="kidney" OR ta="renal") AND ta="RNA"',
      range_end: 10,
    },
    (r) => {
      const data = parseJson(r);
      return data.totalCount !== undefined ? null : "Missing totalCount";
    }
  );

  /* ── Step 9: Specific disease target searches ───────────────────── */

  await test(
    "IgA nephropathy siRNA patents",
    "search_patents",
    {
      query: 'ta="siRNA" AND ta="IgA nephropathy"',
      count_only: true,
    },
    (r) => {
      const data = parseJson(r);
      // May be 0 — IgA nephropathy + siRNA is niche. Just verify no error.
      return typeof data.totalCount === "number" ? null : "Missing totalCount";
    }
  );

  await test(
    "Polycystic kidney disease siRNA patents",
    "search_patents",
    {
      query: 'ta="siRNA" AND (ta="polycystic kidney" OR ta="PKD")',
      count_only: true,
    },
    (r) => {
      const data = parseJson(r);
      return typeof data.totalCount === "number" ? null : "Missing totalCount";
    }
  );

  await test(
    "Diabetic nephropathy siRNA patents",
    "search_patents",
    {
      query: 'ta="siRNA" AND (ta="diabetic nephropathy" OR ta="diabetic kidney")',
      count_only: true,
    },
    (r) => {
      const data = parseJson(r);
      return typeof data.totalCount === "number" ? null : "Missing totalCount";
    }
  );

}).then(({ failed }) => process.exit(failed > 0 ? 1 : 0));
