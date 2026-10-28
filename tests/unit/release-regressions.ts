import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import { EpoClient, OpsApiError } from '../../src/epo-client.js';
import { paginateParagraphs, type Paragraph } from '../../src/parsers.js';
import { registerSearchInPatentText } from '../../src/tools/search-in-patent-text.js';
import { registerSearchAndFilterFulltext } from '../../src/tools/search-and-filter.js';
import { registerSearchPatents } from '../../src/tools/search-patents.js';
import { fetchWithFamilyFallback } from '../../src/fallback.js';
import { registerGetPatentClaims } from '../../src/tools/fulltext.js';

const text = (section: string, value = 'An ordinary claim.', language = 'en') => JSON.stringify({
  'ops:world-patent-data': { 'ftxt:fulltext-documents': { 'ftxt:fulltext-document': {
    [section]: { '@lang': language, ...(section === 'claims' ? { claim: { 'claim-text': { $: value } } } : { p: { $: value } }) },
  } } },
});
const search = (total: number, start = 1, length = 1) => JSON.stringify({ 'ops:world-patent-data': {
  'ops:biblio-search': { '@total-result-count': String(total), 'ops:search-result': {
    'exchange-documents': Array.from({ length }, (_, i) => ({ 'exchange-document': { 'bibliographic-data': {
      'publication-reference': { 'document-id': { '@document-id-type': 'epodoc', 'doc-number': `EP${1000000 + start + i}` } },
      'invention-title': { '@lang': 'en', $: 'Example' },
    } } })),
  } },
} });
const missing = async () => { throw new OpsApiError(404, 'Unavailable'); };
const client = (overrides: Record<string, unknown> = {}) => ({
  lastThrottle: null, timeRemaining: 50000, startToolCall() {}, search: async () => search(1),
  getClaims: missing, getDescription: missing, getFamily: missing, ...overrides,
}) as unknown as EpoClient;
function tool(register: any, c = client()) {
  let schema: any; let handler: any;
  register({ registerTool(_name: string, config: any, fn: any) { schema = z.object(config.inputSchema); handler = fn; } }, c);
  return { schema, invoke: async (args: object) => handler(schema.parse(args)) };
}
const data = (r: any) => JSON.parse(r.content[0].text);
const filterArgs = { query: 'ta="target"', filter_terms: ['target'], section_filter: ['claims'], max_patents_to_scan: 1, fallback_to_family: false };
const textArgs = { document_number: 'EP1000001', search_terms: ['target'], fallback_to_family: false };

test('both keyword tools reject empty and whitespace-only terms at the protocol boundary', () => {
  for (const blank of ['', ' ', '\n\t']) {
    assert.equal(tool(registerSearchInPatentText).schema.safeParse({ ...textArgs, search_terms: [blank] }).success, false);
    assert.equal(tool(registerSearchAndFilterFulltext).schema.safeParse({ ...filterArgs, filter_terms: ['valid', blank] }).success, false);
  }
  assert.equal(tool(registerSearchAndFilterFulltext).schema.safeParse({ ...filterArgs, section_filter: [] }).success, false);
});

