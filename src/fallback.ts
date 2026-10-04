import { EpoClient, OpsApiError } from "./epo-client.js";
import { parseFamilyMembers } from "./parsers.js";

/** Compute alternative kind codes to try for a document number before family fallback. */
export function computeKindFallbacks(docNumber: string, inputFormat: string): string[] {
  // Only works for epodoc-style numbers where we can extract country+number
  if (inputFormat === "docdb") {
    // docdb format: CC.number.KK — extract parts and try other kind codes
    const parts = docNumber.split(".");
    if (parts.length === 3) {
      const [cc, num, currentKind] = parts;
      // Only try A1/B1 — covers >90% of cases without excessive API calls
      return ["A1", "B1"]
        .filter((k) => k !== currentKind)
        .map((k) => `${cc}.${num}.${k}`);
    }
    return [];
  }
  // epodoc: e.g. EP1000000 — try docdb format with A1/B1 kind codes
  const m = docNumber.match(/^([A-Z]{2})(.+)$/);
  if (!m) return [];
  const [, cc, num] = m;
  return ["A1", "B1"].map((k) => `${cc}.${num}.${k}`);
}

/**
 * The OPS family endpoint rejects some numbers in epodoc format that the
 * biblio endpoint accepts (US application publications such as US2023233694,
 * some WO numbers). Those resolve in docdb format with an explicit kind code.
 * Retry with the common kind codes before giving up so that get_patent_family
 * and the full-text family fallback do not dead-end on documents that
 * get_patent_details just returned.
 */
export async function getFamilyWithFormatFallback(
  client: EpoClient,
  docNumber: string,
  inputFormat: string,
  light = false
): Promise<{ raw: string; resolvedAs: string }> {
  const fetch = (d: string, f: string) => (light ? client.getFamilyLight(d, f) : client.getFamily(d, f));
  try {
    return { raw: await fetch(docNumber, inputFormat), resolvedAs: docNumber };
  } catch (e) {
    if (!(e instanceof OpsApiError) || e.status !== 404 || inputFormat !== "epodoc") throw e;
    const m = docNumber.match(/^([A-Z]{2})(\d+)$/);
    if (!m) throw e;
    const [, cc, num] = m;
    for (const kind of ["A1", "A2", "B1", "B2", "A", "B"]) {
      const alt = `${cc}.${num}.${kind}`;
      try {
        return { raw: await fetch(alt, "docdb"), resolvedAs: alt };
      } catch (inner) {
        if (!(inner instanceof OpsApiError) || inner.status !== 404) throw inner;
      }
    }
    throw e;
  }
}

/**
 * Try to fetch fulltext (claims or description) for a document.
 * If the initial fetch returns 404, fetch the patent family and try
 * EP/WO members first (most reliably indexed in OPS), then others.
 * Returns the raw JSON, the document that succeeded, and whether a
 * family substitution was made.
 */
export async function fetchWithFamilyFallback(
  client: EpoClient,
  docNumber: string,
  inputFormat: string,
  fetcher: (docNum: string, fmt: string) => Promise<string>
): Promise<{ raw: string; resolvedDocument: string; substituted: boolean }> {
  try {
    const raw = await fetcher(docNumber, inputFormat);
    return { raw, resolvedDocument: docNumber, substituted: false };
  } catch (e) {
    if (!(e instanceof OpsApiError) || e.status !== 404) throw e;
  }

  // 404 — try alternative kind codes for the same patent before family lookup
  const kindFallbacks = computeKindFallbacks(docNumber, inputFormat);
  for (const alt of kindFallbacks) {
    try {
      const raw = await fetcher(alt, "docdb");
      return { raw, resolvedDocument: alt, substituted: true };
    } catch {
      // try next kind code
    }
  }

  // Still 404 — try the patent family
  let familyRaw: string;
  try {
    familyRaw = (await getFamilyWithFormatFallback(client, docNumber, inputFormat)).raw;
  } catch (e) {
    // Very large families (Xencor, Immunomedics) are refused with "smaller
    // chunks"; the light variant still lists members, which is all we need.
    if (e instanceof OpsApiError && e.message.includes("smaller chunks")) {
      try {
        familyRaw = (await getFamilyWithFormatFallback(client, docNumber, inputFormat, true)).raw;
      } catch {
        throw new OpsApiError(
          404,
          `Full text not available for ${docNumber} and could not retrieve patent family for fallback.`
        );
      }
    } else {
      throw new OpsApiError(
        404,
        `Full text not available for ${docNumber} and could not retrieve patent family for fallback.`
      );
    }
  }

  const members = parseFamilyMembers(familyRaw);
  if (members.length === 0) {
    throw new OpsApiError(
      404,
      `Full text not available for ${docNumber} and no family members found.`
    );
  }

  // Prioritise offices most likely to have full text in OPS
  const priority = ["EP", "WO", "GB", "DE", "FR"];
  const sorted = [...members].sort((a, b) => {
    const ai = priority.indexOf(a.country);
    const bi = priority.indexOf(b.country);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });

  for (const member of sorted) {
    if (!member.kind || !member.rawNumber) continue;
    // Docdb format expected by OPS: CC.number.KK  e.g. EP.3750919.A1
    const docdbNum = `${member.country}.${member.rawNumber}.${member.kind}`;
    try {
      const raw = await fetcher(docdbNum, "docdb");
      return { raw, resolvedDocument: docdbNum, substituted: true };
    } catch {
      // try next member
    }
  }

  throw new OpsApiError(
    404,
    `Full text not available for ${docNumber} or any of its ${members.length} family member(s). ` +
      `Family includes: ${members
        .slice(0, 8)
        .map((m) => m.publicationNumber)
        .join(", ")}${members.length > 8 ? "…" : ""}.`
  );
}

/** Note when full text was taken from a family member rather than the requested document. */
export function substitutionNote(
  requested: string,
  resolved: string,
  section: "claims" | "description",
  empty: boolean
): string {
  if (empty) {
    return section === "claims"
      ? `Full text not available for ${requested}. Attempted family member ${resolved} but it also returned no claims. Granted patent claims (B1/B2 kind codes) are often not available via OPS. Check Espacenet web or USPTO PAIR for granted claim text.`
      : `Full text not available for ${requested}. Attempted family member ${resolved} but it also returned no description. Granted patents (B1/B2) often lack full text in OPS. Try the A1/A2 version or check Espacenet web.`;
  }
  return `Full text not available for ${requested}. Showing ${section} from family member ${resolved}.`;
}
