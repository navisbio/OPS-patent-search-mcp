import type { ThrottleStatus } from "./epo-client.js";
import { isOpsInterruption, interruptionDetails } from "./epo-client.js";

export const GROUNDING_NOTICE =
  "GROUNDING: Only patent numbers, dates, names, and text that appear in this response may be cited in your output. Never supplement with patent numbers from your own knowledge. When quoting patent claims or description passages, use the exact text returned here — do not paraphrase from memory.";

type ThrottleSource = { lastThrottle: ThrottleStatus | null; lastPaceMs?: number; lastPaceColor?: string; lastPaceService?: string; effectiveThrottle?: ThrottleStatus | null;
  lastRetry?: { attempts: number; waitedMs: number; rateLimitEvents: number } };

export function createHelpers(client: ThrottleSource) {
  function errorResult(e: unknown) {
    if (isOpsInterruption(e)) {
      return { ...jsonResult(interruptionDetails(e)), isError: true };
    }
    const msg = e instanceof Error ? e.message : String(e);
    const throttle = client.effectiveThrottle === undefined ? client.lastThrottle : client.effectiveThrottle;
    const parts = [`Error: ${msg}`];
    if (/ambiguous/i.test(msg)) {
      parts.push(
        `\nHint: OPS found several publications for this number (e.g. A1 and B1). Give a kind code in docdb format, e.g. "EP.1234567.B1", or use epodoc format ("EP1234567") to take the first one.`
      );
    }
    if (/3 characters required when '\*'/i.test(msg)) {
      parts.push(
        `\nHint: hyphens split a term into tokens, so freeze-dr* is read as dr*. Use the full word ("freeze-drying") or an unhyphenated stem with at least 3 characters before the *.`
      );
    }
    if (throttle?.overallStatus === "overloaded") parts.push("\nOPS reports high service load; the server moderates requests using conservative limits over 60 seconds.");
    if (throttle?.isThrottled) {
      parts.push(
        `\nRate limit status: ${throttle.overallStatus}. ` +
        Object.entries(throttle.services)
          .filter(([, s]) => s.color !== "green")
          .map(([name, s]) => `${name}=${s.color}:${s.requestLimit}`)
          .join(", ") +
        `. Wait 1-2 minutes before retrying.`
      );
    }
    return {
      content: [{ type: "text" as const, text: parts.join("") }],
      isError: true,
    };
  }

  function jsonResult(data: unknown, { grounding = false }: { grounding?: boolean } = {}) {
    const enriched = appendThrottleInfo(data);
    const content: { type: "text"; text: string }[] = [
      { type: "text" as const, text: JSON.stringify(enriched, null, 2) },
    ];
    if (Array.isArray(data)) {
      const metadata = appendThrottleInfo({});
      if (Object.keys(metadata as object).length) content.push({ type: "text", text: JSON.stringify(metadata, null, 2) });
    }
    if (grounding) {
      content.push({ type: "text" as const, text: GROUNDING_NOTICE });
    }
    return { content };
  }

  /** Append a compact throttle summary to any response object when rate limits are approaching. */
  function appendThrottleInfo(data: unknown): unknown {
    if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
    const retry = client.lastRetry;
    if (retry && (retry.attempts > 0 || retry.waitedMs > 0 || retry.rateLimitEvents > 0)) {
      data = { ...data, _retry: { ...retry } };
    }
    const throttle = client.effectiveThrottle === undefined ? client.lastThrottle : client.effectiveThrottle;
    if (!throttle) return data;

    const quota: Record<string, unknown> = {};
    for (const [service, status] of Object.entries(throttle.services)) {
      quota[service] = { requestLimit: status.requestLimit, status: status.color };
    }

    const throttleInfo = {
      overallStatus: client.lastThrottle?.overallStatus ?? throttle.overallStatus,
      effectiveOverallStatus: throttle.overallStatus,
      observationWindowSeconds: 60,
      isOverloaded: throttle.overallStatus === "overloaded",
      isThrottled: throttle.isThrottled,
      quota,
      ...(throttle.overallStatus === "overloaded" && {
        loadWarning: "OPS reports high service load. The server paces requests using conservative limits over 60 seconds. Preserve returned results and avoid parallel tool calls; overload alone is not an HTTP rate-limit failure.",
      }),
      ...(throttle.isThrottled && {
        warning: "EPO OPS rate limits are approaching. Space out requests or wait 1-2 minutes to avoid timeouts.",
      }),
      ...((client.lastPaceMs ?? 0) > 0 && {
        pacingWaitMs: client.lastPaceMs,
        pacing: `The server waited ${client.lastPaceMs! / 1000}s in total during this tool call. The most recent paced service was ${client.lastPaceService ?? "search"} (${client.lastPaceColor}). Requests are spaced automatically; follow retryAfterSeconds if a request is deferred, and prefer batch tools over repeated count_only calls.`,
      }),
    };

    if (typeof data === "object" && data !== null && !Array.isArray(data)) {
      const zero = (data as Record<string, unknown>).totalCount === 0;
      return { ...data, _throttle: throttleInfo,
        ...(zero && throttle.overallStatus === "overloaded" && {
          verificationRecommended: true,
          loadQualification: "OPS returned zero search results while overload was observed. Consider confirming after load subsides before concluding absence; overload does not establish that this result is incorrect.",
        }),
      };
    }
    return data;
  }

  return { errorResult, jsonResult, appendThrottleInfo };
}