test('the low-level matcher rejects blank terms without blocking the process', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { searchKeywordsInParagraphs } from './src/parsers.ts';
    assert.throws(() => searchKeywordsInParagraphs([{index:0,section:'claims',text:'Example',startChar:0,endChar:7}], ['']), /blank/);
  `], { timeout: 5000, encoding: 'utf8' });
  assert.equal(r.error, undefined);
  assert.equal(r.status, 0, r.stderr);
});

for (const lengths of [[80, 80, 80], [2500], [100, 100], [140, 10, 230]]) {
  test(`pagination reconstructs every character exactly once: ${lengths}`, () => {
    const paragraphs: Paragraph[] = lengths.map((length, index) => ({ index, section: 'claims',
      text: String.fromCharCode(65 + index).repeat(length), startChar: lengths.slice(0, index).reduce((a, b) => a + b, 0),
      endChar: lengths.slice(0, index + 1).reduce((a, b) => a + b, 0) }));
    let cursor = { offset: 0, character_offset: 0 }; let joined = ''; let pages = 0;
    for (;;) {
      const page = paginateParagraphs(paragraphs, cursor.offset, undefined, 100, cursor.character_offset);
      assert.ok(++pages < 100);
      assert.ok(page.returnedCharacters <= 100);
      joined += page.paragraphs.map(p => p.text).join('');
      if (!page.continuation) break;
      assert.notDeepEqual(page.continuation, cursor);
      cursor = page.continuation;
    }
    assert.equal(joined, paragraphs.map(p => p.text).join(''));
  });
}

for (const [name, getClaims] of [
  ['missing', missing], ['empty', async () => '{}'],
  ['service failure', async () => { throw new OpsApiError(503, 'Service failed'); }],
  ['timeout', async () => { throw new OpsApiError(408, 'Timed out', 'TOOL_TIMEOUT'); }],
  ['invalid response', async () => 'not JSON'],
] as const) {
  test(`filter reports ${name} as unknown, never a negative screening result`, async () => {
    const r = await tool(registerSearchAndFilterFulltext, client({ getClaims })).invoke(filterArgs);
    const d = data(r);
    assert.equal(d.checked, 0); assert.equal(d.fullyChecked, 0);
    assert.equal(d.noMatchCount, 0); assert.equal(d.unknownCount, 1); assert.equal(d.partial, true);
    assert.match(d.hint, /unknown/); assert.doesNotMatch(d.hint, /None of/);
    if (!['missing', 'empty'].includes(name)) assert.equal(r.isError, true);
  });
}

test('a missing or failed description preserves claims and qualifies zero matches', async () => {
  for (const getDescription of [missing, async () => { throw new OpsApiError(408, 'Timed out', 'TOOL_TIMEOUT'); }]) {
    const r = await tool(registerSearchInPatentText, client({ getClaims: async () => text('claims'), getDescription })).invoke(textArgs);
    const d = data(r);
    assert.equal(d.partial, true); assert.equal(d.claimsParagraphs, 1); assert.equal(d.totalMatchCount, 0);
    assert.equal(d.sectionStatus.claims.status, 'available'); assert.notEqual(d.sectionStatus.description.status, 'available');
    assert.match(d.hint, /unknown/);
  }
});

test('complete negative screening and positive screening remain distinct', async () => {
  for (const value of ['An ordinary claim.', 'A target inhibitor.']) {
    const r = await tool(registerSearchAndFilterFulltext, client({ getClaims: async () => text('claims', value) })).invoke(filterArgs);
    const d = data(r);
    assert.equal(d.fullyChecked, 1); assert.equal(d.unknownCount, 0);
    assert.equal(d.matchedCount, value.includes('target') ? 1 : 0);
    assert.equal(d.noMatchCount, value.includes('target') ? 0 : 1);
  }
});

test('a negative family-text result identifies the source and does not clear the original publication', async () => {
  const c = client({ getClaims: async (document: string) => document.includes('.') ? text('claims') : missing() });
  const r = await tool(registerSearchAndFilterFulltext, c).invoke({ ...filterArgs, fallback_to_family: true });
  const d = data(r);
  assert.equal(d.nonMatches[0].resolvedDocuments.claims, 'EP.1000001.A1');
  assert.match(d.nonMatches[0].note, /do not establish.*absence/);
});

test('deadline before scanning returns every candidate for resumption', async () => {
  const r = await tool(registerSearchAndFilterFulltext, client({ timeRemaining: 7000 })).invoke(filterArgs);
  const d = data(r);
  assert.equal(d.scanned, 0); assert.equal(d.truncated, true); assert.equal(d.partial, true);
  assert.equal(d.unattemptedCount, 1); assert.deepEqual(d.remainingDocuments, ['EP1000001']);
});

test('deadline between sections preserves matches and marks the unread description', async () => {
  let timeRemaining = 50000;
  const c = client({ getClaims: async () => { timeRemaining = 7000; return text('claims', 'A target inhibitor.'); } });
  Object.defineProperty(c, 'timeRemaining', { get: () => timeRemaining });
  const r = await tool(registerSearchAndFilterFulltext, c).invoke({ ...filterArgs, section_filter: ['claims', 'description'] });
  const d = data(r);
  assert.equal(d.matchedCount, 1); assert.equal(d.fullyChecked, 0); assert.equal(d.partial, true);
  assert.equal(d.matched[0].sectionStatus.description.status, 'not_attempted');
  assert.deepEqual(d.remainingDocuments, ['EP1000001']);
});

test('the fulltext tool accepts its continuation and preserves a long claim exactly', async () => {
  const original = 'A'.repeat(120) + 'B'.repeat(120);
  const calls: string[] = [];
  const reader = tool(registerGetPatentClaims, client({ getClaims: async (document: string, format: string) => {
    calls.push(`${format}:${document}`); return text('claims', original);
  } }));
  let continuation: any = { offset: 0, character_offset: 0 }; let reconstructed = '';
  while (continuation) {
    const r = await reader.invoke({ document_number: 'EP1000001A1', fallback_to_family: false, max_characters: 100, ...continuation });
    const d = data(r); reconstructed += d.paragraphs.map((p: any) => p.text).join(''); continuation = d.continuation;
    assert.ok(calls.length <= 3);
  }
  assert.equal(reconstructed, original);
  assert.deepEqual(calls, Array(3).fill('docdb:EP.1000001.A1'));
});

test('fallback propagates generic service failures instead of converting them to unavailable text', async () => {
  const error = new OpsApiError(503, 'Unavailable'); let requests = 0;
  await assert.rejects(fetchWithFamilyFallback(client(), 'EP1000001', 'epodoc', async () => {
    if (++requests === 1) return missing(); throw error;
  }), e => e === error);
  assert.equal(requests, 2);
});

test('year decomposition retains exact boundary dates and paginates later years independently', async () => {
  const queries: string[] = []; let first = true;
  const c = client({ search: async (q: string, start: number) => {
    queries.push(q);
    if (first) { first = false; return search(2001); }
    if (q.includes('20230601,20231231')) return search(100, 1, 100);
    assert.match(q, /20240101,20240630/);
    return search(150, start + 100, start === 1 ? 100 : 50);
  } });
  const r = await tool(registerSearchPatents, c).invoke({ query: 'ta="target"', published_after: '20230601',
    published_before: '20240630', auto_paginate: true, detail_level: 'compact', max_results: 500 });
  assert.equal(data(r).fetchedCount, 250);
  assert.equal(queries.length, 4);
  assert.match(queries[0], /20230601,20240630/);
  assert.doesNotMatch(queries.slice(1).join(' '), /20230101|20241231/);
});

test('an empty year does not prevent retrieval from subsequent years', async () => {
  let calls = 0;
  const c = client({ search: async () => {
    if (++calls === 1) return search(2001);
    if (calls === 2) return missing();
    return search(1);
  } });
  const r = await tool(registerSearchPatents, c).invoke({ query: 'ta="target"', published_after: '2023',
    published_before: '2024', auto_paginate: true, detail_level: 'compact' });
  assert.equal(calls, 3); assert.equal(data(r).fetchedCount, 1);
  assert.equal(data(r).paginationErrors, undefined);
});
