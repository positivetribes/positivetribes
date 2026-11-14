import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers.mjs';
import { weeksBefore, digestFrom, runWebDigest, latestWebDigest, webReady, reportRequests, webAdmin } from '../src/web.js';

async function saKey() {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
  return { json: JSON.stringify({ client_email: 'digest@pt.iam.gserviceaccount.com', private_key: `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n` }), publicKey: pair.publicKey };
}
const row = (dims, mets) => ({ dimensionValues: dims.map(value => ({ value })), metricValues: mets.map(value => ({ value: String(value) })) });
const REPORTS = [
  { rows: [row(['now'], [14, 20, 21]), row(['before'], [19, 30, 47])] },
  { rows: [row(['generate_lead', 'now'], [2, 0]), row(['donation_complete', 'now'], [1, 50]), row(['generate_lead', 'before'], [1, 0])] },
  { rows: [row(['linkedin.com'], [9, 2]), row(['(direct)'], [6, 0])] },
  { rows: [row(['/care.html', 'now'], [5]), row(['/care.html', 'before'], [2])] }
];

test('weeksBefore picks the last full Monday-to-Sunday week', () => {
  assert.deepEqual(weeksBefore('2026-11-16'), { start: '2026-11-09', end: '2026-11-15', prevStart: '2026-11-02', prevEnd: '2026-11-08' }); // Monday
  assert.deepEqual(weeksBefore('2026-11-14').start, '2026-11-02'); // Saturday: the week before this one
  assert.deepEqual(weeksBefore('2026-11-15').start, '2026-11-02'); // Sunday: this week is not over
});

test('digestFrom turns GA reports into this week vs last', () => {
  const d = digestFrom(weeksBefore('2026-11-16'), REPORTS);
  assert.deepEqual(d.visitors, { now: 14, before: 19 });
  assert.deepEqual(d.events.find(e => e.name === 'generate_lead'), { name: 'generate_lead', label: 'Contact and volunteer forms sent', now: 2, before: 1 });
  assert.deepEqual(d.events.find(e => e.name === 'support_request'), { name: 'support_request', label: 'Help requests', now: 0, before: 0 });
  assert.deepEqual(d.donated, { now: 50, before: 0 });
  assert.deepEqual(d.sources[0], { source: 'linkedin.com', sessions: 9, keyEvents: 2 });
  assert.deepEqual(d.pages.find(p => p.path === '/care.html'), { path: '/care.html', now: 5, before: 2 });
  assert.equal(reportRequests(weeksBefore('2026-11-16')).length, 4);
});

test('runWebDigest is off unless the host, property and key are all set', async () => {
  const { db } = database();
  assert.equal(webReady({ WEB_HOST: 'hub.positivetribes.org', GA_PROPERTY_ID: '', GA_SA_KEY: '{}' }), false);
  assert.equal(webReady({ WEB_HOST: 'preview.example', GA_PROPERTY_ID: '123', GA_SA_KEY: '{}' }), false);
  const r = await runWebDigest({ ADMIN_DB: db, WEB_HOST: 'hub.positivetribes.org', GA_PROPERTY_ID: '123' }, '2026-11-16', () => { throw new Error('no calls'); });
  assert.equal(r.ran, false);
});

test('runWebDigest signs in read-only, saves the week, and saves a failure without losing it', async () => {
  const { db } = database();
  const { json, publicKey } = await saKey();
  const env = { ADMIN_DB: db, WEB_HOST: 'hub.positivetribes.org', GA_PROPERTY_ID: '123456', GA_SA_KEY: json };
  const calls = [];
  const ok = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('oauth2')) {
      const jwt = new URLSearchParams(init.body).get('assertion');
      const [h, c, s] = jwt.split('.');
      const claims = JSON.parse(Buffer.from(c, 'base64url'));
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/analytics.readonly');
      assert.equal(claims.iss, 'digest@pt.iam.gserviceaccount.com');
      assert.ok(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, Buffer.from(s, 'base64url'), new TextEncoder().encode(h + '.' + c)));
      return new Response(JSON.stringify({ access_token: 'tok' }));
    }
    assert.equal(url, 'https://analyticsdata.googleapis.com/v1beta/properties/123456:batchRunReports');
    assert.equal(init.headers.Authorization, 'Bearer tok');
    return new Response(JSON.stringify({ reports: REPORTS }));
  };
  assert.deepEqual(await runWebDigest(env, '2026-11-16', ok), { ran: true, week: '2026-11-09' });
  assert.equal(calls.length, 2);
  let web = await latestWebDigest(db);
  assert.equal(web.digest.visitors.now, 14);
  assert.deepEqual(web.trend, [{ week: '2026-11-09', leads: 2 }]);

  const broken = async url => url.includes('oauth2') ? new Response(JSON.stringify({ access_token: 'tok' })) : new Response(JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }), { status: 403 });
  const r = await runWebDigest(env, '2026-11-17', broken);
  assert.equal(r.ran, false);
  web = await latestWebDigest(db);
  assert.match(web.error, /PERMISSION_DENIED/);
  assert.equal(web.digest.visitors.now, 14); // the good save for that week is kept
});

test('Run now works only on the production host', async () => {
  const { db } = database();
  const json = (data, status = 200) => ({ data, status });
  const res = await webAdmin({ env: { ADMIN_DB: db }, url: new URL('https://tribe-hub-preview.example/api/admin/web/run'), route: 'POST /api/admin/web/run', json }, '2026-11-16');
  assert.equal(res.status, 409);
  assert.equal(await webAdmin({ env: {}, url: new URL('https://hub.positivetribes.org/x'), route: 'GET /api/admin/x', json }, '2026-11-16'), null);
});
