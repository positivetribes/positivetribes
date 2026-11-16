import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { database } from './helpers.mjs';
import { createScheduledAsks, pendingFor, tasksFor, commentForSalesforce, runFeedback } from '../src/feedback.js';

const OPP = '006Pr00000c8GsvIAE', ACCOUNT = '001Pr00000yy8o9IAA';

function setup({ sfHost } = {}) {
  const { sqlite, db } = database();
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  sqlite.exec(`
    INSERT INTO clients (slug, name, salesforce_account_id) VALUES ('uep', 'UEP', '${ACCOUNT}'), ('other', 'Other', '');
    INSERT INTO projects (client_id, slug, name, phase, salesforce_opportunity_id) VALUES (1, 'scheduler', 'Scheduler', 'build', '${OPP}');
    INSERT INTO users (email, name, role, client_id) VALUES
      ('molly@uep.org', 'Molly', 'ed', 1), ('sam@uep.org', 'Sam', 'staff', 1), ('eric@positivetribes.org', 'Eric', 'pt', NULL), ('olga@other.org', 'Olga', 'ed', 2);
    INSERT INTO releases (client_id, project_id, number, stage, uat_started, uat_days, uat_day_type) VALUES (1, 1, 2, 'uat', '2026-11-04', 10, 'business');
  `);
  const env = { DB: db, ADMIN_DB: database().db, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') },
    SF_DOMAIN: 'https://sf.example', SF_CLIENT_ID: 'id', SF_CLIENT_SECRET: 'secret', ...(sfHost ? { SF_TASK_SYNC_HOST: sfHost } : {}) };
  const call = async (who, path, method = 'GET', payload) => {
    const r = await worker.fetch(new Request('http://localhost/api/' + path, {
      method, headers: { 'x-dev-email': who, 'content-type': 'application/json', origin: 'http://localhost' },
      body: payload ? JSON.stringify(payload) : undefined
    }), env);
    return { status: r.status, body: await r.json() };
  };
  const rows = () => sqlite.prepare('SELECT * FROM feedback ORDER BY id').all();
  return { sqlite, db, env, call, rows };
}

