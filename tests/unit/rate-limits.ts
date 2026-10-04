import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as flushAsync } from 'node:timers/promises';
import { EpoClient, OpsApiError, isRateLimitError } from '../../src/epo-client.js';
import { fetchWithFamilyFallback } from '../../src/fallback.js';
import { registerSearchAndFilterFulltext } from '../../src/tools/search-and-filter.js';
import { registerSearchInPatentText } from '../../src/tools/search-in-patent-text.js';
import { registerSearchPatents } from '../../src/tools/search-patents.js';
import { registerGetPatentDetails } from '../../src/tools/get-patent-details.js';
import { registerGetPatentFamily } from '../../src/tools/get-patent-family.js';
import { registerGetPatentClaims } from '../../src/tools/fulltext.js';
import { registerGetPatentLegalStatus } from '../../src/tools/get-patent-legal-status.js';

const unavailable = () => { throw new OpsApiError(404, 'Unavailable'); };
const limited = (status = 429) => new OpsApiError(status, 'OPS rate limited', 'RATE_LIMIT', 60);
const claims = JSON.stringify({ 'ops:world-patent-data': {
  'ftxt:fulltext-documents': { 'ftxt:fulltext-document': { claims: { claim: { 'claim-text': { $: 'A target inhibitor.' } } } } },
} });
const family = JSON.stringify({ 'ops:world-patent-data': { 'ops:patent-family': { 'ops:family-member': {
  'publication-reference': { 'document-id': { '@document-id-type': 'docdb', country: 'WO', 'doc-number': '2023000001', kind: 'A1' } },
} } } });
function search(count = 3) {
  return JSON.stringify({ 'ops:world-patent-data': { 'ops:biblio-search': {
    '@total-result-count': String(count), 'ops:search-result': { 'exchange-documents': [1, 2, 3].map(n => ({
      'exchange-document': { 'bibliographic-data': {
        'publication-reference': { 'document-id': { '@document-id-type': 'epodoc', 'doc-number': `EP100000${n}`, date: '20230101' } },
        'invention-title': { '@lang': 'en', $: 'Example inhibitor' },
      } },
    })) },
  } } });
}
function client(overrides: Record<string, unknown> = {}): EpoClient {
  return { lastThrottle: null, timeRemaining: 50000, startToolCall() {}, search: async () => search(),
    getClaims: unavailable, getDescription: unavailable, getFamily: unavailable, getFamilyLight: unavailable,
    getBiblio: unavailable, getBiblioMulti: unavailable, getLegalStatus: unavailable, ...overrides } as unknown as EpoClient;
}
async function invoke(register: (server: any, client: EpoClient) => void, c: EpoClient, args: Record<string, unknown>) {
  let handler: any;
  register({ registerTool(_name: string, _schema: unknown, h: unknown) { handler = h; } }, c);
  return handler(args);
}
const filterArgs = { query: 'ta="target"', filter_terms: ['target'], match_mode: 'any', section_filter: ['claims'],
  max_patents_to_scan: 3, context_chars: 150, max_snippets_per_patent: 3, case_sensitive: false, fallback_to_family: false };
const textArgs = { document_number: 'EP1000001', input_format: 'epodoc', search_terms: ['target'],
  context_chars: 150, limit: 30, case_sensitive: false, fallback_to_family: false };
const data = (r: any) => JSON.parse(r.content[0].text);

for (const fallback of [false, true]) {
  for (const status of [403, 429]) {
    for (const section of ['claims', 'description']) {
      test(`${section}-only text search skips excluded HTTP ${status} with fallback=${fallback}`, async () => {
        let excludedRequests = 0;
        const description = JSON.stringify({ 'ops:world-patent-data': {
          'ftxt:fulltext-documents': { 'ftxt:fulltext-document': {
            description: { p: { $: 'A target inhibitor.' } },
          } },
        } });
        const excluded = async () => { excludedRequests++; throw limited(status); };
        const r = await invoke(registerSearchInPatentText, client({
          getClaims: section === 'claims' ? async () => claims : excluded,
          getDescription: section === 'description' ? async () => description : excluded,
        }), { ...textArgs, section_filter: [section], fallback_to_family: fallback });
        assert.equal(excludedRequests, 0);
        assert.equal(r.isError, undefined);
        assert.equal(data(r).partial, undefined);
        assert.equal(data(r).rateLimit, undefined);
        assert.equal(data(r).totalMatchCount, 1);
        assert.equal(data(r).matches[0].sectionOffset, 0);
      });
    }
  }
}

