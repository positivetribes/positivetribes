import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { database } from './helpers.mjs';
import { balanceOf, endOfMonth, addMonths, ensureGrants, todayUtc, monthOf } from '../src/care.js';

const UEP_ACCOUNT = '001Pr00000yy8o9IAA', SAFE_ACCOUNT = '001Pr00000yyXUuIAM';
const OPP = '006Pr00000AbCdEIAZ', OTHER_OPP = '006Pr00000ZzZzZIAZ';

// ---- The credit rules, as pure functions ----

const row = (id, kind, credits, at, expires_on = null, month = at.slice(0, 7)) => ({ id, kind, credits, at, expires_on, month });

test('monthly credits roll over one month, then end', () => {
  assert.equal(endOfMonth('2026-11', 1), '2026-12-31');
  assert.equal(endOfMonth('2027-01', 1), '2027-02-28');
  assert.equal(addMonths('2026-12', 1), '2027-01');
  const ledger = [row(1, 'grant', 6, '2026-10-01 00:00:00', '2026-11-30'), row(2, 'grant', 6, '2026-11-01 00:00:00', '2026-12-31')];
  assert.equal(balanceOf(ledger, '2026-11-15').available, 12);
  assert.equal(balanceOf(ledger, '2026-11-15').expiringSoon, 6);
  // October's credits are gone in December.
  assert.equal(balanceOf(ledger, '2026-12-01').available, 6);
});

test('spends use the credits that end soonest: rollover first, boost packs last', () => {
  const ledger = [
    row(1, 'boost', 8, '2026-10-05 10:00:00', '2027-10-05'),
    row(2, 'grant', 6, '2026-10-01 00:00:00', '2026-11-30'),
    row(3, 'grant', 6, '2026-11-01 00:00:00', '2026-12-31'),
    row(4, 'spend', -8, '2026-11-10 10:00:00')
  ];
  const b = balanceOf(ledger, '2026-11-15');
  assert.equal(b.available, 12);
  assert.equal(b.boost, 8, 'boost untouched while monthly credits remain');
  assert.equal(b.monthly, 4);
  assert.equal(b.usedThisMonth, 8);
  // Spending past every monthly credit reaches the boost pack.
  const more = balanceOf([...ledger, row(5, 'spend', -6, '2026-11-12 10:00:00')], '2026-11-15');
  assert.deepEqual([more.monthly, more.boost, more.available], [0, 6, 6]);
});

test('a refund comes back as credits; an overdraft is owed from the next grant', () => {
  const ledger = [row(1, 'grant', 2, '2026-11-01 00:00:00', '2026-12-31'), row(2, 'spend', -4, '2026-11-03 00:00:00')];
  assert.equal(balanceOf(ledger, '2026-11-15').available, 0);
  assert.equal(balanceOf(ledger, '2026-11-15').owed, 2);
  const next = [...ledger, row(3, 'grant', 2, '2026-12-01 00:00:00', '2027-01-31')];
  assert.equal(balanceOf(next, '2026-12-02').available, 0);
  const refunded = [row(1, 'grant', 2, '2026-11-01 00:00:00', '2026-12-31'), row(2, 'spend', -2, '2026-11-03 00:00:00'), row(3, 'refund', 2, '2026-11-04 00:00:00', '2026-12-31')];
  assert.equal(balanceOf(refunded, '2026-11-15').available, 2);
  assert.equal(balanceOf(refunded, '2026-11-15').usedThisMonth, 0);
});

// ---- Through the Worker, against the real migrations ----

