import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isRefusalEvent, summarizeLegalStatus } from '../../src/legal.js';
import { registerGetPatentLegalStatus } from '../../src/tools/get-patent-legal-status.js';
import type { EpoClient } from '../../src/epo-client.js';
import type { LegalEvent } from '../../src/parsers.js';

const refusals: LegalEvent[] = [
  { eventCode: 'STAA', country: 'EP', date: '20230310', description: 'INFORMATION ON THE STATUS OF AN EP PATENT APPLICATION OR GRANTED EP PATENT',
    freeText: 'STATUS: THE APPLICATION HAS BEEN REFUSED' },
  { eventCode: '18R ', country: 'EP', date: '20230412', description: 'APPLICATION REFUSED', effectiveDate: '20221204' },
];

test('explicit refusals retain provenance and both gazette and effective dates', () => {
  const summary = summarizeLegalStatus(refusals);
  assert.equal(summary.refused, true);
  assert.equal(summary.granted, false);
  assert.equal(summary.lapsed, false);
  assert.deepEqual(summary.refusalEvents, refusals);
  assert.ok(summary.keyEvents.includes('[EP] Application refused (20230412) (effective 20221204)'));
});

test('refusal notices, negation and unrelated refused requests are not application refusals', () => {
  for (const event of [
    { eventCode: 'STAA', freeText: 'THE APPLICATION HAS NOT BEEN REFUSED' },
    { eventCode: 'STAA', freeText: 'INTENTION TO REFUSE THE APPLICATION' },
    { eventCode: 'X', description: 'REQUEST FOR EXTENSION REFUSED' },
    { eventCode: 'X', description: 'NO REFUSAL OF THE APPLICATION' },
  ]) assert.equal(isRefusalEvent(event), false);
  assert.equal(summarizeLegalStatus([]).refused, false);
});

test('a later grant does not erase the historical refusal', () => {
  const summary = summarizeLegalStatus([...refusals, { eventCode: 'B1', country: 'EP', date: '20250101' }]);
  assert.equal(summary.granted, true);
  assert.equal(summary.refused, true);
});

for (const condensed of [false, true]) {
  for (const eventTypes of [undefined, ['refusal'], ['grant']]) {
    test(`refusal summary survives tool filtering and condensation: ${eventTypes}, ${condensed}`, async () => {
      let handler: any;
      const raw = JSON.stringify({ 'ops:world-patent-data': { 'ops:patent-family': { 'ops:family-member': {
        'ops:legal': refusals.map(e => ({ '@code': e.eventCode, '@desc': e.description,
          'ops:L001EP': e.country, 'ops:L007EP': e.date,
          'ops:L500EP': { 'ops:L510EP': e.freeText, 'ops:L525EP': e.effectiveDate } })),
      } } } });
      registerGetPatentLegalStatus({ registerTool(_n: string, _s: unknown, h: any) { handler = h; } } as any,
        { startToolCall() {}, lastThrottle: null, getLegalStatus: async () => raw } as unknown as EpoClient);
      const response = await handler({ document_number: 'EP1000001', input_format: 'epodoc', event_types: eventTypes, condensed });
      assert.equal(response.isError, undefined);
      const data = JSON.parse(response.content[0].text);
      assert.equal(data.statusSummary.refused, true);
      assert.equal(data.statusSummary.refusalEvents.length, 2);
      assert.equal(data.legalEvents.length, eventTypes?.[0] === 'grant' ? 0 : 2);
      assert.equal(data.statusSummary.refusalEvents[1].effectiveDate, '20221204');
    });
  }
}
