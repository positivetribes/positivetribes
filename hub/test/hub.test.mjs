import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker, { windowEnd } from '../src/index.js';
import { database } from './helpers.mjs';

function setup() {
  const { sqlite, db } = database();
  for (const file of ['0001_init.sql', '0002_legacy_ids.sql', '0003_releases.sql', '0004_release_url.sql', '0005_release_script.sql', '0006_release_window.sql']) sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  sqlite.exec(`
    INSERT INTO clients (slug, name) VALUES ('uep', 'UEP'), ('safe', 'Sober AF');
    INSERT INTO projects (client_id, slug, name) VALUES (1, 'scheduler', 'Scheduler'), (1, 'fundraising', 'Fundraising'), (2, 'chapters', 'Chapters');
    INSERT INTO users (email, name, role, client_id) VALUES
      ('molly@uep.org', 'Molly', 'ed', 1), ('eric@positivetribes.org', 'Eric', 'pt', NULL), ('dana@safe.org', 'Dana', 'ed', 2);
  `);
  const env = { DB: db, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') } };
  const call = (who, path, method = 'GET', payload) => worker.fetch(new Request('http://localhost' + path, {
    method,
    headers: { ...(who ? { 'x-dev-email': who } : {}), 'content-type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined
  }), env);
  return { sqlite, call };
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
  const p = await (await call('molly@uep.org', '/api/c/uep/projects')).json();
  assert.equal(p.releases[0].uat_due, '2026-11-29');
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
