import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { windowEnd } from '../src/index.js';
import { database } from './helpers.mjs';

function setup() {
  const { sqlite, db } = database();
  for (const file of ['0001_init.sql', '0002_legacy_ids.sql', '0003_releases.sql', '0004_release_url.sql', '0005_release_script.sql', '0006_release_window.sql', '0007_project_live_url.sql', '0008_documents.sql', '0009_hub_ideas.sql', '0010_hub_idea_images.sql', '0011_documents_for_everyone.sql', '0012_notifications.sql', '0013_notification_clear.sql', '0014_last_seen.sql', '0015_care_plans.sql', '0016_patch_triage.sql', '0017_document_date.sql', '0018_client_salesforce_url.sql', '0019_project_has_prototype.sql', '0020_client_logo.sql', '0021_client_logo_soberaf.sql', '0022_project_next_note.sql', '0023_item_status.sql', '0024_patch_replies.sql', '0025_item_releases.sql', '0026_change_estimates.sql', '0027_donated_changes.sql', '0028_estimate_lines.sql']) sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  sqlite.exec(`
    INSERT INTO clients (slug, name) VALUES ('uep', 'UEP'), ('safe', 'Sober AF');
    INSERT INTO projects (client_id, slug, name) VALUES (1, 'scheduler', 'Scheduler'), (1, 'fundraising', 'Fundraising'), (2, 'chapters', 'Chapters');
    INSERT INTO users (email, name, role, client_id) VALUES
      ('molly@uep.org', 'Molly', 'ed', 1), ('eric@positivetribes.org', 'Eric', 'pt', NULL), ('dana@safe.org', 'Dana', 'ed', 2);
  `);
  const env = { DB: db, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') } };
  const call = (who, path, method = 'GET', payload) => worker.fetch(new Request('http://localhost' + path, {
    method,
    headers: { ...(who ? { 'x-dev-email': who } : {}), 'content-type': 'application/json', ...(method !== 'GET' ? { origin: 'http://localhost' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined
  }), env);
  return { sqlite, call, env };
}

test('requires sign in and an invitation', async () => {
  const { call } = setup();
  assert.equal((await call(null, '/api/me')).status, 401);
  assert.equal((await call('stranger@x.org', '/api/me')).status, 403);
  const me = await (await call('molly@uep.org', '/api/me')).json();
  assert.deepEqual(me.clients.map(c => c.slug), ['uep']);
  const pt = await (await call('eric@positivetribes.org', '/api/me')).json();
  assert.deepEqual(pt.clients.map(c => c.slug), ['safe', 'uep']);
});

test('only Positive Tribes can list a client\'s people, for previewing as them', async () => {
  const { call, sqlite } = setup();
  sqlite.exec("INSERT INTO users (email, name, role, client_id) VALUES ('sam@uep.org', 'Sam', 'staff', 1)");
  const r = await call('eric@positivetribes.org', '/api/c/uep/people');
  assert.equal(r.status, 200);
  // Directors first; only this client's people; Positive Tribes itself is not listed.
  assert.deepEqual((await r.json()).people, [{ email: 'molly@uep.org', name: 'Molly', role: 'ed', decides: true }, { email: 'sam@uep.org', name: 'Sam', role: 'staff', decides: false }]);
  assert.deepEqual((await (await call('eric@positivetribes.org', '/api/c/safe/people')).json()).people.map(p => p.email), ['dana@safe.org']);
  assert.equal((await call('molly@uep.org', '/api/c/uep/people')).status, 404);
  assert.equal((await call('sam@uep.org', '/api/c/uep/people')).status, 404);
  assert.equal((await call('dana@safe.org', '/api/c/uep/people')).status, 404);
  assert.equal((await call('eric@positivetribes.org', '/api/c/uep/people', 'POST', {})).status, 404);
});

test('documents: clients see their own shown documents; Positive Tribes sees hidden ones too', async () => {
  const { call, sqlite } = setup();
  sqlite.exec(`
    INSERT INTO documents (client_id, project_id, title, url, status, visible, position) VALUES
      (1, 1, 'Scheduler proposal', 'https://docs.example/signed', 'signed', 1, 1),
      (1, 2, 'Fundraising proposal', 'https://docs.example/draft', 'draft', 0, 2),
      (2, 3, 'Sober AF proposal', '', '', 1, 1);
  `);
  const molly = await (await call('molly@uep.org', '/api/c/uep/projects')).json();
  assert.deepEqual(molly.documents.map(d => [d.title, d.status, d.visible]), [['Scheduler proposal', 'signed', true]]);
  const eric = await (await call('eric@positivetribes.org', '/api/c/uep/projects')).json();
  assert.deepEqual(eric.documents.map(d => [d.title, d.visible]), [['Fundraising proposal', false], ['Scheduler proposal', true]]); // newest first
  // Another client's documents never leak.
  assert.equal((await call('dana@safe.org', '/api/c/uep/projects')).status, 404);
  assert.deepEqual((await (await call('dana@safe.org', '/api/c/safe/projects')).json()).documents.map(d => d.title), ['Sober AF proposal']);
});

test('hub ideas: everyone suggests, clients see only their own, only Positive Tribes decides', async () => {
  const { call, sqlite } = setup();
  sqlite.exec("INSERT INTO users (email, name, role, client_id) VALUES ('sam@uep.org', 'Sam', 'staff', 1)");
  const add = (who, title, tier) => call(who, '/api/ideas', 'POST', { title, tier });
  assert.equal((await add('molly@uep.org', 'Email me when a phase is ready', 'must')).status, 201);
  await add('dana@safe.org', 'Dark mode logo', 'idea');
  await add('eric@positivetribes.org', 'Weekly update page', 'nice');
  const ideas = async who => (await (await call(who, '/api/ideas')).json()).ideas;
  // Staff see their organization's ideas; nobody sees another client's.
  assert.deepEqual((await ideas('sam@uep.org')).map(i => i.title), ['Email me when a phase is ready']);
  assert.deepEqual((await ideas('dana@safe.org')).map(i => i.title), ['Dark mode logo']);
  const all = await ideas('eric@positivetribes.org');
  assert.deepEqual(all.map(i => [i.title, i.client_name, i.status]), [
    ['Email me when a phase is ready', 'UEP', 'new'], ['Weekly update page', 'Positive Tribes', 'new'], ['Dark mode logo', 'Sober AF', 'new']]);
  // Clients may reword while new, but cannot decide, and cannot reach another client's idea.
  assert.equal((await call('molly@uep.org', '/api/ideas/1', 'PATCH', { details: 'A short email' })).status, 200);
  assert.equal((await call('molly@uep.org', '/api/ideas/1', 'PATCH', { status: 'next' })).status, 403);
  assert.equal((await call('dana@safe.org', '/api/ideas/1', 'PATCH', { title: 'x' })).status, 404);
  assert.equal((await call('molly@uep.org', '/api/ideas/1', 'DELETE')).status, 403);
  // Positive Tribes picks it for the next build and replies; then the client can no longer edit it.
  const r = await (await call('eric@positivetribes.org', '/api/ideas/1', 'PATCH', { status: 'next', note: 'In the next hub build.' })).json();
  assert.deepEqual([r.ideas[0].status, r.ideas[0].note, r.ideas[0].details], ['next', 'In the next hub build.', 'A short email']);
  assert.equal((await call('molly@uep.org', '/api/ideas/1', 'PATCH', { title: 'Changed' })).status, 403);
  const shipped = await (await call('eric@positivetribes.org', '/api/ideas/1', 'PATCH', { status: 'shipped' })).json();
  assert.ok(shipped.ideas[0].shipped_at);
  assert.equal((await call('eric@positivetribes.org', '/api/ideas/1', 'PATCH', { status: 'maybe' })).status, 400);
  assert.equal((await call('eric@positivetribes.org', '/api/ideas/2', 'DELETE')).status, 200);
  assert.equal((await ideas('dana@safe.org')).length, 0);
});

test('hub idea screenshots: real images only, same visibility as the idea, locked once reviewed', async () => {
  const { call, env } = setup();
  const post = (who, path, bytes) => worker.fetch(new Request('http://localhost' + path, { method: 'POST', headers: { 'x-dev-email': who, 'content-type': 'image/png', origin: 'http://localhost' }, body: bytes }), env);
  const created = await (await call('molly@uep.org', '/api/ideas', 'POST', { title: 'Bigger buttons' })).json();
  assert.equal(created.id, 1);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const r = await post('molly@uep.org', '/api/ideas/1/images', png);
  assert.equal(r.status, 201);
  assert.deepEqual((await r.json()).ideas[0].images, [1]);
  // Not an image, even if it says it is.
  assert.equal((await post('molly@uep.org', '/api/ideas/1/images', new TextEncoder().encode('<script>alert(1)</script>'))).status, 400);
  assert.equal((await post('molly@uep.org', '/api/ideas/1/images', new Uint8Array(1500001))).status, 413);
  // The image comes back with its checked type; another client cannot fetch or add one.
  const got = await call('molly@uep.org', '/api/ideas/1/images/1');
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), png);
  assert.equal((await call('eric@positivetribes.org', '/api/ideas/1/images/1')).status, 200);
  assert.equal((await call('dana@safe.org', '/api/ideas/1/images/1')).status, 404);
  assert.equal((await post('dana@safe.org', '/api/ideas/1/images', png)).status, 404);
  // At most four.
  for (let n = 0; n < 3; n++) await post('molly@uep.org', '/api/ideas/1/images', png);
  assert.equal((await post('molly@uep.org', '/api/ideas/1/images', png)).status, 400);
  // Once reviewed, the client can no longer add or remove; Positive Tribes still can, and deleting the idea removes them.
  await call('eric@positivetribes.org', '/api/ideas/1', 'PATCH', { status: 'later' });
  assert.equal((await call('molly@uep.org', '/api/ideas/1/images/1', 'DELETE')).status, 403);
  assert.equal((await call('eric@positivetribes.org', '/api/ideas/1/images/1', 'DELETE')).status, 200);
  assert.equal((await call('eric@positivetribes.org', '/api/ideas/1', 'DELETE')).status, 200);
  assert.equal((await call('eric@positivetribes.org', '/api/ideas/1/images/2')).status, 404);
});

test('clients cannot see or touch another client', async () => {
  const { call } = setup();
  const add = await call('molly@uep.org', '/api/c/uep/items', 'POST', { title: 'Waitlist rules', kind: 'question', tier: 'must', project_id: 1 });
  assert.equal(add.status, 201);
  assert.equal((await call('dana@safe.org', '/api/c/uep/items')).status, 404);
  assert.equal((await call('dana@safe.org', '/api/c/uep/items/1', 'PATCH', { done: true })).status, 404);
  // Cannot file into another client's list, even while in your own workspace.
  assert.equal((await call('dana@safe.org', '/api/c/safe/items', 'POST', { title: 'x', project_id: 1 })).status, 400);
  const own = await (await call('dana@safe.org', '/api/c/safe/items')).json();
  assert.equal(own.items.length, 0);
  const pt = await (await call('eric@positivetribes.org', '/api/c/uep/items')).json();
  assert.equal(pt.items.length, 1);
});

test('add, answer, move, done and delete are logged with the real person', async () => {
  const { call, sqlite } = setup();
  for (const title of ['A', 'B']) await call('molly@uep.org', '/api/c/uep/items', 'POST', { title, tier: 'must', project_id: 1 });
  let r = await (await call('molly@uep.org', '/api/c/uep/items/2/move', 'POST', { direction: 'up' })).json();
  assert.deepEqual(r.items.map(i => i.title), ['B', 'A']);
  r = await (await call('molly@uep.org', '/api/c/uep/items/1', 'PATCH', { answer: 'Both email and text' })).json();
  assert.equal(r.items.find(i => i.id === 1).answer, 'Both email and text');
  await call('molly@uep.org', '/api/c/uep/items/1', 'PATCH', { done: true });
  assert.equal((await call('molly@uep.org', '/api/c/uep/items/1', 'DELETE')).status, 403);
  assert.equal((await call('eric@positivetribes.org', '/api/c/uep/items/1', 'DELETE')).status, 200);
  const events = sqlite.prepare('SELECT action, actor_email, actor_name FROM events ORDER BY id').all();
  assert.deepEqual(events.map(e => e.action), ['added', 'added', 'answered', 'done', 'deleted']);
  assert.equal(events[2].actor_email, 'molly@uep.org');
  assert.equal(events[4].actor_name, 'Eric');
});

test('rejects bad input and unknown routes; assets pass through', async () => {
  const { call } = setup();
  assert.equal((await call('molly@uep.org', '/api/c/uep/items', 'POST', { title: '', project_id: 1 })).status, 400);
  assert.equal((await call('molly@uep.org', '/api/c/uep/items', 'POST', { title: 'x', tier: 'huge', project_id: 1 })).status, 400);
  assert.equal((await call('molly@uep.org', '/api/c/uep/items/999', 'PATCH', { done: true })).status, 404);
  assert.equal((await call('molly@uep.org', '/api/nope')).status, 404);
  const asset = await worker.fetch(new Request('http://localhost/'), { ASSETS: { fetch: () => new Response('asset') } });
  assert.equal(await asset.text(), 'asset');
});

test('phases: 30-day testing window, sign-off starts the next phase', async () => {
  const { call, sqlite } = setup();
  sqlite.exec(`
    INSERT INTO users (email, name, role, client_id) VALUES ('sam@uep.org', 'Sam', 'staff', 1);
    INSERT INTO releases (client_id, project_id, number, stage, uat_started) VALUES (1, 1, 1, 'uat', '2026-10-30');
    INSERT INTO releases (client_id, project_id, number, stage) VALUES (1, 1, 2, 'waiting');
  `);
  sqlite.exec("UPDATE projects SET live_url = 'https://app.example/' WHERE id = 1");
  const p = await (await call('molly@uep.org', '/api/c/uep/projects')).json();
  assert.equal(p.releases[0].uat_due, '2026-11-29');
  // The production address travels with the project; the page shows it only once the project is live.
  assert.equal(p.projects.find(x => x.id === 1).live_url, 'https://app.example/');
  assert.equal((await call('dana@safe.org', '/api/c/uep/releases/1/signoff', 'POST', {})).status, 404);
  assert.equal((await call('sam@uep.org', '/api/c/uep/releases/1/signoff', 'POST', {})).status, 403);
  // A problem that stops sign-off blocks it until fixed.
  await call('molly@uep.org', '/api/c/uep/items', 'POST', { title: 'Save fails', kind: 'problem', tier: 'must', project_id: 1 });
  assert.equal((await call('molly@uep.org', '/api/c/uep/releases/1/signoff', 'POST', {})).status, 400);
  await call('molly@uep.org', '/api/c/uep/items/1', 'PATCH', { done: true });
  const r = await (await call('molly@uep.org', '/api/c/uep/releases/1/signoff', 'POST', {})).json();
  assert.equal(r.releases[0].stage, 'signed_off');
  assert.equal(r.releases[0].signed_off_by, 'Molly');
  assert.equal(r.releases[1].stage, 'uat');
  assert.equal(r.releases[1].uat_started, new Date().toISOString().slice(0, 10));
  assert.equal((await call('molly@uep.org', '/api/c/uep/releases/1/signoff', 'POST', {})).status, 400);
  const last = sqlite.prepare('SELECT action, item_title, detail FROM events ORDER BY id DESC LIMIT 1').get();
  assert.deepEqual({ ...last }, { action: 'signed_off', item_title: 'Phase 1', detail: 'Phase 2 starts testing' });
});

test('testing windows count calendar or business days', () => {
  assert.equal(windowEnd('2026-10-30', 30, 'calendar'), '2026-11-29');
  // UEP Phase 1: ready Friday Oct 30, accepted 10 business days later.
  assert.equal(windowEnd('2026-10-30', 10, 'business'), '2026-11-13');
  assert.equal(windowEnd('2026-11-07', 1, 'business'), '2026-11-09');
});

test('bell: a client hears what others did for them, never their own changes or another client\'s', async () => {
  const { call, sqlite } = setup();
  sqlite.exec("INSERT INTO users (email, name, role, client_id) VALUES ('sam@uep.org', 'Sam', 'staff', 1)");
  const bell = async who => (await call(who, '/api/notifications')).json();
  // Molly asks a question and adds her own change: neither is news to Molly.
  await call('molly@uep.org', '/api/c/uep/items', 'POST', { title: 'Who books rides?', kind: 'question', tier: 'must', project_id: 1 });
  await call('molly@uep.org', '/api/c/uep/items', 'POST', { title: 'Bigger font', kind: 'change', tier: 'nice', project_id: 1 });
  let b = await bell('molly@uep.org');
  assert.equal(b.unread, 0);
  // Sam sees the question, but a teammate's own change is left out.
  b = await bell('sam@uep.org');
  assert.deepEqual(b.items.map(i => [i.action, i.title]), [['added', 'Who books rides?']]);
  // Eric answers and finishes; edits and priority changes are not news.
  await call('eric@positivetribes.org', '/api/c/uep/items/1', 'PATCH', { answer: 'The volunteers' });
  await call('eric@positivetribes.org', '/api/c/uep/items/2', 'PATCH', { title: 'Bigger fonts' });
  await call('eric@positivetribes.org', '/api/c/uep/items/2', 'PATCH', { tier: 'must' });
  await call('eric@positivetribes.org', '/api/c/uep/items/2', 'PATCH', { done: true });
  b = await bell('molly@uep.org');
  assert.deepEqual(b.items.map(i => [i.action, i.title, i.fromPt, i.url]), [['done', 'Bigger fonts', true, '#/uep/backlog/2'], ['answered', 'Who books rides?', true, '#/uep/backlog/1']]);
  assert.equal(b.unread, 2);
  // Another client never sees it, and Positive Tribes' bell is the Inbox.
  assert.equal((await bell('dana@safe.org')).items.length, 0);
  assert.equal((await call('eric@positivetribes.org', '/api/notifications')).status, 404);

  // Reading is per person, and only within one's own client.
  const doneId = b.items[0].id;
  assert.equal((await call('molly@uep.org', '/api/notifications/read', 'POST', { ids: ['x'] })).status, 400);
  b = await (await call('molly@uep.org', '/api/notifications/read', 'POST', { ids: [doneId] })).json();
  assert.equal(b.unread, 1);
  await call('dana@safe.org', '/api/notifications/read', 'POST', { ids: [doneId] });
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM notification_reads WHERE user_id = 3').get().n, 0);
  assert.equal((await bell('sam@uep.org')).unread, 3);
  b = await (await call('molly@uep.org', '/api/notifications/read', 'POST', { all: true })).json();
  assert.equal(b.unread, 0);

  // Eric previews Sam's bell without marking anything; clients cannot.
  const preview = await (await call('eric@positivetribes.org', '/api/c/uep/notifications?as=sam@uep.org')).json();
  assert.equal(preview.unread, 3);
  assert.equal((await call('eric@positivetribes.org', '/api/c/uep/notifications?as=dana@safe.org')).status, 404);
  assert.equal((await call('molly@uep.org', '/api/c/uep/notifications?as=sam@uep.org')).status, 404);
});

test('bell: phases, documents and idea decisions notify, even when changed by hand in SQL', async () => {
  const { call, sqlite } = setup();
  const today = new Date().toISOString().slice(0, 10);
  sqlite.exec(`
    INSERT INTO releases (client_id, project_id, number, name, stage) VALUES (1, 1, 1, '', 'building');
    UPDATE releases SET stage = 'uat', uat_started = '${today}', uat_days = 2 WHERE id = 1;
    INSERT INTO documents (client_id, kind, title, url, visible) VALUES (1, 'proposal', 'Draft', 'https://x', 0), (NULL, 'plan', 'PT plan', 'https://y', 1);
    UPDATE documents SET visible = 1 WHERE id = 1;
  `);
  await call('molly@uep.org', '/api/ideas', 'POST', { title: 'Dark mode' });
  await call('eric@positivetribes.org', '/api/ideas', 'POST', { title: 'PT idea' });
  await call('eric@positivetribes.org', '/api/ideas/1', 'PATCH', { status: 'shipped', note: 'Done, try the toggle' });
  await call('eric@positivetribes.org', '/api/ideas/2', 'PATCH', { status: 'next' });
  await call('molly@uep.org', '/api/c/uep/items', 'POST', { title: 'Open question', kind: 'question', tier: 'must', project_id: 1 });
  const b = await (await call('molly@uep.org', '/api/notifications')).json();
  assert.deepEqual(b.items.map(i => [i.action, i.kind, i.title, i.url]), [
    ['idea_status', 'idea', 'Dark mode', '#/uep/ideas'],
    ['shared', 'document', 'Draft', '#/uep/home'],
    ['uat_started', 'release', 'Phase 1', '#/uep/home']
  ]);
  assert.equal(b.items[0].detail, 'Shipped: Done, try the toggle');
  assert.deepEqual(b.reminders.map(r => [r.type, r.daysLeft ?? r.count]), [['testing_ends', 2], ['questions', 1]]);
  // Sober AF hears nothing of it.
  assert.equal((await (await call('dana@safe.org', '/api/notifications')).json()).items.length, 0);
});

test('bell: phase moves only on the client\'s own suggestions, history before launch is hidden, clear all empties it', async () => {
  const { call, sqlite } = setup();
  await call('molly@uep.org', '/api/c/uep/items', 'POST', { title: 'Molly idea', kind: 'change', tier: 'nice', project_id: 1 });
  await call('eric@positivetribes.org', '/api/c/uep/items', 'POST', { title: 'Eric idea', kind: 'change', tier: 'nice', project_id: 1 });
  await call('eric@positivetribes.org', '/api/c/uep/items/1', 'PATCH', { phase: 'full' });
  await call('eric@positivetribes.org', '/api/c/uep/items/2', 'PATCH', { phase: 'later' });
  // An event imported from before the bell went live never shows.
  sqlite.exec("INSERT INTO events (client_id, item_id, action, item_title, item_kind, actor_name, at) VALUES (1, 1, 'answered', 'Old', 'question', 'Eric', '2026-10-30 09:58:11')");
  let b = await (await call('molly@uep.org', '/api/notifications')).json();
  assert.deepEqual(b.items.map(i => [i.action, i.title]), [['phase', 'Molly idea'], ['added', 'Eric idea']]);
  b = await (await call('molly@uep.org', '/api/notifications/clear', 'POST', { all: true })).json();
  assert.deepEqual([b.items.length, b.unread], [0, 0]);
  // New activity after a clear still arrives.
  await call('eric@positivetribes.org', '/api/c/uep/items/1', 'PATCH', { done: true });
  b = await (await call('molly@uep.org', '/api/notifications')).json();
  assert.deepEqual(b.items.map(i => [i.action, i.read]), [['done', false]]);
});

test('opening the hub records when each person was last seen', async () => {
  const { call, sqlite } = setup();
  const seen = () => sqlite.prepare("SELECT last_seen_at FROM users WHERE email = 'molly@uep.org'").get().last_seen_at;
  assert.equal(seen(), null);
  await call('molly@uep.org', '/api/me');
  assert.ok(seen());
  sqlite.exec("UPDATE users SET last_seen_at = '2026-10-01 00:00:00' WHERE email = 'molly@uep.org'");
  await call('molly@uep.org', '/api/notifications');
  assert.notEqual(seen(), '2026-10-01 00:00:00');
  // Within 10 minutes a second visit writes nothing.
  sqlite.exec("UPDATE users SET last_seen_at = datetime('now', '-5 minutes') WHERE email = 'molly@uep.org'");
  const before = seen();
  await call('molly@uep.org', '/api/me');
  assert.equal(seen(), before);
});

test('system status: scoped to the client, states only, safe when the status Worker is down', async () => {
  const { call, env } = setup();
  env.STATUS_URL = 'https://status.test';
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => {
    seen.push(String(url));
    return String(url).endsWith('/uep.json')
      ? new Response(JSON.stringify({ overall: 'up', checks: [{ name: 'Climb Scheduler', state: 'up', pct: 99.9, url: 'https://secret.example' }] }))
      : new Response('nope', { status: 404 });
  };
  try {
    const molly = await (await call('molly@uep.org', '/api/c/uep/status')).json();
    assert.deepEqual(molly, { checks: [{ name: 'Climb Scheduler', state: 'up', pct: 99.9 }], overall: 'up', page_url: 'https://status.test/uep' });
    // Another client's person cannot read it, and no outside request is made for them.
    assert.equal((await call('dana@safe.org', '/api/c/uep/status')).status, 404);
    assert.equal((await call(null, '/api/c/uep/status')).status, 401);
    // A client with no checks, then an unreachable status Worker: empty, never an error.
    assert.deepEqual((await (await call('dana@safe.org', '/api/c/safe/status')).json()).checks, []);
    globalThis.fetch = async () => { throw new Error('down'); };
    assert.deepEqual((await (await call('molly@uep.org', '/api/c/uep/status')).json()).checks, []);
    env.STATUS_URL = '';
    assert.deepEqual((await (await call('molly@uep.org', '/api/c/uep/status')).json()).checks, []);
  } finally { globalThis.fetch = realFetch; }
  assert.deepEqual(seen.filter(u => u.includes('safe') === false && u.includes('uep.json')).length, 1);
});

test('status: only Positive Tribes replies; not doing closes it, another pick or a reopen brings it back; the client hears it', async () => {
  const { call, sqlite } = setup();
  await call('molly@uep.org', '/api/c/uep/items', 'POST', { title: 'Bigger buttons', kind: 'change', tier: 'must', project_id: 1 });
  await call('molly@uep.org', '/api/c/uep/items', 'POST', { title: 'Dark mode', kind: 'change', tier: 'nice', project_id: 1 });
  await call('molly@uep.org', '/api/c/uep/items', 'POST', { title: 'Question', kind: 'question', project_id: 1 });
  let items = (await (await call('molly@uep.org', '/api/c/uep/items')).json()).items;
  assert.deepEqual(items.map(i => i.status), ['new', 'new', 'new']);
  // The client cannot set it, and kinds without a status refuse it.
  assert.equal((await call('molly@uep.org', '/api/c/uep/items/1', 'PATCH', { status: 'planned' })).status, 403);
  assert.equal((await call('eric@positivetribes.org', '/api/c/uep/items/3', 'PATCH', { status: 'planned' })).status, 400);
  assert.equal((await call('eric@positivetribes.org', '/api/c/uep/items/1', 'PATCH', { status: 'maybe' })).status, 400);
  await call('eric@positivetribes.org', '/api/c/uep/items/1', 'PATCH', { status: 'built' });
  await call('eric@positivetribes.org', '/api/c/uep/items/2', 'PATCH', { status: 'planned' });
  // Not doing closes it, with the reason logged as its own answered event.
  await call('eric@positivetribes.org', '/api/c/uep/items/1', 'PATCH', { status: 'declined', answer: 'Out of scope for now.' });
  const row = id => sqlite.prepare('SELECT status, done FROM items WHERE id = ?').get(id);
  assert.deepEqual({ ...row(1) }, { status: 'declined', done: 1 });
  // Picking another status reopens it; a plain reopen starts over as new.
  await call('eric@positivetribes.org', '/api/c/uep/items/1', 'PATCH', { status: 'planned' });
  assert.deepEqual({ ...row(1) }, { status: 'planned', done: 0 });
  await call('molly@uep.org', '/api/c/uep/items/1', 'PATCH', { done: true });
  await call('molly@uep.org', '/api/c/uep/items/1', 'PATCH', { done: false });
  assert.deepEqual({ ...row(1) }, { status: 'new', done: 0 });
  const bell = await (await call('molly@uep.org', '/api/notifications')).json();
  assert.deepEqual(bell.items.filter(i => i.action === 'status').map(i => [i.title, i.detail]),
    [['Bigger buttons', 'Planned'], ['Bigger buttons', 'Not doing'], ['Dark mode', 'On the wishlist'], ['Bigger buttons', 'Built, ready to test']]);
  assert.ok(bell.items.some(i => i.action === 'answered' && i.detail === 'Out of scope for now.'));
});


// ---- Items follow their release ----

function releaseSetup() {
  const s = setup();
  s.sqlite.exec(`
    INSERT INTO releases (client_id, project_id, number, stage, uat_started) VALUES (1, 1, 1, 'waiting', NULL), (1, 1, 2, 'waiting', NULL);
    INSERT INTO items (client_id, project_id, kind, title, tier, phase, status, done, position, added_by, release_id) VALUES
      (1, 1, 'change', 'planned in 1', 'must', 'full', 'planned', 0, 1, 'Molly', 1),
      (1, 1, 'change', 'planned in 2', 'must', 'full', 'planned', 0, 2, 'Molly', 2),
      (1, 1, 'change', 'new in 1', 'must', 'full', 'new', 0, 3, 'Molly', 1),
      (1, 1, 'change', 'not doing in 1', 'nice', 'full', 'declined', 1, 4, 'Molly', 1),
      (1, 1, 'change', 'planned, no release', 'must', 'full', 'planned', 0, 5, 'Molly', NULL),
      (1, 1, 'problem', 'fixing in 1', 'nice', 'full', 'planned', 0, 6, 'Molly', 1),
      (1, 1, 'change', 'Eric added', 'idea', 'full', 'planned', 0, 7, 'Eric', 1);
  `);
  const row = title => ({ ...s.sqlite.prepare('SELECT status, done FROM items WHERE title = ?').get(title) });
  return { ...s, row };
}

test('a release going to testing moves its Planned items to Built, and tells the client about their own', async () => {
  const { sqlite, row } = releaseSetup();
  sqlite.exec("UPDATE releases SET stage = 'uat', uat_started = date('now') WHERE id = 1");
  assert.deepEqual(row('planned in 1'), { status: 'built', done: 0 });
  assert.deepEqual(row('fixing in 1'), { status: 'built', done: 0 });
  assert.deepEqual(row('planned in 2'), { status: 'planned', done: 0 }, 'another release is untouched');
  assert.deepEqual(row('new in 1'), { status: 'new', done: 0 }, 'new stays new');
  assert.deepEqual(row('not doing in 1'), { status: 'declined', done: 1 }, 'not doing stays closed');
  assert.deepEqual(row('planned, no release'), { status: 'planned', done: 0 }, 'no release, no change');
  const events = sqlite.prepare("SELECT item_title, detail FROM events WHERE action = 'status' ORDER BY item_title").all().map(e => ({ ...e }));
  assert.deepEqual(events.map(e => e.item_title), ['Eric added', 'fixing in 1', 'planned in 1']);
  assert.equal(events.find(e => e.item_title === 'fixing in 1').detail, 'Fixed, ready to retest');
  // Moving the same release to testing again changes nothing more.
  sqlite.exec("UPDATE releases SET stage = 'waiting' WHERE id = 1; UPDATE releases SET stage = 'uat' WHERE id = 1;");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE action = 'status'").get().n, 3);
});

test('sign-off finishes the release\'s items, and the next phase starting moves its own', async () => {
  const { call, sqlite, row } = releaseSetup();
  sqlite.exec("UPDATE releases SET stage = 'uat', uat_started = date('now') WHERE id = 1");
  const r = await call('molly@uep.org', '/api/c/uep/releases/1/signoff', 'POST', {});
  assert.equal(r.status, 200, JSON.stringify(await r.clone().json()));
  assert.deepEqual(row('planned in 1'), { status: 'built', done: 1 });
  assert.deepEqual(row('fixing in 1'), { status: 'built', done: 1 });
  assert.deepEqual(row('new in 1'), { status: 'new', done: 0 });
  // Sign-off started Phase 2 testing in the same step, so its Planned item is now Built.
  assert.deepEqual(row('planned in 2'), { status: 'built', done: 0 });
});

test('a care request is never closed by a release', async () => {
  const { sqlite, row } = releaseSetup();
  sqlite.exec(`
    INSERT INTO care_plans (client_id, tier, monthly_credits, status, starts_on) VALUES (1, 'care', 6, 'setup', '2026-11-01');
    INSERT INTO care_requests (client_id, care_plan_id, item_id) SELECT 1, 1, id FROM items WHERE title = 'planned in 1';
  `);
  sqlite.exec("UPDATE releases SET stage = 'signed_off' WHERE id = 1");
  assert.deepEqual(row('planned in 1'), { status: 'planned', done: 0 });
  assert.deepEqual(row('fixing in 1'), { status: 'built', done: 1 });
});

test('only Positive Tribes tags an item with a phase, and only one on the item\'s own list', async () => {
  const { call, sqlite } = releaseSetup();
  sqlite.exec("INSERT INTO releases (client_id, project_id, number, stage) VALUES (1, 2, 1, 'waiting'), (2, 3, 1, 'waiting')");
  const id = sqlite.prepare("SELECT id FROM items WHERE title = 'planned, no release'").get().id;
  assert.equal((await call('molly@uep.org', `/api/c/uep/items/${id}`, 'PATCH', { release_id: 1 })).status, 403);
  assert.equal((await call('eric@positivetribes.org', `/api/c/uep/items/${id}`, 'PATCH', { release_id: 3 })).status, 400, 'another list');
  assert.equal((await call('eric@positivetribes.org', `/api/c/uep/items/${id}`, 'PATCH', { release_id: 4 })).status, 400, 'another client');
  const ok = await call('eric@positivetribes.org', `/api/c/uep/items/${id}`, 'PATCH', { release_id: 2 });
  assert.equal(ok.status, 200);
  const item = (await ok.json()).items.find(i => i.id === id);
  assert.equal(item.release_id, 2);
  assert.equal(item.release_number, 2);
  // Tagging is internal: it logs nothing for the client's bell.
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM events WHERE item_id = ?').get(id).n, 0);
  // Moving the item to another list clears the tag; clearing it by hand works too.
  await call('eric@positivetribes.org', `/api/c/uep/items/${id}`, 'PATCH', { project_id: 2 });
  assert.equal(sqlite.prepare('SELECT release_id FROM items WHERE id = ?').get(id).release_id, null);
  await call('eric@positivetribes.org', `/api/c/uep/items/${id}`, 'PATCH', { project_id: 1, release_id: 1 });
  await call('eric@positivetribes.org', `/api/c/uep/items/${id}`, 'PATCH', { release_id: null });
  assert.equal(sqlite.prepare('SELECT release_id FROM items WHERE id = ?').get(id).release_id, null);
});
