import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { database } from './helpers.mjs';
import { accessIdentity } from '../src/access.js';
import { handleAdmin, buildOverview, rankNow, buildMatch, buildClient, buildInbox, BACKLOGS, lastSeenBy } from '../src/admin.js';
import hub from '../src/index.js';

const TEAM = 'positivetribes.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const ORIGIN = 'https://hub.positivetribes.org';
const SYNC = '1832d7e5e79b6740c6a00a00ee1facd6.access';
const UEP = '001Pr00000yy8o9IAA', SAFE = '001Pr00000yyXUuIAM', ROCKS = '001Pr00000zpU7OIAU';

// One signing key served from the Access certs URL, and a second key Access never published.
const algorithm = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' };
const keys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
const strangerKeys = await crypto.subtle.generateKey(algorithm, true, ['sign', 'verify']);
const publicJwk = { ...await crypto.subtle.exportKey('jwk', keys.publicKey), kid: 'key-1' };
const realFetch = globalThis.fetch;
let fakeSalesforce = null;
globalThis.fetch = async (input, init) => {
  if (String(input) === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [publicJwk] });
  if (fakeSalesforce && String(input).startsWith('https://sf.example')) return fakeSalesforce(String(input), init);
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
const accessEnv = (extra = {}) => ({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extra });
const ask = jwt => new Request(ORIGIN + '/api/admin/overview', { headers: jwt ? { 'Cf-Access-Jwt-Assertion': jwt } : {} });
const identify = (request, e = accessEnv()) => accessIdentity(request, e, new URL(request.url));

// ---- Who gets in ----

test('a valid Access token is a person; a service token is a service', async () => {
  assert.deepEqual(await identify(ask(await token({ email: 'Eric@PositiveTribes.org' }))), { email: 'eric@positivetribes.org' });
  assert.deepEqual(await identify(ask(await token({ email: undefined, common_name: SYNC }))), { service: SYNC });
});

test('everything else is refused', async () => {
  const refused = async (request, e) => assert.equal(await identify(request, e), null);
  await refused(ask(null));
  await refused(ask('not.a.token'));
  await refused(ask(await token({ aud: ['b'.repeat(64)] })));
  await refused(ask(await token({ exp: Math.floor(Date.now() / 1000) - 5 })));
  await refused(ask(await token({ iss: 'https://evil.cloudflareaccess.com' })));
  await refused(ask(await token({}, { key: strangerKeys.privateKey })));
  await refused(ask(await token({}, { kid: 'unknown' })));
  await refused(ask(await token({}, { alg: 'none' })));
  await refused(ask(await token({ email: undefined })));
  // Fails closed when Access is not configured.
  await refused(ask(await token()), {});
  await refused(ask(await token()), accessEnv({ ACCESS_AUD: '' }));
  await refused(ask(await token()), accessEnv({ ACCESS_TEAM_DOMAIN: 'evil.example.com' }));
});

test('the local development stand-ins only work on localhost', async () => {
  const dev = { HUB_DEV: '1' };
  assert.deepEqual(await identify(new Request('http://localhost/api/me', { headers: { 'x-dev-email': 'A@b.org' } }), dev), { email: 'a@b.org' });
  assert.deepEqual(await identify(new Request('http://localhost/api/me', { headers: { 'x-dev-service': SYNC } }), dev), { service: SYNC });
  assert.equal(await identify(new Request(ORIGIN + '/api/me', { headers: { 'x-dev-email': 'a@b.org' } }), dev), null);
});

