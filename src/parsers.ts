/**
 * Helpers to extract readable data from EPO OPS JSON responses.
 * The OPS JSON structure is deeply nested and inconsistent — these
 * functions normalise it into clean objects.
 */

/* ---------- tiny helpers ---------- */

function asArray<T>(val: T | T[] | undefined): T[] {
  if (val === undefined || val === null) return [];
  return Array.isArray(val) ? val : [val];
}

function extractText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (node.$) return node.$;
  if (node._) return node._;
  if (typeof node === "object") {
    const values = Object.values(node).filter((v) => typeof v === "string");
    return (values[0] as string) ?? JSON.stringify(node);
  }
  return String(node);
}

/** Normalise IPC-R text like "C07K  16/    28            A I" → "C07K16/28". */
function normalizeIpc(raw: string): string {
  // Strip trailing classification level indicator (e.g. "A I", "A N", "F I")
  const cleaned = raw.replace(/\s+[A-F]\s+[INS]\s*$/, "").trim();
  // Collapse all internal whitespace
  return cleaned.replace(/\s+/g, "");
}

/* ---------- document-id helpers ---------- */

interface DocId {
  country: string;
  number: string;
  kind: string;
  date?: string;
  formatted: string;
}

function parseDocId(raw: any): DocId | null {
  if (!raw) return null;
  const country = extractText(raw["country"]) || "";
  const number = extractText(raw["doc-number"]) || "";
  const kind = extractText(raw["kind"]) || "";
  const date = extractText(raw["date"]) || undefined;
  return { country, number, kind, date, formatted: `${country}${number}${kind}` };
}

function pickDocId(refs: any, preferredType = "epodoc"): DocId | null {
  const ids = asArray(refs?.["document-id"]);
  const preferred = ids.find(
    (d: any) => d?.["@document-id-type"] === preferredType
  );
  return parseDocId(preferred ?? ids[0]);
}

/* ---------- search results ---------- */

export interface SearchResultItem {
  publicationNumber: string;
  kindCode?: string;
  title: string;
  applicants: string[];
  inventors: string[];
  classifications: string[];
  publicationDate?: string;
  abstract?: string;
  espacenetUrl?: string;
  /** Heuristic: is full text (claims/description) likely available in EPO OPS? Based on country and kind code. */
  fulltextLikely?: boolean;
}

/**
 * Heuristic for whether EPO OPS is likely to have full text for a document.
 * EP/WO A-kind publications are reliably indexed. US A1 usually available.
 * Granted patents (B1/B2) often lack full text. CN/JP/KR rarely available.
 */
function estimateFulltextAvailability(country: string, kind: string): boolean {
  const c = country.toUpperCase();
  const k = kind.toUpperCase();
  // CN, JP, KR — almost never have full text in OPS
  if (c === "CN" || c === "JP" || c === "KR") return false;
  // EP and WO application publications — reliably indexed
  if ((c === "EP" || c === "WO") && k.startsWith("A")) return true;
  // EP/WO granted — sometimes available but unreliable
  if ((c === "EP" || c === "WO") && k.startsWith("B")) return false;
  // US A1 (published applications) — usually available
  if (c === "US" && k === "A1") return true;
  // US granted (B1/B2) and other US kinds — often not indexed
  if (c === "US") return false;
  // GB, DE, FR application publications — sometimes available
  if ((c === "GB" || c === "DE" || c === "FR") && k.startsWith("A")) return true;
  // Default: unknown, assume unlikely
  return false;
}

