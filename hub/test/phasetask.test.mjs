import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { database } from './helpers.mjs';
import { checkTestingWindows, pushPhaseTask } from '../src/phasetask.js';

const OPP = '006Pr00000c8GsvIAE', ACCOUNT = '001Pr00000yy8o9IAA';

function setup() {
  const { sqlite, db } = database();
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  sqlite.exec(`
    INSERT INTO clients (slug, name, salesforce_account_id) VALUES ('uep', 'UEP', '${ACCOUNT}');
    INSERT INTO projects (client_id, slug, name, phase, salesforce_opportunity_id) VALUES (1, 'scheduler', 'Scheduler', 'build', '${OPP}');
    INSERT INTO users (email, name, role, client_id) VALUES ('molly@uep.org', 'Molly', 'ed', 1), ('eric@positivetribes.org', 'Eric', 'pt', NULL);
    INSERT INTO releases (client_id, project_id, number, stage, uat_started, uat_days, uat_day_type, auto_accept) VALUES
      (1, 1, 2, 'uat', '2026-11-04', 10, 'business', 1), (1, 1, 3, 'waiting', NULL, 10, 'business', 1), (1, 1, 4, 'planned', NULL, 10, 'business', 1);
    INSERT INTO items (client_id, project_id, kind, title, details, tier, phase, position, added_by, status, release_id) VALUES
      (1, 1, 'change', 'Calendar view', '', 'nice', 'full', 1, 'Molly', 'planned', 1),
      (1, 1, 'change', 'Move up button', '', 'nice', 'full', 2, 'Molly', 'planned', 1),
      (1, 1, 'change', 'Not approved', '', 'nice', 'full', 3, 'Molly', 'planned', 1),
      (1, 1, 'change', 'Ships later', '', 'nice', 'full', 4, 'Molly', 'planned', 3);
    INSERT INTO change_estimates (item_id, client_id, minutes, rate_cents, price_cents, credits, status, donated) VALUES
      (1, 1, 480, 5000, 40000, 16, 'approved_now', 0),
      (2, 1, 240, 5000, 20000, 8, 'approved_now', 1),
      (3, 1, 180, 5000, 15000, 6, 'offered', 0),
      (4, 1, 180, 5000, 15000, 6, 'approved_now', 0);
  `);
  const env = { DB: db, ADMIN_DB: database().db, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') },
    SF_DOMAIN: 'https://sf.example', SF_CLIENT_ID: 'id', SF_CLIENT_SECRET: 'secret' };
  const call = async (who, path, method = 'GET', payload) => {
    const r = await worker.fetch(new Request('http://localhost/api/' + path, {
      method, headers: { 'x-dev-email': who, 'content-type': 'application/json', origin: 'http://localhost' },
      body: payload ? JSON.stringify(payload) : undefined
    }), env);
    return { status: r.status, body: await r.json() };
  };
  const release = id => sqlite.prepare('SELECT * FROM releases WHERE id = ?').get(id);
  return { sqlite, db, env, call, release };
}

function withSalesforce(t, handler) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input?.url || input);
    calls.push({ url: u, method: init.method || 'GET', body: init.body });
    return handler(u, init, calls);
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const salesforce = u => u.includes('/oauth2/token') ? ok({ access_token: 'x', instance_url: 'https://sf.example' }) : ok({ id: '00TPr0000PHASE2AAA' });
const tasks = calls => calls.filter(c => c.url.endsWith('/sobjects/Task')).map(c => JSON.parse(c.body));

