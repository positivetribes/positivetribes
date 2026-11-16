import test from 'node:test';
import assert from 'node:assert/strict';
import { database } from './helpers.mjs';
import { planMoves, runEmailFiling, emailFilingOverview } from '../src/emailfix.js';

const WFA = '001Pr00001316M5IAI', COYOTE = '001Pr00000yyAOXIA2', UEP = '001Pr00000yy8o9IAA';
const COYOTE_OPP = '006Pr00000c7vX3IAI', UEP_OPP = '006Pr00000c8GsvIAE', UEP_OPP2 = '006Pr00000e0kBtIAI';
const MANDY = '003Pr000016hXnxIAE', RAINER = '003Pr000016NO5jIAG', MOLLY = '003Pr000012VvI6IAK';

const task = (id, who, whatId, whatType, whatName, accountId) =>
  ({ Id: id, Subject: 'Email: Re: Introduction', WhoId: who, WhatId: whatId, What: { Type: whatType, Name: whatName }, AccountId: accountId });
const contacts = new Map([
  [MANDY, { Name: 'Mandy Culbertson', AccountId: WFA, AccountName: 'Wildlife for All' }],
  [RAINER, { Name: 'Rainer Gerbatsch', AccountId: COYOTE, AccountName: 'Project Coyote' }],
  [MOLLY, { Name: 'Molly Cupka', AccountId: UEP, AccountName: "Up Ending Parkinson's" }]
]);

test('an email filed on another client moves to the contact\'s Account when it has no open Opportunity', () => {
  const moves = planMoves([task('00T1', MANDY, COYOTE_OPP, 'Opportunity', 'Project Coyote: Mange Tracking App', COYOTE)], contacts, new Set(), new Map());
  assert.equal(moves.length, 1);
  assert.deepEqual([moves[0].toId, moves[0].to, moves[0].from, moves[0].subject], [WFA, 'Wildlife for All', 'Project Coyote: Mange Tracking App', 'Re: Introduction']);
});

test('emails already on the contact\'s client, or where the contact has a role, stay put', () => {
  const tasks = [
    task('00T1', RAINER, COYOTE_OPP, 'Opportunity', 'Coyote', COYOTE),
    task('00T2', MOLLY, UEP_OPP, 'Opportunity', 'UEP', UEP),
    task('00T3', MOLLY, COYOTE_OPP, 'Opportunity', 'Coyote', COYOTE),
    task('00T4', '003Pr00000UNKNOWN', COYOTE_OPP, 'Opportunity', 'Coyote', COYOTE),
    task('00T5', MANDY, '500Pr0000000001AAA', 'Case', 'A case', COYOTE)
  ];
  assert.deepEqual(planMoves(tasks, contacts, new Set([MOLLY + ':' + COYOTE_OPP]), new Map()), []);
});

test('the target is the one open Opportunity, else the one with a role, else the Account', () => {
  const t = [task('00T1', MOLLY, COYOTE_OPP, 'Opportunity', 'Coyote', COYOTE)];
  const one = new Map([[UEP, [{ Id: UEP_OPP, Name: 'Scheduler' }]]]);
  const two = new Map([[UEP, [{ Id: UEP_OPP, Name: 'Scheduler' }, { Id: UEP_OPP2, Name: 'Virtuous' }]]]);
  assert.equal(planMoves(t, contacts, new Set(), one)[0].toId, UEP_OPP);
  assert.equal(planMoves(t, contacts, new Set([MOLLY + ':' + UEP_OPP2]), two)[0].toId, UEP_OPP2);
  assert.equal(planMoves(t, contacts, new Set(), two)[0].toId, UEP);
});

function salesforce(t, records, { patchFails = false } = {}) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const u = decodeURIComponent(String(input?.url || input));
    calls.push({ url: u, method: init.method || 'GET', body: init.body });
    const ok = b => new Response(b === null ? null : JSON.stringify(b), { status: b === null ? 204 : 200, headers: { 'content-type': 'application/json' } });
    if (u.includes('/oauth2/token')) return ok({ access_token: 'x', instance_url: 'https://sf.example' });
    if (init.method === 'PATCH') return patchFails ? new Response(JSON.stringify([{ message: 'nope' }]), { status: 400 }) : ok(null);
    if (u.includes('FROM Task')) return ok({ records: records.tasks });
    if (u.includes('FROM Contact')) return ok({ records: records.contacts });
    if (u.includes('FROM OpportunityContactRole')) return ok({ records: [] });
    if (u.includes('FROM Opportunity')) return ok({ records: [] });
    return new Response('{}', { status: 404 });
  };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}
const env = db => ({ ADMIN_DB: db, SF_DOMAIN: 'https://sf.example', SF_CLIENT_ID: 'id', SF_CLIENT_SECRET: 's', SF_TASK_SYNC_HOST: 'hub.positivetribes.org' });
const records = {
  tasks: [task('00TPr000018kL9IMAU', MANDY, COYOTE_OPP, 'Opportunity', 'Project Coyote: Mange Tracking App', COYOTE),
    task('00TPr000018kL9JMAU', RAINER, COYOTE_OPP, 'Opportunity', 'Project Coyote: Mange Tracking App', COYOTE)],
  contacts: [{ Id: MANDY, Name: 'Mandy Culbertson', AccountId: WFA, Account: { Name: 'Wildlife for All' } },
    { Id: RAINER, Name: 'Rainer Gerbatsch', AccountId: COYOTE, Account: { Name: 'Project Coyote' } }]
};

test('the nightly run moves only the misfiled Task, sets WhatId alone, and saves the run for Today', async t => {
  const { db } = database();
  const calls = salesforce(t, records);
  assert.deepEqual(await runEmailFiling(env(db), db), { ran: true, checked: 2, moved: 1, failed: 0 });
  const patches = calls.filter(c => c.method === 'PATCH');
  assert.equal(patches.length, 1);
  assert.ok(patches[0].url.endsWith('/sobjects/Task/00TPr000018kL9IMAU'));
  assert.deepEqual(JSON.parse(patches[0].body), { WhatId: WFA });
  const view = await emailFilingOverview(db);
  assert.equal(view.latest.moved, 1);
  assert.deepEqual(view.moves.map(m => [m.contact, m.to, m.ok]), [['Mandy Culbertson', 'Wildlife for All', true]]);
});

test('a failed move is saved as failed, and a failed run is saved with its error', async t => {
  const { db } = database();
  salesforce(t, records, { patchFails: true });
  assert.deepEqual(await runEmailFiling(env(db), db), { ran: true, checked: 2, moved: 0, failed: 1 });
  assert.equal((await emailFilingOverview(db)).moves[0].ok, false);
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'invalid_client' }), { status: 400 });
  await assert.rejects(runEmailFiling(env(db), db));
  assert.match((await emailFilingOverview(db)).latest.error, /sf_auth_invalid_client/);
});

test('it does nothing without Salesforce or off the production setup', async () => {
  const { db } = database();
  assert.deepEqual(await runEmailFiling({ ADMIN_DB: db }, db), { ran: false, reason: 'off' });
  assert.deepEqual(await runEmailFiling({ ...env(db), SF_TASK_SYNC_HOST: '' }, db), { ran: false, reason: 'off' });
  assert.equal(await emailFilingOverview(db), null);
});