function authenticatedClient() {
  const c = new EpoClient('test', 'test');
  (c as any).token = { accessToken: 'test', expiresAt: Date.now() + 3600000 };
  return c;
}

for (const section of ['claims', 'description']) {
  test(`${section}-only family fallback reports only the retrieved section`, async () => {
    let requests = 0;
    const fetchRequested = async () => {
      if (++requests === 1) return unavailable();
      return section === 'claims' ? claims : JSON.stringify({ 'ops:world-patent-data': {
        'ftxt:fulltext-documents': { 'ftxt:fulltext-document': { description: { p: { $: 'A target inhibitor.' } } } },
      } });
    };
    let excludedRequests = 0;
    const excluded = async () => { excludedRequests++; throw limited(); };
    const r = await invoke(registerSearchInPatentText, client({
      getClaims: section === 'claims' ? fetchRequested : excluded,
      getDescription: section === 'description' ? fetchRequested : excluded,
    }), { ...textArgs, section_filter: [section], fallback_to_family: true });
    assert.equal(r.isError, undefined);
    assert.equal(excludedRequests, 0);
    assert.equal(requests, 2);
    assert.deepEqual(data(r).resolvedDocuments, { [section]: 'EP.1000001.A1' });
    assert.equal(data(r).totalMatchCount, 1);
  });
}

test('rate-limit retry waits and reports recovery to the agent', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const c = authenticatedClient();
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1
    ? new Response('limited', { status: 429, headers: { 'Retry-After': '7' } })
    : new Response(claims));
  const response = invoke(registerSearchInPatentText, c, { ...textArgs, section_filter: ['claims'] });
  await flushAsync();
  t.mock.timers.tick(6999);
  await flushAsync();
  assert.equal(requests, 1);
  t.mock.timers.tick(1);
  const r = await response;
  assert.equal(r.isError, undefined);
  assert.equal(data(r).totalMatchCount, 1);
  assert.deepEqual(data(r)._retry, { attempts: 1, waitedMs: 7000, rateLimitEvents: 1 });
  c.startToolCall();
  assert.deepEqual(c.lastRetry, { attempts: 0, waitedMs: 0, rateLimitEvents: 0 });
  await c.getClaims('EP1000001');
  assert.equal(requests, 3, 'successful recovery clears cooldown');
});

for (const status of [403, 429, 503]) {
  test(`HTTP ${status} stops after two retries even with an unlimited deadline`, async t => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
    const c = authenticatedClient();
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => { requests++; return new Response('unavailable', { status }); });
    const rejected = assert.rejects(c.getClaims('EP1000001'), (e: unknown) => {
      assert.ok(e instanceof OpsApiError);
      assert.equal(e.status, status);
      if (status !== 503) {
        assert.equal(e.retryAttempts, 2);
        assert.equal(e.retryAfterSeconds, 16);
      }
      return true;
    });
    await flushAsync();
    t.mock.timers.tick(status === 503 ? 4000 : 5000);
    await flushAsync();
    t.mock.timers.tick(8000);
    await rejected;
    assert.equal(requests, 3);
    assert.equal(c.lastRetry.attempts, 2);
  });
}

test('cooldown survives tool calls and prevents requests until Retry-After expires', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const c = authenticatedClient();
  c.deadline = Date.now() + 4000;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1
    ? new Response('limited', { status: 429, headers: { 'Retry-After': '90' } })
    : new Response(claims));
  await assert.rejects(c.getClaims('EP1000001'), isRateLimitError);
  t.mock.timers.tick(10000);
  const r = await invoke(registerSearchInPatentText, c, { ...textArgs, section_filter: ['claims'] });
  assert.equal(r.isError, true);
  assert.equal(data(r).retryable, true);
  assert.equal(data(r).retryAfterSeconds, 80);
  assert.equal(data(r).retryAttempts, 0);
  assert.match(data(r).hint, /Wait 80 seconds/);
  assert.equal(requests, 1);
  t.mock.timers.tick(80000);
  c.startToolCall();
  await c.getClaims('EP1000001');
  assert.equal(requests, 2);
});