export function parseSearchResults(json: string): {
  totalCount: number;
  results: SearchResultItem[];
} {
  const data = JSON.parse(json);
  const biblioSearch =
    data?.["ops:world-patent-data"]?.["ops:biblio-search"] ??
    data?.["ops:world-patent-data"]?.["ops:search-result"];

  const totalCount = parseInt(biblioSearch?.["@total-result-count"] ?? "0", 10);

  const searchResult = biblioSearch?.["ops:search-result"];
  const docs = asArray(
    searchResult?.["exchange-documents"] ??
      searchResult?.["ops:publication-reference"]
  );

  const results: SearchResultItem[] = [];

  for (const wrapper of docs) {
    const exDoc = wrapper?.["exchange-document"] ?? wrapper;
    if (!exDoc) continue;

    const biblio = exDoc?.["bibliographic-data"] ?? exDoc;
    const pubRef = biblio?.["publication-reference"];
    const docId = pickDocId(pubRef);

    const titles = asArray(biblio?.["invention-title"]);
    const enTitle = titles.find((t: any) => t?.["@lang"] === "en") ?? titles[0];
    const title = extractText(enTitle);

    const applicants = asArray(
      biblio?.parties?.applicants?.applicant
    ).map((a: any) => extractText(a?.["applicant-name"]?.name));

    const inventors = asArray(
      biblio?.parties?.inventors?.inventor
    ).map((i: any) => extractText(i?.["inventor-name"]?.name));

    const ipcrs = asArray(biblio?.["classifications-ipcr"]?.["classification-ipcr"]);
    const classifications = ipcrs.map((c: any) => normalizeIpc(extractText(c?.text)));

    const abstracts = asArray(exDoc?.abstract ?? biblio?.abstract);
    const enAbstract = abstracts.find((a: any) => a?.["@lang"] === "en") ?? abstracts[0];
    const abstractParts = asArray(enAbstract?.p);
    const abstractText = abstractParts.map(extractText).join(" ").trim();

    const pubDate = docId?.date;

    const pubNum = docId?.formatted ?? "unknown";
    const country = docId?.country ?? "";
    const kind = docId?.kind ?? "";
    results.push({
      publicationNumber: pubNum,
      kindCode: kind || undefined,
      title,
      applicants: applicants.filter(Boolean),
      inventors: inventors.filter(Boolean),
      classifications: classifications.filter(Boolean),
      publicationDate: pubDate,
      abstract: abstractText || undefined,
      espacenetUrl: `https://worldwide.espacenet.com/patent/search?q=pn%3D${encodeURIComponent(pubNum)}`,
      fulltextLikely: estimateFulltextAvailability(country, kind),
    });
  }

  return { totalCount, results };
}

/* ---------- biblio ---------- */

export interface PriorityClaim {
  number: string;
  date?: string;
  country?: string;
}

export interface PatentBiblio {
  publicationNumber: string;
  kindCode?: string;
  applicationNumber?: string;
  title: string;
  abstract?: string;
  applicants: string[];
  inventors: string[];
  ipcClassifications: string[];
  cpcClassifications: string[];
  publicationDate?: string;
  applicationDate?: string;
  priorityClaims: PriorityClaim[];
  espacenetUrl?: string;
}

export function parseBiblio(json: string): PatentBiblio[] {
  const data = JSON.parse(json);
  const exDocs = asArray(
    data?.["ops:world-patent-data"]?.["exchange-documents"]?.["exchange-document"] ??
      data?.["ops:world-patent-data"]?.["exchange-document"]
  );

  return exDocs.map((exDoc: any) => {
    const biblio = exDoc?.["bibliographic-data"] ?? exDoc;
    const pubRef = biblio?.["publication-reference"];
    const appRef = biblio?.["application-reference"];
    const docId = pickDocId(pubRef);
    const appId = pickDocId(appRef);

    const titles = asArray(biblio?.["invention-title"]);
    const enTitle = titles.find((t: any) => t?.["@lang"] === "en") ?? titles[0];

    const applicants = asArray(biblio?.parties?.applicants?.applicant).map(
      (a: any) => extractText(a?.["applicant-name"]?.name)
    );
    const inventors = asArray(biblio?.parties?.inventors?.inventor).map(
      (i: any) => extractText(i?.["inventor-name"]?.name)
    );

    const ipcrs = asArray(biblio?.["classifications-ipcr"]?.["classification-ipcr"]);
    const ipcClassifications = ipcrs.map((c: any) => normalizeIpc(extractText(c?.text)));

    const cpcs = asArray(biblio?.["patent-classifications"]?.["patent-classification"]);
    const cpcClassifications = cpcs
      .filter((c: any) => extractText(c?.["classification-scheme"]?.["@scheme"]) === "CPC")
      .map((c: any) => {
        const section = extractText(c?.section);
        const cls = extractText(c?.class);
        const subclass = extractText(c?.subclass);
        const main = extractText(c?.["main-group"]);
        const sub = extractText(c?.subgroup);
        return `${section}${cls}${subclass}${main}/${sub}`.trim();
      });

    const abstracts = asArray(exDoc?.abstract ?? biblio?.abstract);
    const enAbstract = abstracts.find((a: any) => a?.["@lang"] === "en") ?? abstracts[0];
    const abstractParts = asArray(enAbstract?.p);
    const abstractText = abstractParts.map(extractText).join(" ").trim();

    const priorities = asArray(biblio?.["priority-claims"]?.["priority-claim"]);
    const priorityClaims: PriorityClaim[] = priorities.map((p: any) => {
      const id = pickDocId(p);
      return {
        number: id?.formatted ?? extractText(p),
        date: id?.date || undefined,
        country: id?.country || undefined,
      };
    }).filter((p: PriorityClaim) => p.number);

    const pubNum = docId?.formatted ?? "unknown";
    const kindCode = docId?.kind || undefined;
    // Build Espacenet URL from country + doc-number
    const espacenetUrl = docId
      ? `https://worldwide.espacenet.com/patent/search?q=pn%3D${encodeURIComponent(pubNum)}`
      : undefined;

    return {
      publicationNumber: pubNum,
      kindCode,
      applicationNumber: appId?.formatted,
      title: extractText(enTitle),
      abstract: abstractText || undefined,
      applicants: applicants.filter(Boolean),
      inventors: inventors.filter(Boolean),
      ipcClassifications: ipcClassifications.filter(Boolean),
      cpcClassifications: cpcClassifications.filter(Boolean),
      publicationDate: docId?.date,
      applicationDate: appId?.date,
      priorityClaims,
      espacenetUrl,
    };
  });
}

