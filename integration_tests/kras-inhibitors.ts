/**
 * Scenario: Pan-KRAS and KRAS G12D inhibitor landscape
 *
 * Simulates an agent answering: "Give me all companies working on
 * pan-KRAS or KRAS G12D inhibitors."
 *
 * Tests: count_only, summary landscape stats, year-decomposition for >2000 results,
 * compact results, applicant normalization, IPC classification, keyword search
 * in patent claims for binding affinity data.
 */

import { runScenario, parseJson, getText } from "./harness.js";

runScenario("Pan-KRAS / KRAS G12D Inhibitor Landscape", async ({ test }) => {

  /* ── Step 1: Size the queries ───────────────────────────────────── */

  await test(
    "Count pan-KRAS patents",
    "search_patents",
    { query: 'ta="pan-KRAS"', count_only: true },
    (r) => {
      const data = parseJson(r);
      if (typeof data.totalCount !== "number") return "Missing totalCount";
      if (data.totalCount < 20) return `Expected 20+ pan-KRAS patents, got ${data.totalCount}`;
      return null;
    }
  );

  await test(
    "Count KRAS G12D inhibitor patents",
    "search_patents",
    { query: 'ab="KRAS G12D" AND (ta="inhibitor" OR ta="compound")', count_only: true },
    (r) => {
      const data = parseJson(r);
      if (typeof data.totalCount !== "number") return "Missing totalCount";
      if (data.totalCount < 50) return `Expected 50+ KRAS G12D patents, got ${data.totalCount}`;
      return null;
    }
  );

  await test(
    "Count KRAS title/abstract since 2023 (large, triggers year-decomp check)",
    "search_patents",
    { query: 'ta="KRAS"', published_after: "2023", count_only: true },
    (r) => {
      const data = parseJson(r);
      if (data.totalCount < 1000) return `Expected 1000+ KRAS patents 2023+, got ${data.totalCount}`;
      // The note should mention year decomposition if >2000
      if (data.totalCount > 2000 && !data.note?.includes("decomp"))
        return "Missing year decomposition guidance for >2000 results";
      return null;
    }
  );

  /* ── Step 2: Summary landscape — extract all companies ──────────── */

  await test(
    "Pan-KRAS + G12D landscape summary",
    "search_patents",
    {
      query: '(ta="pan-KRAS" OR (ab="KRAS G12D" AND ta="inhibitor"))',
      published_after: "2018",
      auto_paginate: true,
      detail_level: "summary",
      max_results: 500,
    },
    (r) => {
      const data = parseJson(r);
      if (!data.topApplicants?.length) return "Missing topApplicants";
      if (!data.yearDistribution) return "Missing yearDistribution";
      if (!data.topClassifications?.length) return "Missing topClassifications";
      // Mirati should be top applicant
      const mirati = data.topApplicants.find(
        (a: { name: string }) => a.name.includes("MIRATI")
      );
      if (!mirati) return "Expected MIRATI in topApplicants for KRAS landscape";
      // Should see C07D (heterocyclic chemistry) in classifications
      const c07d = data.topClassifications.find(
        (c: { code: string }) => c.code.startsWith("C07D")
      );
      if (!c07d) return "Expected C07D classification for small-molecule inhibitors";
      return null;
    }
  );

  /* ── Step 3: Applicant normalization check ──────────────────────── */

  await test(
    "Applicant names are normalized (Mirati variants merge)",
    "search_patents",
    {
      query: 'pa="Mirati" AND ta="KRAS"',
      auto_paginate: true,
      detail_level: "summary",
      max_results: 100,
    },
    (r) => {
      const data = parseJson(r);
      // After normalization, all Mirati variants should be a single entry
      const miratiEntries = data.topApplicants?.filter(
        (a: { name: string }) => a.name.includes("MIRATI")
      );
      if (!miratiEntries?.length) return "No MIRATI found in topApplicants";
      if (miratiEntries.length > 1) {
        const names = miratiEntries.map((a: { name: string }) => a.name);
        return `Mirati not fully normalized — found ${miratiEntries.length} variants: ${names.join(", ")}`;
      }
      return null;
    }
  );

  /* ── Step 4: Year decomposition for large result set ────────────── */

  await test(
    "Auto-paginate with year decomposition (KRAS 2023-2025, >2000 total)",
    "search_patents",
    {
      query: 'ta="KRAS"',
      published_after: "2023",
      published_before: "2025",
      auto_paginate: true,
      detail_level: "summary",
      max_results: 100,
    },
    (r) => {
      const data = parseJson(r);
      const text = getText(r);
      if (data.fetchedCount === 0) return "Expected results";
      if (data.totalCount > 2000 && !text.includes("year decomposition"))
        return `totalCount=${data.totalCount} > 2000 but no year decomposition note`;
      // Year distribution should cover 2023-2025
      const years = data.yearDistribution ? Object.keys(data.yearDistribution) : [];
      if (!years.includes("2023") || !years.includes("2024"))
        return `Expected 2023 and 2024 in yearDistribution, got: ${years}`;
      return null;
    }
  );

  /* ── Step 5: Compact results for recent G12D filings ────────────── */

  await test(
    "Recent KRAS G12D filings (compact, 2024+)",
    "search_patents",
    {
      query: 'ab="KRAS G12D" AND ta="inhibitor"',
      published_after: "2024",
      detail_level: "compact",
      range_end: 25,
    },
    (r) => {
      const data = parseJson(r);
      if (data.totalCount === 0) return "Expected recent KRAS G12D patents";
      const first = data.results?.[0];
      if (!first) return "No results returned";
      // Compact should have exactly: publicationNumber, title, applicant, publicationDate
      if (!first.publicationNumber) return "Missing publicationNumber in compact";
      if (!first.title) return "Missing title in compact";
      if (first.abstract !== undefined) return "Compact should NOT include abstract";
      if (first.inventors !== undefined) return "Compact should NOT include inventors";
      if (first.classifications !== undefined) return "Compact should NOT include classifications";
      return null;
    }
  );

  /* ── Step 6: Full detail for a specific applicant ───────────────── */

  await test(
    "Mirati pan-KRAS patents (full detail)",
    "search_patents",
    {
      query: 'pa="Mirati" AND ta="pan-KRAS"',
      detail_level: "full",
      range_end: 10,
    },
    (r) => {
      const data = parseJson(r);
      if (data.totalCount === 0) return "Expected Mirati pan-KRAS patents";
      const first = data.results?.[0];
      if (!first) return "No results";
      // Full should include all fields
      if (!first.title) return "Missing title";
      if (!first.applicants?.length) return "Missing applicants";
      if (!first.classifications?.length) return "Missing classifications";
      return null;
    }
  );

  /* ── Step 7: Deep dive — biblio on a known pan-KRAS patent ──────── */

  await test(
    "Biblio: Mirati tetrahydropyridopyrimidine pan-KRAS (US20260035389)",
    "get_patent_details",
    { document_number: "US20260035389" },
    (r) => {
      const data = parseJson(r);
      const b = Array.isArray(data) ? data[0] : data;
      if (!b?.title) return "Missing title";
      if (!b.title.toUpperCase().includes("KRAS"))
        return `Expected KRAS in title, got: ${b.title}`;
      if (!b.ipcClassifications?.length) return "Missing IPC classifications";
      return null;
    }
  );

  /* ── Step 8: Keyword search for binding affinity in claims ──────── */

  await test(
    "Keyword search: CRISPR terms in EP3750919 (verify keyword search works)",
    "search_in_patent_text",
    {
      document_number: "EP3750919",
      search_terms: ["CRISPR", "nucleic"],
    },
    (r) => {
      const data = parseJson(r);
      if (data.matchCount === undefined) return "Missing matchCount";
      if (data.matchCount === 0) return "Expected keyword matches for CRISPR/nucleic in CRISPR patent";
      return null;
    }
  );

  /* ── Step 9: KRAS PROTAC/degrader sub-landscape ─────────────────── */

  await test(
    "KRAS PROTAC/degrader patents (niche landscape)",
    "search_patents",
    {
      query: 'ta="KRAS" AND (ta="PROTAC" OR ta="degrader" OR ta="bifunctional")',
      published_after: "2021",
      auto_paginate: true,
      detail_level: "summary",
      max_results: 100,
    },
    (r) => {
      const data = parseJson(r);
      if (data.totalCount === 0) return "Expected KRAS degrader/PROTAC patents";
      if (!data.topApplicants?.length) return "Missing topApplicants";
      return null;
    }
  );

  /* ── Step 10: IPC/CPC classification search ─────────────────────── */

  await test(
    "CPC + keyword search (C07D heterocycles + KRAS)",
    "search_patents",
    {
      query: 'cpc="C07D" AND ab="KRAS" AND ab="G12D"',
      published_after: "2022",
      range_end: 5,
    },
    (r) => {
      const data = parseJson(r);
      return data.totalCount > 0
        ? null
        : "Expected results for CPC C07D + KRAS G12D";
    }
  );

}).then(({ failed }) => process.exit(failed > 0 ? 1 : 0));