// A hub database with three clients and their people, plus the command center's own database.
function hubDb() {
  const h = database();
  for (const file of ['0001_init.sql', '0002_legacy_ids.sql', '0003_releases.sql', '0004_release_url.sql', '0005_release_script.sql', '0006_release_window.sql', '0007_project_live_url.sql', '0008_documents.sql', '0009_hub_ideas.sql', '0010_hub_idea_images.sql', '0011_documents_for_everyone.sql', '0012_notifications.sql', '0013_notification_clear.sql', '0014_last_seen.sql', '0015_care_plans.sql', '0016_patch_triage.sql', '0017_document_date.sql', '0018_client_salesforce_url.sql', '0019_project_has_prototype.sql', '0020_client_logo.sql']) {
    h.sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  h.sqlite.exec(`
    INSERT INTO clients (slug, name) VALUES ('uep', 'UEP'), ('safe', 'Sober AF'), ('coyote', 'Project Coyote');
    INSERT INTO projects (client_id, slug, name) VALUES (1, 'scheduler', 'Scheduler'), (2, 'chapters', 'Chapters'), (3, 'mange-app', 'Mange app');
    INSERT INTO users (email, name, role, client_id) VALUES ('molly@uep.org', 'Molly Cupka', 'ed', 1), ('dana@safe.org', 'Dana', 'ed', 2), ('mark@coyote.org', 'Mark', 'ed', 3), ('eric@positivetribes.org', 'Eric Roberts', 'pt', NULL);
  `);
  const admin = database();
  const env = { DB: h.db, ADMIN_DB: admin.db, HUB_DEV: '1', SYNC_SERVICE_TOKENS: SYNC, ASSETS: { fetch: () => new Response('asset') } };
  // As a person (x-dev-email) or the sync routine (x-dev-service), through the whole Worker.
  const as = (who, method, path, payload, { service = false, origin = 'http://localhost' } = {}) => hub.fetch(new Request('http://localhost/api/' + path, {
    method,
    headers: { [service ? 'x-dev-service' : 'x-dev-email']: who, 'content-type': 'application/json', ...(origin && method !== 'GET' ? { origin } : {}) },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  }), env);
  return { hub: h, admin, env, as };
}

test('the command center is Positive Tribes only; clients and strangers are told it does not exist', async () => {
  const { as } = hubDb();
  assert.equal((await as('eric@positivetribes.org', 'GET', 'admin/overview')).status, 200);
  for (const who of ['molly@uep.org', 'dana@safe.org', 'stranger@example.org']) {
    assert.equal((await as(who, 'GET', 'admin/overview')).status, 404, who);
    assert.equal((await as(who, 'POST', 'admin/steps', { accountId: UEP, title: 'x' })).status, 404, who);
  }
  // Writes must come from the hub itself.
  assert.equal((await as('eric@positivetribes.org', 'POST', 'admin/steps', { accountId: UEP, title: 'x' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await as('eric@positivetribes.org', 'POST', 'admin/steps', { accountId: UEP, title: 'Send the scope' })).status, 201);
});

test('the sync token reaches only the two sync routes, and no other token gets in', async () => {
  const { as, admin } = hubDb();
  const post = { items: [{ external_id: 'gmail:1', account_id: UEP, kind: 'email', occurred_at: '2026-11-01T15:00:00Z', title: 'Hello' }] };
  const r = await as(SYNC, 'POST', 'admin/activity', post, { service: true, origin: null });
  assert.equal(r.status, 200);
  assert.equal(admin.sqlite.prepare('SELECT COUNT(*) AS n FROM activity').get().n, 1);
  // Match needs Salesforce, which is not connected here: it gets past the door and reports that instead.
  assert.equal((await as(SYNC, 'GET', 'admin/match', undefined, { service: true })).status, 503);
  assert.equal((await as(SYNC, 'GET', 'admin/overview', undefined, { service: true })).status, 403);
  assert.equal((await as(SYNC, 'GET', 'me', undefined, { service: true })).status, 403);
  assert.equal((await as(SYNC, 'GET', 'c/uep/items', undefined, { service: true })).status, 403);
  assert.equal((await as('other.access', 'POST', 'admin/activity', post, { service: true, origin: null })).status, 403);
});

// ---- API against a real SQLite database (Salesforce not connected) ----

const ME = { email: 'eric@positivetribes.org' }, ROUTINE = { service: SYNC };
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
  assert.deepEqual(r.body.testing, []);
});

test('Today counts down every client phase in testing, from the hub', async () => {
  const { hub: h, admin } = hubDb();
  h.sqlite.exec(`
    INSERT INTO releases (client_id, project_id, number, name, stage, uat_started, uat_days, uat_day_type, auto_accept) VALUES
      (1, 1, 1, '', 'uat', '2026-10-30', 10, 'business', 1), (1, 1, 2, '', 'waiting', NULL, 30, 'calendar', 0), (2, 2, 1, 'Pilot', 'uat', '2026-11-02', 30, 'calendar', 0);
  `);
  const r = await call(admin.db, 'GET', '/api/admin/overview', undefined, { env: { DB: h.db } });
  assert.deepEqual(r.body.testing.map(t => [t.client, t.workspace, t.project, t.phase, t.due, t.autoAccept]), [
    ['UEP', 'uep', 'Scheduler', 'Phase 1', '2026-11-13', true],
    ['Sober AF', 'safe', 'Chapters', 'Pilot', '2026-12-02', false]
  ]);
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
    { Id: '00Q3', Name: 'Wendy Warm', Company: 'Trail Club', Status: 'Qualified', Rating: 'Warm', LeadSource: 'Web', CreatedDate: '2026-10-22T12:00:00.000+0000' },
    { Id: '00Q4', Name: 'Kent Touched', Company: '[not provided]', Status: 'Working', Rating: 'Warm', LeadSource: 'Word of mouth', CreatedDate: '2026-10-04T12:00:00.000+0000', LastActivityDate: '2026-10-27' }
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
    'Warm lead: Wendy Warm (Trail Club)'
  ]);
  const wendy = view.attention.find(a => a.title.startsWith('Wendy'));
  assert.match(wendy.detail, /^7 days with no contact logged since it came in · Web · Qualified · follow up/);
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
    'Opp 006B: Revenue: past its target close date'
  ]);
  assert.equal(rankNow(view.attention, view.upcoming, today, Date.now(), 20).at(-1).title, 'SAFE', 'quiet clients rank last');
  const meeting = { type: 'meeting', title: 'Standup', at: '2026-10-29T15:00:00Z', day: today };
  assert.equal(rankNow([], [meeting], today, Date.parse('2026-10-29T15:30:00Z'))[0].why, 'Fixed time today');
  assert.deepEqual(rankNow([], [meeting], today, Date.parse('2026-10-29T17:00:00Z')), [], 'a meeting that is over drops out');
});

