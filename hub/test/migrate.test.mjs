import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import uep from '../../uep-backlog/src/index.js';
import safe from '../../soberafe-backlog/src/index.js';
import { database } from './helpers.mjs';
import { buildMigrationSql } from '../scripts/migrate-backlog.mjs';

const hubDb = () => {
  const { sqlite } = database();
  for (const file of ['0001_init.sql', '0002_legacy_ids.sql']) sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  return sqlite;
};

// Drives the real old Worker so the test data has its true schema, seeds and event log.
async function oldBacklog(worker, extra) {
  const { sqlite, db } = database();
  const env = { DB: db, BACKLOG_PASSCODE: 'pw', ASSETS: {} };
  const call = (path, method = 'GET', body) => worker.fetch(new Request('http://x' + path, {
    method, body: body && JSON.stringify(body), headers: { 'x-backlog-passcode': 'pw', 'x-backlog-name': encodeURIComponent('Molly'), 'content-type': 'application/json' }
  }), env);
  await call('/api/items');
  for (const body of extra) await call('/api/items', 'POST', body);
  await call('/api/items/1', 'PATCH', { answer: 'Both', done: true });
  const doomed = (await (await call('/api/items', 'POST', { title: 'Delete me', kind: 'change' })).json()).items.find(i => i.title === 'Delete me');
  await call('/api/items/' + doomed.id, 'DELETE');
  return {
    items: sqlite.prepare('SELECT * FROM backlog_items ORDER BY id').all(),
    events: sqlite.prepare('SELECT * FROM backlog_events ORDER BY id').all()
  };
}

test('UEP backlog imports completely, split into its two projects, and is safe to re-run', async () => {
  const old = await oldBacklog(uep, [
    { title: 'Donate button', kind: 'change', area: 'fundraising', tier: 'must' },
    { title: 'Back loses site', kind: 'problem', tier: 'must', owner: 'Test 3' }
  ]);
  const sql = buildMigrationSql('uep', old, { users: [{ email: 'Molly@UEP.org', name: 'Molly', role: 'ed' }] });
  const hub = hubDb();
  hub.exec(sql);
  hub.exec(sql); // second run changes nothing
  const count = t => hub.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  assert.equal(count('items'), old.items.length);
  assert.equal(count('events'), old.events.length);
  assert.equal(count('clients'), 1);
  assert.equal(count('projects'), 2);
  assert.equal(hub.prepare("SELECT COUNT(*) n FROM items i JOIN projects p ON p.id = i.project_id WHERE p.slug = 'fundraising'").get().n, 1);
  const answered = hub.prepare("SELECT * FROM items WHERE legacy_id = 1").get();
  assert.equal(answered.answer, 'Both');
  assert.equal(answered.done, 1);
  assert.equal(answered.created_at, old.items[0].created_at);
  assert.ok(hub.prepare("SELECT 1 FROM users WHERE email = 'molly@uep.org' AND role = 'ed'").get());
  assert.ok(hub.prepare("SELECT 1 FROM users WHERE role = 'pt' AND client_id IS NULL").get());
  // Events point at the NEW item ids; the deleted item's events keep item_id 0.
  const viaEvent = hub.prepare("SELECT i.legacy_id FROM events e JOIN items i ON i.id = e.item_id WHERE e.action = 'answered'").get();
  assert.equal(viaEvent.legacy_id, 1);
  assert.ok(hub.prepare("SELECT 1 FROM events WHERE action = 'deleted' AND item_id = 0").get());
  assert.ok(hub.prepare("SELECT 1 FROM events WHERE actor_name = 'Molly'").get());
});

test('two clients with the same old ids do not collide, and Sober AF has one project', async () => {
  const a = await oldBacklog(uep, []);
  const b = await oldBacklog(safe, []);
  const hub = hubDb();
  hub.exec(buildMigrationSql('uep', a));
  hub.exec(buildMigrationSql('safe', b));
  assert.equal(hub.prepare('SELECT COUNT(*) n FROM items').get().n, a.items.length + b.items.length);
  assert.equal(hub.prepare("SELECT COUNT(*) n FROM items WHERE client_id = (SELECT id FROM clients WHERE slug = 'safe') AND legacy_id = 1").get().n, 1);
  assert.equal(hub.prepare("SELECT COUNT(*) n FROM projects WHERE client_id = (SELECT id FROM clients WHERE slug = 'safe')").get().n, 1);
});

test('refuses data it does not understand, and quotes awkward text safely', () => {
  const row = { id: 1, kind: 'change', title: "It's a \"test\"; DROP TABLE items;--", details: '', owner: '', answer: '', tier: 'must', phase: 'review', position: 1, done: 0, added_by: '', created_at: '2026-01-01 00:00:00' };
  const hub = hubDb();
  hub.exec(buildMigrationSql('safe', { items: [row] }));
  assert.equal(hub.prepare('SELECT title FROM items').get().title, row.title);
  assert.throws(() => buildMigrationSql('safe', { items: [{ ...row, tier: 'urgent' }] }), /unexpected value "urgent"/);
  assert.throws(() => buildMigrationSql('safe', { items: [{ ...row, kind: 'bug' }] }), /kind/);
  assert.throws(() => buildMigrationSql('uep', { items: [{ ...row, area: 'billing' }] }), /no hub project/);
  assert.throws(() => buildMigrationSql('nobody', { items: [] }), /Unknown client/);
});
