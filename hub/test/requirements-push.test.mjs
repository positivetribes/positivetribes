// POST /api/sync/requirements: client CI pushes its requirements file; one token per client, one route, nothing else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { database } from './helpers.mjs';
import { requirementTokens } from '../src/requirements.js';

const UEP_TOKEN = 'a'.repeat(32) + '.access', SAFE_TOKEN = 'b'.repeat(32) + '.access', SYNC_TOKEN = 'c'.repeat(32) + '.access';
function setup() {
  const { sqlite, db } = database();
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  sqlite.exec(`
    INSERT INTO clients (slug, name) VALUES ('uep', 'UEP'), ('safe', 'Sober AF');
    INSERT INTO projects (client_id, slug, name, phase, position) VALUES (1, 'scheduler', 'Scheduler', 'uat', 1), (2, 'chapters', 'Chapters', 'prototype', 1);
    INSERT INTO users (email, name, role, client_id) VALUES ('eric@positivetribes.org', 'Eric', 'pt', NULL);
  `);
  const env = { DB: db, ADMIN_DB: database().db, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') },
    SYNC_SERVICE_TOKENS: SYNC_TOKEN, REQUIREMENTS_SYNC_TOKENS: `${UEP_TOKEN}=uep, ${SAFE_TOKEN}=safe` };
  const call = async (headers, payload, method = 'POST', path = 'sync/requirements') => {
    const r = await worker.fetch(new Request('http://localhost/api/' + path, {
      method, headers: { 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload)
    }), env);
    return { status: r.status, body: await r.json() };
  };
  return { sqlite, call };
}
const FILE = n => `# Requirements\n| ID | Requirement | Source | Phase |\n|---|---|---|---|\n${Array.from({ length: n }, (_, i) => `| R${i + 1} | Thing ${i + 1}; DROP TABLE items; ' | Molly #7 | 3 |`).join('\n')}\n`;
const body = (over = {}) => ({ project: 'scheduler', prefix: 'R', file: 'docs/requirements.md', branch: 'phase-4', commit: 'abc1234', markdown: FILE(20), cited: ['R1', 'R2'], in_uat: ['R1'], ...over });
const as = token => ({ 'x-dev-service': token });

test('a client token replaces its own rows, parsed and bound by the hub', async () => {
  const { sqlite, call } = setup();
  const r = await call(as(UEP_TOKEN), body());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual([r.body.rows, r.body.cited, r.body.in_uat], [20, 2, 1]);
  const rows = sqlite.prepare('SELECT ref, text, cited, in_uat, hub_refs FROM requirements ORDER BY position').all();
  assert.equal(rows.length, 20);
  assert.equal(rows[0].text, "Thing 1; DROP TABLE items; '");
  assert.deepEqual([rows[0].cited, rows[0].in_uat, rows[2].cited], [1, 1, 0]);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM items').get().n, 0, 'items table still there');
  const sync = sqlite.prepare('SELECT branch, commit_sha, rows FROM requirement_syncs').get();
  assert.deepEqual({ ...sync }, { branch: 'phase-4', commit_sha: 'abc1234', rows: 20 });
  // A second push replaces, not appends.
  assert.equal((await call(as(UEP_TOKEN), body({ markdown: FILE(15) }))).status, 200);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM requirements').get().n, 15);
});

test('nobody else gets in: other client, the command center token, a person, no sign-in, GET', async () => {
  const { sqlite, call } = setup();
  const other = await call(as(SAFE_TOKEN), body());
  assert.equal(other.status, 400, 'Sober AF token cannot reach UEP projects');
  assert.match(other.body.error, /No project/);
  assert.equal((await call(as(SYNC_TOKEN), body())).status, 403);
  assert.equal((await call({ 'x-dev-email': 'eric@positivetribes.org' }, body())).status, 403);
  assert.equal((await call({}, body())).status, 401);
  assert.equal((await call(as(UEP_TOKEN), null, 'GET')).status, 403);
  // And the requirements token cannot use the command center or client routes.
  assert.equal((await call(as(UEP_TOKEN), null, 'GET', 'admin/requirements')).status, 403);
  assert.equal((await call(as(UEP_TOKEN), null, 'GET', 'c/uep/projects')).status, 403);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM requirements').get().n, 0);
});

test('input is checked, and a broken file cannot wipe the copy', async () => {
  const { sqlite, call } = setup();
  for (const over of [{ project: 'Scheduler; --' }, { prefix: 'r' }, { file: '../secret.md' }, { commit: 'nothex!' }, { cited: ['R1', 'DROP'] }, { markdown: '' }, { branch: 'a b' }]) {
    assert.equal((await call(as(UEP_TOKEN), body(over))).status, 400, JSON.stringify(over));
  }
  assert.equal((await call(as(UEP_TOKEN), 'not json')).status, 400);
  assert.equal((await call(as(UEP_TOKEN), body({ markdown: '# Nothing here' }))).status, 400);
  assert.equal((await call(as(UEP_TOKEN), body({ markdown: FILE(2) + '| R1 | again | x | 3 |\n' }))).status, 400, 'duplicate ref');
  assert.equal((await call(as(UEP_TOKEN), body())).status, 200);
  const cut = await call(as(UEP_TOKEN), body({ markdown: FILE(9) }));
  assert.equal(cut.status, 400);
  assert.match(cut.body.error, /more than half/);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM requirements').get().n, 20, 'unchanged');
  assert.equal((await call(as(UEP_TOKEN), body({ markdown: 'x'.repeat(700 * 1024) }))).status, 413);
});

test('token list parsing ignores anything malformed', () => {
  const m = requirementTokens(`${UEP_TOKEN}=uep junk=uep ${'d'.repeat(32)}.access=Bad_Slug`);
  assert.deepEqual([...m], [[UEP_TOKEN, 'uep']]);
});