test('a meeting in Salesforce and in the synced calendar shows once, with the summary', () => {
  const synced = { id: 9, account_id: UEP, kind: 'calendar', occurred_at: '2026-11-04T17:00:00Z', title: 'UEP review', summary: 'Talk budget', url: '' };
  const view = buildOverview(SF_ENV, sf, { ...local, activity: [...local.activity, synced] }, today);
  const meetings = view.upcoming.filter(i => i.title === 'UEP review');
  assert.equal(meetings.length, 1);
  assert.equal(meetings[0].detail, 'Talk budget');
  assert.equal(meetings[0].source, 'salesforce');
});

test('a client page splits the timeline at now', () => {
  const view = buildClient(SF_ENV, { account: sf.accounts[0], tasks: sf.tasks.slice(0, 1), events: sf.events, cases: [], contacts: [], history: [] },
    { meta: null, steps: local.steps, notes: local.notes, activity: [] }, today);
  assert.deepEqual(view.future.map(i => i.title), ['Prep demo', 'UEP review', 'Opp 006A']);
  assert.deepEqual(view.past.map(i => i.title), ['Molly likes it', 'Proposal for signing', 'Send revised scope']);
  assert.deepEqual(view.steps.map(s => s.title), ['Send revised scope', 'Prep demo']);
});

test('one email sent to several Contacts shows once, naming each recipient', () => {
  const sent = { Subject: 'Email: Hub launch', ActivityDate: '2026-10-29', CreatedDate: '2026-10-29T12:29:23.000+0000', IsClosed: true, AccountId: UEP };
  const tasks = [
    { ...sent, Id: '00T7', Who: { Name: 'Ann Lee' } },
    { ...sent, Id: '00T8', Who: { Name: 'Ben Ortiz' } },
    { ...sent, Id: '00T9', Subject: 'Email: Different email', Who: { Name: 'Ann Lee' } }
  ];
  const view = buildClient(SF_ENV, { account: sf.accounts[0], tasks, events: [], cases: [], contacts: [], history: [] },
    { meta: null, steps: [], notes: [], activity: [] }, today);
  const emails = view.past.filter(i => i.type === 'email');
  assert.deepEqual(emails.map(i => [i.title, i.detail]).sort(), [['Different email', 'To Ann Lee'], ['Hub launch', 'To Ann Lee, Ben Ortiz']]);
});