/* ---------- fulltext: paragraph-level parsing ---------- */

export interface Paragraph {
  index: number;
  section: "claims" | "description";
  text: string;
  startChar: number;
  endChar: number;
}

/**
 * Parse fulltext JSON into an array of paragraphs with character offsets.
 * Works for both claims and description responses.
 */
export function parseFulltextParagraphs(json: string): Paragraph[] {
  const data = JSON.parse(json);
  const doc =
    data?.["ops:world-patent-data"]?.["ftxt:fulltext-documents"]?.[
      "ftxt:fulltext-document"
    ];

  if (!doc) return [];

  const paragraphs: Paragraph[] = [];
  let charOffset = 0;
  let idx = 0;

  // Claims: doc.claims.claim.claim-text[].$
  const claims = doc?.claims;
  if (claims) {
    const claimEntries = asArray(claims?.claim);
    for (const claim of claimEntries) {
      const texts = asArray(claim?.["claim-text"]);
      for (const t of texts) {
        const text = extractText(t);
        if (!text) continue;
        const startChar = charOffset;
        charOffset += text.length;
        paragraphs.push({
          index: idx++,
          section: "claims",
          text,
          startChar,
          endChar: charOffset,
        });
      }
    }
  }

  // Description: doc.description.p[].$
  const description = doc?.description;
  if (description) {
    const paras = asArray(description?.p);
    for (const p of paras) {
      const text = extractText(p);
      if (!text) continue;
      const startChar = charOffset;
      charOffset += text.length;
      paragraphs.push({
        index: idx++,
        section: "description",
        text,
        startChar,
        endChar: charOffset,
      });
    }
  }

  return paragraphs;
}

/* ---------- paginated fulltext ---------- */

export interface PaginatedText {
  paragraphs: { index: number; section: string; text: string }[];
  totalParagraphs: number;
  totalCharacters: number;
  returnedCharacters: number;
  nextOffset: number | null;
  truncated: boolean;
}

