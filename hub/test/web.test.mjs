import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers.mjs';
import { weeksBefore, denverMidnight, bounds, visitsFrom, runWebDigest, latestWebDigest, webReady, webAdmin } from '../src/web.js';

const HEX = 'd7e67bd9fff1850969da60348408f3f0', SITE = '0123456789abcdef0123456789abcdef';
const SF = { SF_DOMAIN: 'https://pt.my.salesforce.com', SF_CLIENT_ID: 'id', SF_CLIENT_SECRET: 'secret' };
const CF = { CF_ACCOUNT_ID: HEX, CF_WEB_SITE_TAG: SITE, CF_ANALYTICS_TOKEN: 'tok' };
const ACCOUNT = {
  now: [{ count: 40, sum: { visits: 14 } }], before: [{ count: 60, sum: { visits: 19 } }],
  sources: [{ sum: { visits: 6 }, dimensions: { refererHost: 'www.linkedin.com' } }, { sum: { visits: 5 }, dimensions: { refererHost: 'positivetribes.org' } }, { sum: { visits: 3 }, dimensions: { refererHost: '' } }],
  pagesNow: [{ count: 5, dimensions: { requestPath: '/care.html' } }], pagesBefore: [{ count: 2, dimensions: { requestPath: '/care.html' } }]
};

// Stubs global fetch (the Salesforce helpers use it) and records every call.
function stubFetch(handler) {
  const calls = [], real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), init }); return handler(String(url), init); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const ok = body => new Response(JSON.stringify(body), { status: 200 });

test('weeks are Monday to Sunday, bounded at Denver midnight', () => {
  const w = weeksBefore('2026-11-16'); // Monday
  assert.deepEqual(w, { start: '2026-11-09', end: '2026-11-15', prevStart: '2026-11-02', prevEnd: '2026-11-08' });
  assert.equal(weeksBefore('2026-11-15').start, '2026-11-02'); // Sunday: this week is not over
  assert.equal(denverMidnight('2026-11-09'), '2026-11-09T07:00:00Z'); // MST
  assert.equal(denverMidnight('2026-07-06'), '2026-07-06T06:00:00Z'); // MDT
  assert.deepEqual(bounds(w), { before: '2026-11-02T07:00:00Z', start: '2026-11-09T07:00:00Z', end: '2026-11-16T07:00:00Z' });
});

test('visitsFrom drops our own host as a source and counts interest pages', () => {
  const v = visitsFrom(ACCOUNT);
  assert.deepEqual(v.visits, { now: 14, before: 19 });
  assert.deepEqual(v.views, { now: 40, before: 60 });
  assert.deepEqual(v.sources, [{ source: 'www.linkedin.com', visits: 6 }, { source: 'Direct or app', visits: 3 }]);
  assert.deepEqual(v.pages.find(p => p.path === '/care.html'), { path: '/care.html', now: 5, before: 2 });
  assert.deepEqual(visitsFrom(undefined).visits, { now: 0, before: 0 });
});

test('off unless on the production host with a source set up', async () => {
  assert.equal(webReady({ WEB_HOST: 'hub.positivetribes.org' }), false);
  assert.equal(webReady({ WEB_HOST: 'preview.example', ...SF }), false);
  assert.equal(webReady({ WEB_HOST: 'hub.positivetribes.org', ...CF, CF_WEB_SITE_TAG: '' }), false);
  assert.equal(webReady({ WEB_HOST: 'hub.positivetribes.org', ...CF }), true);
  const { db } = database();
  assert.equal((await runWebDigest({ ADMIN_DB: db, WEB_HOST: 'preview.example', ...SF, ...CF }, '2026-11-16')).ran, false);
});