test('match rules come from Contacts, the website and saved extras', () => {
  const rules = buildMatch(
    [{ Id: UEP, Name: 'UEP', Website: 'www.upendingparkinsons.org' }, { Id: '001Pr0000111WhXIAU', Name: 'Hidden Co' }],
    [{ AccountId: UEP, Name: 'Molly Cupka', Email: 'Molly.Example@gmail.com' }, { AccountId: UEP, Name: 'Staff Person', Email: 'staff@upendingparkinsons.org' }],
    [{ account_id: UEP, match_json: '{"keywords":["climb scheduler"],"domains":["uep.org"]}' }, { account_id: '001Pr0000111WhXIAU', hidden: 1 }]
  );
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].emails, ['molly.example@gmail.com', 'staff@upendingparkinsons.org']);
  assert.deepEqual(rules[0].domains.sort(), ['uep.org', 'upendingparkinsons.org']);
  assert.deepEqual(rules[0].keywords, ['climb scheduler']);
});

test('a contact linked from another account adds their email but not their domain', () => {
  const rules = buildMatch(
    [{ Id: UEP, Name: 'UEP' }],
    [{ AccountId: UEP, IsDirect: false, Name: 'Linked Person', Email: 'person@soberafe.com' }],
    []
  );
  assert.deepEqual(rules[0].people, ['Linked Person']);
  assert.deepEqual(rules[0].emails, ['person@soberafe.com']);
  assert.deepEqual(rules[0].domains, []);
});

// ---- Inbox ----

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
  const inbox = buildInbox(BACKLOGS, results, [{ backlog: 'uep-hub', event_id: 5 }, { backlog: 'coyote-hub', event_id: 4 }], ['eric']);
  assert.deepEqual(inbox.backlogs.map(b => [b.key, b.status, b.unread]), [['uep-hub', 'ok', 2], ['coyote-hub', 'off', 0], ['safe-hub', 'not_ready', 0]]);
  assert.deepEqual(inbox.items.map(i => [i.itemId, i.action, i.added, i.eventIds]), [[10, 'answered', true, [1, 2]], [12, 'deleted', false, [4]]]);
  const [answered, deleted] = inbox.items;
  assert.equal(answered.at, '2026-10-29T16:00:00Z');
  assert.equal(answered.detail, 'Yes, 84 accounts');
  // Links stay inside the hub.
  assert.equal(answered.url, '#/uep/backlog/10');
  assert.equal(answered.accountId, UEP);
  // A deleted item has nothing to scroll to, so it links to the workspace itself.
  assert.equal(deleted.url, '#/uep/home');
});

