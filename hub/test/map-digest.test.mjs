// Map step 4: the Monday project digest (src/mapdigest.js): snapshot, week-over-week changes, drift, storage, run route.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { database } from './helpers.mjs';
import { weekOf, changesBetween, driftOf, snapshotOf, runMapDigest, latestMapDigest, DIGEST } from '../src/mapdigest.js';
import { loadMap } from '../src/map.js';

function setup() {
  const { sqlite, db } = database();
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  sqlite.exec(`
    INSERT INTO clients (slug, name, salesforce_account_id) VALUES ('uep', 'UEP', '001AAAAAAAAAAAAAAA');
    INSERT INTO projects (client_id, slug, name, phase, position) VALUES (1, 'scheduler', 'Scheduler', 'uat', 1);
    INSERT INTO users (email, name, role, client_id) VALUES ('molly@uep.org', 'Molly', 'ed', 1), ('eric@positivetribes.org', 'Eric', 'pt', NULL);
    INSERT INTO releases (client_id, project_id, number, stage) VALUES (1, 1, 3, 'uat');
    INSERT INTO timeline_entries (client_id, project_id, release_id, label, start_date, end_date, kind) VALUES (1, 1, 1, 'Phase 3 testing', '2026-11-15', '2026-12-20', 'work');
    INSERT INTO requirements (client_id, project_id, ref, text, phase, state, cited, position) VALUES (1, 1, 'R1', 'Roster', '3', 'agreed', 1, 1), (1, 1, 'R2', 'Report', '3', 'agreed', 0, 2);
    INSERT INTO requirement_syncs (client_id, project_id, file, branch, commit_sha, rows, synced_at) VALUES (1, 1, 'docs/requirements.md', 'phase-4', 'abc', 2, '2026-11-01 10:00:00');
    INSERT INTO dependencies (client_id, blocker_kind, blocker_ref, blocked_kind, blocked_ref, kind, label, needed_by) VALUES
      (1, 'sf_task', '00TAAAAAAAAAAAAAAA', 'timeline', '1', 'needs_input', 'Gym list', '2026-11-20');
  `);
  return { sqlite, db };
}

test('weekOf gives the Monday of the week', () => {
  assert.equal(weekOf('2026-11-23'), '2026-11-23'); // Monday
  assert.equal(weekOf('2026-11-22'), '2026-11-16'); // Sunday
  assert.equal(weekOf('2026-11-25'), '2026-11-23');
});

test('drift: stale requirements copy, and a past-due Task blocker Salesforce no longer reports', async () => {
  const { db } = setup();
  const today = '2026-11-23';
  const unknown = await loadMap(db, { today, taskStatus: new Map() });
  const drift = driftOf(unknown, today, true);
  assert.deepEqual(drift.map(d => d.kind).sort(), ['missing_task', 'stale_requirements']);
  assert.match(drift.find(d => d.kind === 'stale_requirements').text, /22 days ago/);
  // Salesforce down: every Task looks unknown, so no Task drift is claimed.
  assert.deepEqual(driftOf(await loadMap(db, { today, taskStatus: null }), today, false).map(d => d.kind), ['stale_requirements']);
  // A closed Task is not drift; a fresh sync is not stale.
  const closed = await loadMap(db, { today: '2026-11-05', taskStatus: new Map([['00TAAAAAAAAAAAA', { closed: true, due: null }]]) });
  assert.deepEqual(driftOf(closed, '2026-11-05', true), []);
  assert.equal(DIGEST.staleSyncDays, 7);
});

