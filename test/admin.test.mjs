import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers.mjs';
import { requireAccess, handleAdmin, isAdminPath, buildOverview, rankNow, buildMatch, buildClient, buildInbox, BACKLOGS } from '../admin.mjs';
import uepBacklog from '../uep-backlog/src/index.js';

const TEAM = 'positivetribes.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const ORIGIN = 'https://positivetribes.org';
const UEP = '001Pr00000yy8o9IAA', SAFE = '001Pr00000yyXUuIAM', ROCKS = '001Pr00000zpU7OIAU';

// One signing key served from the Access certs URL, and a second key Access never published.
const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
const strangerKeys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
const publicJwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'key-1' };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  if (String(input) === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [publicJwk] });
  throw new Error('Unexpected fetch ' + input);
};
test.after(() => { globalThis.fetch = realFetch; });

const b64 = data => Buffer.from(data).toString('base64url');
async function token(claims = {}, { key = keys.privateKey, kid = 'key-1', alg = 'RS256' } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const payload = b64(JSON.stringify({ aud: [AUD], iss: `https://${TEAM}`, exp: now + 600, iat: now, email: 'eric@positivetribes.org', ...claims }));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(head + '.' + payload));
  return head + '.' + payload + '.' + b64(signature);
}
const env = (extra = {}) => ({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extra });
const ask = (jwt, path = '/api/admin/overview') => new Request(ORIGIN + path, { headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} });
const check = (request, e = env()) => requireAccess(request, e, new URL(request.url));

test('admin paths are recognized however they are spelled', () => {
  for (const path of ['/admin', '/admin/', '/admin/index.html', '/ADMIN/', '//admin/', '/%61dmin/', '/api/admin/overview', '/api//admin/x', '/admin.html']) assert.equal(isAdminPath(path), true, path);
  for (const path of ['/', '/about.html', '/api/contact', '/administrator-guide', '/uep/admin']) assert.equal(isAdminPath(path), false, path);
});

test('a valid Access token for an allowed email gets in', async () => {
  assert.deepEqual(await check(ask(await token())), { email: 'eric@positivetribes.org' });
});

test('a service token gets in as a service, not a person', async () => {
  assert.deepEqual(await check(ask(await token({ email: undefined, common_name: 'abc.access' }))), { service: 'abc.access' });
});

test('everything else is refused', async () => {
  const refused = async (request, e) => assert.equal((await check(request, e)).status, 403);
  await refused(ask(null));
  await refused(ask('not.a.token'));
  await refused(ask(await token({ aud: ['b'.repeat(64)] })));
  await refused(ask(await token({ exp: Math.floor(Date.now() / 1000) - 5 })));
  await refused(ask(await token({ iss: 'https://evil.cloudflareaccess.com' })));
  await refused(ask(await token({ email: 'someone@example.com' })));
  await refused(ask(await token({}, { key: strangerKeys.privateKey })));
  await refused(ask(await token({}, { kid: 'unknown' })));
  await refused(ask(await token({}, { alg: 'none' })));
  await refused(ask(await token({ email: undefined })));
  // Fails closed when Access is not configured.
  await refused(ask(await token()), {});
  await refused(ask(await token()), env({ ACCESS_AUD: '' }));
  await refused(ask(await token()), env({ ACCESS_TEAM_DOMAIN: 'evil.example.com' }));
});

test('ADMIN_EMAILS widens the allowed list', async () => {
  assert.deepEqual(await check(ask(await token({ email: 'Rich@Example.com' })), env({ ADMIN_EMAILS: 'eric@positivetribes.org, rich@example.com' })), { email: 'Rich@Example.com' });
});

test('the local development bypass only works on localhost', async () => {
  assert.deepEqual(await check(new Request('http://localhost:8787/admin/'), { ADMIN_DEV: '1' }), { email: 'dev@localhost' });
  assert.equal((await check(new Request(ORIGIN + '/admin/'), { ADMIN_DEV: '1' })).status, 403);
});

// ---- API against a real SQLite database (Salesforce not connected) ----

