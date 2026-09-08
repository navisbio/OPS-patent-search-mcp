/**
 * EPO Open Patent Services (OPS) API client.
 * Handles OAuth2 authentication and provides methods for search/retrieval.
 */

const TOKEN_URL = "https://ops.epo.org/3.2/auth/accesstoken";
const BASE_URL = "https://ops.epo.org/3.2/rest-services";

/**
 * Tool call budget: how long an entire tool call may run before we bail out
 * with a clean message (instead of letting the MCP client timeout kill us).
 * Tuneable via OPS_TOOL_TIMEOUT_MS. Default 55s leaves a 5s margin before
 * the MCP client's 60s default timeout.
 */
const TOOL_TIMEOUT_MS = parseInt(process.env.OPS_TOOL_TIMEOUT_MS ?? "55000", 10);
/** Per-request timeout — individual HTTP call to OPS. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Base delay for exponential backoff on retries. */
const BACKOFF_BASE_MS = 2_000;

interface TokenInfo {
  accessToken: string;
  expiresAt: number;
}

/* ---------- throttle tracking ---------- */

export interface ThrottleStatus {
  /** Per-service status from X-Throttling-Control header. */
  services: Record<string, { color: string; remaining: number }>;
  /** Overall status: idle, busy, or overloaded. */
  overallStatus: string;
  /** True if any service is orange/red/black (approaching or at limit). */
  isThrottled: boolean;
  /** Raw header value for debugging. */
  raw: string;
}

/**
 * Parse the EPO OPS X-Throttling-Control header.
 * Format: "idle (images=green:200, inpadoc=green:60, other=green:1000, retrieval=green:200, search=green:30)"
 */
function parseThrottleHeader(header: string | null): ThrottleStatus | null {
  if (!header) return null;
  const overallMatch = header.match(/^(\w+)\s*\(/);
  const overallStatus = overallMatch?.[1] ?? "unknown";
  const services: Record<string, { color: string; remaining: number }> = {};
  const servicePattern = /(\w+)=(\w+):(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = servicePattern.exec(header)) !== null) {
    services[match[1]] = { color: match[2], remaining: parseInt(match[3], 10) };
  }
  const isThrottled = Object.values(services).some(
    (s) => s.color === "orange" || s.color === "red" || s.color === "black"
  );
  return { services, overallStatus, isThrottled, raw: header };
}

/** Structured error from OPS API with human-readable message. */
export class OpsApiError extends Error {
  public readonly status: number;
  public readonly code: string;

  constructor(status: number, message: string, code: string = "") {
    super(message);
    this.name = "OpsApiError";
    this.status = status;
    this.code = code;
  }
}

/** Extract a human-readable message from OPS XML error responses. */
function parseOpsError(status: number, body: string, path: string): OpsApiError {
  // OPS errors are XML like: <fault><code>...</code><message>...</message></fault>
  const codeMatch = body.match(/<code>\s*(.*?)\s*<\/code>/);
  const msgMatch = body.match(/<message>\s*(.*?)\s*<\/message>/);
  const code = codeMatch?.[1] ?? "";
  const rawMsg = msgMatch?.[1] ?? "";

  // Build a clean error message
  if (status === 404) {
    if (path.includes("/search/")) {
      return new OpsApiError(404, "No results found for this search query.", code);
    }
    if (path.includes("/claims") || path.includes("/description")) {
      return new OpsApiError(
        404,
        `Full text not available for this document. Try using docdb format with a kind code (e.g. "EP.1000000.A1") or a different publication.`,
        code
      );
    }
    return new OpsApiError(404, `Document not found: ${rawMsg || path}`, code);
  }
  if (status === 400) {
    return new OpsApiError(400, `Invalid query: ${rawMsg || "check your CQL syntax. Operators (AND, OR, NOT) must be uppercase."}`, code);
  }
  if (status === 403) {
    return new OpsApiError(403, `Rate limited by EPO. Wait a minute and try again. ${rawMsg}`, code);
  }

  return new OpsApiError(status, rawMsg || `OPS API error (${status}) at ${path}`, code);
}

export class EpoClient {
  private consumerKey: string;
  private consumerSecret: string;
  private token: TokenInfo | null = null;
  /** Most recent throttle status from OPS. Updated on every successful request. */
  public lastThrottle: ThrottleStatus | null = null;
  /**
   * Deadline (epoch ms) for the current tool call. Set via startToolCall()
   * at the beginning of each MCP tool handler. The request() method checks
   * this before each attempt and bails if time is running out.
   */
  public deadline: number = Infinity;
  /** Whether the last request failure was due to rate limiting (403/429). */
  public wasRateLimited: boolean = false;

  constructor(consumerKey: string, consumerSecret: string) {
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
  }

  /** Call at the start of each tool handler to set the deadline clock. */
  startToolCall(): void {
    this.deadline = Date.now() + TOOL_TIMEOUT_MS;
    this.wasRateLimited = false;
  }

  /** Milliseconds remaining before the deadline. */
  get timeRemaining(): number {
    return Math.max(0, this.deadline - Date.now());
  }

  private async authenticate(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) {
      return this.token.accessToken;
    }