test('a cooldown that fits the next tool budget is waited out automatically', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const c = authenticatedClient();
  c.deadline = Date.now() + 4000;
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => ++requests === 1
    ? new Response('limited', { status: 403, headers: { 'Retry-After': '20' } })
    : new Response(claims));
  await assert.rejects(c.getClaims('EP1000001'), isRateLimitError);
  const response = invoke(registerSearchInPatentText, c, { ...textArgs, section_filter: ['claims'] });
  await flushAsync();
  assert.equal(requests, 1);
  t.mock.timers.tick(20000);
  const r = await response;
  assert.equal(r.isError, undefined);
  assert.deepEqual(data(r)._retry, { attempts: 0, waitedMs: 20000, rateLimitEvents: 0 });
  assert.equal(requests, 2);
});

for (const status of [403, 429]) {
  test(`HTTP ${status} preserves status and Retry-After when retry budget is exhausted`, async () => {
    const c = new EpoClient('test', 'test');
    (c as any).token = { accessToken: 'test', expiresAt: Date.now() + 3600000 };
    c.deadline = Date.now() + 4000;
    const original = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => { requests++; return new Response('limited', { status, headers: { 'Retry-After': '60' } }); };
    try {
      await assert.rejects(c.getClaims('EP1000001'), (e: unknown) => {
        assert.ok(isRateLimitError(e)); assert.equal(e.status, status); assert.equal(e.retryAfterSeconds, 60); return true;
      });
      assert.equal(requests, 1, 'must not spin or send more requests when retry cannot fit');
    } finally { globalThis.fetch = original; }
  });
  test(`fulltext filter exposes ${status}, stops retrieval and preserves earlier matches`, async () => {
    let requests = 0;
    const r = await invoke(registerSearchAndFilterFulltext, client({ getClaims: async () => {
      if (++requests === 2) throw limited(status); return claims;
    } }), filterArgs);
    const d = data(r);
    assert.equal(r.isError, true); assert.equal(d.rateLimit.httpStatus, status); assert.equal(d.rateLimit.retryAfterSeconds, 60);
    assert.equal(d.partial, true); assert.equal(d.truncated, true); assert.equal(d.scanned, 2); assert.equal(d.checked, 1);
    assert.equal(d.matchedCount, 1); assert.equal(d.interruptedDocument, 'EP1000002'); assert.deepEqual(d.skipped, []);
    assert.equal(requests, 2); assert.match(d.hint, /unknown/); assert.doesNotMatch(d.hint, /None of/);
  });
  for (const fallback of [false, true]) {
    test(`text search exposes ${status} with fallback=${fallback} and stops further requests`, async () => {
      let descriptions = 0;
      const r = await invoke(registerSearchInPatentText, client({ getClaims: async () => { throw limited(status); },
        getDescription: async () => { descriptions++; return claims; } }), { ...textArgs, fallback_to_family: fallback });
      assert.equal(r.isError, true); assert.equal(data(r).error, 'rate_limited'); assert.equal(data(r).httpStatus, status);
      assert.equal(descriptions, 0); assert.doesNotMatch(r.content[0].text, /No full text available/);
    });
  }
}

test('legacy rate-limited deadline is still classified as a rate limit', () => {
  assert.equal(isRateLimitError(new OpsApiError(408, 'Rate limited by EPO OPS', 'TOOL_TIMEOUT')), true);
  assert.equal(isRateLimitError(new OpsApiError(408, 'Service timed out', 'TOOL_TIMEOUT')), false);
});
for (const stage of ['kind', 'family', 'light-family', 'member']) {
  test(`fulltext fallback propagates rate limit at ${stage} stage unchanged`, async () => {
    const error = limited(); let requests = 0;
    const c = client({
      getFamily: async () => {
        if (stage === 'family') throw error;
        if (stage === 'light-family') throw new OpsApiError(400, 'smaller chunks');
        return family;
      },
      getFamilyLight: async () => { throw error; },
    });
    await assert.rejects(fetchWithFamilyFallback(c, 'EP1000001', 'epodoc', async doc => {
      requests++;
      if ((stage === 'kind' && requests === 2) || (stage === 'member' && doc.startsWith('WO.'))) throw error;
      return unavailable();
    }), e => e === error);
  });
}