const ME = { email: 'eric@positivetribes.org' }, ROUTINE = { service: 'sync' };
function call(db, method, path, data, { who = ME, origin = ORIGIN, env = {} } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (data !== undefined) headers['Content-Type'] = 'application/json';
  const request = new Request(ORIGIN + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) });
  return handleAdmin(request, { ADMIN_DB: db, ...env }, new URL(request.url), who).then(async r => ({ status: r.status, body: await r.json() }));
}

test('steps and notes are saved, validated and protected', async () => {
  const { db, sqlite } = database();
  let r = await call(db, 'POST', '/api/admin/steps', { accountId: UEP, title: '  Send the proposal  ', dueDate: '2026-11-04' });
  assert.equal(r.status, 201);
  assert.equal(sqlite.prepare('SELECT title FROM next_steps').get().title, 'Send the proposal');
  assert.equal((await call(db, 'POST', '/api/admin/steps', { accountId: 'nope', title: 'x' })).status, 400);
  assert.equal((await call(db, 'POST', '/api/admin/steps', { accountId: UEP, title: 'x', dueDate: '11/4' })).status, 400);
  assert.equal((await call(db, 'POST', '/api/admin/steps', { accountId: UEP, title: '' })).status, 400);
  // Writes from another site, or from the sync routine, are refused.
  assert.equal((await call(db, 'POST', '/api/admin/steps', { accountId: UEP, title: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(db, 'POST', '/api/admin/steps', { accountId: UEP, title: 'x' }, { who: ROUTINE })).status, 403);
  assert.equal((await call(db, 'GET', '/api/admin/overview', undefined, { who: ROUTINE })).status, 403);

  r = await call(db, 'PATCH', `/api/admin/steps/${r.body.id}`, { status: 'done' });
  assert.equal(r.status, 200);
  const done = sqlite.prepare('SELECT status, done_at FROM next_steps').get();
  assert.equal(done.status, 'done');
  assert.ok(done.done_at);
  assert.equal((await call(db, 'PATCH', '/api/admin/steps/999', { status: 'done' })).status, 404);

  r = await call(db, 'POST', '/api/admin/notes', { accountId: UEP, body: 'Molly wants a\nNov 4 review.' });
  assert.equal(r.status, 201);
  assert.equal(sqlite.prepare('SELECT created_by FROM notes').get().created_by, 'eric@positivetribes.org');
  assert.equal((await call(db, 'DELETE', `/api/admin/notes/${r.body.id}`)).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM notes').get().n, 0);
});

test('links must be web addresses', async () => {
  const { db, sqlite } = database();
  const ok = await call(db, 'PUT', `/api/admin/clients/${UEP}/meta`, { links: [{ label: 'Prototype', url: 'https://positivetribes.org/uep/' }], match: { domains: ['UpEndingParkinsons.org'], keywords: ['climb scheduler'] }, pinned: true });
  assert.equal(ok.status, 200);
  const row = sqlite.prepare('SELECT * FROM client_meta').get();
  assert.equal(row.pinned, 1);
  assert.deepEqual(JSON.parse(row.match_json).domains, ['upendingparkinsons.org']);
  assert.equal((await call(db, 'PUT', `/api/admin/clients/${UEP}/meta`, { links: [{ label: 'x', url: 'javascript:alert(1)' }] })).status, 400);
  assert.equal((await call(db, 'PUT', `/api/admin/clients/${UEP}/meta`, { match: { domains: ['not a domain'] } })).status, 400);
});

test('the sync routine can post activity, and reruns do not duplicate it', async () => {
  const { db, sqlite } = database();
  const payload = {
    note: 'Daily sync',
    items: [
      { external_id: 'gmail:abc', account_id: UEP, kind: 'email', occurred_at: '2026-10-28T15:04:00Z', title: 'Proposal for signing', summary: 'Molly will review by Nov 4.', url: 'https://mail.google.com/mail/u/0/#all/abc' },
      { external_id: 'gcal:evt1', account_id: SAFE, kind: 'calendar', occurred_at: '2026-11-03T17:00:00-07:00', title: 'SAFE chapters walkthrough' }
    ],
    steps: [{ external_id: 'fathom:9:1', account_id: UEP, title: 'Send revised scope', due_date: '2026-11-02' }]
  };
  let r = await call(db, 'POST', '/api/admin/activity', payload, { who: ROUTINE, origin: null });
  assert.deepEqual(r.body, { ok: true, added: 2, updated: 0, removed: 0, steps: 1 });
  assert.equal(sqlite.prepare("SELECT occurred_at FROM activity WHERE external_id = 'gcal:evt1'").get().occurred_at, '2026-11-04T00:00:00.000Z');

  // A suggestion Eric dismissed stays dismissed when the routine sends it again.
  sqlite.exec("UPDATE next_steps SET status = 'dismissed'");
  payload.items[1].occurred_at = '2026-11-05T17:00:00Z';
  r = await call(db, 'POST', '/api/admin/activity', payload, { who: ROUTINE, origin: null });
  assert.deepEqual(r.body, { ok: true, added: 0, updated: 2, removed: 0, steps: 0 });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM activity').get().n, 2);
  assert.equal(sqlite.prepare('SELECT status FROM next_steps').get().status, 'dismissed');
  assert.equal(sqlite.prepare("SELECT occurred_at FROM activity WHERE external_id = 'gcal:evt1'").get().occurred_at, '2026-11-05T17:00:00.000Z');

  r = await call(db, 'POST', '/api/admin/activity', { items: [{ external_id: 'gcal:evt1', cancelled: true }] }, { who: ROUTINE, origin: null });
  assert.equal(r.body.removed, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sync_runs').get().n, 3);

  for (const bad of [
    { items: [{ external_id: 'x', account_id: UEP, kind: 'tweet', occurred_at: '2026-10-28', title: 't' }] },
    { items: [{ external_id: 'x', account_id: UEP, kind: 'email', occurred_at: 'yesterday', title: 't' }] },
    { items: [{ external_id: 'x', account_id: UEP, kind: 'email', occurred_at: '2026-10-28', title: 't', url: 'javascript:alert(1)' }] },
    { items: [{ account_id: UEP, kind: 'email', occurred_at: '2026-10-28', title: 't' }] },
    { items: Array.from({ length: 201 }, (_, i) => ({ external_id: 'x' + i })) }
  ]) assert.equal((await call(db, 'POST', '/api/admin/activity', bad, { who: ROUTINE, origin: null })).status, 400);
  // A bad batch saves nothing.
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM sync_runs').get().n, 3);
});

test('overview works without Salesforce, from local data only', async () => {
  const { db } = database();
  const r = await call(db, 'GET', '/api/admin/overview');
  assert.equal(r.status, 200);
  assert.equal(r.body.salesforce, 'off');
  assert.deepEqual(r.body.clients, []);
});

// ---- The Today rules ----

const SF_ENV = { SF_DOMAIN: 'https://pt.my.salesforce.com' };
const today = '2026-10-29';
const opp = (Id, StageName, CloseDate, extra = {}) => ({ Id, Name: 'Opp ' + Id, StageName, CloseDate, NextStep: null, IsClosed: false, IsWon: false, ...extra });
const sf = {
  accounts: [
    { Id: UEP, Name: "Up Ending Parkinson's", Type: 'Prospect', Opportunities: { records: [opp('006A', 'Proposal', '2026-11-05')] } },
    { Id: SAFE, Name: 'SAFE', Type: 'Partner', Opportunities: { records: [opp('006B', 'Mockup & Align', '2026-10-01')] } },
    { Id: ROCKS, Name: 'United Rocks', Type: 'Prospect', Opportunities: { records: [opp('006C', 'Closed Lost', '2026-12-31', { IsClosed: true })] } },
    { Id: '001Pr0000111WhXIAU', Name: 'Hidden Co', Opportunities: { records: [opp('006D', 'Connect & Frame', '2026-10-30')] } }
  ],
  tasks: [
    { Id: '00T1', Subject: 'Email: Proposal for signing', ActivityDate: '2026-10-28', CreatedDate: '2026-10-28T15:00:00.000+0000', IsClosed: true, AccountId: UEP },
    { Id: '00T2', Subject: 'Call Duke', ActivityDate: '2026-10-20', CreatedDate: '2026-10-01T15:00:00.000+0000', IsClosed: false, AccountId: SAFE }
  ],
  events: [{ Id: '00U1', Subject: 'UEP review', StartDateTime: '2026-11-04T17:00:00.000+0000', IsAllDayEvent: false, ActivityDate: '2026-11-04', AccountId: UEP }],
  cases: [],
  leads: [
    { Id: '00Q1', Name: 'Pat Doe', Company: '[not provided]', Status: 'Open', Rating: null, LeadSource: 'Web', CreatedDate: '2026-10-27T12:00:00.000+0000' },
    { Id: '00Q2', Name: 'Sam Hot', Company: 'Mountain Rescue', Status: 'Qualified', Rating: 'Hot', LeadSource: 'Referral', CreatedDate: '2026-10-20T12:00:00.000+0000' },
    { Id: '00Q3', Name: 'Wendy Warm', Company: 'Trail Club', Status: 'Qualified', Rating: 'Warm', LeadSource: 'Web', CreatedDate: '2026-10-22T12:00:00.000+0000' }
  ]
};
const local = {
  meta: [{ account_id: '001Pr0000111WhXIAU', links_json: '[]', match_json: '{}', pinned: 0, hidden: 1 }, { account_id: SAFE, links_json: '[]', match_json: '{}', pinned: 1, hidden: 0 }],
  steps: [
    { id: 1, account_id: UEP, title: 'Send revised scope', due_date: '2026-10-27', status: 'open', source: 'you' },
    { id: 2, account_id: UEP, title: 'Prep demo', due_date: '2026-11-02', status: 'open', source: 'claude' },
    { id: 3, account_id: UEP, title: 'Old idea', due_date: '2026-10-29', status: 'dismissed', source: 'claude' }
  ],
  notes: [{ id: 1, account_id: UEP, body: 'Molly likes it', created_at: '2026-10-29T16:00:00Z' }],
  activity: [{ id: 1, account_id: SAFE, kind: 'meeting', occurred_at: '2026-09-15T16:00:00Z', title: 'SAFE kickoff', summary: '', url: '' }]
};

test('Today shows what needs attention, what is coming and what just happened', () => {
  const view = buildOverview(SF_ENV, sf, local, today);
  assert.deepEqual(view.clients.map(c => c.name), ['SAFE', "Up Ending Parkinson's", 'United Rocks'], 'pinned first, hidden left out, inactive last');
  const uep = view.clients.find(c => c.id === UEP);
  assert.equal(uep.lastTouch, '2026-10-29');
  assert.equal(uep.nextStep.title, 'Send revised scope');
  assert.equal(view.clients.find(c => c.id === SAFE).lastTouch, '2026-09-15');
  assert.equal(view.clients.find(c => c.id === ROCKS).active, false);

  const reasons = view.attention.map(a => `${a.reason}: ${a.title}`).sort();
  assert.deepEqual(reasons, [
    'Hot lead: Sam Hot (Mountain Rescue)',
    'No activity in 21+ days · No next step: SAFE',
    'Overdue Salesforce task: Call Duke',
    'Overdue step: Send revised scope',
    'Past target close date: Opp 006B',
    'Unrated lead: Pat Doe',
    'Warm lead: Wendy Warm (Trail Club)'
  ]);
  assert.deepEqual(view.upcoming.map(i => i.title), ['Prep demo', 'UEP review', 'Opp 006A']);
  assert.deepEqual(view.recent.map(i => i.title), ['Molly likes it', 'Proposal for signing']);
  assert.ok(view.attention.every(a => a.accountId !== '001Pr0000111WhXIAU'));
});

test('Now puts satisfaction first, then Hot and Warm leads, then revenue and quiet clients', () => {
  const view = buildOverview(SF_ENV, sf, local, today);
  assert.deepEqual(view.now.map(i => `${i.title}: ${i.why}`), [
    'Call Duke: Hard deadline missed 9 days ago',
    'Send revised scope: Hard deadline missed 2 days ago',
    'Sam Hot (Mountain Rescue): Hot lead: fits Positive Tribes and is a high priority',
    'Wendy Warm (Trail Club): Warm lead: a good fit, follow up',
    'Pat Doe: Unrated lead: rate it in Salesforce (Hot, Warm or Cold)'
  ]);
  assert.equal(rankNow(view.attention, view.upcoming, today, Date.now(), 20).at(-1).title, 'SAFE', 'quiet clients rank last');
  const meeting = { type: 'meeting', title: 'Standup', at: '2026-10-29T15:00:00Z', day: today };
  assert.equal(rankNow([], [meeting], today, Date.parse('2026-10-29T15:30:00Z'))[0].why, 'Fixed time today');
  assert.deepEqual(rankNow([], [meeting], today, Date.parse('2026-10-29T17:00:00Z')), [], 'a meeting that is over drops out');
});

test('a client page splits the timeline at now', () => {
  const view = buildClient(SF_ENV, { account: sf.accounts[0], tasks: sf.tasks.slice(0, 1), events: sf.events, cases: [], contacts: [], history: [] },
    { meta: null, steps: local.steps, notes: local.notes, activity: [] }, today);
  assert.deepEqual(view.future.map(i => i.title), ['Prep demo', 'UEP review', 'Opp 006A']);
  assert.deepEqual(view.past.map(i => i.title), ['Molly likes it', 'Proposal for signing', 'Send revised scope']);
  assert.deepEqual(view.steps.map(s => s.title), ['Send revised scope', 'Prep demo']);
});

test('match rules come from Contacts, the website and saved extras', () => {
  const rules = buildMatch(
    [{ Id: UEP, Name: 'UEP', Website: 'www.upendingparkinsons.org' }, { Id: '001Pr0000111WhXIAU', Name: 'Hidden Co' }],
    [{ AccountId: UEP, Name: 'Molly Cupka', Email: 'UpEndingParkinsons@gmail.com' }, { AccountId: UEP, Name: 'Tammie Koenig', Email: 'tammie@upendingparkinsons.org' }],
    [{ account_id: UEP, match_json: '{"keywords":["climb scheduler"],"domains":["uep.org"]}' }, { account_id: '001Pr0000111WhXIAU', hidden: 1 }]
  );
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].emails, ['upendingparkinsons@gmail.com', 'tammie@upendingparkinsons.org']);
  assert.deepEqual(rules[0].domains.sort(), ['uep.org', 'upendingparkinsons.org']);
  assert.deepEqual(rules[0].keywords, ['climb scheduler']);
});

test('a contact linked from another account adds their email but not their domain', () => {
  const rules = buildMatch(
    [{ Id: UEP, Name: 'UEP' }],
    [{ AccountId: UEP, IsDirect: false, Name: 'Glenn Hadley', Email: 'glenn@soberafe.com' }],
    []
  );
  assert.deepEqual(rules[0].people, ['Glenn Hadley']);
  assert.deepEqual(rules[0].emails, ['glenn@soberafe.com']);
  assert.deepEqual(rules[0].domains, []);
});

// ---- Backlog inbox ----

test('the inbox shows client changes, one row per item, and leaves out Eric and cleared events', () => {
  const event = (id, item_id, action, actor, at, extra = {}) => ({ id, item_id, action, item_title: 'Item ' + item_id, item_kind: 'question', detail: '', actor, at, ...extra });
  const results = [
    { status: 'ok', events: [
      event(1, 10, 'added', 'Molly', '2026-10-28 15:00:00'),
      event(2, 10, 'answered', 'Molly', '2026-10-29 16:00:00', { detail: 'Yes, 84 accounts' }),
      event(3, 11, 'added', 'Eric R', '2026-10-29 17:00:00'),
      event(4, 12, 'deleted', 'molly', '2026-10-27 09:00:00'),
      event(5, 13, 'done', 'Molly', '2026-10-29 18:00:00')
    ] },
    { status: 'off', events: [] },
    { status: 'not_ready', events: [] }
  ];
  const inbox = buildInbox(BACKLOGS, results, [{ backlog: 'uep', event_id: 5 }, { backlog: 'coyote', event_id: 4 }], ['eric']);
  assert.deepEqual(inbox.backlogs.map(b => [b.key, b.status, b.unread]), [['uep', 'ok', 2], ['coyote', 'off', 0], ['soberafe', 'not_ready', 0]]);
  assert.deepEqual(inbox.items.map(i => [i.itemId, i.action, i.added, i.eventIds]), [[10, 'answered', true, [1, 2]], [12, 'deleted', false, [4]]]);
  const [answered, deleted] = inbox.items;
  assert.equal(answered.at, '2026-10-29T16:00:00Z');
  assert.equal(answered.detail, 'Yes, 84 accounts');
  assert.equal(answered.url, 'https://uep.positivetribes.org/#item-10');
  assert.equal(answered.accountId, UEP);
  // A deleted item has nothing to scroll to, so it links to the backlog itself.
  assert.equal(deleted.url, 'https://uep.positivetribes.org/');
});

test('the inbox reads a real backlog, reports backlogs it cannot read, and clearing sticks', async () => {
  const { db } = database();
  const uep = database(), safe = database();
  const env = { UEP_BACKLOG_DB: uep.db, SOBERAFE_BACKLOG_DB: safe.db };
  const backlog = (name, method, path, payload) => uepBacklog.fetch(new Request('https://uep.test/api' + path, {
    method,
    headers: { 'x-backlog-passcode': 'p', 'content-type': 'application/json', 'x-backlog-name': name },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  }), { DB: uep.db, BACKLOG_PASSCODE: 'p', ASSETS: {} });
  await backlog('Molly', 'POST', '/items', { kind: 'change', title: 'Bigger buttons', tier: 'must', added_by: 'Molly' });
  await backlog('Eric', 'POST', '/items', { kind: 'change', title: 'Eric note', tier: 'idea', added_by: 'Eric' });

  let r = await call(db, 'GET', '/api/admin/inbox', undefined, { env });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.backlogs.map(b => [b.key, b.status, b.unread]), [['uep', 'ok', 1], ['coyote', 'off', 0], ['soberafe', 'not_ready', 0]]);
  assert.equal(r.body.items[0].title, 'Bigger buttons');
  assert.equal(r.body.items[0].actor, 'Molly');
  assert.equal((await call(db, 'GET', '/api/admin/overview', undefined, { env })).body.inboxCount, 1);

  // Only Eric, from this site, can clear; bad input is refused.
  const clear = { items: [{ backlog: 'uep', eventIds: r.body.items[0].eventIds }] };
  assert.equal((await call(db, 'POST', '/api/admin/inbox/clear', clear, { env, who: ROUTINE })).status, 403);
  assert.equal((await call(db, 'POST', '/api/admin/inbox/clear', clear, { env, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(db, 'POST', '/api/admin/inbox/clear', { items: [{ backlog: 'nope', eventIds: [1] }] }, { env })).status, 400);
  assert.equal((await call(db, 'POST', '/api/admin/inbox/clear', { items: [{ backlog: 'uep', eventIds: ['1'] }] }, { env })).status, 400);
  assert.equal((await call(db, 'POST', '/api/admin/inbox/clear', clear, { env })).status, 200);
  assert.equal((await call(db, 'POST', '/api/admin/inbox/clear', clear, { env })).status, 200);
  r = await call(db, 'GET', '/api/admin/inbox', undefined, { env });
  assert.deepEqual(r.body.items, []);

  // A later change to the same item comes back as a new row.
  const id = (await (await backlog('Molly', 'GET', '/items')).json()).items.find(i => i.title === 'Bigger buttons').id;
  await backlog('Molly', 'PATCH', '/items/' + id, { done: true });
  r = await call(db, 'GET', '/api/admin/inbox', undefined, { env });
  assert.deepEqual(r.body.items.map(i => [i.action, i.added]), [['done', false]]);
});