test('signing off a phase makes one Task to invoice it, with the approved changes that ship in it', async t => {
  const { call, release } = setup();
  const calls = withSalesforce(t, salesforce);
  const r = await call('molly@uep.org', 'c/uep/releases/1/signoff', 'POST', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [task] = tasks(calls);
  assert.equal(task.WhatId, OPP);
  assert.equal(task.Priority, 'High');
  assert.match(task.Subject, /^Scheduler Phase 2 accepted \(signed off\): send the invoice \+ \$400 in changes$/);
  assert.match(task.Description, /Molly signed off Scheduler Phase 2/);
  assert.match(task.Description, /#1 Calendar view \(8 hours, \$400\)/);
  assert.match(task.Description, /Donated, no charge[\s\S]*#2 Move up button \(4 hours, \$200 value, donated\)/);
  assert.doesNotMatch(task.Description, /Not approved|Ships later|molly@/);
  assert.equal(release(1).sf_task_id, '00TPr0000PHASE2AAA');
  assert.equal(release(1).sf_task_reason, 'signed_off');
});

test('a phase never gets a second Task', async t => {
  const { db, env } = setup();
  const calls = withSalesforce(t, salesforce);
  assert.equal(await pushPhaseTask(env, db, 'localhost', 1, 'signed_off', '2026-11-15'), 'created');
  assert.equal(await pushPhaseTask(env, db, 'localhost', 1, 'signed_off', '2026-11-15'), 'exists');
  assert.deepEqual(await checkTestingWindows(env, db, '2026-12-01'), [], 'the window check skips it too');
  assert.equal(tasks(calls).length, 1);
});

test('a testing window that ends with no problems makes a Task to confirm and invoice, but does not sign off', async t => {
  const { db, env, release } = setup();
  const calls = withSalesforce(t, salesforce);
  // Nov 4 + 10 business days = Nov 18. Accepted on that day, so nothing until the day after.
  assert.deepEqual(await checkTestingWindows(env, db, '2026-11-18'), []);
  assert.deepEqual(await checkTestingWindows(env, db, '2026-11-19'), [{ id: 1, result: 'created' }]);
  const [task] = tasks(calls);
  assert.match(task.Subject, /accepted \(testing window ended\)/);
  assert.match(task.Description, /ended on 2026-11-18 with no problems listed[\s\S]*sign it off in the hub on their behalf/);
  assert.equal(task.ActivityDate, '2026-11-20');
  assert.equal(release(1).stage, 'uat', 'a person signs it off');
});

test('an open problem holds the window check', async t => {
  const { sqlite, db, env } = setup();
  const calls = withSalesforce(t, salesforce);
  sqlite.exec("INSERT INTO items (client_id, project_id, kind, title, details, tier, phase, position, added_by) VALUES (1, 1, 'problem', 'Broken', '', 'nice', 'full', 1, 'Molly')");
  assert.deepEqual(await checkTestingWindows(env, db, '2026-12-01'), []);
  sqlite.exec("UPDATE items SET done = 1 WHERE kind = 'problem'");
  assert.equal((await checkTestingWindows(env, db, '2026-12-01')).length, 1);
  assert.equal(tasks(calls).length, 1);
});

test('a failed sign-off Task keeps the sign-off and is retried by the daily check', async t => {
  const { call, db, env, release } = setup();
  let down = true;
  withSalesforce(t, u => u.includes('/oauth2/token') ? ok({ access_token: 'x', instance_url: 'https://sf.example' })
    : down ? new Response(JSON.stringify([{ message: 'boom' }]), { status: 500 }) : ok({ id: '00TPr0000PHASE2AAA' }));
  const origError = console.error; console.error = () => {}; t.after(() => { console.error = origError; });
  assert.equal((await call('molly@uep.org', 'c/uep/releases/1/signoff', 'POST', {})).status, 200);
  assert.equal(release(1).stage, 'signed_off');
  assert.match(release(1).sf_error, /sf_500/);
  down = false;
  assert.deepEqual(await checkTestingWindows(env, db, '2026-11-16'), [{ id: 1, result: 'created' }]);
  assert.equal(release(1).sf_error, '');
  assert.equal(release(1).sf_task_reason, 'signed_off');
});

test('a preview host never writes the Task', async t => {
  const { call, env } = setup();
  env.SF_TASK_SYNC_HOST = 'hub.positivetribes.org';
  const calls = withSalesforce(t, () => { throw new Error('should not be called'); });
  assert.equal((await call('molly@uep.org', 'c/uep/releases/1/signoff', 'POST', {})).status, 200);
  assert.equal(calls.length, 0);
});