test('text search preserves retrieved claims when description is rate limited', async () => {
  const r = await invoke(registerSearchInPatentText, client({ getClaims: async () => claims,
    getDescription: async () => { throw limited(); } }), textArgs);
  const d = data(r); assert.equal(r.isError, true); assert.equal(d.partial, true);
  assert.equal(d.rateLimit.error, 'rate_limited'); assert.equal(d.totalMatchCount, 1); assert.match(d.hint, /unknown/);
});
test('fulltext filter captures rate limiting in description retrieval', async () => {
  const r = await invoke(registerSearchAndFilterFulltext, client({ getClaims: async () => claims,
    getDescription: async () => { throw limited(); } }), { ...filterArgs, section_filter: undefined });
  const d = data(r); assert.equal(r.isError, true); assert.equal(d.rateLimit.httpStatus, 429);
  assert.equal(d.checked, 0); assert.deepEqual(d.skipped, []);
});
test('genuine missing text remains a missing-text outcome', async () => {
  const r = await invoke(registerSearchAndFilterFulltext, client(), filterArgs);
  assert.equal(r.isError, undefined); assert.equal(data(r).skipped.length, 3); assert.equal(data(r).rateLimit, undefined);
});
test('normal keyword matches still succeed', async () => {
  const r = await invoke(registerSearchInPatentText, client({ getClaims: async () => claims }), textArgs);
  assert.equal(r.isError, undefined); assert.equal(data(r).totalMatchCount, 1);
});
test('search pagination retains results and structured rate-limit evidence', async () => {
  let requests = 0;
  const r = await invoke(registerSearchPatents, client({ search: async () => {
    if (++requests === 3) throw limited(); return search(200);
  } }), { query: 'ta="target"', range_start: 1, range_end: 25, count_only: false,
    detail_level: 'compact', auto_paginate: true, max_results: 200 });
  assert.equal(r.isError, true); assert.equal(data(r).partial, true); assert.equal(data(r).rateLimit.httpStatus, 429);
  assert.equal(data(r).results.length, 3);
});
test('batch bibliography rate limit is not reported as missing patents', async () => {
  const r = await invoke(registerGetPatentDetails, client({ getBiblioMulti: async () => { throw limited(); } }),
    { document_numbers: ['EP1000001'], input_format: 'epodoc' });
  assert.equal(r.isError, true); assert.equal(data(r).error, 'rate_limited'); assert.equal(data(r).notFound, undefined);
});
test('bibliography kind retry does not hide a rate limit behind its original 404', async () => {
  let requests = 0;
  const r = await invoke(registerGetPatentDetails, client({ getBiblio: async () => {
    if (++requests === 1) return unavailable(); throw limited();
  } }), { document_number: 'EP1000001', input_format: 'epodoc' });
  assert.equal(r.isError, true); assert.equal(data(r).httpStatus, 429); assert.equal(requests, 2);
});
test('legal status kind retry propagates rate limiting', async () => {
  let requests = 0;
  const r = await invoke(registerGetPatentLegalStatus, client({ getLegalStatus: async () => {
    if (++requests === 1) return unavailable(); throw limited();
  } }), { document_number: 'EP1000001', input_format: 'epodoc' });
  assert.equal(r.isError, true); assert.equal(data(r).httpStatus, 429); assert.equal(requests, 2);
});
test('large-family light retry does not label a rate limit as family-too-large', async () => {
  const r = await invoke(registerGetPatentFamily, client({ getFamily: async () => { throw new OpsApiError(400, 'smaller chunks'); },
    getFamilyLight: async () => { throw limited(); } }), { document_number: 'EP1000001', input_format: 'epodoc', max_members: 150 });
  assert.equal(r.isError, true); assert.equal(data(r).error, 'rate_limited');
});

