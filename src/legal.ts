import type { LegalEvent } from "./parsers.js";

/** Grant events across offices. EP publishes the grant as GRAA "(EXPECTED) GRANT"
 *  plus a STAA status line "THE PATENT HAS BEEN GRANTED"; neither carries the
 *  word "granted" in its description, which is why granted patents were
 *  reported as pending until 2026-09. */
export function isGrantEvent(e: LegalEvent): boolean {
  const code = (e.eventCode ?? "").trim().toUpperCase();
  const desc = (e.description ?? "").toLowerCase();
  const free = (e.freeText ?? "").toUpperCase();
  return (
    code === "B1" || code === "B2" ||   // EP grant publication
    code === "STCF" ||                  // US: patent grant
    code === "GRAA" ||                  // EP: mention of grant in the Bulletin
    (code === "STAA" && free.includes("HAS BEEN GRANTED")) ||
    desc.includes("patent granted") ||
    desc.includes("grant of patent") ||
    desc.includes("decision to grant") ||
    desc.includes("rule 71(3)") ||
    desc.includes("b1 publication") ||
    desc.includes("b2 publication")
  );
}

/** SPC / PTE events. EP national SPC registrations arrive as REG events whose
 *  free text starts with "PRODUCT NAME:"; the description ("REFERENCE TO A
 *  NATIONAL CODE") says nothing about SPCs. */
export function isSpcEvent(e: LegalEvent): boolean {
  const code = (e.eventCode ?? "").trim().toUpperCase();
  const desc = (e.description ?? "").toLowerCase();
  const free = (e.freeText ?? "").toUpperCase();
  if (code === "CC" || desc === "certificate of correction") return false;
  return (
    desc.includes("supplementary protection") ||
    desc.includes("patent term extension") ||
    code === "PTEF" ||     // US: PTE filed
    code === "PTEG" ||     // US: PTE granted
    (code === "REG" && /PRODUCT NAME|\bSPC\b|SUPPLEMENTARY PROTECTION|CERTIFICATE/.test(free))
  );
}

export function summarizeLegalStatus(events: LegalEvent[]): {
  granted: boolean;
  lapsed: boolean;
  oppositionFiled: boolean;
  spcOrPte: boolean;
  /** EP contracting states with an SPC registration (from national REG events) */
  spcStates: string[];
  keyEvents: string[];
  /** EP contracting states where the patent has lapsed (from PG25 events) */
  lapsedStates: string[];
  /** EP contracting states where annual fees are paid (from PGFP events) */
  activeStates: string[];
  /** SPC/PTE details extracted from event free text, if available */
  spcOrPteDetails: string[];
} {
  let granted = false;
  let lapsed = false;
  let oppositionFiled = false;
  let spcOrPte = false;
  const keyEvents: string[] = [];
  const lapsedStates = new Set<string>();
  const activeStates = new Set<string>();
  const spcStates = new Set<string>();
  const spcOrPteDetails: string[] = [];

  for (const e of events) {
    const code = (e.eventCode ?? "").toUpperCase();
    const desc = (e.description ?? "").toLowerCase();
    const dateStr = e.date ? ` (${e.date})` : "";
    const ctry = e.country ? `[${e.country}] ` : "";

    if (isGrantEvent(e)) {
      granted = true;
      keyEvents.push(`${ctry}Granted${dateStr}`);
    }
    // US abandonment — STCB = examination discontinued / abandoned
    if (code === "STCB" || desc.includes("abandoned")) {
      lapsed = true;
      keyEvents.push(`${ctry}Abandoned${dateStr}`);
    }
    // Lapse / cessation / expiry — track contracting states from PG25
    if (code === "PG25" && e.refCountryCode) {
      lapsedStates.add(e.refCountryCode);
      // Don't add per-state PG25 to keyEvents (too noisy) — the lapsedStates array covers it
    } else if (desc.includes("lapse") || desc.includes("ceased") || desc.includes("expired") || desc.includes("not in force") || desc.includes("patent ceased") || code === "PGFP-LAPSE") {
      lapsed = true;
      keyEvents.push(`${ctry}Lapsed/ceased${dateStr}`);
    }
    // PGFP — annual fee paid, track active contracting states
    if (code === "PGFP" && e.refCountryCode) {
      activeStates.add(e.refCountryCode);
      // Don't add per-state PGFP to keyEvents
    }
    // Withdrawal
    if (desc.includes("withdrawn") || desc.includes("withdrawal")) {
      lapsed = true;
      keyEvents.push(`${ctry}Withdrawn${dateStr}`);
    }
    // Opposition — must distinguish actual opposition from "no opposition filed" events
    if (code.startsWith("OPP")) {
      oppositionFiled = true;
      keyEvents.push(`${ctry}Opposition${dateStr}`);
    } else if (desc.includes("opposition")) {
      // Exclude "no opposition" / "no opposition filed" events (PLBE, 26N, etc.)
      if (!desc.includes("no opposition")) {
        oppositionFiled = true;
        keyEvents.push(`${ctry}Opposition${dateStr}`);
      }
    }
    if (isSpcEvent(e)) {
      spcOrPte = true;
      if (e.refCountryCode) spcStates.add(e.refCountryCode);
      // One keyEvent per SPC would swamp the summary (Keytruda's EP has 100+
      // national REG events); a single line is added after the loop.
      if (e.freeText) {
        spcOrPteDetails.push(`${e.refCountryCode ? `[${e.refCountryCode}] ` : ""}${e.freeText}`);
      }
    }
  }

  if (spcOrPte) {
    keyEvents.push(
      spcStates.size > 0
        ? `SPC/PTE registered in ${[...spcStates].sort().join(", ")}`
        : "SPC/PTE recorded"
    );
  }

  // If we have PG25 lapse data, also set the overall lapsed flag if ALL states have lapsed
  if (lapsedStates.size > 0 && activeStates.size === 0) {
    lapsed = true;
  }

  // PGFP heuristic: if annual fees are being paid but no explicit grant event was detected,
  // the patent must have been granted (you don't pay maintenance fees on applications)
  if (!granted && activeStates.size > 0) {
    granted = true;
    keyEvents.push("Granted (inferred from fee payments)");
  }

  return {
    granted, lapsed, oppositionFiled, spcOrPte,
    spcStates: [...spcStates].sort(),
    keyEvents: [...new Set(keyEvents)],
    lapsedStates: [...lapsedStates].sort(),
    activeStates: [...activeStates].sort(),
    spcOrPteDetails: [...new Set(spcOrPteDetails)].slice(0, 60),
  };
}