test('the inbox reads each client from the hub database, keeps them apart, and clearing sticks', async () => {
  const { hub: h, admin, as } = hubDb();
  const env = { DB: h.db };
  const db = admin.db;
  assert.equal((await as('dana@safe.org', 'POST', 'c/safe/items', { title: 'Bigger buttons', kind: 'change', tier: 'must', project_id: 2 })).status, 201);
  await as('eric@positivetribes.org', 'POST', 'c/safe/items', { title: 'Eric note', kind: 'change', tier: 'idea', project_id: 2 });
  await as('mark@coyote.org', 'POST', 'c/coyote/items', { title: 'Photo upload', kind: 'question', tier: 'nice', project_id: 3 });
  assert.equal((await as('molly@uep.org', 'POST', 'c/uep/items', { title: 'Save fails on step 3', kind: 'problem', tier: 'must', project_id: 1 })).status, 201);

  let r = await call(db, 'GET', '/api/admin/inbox', undefined, { env });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.backlogs.map(b => [b.key, b.status, b.unread]), [['uep-hub', 'ok', 1], ['coyote-hub', 'ok', 1], ['safe-hub', 'ok', 1]]);
  const safe = r.body.items.find(i => i.backlog === 'safe-hub');
  assert.deepEqual([safe.title, safe.actor, safe.client, safe.accountId], ['Bigger buttons', 'Dana', 'Sober AF', SAFE]);
  assert.match(safe.url, /^#\/safe\/backlog\/\d+$/);
  const uep = r.body.items.find(i => i.backlog === 'uep-hub');
  assert.deepEqual([uep.title, uep.actor, uep.kind], ['Save fails on step 3', 'Molly Cupka', 'problem']);
  let overview = (await call(db, 'GET', '/api/admin/overview', undefined, { env })).body;
  assert.deepEqual([overview.inboxCount, overview.carePending], [3, 0]);
  // The Care plans tab counts Patch's suggestions waiting for a decision, and only those.
  await h.db.prepare("INSERT INTO patch_decisions (client_id, item_id, status, kind, trust_kind) VALUES (1, 1, 'pending', 'fix', 'fix'), (1, 2, 'agreed', 'fix', 'fix')").run();
  overview = (await call(db, 'GET', '/api/admin/overview', undefined, { env })).body;
  assert.equal(overview.carePending, 1);

  // Only Eric, from the hub, can clear; bad input is refused. Clearing one client leaves the others alone.
  const clear = { items: [{ backlog: 'safe-hub', eventIds: safe.eventIds }] };
  assert.equal((await call(db, 'POST', '/api/admin/inbox/clear', clear, { env, who: ROUTINE })).status, 403);
  assert.equal((await call(db, 'POST', '/api/admin/inbox/clear', clear, { env, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(db, 'POST', '/api/admin/inbox/clear', { items: [{ backlog: 'soberafe', eventIds: [1] }] }, { env })).status, 400);
  assert.equal((await call(db, 'POST', '/api/admin/inbox/clear', { items: [{ backlog: 'safe-hub', eventIds: ['1'] }] }, { env })).status, 400);
  assert.equal((await call(db, 'POST', '/api/admin/inbox/clear', clear, { env })).status, 200);
  assert.equal((await call(db, 'POST', '/api/admin/inbox/clear', clear, { env })).status, 200);
  r = await call(db, 'GET', '/api/admin/inbox', undefined, { env });
  assert.deepEqual(r.body.items.map(i => i.backlog).sort(), ['coyote-hub', 'uep-hub']);

  // Eric's own work, phases and documents the database logs by itself, and idea replies are not news to Eric.
  h.sqlite.exec("INSERT INTO releases (client_id, project_id, number, stage) VALUES (1, 1, 1, 'uat'); INSERT INTO documents (client_id, title, url) VALUES (1, 'Proposal', 'https://x')");
  await as('molly@uep.org', 'POST', 'ideas', { title: 'Dark mode' });
  await as('eric@positivetribes.org', 'PATCH', 'ideas/1', { status: 'next' });
  r = await call(db, 'GET', '/api/admin/inbox', undefined, { env });
  const idea = r.body.items.find(i => i.kind === 'idea');
  assert.deepEqual([idea.title, idea.action, idea.url, idea.actor], ['Dark mode', 'added', '#/command/ideas', 'Molly Cupka']);
  assert.deepEqual(r.body.items.map(i => i.backlog).sort(), ['coyote-hub', 'uep-hub', 'uep-hub']);
  await call(db, 'POST', '/api/admin/inbox/clear', { items: [{ backlog: 'uep-hub', eventIds: idea.eventIds }] }, { env });

  // A later change to the same item comes back as a new row.
  await as('dana@safe.org', 'PATCH', 'c/safe/items/' + safe.itemId, { done: true });
  r = await call(db, 'GET', '/api/admin/inbox', undefined, { env });
  assert.deepEqual(r.body.items.filter(i => i.backlog === 'safe-hub').map(i => [i.action, i.added]), [['done', false]]);
});

// ---- Documents ----

test('documents: Positive Tribes keeps its own and every client\'s; clients see only their own shown ones', async () => {
  const { hub: h, as } = hubDb();
  const add = (payload, who = 'eric@positivetribes.org') => as(who, 'POST', 'admin/documents', payload);
  let r = await add({ client: '', kind: 'process', title: 'Sales process', url: 'https://claude.ai/artifact/abc', visible: true });
  assert.equal(r.status, 201);
  const own = (await r.json()).id;
  assert.equal((await add({ client: 'uep', project_id: 1, kind: 'proposal', title: 'Phase 3 proposal', url: 'https://drive.google.com/file/d/1', status: 'sent', visible: true })).status, 201);
  assert.equal((await add({ client: 'uep', kind: 'design', title: 'Draft designs', url: 'https://figma.com/x' })).status, 201);
  assert.equal((await add({ client: 'safe', kind: 'proposal', title: 'Chapters proposal', note: 'After the Nov 4 budget call', visible: true })).status, 201);

  // Positive Tribes' own document is never shown, even when asked.
  assert.equal(h.sqlite.prepare('SELECT client_id, visible FROM documents WHERE id = ?').get(own).visible, 0);

  for (const bad of [
    { client: 'nope', title: 'x', url: 'https://a.org' },
    { client: 'safe', project_id: 1, title: 'x', url: 'https://a.org' },
    { client: '', project_id: 1, title: 'x', url: 'https://a.org' },
    { client: '', kind: 'memo', title: 'x', url: 'https://a.org' },
    { client: '', status: 'lost', title: 'x', url: 'https://a.org' },
    { client: '', title: '', url: 'https://a.org' },
    { client: '', title: 'x', url: 'javascript:alert(1)' },
    { client: '', title: 'x' }
  ]) assert.equal((await add(bad)).status, 400, JSON.stringify(bad));

  const list = await (await as('eric@positivetribes.org', 'GET', 'admin/documents')).json();
  assert.deepEqual(list.documents.map(d => [d.client, d.title, d.visible]), [
    ['', 'Sales process', false], ['uep', 'Phase 3 proposal', true], ['uep', 'Draft designs', false], ['safe', 'Chapters proposal', true]
  ]);
  assert.deepEqual(list.clients.find(c => c.slug === 'uep').projects, [{ id: 1, name: 'Scheduler' }]);

  // Clients cannot reach the list, and their workspace shows only their own shown documents.
  assert.equal((await as('molly@uep.org', 'GET', 'admin/documents')).status, 404);
  assert.equal((await add({ client: 'uep', title: 'x', url: 'https://a.org' }, 'molly@uep.org')).status, 404);
  const uep = await (await as('molly@uep.org', 'GET', 'c/uep/projects')).json();
  assert.deepEqual(uep.documents.map(d => d.title), ['Phase 3 proposal']);

  // Edit moves a document and shows it; delete removes it.
  const designs = list.documents.find(d => d.title === 'Draft designs').id;
  assert.equal((await as('eric@positivetribes.org', 'PUT', 'admin/documents/' + designs, { client: 'uep', project_id: 1, kind: 'design', title: 'Designs', url: 'https://figma.com/x', visible: true })).status, 200);
  assert.deepEqual((await (await as('molly@uep.org', 'GET', 'c/uep/projects')).json()).documents.map(d => d.title), ['Designs', 'Phase 3 proposal']); // newest first
  assert.equal((await as('eric@positivetribes.org', 'DELETE', 'admin/documents/' + designs)).status, 200);
  assert.equal((await as('eric@positivetribes.org', 'DELETE', 'admin/documents/' + designs)).status, 404);
  assert.equal(h.sqlite.prepare('SELECT COUNT(*) AS n FROM documents').get().n, 3);
});

test('each client\'s latest hub visit is its most recent person\'s', () => {
  assert.deepEqual(lastSeenBy([
    { slug: 'uep', last_seen_at: '2026-11-01T10:00:00Z' }, { slug: 'uep', last_seen_at: '2026-11-02T09:00:00Z' },
    { slug: 'uep', last_seen_at: null }, { slug: 'safe', last_seen_at: null }
  ]), { uep: '2026-11-02T09:00:00Z' });
});

// ---- Next steps and Salesforce Tasks, against a small fake Salesforce ----

const ERIC_USER = '005ERIC00000001', GLENN_USER = '005GLEN00000001', UEP_OPP = '006UEP000000001';
function fakeOrg() {
  const org = { tasks: new Map(), next: 1, failWrites: false };
  const task = (id, fields) => org.tasks.set(id, { Id: id, AccountId: UEP, CreatedDate: '2026-10-28T15:00:00.000+0000', ActivityDate: null, IsClosed: false, OwnerId: ERIC_USER, Owner: { Name: 'Eric Roberts' }, ...fields });
  org.task = task;
  fakeSalesforce = async (url, init = {}) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/services/oauth2/token') return Response.json({ access_token: 't', instance_url: 'https://sf.example' });
    const path = pathname.replace('/services/data/v62.0', '');
    if (path === '/query') {
      const q = searchParams.get('q');
      const rows = list => Response.json({ records: list });
      if (/FROM Account WHERE Id/.test(q)) return rows([{ Id: UEP, Name: "Up Ending Parkinson's", Opportunities: { records: [{ Id: UEP_OPP, Name: 'Scheduler', StageName: 'Build', CloseDate: '2026-12-01', IsClosed: false }] } }]);
      if (/FROM Opportunity WHERE AccountId/.test(q)) return rows([{ Id: UEP_OPP }]);
      if (/FROM Task WHERE Id IN/.test(q)) { const ids = [...q.matchAll(/'([^']+)'/g)].map(m => m[1]); return rows([...org.tasks.values()].filter(t => ids.includes(t.Id))); }
      if (/FROM Task WHERE AccountId =/.test(q)) return rows([...org.tasks.values()]);
      return rows([]);
    }
    if (org.failWrites) return Response.json([{ errorCode: 'UNAVAILABLE' }], { status: 503 });
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === '/sobjects/Task' && init.method === 'POST') {
      const id = '00T' + String(org.next++).padStart(12, '0');
      task(id, { ...body, IsClosed: body.Status === 'Completed', AccountId: UEP, Owner: { Name: 'Eric Roberts' } });
      return Response.json({ id, success: true }, { status: 201 });
    }
    const one = path.match(/^\/sobjects\/Task\/(\w+)$/);
    if (one) {
      const t = org.tasks.get(one[1]);
      if (!t) return Response.json([{ errorCode: 'NOT_FOUND' }], { status: 404 });
      if (init.method === 'DELETE') { org.tasks.delete(t.Id); return new Response(null, { status: 204 }); }
      Object.assign(t, body, body.Status ? { IsClosed: body.Status === 'Completed' } : {});
      return new Response(null, { status: 204 });
    }
    throw new Error('Unexpected Salesforce call ' + path);
  };
  return org;
}
const SF = { SF_DOMAIN: 'https://sf.example', SF_CLIENT_ID: 'id', SF_CLIENT_SECRET: 'secret', SF_TASK_OWNER_ID: ERIC_USER, SF_TASK_SYNC_HOST: 'hub.positivetribes.org' };

test('adding a step that is already open reuses it, moving its due date and its Task', async () => {
  const org = fakeOrg();
  const { db, sqlite } = database();
  const first = (await call(db, 'POST', '/api/admin/steps', { accountId: UEP, title: 'Follow up: Golden High School', dueDate: '2026-11-08' }, { env: SF })).body;
  const again = await call(db, 'POST', '/api/admin/steps', { accountId: UEP, title: 'follow up: golden high school', dueDate: '2026-11-15' }, { env: SF });
  assert.equal(again.status, 200);
  assert.deepEqual([again.body.id, again.body.existing], [first.id, true]);
  assert.deepEqual(sqlite.prepare('SELECT due_date FROM next_steps').all().map(r => r.due_date), ['2026-11-15']);
  assert.equal(org.tasks.size, 1);
  assert.equal([...org.tasks.values()][0].ActivityDate, '2026-11-15');
  // Another client, or a step that is already done, still gets its own.
  assert.equal((await call(db, 'POST', '/api/admin/steps', { accountId: SAFE, title: 'Follow up: Golden High School' }, { env: SF })).status, 201);
  await call(db, 'PATCH', `/api/admin/steps/${first.id}`, { status: 'done' }, { env: SF });
  assert.equal((await call(db, 'POST', '/api/admin/steps', { accountId: UEP, title: 'Follow up: Golden High School' }, { env: SF })).status, 201);
  fakeSalesforce = null;
});

test('a preview on another host never writes Salesforce Tasks', async () => {
  const org = fakeOrg();
  const { db } = database();
  const r = await call(db, 'POST', '/api/admin/steps', { accountId: UEP, title: 'Preview step' }, { env: { ...SF, SF_TASK_SYNC_HOST: 'other.example' } });
  assert.equal(r.body.salesforce, 'off');
  assert.equal(org.tasks.size, 0);
  fakeSalesforce = null;
});

test('a step added in the hub becomes a Salesforce Task, and finishing or removing it follows', async () => {
  const org = fakeOrg();
  const { db, sqlite } = database();
  const step = (await call(db, 'POST', '/api/admin/steps', { accountId: UEP, title: 'Send revised scope', dueDate: '2026-11-04' }, { env: SF })).body;
  assert.equal(step.salesforce, 'ok');
  const taskId = sqlite.prepare('SELECT sf_task_id FROM next_steps WHERE id = ?').get(step.id).sf_task_id;
  assert.deepEqual(['Subject', 'ActivityDate', 'WhatId', 'Status', 'OwnerId'].map(k => org.tasks.get(taskId)[k]), ['Send revised scope', '2026-11-04', UEP_OPP, 'Not Started', ERIC_USER]);

  await call(db, 'PATCH', `/api/admin/steps/${step.id}`, { status: 'done' }, { env: SF });
  assert.equal(org.tasks.get(taskId).Status, 'Completed');

  const other = (await call(db, 'POST', '/api/admin/steps', { accountId: UEP, title: 'Drop this' }, { env: SF })).body;
  const otherTask = sqlite.prepare('SELECT sf_task_id FROM next_steps WHERE id = ?').get(other.id).sf_task_id;
  await call(db, 'PATCH', `/api/admin/steps/${other.id}`, { status: 'dismissed' }, { env: SF });
  assert.equal(org.tasks.has(otherTask), false);
  fakeSalesforce = null;
});

test('the client page brings in open Tasks and follows what changed in Salesforce', async () => {
  const org = fakeOrg();
  const { db, sqlite } = database();
  org.task('00TGLENN0000001', { Subject: 'Draft close-call talking points', OwnerId: GLENN_USER, Owner: { Name: 'Glenn Hadley' } });
  org.task('00TMAIL00000001', { Subject: 'Email: Hello', IsClosed: true });
  org.task('00TOPEN00000001', { Subject: 'Quote the fundraising pages', ActivityDate: '2026-11-04' });
  const page = async () => (await call(db, 'GET', `/api/admin/clients/${UEP}`, undefined, { env: SF })).body;

  let view = await page();
  assert.deepEqual(view.steps.map(s => [s.title, s.owner]), [['Quote the fundraising pages', ''], ['Draft close-call talking points', 'Glenn Hadley']]);
  assert.ok(view.steps.every(s => s.url.endsWith('/view')), 'each step links to its Task');
  assert.equal([...view.future, ...view.past].filter(i => i.type === 'task').length, 0, 'a Task that is a step shows once');
  assert.equal([...view.future, ...view.past].filter(i => i.type === 'email').length, 1);

  // Closed and deleted in Salesforce; a suggestion stays in the hub; a step saved while Salesforce was down catches up.
  org.tasks.get('00TOPEN00000001').IsClosed = true;
  org.tasks.delete('00TGLENN0000001');
  org.failWrites = true;
  assert.equal((await call(db, 'POST', '/api/admin/steps', { accountId: UEP, title: 'Call Molly' }, { env: SF })).body.salesforce, 'error');
  org.failWrites = false;
  sqlite.prepare("INSERT INTO next_steps (account_id, title, source, external_id) VALUES (?, 'Suggested idea', 'claude', 'x:1')").run(UEP);
  view = await page();
  assert.deepEqual(view.steps.map(s => s.title).sort(), ['Call Molly', 'Suggested idea']);
  assert.deepEqual(sqlite.prepare('SELECT title, status FROM next_steps WHERE sf_task_id LIKE ? ORDER BY title').all('00T%').map(r => [r.title, r.status]),
    [['Call Molly', 'open'], ['Draft close-call talking points', 'dismissed'], ['Quote the fundraising pages', 'done']]);
  assert.equal([...org.tasks.values()].filter(t => t.Subject === 'Suggested idea').length, 0, 'suggestions stay in the hub');

  // Keeping a suggestion sends it; a second load creates nothing new.
  const idea = sqlite.prepare("SELECT id FROM next_steps WHERE title = 'Suggested idea'").get().id;
  await call(db, 'PATCH', `/api/admin/steps/${idea}`, { keep: true }, { env: SF });
  const count = org.tasks.size;
  await page();
  assert.equal(org.tasks.size, count);
  assert.equal([...org.tasks.values()].filter(t => t.Subject === 'Suggested idea').length, 1);
  fakeSalesforce = null;
});