export function paginateParagraphs(
  paragraphs: Paragraph[],
  offset: number = 0,
  limit?: number,
  maxCharacters?: number
): PaginatedText {
  const totalCharacters = paragraphs.length > 0
    ? paragraphs[paragraphs.length - 1].endChar
    : 0;

  const sliceStart = Math.max(0, Math.min(offset, paragraphs.length));
  const sliceEnd = limit !== undefined
    ? Math.min(sliceStart + limit, paragraphs.length)
    : paragraphs.length;

  const selected: { index: number; section: string; text: string }[] = [];
  let usedChars = 0;
  let truncated = false;
  let lastIncluded = sliceStart - 1;

  for (let i = sliceStart; i < sliceEnd; i++) {
    const p = paragraphs[i];
    if (maxCharacters !== undefined && usedChars + p.text.length > maxCharacters) {
      // Include a truncated version of this paragraph
      const remaining = maxCharacters - usedChars;
      if (remaining > 50) {
        selected.push({
          index: p.index,
          section: p.section,
          text: p.text.slice(0, remaining) + "…",
        });
        usedChars += remaining;
      }
      truncated = true;
      lastIncluded = i;
      break;
    }
    selected.push({ index: p.index, section: p.section, text: p.text });
    usedChars += p.text.length;
    lastIncluded = i;
  }

  const nextOffset =
    lastIncluded + 1 < paragraphs.length ? lastIncluded + 1 : null;

  return {
    paragraphs: selected,
    totalParagraphs: paragraphs.length,
    totalCharacters,
    returnedCharacters: usedChars,
    nextOffset,
    truncated,
  };
}

/* ---------- keyword search in fulltext ---------- */

export interface KeywordSnippet {
  keyword: string;
  matchText: string;
  snippet: string;
  section: string;
  paragraphIndex: number;
  startChar: number;
}

export interface KeywordSearchResult {
  totalMatchCount: number;
  matchCountByKeyword: Record<string, number>;
  matches: KeywordSnippet[];
}

export function searchKeywordsInParagraphs(
  paragraphs: Paragraph[],
  terms: string[],
  options: {
    contextChars?: number;
    limit?: number;
    caseSensitive?: boolean;
    sectionFilter?: string[];
  } = {}
): KeywordSearchResult {
  const contextChars = options.contextChars ?? 150;
  const limit = options.limit ?? 30;
  const caseSensitive = options.caseSensitive ?? false;
  const sectionFilter = options.sectionFilter?.map((s) => s.toLowerCase());

  const patterns = terms.map((term) => ({
    term,
    regex: new RegExp(
      term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      caseSensitive ? "g" : "gi"
    ),
  }));

  const matches: KeywordSnippet[] = [];
  let totalMatchCount = 0;
  const matchCountByKeyword: Record<string, number> = {};
  for (const { term } of patterns) matchCountByKeyword[term] = 0;

  for (const p of paragraphs) {
    if (sectionFilter && !sectionFilter.includes(p.section.toLowerCase())) {
      continue;
    }

    for (const { term, regex } of patterns) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(p.text)) !== null) {
        totalMatchCount++;
        matchCountByKeyword[term]++;

        if (matches.length < limit) {
          const start = match.index;
          const end = start + match[0].length;
          const snippetStart = Math.max(0, start - contextChars);
          const snippetEnd = Math.min(p.text.length, end + contextChars);

          let snippet = p.text.slice(snippetStart, snippetEnd);
          if (snippetStart > 0) snippet = "…" + snippet;
          if (snippetEnd < p.text.length) snippet = snippet + "…";

          matches.push({
            keyword: term,
            matchText: match[0],
            snippet,
            section: p.section,
            paragraphIndex: p.index,
            startChar: p.startChar + start,
          });
        }
      }
    }
  }

  return { totalMatchCount, matchCountByKeyword, matches };
}

/* ---------- family ---------- */

export interface FamilyMember {
  publicationNumber: string;
  /** Raw doc number (without country/kind) — use with country + kind to form docdb API format */
  rawNumber: string;
  title?: string;
  country: string;
  kind: string;
  publicationDate?: string;
}

export function parseFamilyMembers(json: string): FamilyMember[] {
  const data = JSON.parse(json);
  const members = asArray(
    data?.["ops:world-patent-data"]?.["ops:patent-family"]?.["ops:family-member"]
  );

  const results: FamilyMember[] = [];
  for (const m of members) {
    const pubRef = m?.["publication-reference"];
    // Use docdb format for family members — it has separate country/kind fields
    const docId = pickDocId(pubRef, "docdb");
    if (!docId) continue;

    const titles = asArray(m?.["bibliographic-data"]?.["invention-title"] ?? m?.["invention-title"]);
    const enTitle = titles.find((t: any) => t?.["@lang"] === "en") ?? titles[0];

    results.push({
      publicationNumber: docId.formatted,
      rawNumber: docId.number,
      title: enTitle ? extractText(enTitle) : undefined,
      country: docId.country,
      kind: docId.kind,
      publicationDate: docId.date,
    });
  }
  return results;
}