test('changes since last week: phase, progress, blockers, risks, decisions', async () => {
  const { sqlite, db } = setup();
  const sf = new Map([['00TAAAAAAAAAAAA', { closed: false, due: null }]]);
  const prev = snapshotOf(await loadMap(db, { today: '2026-11-16', taskStatus: sf }), '2026-11-16', true);
  assert.equal(changesBetween(null, prev), null);
  assert.deepEqual(changesBetween(prev, prev), []);
  sqlite.exec(`UPDATE requirements SET cited = 1 WHERE ref = 'R2';
    INSERT INTO decisions (client_id, project_id, decided_on, decided_by, summary, price_change) VALUES (1, 1, '2026-11-20', 'Molly', 'Roster 6 days out', 1);`);
  const done = new Map([['00TAAAAAAAAAAAA', { closed: true, due: null }]]);
  const cur = snapshotOf(await loadMap(db, { today: '2026-11-23', taskStatus: done }), '2026-11-23', true);
  const lines = changesBetween(prev, cur).map(c => c.text);
  assert.ok(lines.includes('Phase 3: 2/2 requirements built (was 1/2)'), lines.join(' | '));
  assert.ok(lines.includes('Blocker cleared: Gym list'));
  assert.ok(lines.some(l => /^Decided 2026-11-20: Roster 6 days out \(changes price\)$/.test(l)));
  // A new blocker, and a release moving on.
  sqlite.exec(`INSERT INTO dependencies (client_id, blocker_kind, blocker_ref, blocked_kind, blocked_ref, kind, label, needed_by) VALUES (1, 'release', '1', 'timeline', '1', 'blocks', 'Jack signs', '2026-12-01');
    UPDATE releases SET stage = 'signed_off';`);
  const later = snapshotOf(await loadMap(db, { today: '2026-11-30', taskStatus: done }), '2026-11-30', true);
  const more = changesBetween(cur, later).map(c => c.text);
  assert.ok(more.some(l => l.startsWith('Phase 3 is now signed off')), more.join(' | '));
});

test('runMapDigest saves one row a week, compares with the week before, records failures', async () => {
  const { sqlite, db } = setup();
  const env = { DB: db };
  const sf = async () => new Map([['00TAAAAAAAAAAAA', { closed: false, due: null }]]);
  assert.equal((await runMapDigest(env, '2026-11-16', { taskStatus: sf })).ran, true);
  let m = await latestMapDigest(db);
  assert.equal(m.week, '2026-11-16'); assert.equal(m.changes, null); assert.equal(m.projects, 1);
  sqlite.exec("UPDATE requirements SET cited = 1 WHERE ref = 'R2'");
  await runMapDigest(env, '2026-11-23', { taskStatus: sf });
  await runMapDigest(env, '2026-11-24', { taskStatus: sf }); // same week: replaces
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM map_snapshots').get().n, 2);
  m = await latestMapDigest(db);
  assert.equal(m.week, '2026-11-23');
  assert.ok(m.changes.some(c => c.text.startsWith('Phase 3: 2/2')));
  // Salesforce down: saved, flagged, no Task drift.
  await runMapDigest(env, '2026-11-25', { taskStatus: async () => null });
  m = await latestMapDigest(db);
  assert.equal(m.salesforceOk, false); assert.ok(!m.drift.some(d => d.kind === 'missing_task'));
  // A failure keeps the good save and records the error.
  const r = await runMapDigest(env, '2026-11-26', { taskStatus: async () => { throw new Error('boom'); } });
  assert.equal(r.ran, false);
  m = await latestMapDigest(db);
  assert.equal(m.error, 'boom'); assert.equal(m.projects, 1);
  // Old weeks are pruned.
  sqlite.exec("INSERT INTO map_snapshots (week_start, data_json) VALUES ('2025-01-06', '{}')");
  await runMapDigest(env, '2026-11-26', { taskStatus: sf });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM map_snapshots WHERE week_start = '2025-01-06'").get().n, 0);
});

test('Run now: Positive Tribes only', async () => {
  const { db } = setup();
  const env = { DB: db, ADMIN_DB: database().db, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') } };
  const call = async (who, origin = 'http://localhost') => {
    const r = await worker.fetch(new Request('http://localhost/api/admin/map/run', { method: 'POST', headers: { 'x-dev-email': who, 'content-type': 'application/json', origin }, body: '{}' }), env);
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await call('molly@uep.org')).status, 404);
  assert.equal((await call('eric@positivetribes.org', 'https://evil.example')).status, 403);
  const ok = await call('eric@positivetribes.org');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.ran, true);
  assert.equal(ok.body.mapDigest.projects, 1);
});