test('a run counts leads and gifts from Salesforce and visits from Cloudflare, saving counts only', async () => {
  const { db } = database();
  const stub = stubFetch(async (url, init) => {
    if (url.endsWith('/services/oauth2/token')) return ok({ access_token: 'sf', instance_url: 'https://pt.my.salesforce.com' });
    if (url.includes('/query?q=')) {
      const q = decodeURIComponent(url.split('q=')[1]);
      if (q.includes('FROM Lead')) {
        assert.match(q, /LeadSource = 'Web' AND CreatedDate >= 2026-11-02T07:00:00Z AND CreatedDate < 2026-11-16T07:00:00Z/);
        return ok({ records: [{ CreatedDate: '2026-11-10T15:00:00.000+0000' }, { CreatedDate: '2026-11-09T07:30:00.000+0000' }, { CreatedDate: '2026-11-09T06:30:00.000+0000' }] });
      }
      assert.match(q, /FROM GiftTransaction WHERE Status = 'Paid' AND TransactionDate >= 2026-11-02 AND TransactionDate <= 2026-11-15/);
      return ok({ records: [{ TransactionDate: '2026-11-12', OriginalAmount: 50 }, { TransactionDate: '2026-11-03', OriginalAmount: 25 }] });
    }
    assert.equal(url, 'https://api.cloudflare.com/client/v4/graphql');
    assert.equal(init.headers.Authorization, 'Bearer tok');
    const vars = JSON.parse(init.body).variables;
    assert.equal(vars.site, SITE);
    assert.equal(vars.start, '2026-11-09T07:00:00Z');
    return ok({ data: { viewer: { accounts: [ACCOUNT] } } });
  });
  try {
    const r = await runWebDigest({ ADMIN_DB: db, WEB_HOST: 'hub.positivetribes.org', ...SF, ...CF }, '2026-11-16');
    assert.deepEqual(r, { ran: true, week: '2026-11-09', notes: [] });
  } finally { stub.restore(); }
  const web = await latestWebDigest(db);
  assert.deepEqual(web.digest.leads, { now: 2, before: 1 });
  assert.deepEqual(web.digest.gifts, { now: 1, before: 1 });
  assert.deepEqual(web.digest.given, { now: 50, before: 25 });
  assert.deepEqual(web.digest.visits, { now: 14, before: 19 });
  assert.deepEqual(web.trend, [{ week: '2026-11-09', leads: 2 }]);
  assert.doesNotMatch(JSON.stringify(web.digest), /@|Email|Name/);
});

test('one source failing is noted, both failing saves the error and keeps the earlier numbers', async () => {
  const { db } = database();
  const env = { ADMIN_DB: db, WEB_HOST: 'hub.positivetribes.org', ...SF, ...CF };
  let stub = stubFetch(async url => {
    if (url.endsWith('/services/oauth2/token')) return ok({ access_token: 'sf', instance_url: 'https://pt.my.salesforce.com' });
    if (url.includes('GiftTransaction')) return new Response(JSON.stringify([{ errorCode: 'INVALID_TYPE' }]), { status: 400 });
    if (url.includes('/query?q=')) return ok({ records: [] });
    return ok({ errors: [{ message: 'not authorized' }] });
  });
  try {
    const r = await runWebDigest(env, '2026-11-16');
    assert.equal(r.ran, true);
    assert.equal(r.notes.length, 2);
    assert.match(r.notes.join(' '), /Donations could not be read/);
    assert.match(r.notes.join(' '), /Visits: Cloudflare analytics refused the query \(200: not authorized\)/);
  } finally { stub.restore(); }
  stub = stubFetch(async () => new Response('{}', { status: 500 }));
  try { assert.equal((await runWebDigest(env, '2026-11-17')).ran, false); } finally { stub.restore(); }
  const web = await latestWebDigest(db);
  assert.match(web.error, /Leads and donations/);
  assert.deepEqual(web.digest.leads, { now: 0, before: 0 }); // the good save for that week is kept
});

test('Run now works only on the production host', async () => {
  const { db } = database();
  const json = (data, status = 200) => ({ data, status });
  const res = await webAdmin({ env: { ADMIN_DB: db }, url: new URL('https://tribe-hub-preview.example/api/admin/web/run'), route: 'POST /api/admin/web/run', json }, '2026-11-16');
  assert.equal(res.status, 409);
  assert.equal(await webAdmin({ env: {}, url: new URL('https://hub.positivetribes.org/x'), route: 'GET /api/admin/x', json }, '2026-11-16'), null);
});