function setup({ live = true, active = true } = {}) {
  const { sqlite, db } = database();
  const files = readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort();
  for (const file of files) sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  sqlite.exec(`
    INSERT INTO clients (slug, name, salesforce_account_id) VALUES ('uep', 'UEP', '${UEP_ACCOUNT}'), ('safe', 'Sober AF', '${SAFE_ACCOUNT}');
    INSERT INTO projects (client_id, slug, name, phase, opportunity_won) VALUES (1, 'scheduler', 'Scheduler', '${live ? 'support' : 'build'}', ${live ? 1 : 0}), (1, 'fundraising', 'Fundraising', 'build', 0), (2, 'chapters', 'Chapters', 'support', 1);
    INSERT INTO users (email, name, role, client_id) VALUES
      ('molly@uep.org', 'Molly', 'ed', 1), ('sam@uep.org', 'Sam', 'staff', 1), ('kim@uep.org', 'Kim', 'staff', 1),
      ('eric@positivetribes.org', 'Eric', 'pt', NULL), ('dana@safe.org', 'Dana', 'ed', 2);
  `);
  const start = monthOf(todayUtc()) + '-01';
  const checklist = `'${start}', 'https://github.com/positivetribes/uep', 'uep-preview-db', 1, 'v1'`;
  sqlite.exec(`
    INSERT INTO care_plans (client_id, tier, monthly_credits, status, starts_on, repo_url, test_db, test_signins_ok, rules_version, balance_contact_user_id)
      VALUES (1, 'essentials', 2, '${active ? 'active' : 'setup'}', ${checklist}, 3),
             (2, 'care', 6, 'active', ${checklist}, NULL);
  `);
  let fakeSalesforce = null;
  const env = { DB: db, ADMIN_DB: database().db, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') } };
  const call = async (who, path, method = 'GET', payload, { origin = 'http://localhost' } = {}) => {
    const r = await worker.fetch(new Request('http://localhost/api/' + path, {
      method,
      headers: { 'x-dev-email': who, 'content-type': 'application/json', ...(origin && method !== 'GET' ? { origin } : {}) },
      body: payload ? JSON.stringify(payload) : undefined
    }), env);
    return { status: r.status, body: await r.json() };
  };
  const request = async (who = 'sam@uep.org', title = 'Add a waitlist') => {
    const r = await call(who, 'c/uep/items', 'POST', { title, project_id: 1, care: true });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return sqlite.prepare('SELECT item_id FROM care_requests ORDER BY item_id DESC LIMIT 1').get().item_id;
  };
  const triage = (id, payload) => call('eric@positivetribes.org', `c/uep/care/${id}/triage`, 'POST', payload);
  const ledger = () => sqlite.prepare('SELECT kind, credits, item_id FROM credit_ledger WHERE client_id = 1 ORDER BY id').all().map(r => ({ ...r }));
  return { sqlite, env, call, request, triage, ledger, sf: fn => { fakeSalesforce = fn; }, get fakeSalesforce() { return fakeSalesforce; } };
}

test('requests open only on a live tool with an active plan', async () => {
  const { call } = setup();
  assert.equal((await call('sam@uep.org', 'c/uep/items', 'POST', { title: 'x', project_id: 2, care: true })).status, 409, 'tool not live');
  assert.equal((await setup({ active: false }).call('sam@uep.org', 'c/uep/items', 'POST', { title: 'x', project_id: 1, care: true })).status, 409, 'plan in setup');
  assert.equal((await setup({ live: false }).call('sam@uep.org', 'c/uep/items', 'POST', { title: 'x', project_id: 1, care: true })).status, 409, 'not sold and released');
  // And the plan does not show in a client's hub before it is active.
  assert.equal((await setup({ active: false }).call('molly@uep.org', 'c/uep/care')).body.plan, null);
});

test('only the director and the named contact see the balance; staff see status, size and cost', async () => {
  const { call, request, triage } = setup();
  const id = await request();
  await triage(id, { type: 'improvement', size: 'M' });
  for (const who of ['molly@uep.org', 'kim@uep.org', 'eric@positivetribes.org']) {
    const view = (await call(who, 'c/uep/care')).body;
    assert.equal(view.balance.available, 2, who);
    assert.ok(Array.isArray(view.history), who);
  }
  const staff = (await call('sam@uep.org', 'c/uep/care')).body;
  assert.equal(staff.balance, null);
  assert.equal(staff.history, null);
  assert.equal(staff.canConfirm, false);
  assert.equal(staff.requests[0].cost, 'M · 2 credits');
  assert.equal(staff.requests[0].status, 'awaiting_confirm');
  // The bell carries the cost but never a balance.
  const bell = (await call('sam@uep.org', 'notifications')).body.items.find(i => i.action === 'triaged');
  assert.match(bell.detail, /M · 2 credits/);
  assert.doesNotMatch(bell.detail, /left|available|balance/i);
});

test('credits are used only when the director confirms, once, even if confirmed twice', async () => {
  const { call, request, triage, ledger } = setup();
  const id = await request();
  await triage(id, { type: 'improvement', size: 'M' });
  assert.equal(ledger().filter(r => r.kind === 'spend').length, 0, 'nothing used before confirming');
  assert.equal((await call('sam@uep.org', `c/uep/care/${id}/confirm`, 'POST', {})).status, 403, 'staff cannot confirm');
  assert.equal((await call('eric@positivetribes.org', `c/uep/care/${id}/confirm`, 'POST', {})).status, 403, 'Positive Tribes never confirms for the client');
  assert.equal((await call('molly@uep.org', `c/uep/care/${id}/confirm`, 'POST', {}, { origin: 'https://evil.example' })).status, 403, 'other sites cannot');
  const ok = await call('molly@uep.org', `c/uep/care/${id}/confirm`, 'POST', {});
  assert.equal(ok.status, 200);
  assert.equal(ok.body.care.balance.available, 0);
  assert.equal((await call('molly@uep.org', `c/uep/care/${id}/confirm`, 'POST', {})).status, 409);
  assert.deepEqual(ledger().filter(r => r.kind === 'spend'), [{ kind: 'spend', credits: -2, item_id: id }]);
});

test('the database itself refuses a second spend for the same request, even with the status guard bypassed', async () => {
  const { sqlite, request } = setup();
  const id = await request();
  sqlite.exec(`INSERT INTO credit_ledger (client_id, care_plan_id, kind, credits, month, item_id) VALUES (1, 1, 'spend', -1, '2026-11', ${id})`);
  assert.throws(() => sqlite.exec(`INSERT INTO credit_ledger (client_id, care_plan_id, kind, credits, month, item_id) VALUES (1, 1, 'spend', -1, '2026-11', ${id})`), /UNIQUE/);
});

test('running out never blocks: the request waits for credits at no cost', async () => {
  const { call, request, triage, ledger } = setup();
  const id = await request();
  await triage(id, { type: 'improvement', size: 'L' });
  const r = await call('molly@uep.org', `c/uep/care/${id}/confirm`, 'POST', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.waiting, true);
  assert.equal(r.body.care.requests[0].status, 'waiting_credits');
  assert.equal(ledger().filter(r => r.kind === 'spend').length, 0);
  // A boost pack lets it go ahead.
  assert.equal((await call('eric@positivetribes.org', 'admin/care/1/boost', 'POST', {})).status, 201);
  const later = await call('molly@uep.org', `c/uep/care/${id}/confirm`, 'POST', {});
  assert.equal(later.body.care.requests[0].status, 'queued');
  assert.equal(later.body.care.balance.available, 4);
});

test('fixes are free and skip the confirm step; new projects use nothing', async () => {
  const { request, triage, ledger, call } = setup();
  const fix = await request('sam@uep.org', 'Button broken');
  const r = await triage(fix, { type: 'fix' });
  assert.equal(r.body.care.requests[0].status, 'queued');
  assert.equal(r.body.care.requests[0].cost, 'Fix · free');
  const big = await request('sam@uep.org', 'A whole donor portal');
  assert.equal((await triage(big, { type: 'project' })).body.care.requests[0].status, 'declined');
  assert.equal(ledger().filter(x => x.kind === 'spend').length, 0);
  // Shipping marks the item done and counts on the meter.
  const shipped = await call('eric@positivetribes.org', `c/uep/care/${fix}/ship`, 'POST', {});
  assert.equal(shipped.body.care.shippedThisMonth, 1);
});

test('courtesy edits are always free, and an edit is counted only once', async () => {
  const { request, triage, ledger } = setup();
  const ids = [];
  for (let n = 1; n <= 6; n++) ids.push(await request('sam@uep.org', 'Typo ' + n));
  for (const id of ids) assert.equal((await triage(id, { type: 'courtesy' })).status, 200);
  assert.equal(ledger().filter(r => r.kind === 'courtesy').length, 6);
  assert.deepEqual(ledger().filter(r => r.kind === 'spend'), []);
  assert.equal((await triage(ids[0], { type: 'courtesy' })).status, 409);
});

test('cancelling a confirmed request returns its credits', async () => {
  const { call, request, triage } = setup();
  const id = await request();
  await triage(id, { type: 'improvement', size: 'S' });
  await call('molly@uep.org', `c/uep/care/${id}/confirm`, 'POST', {});
  assert.equal((await call('eric@positivetribes.org', `c/uep/items/${id}`, 'DELETE')).status, 409, 'cannot delete with credits held');
  const r = await call('eric@positivetribes.org', `c/uep/care/${id}/cancel`, 'POST', {});
  assert.equal(r.body.care.balance.available, 2);
  assert.equal((await call('eric@positivetribes.org', `c/uep/items/${id}`, 'DELETE')).status, 200);
});

test('returned boost credits keep their year, and a refund of last month\'s spend does not count against this month', () => {
  const ledger = [
    row(1, 'grant', 1, '2026-11-01 00:00:00', '2026-12-31'),
    row(2, 'boost', 8, '2026-11-02 00:00:00', '2027-11-02'),
    { ...row(3, 'spend', -4, '2026-11-03 00:00:00'), item_id: 9 }
  ];
  const b = balanceOf(ledger, '2026-11-15');
  assert.deepEqual(b.drawn[3], [{ credits: 1, expires: '2026-12-31' }, { credits: 3, expires: '2027-11-02' }]);
  // Refunded with the latest end date it drew from (one refund row per request, so the client never loses time),
  // the credits count as boost and are still used last: 5 left in the pack plus the 4 returned.
  const back = balanceOf([...ledger, { ...row(4, 'refund', 4, '2026-11-04 00:00:00', '2027-11-02'), item_id: 9 }], '2027-03-01');
  assert.equal(back.boost, 9);
  assert.equal(back.monthly, 0);
  const later = balanceOf([
    row(1, 'grant', 6, '2026-11-01 00:00:00', '2026-12-31'), { ...row(2, 'spend', -2, '2026-11-20 00:00:00'), item_id: 9 },
    row(3, 'grant', 6, '2026-12-01 00:00:00', '2027-01-31'), { ...row(4, 'refund', 2, '2026-12-02 00:00:00', '2027-01-31'), item_id: 9 }
  ], '2026-12-05');
  assert.equal(later.usedThisMonth, 0);
});

test('cancelling a request paid from a boost pack returns boost credits that last the pack\'s year', async () => {
  const { call, request, triage, sqlite } = setup();
  assert.equal((await call('eric@positivetribes.org', 'admin/care/1/boost', 'POST', {})).status, 201);
  const id = await request();
  await triage(id, { type: 'improvement', size: 'L' });
  await call('molly@uep.org', `c/uep/care/${id}/confirm`, 'POST', {});
  const r = await call('eric@positivetribes.org', `c/uep/care/${id}/cancel`, 'POST', {});
  assert.equal(r.body.care.balance.available, 8);
  const boostEnd = sqlite.prepare("SELECT expires_on FROM credit_ledger WHERE kind = 'boost'").get().expires_on;
  assert.equal(sqlite.prepare("SELECT expires_on FROM credit_ledger WHERE kind = 'refund'").get().expires_on, boostEnd);
  // The cancelled request is closed on the list too.
  assert.equal(sqlite.prepare('SELECT done FROM items WHERE id = ?').get(id).done, 1);
});

test('a care request closes only through its own steps and stays on its tool', async () => {
  const { call, request, triage, sqlite } = setup();
  const id = await request();
  assert.equal((await call('sam@uep.org', `c/uep/items/${id}`, 'PATCH', { done: true })).status, 409);
  assert.equal((await call('eric@positivetribes.org', `c/uep/items/${id}`, 'PATCH', { project_id: 2 })).status, 409);
  assert.equal((await call('sam@uep.org', `c/uep/items/${id}`, 'PATCH', { details: 'More detail' })).status, 200, 'other edits are fine');
  await triage(id, { type: 'improvement', size: 'S' });
  assert.equal((await call('molly@uep.org', `c/uep/care/${id}/decline`, 'POST', {})).status, 200);
  assert.equal(sqlite.prepare('SELECT done FROM items WHERE id = ?').get(id).done, 1, 'declining closes it');
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE item_id = ? AND action = 'declined'").get(id).n, 1);
  assert.equal((await call('molly@uep.org', `c/uep/care/${id}/decline`, 'POST', {})).status, 409);
});

test('a confirm for a size the request no longer has spends nothing', async () => {
  const { call, request, triage, sqlite, ledger, env } = setup();
  const id = await request();
  await triage(id, { type: 'improvement', size: 'S' });
  // As if the request were re-sorted to L after the confirm read it and before its batch ran.
  const batch = env.DB.batch;
  env.DB.batch = statements => { sqlite.exec(`UPDATE care_requests SET size = 'L', credits = 4 WHERE item_id = ${id}`); env.DB.batch = batch; return batch(statements); };
  const r = await call('molly@uep.org', `c/uep/care/${id}/confirm`, 'POST', {});
  assert.equal(r.status, 409);
  assert.equal(ledger().filter(x => x.kind === 'spend').length, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE action = 'confirmed'").get().n, 0);
});

test('turning a plan on never grants months before today', async () => {
  const { call, sqlite } = setup({ active: false });
  sqlite.exec("UPDATE care_plans SET starts_on = '2025-01-01' WHERE client_id = 1");
  const on = await call('eric@positivetribes.org', 'admin/care/1', 'PUT', { tier: 'care', status: 'active', startsOn: '2025-01-01', repoUrl: 'https://github.com/x/y', testDb: 'db', testSigninsOk: true, rulesVersion: 'v1', balanceContactEmail: 'kim@uep.org' });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(sqlite.prepare('SELECT starts_on FROM care_plans WHERE client_id = 1').get().starts_on, todayUtc());
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE client_id = 1 AND kind = 'grant'").get().n, 1);
  // An active plan keeps its start date even if a later edit sends an older one.
  await call('eric@positivetribes.org', 'admin/care/1', 'PUT', { tier: 'care', status: 'active', startsOn: '2025-01-01', repoUrl: 'https://github.com/x/y', testDb: 'db', testSigninsOk: true, rulesVersion: 'v1', balanceContactEmail: 'kim@uep.org' });
  assert.equal(sqlite.prepare('SELECT starts_on FROM care_plans WHERE client_id = 1').get().starts_on, todayUtc());
});

test('the ledger cannot be edited or deleted', async () => {
  const { sqlite, env } = setup();
  await ensureGrants(env.DB, sqlite.prepare('SELECT * FROM care_plans WHERE id = 1').get(), todayUtc());
  await ensureGrants(env.DB, sqlite.prepare('SELECT * FROM care_plans WHERE id = 1').get(), todayUtc());
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE kind = 'grant' AND care_plan_id = 1").get().n, 1, 'one grant a month, however often it runs');
  assert.throws(() => sqlite.exec('UPDATE credit_ledger SET credits = 99'), /append-only/);
  assert.throws(() => sqlite.exec('DELETE FROM credit_ledger'), /append-only/);
  // A plan cannot go active with its checklist unfinished.
  assert.throws(() => sqlite.exec("UPDATE care_plans SET repo_url = '' WHERE id = 1"), /CHECK/);
});

test('one client never reaches another client\'s care requests or plan', async () => {
  const { call, request, triage } = setup();
  const id = await request();
  await triage(id, { type: 'improvement', size: 'S' });
  assert.equal((await call('dana@safe.org', 'c/uep/care')).status, 404);
  assert.equal((await call('dana@safe.org', `c/uep/care/${id}/confirm`, 'POST', {})).status, 404);
  // Through her own workspace, the item id is not hers either.
  assert.equal((await call('dana@safe.org', `c/safe/care/${id}/confirm`, 'POST', {})).status, 404);
  assert.equal((await call('molly@uep.org', 'admin/care')).status, 404, 'command center is Positive Tribes only');
});

test('command center: the overview, the go-live checklist, and the Opportunity link', async () => {
  const t = setup({ active: false });
  const { call } = t;
  const overview = (await call('eric@positivetribes.org', 'admin/care')).body;
  const uep = overview.clients.find(c => c.client.slug === 'uep');
  assert.equal(uep.plan.status, 'setup');
  assert.equal(uep.checklist.find(c => c.key === 'contact').done, true);
  // Activation is refused while something on the checklist is missing.
  const missing = await call('eric@positivetribes.org', 'admin/care/1', 'PUT', { tier: 'care', status: 'active', startsOn: '2026-11-01', repoUrl: 'https://github.com/x/y', testDb: 'db', testSigninsOk: false, rulesVersion: 'v1', balanceContactEmail: 'kim@uep.org' });
  assert.equal(missing.status, 409);
  assert.match(missing.body.error, /Test sign-ins/);
  // The balance contact must be this client's own person.
  assert.equal((await call('eric@positivetribes.org', 'admin/care/1', 'PUT', { tier: 'care', balanceContactEmail: 'dana@safe.org' })).status, 400);
  const on = await call('eric@positivetribes.org', 'admin/care/1', 'PUT', { tier: 'care', status: 'active', startsOn: '2026-11-01', repoUrl: 'https://github.com/x/y', testDb: 'db', testSigninsOk: true, rulesVersion: 'v1', balanceContactEmail: 'kim@uep.org' });
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.equal(on.body.clients.find(c => c.client.slug === 'uep').plan.monthly_credits, 6);

  // Opportunity: checked in Salesforce, and only one on this client's own Account.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.pathname === '/services/oauth2/token') return Response.json({ access_token: 't', instance_url: 'https://sf.example' });
    const q = url.searchParams.get('q');
    if (q.includes(OPP)) return Response.json({ records: [{ Id: OPP, AccountId: UEP_ACCOUNT, IsWon: true, StageName: 'Closed Won' }] });
    if (q.includes(OTHER_OPP)) return Response.json({ records: [{ Id: OTHER_OPP, AccountId: SAFE_ACCOUNT, IsWon: true, StageName: 'Closed Won' }] });
    return Response.json({ records: [] });
  };
  try {
    Object.assign(t.env, { SF_DOMAIN: 'https://sf.example', SF_CLIENT_ID: 'id', SF_CLIENT_SECRET: 'secret' });
    assert.equal((await call('eric@positivetribes.org', 'admin/projects/2/opportunity', 'PUT', { opportunityId: 'not-an-id' })).status, 400);
    assert.equal((await call('eric@positivetribes.org', 'admin/projects/2/opportunity', 'PUT', { opportunityId: OTHER_OPP })).status, 409);
    assert.equal((await call('eric@positivetribes.org', 'admin/projects/2/opportunity', 'PUT', { opportunityId: OPP }, { origin: 'https://evil.example' })).status, 403);
    const linked = await call('eric@positivetribes.org', 'admin/projects/2/opportunity', 'PUT', { opportunityId: OPP });
    assert.equal(linked.status, 200);
    assert.equal(t.sqlite.prepare('SELECT opportunity_won FROM projects WHERE id = 2').get().opportunity_won, 1);
  } finally { globalThis.fetch = realFetch; }
});

test('every client write must come from the hub itself, not another site', async () => {
  const { call } = setup();
  const evil = { origin: 'https://evil.example' };
  assert.equal((await call('molly@uep.org', 'c/uep/items', 'POST', { title: 'x', project_id: 1 }, evil)).status, 403);
  assert.equal((await call('molly@uep.org', 'c/uep/items/1', 'PATCH', { done: true }, evil)).status, 403);
  assert.equal((await call('molly@uep.org', 'ideas', 'POST', { title: 'x' }, evil)).status, 403);
  assert.equal((await call('molly@uep.org', 'notifications/read', 'POST', { all: true }, evil)).status, 403);
  assert.equal((await call('molly@uep.org', 'c/uep/items', 'POST', { title: 'Fine', project_id: 1 })).status, 201);
});