/* ---------- legal status ---------- */

export interface LegalEvent {
  eventCode: string;
  eventType?: string;
  description?: string;
  date?: string;
  country?: string;
  /** Contracting state from PG25/PGFP events (e.g. "DE", "FR") */
  refCountryCode?: string;
  /** Effective date from ops:L525EP (YYYYMMDD format) */
  effectiveDate?: string;
  /** Free-form text with additional details (e.g. lapse reason, SPC info) */
  freeText?: string;
  /** Year of fee payment from PGFP events */
  yearOfFeePayment?: string;
}

export function parseLegalEvents(json: string): LegalEvent[] {
  const data = JSON.parse(json);
  const wpd = data?.["ops:world-patent-data"];

  // The /legal endpoint returns ops:patent-family with ops:legal per family member.
  // Each event entry has @code, @desc, ops:L001EP (country), ops:L007EP (gazette date), etc.
  const family = wpd?.["ops:patent-family"];
  if (family) {
    const members = asArray(family?.["ops:family-member"]);
    const events: LegalEvent[] = [];
    for (const member of members) {
      const legalEntries = asArray(member?.["ops:legal"]);
      for (const entry of legalEntries) {
        const code = (entry?.["@code"] as string) || "unknown";
        const desc = (entry?.["@desc"] as string) || undefined;
        const country = extractText(entry?.["ops:L001EP"]) || undefined;
        // ops:L007EP = Gazette date, ops:L019EP = date first created
        const date =
          extractText(entry?.["ops:L007EP"]) ||
          extractText(entry?.["ops:L019EP"]) ||
          undefined;

        // Extract structured sub-fields from ops:L500EP
        const l500 = entry?.["ops:L500EP"];
        const refCountryCode = extractText(l500?.["ops:L501EP"]) || undefined;
        const effectiveDate = extractText(l500?.["ops:L525EP"]) || undefined;
        const freeText = extractText(l500?.["ops:L510EP"]) || undefined;
        const yearOfFeePayment = extractText(l500?.["ops:L520EP"]) || undefined;

        const event: LegalEvent = { eventCode: code, description: desc, country, date };
        if (refCountryCode) event.refCountryCode = refCountryCode;
        if (effectiveDate) event.effectiveDate = effectiveDate;
        if (freeText) event.freeText = freeText;
        if (yearOfFeePayment) event.yearOfFeePayment = yearOfFeePayment;
        events.push(event);
      }
    }
    // Sort chronologically (YYYYMMDD strings sort lexicographically)
    return events.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }

  return [];
}

/* ---------- citations ---------- */

export interface PatentCitation {
  type: "patent" | "npl";
  publicationNumber?: string;
  text?: string;
  category?: string;
}

export function parseCitations(json: string): PatentCitation[] {
  const data = JSON.parse(json);
  const exDocs = asArray(
    data?.["ops:world-patent-data"]?.["exchange-documents"]?.["exchange-document"] ??
      data?.["ops:world-patent-data"]?.["exchange-document"]
  );

  const citations: PatentCitation[] = [];
  for (const exDoc of exDocs) {
    const biblio = exDoc?.["bibliographic-data"] ?? exDoc;
    const refs = asArray(biblio?.["references-cited"]?.citation);
    for (const ref of refs) {
      const category = ref?.["@category"] ?? undefined;
      if (ref?.patcit) {
        // Prefer docdb format (includes kind code) for unambiguous publication numbers
        const docId = pickDocId(ref.patcit, "docdb") ?? pickDocId(ref.patcit);
        citations.push({
          type: "patent",
          publicationNumber: docId?.formatted,
          category: category ? extractText(category) : undefined,
        });
      } else if (ref?.nplcit) {
        citations.push({
          type: "npl",
          text: extractText(ref.nplcit?.text ?? ref.nplcit),
          category: category ? extractText(category) : undefined,
        });
      }
    }
  }
  return citations;
}
