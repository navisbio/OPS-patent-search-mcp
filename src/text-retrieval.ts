import { EpoClient, OpsApiError, isOpsInterruption } from "./epo-client.js";
import { fetchWithFamilyFallback, normaliseDocNumber } from "./fallback.js";
import { parseFulltextParagraphs, detectFulltextLanguage, type Paragraph } from "./parsers.js";

export type TextSection = "claims" | "description";
export interface SectionStatus {
  status: "available" | "unavailable" | "empty" | "error" | "not_attempted";
  requestedDocument: string;
  resolvedDocument?: string;
  language?: string;
  paragraphCount: number;
  reason?: string;
  httpStatus?: number;
  code?: string;
}

/** Keep missing text, failed retrieval and actual negative searches distinguishable. */
export async function retrieveTextSections(
  client: EpoClient,
  documentNumber: string,
  inputFormat: string,
  sections: TextSection[],
  fallback: boolean,
  reserveMs = 0
) {
  const sectionStatus: Partial<Record<TextSection, SectionStatus>> = {};
  const paragraphs: Record<TextSection, Paragraph[]> = { claims: [], description: [] };
  let interruption: OpsApiError | undefined;
  let retrievalError: unknown;
  let stopped = false;
  let substituted = false;
  let source = normaliseDocNumber(documentNumber, inputFormat);

  for (const section of ["claims", "description"] as const) {
    if (!sections.includes(section)) continue;
    const status: SectionStatus = { status: "not_attempted", requestedDocument: documentNumber, paragraphCount: 0 };
    sectionStatus[section] = status;
    if (stopped || client.timeRemaining < reserveMs) {
      status.reason = stopped ? "Retrieval stopped after an earlier error." : "Tool time budget exhausted before this section was requested.";
      stopped = true;
      continue;
    }
    const fetch = (d: string, f: string) => section === "claims" ? client.getClaims(d, f) : client.getDescription(d, f);
    try {
      const result = fallback
        ? await fetchWithFamilyFallback(client, source.number, source.format, fetch)
        : { raw: await fetch(source.number, source.format), resolvedDocument: source.number, substituted: false };
      status.resolvedDocument = result.resolvedDocument;
      substituted ||= result.substituted;
      if (result.substituted) source = { number: result.resolvedDocument, format: "docdb" };
      paragraphs[section] = parseFulltextParagraphs(result.raw).filter(p => p.section === section);
      status.paragraphCount = paragraphs[section].length;
      status.language = detectFulltextLanguage(result.raw)[section];
      status.status = status.paragraphCount ? "available" : "empty";
      if (!status.paragraphCount) status.reason = "OPS returned no readable paragraphs for this section.";
    } catch (e) {
      status.reason = e instanceof Error ? e.message : String(e);
      if (e instanceof OpsApiError) {
        status.httpStatus = e.status;
        status.code = e.code;
      }
      if (e instanceof OpsApiError && e.status === 404) {
        status.status = "unavailable";
      } else {
        status.status = "error";
        retrievalError = e;
        if (isOpsInterruption(e)) interruption = e;
        stopped = true;
      }
    }
  }
  const allParagraphs = [...paragraphs.claims, ...paragraphs.description];
  let character = 0;
  allParagraphs.forEach((p, index) => {
    p.index = index;
    p.startChar = character;
    character += p.text.length;
    p.endChar = character;
  });
  return {
    sectionStatus, paragraphs: allParagraphs, claimsCount: paragraphs.claims.length,
    complete: Object.values(sectionStatus).every(s => s.status === "available"),
    interruption, retrievalError, stopped, substituted,
    resolvedDocuments: Object.fromEntries(Object.entries(sectionStatus).filter(([, s]) => s.status === "available").map(([section, s]) => [section, s.resolvedDocument])),
    textLanguage: Object.fromEntries(Object.entries(sectionStatus).filter(([, s]) => s.language).map(([section, s]) => [section, s.language])),
  };
}