test('HTTP-date Retry-After is preserved as a delay', async () => {
  const c = new EpoClient('test', 'test');
  (c as any).token = { accessToken: 'test', expiresAt: Date.now() + 3600000 };
  c.deadline = Date.now() + 4000;
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('limited', { status: 429,
    headers: { 'Retry-After': new Date(Date.now() + 60000).toUTCString() } });
  try {
    await assert.rejects(c.getClaims('EP1000001'), (e: unknown) => {
      assert.ok(isRateLimitError(e)); assert.ok(e.retryAfterSeconds! >= 59); return true;
    });
  } finally { globalThis.fetch = original; }
});
test('fulltext reader reports structured rate limiting from a kind fallback', async () => {
  let requests = 0;
  const r = await invoke(registerGetPatentClaims, client({ getClaims: async () => {
    if (++requests === 1) return unavailable(); throw limited();
  } }), { document_number: 'EP1000001', input_format: 'epodoc', fallback_to_family: true,
    offset: 0, max_characters: 1000 });
  assert.equal(r.isError, true); assert.equal(data(r).httpStatus, 429); assert.equal(requests, 2);
});
test('successful kind fallback still returns full text', async () => {
  let requests = 0;
  const result = await fetchWithFamilyFallback(client(), 'EP1000001', 'epodoc', async () => {
    if (++requests === 1) return unavailable(); return claims;
  });
  assert.equal(result.raw, claims); assert.equal(result.substituted, true); assert.equal(requests, 2);
});


test('kind-suffixed fulltext input is normalized and still propagates rate limits', async () => {
  let requests = 0;
  const error = limited();
  await assert.rejects(fetchWithFamilyFallback(client(), ' US11939382B2 ', 'epodoc', async (number, format) => {
    requests++;
    assert.equal(number, 'US.11939382.B2'); assert.equal(format, 'docdb');
    throw error;
  }), (e: unknown) => e === error);
  assert.equal(requests, 1);
});
test('rate-limit interruption takes precedence over non-English zero-match guidance', async () => {
  const japanese = JSON.stringify({ 'ops:world-patent-data': {
    'ftxt:fulltext-documents': { 'ftxt:fulltext-document': {
      claims: { '@lang': 'ja', claim: { 'claim-text': { $: '日本語の特許文書' } } },
    } },
  } });
  const r = await invoke(registerSearchInPatentText, client({ getClaims: async () => japanese,
    getDescription: async () => { throw limited(); } }), textArgs);
  const d = data(r);
  assert.equal(r.isError, true); assert.equal(d.partial, true); assert.equal(d.textLanguage.claims, 'ja');
  assert.equal(d.matchCount, 0); assert.match(d.hint, /rate limiting interrupted/);
});
test('single-page summary includes partial sample warning and valid JSON steering', async () => {
  const r = await invoke(registerSearchPatents, client({ search: async () => search(200) }), {
    query: 'ta="target"', range_start: 1, range_end: 25, count_only: false,
    detail_level: 'summary', auto_paginate: false, max_results: 200,
  });
  const d = data(r);
  assert.equal(d.partialSample, true); assert.match(d.sampleWarning, /only 3 of 200/);
  assert.match(d.steering, /Showing results/);
});
test('partial pagination keeps both pacing metadata and structured rate-limit evidence', async () => {
  let requests = 0;
  const r = await invoke(registerSearchPatents, client({
    lastPaceMs: 3000, lastPaceColor: 'yellow',
    lastThrottle: { overallStatus: 'yellow', isThrottled: false, services: {} },
    search: async () => { if (++requests === 3) throw limited(); return search(200); },
  }), { query: 'ta="target"', range_start: 1, range_end: 25, count_only: false,
    detail_level: 'compact', auto_paginate: true, max_results: 200 });
  const d = data(r);
  assert.equal(r.isError, true); assert.equal(d.rateLimit.httpStatus, 429);
  assert.match(d._throttle.pacing, /waited 3s/); assert.match(d.note, /WARNING/);
  assert.equal(d.results.length, 3);
});
