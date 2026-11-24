import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { database } from './helpers.mjs';
import { runSupportWatch } from '../src/supportwatch.js';
import { addBusinessHours } from '../src/businesshours.js';

function setup() {
  const h = database();
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    h.sqlite.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  }
  h.sqlite.exec(`
    INSERT INTO clients (slug, name, salesforce_account_id) VALUES ('uep', 'UEP', '001Pr00000yy8o9IAA'), ('wfa', 'Wildlife for All', '001Pr00001316M5IAI');
    INSERT INTO projects (client_id, slug, name, position, live_url) VALUES (1, 'scheduler', 'Scheduler', 1, 'https://x.test'), (2, 'tracker', 'Tracker', 1, 'https://y.test');`);
  const mail = [];
  const incidents = [];
  const env = {
    DB: h.db, ALERT_TO: 'eric@example.org', ALERT_MAIL: { send: async m => { mail.push(m); } },
    STATUS: { closedSince: async () => incidents, coverage: async () => ({ uep: 2 }) }
  };
  return { h, env, mail, incidents };
}
// Tue 2026-11-24 10:00am MT; an item created then is due Wed 10:00am MT.
const T0 = Date.parse('2026-11-24T17:00:00Z');
const add = (h, title, by = 'Mandy', kind = 'problem') =>
  h.sqlite.prepare(`INSERT INTO items (client_id, project_id, kind, title, tier, status, done, position, added_by, created_at) VALUES (2, 2, ?, ?, 'must', 'new', 0, 1, ?, '2026-11-24 17:00:00')`).run(kind, title, by);

test('quiet outside business hours', async () => {
  const { env, mail } = setup();
  assert.deepEqual(await runSupportWatch(env, Date.parse('2026-11-29T18:00:00Z')), { ran: false, reason: 'outside business hours' });
  assert.equal(mail.length, 0);
});

test('a reply due within 2 business hours, then late, emails once per stage; Eric\'s own items never do', async () => {
  const { h, env, mail } = setup();
  add(h, 'Embed is blank');
  add(h, 'Eric note', 'Eric Roberts');
  add(h, 'Please add a column', 'Kavya', 'request');
  let r = await runSupportWatch(env, T0 + 3600e3);
  assert.equal(mail.length, 1, 'only the coverage flag');
  assert.match(mail[0].text, /Wildlife for All: Tracker has a live address but no uptime check/);
  assert.doesNotMatch(mail[0].text, /Scheduler/);
  const soon = addBusinessHours(T0, 8.5); // Wed 8:30am MT
  r = await runSupportWatch(env, soon);
  assert.equal(r.soon, 2);
  assert.match(mail[1].subject, /2 due soon/);
  assert.match(mail[1].text, /Wildlife for All: Embed is blank\n  reply by Wed, Nov 25, 10:00am MT\n  https:\/\/hub\.positivetribes\.org\/#\/wfa\/backlog\/1/);
  assert.doesNotMatch(mail[1].text, /Eric note|uptime check/);
  await runSupportWatch(env, soon + 1800e3);
  assert.equal(mail.length, 2, 'no repeat in the same stage');
  r = await runSupportWatch(env, addBusinessHours(T0, 10.5));
  assert.equal(r.late, 2);
  assert.match(mail[2].subject, /^Support watch: 2 late$/);
  await runSupportWatch(env, addBusinessHours(T0, 12));
  assert.equal(mail.length, 3, 'late is sent once');
});

test('an answered item drops out', async () => {
  const { h, env, mail } = setup();
  add(h, 'Embed is blank');
  h.sqlite.exec("UPDATE items SET answer = 'Fixed, thanks' WHERE id = 1");
  await runSupportWatch(env, addBusinessHours(T0, 11));
  assert.equal(mail.filter(m => /late/.test(m.subject)).length, 0);
});

test('a failed email is retried next hour', async () => {
  const { h, env, mail } = setup();
  add(h, 'Embed is blank');
  const send = env.ALERT_MAIL.send;
  env.ALERT_MAIL.send = async () => { throw new Error('not verified'); };
  const r = await runSupportWatch(env, addBusinessHours(T0, 10.5));
  assert.equal(r.emailed, false);
  env.ALERT_MAIL.send = send;
  await runSupportWatch(env, addBusinessHours(T0, 11.5));
  assert.match(mail[0].text, /LATE/);
});

test('without Salesforce, a closed outage is reported instead of silently skipped', async () => {
  const { env, mail, incidents } = setup();
  incidents.push({ id: 7, client: 'uep', check_id: 'scheduler', checkName: 'Climb Scheduler', started: T0 / 1000 - 1800, ended: T0 / 1000 });
  const r = await runSupportWatch(env, T0 + 600e3);
  assert.equal(r.notes, 0);
  assert.match(r.errors[0], /outage 7: no Salesforce/);
  assert.match(mail[0].text, /could not finish/);
});

test('a closed outage becomes one Salesforce Task on the client Account, due 2 business days later', async () => {
  const { env, incidents } = setup();
  Object.assign(env, { SF_DOMAIN: 'https://sf.test', SF_CLIENT_ID: 'id', SF_CLIENT_SECRET: 'secret', SF_TASK_OWNER_ID: '005Hu00000QcVdBIAV' });
  incidents.push({ id: 7, client: 'uep', check_id: 'scheduler', checkName: 'Climb Scheduler', started: T0 / 1000 - 1800, ended: T0 / 1000 });
  const posted = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/oauth2/token')) return Response.json({ access_token: 't', instance_url: 'https://sf.test' });
    if (u.includes('/query?')) return Response.json({ records: [] });
    if (u.endsWith('/sobjects/Task')) { posted.push(JSON.parse(init.body)); return Response.json({ id: '00T1' }, { status: 201 }); }
    throw new Error('unexpected ' + u);
  };
  try {
    assert.equal((await runSupportWatch(env, T0 + 600e3)).notes, 1);
    await runSupportWatch(env, T0 + 4200e3);
  } finally { globalThis.fetch = real; }
  assert.equal(posted.length, 1, 'one Task per outage');
  assert.equal(posted[0].WhatId, '001Pr00000yy8o9IAA');
  assert.equal(posted[0].ActivityDate, '2026-11-26');
  assert.match(posted[0].Subject, /after-outage note in the hub for UEP: Climb Scheduler/);
  assert.match(posted[0].Description, /down about 30 minutes/);
});
