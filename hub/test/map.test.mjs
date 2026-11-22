// Map steps 1 and 2: requirements parsing and status, the sync SQL, decisions and dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { database } from './helpers.mjs';
import { parseRequirements, hubRefs, phaseNumbers, statusOf } from '../src/requirements.js';
import { syncSql, readConfig } from '../scripts/requirements-sync.mjs';
import { decisionSql, dependencySql, end, parse } from '../scripts/map.mjs';

function setup() {
  const { sqlite, db } = database();
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  sqlite.exec(`
    INSERT INTO clients (slug, name) VALUES ('uep', 'UEP'), ('safe', 'Sober AF');
    INSERT INTO projects (client_id, slug, name, phase, position) VALUES (1, 'scheduler', 'Scheduler', 'uat', 1), (2, 'chapters', 'Chapters', 'prototype', 1);
    INSERT INTO users (email, name, role, client_id) VALUES ('molly@uep.org', 'Molly', 'ed', 1), ('eric@positivetribes.org', 'Eric', 'pt', NULL);
    INSERT INTO releases (client_id, project_id, number, stage, uat_started, uat_days, uat_day_type) VALUES
      (1, 1, 2, 'signed_off', '2026-11-04', 10, 'business'), (1, 1, 3, 'uat', '2026-11-15', 10, 'business');
    INSERT INTO timeline_entries (client_id, project_id, release_id, label, start_date, end_date, kind) VALUES
      (1, 1, 2, 'Phase 3 testing', '2026-11-15', '2026-11-27', 'work'), (1, 1, NULL, 'Pilot', '2027-01-11', '2027-01-29', 'work'), (2, 2, NULL, 'Chapters build', '2026-12-01', '2027-01-15', 'work');
    INSERT INTO items (client_id, project_id, kind, title, tier, phase, position, due_date) VALUES (1, 1, 'question', 'Gym list', 'must', 'full', 1, '2026-11-10'), (2, 2, 'question', 'Other client', 'must', 'full', 1, '');
  `);
  const env = { DB: db, ADMIN_DB: database().db, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') } };
  const call = async (who, path, method = 'GET', payload) => {
    const r = await worker.fetch(new Request('http://localhost/api/' + path, {
      method, headers: { 'x-dev-email': who, 'content-type': 'application/json', origin: 'http://localhost' },
      body: payload ? JSON.stringify(payload) : undefined
    }), env);
    return { status: r.status, body: await r.json() };
  };
  return { sqlite, call };
}
const ERIC = 'eric@positivetribes.org', MOLLY = 'molly@uep.org';

const SAMPLE = `# Requirements
### 1. Sign-in
| ID | Requirement | Source | Phase | v2 |
|---|---|---|---|---|
| R1 | One sign-in, **no passwords** | Molly (#76) | 2 | yes |
| R2 | Lead roster email | Hub #84, BL-63 | 3 | |
| R3 | Dropped: old idea | Eric | n/a | |
| R4 | Both phases | Proposal | 2, 3 | |
## Not in scope
| ID | Requirement | Source | Phase | v2 |
|---|---|---|---|---|
| R9 | Payroll | Molly | n/a | |
## Proposed, not decided
| Ref | Proposal | Notes | Phase | Hub |
|---|---|---|---|---|
| P5 | Text reminders | costs money | 4 | #12 |
| PF1 | Help desk | later | | |
P5 DECIDED Nov 18: yes
`;

test('the parser reads rows by header name and sets state from the section', () => {
  const rows = parseRequirements(SAMPLE, { prefix: 'R' });
  assert.deepEqual(rows.map(r => `${r.ref}:${r.state}`), ['R1:agreed', 'R2:agreed', 'R3:dropped', 'R4:agreed', 'R9:out_of_scope', 'P5:decided', 'PF1:proposed']);
  assert.equal(rows[0].text, 'One sign-in, no passwords');
  assert.equal(rows[0].section, '1. Sign-in');
  assert.equal(rows[1].hub_refs, '84,63');
  assert.equal(rows[5].text, 'Text reminders');
  assert.equal(rows[5].source, 'costs money');
  assert.throws(() => parseRequirements(SAMPLE + '| R1 | again | x | 1 | |\n'.replace(/^/, '\n| ID | Requirement |\n|---|---|\n')), /twice/);
  assert.deepEqual(hubRefs('Hub #125 and #125, BL-7'), [125, 7]);
  assert.deepEqual(phaseNumbers('1, 4'), [1, 4]);
  assert.deepEqual(phaseNumbers('W1'), []);
});

test('status comes from facts: phase signed off is accepted, cited is built', () => {
  const rel = [{ project_id: 1, number: 2, stage: 'signed_off' }, { project_id: 1, number: 3, stage: 'uat' }];
  assert.equal(statusOf({ project_id: 1, state: 'agreed', phase: '2', cited: 0 }, rel), 'accepted');
  assert.equal(statusOf({ project_id: 1, state: 'agreed', phase: '3', cited: 1 }, rel), 'built');
  assert.equal(statusOf({ project_id: 1, state: 'agreed', phase: '2, 3', cited: 0 }, rel), 'planned');
  assert.equal(statusOf({ project_id: 1, state: 'agreed', phase: 'Later', cited: 0 }, rel), 'planned');
  assert.equal(statusOf({ project_id: 1, state: 'dropped', phase: '2', cited: 1 }, rel), 'dropped');
});

test('a sync replaces the project rows, quotes text, and the admin route reads them back', async () => {
  const { sqlite, call } = setup();
  const rows = parseRequirements(SAMPLE, { prefix: 'R' }).map(r => ({ ...r, cited: r.ref === 'R2', in_uat: r.ref === 'R2' }));
  rows[0].text = "Molly's sign-in'); DROP TABLE items; --";
  sqlite.exec(syncSql({ client_id: 1, project_id: 1 }, rows, { file: 'docs/requirements.md', branch: 'phase-4', commit: 'abc123' }));
  assert.equal(sqlite.prepare('SELECT text FROM requirements WHERE ref = ?').get('R1').text, rows[0].text);
  assert.ok(sqlite.prepare('SELECT 1 FROM items').get());
  // A row taken out of the file goes; the rest stay with the same ids.
  const before = sqlite.prepare("SELECT id FROM requirements WHERE ref = 'R2'").get().id;
  sqlite.exec(syncSql({ client_id: 1, project_id: 1 }, rows.filter(r => r.ref !== 'R4'), { file: 'docs/requirements.md', branch: 'phase-4', commit: 'def456' }));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM requirements").get().n, 6);
  assert.equal(sqlite.prepare("SELECT id FROM requirements WHERE ref = 'R2'").get().id, before);

  const { status, body } = await call(ERIC, 'admin/requirements?client_id=1');
  assert.equal(status, 200);
  const p = body.projects[0];
  assert.equal(p.last_sync.commit_sha, 'def456');
  assert.equal(p.rows.find(r => r.ref === 'R1').status, 'accepted');
  assert.equal(p.rows.find(r => r.ref === 'R2').status, 'built');
  assert.deepEqual(p.phases['3'], { total: 1, built: 1, accepted: 0, in_uat: 1 });
  assert.equal((await call(ERIC, 'admin/requirements?client_id=x')).status, 400);
  assert.equal((await call(MOLLY, 'admin/requirements')).status, 404);
});

test('sync config is checked before anything runs', () => {
  assert.throws(() => readConfig('{"client":"uep","projects":[{"project":"s","file":"../x.md","prefix":"R"}]}'), /inside the repo/);
  assert.throws(() => readConfig('{"client":"UEP","projects":[]}'), /slug/);
  assert.equal(readConfig('{"client":"uep","projects":[{"project":"scheduler","file":"docs/requirements.md","prefix":"R"}]}').client, 'uep');
});

test('decisions: add, list, replace and delete, only for Positive Tribes and the right client', async () => {
  const { call } = setup();
  const one = await call(ERIC, 'admin/decisions', 'POST', { client_id: 1, project_id: 1, decided_on: '2026-11-18', decided_by: 'Molly', summary: 'Go live Jun 30', why: 'Signed date', affects: 'V16', price_change: false });
  assert.equal(one.status, 200);
  const two = await call(ERIC, 'admin/decisions', 'POST', { client_id: 1, decided_on: '2026-11-22', summary: 'Notice Aug 10', supersedes_id: one.body.id });
  assert.equal(two.status, 200);
  assert.equal((await call(ERIC, 'admin/decisions', 'POST', { client_id: 1, project_id: 2, decided_on: '2026-11-22', summary: 'x' })).status, 400);
  assert.equal((await call(ERIC, 'admin/decisions', 'POST', { client_id: 1, decided_on: '2026-02-30', summary: 'x' })).status, 400);
  assert.equal((await call(ERIC, 'admin/decisions', 'POST', { client_id: 2, decided_on: '2026-11-22', summary: 'x', supersedes_id: one.body.id })).status, 400);
  assert.equal((await call(MOLLY, 'admin/decisions')).status, 404);
  const list = (await call(ERIC, 'admin/decisions?client_id=1')).body.decisions;
  assert.deepEqual(list.map(d => d.summary), ['Notice Aug 10', 'Go live Jun 30']);
  assert.equal((await call(ERIC, `admin/decisions/${two.body.id}`, 'PUT', { decided_on: '2026-11-22', summary: 'x', supersedes_id: two.body.id })).status, 400);
  assert.equal((await call(ERIC, `admin/decisions/${one.body.id}`, 'DELETE')).status, 200);
  assert.equal((await call(ERIC, 'admin/decisions?client_id=1')).body.decisions[0].supersedes_id, null);
});

test('dependencies: ends must be this client\'s, late blockers mark the timeline bar', async () => {
  const { call } = setup();
  // The gym list question (due Nov 10, not answered) blocks the pilot bar: late.
  const late = await call(ERIC, 'admin/dependencies', 'POST', { client_id: 1, blocker_kind: 'item', blocker_ref: 1, blocked_kind: 'timeline', blocked_ref: 2, kind: 'needs_input' });
  assert.equal(late.status, 200);
  // Phase 2 (signed off) blocks the pilot: done, not waiting.
  assert.equal((await call(ERIC, 'admin/dependencies', 'POST', { client_id: 1, blocker_kind: 'release', blocker_ref: 1, blocked_kind: 'timeline', blocked_ref: 2 })).status, 200);
  // A Salesforce Task needs a label and a real Task Id.
  assert.equal((await call(ERIC, 'admin/dependencies', 'POST', { client_id: 1, blocker_kind: 'sf_task', blocker_ref: '00TPr000019BOJ6MAO', blocked_kind: 'release', blocked_ref: 2 })).status, 400);
  assert.equal((await call(ERIC, 'admin/dependencies', 'POST', { client_id: 1, blocker_kind: 'sf_task', blocker_ref: 'abc', blocked_kind: 'release', blocked_ref: 2, label: 'x' })).status, 400);
  assert.equal((await call(ERIC, 'admin/dependencies', 'POST', { client_id: 1, blocker_kind: 'sf_task', blocker_ref: '00TPr000019BOJ6MAO', blocked_kind: 'release', blocked_ref: 2, label: 'Resend key', needed_by: '2099-01-01' })).status, 200);
  // Another client's ends, a self-loop and a repeat are refused.
  assert.equal((await call(ERIC, 'admin/dependencies', 'POST', { client_id: 1, blocker_kind: 'item', blocker_ref: 2, blocked_kind: 'timeline', blocked_ref: 2 })).status, 400);
  assert.equal((await call(ERIC, 'admin/dependencies', 'POST', { client_id: 1, blocker_kind: 'timeline', blocker_ref: 3, blocked_kind: 'timeline', blocked_ref: 2 })).status, 400);
  assert.equal((await call(ERIC, 'admin/dependencies', 'POST', { client_id: 1, blocker_kind: 'timeline', blocker_ref: 2, blocked_kind: 'timeline', blocked_ref: 2 })).status, 400);
  assert.equal((await call(ERIC, 'admin/dependencies', 'POST', { client_id: 1, blocker_kind: 'item', blocker_ref: 1, blocked_kind: 'timeline', blocked_ref: 2 })).status, 400);
  assert.equal((await call(MOLLY, 'admin/dependencies')).status, 404);

  const deps = (await call(ERIC, 'admin/dependencies?client_id=1')).body.dependencies;
  assert.equal(deps.length, 3);
  const [gym, phase, task] = deps;
  assert.equal(gym.waiting, true); assert.equal(gym.late, true); assert.equal(gym.blocker.name, '#1 Gym list');
  assert.equal(phase.waiting, false); assert.equal(phase.late, false);
  assert.equal(task.blocker.done, null); assert.equal(task.late, false); assert.equal(task.blocker.name, 'Resend key');

  // The admin timeline carries each client's dependencies; Sober AF sees none of UEP's.
  const tl = (await call(ERIC, 'admin/timeline')).body.clients;
  assert.equal(tl.find(c => c.slug === 'uep').dependencies.length, 3);
  assert.equal(tl.find(c => c.slug === 'safe').dependencies.length, 0);
  // The client's own timeline does not.
  const own = await call(MOLLY, 'c/uep/projects');
  assert.equal(own.status, 200);
  assert.ok(own.body.timeline);
  assert.equal(JSON.stringify(own.body).includes('dependencies'), false);

  assert.equal((await call(ERIC, `admin/dependencies/${gym.id}`, 'DELETE')).status, 200);
  assert.equal((await call(ERIC, `admin/dependencies/${gym.id}`, 'DELETE')).status, 404);
});

test('the map CLI checks its input and quotes every value', () => {
  assert.throws(() => parse(['nope', 'uep']), /Command/);
  assert.deepEqual(parse(['decision', 'uep', '--on', '2026-11-22', '--price']).opts, { on: '2026-11-22', price: true });
  assert.throws(() => end('item:abc', '--blocker'), /not a valid/);
  assert.deepEqual(end('sf_task:00TPr000019BOJ6MAO', 'x'), { kind: 'sf_task', ref: '00TPr000019BOJ6MAO' });
  assert.match(decisionSql(1, null, { on: '2026-11-22', summary: "Eric's call" }), /'Eric''s call'/);
  assert.throws(() => decisionSql(1, null, { on: '2026-13-01', summary: 'x' }), /look like/);
  assert.throws(() => dependencySql(1, { kind: 'sf_task', ref: '00TPr000019BOJ6MAO' }, { kind: 'release', ref: '2' }, {}), /--label/);
  assert.throws(() => dependencySql(1, { kind: 'item', ref: '2' }, { kind: 'item', ref: '2' }, {}), /itself/);
});