function withSalesforce(t) {
  const original = globalThis.fetch, calls = [];
  let n = 0;
  globalThis.fetch = async (input, init = {}) => {
    const u = String(input?.url || input);
    calls.push({ url: u, method: init.method || 'GET', body: init.body });
    const ok = b => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/oauth2/token')) return ok({ access_token: 'x', instance_url: 'https://sf.example' });
    if (init.method === 'PATCH') return new Response(null, { status: 204 });
    if ((init.method || 'GET') === 'GET') return ok({ Description: 'Molly at UEP answered\nAnswer: 2/5\nNo comment.' });
    return ok({ id: '00TPr0000FEED' + String(++n).padStart(2, '0') + 'AAA' });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const tasks = calls => calls.filter(c => c.url.endsWith('/sobjects/Task') && c.method === 'POST').map(c => JSON.parse(c.body));

test('signing off a phase asks the director once, with one quick question', async t => {
  const { call, rows } = setup();
  withSalesforce(t);
  assert.equal((await call('molly@uep.org', 'c/uep/releases/1/signoff', 'POST', {})).status, 200);
  assert.equal(rows().filter(r => r.kind === 'phase').length, 1);
  const r = await call('molly@uep.org', 'c/uep/feedback');
  assert.equal(r.body.ask.question, 'How did Scheduler Phase 2 go?');
  assert.equal(r.body.ask.scale, 'five');
  // Staff were not asked about a phase they did not sign off.
  assert.equal((await call('sam@uep.org', 'c/uep/feedback')).body.ask, null);
});

test('a low rating makes a completed Task and a High follow-up; a comment updates them', async t => {
  const { call, rows } = setup();
  const calls = withSalesforce(t);
  await call('molly@uep.org', 'c/uep/releases/1/signoff', 'POST', {});
  const id = (await call('molly@uep.org', 'c/uep/feedback')).body.ask.id;
  const before = tasks(calls).length;
  const r = await call('molly@uep.org', `c/uep/feedback/${id}`, 'POST', { score: 2 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const [main, followup] = tasks(calls).slice(before);
  assert.equal(main.WhatId, OPP);
  assert.equal(main.Status, 'Completed');
  assert.equal(main.Subject, 'CSAT · UEP · Scheduler Phase 2: 2/5');
  assert.equal(followup.Priority, 'High');
  assert.match(followup.Subject, /^Follow up: UEP rated Scheduler Phase 2 2\/5$/);
  assert.doesNotMatch(main.Description + followup.Description, /molly@/);
  const saved = rows().find(x => x.id === id);
  assert.match(saved.sf_task_id, /^00T/);
  assert.match(saved.sf_followup_id, /^00T/);
  // The same question can't be answered twice, and nothing more is asked.
  assert.equal((await call('molly@uep.org', `c/uep/feedback/${id}`, 'POST', { score: 5 })).status, 409);
  assert.equal((await call('molly@uep.org', 'c/uep/feedback')).body.ask, null);
  const c = await call('molly@uep.org', `c/uep/feedback/${id}`, 'POST', { comment: 'The calendar was slow.' });
  assert.equal(c.status, 200);
  const patches = calls.filter(x => x.method === 'PATCH').map(x => JSON.parse(x.body).Description);
  assert.equal(patches.length, 2);
  assert.match(patches[0], /Comment: The calendar was slow\./);
});

test('a good rating makes one Task and no follow-up', async t => {
  const { call } = setup();
  const calls = withSalesforce(t);
  await call('molly@uep.org', 'c/uep/releases/1/signoff', 'POST', {});
  const id = (await call('molly@uep.org', 'c/uep/feedback')).body.ask.id;
  const before = tasks(calls).length;
  await call('molly@uep.org', `c/uep/feedback/${id}`, 'POST', { score: 5 });
  assert.equal(tasks(calls).length - before, 1);
});

test('only the person asked can answer; Positive Tribes and other clients cannot', async t => {
  const { call } = setup();
  withSalesforce(t);
  await call('molly@uep.org', 'c/uep/releases/1/signoff', 'POST', {});
  const id = (await call('molly@uep.org', 'c/uep/feedback')).body.ask.id;
  assert.equal((await call('eric@positivetribes.org', `c/uep/feedback/${id}`, 'POST', { score: 5 })).status, 403);
  assert.equal((await call('sam@uep.org', `c/uep/feedback/${id}`, 'POST', { score: 5 })).status, 404);
  assert.equal((await call('olga@other.org', `c/uep/feedback/${id}`, 'POST', { score: 5 })).status, 404);
  assert.equal((await call('molly@uep.org', `c/uep/feedback/${id}`, 'POST', { score: 9 })).status, 400);
  // Preview as: Positive Tribes sees Molly's question, but has none of its own.
  assert.equal((await call('eric@positivetribes.org', 'c/uep/feedback?as=molly@uep.org')).body.ask.id, id);
  assert.equal((await call('eric@positivetribes.org', 'c/uep/feedback')).body.ask, null);
});

test('Not now hides it; two in a row stop that kind for the person', async t => {
  withSalesforce(t);
  const { db, sqlite, call, rows } = setup();
  sqlite.exec(`INSERT INTO releases (client_id, project_id, number, stage) VALUES (1, 1, 3, 'uat'), (1, 1, 4, 'uat')`);
  await call('molly@uep.org', 'c/uep/releases/1/signoff', 'POST', {});
  let ask = (await call('molly@uep.org', 'c/uep/feedback')).body.ask;
  assert.equal((await call('molly@uep.org', `c/uep/feedback/${ask.id}`, 'POST', { dismiss: true })).status, 200);
  assert.equal((await call('molly@uep.org', 'c/uep/feedback')).body.ask, null);
  await call('molly@uep.org', 'c/uep/releases/2/signoff', 'POST', {});
  ask = (await call('molly@uep.org', 'c/uep/feedback')).body.ask;
  await call('molly@uep.org', `c/uep/feedback/${ask.id}`, 'POST', { dismiss: true });
  await call('molly@uep.org', 'c/uep/releases/3/signoff', 'POST', {});
  assert.equal(rows().filter(r => r.kind === 'phase').length, 2);
  assert.ok(db);
});

test('after one answer, phase/value/pulse questions stay quiet for 30 days; care thumbs still show', async () => {
  const { db, sqlite } = setup();
  sqlite.exec(`
    INSERT INTO feedback (client_id, user_id, kind, ref_id, label, scale, score, answered_at, expires_at) VALUES (1, 1, 'phase', 9, 'Old', 'five', 5, datetime('now', '-3 days'), datetime('now', '+1 day'));
    INSERT INTO feedback (client_id, user_id, kind, ref_id, label, scale, expires_at) VALUES (1, 1, 'value', 1, 'Scheduler', 'value', datetime('now', '+5 days'));`);
  const molly = sqlite.prepare("SELECT * FROM users WHERE id = 1").get();
  assert.equal(await pendingFor(db, molly, 1), null);
  sqlite.exec(`INSERT INTO feedback (client_id, user_id, kind, ref_id, label, scale, expires_at) VALUES (1, 1, 'care', 7, 'Export fix', 'thumbs', datetime('now', '+5 days'))`);
  assert.equal((await pendingFor(db, molly, 1)).kind, 'care');
  // An expired ask is never shown.
  sqlite.exec(`UPDATE feedback SET expires_at = datetime('now', '-1 minute') WHERE kind = 'care'`);
  assert.equal(await pendingFor(db, molly, 1), null);
});

test('the daily run asks about a launch 30 to 45 days old and a quarterly pulse on an active care plan', async () => {
  const { db, sqlite, env, rows } = setup();
  sqlite.exec(`
    INSERT INTO releases (client_id, project_id, number, stage) VALUES (1, 1, 1, 'live');
    UPDATE events SET at = datetime('now', '-35 days') WHERE action = 'live';
    INSERT INTO care_plans (client_id, tier, monthly_credits, starts_on, status, repo_url, test_db, test_signins_ok, rules_version)
      VALUES (1, 'care', 6, '2026-09-01', 'active', 'r', 't', 1, 'standard-2');`);
  await createScheduledAsks(db, '2026-11-16');
  const kinds = rows().map(r => r.kind + ':' + r.user_id).sort();
  assert.deepEqual(kinds, ['pulse:1', 'value:1']);
  assert.equal(rows().find(r => r.kind === 'value').label, 'Scheduler');
  // Running again asks nothing new.
  await runFeedback(env, db, '2026-11-16');
  assert.equal(rows().length, 2);
});

test('previews never write Salesforce Tasks', async t => {
  const { call } = setup({ sfHost: 'hub.positivetribes.org' });
  const calls = withSalesforce(t);
  await call('molly@uep.org', 'c/uep/releases/1/signoff', 'POST', {});
  const id = (await call('molly@uep.org', 'c/uep/feedback')).body.ask.id;
  assert.equal((await call('molly@uep.org', `c/uep/feedback/${id}`, 'POST', { score: 1 })).body.salesforce, 'off');
  assert.equal(tasks(calls).length, 0);
});

test('a comment with health or payment words stays in the hub', () => {
  assert.match(commentForSalesforce('My medication schedule broke'), /not copied here: it mentions health data/);
  assert.equal(commentForSalesforce(''), 'No comment.');
  const { followup } = tasksFor({ kind: 'care', label: 'Export fix', scale: 'thumbs', score: 0, comment: '', client_name: 'UEP', person: 'Molly' }, '2026-11-20');
  assert.equal(followup.ActivityDate, '2026-11-23'); // Friday → Monday
});

test('shipping a care request asks whoever asked for it', async () => {
  const { sqlite, db } = setup();
  sqlite.exec(`
    INSERT INTO items (client_id, project_id, kind, title, details, tier, phase, position, added_by) VALUES (1, 1, 'request', 'Export fix', '', 'nice', 'review', 1, 'Sam');
    INSERT INTO events (client_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name) VALUES (1, 1, 'added', 'Export fix', 'request', '', 'sam@uep.org', 'Sam');`);
  const { askCare } = await import('../src/feedback.js');
  await askCare(db, 1, { id: 1, title: 'Export fix' });
  const sam = sqlite.prepare("SELECT * FROM users WHERE id = 2").get();
  const ask = await pendingFor(db, sam, 1);
  assert.equal(ask.question, 'Did “Export fix” turn out the way you wanted?');
});
