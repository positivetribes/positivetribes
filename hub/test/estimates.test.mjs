import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { database } from './helpers.mjs';
import { minutesFromHours, priceCentsOf, creditsOf, hoursLabel, moneyLabel, canDecideEstimate, donatedTotals } from '../src/estimates.js';

const OPP = '006Pr00000c8GsvIAE', ACCOUNT = '001Pr00000yy8o9IAA';

function setup({ plan = true, contact = 3 } = {}) {
  const { sqlite, db } = database();
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  sqlite.exec(`
    INSERT INTO clients (slug, name, salesforce_account_id) VALUES ('uep', 'UEP', '${ACCOUNT}'), ('safe', 'Sober AF', '001Pr00000yyXUuIAM');
    INSERT INTO projects (client_id, slug, name, phase, salesforce_opportunity_id) VALUES (1, 'scheduler', 'Scheduler', 'build', '${OPP}'), (2, 'chapters', 'Chapters', 'build', '');
    INSERT INTO users (email, name, role, client_id) VALUES
      ('molly@uep.org', 'Molly', 'ed', 1), ('sam@uep.org', 'Sam', 'staff', 1), ('kim@uep.org', 'Kim', 'staff', 1),
      ('eric@positivetribes.org', 'Eric', 'pt', NULL), ('dana@safe.org', 'Dana', 'ed', 2);
    INSERT INTO items (client_id, project_id, kind, title, details, tier, phase, position, added_by) VALUES
      (1, 1, 'change', 'Leads add a climber', '', 'must', 'review', 1, 'Molly'),
      (1, 1, 'change', 'Paper waiver', '', 'nice', 'review', 1, 'Molly'),
      (1, 1, 'problem', 'A broken button', '', 'nice', 'full', 1, 'Sam'),
      (2, 2, 'change', 'Their change', '', 'nice', 'review', 1, 'Dana');
  `);
  if (plan) {
    sqlite.exec(`INSERT INTO care_plans (client_id, tier, monthly_credits, status, balance_contact_user_id) VALUES (1, 'care', 6, 'setup', ${contact === null ? 'NULL' : contact})`);
  }
  const env = { DB: db, ADMIN_DB: database().db, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') } };
  const call = async (who, path, method = 'GET', payload, { origin = 'http://localhost' } = {}) => {
    const r = await worker.fetch(new Request('http://localhost/api/' + path, {
      method,
      headers: { 'x-dev-email': who, 'content-type': 'application/json', ...(origin && method !== 'GET' ? { origin } : {}) },
      body: payload ? JSON.stringify(payload) : undefined
    }), env);
    return { status: r.status, body: await r.json() };
  };
  const PT = 'eric@positivetribes.org';
  const estimate = (item, hours, extra = {}) => call(PT, `admin/items/${item}/estimate`, 'PUT', { hours, ...extra });
  const offer = item => call(PT, `admin/items/${item}/estimate/offer`, 'POST', {});
  const sent = async (item = 1, hours = 3) => { await estimate(item, hours, { schedule_note: 'Adds about a week' }); return offer(item); };
  const decide = (who, item, choice, version = 1, slug = 'uep') => call(who, `c/${slug}/items/${item}/estimate/decide`, 'POST', { choice, version });
  const row = item => sqlite.prepare('SELECT * FROM change_estimates WHERE item_id = ?').get(item);
  const item = id => sqlite.prepare('SELECT * FROM items WHERE id = ?').get(id);
  const events = action => sqlite.prepare('SELECT * FROM events WHERE action = ? ORDER BY id').all(action);
  return { sqlite, env, call, estimate, offer, sent, decide, row, item, events, PT };
}

test('hours become a price and credits: $50/h, 1 credit = 30 minutes', () => {
  assert.equal(minutesFromHours(3), 180);
  assert.equal(minutesFromHours('1.5'), 90);
  assert.equal(minutesFromHours(0.5), 30);
  for (const bad of [0, 0.25, 1.1, -1, 201, NaN, 'x', null, undefined]) assert.throws(() => minutesFromHours(bad), /hours|Use whole/i, String(bad));
  assert.equal(priceCentsOf(180, 5000), 15000);
  assert.equal(priceCentsOf(30, 5000), 2500);
  assert.equal(priceCentsOf(90, 4500), 6750);
  assert.equal(creditsOf(180), 6);
  assert.equal(creditsOf(30), 1);
  assert.equal(hoursLabel(30), '30 minutes');
  assert.equal(hoursLabel(60), '1 hour');
  assert.equal(hoursLabel(90), '1.5 hours');
  assert.equal(hoursLabel(180), '3 hours');
  assert.equal(moneyLabel(15000), '$150');
  assert.equal(moneyLabel(6750), '$67.50');
});

test('who may decide: the director and the named contact; never staff, never Positive Tribes', () => {
  const plan = { balance_contact_user_id: 7 };
  assert.equal(canDecideEstimate({ id: 1, role: 'ed' }, plan), true);
  assert.equal(canDecideEstimate({ id: 7, role: 'staff' }, plan), true);
  assert.equal(canDecideEstimate({ id: 2, role: 'staff' }, plan), false);
  assert.equal(canDecideEstimate({ id: 2, role: 'staff' }, null), false);
  assert.equal(canDecideEstimate({ id: 3, role: 'pt' }, plan), false);
  assert.equal(canDecideEstimate({ id: 3, role: 'ed' }, null), true, 'a director needs no care plan during the build');
});

test('only Positive Tribes estimates, only suggested changes, and a client cannot see a draft', async () => {
  const { call, estimate, PT, row } = setup();
  assert.equal((await call('molly@uep.org', 'admin/items/1/estimate', 'PUT', { hours: 3 })).status, 404, 'the command center does not exist for clients');
  assert.equal((await estimate(3, 2)).status, 409, 'not a problem');
  assert.equal((await estimate(1, 1.25)).status, 400);
  const draft = await estimate(1, 3, { schedule_note: 'Adds about a week', scope_note: 'Not in the signed scope' });
  assert.equal(draft.status, 201);
  assert.equal(draft.body.estimate.price_label, '$150');
  assert.equal(draft.body.estimate.credits, 6);
  assert.equal(row(1).status, 'draft');
  const forClient = (await call('molly@uep.org', 'c/uep/items')).body.items.find(i => i.id === 1);
  assert.equal(forClient.estimate, null, 'drafts are Positive Tribes\' alone');
  const forPt = (await call(PT, 'c/uep/items')).body.items.find(i => i.id === 1);
  assert.equal(forPt.estimate.status, 'draft');
});

test('sending tells the client; everyone on the hub sees the price, only the director gets the buttons', async () => {
  const { call, sent, events } = setup();
  const r = await sent();
  assert.equal(r.status, 200);
  assert.equal(events('estimate_offered').length, 1);
  assert.equal(events('estimate_offered')[0].detail, 'About 3 hours · $150');
  const molly = (await call('molly@uep.org', 'c/uep/items')).body.items.find(i => i.id === 1).estimate;
  const sam = (await call('sam@uep.org', 'c/uep/items')).body.items.find(i => i.id === 1).estimate;
  const kim = (await call('kim@uep.org', 'c/uep/items')).body.items.find(i => i.id === 1).estimate;
  assert.equal(molly.price_label, '$150');
  assert.equal(sam.price_label, '$150');
  assert.equal(molly.can_decide, true);
  assert.equal(sam.can_decide, false);
  assert.equal(kim.can_decide, true, 'kim is user 3, the named contact');
  assert.equal(molly.rate_label, undefined, 'the rate and Salesforce details are Positive Tribes\'');
  assert.equal(molly.sf_error, undefined);
  const bell = (await call('sam@uep.org', 'notifications')).body.items.find(i => i.action === 'estimate_offered');
  assert.equal(bell.detail, 'About 3 hours · $150');
  assert.equal((await call('dana@safe.org', 'c/uep/items')).status, 404, 'another client sees nothing');
});

test('add it now: the item moves into the build, one Task is not created without Salesforce, and the bell tells Positive Tribes', async () => {
  const { call, sent, decide, row, item, events } = setup();
  await sent();
  const r = await decide('molly@uep.org', 1, 'now');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(row(1).status, 'approved_now');
  assert.equal(row(1).decided_version, 1);
  assert.equal(item(1).status, 'planned');
  assert.equal(item(1).phase, 'full');
  assert.equal(item(1).tier, 'must');
  assert.equal(events('estimate_decided').length, 1);
  assert.equal(events('estimate_decided')[0].detail, 'Add it now · 3 hours · $150');
  assert.equal(events('estimate_decided')[0].actor_email, 'molly@uep.org');
  assert.equal(r.body.items.find(i => i.id === 1).estimate.decided_by, 'Molly');
  // Positive Tribes' inbox picks up the client's event.
  const inbox = (await call('eric@positivetribes.org', 'admin/inbox')).body;
  assert.ok(inbox.items.some(i => i.action === 'estimate_decided' && i.itemId === 1));
});

test('after launch needs a care plan and 2 hours or less; larger changes are better added now', async () => {
  const a = setup();
  await a.sent(1, 2);
  assert.equal((await a.call('molly@uep.org', 'c/uep/items')).body.items.find(i => i.id === 1).estimate.later_ok, true);
  assert.equal((await a.decide('molly@uep.org', 1, 'later')).status, 200);
  assert.equal(a.item(1).phase, 'later');
  assert.equal(a.row(1).status, 'approved_later');
  assert.equal(a.events('estimate_decided')[0].detail, 'After launch · 2 hours · 4 credits');

  const big = setup();
  await big.sent(1, 2.5);
  const view = (await big.call('molly@uep.org', 'c/uep/items')).body.items.find(i => i.id === 1).estimate;
  assert.equal(view.later_ok, false);
  assert.match(view.later_note, /better added now/);
  assert.equal((await big.decide('molly@uep.org', 1, 'later')).status, 409);
  assert.equal(big.row(1).status, 'offered', 'nothing changed');

  const none = setup({ plan: false });
  await none.sent(1, 1);
  assert.equal((await none.call('molly@uep.org', 'c/uep/items')).body.items.find(i => i.id === 1).estimate.later_ok, false);
  assert.equal((await none.decide('molly@uep.org', 1, 'later')).status, 409);
  assert.equal((await none.decide('molly@uep.org', 1, 'now')).status, 200, 'a director needs no care plan to add it now');
});

test('not now keeps it on the wishlist: a must have becomes an idea, a nice to have stays', async () => {
  const { sent, decide, item, row } = setup();
  await sent(1, 3);
  assert.equal((await decide('molly@uep.org', 1, 'not_now')).status, 200);
  assert.equal(item(1).tier, 'idea');
  assert.equal(item(1).status, 'planned');
  assert.equal(item(1).phase, 'review', 'phase unchanged');
  assert.equal(item(1).done, 0);
  assert.equal(row(1).status, 'not_now');
  await sent(2, 1);
  assert.equal((await decide('molly@uep.org', 2, 'not_now')).status, 200);
  assert.equal(item(2).tier, 'nice');
});

test('nobody else can decide: staff, other clients, Positive Tribes, other sites, bad input', async () => {
  const { call, sent, decide, row } = setup({ contact: null });
  await sent();
  assert.equal((await decide('sam@uep.org', 1, 'now')).status, 403, 'staff');
  assert.equal((await decide('eric@positivetribes.org', 1, 'now')).status, 403, 'Positive Tribes never decides');
  assert.equal((await decide('dana@safe.org', 1, 'now')).status, 404, 'another client');
  assert.equal((await decide('dana@safe.org', 1, 'now', 1, 'safe')).status, 404, 'their own slug cannot reach our item');
  assert.equal((await call('molly@uep.org', 'c/uep/items/1/estimate/decide', 'POST', { choice: 'now', version: 1 }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await decide('molly@uep.org', 1, 'free')).status, 400);
  assert.equal((await decide('molly@uep.org', 1, 'now', '1')).status, 400);
  assert.equal((await call('molly@uep.org', 'c/uep/items/1/estimate/decide', 'GET')).status, 404);
  assert.equal(row(1).status, 'offered', 'still waiting');
});

test('a second decision, or one on a re-estimated number, is refused', async () => {
  const { call, estimate, offer, sent, decide, row, events } = setup();
  await sent(1, 3);
  assert.equal((await decide('molly@uep.org', 1, 'now')).status, 200);
  assert.equal((await decide('molly@uep.org', 1, 'now')).status, 409);
  assert.equal((await decide('molly@uep.org', 1, 'not_now')).status, 409);
  assert.equal(events('estimate_decided').length, 1, 'one decision, one event');
  assert.equal((await estimate(1, 5)).status, 409, 'an approved estimate cannot be changed');

  const stale = setup();
  await stale.sent(1, 3);
  await stale.estimate(1, 6);
  assert.equal(stale.row(1).version, 2);
  assert.equal(stale.row(1).status, 'draft', 'a new number goes back to a draft');
  assert.equal((await stale.decide('molly@uep.org', 1, 'now', 1)).status, 404, 'a draft has nothing to decide');
  await stale.offer(1);
  assert.equal((await stale.decide('molly@uep.org', 1, 'now', 1)).status, 409, 'the old version is refused');
  assert.equal(stale.row(1).status, 'offered');
  assert.equal((await stale.decide('molly@uep.org', 1, 'now', 2)).status, 200);
  assert.equal(stale.row(1).price_cents, 30000);
});

test('the guarded update and the table checks refuse a repeat or an impossible estimate', async () => {
  const { sqlite, sent, decide } = setup();
  await sent();
  await decide('molly@uep.org', 1, 'now');
  const done = sqlite.prepare("UPDATE items SET phase = 'review' WHERE id = 1").run();
  assert.equal(done.changes, 1);
  // The guarded update (status = 'offered') finds nothing to change.
  const again = sqlite.prepare("UPDATE change_estimates SET status = 'not_now' WHERE item_id = 1 AND status = 'offered' AND version = 1").run();
  assert.equal(again.changes, 0);
  assert.throws(() => sqlite.exec("UPDATE change_estimates SET minutes = 45 WHERE item_id = 1"), /CHECK/);
  assert.throws(() => sqlite.exec("UPDATE change_estimates SET status = 'maybe' WHERE item_id = 1"), /CHECK/);
});

test('the rate is per client and each sent estimate keeps its own copy', async () => {
  const { call, estimate, offer, sent, row, PT } = setup();
  await sent(1, 2);
  assert.equal(row(1).rate_cents, 5000);
  assert.equal((await call(PT, 'admin/clients/1/rate', 'PUT', { rate: 60 })).status, 200);
  assert.equal(row(1).price_cents, 10000, 'a sent estimate does not change when the rate does');
  await estimate(2, 2);
  await offer(2);
  assert.equal(row(2).price_cents, 12000);
  assert.equal(row(2).rate_cents, 6000);
  assert.equal((await call(PT, 'admin/clients/1/rate', 'PUT', { rate: -1 })).status, 400);
  assert.equal((await call(PT, 'admin/clients/1/rate', 'PUT', { rate: 5000 })).status, 400);
  assert.equal((await call(PT, 'admin/clients/99/rate', 'PUT', { rate: 50 })).status, 404);
  assert.equal((await call('molly@uep.org', 'admin/clients/1/rate', 'PUT', { rate: 1 })).status, 404);
});

test('Positive Tribes can withdraw, and the Today list shows what waits and what to handle', async () => {
  const { call, sent, estimate, offer, decide, PT } = setup();
  await sent(1, 3);
  await estimate(2, 1);
  await offer(2);
  let list = (await call(PT, 'admin/estimates')).body;
  assert.deepEqual(list.waiting.map(r => r.item_id).sort(), [1, 2]);
  assert.equal(list.waiting[0].price_label, '$150');
  await call(PT, 'admin/items/2/estimate/withdraw', 'POST', {});
  assert.equal((await call('molly@uep.org', 'c/uep/items')).body.items.find(i => i.id === 2).estimate, null, 'withdrawn is gone for the client');
  assert.equal((await decide('molly@uep.org', 2, 'now')).status, 404);
  await decide('molly@uep.org', 1, 'now');
  list = (await call(PT, 'admin/estimates')).body;
  assert.deepEqual([list.waiting.length, list.toHandle.map(r => r.item_id)], [0, [1]]);
  assert.equal((await call(PT, 'admin/items/1/estimate/handled', 'POST', {})).status, 200);
  assert.equal((await call(PT, 'admin/estimates')).body.toHandle.length, 0);
});

// ---- Salesforce ----

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
const sfEnv = env => Object.assign(env, { SF_DOMAIN: 'https://sf.example', SF_CLIENT_ID: 'id', SF_CLIENT_SECRET: 'secret' });
const ok = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('approving creates one Salesforce Task on the project\'s Opportunity, and none for not now', async t => {
  const { env, sent, decide, row } = setup();
  sfEnv(env);
  const calls = withSalesforce(t, u => u.includes('/oauth2/token') ? ok({ access_token: 'x', instance_url: 'https://sf.example' }) : ok({ id: '00TPr0000181mxGMAQ' }));
  await sent(1, 3);
  assert.equal((await decide('molly@uep.org', 1, 'now')).status, 200);
  const post = calls.find(c => c.url.endsWith('/sobjects/Task'));
  const task = JSON.parse(post.body);
  assert.equal(task.WhatId, OPP);
  assert.match(task.Subject, /Change approved: Leads add a climber \(3 hours, \$150, add now\)/);
  assert.equal(task.Status, 'Not Started');
  assert.doesNotMatch(JSON.stringify(task), /molly@|balance/i);
  assert.equal(row(1).sf_task_id, '00TPr0000181mxGMAQ');
  await sent(2, 1);
  await decide('molly@uep.org', 2, 'not_now');
  assert.equal(calls.filter(c => c.url.endsWith('/sobjects/Task')).length, 1);
});

test('a donated change\'s Salesforce Task says schedule it, no invoice', async t => {
  const { env, estimate, offer, decide } = setup();
  sfEnv(env);
  const calls = withSalesforce(t, u => u.includes('/oauth2/token') ? ok({ access_token: 'x', instance_url: 'https://sf.example' }) : ok({ id: '00TPr0000181mxGMAQ' }));
  await estimate(1, 1, { donated: true });
  await offer(1);
  await decide('molly@uep.org', 1, 'now');
  const task = JSON.parse(calls.find(c => c.url.endsWith('/sobjects/Task')).body);
  assert.match(task.Subject, /\(1 hour, donated, \$50 value\)/);
  assert.match(task.Description, /no invoice/);
});

test('a Salesforce failure keeps the decision, records why, and can be retried', async t => {
  const { env, call, sent, decide, row, PT } = setup();
  sfEnv(env);
  let down = true;
  withSalesforce(t, u => u.includes('/oauth2/token') ? ok({ access_token: 'x', instance_url: 'https://sf.example' })
    : down ? new Response(JSON.stringify([{ message: 'boom' }]), { status: 500 }) : ok({ id: '00TPr0000181mxGMAQ' }));
  const origError = console.error; console.error = () => {}; t.after(() => { console.error = origError; });
  await sent(1, 3);
  assert.equal((await decide('molly@uep.org', 1, 'now')).status, 200, 'the client\'s decision stands');
  assert.equal(row(1).status, 'approved_now');
  assert.equal(row(1).sf_task_id, '');
  assert.match(row(1).sf_error, /sf_500/);
  assert.equal((await call(PT, 'admin/estimates')).body.taskFailed.length, 1);
  assert.equal((await call('molly@uep.org', 'c/uep/items')).body.items.find(i => i.id === 1).estimate.sf_error, undefined);
  down = false;
  assert.equal((await call(PT, 'admin/items/1/estimate/retry-task', 'POST', {})).body.result, 'created');
  assert.equal(row(1).sf_error, '');
  assert.equal((await call(PT, 'admin/items/1/estimate/retry-task', 'POST', {})).body.result, 'exists', 'never a second Task');
});

test('a preview host never writes Salesforce Tasks', async t => {
  const { env, sent, decide } = setup();
  sfEnv(env);
  env.SF_TASK_SYNC_HOST = 'hub.positivetribes.org';
  const calls = withSalesforce(t, () => { throw new Error('should not be called'); });
  await sent();
  assert.equal((await decide('molly@uep.org', 1, 'now')).status, 200);
  assert.equal(calls.length, 0);
});

// ---- Donated changes ----

test('a donated estimate shows its value as donated, offers no after-launch, and counts once approved', async () => {
  const { env, call, estimate, offer, decide, row, item, events, PT } = setup();
  assert.equal((await estimate(1, 1, { donated: 'yes' })).status, 400, 'donated is true or false');
  assert.equal((await estimate(1, 1, { donated: true })).status, 201);
  await offer(1);
  assert.equal(events('estimate_offered')[0].detail, 'About 1 hour · donated ($50 value)');
  const molly = (await call('molly@uep.org', 'c/uep/items')).body.items.find(i => i.id === 1).estimate;
  assert.equal(molly.donated, true);
  assert.equal(molly.price_label, '$50', 'the value, not a charge');
  assert.equal(molly.later_ok, false, 'nothing to put off to the care plan');
  assert.equal((await decide('molly@uep.org', 1, 'later')).status, 409);
  assert.deepEqual(await donatedTotals(env.DB), [], 'offered is not donated yet');
  assert.equal((await decide('molly@uep.org', 1, 'now')).status, 200);
  assert.equal(row(1).status, 'approved_now');
  assert.equal(item(1).phase, 'full');
  assert.equal(events('estimate_decided')[0].detail, 'Add it now · 1 hour · donated ($50 value)');
  const totals = await donatedTotals(env.DB);
  assert.deepEqual(totals.map(t => [t.slug, t.minutes, t.value_cents]), [['uep', 60, 5000]]);
  assert.equal((await call(PT, 'admin/estimates')).body.toHandle[0].donated, 1);
});

test('re-estimating can turn a donation on or off; not now and withdrawn never count', async () => {
  const { env, estimate, offer, decide, row, call, PT } = setup();
  await estimate(1, 2, { donated: true });
  await estimate(1, 2);
  assert.equal(row(1).donated, 0, 'leaving it out means charged');
  await estimate(1, 2, { donated: true });
  await offer(1);
  await decide('molly@uep.org', 1, 'not_now', 3);
  await estimate(2, 1, { donated: true });
  await offer(2);
  await call(PT, 'admin/items/2/estimate/withdraw', 'POST', {});
  assert.deepEqual(await donatedTotals(env.DB), []);
});

test('donated time: only Positive Tribes logs it, any item, everyone on the hub sees it, and it is totalled by year', async () => {
  const { env, sqlite, call, events, PT } = setup();
  const log = (who, id, payload) => call(who, `admin/items/${id}/donated-time`, 'POST', payload);
  assert.equal((await log('molly@uep.org', 3, { hours: 1 })).status, 404, 'clients cannot reach the command center');
  assert.equal((await log(PT, 3, { hours: 0.25 })).status, 400);
  assert.equal((await log(PT, 999, { hours: 1 })).status, 404);
  assert.equal((await log(PT, 3, { hours: 1.5, note: 'Matching-gift prompt' })).status, 201, 'a problem fix counts too');
  assert.equal((await log(PT, 4, { hours: 1 })).status, 201, 'another client');
  assert.equal(events('donated_time')[0].detail, '1.5 hours donated ($75 value)');
  const sam = (await call('sam@uep.org', 'c/uep/items')).body.items.find(i => i.id === 3);
  assert.deepEqual(sam.donated_time.map(d => [d.hours_label, d.value_label, d.note, d.created_by]), [['1.5 hours', '$75', 'Matching-gift prompt', undefined]]);
  assert.equal((await call('sam@uep.org', 'c/uep/items')).body.items.find(i => i.id === 1).donated_time.length, 0);
  assert.equal((await call('dana@safe.org', 'c/safe/items')).body.items.find(i => i.id === 4).donated_time.length, 1);
  assert.ok(!(await call('dana@safe.org', 'c/safe/items')).body.items.some(i => i.id === 3), 'no other client\'s time');
  const bell = (await call('sam@uep.org', 'notifications')).body.items.find(i => i.action === 'donated_time');
  assert.equal(bell.detail, '1.5 hours donated ($75 value)');
  let totals = await donatedTotals(env.DB);
  assert.deepEqual(totals.map(t => [t.slug, t.value_label]), [['uep', '$75'], ['safe', '$50']]);
  sqlite.exec("UPDATE donated_time SET created_at = '2025-12-31 10:00:00' WHERE item_id = 4");
  totals = await donatedTotals(env.DB, '2026-01-01');
  assert.deepEqual(totals.map(t => t.slug), ['uep'], 'last year is left out');
  const id = sqlite.prepare('SELECT id FROM donated_time WHERE item_id = 3').get().id;
  assert.equal((await call('molly@uep.org', `admin/donated-time/${id}`, 'DELETE')).status, 404);
  assert.equal((await call(PT, `admin/donated-time/${id}`, 'DELETE')).status, 200);
  assert.equal((await call(PT, `admin/donated-time/${id}`, 'DELETE')).status, 404);
});

test('an item with an approved estimate or donated time stays on record; one with only a draft can be deleted', async () => {
  const { call, sent, estimate, decide, row, PT } = setup();
  await estimate(2, 1);
  assert.equal((await call(PT, 'c/uep/items/2', 'DELETE')).status, 200, JSON.stringify((await call(PT, 'c/uep/items')).body.error || ''));
  assert.equal(row(2), undefined, 'its draft goes with it');
  await sent(1, 1);
  await decide('molly@uep.org', 1, 'now');
  assert.equal((await call(PT, 'c/uep/items/1', 'DELETE')).status, 409);
  await call(PT, 'admin/items/3/donated-time', 'POST', { hours: 1 });
  assert.equal((await call(PT, 'c/uep/items/3', 'DELETE')).status, 409);
});

test('"Preview as" knows who gets the estimate buttons, and only Positive Tribes gets the list', async () => {
  const { call, PT } = setup();
  const people = (await call(PT, 'c/uep/people')).body.people;
  assert.deepEqual(people.map(p => [p.name, p.decides]), [['Molly', true], ['Kim', true], ['Sam', false]]);
  assert.ok(people.every(p => p.id === undefined), 'no user ids leave the server');
  assert.equal((await call('molly@uep.org', 'c/uep/people')).status, 404);
});

test('while an estimate waits, the client cannot close it, change its phase or move it; Positive Tribes still can', async () => {
  const { call, sent, decide, item, PT } = setup();
  await sent(1, 3);
  for (const [who, change] of [['molly@uep.org', { done: true }], ['sam@uep.org', { phase: 'full' }], ['molly@uep.org', { phase: 'later' }]]) {
    assert.equal((await call(who, 'c/uep/items/1', 'PATCH', change)).status, 409, JSON.stringify(change));
  }
  assert.equal(item(1).done, 0);
  assert.equal(item(1).phase, 'review');
  assert.equal((await call('molly@uep.org', 'c/uep/items/1', 'PATCH', { tier: 'nice', title: 'Leads add a climber by link' })).status, 200, 'priority and wording are fine');
  assert.equal((await call(PT, 'c/uep/items/1', 'PATCH', { phase: 'later' })).status, 200, 'Positive Tribes keeps every control');
  await decide('molly@uep.org', 1, 'not_now');
  assert.equal((await call('molly@uep.org', 'c/uep/items/1', 'PATCH', { done: true })).status, 200, 'decided, so the lock is gone');
});

test('a breakdown sets the hours, everyone on the hub can read it once sent, and bad lines are refused', async () => {
  const { call, estimate, offer, row, PT } = setup();
  const lines = [{ label: 'Leads flag a possible duplicate', hours: 1.5 }, { label: 'Staff review and merge', hours: 2 }, { label: 'Testing', hours: 0.5 }];
  const r = await estimate(1, 99, { lines });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(row(1).minutes, 240, 'the lines win over the single number');
  assert.equal(r.body.estimate.price_label, '$200');
  assert.deepEqual(r.body.estimate.lines.map(l => [l.label, l.hours_label]), [['Leads flag a possible duplicate', '1.5 hours'], ['Staff review and merge', '2 hours'], ['Testing', '30 minutes']]);
  assert.equal((await call('sam@uep.org', 'c/uep/items')).body.items.find(i => i.id === 1).estimate, null, 'a draft breakdown is Positive Tribes\' alone');
  await offer(1);
  const sam = (await call('sam@uep.org', 'c/uep/items')).body.items.find(i => i.id === 1).estimate;
  assert.equal(sam.lines.length, 3);
  for (const bad of [
    { lines: 'x' }, { lines: [{ label: '', hours: 1 }] }, { lines: [{ label: 'A', hours: 0.25 }] }, { lines: [{ label: 'x'.repeat(121), hours: 1 }] },
    { lines: Array.from({ length: 9 }, (_, n) => ({ label: 'L' + n, hours: 1 })) }, { lines: [{ label: 'A', hours: 150 }, { label: 'B', hours: 60 }] }, { lines: [null] }
  ]) assert.equal((await call(PT, 'admin/items/2/estimate', 'PUT', { hours: 1, ...bad })).status, 400, JSON.stringify(bad).slice(0, 60));
  assert.equal((await estimate(1, 2, { lines: [] })).status, 200, 'an empty breakdown goes back to a single number');
  assert.equal(row(1).minutes, 120);
  assert.equal(row(1).lines, '[]');
});

test('Patch is never given an estimate', () => {
  for (const file of ['../src/reply.js', '../src/patch.js']) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), 'utf8'), /change_estimates|estimatesFor|estimateView/, file);
  }
});