    const credentials = Buffer.from(
      `${this.consumerKey}:${this.consumerSecret}`
    ).toString("base64");

    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new OpsApiError(resp.status, `Authentication failed: ${text}`, "AUTH");
    }

    const data = (await resp.json()) as {
      access_token: string;
      expires_in: number;
    };
    this.token = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    return this.token.accessToken;
  }

  private async request(
    path: string,
    options: { rangeStart?: number; rangeEnd?: number } = {}
  ): Promise<string> {
    const token = await this.authenticate();
    const baseHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (options.rangeStart !== undefined && options.rangeEnd !== undefined) {
      baseHeaders["Range"] = `${options.rangeStart}-${options.rangeEnd}`;
    }

    const url = `${BASE_URL}${path}`;
    let attempt = 0;
    let lastStatus = 0;

    while (true) {
      // Check deadline before each attempt — leave 2s margin for response processing
      const remaining = this.deadline - Date.now();
      if (remaining < 2_000) {
        const reason = this.wasRateLimited
          ? `Tool call timeout reached. Rate limited by EPO OPS — too many requests in this session. Wait 1-2 minutes before retrying.`
          : `Tool call timeout reached. EPO OPS did not respond in time (last HTTP status: ${lastStatus || "timeout"}). The service may be slow or temporarily unavailable.`;
        throw new OpsApiError(408, reason, "TOOL_TIMEOUT");
      }

      // Per-request timeout: min of REQUEST_TIMEOUT_MS and remaining time
      const thisTimeout = Math.min(REQUEST_TIMEOUT_MS, remaining - 1_000);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), thisTimeout);

      let resp: Response;
      try {
        resp = await fetch(url, { headers: baseHeaders, signal: controller.signal });
      } catch (e: unknown) {
        clearTimeout(timer);
        if (e instanceof Error && e.name === "AbortError") {
          lastStatus = 0;
          attempt++;
          // Check if we have time for another attempt + backoff
          const delay = BACKOFF_BASE_MS * 2 ** Math.min(attempt, 4);
          if (this.deadline - Date.now() > delay + 3_000) {
            await new Promise((r) => setTimeout(r, delay));
            continue;
          }
          // No time left — fall through to deadline check at top of loop
          continue;
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }

      // Update throttle status from every response
      this.lastThrottle = parseThrottleHeader(
        resp.headers.get("X-Throttling-Control")
      );

      if (resp.ok) {
        return resp.text();
      }

      lastStatus = resp.status;
      const isRateLimit = resp.status === 403 || resp.status === 429;
      if (isRateLimit) this.wasRateLimited = true;
      const isRetryable = isRateLimit || resp.status >= 500;

      if (isRetryable) {
        attempt++;
        const retryAfter = resp.headers.get("Retry-After");
        let delay: number;
        if (retryAfter) {
          delay = (parseInt(retryAfter, 10) || 1) * 1000;
        } else {
          delay = BACKOFF_BASE_MS * 2 ** Math.min(attempt, 4);
        }
        if (isRateLimit) delay = Math.max(delay, 5_000);

        // Only retry if we have enough time left
        if (this.deadline - Date.now() > delay + 3_000) {
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        // Not enough time — fall through to deadline check at top of loop
        continue;
      }

      const text = await resp.text();
      throw parseOpsError(resp.status, text, path);
    }
  }

  async search(
    query: string,
    rangeStart: number = 1,
    rangeEnd: number = 25
  ): Promise<string> {
    const q = encodeURIComponent(query);
    return this.request(
      `/published-data/search/biblio?q=${q}`,
      { rangeStart, rangeEnd }
    );
  }

  async getBiblio(
    documentNumber: string,
    inputFormat: string = "epodoc"
  ): Promise<string> {
    return this.request(
      `/published-data/publication/${inputFormat}/${encodeURIComponent(documentNumber)}/biblio`
    );
  }

  /** Fetch biblio for multiple documents in one request (comma-separated in URL path). */
  async getBiblioMulti(
    documentNumbers: string[],
    inputFormat: string = "epodoc"
  ): Promise<string> {
    const joined = documentNumbers.map(encodeURIComponent).join(",");
    return this.request(
      `/published-data/publication/${inputFormat}/${joined}/biblio`
    );
  }

  async getClaims(
    documentNumber: string,
    inputFormat: string = "epodoc"
  ): Promise<string> {
    return this.request(
      `/published-data/publication/${inputFormat}/${encodeURIComponent(documentNumber)}/claims`
    );
  }

  async getDescription(
    documentNumber: string,
    inputFormat: string = "epodoc"
  ): Promise<string> {
    return this.request(
      `/published-data/publication/${inputFormat}/${encodeURIComponent(documentNumber)}/description`
    );
  }

  async getFamily(
    documentNumber: string,
    inputFormat: string = "epodoc"
  ): Promise<string> {
    return this.request(
      `/family/publication/${inputFormat}/${encodeURIComponent(documentNumber)}/biblio`
    );
  }

  /** Lightweight family request without biblio — just publication references. */
  async getFamilyLight(
    documentNumber: string,
    inputFormat: string = "epodoc"
  ): Promise<string> {
    return this.request(
      `/family/publication/${inputFormat}/${encodeURIComponent(documentNumber)}`
    );
  }

  async getLegalStatus(
    documentNumber: string,
    inputFormat: string = "epodoc"
  ): Promise<string> {
    return this.request(
      `/legal/publication/${inputFormat}/${encodeURIComponent(documentNumber)}`
    );
  }

}
