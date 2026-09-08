/**
 * Scenario: Loss of Exclusivity — Pembrolizumab & Nivolumab
 *
 * Simulates an agent answering: "Which are the relevant patents for the
 * loss of exclusivity of pembrolizumab and nivolumab?"
 *
 * Tests: count_only, detail_level (summary/compact/full), legal status,
 * forward citations, biblio deep dive, date range filtering.
 */

import { runScenario, parseJson, getText } from "./harness.js";

runScenario("LOE — Pembrolizumab & Nivolumab", async ({ test }) => {

  /* ── Step 1: Scope the landscape ────────────────────────────────── */

  await test(
    "Count pembrolizumab patents",
    "search_patents",
    { query: 'ta="pembrolizumab" OR ta="Keytruda"', count_only: true },
    (r) => {
      const data = parseJson(r);
      if (typeof data.totalCount !== "number") return "Missing totalCount";
      if (data.totalCount < 50) return `Expected 50+ pembrolizumab patents, got ${data.totalCount}`;
      return null;
    }
  );

  await test(
    "Count nivolumab patents",
    "search_patents",
    { query: 'ta="nivolumab" OR ta="Opdivo"', count_only: true },
    (r) => {
      const data = parseJson(r);
      if (typeof data.totalCount !== "number") return "Missing totalCount";
      if (data.totalCount < 50) return `Expected 50+ nivolumab patents, got ${data.totalCount}`;
      return null;
    }
  );

  /* ── Step 2: Landscape summary via auto_paginate ────────────────── */

  await test(
    "Pembrolizumab landscape summary (auto_paginate + summary)",
    "search_patents",
    {
      query: 'ta="pembrolizumab" OR ta="Keytruda"',
      auto_paginate: true,
      detail_level: "summary",
      max_results: 200,
    },
    (r) => {
      const data = parseJson(r);
      if (!data.topApplicants) return "Missing topApplicants in summary";
      if (!data.yearDistribution) return "Missing yearDistribution in summary";
      if (!data.topClassifications) return "Missing topClassifications in summary";
      if (data.results) return "summary mode should NOT return individual results";
      // Merck should be the dominant applicant
      const merck = data.topApplicants.find(
        (a: { name: string }) => a.name.includes("MERCK")
      );
      if (!merck) return "Expected MERCK in topApplicants for pembrolizumab";
      return null;
    }
  );

  await test(
    "Nivolumab landscape summary (auto_paginate + summary)",
    "search_patents",
    {
      query: 'ta="nivolumab" OR ta="Opdivo"',
      auto_paginate: true,
      detail_level: "summary",
      max_results: 200,
    },
    (r) => {
      const data = parseJson(r);
      if (!data.topApplicants) return "Missing topApplicants";
      // BMS should be the dominant applicant
      const bms = data.topApplicants.find(
        (a: { name: string }) => a.name.includes("BRISTOL")
      );
      if (!bms) return "Expected BRISTOL-MYERS in topApplicants for nivolumab";
      return null;
    }
  );

  /* ── Step 3: Compact results for early PD-1 filings ────────────── */

  await test(
    "Early Merck PD-1 antibody patents (compact, pre-2015)",
    "search_patents",
    {
      query: 'pa="Merck" AND ta="PD-1" AND ta="antibody"',
      published_before: "20150101",
      detail_level: "compact",
      range_end: 25,
    },
    (r) => {
      const data = parseJson(r);
      if (data.totalCount === undefined) return "Missing totalCount";
      // Compact results should have limited fields
      if (data.results?.[0]?.abstract !== undefined) return "Compact should not include abstract";
      if (data.results?.[0]?.inventors !== undefined) return "Compact should not include inventors";
      return null;
    }
  );

  await test(
    "Early BMS/Ono PD-1 antibody patents (compact)",
    "search_patents",
    {
      query: '(pa="Bristol-Myers" OR pa="Ono Pharmaceutical") AND ta="PD-1" AND ta="antibody"',
      published_before: "20150101",
      detail_level: "compact",
      range_end: 25,
    },
    (r) => {
      const data = parseJson(r);
      return data.totalCount > 0 ? null : "Expected early BMS/Ono PD-1 patents";
    }
  );

  /* ── Step 4: Biblio deep dive on key patents ────────────────────── */

  await test(
    "Biblio: EP2170959 (pembrolizumab key patent)",
    "get_patent_details",
    { document_number: "EP2170959" },
    (r) => {
      const data = parseJson(r);
      const b = Array.isArray(data) ? data[0] : data;
      if (!b?.title) return "Missing title";
      const title = b.title.toUpperCase();
      if (!title.includes("PD-1") && !title.includes("PROGRAMMED DEATH"))
        return `Expected PD-1 related title, got: ${b.title}`;
      return null;
    }
  );

  await test(
    "Biblio: EP2161336 (nivolumab key patent)",
    "get_patent_details",
    { document_number: "EP2161336" },
    (r) => {
      const data = parseJson(r);
      const b = Array.isArray(data) ? data[0] : data;
      if (!b?.title) return "Missing title";
      const title = b.title.toUpperCase();
      if (!title.includes("PD-1") && !title.includes("PROGRAMMED DEATH"))
        return `Expected PD-1 related title, got: ${b.title}`;
      return null;
    }
  );

  /* ── Step 5: Legal status — are these patents still active? ─────── */

  await test(
    "Legal status: EP2170959 (pembrolizumab) — patent is active",
    "get_patent_legal_status",
    { document_number: "EP2170959" },
    (r) => {
      const data = parseJson(r);
      if (!data.legalEvents?.length) return "No legal events";
      // Check for PGFP (annual fee payment) — indicates patent is maintained
      const pgfp = data.legalEvents.filter(
        (e: { eventCode: string }) => e.eventCode === "PGFP"
      );
      if (pgfp.length === 0) return "No PGFP events found — cannot confirm patent is active";
      // Most recent PGFP should be recent (within last 2 years)
      const lastPgfp = pgfp[pgfp.length - 1];
      const recentYear = new Date().getFullYear() - 2;
      if (lastPgfp.date && parseInt(lastPgfp.date.slice(0, 4)) < recentYear)
        return `Last PGFP date ${lastPgfp.date} seems too old`;
      return null;
    }
  );

  await test(
    "Legal status: EP2161336 (nivolumab) — patent is active",
    "get_patent_legal_status",
    { document_number: "EP2161336" },
    (r) => {
      const data = parseJson(r);
      const pgfp = data.legalEvents?.filter(
        (e: { eventCode: string }) => e.eventCode === "PGFP"
      );
      if (!pgfp?.length) return "No PGFP events — cannot confirm active status";
      return null;
    }
  );

  /* ── Step 6: Legal events are sorted chronologically ────────────── */

  await test(
    "Legal events are chronologically sorted",
    "get_patent_legal_status",
    { document_number: "EP2170959" },
    (r) => {
      const data = parseJson(r);
      const dates = data.legalEvents
        ?.map((e: { date?: string }) => e.date)
        .filter(Boolean) as string[];
      if (!dates || dates.length < 2) return "Not enough dated events to verify sort";
      for (let i = 1; i < dates.length; i++) {
        if (dates[i] < dates[i - 1])
          return `Events not sorted: ${dates[i - 1]} > ${dates[i]} at index ${i}`;
      }
      return null;
    }
  );

  /* ── Step 7: Forward citations — who is building on these patents? ─ */

  await test(
    "Forward citations: patents citing EP2161336 (nivolumab)",
    "search_patents",
    { query: 'ct="EP2161336"', range_end: 5 },
    (r) => {
      const data = parseJson(r);
      return data.totalCount !== undefined ? null : "Missing totalCount for forward citation search";
    }
  );

  /* ── Step 8: Two-sided date range works for landscape slicing ───── */

  await test(
    "Date range: PD-1 antibody patents 2008-2015",
    "search_patents",
    {
      query: 'ta="anti-PD-1 antibody"',
      published_after: "20080101",
      published_before: "20151231",
      range_end: 5,
    },
    (r) => {
      // Should NOT error (previously broke with pd>=X AND pd<=Y)
      if (getText(r).startsWith("Error:")) return getText(r);
      const data = parseJson(r);
      return data.totalCount > 0 ? null : "Expected results for PD-1 antibody 2008-2015";
    }
  );

}).then(({ failed }) => process.exit(failed > 0 ? 1 : 0));
