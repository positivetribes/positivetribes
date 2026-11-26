import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { database } from './helpers.mjs';
import { runClientInstant, runClientDigest, ownedBy, setEmailPref } from '../src/clientmail.js';

// Tue 2026-11-24 10:00am MT (business hours); the events below are logged an hour earlier.
const T0 = Date.parse('2026-11-24T17:00:00Z');
const MONDAY = Date.parse('2026-11-30T14:00:00Z');

function setup(mode = 'preview') {
  const h = database();
  for (const f of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    h.sqlite.exec(readFileSync(new URL('../migrations/' + f, import.meta.url), 'utf8'));
  }
  h.sqlite.exec(`
    INSERT INTO clients (slug, name, email_mode, email_since) VALUES ('uep', 'UEP', '${mode}', '2026-11-20 00:00:00'), ('wfa', 'Wildlife for All', 'off', NULL);
    INSERT INTO projects (client_id, slug, name, position) VALUES (1, 'scheduler', 'Scheduler', 1), (2, 'tracker', 'Tracker', 1);
    INSERT INTO users (email, name, role, client_id) VALUES ('molly@uep.test', 'Molly Smith', 'ed', 1), ('tammie@uep.test', 'Tammie Jones', 'staff', 1),
      ('eric@pt.test', 'Eric Roberts', 'pt', NULL), ('mandy@wfa.test', 'Mandy', 'ed', 2);`);
  const alerts = [], client = [];
  const env = { DB: h.db, ALERT_TO: 'eric@example.org', ALERT_MAIL: { send: async m => { alerts.push(m); } }, CLIENT_MAIL: { send: async m => { client.push(m); } } };
  return { h, env, alerts, client };
}
const item = (h, { kind = 'question', title, owner = '', client = 1, done = 0, answer = '' }) =>
  Number(h.sqlite.prepare(`INSERT INTO items (client_id, project_id, kind, title, owner, tier, done, answer, position) VALUES (?, ?, ?, ?, ?, 'must', ?, ?, 1)`)
    .run(client, client, kind, title, owner, done, answer).lastInsertRowid);
const event = (h, { item: id, action, title, kind = 'question', actor = 'eric@pt.test', at = '2026-11-24 16:00:00', client = 1 }) =>
  h.sqlite.prepare('INSERT INTO events (client_id, item_id, action, item_title, item_kind, actor_email, at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(client, id, action, title, kind, actor, at);

test('owner matching is whole words on the first name', () => {
  assert.equal(ownedBy('Molly', 'Molly Smith'), true);
  assert.equal(ownedBy('Molly / Tammie', 'Tammie Jones'), true);
  assert.equal(ownedBy('Sally', 'Al Green'), false);
  assert.equal(ownedBy('', 'Molly'), false);
  assert.equal(ownedBy('Molly', ''), false);
});

test('preview: a question named for one person goes to Eric, once, naming that person; other clients stay quiet', async () => {
  const { h, env, alerts, client } = setup();
  const q = item(h, { title: 'Which reminder time?', owner: 'Molly' });
  event(h, { item: q, action: 'added', title: 'Which reminder time?' });
  const w = item(h, { title: 'WFA question', owner: 'Mandy', client: 2 });
  event(h, { item: w, action: 'added', title: 'WFA question', client: 2 });
  const r = await runClientInstant(env, T0);
  assert.equal(r.previewed, 1);
  assert.equal(client.length, 0, 'preview never reaches the client');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].to, 'eric@example.org');
  assert.match(alerts[0].subject, /^\[Preview for Molly Smith, molly@uep\.test\] A question for you: “Which reminder time\?”$/);
  assert.match(alerts[0].text, /https:\/\/hub\.positivetribes\.org\/#\/uep\/backlog\/\d+/);
  assert.doesNotMatch(alerts[0].text, /WFA/);
  await runClientInstant(env, T0 + 3600e3);
  assert.equal(alerts.length, 1, 'not sent twice');
});

test('live: phases, estimates for the decider only, testing ending; nothing the person did themselves', async () => {
  const { h, env, client } = setup('live');
  const c = item(h, { kind: 'change', title: 'Add a column' });
  h.sqlite.exec(`INSERT INTO change_estimates (item_id, client_id, minutes, rate_cents, price_cents, credits, status) VALUES (${c}, 1, 60, 5000, 5000, 2, 'offered')`);
  event(h, { item: c, action: 'estimate_offered', title: 'Add a column', kind: 'change' });
  h.sqlite.exec(`INSERT INTO releases (client_id, project_id, number, name, stage, uat_started, uat_days) VALUES (1, 1, 3, 'Phase 3', 'uat', '2026-11-01', 25)`);
  // The insert trigger (migration 0012) logs uat_started; date it inside the window.
  h.sqlite.exec("UPDATE events SET at = '2026-11-24 16:00:00', actor_email = '' WHERE action = 'uat_started'");
  const own = item(h, { title: 'Tammie asks', owner: 'Tammie' });
  event(h, { item: own, action: 'added', title: 'Tammie asks', actor: 'tammie@uep.test' });
  await runClientInstant(env, T0);
  const molly = client.find(m => m.to.email === 'molly@uep.test'), tammie = client.find(m => m.to.email === 'tammie@uep.test');
  assert.equal(client.length, 2);
  assert.equal(molly.from.email, 'hello@positivetribes.org');
  assert.equal(molly.replyTo, 'eric@positivetribes.org');
  assert.equal(molly.bcc, undefined, 'no blind copy unless CLIENT_MAIL_BCC is set');
  assert.match(molly.subject, /^3 updates on your UEP hub$/);
  assert.match(molly.text, /An estimate for you to decide: “Add a column”/);
  assert.match(molly.text, /Scheduler Phase 3 is ready for you to test/, 'the phase names its project');
  assert.match(molly.text, /Testing for Scheduler Phase 3 ends Thu, Nov 26/);
  assert.doesNotMatch(tammie.text, /estimate/, 'staff do not decide estimates');
  assert.doesNotMatch(tammie.text, /Tammie asks/, 'her own question is not news to her');
  assert.doesNotMatch(molly.text, /5000|\$/, 'no prices in email');
});

test('events from before the client was turned on, answered questions, and people who chose weekly or off get no instant email', async () => {
  const { h, env, alerts } = setup();
  const old = item(h, { title: 'Old', owner: 'Molly' });
  event(h, { item: old, action: 'added', title: 'Old', at: '2026-11-19 12:00:00' });
  const answered = item(h, { title: 'Answered already', owner: 'Molly', answer: 'Yes' });
  event(h, { item: answered, action: 'added', title: 'Answered already' });
  const t = item(h, { title: 'For Tammie', owner: 'Tammie' });
  event(h, { item: t, action: 'added', title: 'For Tammie' });
  await setEmailPref(h.db, { id: 2 }, 'weekly');
  await runClientInstant(env, T0);
  assert.equal(alerts.length, 0);
});

test('outside business hours nothing is sent', async () => {
  const { h, env, alerts } = setup();
  const q = item(h, { title: 'Late night', owner: 'Molly' });
  event(h, { item: q, action: 'added', title: 'Late night' });
  assert.equal((await runClientInstant(env, Date.parse('2026-11-25T05:00:00Z'))).ran, false);
  assert.equal(alerts.length, 0);
});

test('a failed send is retried next run and reported to Eric once a day', async () => {
  const { h, env, client, alerts } = setup('live');
  const q = item(h, { title: 'Pick a color', owner: 'Molly' });
  event(h, { item: q, action: 'added', title: 'Pick a color' });
  let fail = true;
  env.CLIENT_MAIL = { send: async m => { if (fail) throw new Error('E_SENDER_NOT_VERIFIED'); client.push(m); } };
  let r = await runClientInstant(env, T0);
  assert.equal(r.failed, 1);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].subject, /Client email: 1 instant email failed/);
  assert.doesNotMatch(alerts[0].text, /Pick a color|molly/, 'no client content in the failure report');
  r = await runClientInstant(env, T0 + 3600e3);
  assert.equal(alerts.length, 1, 'reported once a day');
  fail = false;
  r = await runClientInstant(env, T0 + 7200e3);
  assert.equal(r.sent, 1);
  assert.equal(client.length, 1);
});

test('CLIENT_MAIL_BCC puts Eric on every live email as a blind copy; preview needs none', async () => {
  const { h, env, client, alerts } = setup('live');
  env.CLIENT_MAIL_BCC = 'eric@positivetribes.org';
  const q = item(h, { title: 'Pick a font', owner: 'Molly' });
  event(h, { item: q, action: 'added', title: 'Pick a font' });
  await runClientInstant(env, T0);
  assert.equal(client.length, 1);
  assert.equal(client[0].bcc, 'eric@positivetribes.org');
  assert.equal(client[0].to.email, 'molly@uep.test');
  assert.doesNotMatch(client[0].text, /eric@/, 'the copy is blind');
  env.CLIENT_MAIL_BCC = 'not an address';
  h.sqlite.exec("DELETE FROM email_log");
  await runClientInstant(env, T0 + 3600e3);
  assert.equal(client[1].bcc, undefined, 'a bad value is ignored');
  assert.equal(alerts.length, 0);
});

test('email off for a client sends nothing, even with news', async () => {
  const { h, env, alerts, client } = setup('off');
  const q = item(h, { title: 'Quiet', owner: 'Molly' });
  event(h, { item: q, action: 'added', title: 'Quiet' });
  await runClientInstant(env, T0);
  await runClientDigest(env, MONDAY);
  assert.equal(alerts.length + client.length, 0);
});

test('Monday summary: waiting on you, in testing and finished; skipped when empty; once a week', async () => {
  const { h, env, client } = setup('live');
  item(h, { title: 'Pick reminder time', owner: 'Molly' });
  item(h, { kind: 'change', title: 'Undecided idea', owner: 'Molly' });
  item(h, { title: 'Closed one', owner: 'Molly', done: 1 });
  const d = item(h, { kind: 'change', title: 'Shipped change', done: 1 });
  event(h, { item: d, action: 'done', title: 'Shipped change', kind: 'change', at: '2026-11-27 15:00:00' });
  event(h, { item: d, action: 'done', title: 'Too old', kind: 'change', at: '2026-11-10 15:00:00' });
  h.db.prepare("UPDATE users SET email_pref = 'off' WHERE id = 2").run();
  let r = await runClientDigest(env, MONDAY);
  assert.equal(r.sent, 1);
  const m = client[0];
  assert.equal(m.to.email, 'molly@uep.test');
  assert.equal(m.subject, 'Your week on the UEP hub: 2 waiting on you');
  assert.match(m.text, /Waiting on you \(2\):\n- “Pick reminder time”/);
  assert.match(m.text, /To decide: “Undecided idea”/);
  assert.match(m.text, /Finished last week:\n- Shipped change/);
  assert.doesNotMatch(m.text, /Closed one|Too old/);
  assert.match(m.html, /<a href="https:\/\/hub\.positivetribes\.org\/#\/uep\/backlog\/1"/);
  r = await runClientDigest(env, MONDAY + 3600e3);
  assert.equal(client.length, 1, 'once per week');
  h.db.prepare("UPDATE users SET email_pref = 'weekly' WHERE id = 2").run();
  r = await runClientDigest(env, MONDAY + 7200e3);
  assert.equal(client.length, 2, 'Tammie gets finished work even with nothing waiting');
  assert.equal(client[1].subject, 'Your week on the UEP hub');
});

test('titles are escaped in the HTML and cannot break the subject line', async () => {
  const { h, env, client } = setup('live');
  const q = item(h, { title: 'Bad <script>alert(1)</script>\r\nBcc: x@y.z', owner: 'Molly' });
  event(h, { item: q, action: 'added', title: 'Bad <script>alert(1)</script>\r\nBcc: x@y.z' });
  await runClientInstant(env, T0);
  assert.doesNotMatch(client[0].html, /<script>/);
  assert.doesNotMatch(client[0].subject, /[\r\n]/);
});

test('a person can only pick all, weekly or off', async () => {
  const { h } = setup();
  assert.equal(await setEmailPref(h.db, { id: 1 }, 'daily'), false);
  assert.equal(await setEmailPref(h.db, { id: 1 }, 'off'), true);
  assert.equal(h.sqlite.prepare('SELECT email_pref FROM users WHERE id = 1').get().email_pref, 'off');
  assert.equal(h.sqlite.prepare('SELECT email_pref FROM users WHERE id = 2').get().email_pref, 'all');
});

test('a question added Friday evening still reaches the person on Monday morning', async () => {
  const { h, env, alerts } = setup();
  const q = item(h, { title: 'Weekend question', owner: 'Molly' });
  event(h, { item: q, action: 'added', title: 'Weekend question', at: '2026-11-28 01:15:00' }); // Fri 6:15pm MT
  await runClientInstant(env, Date.parse('2026-11-30T15:30:00Z')); // Mon 8:30am MT, the first run after the weekend
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].subject, /Weekend question/);
});

test('an error with one client stops only that client, and Eric is told', async () => {
  const { h, env, alerts } = setup();
  h.sqlite.exec("UPDATE clients SET email_mode = 'preview', email_since = '2026-11-20 00:00:00' WHERE id = 2");
  for (const c of [1, 2]) { const q = item(h, { title: 'Q' + c, owner: c === 1 ? 'Molly' : 'Mandy', client: c }); event(h, { item: q, action: 'added', title: 'Q' + c, client: c }); }
  const real = env.DB;
  env.DB = { ...real, batch: real.batch.bind(real), prepare: sql => {
    const st = real.prepare(sql);
    if (!sql.includes('FROM care_plans')) return st;
    return { bind: (...a) => a[0] === 1 ? { first: async () => { throw new Error('D1_ERROR: boom'); } } : st.bind(...a) };
  } };
  const r = await runClientInstant(env, T0);
  assert.equal(r.previewed, 1, 'the second client still gets its email');
  assert.match(alerts[0].subject, /Preview for Mandy/);
  assert.equal(alerts.length, 2);
  assert.match(alerts[1].subject, /^Client email: the instant run hit a problem$/);
  assert.match(alerts[1].text, /uep: stopped: D1_ERROR: boom/);
});

test('the log is written before sending: no log, no send; sent but unrecorded is never sent again', async () => {
  const { h, env, client, alerts } = setup('live');
  const q = item(h, { title: 'Log me', owner: 'Molly' });
  event(h, { item: q, action: 'added', title: 'Log me' });
  const real = env.DB;
  let calls = 0, failOn = 1;
  env.DB = { prepare: real.prepare.bind(real), batch: async st => { calls++; if (calls === failOn) throw new Error('D1_ERROR: busy'); return real.batch(st); } };
  let r = await runClientInstant(env, T0);
  assert.equal(client.length, 0, 'nothing sent when the log could not be written first');
  assert.equal(r.failed, 1);
  calls = 0; failOn = 2;
  r = await runClientInstant(env, T0 + 3600e3);
  assert.equal(client.length, 1, 'sent once the log is written');
  assert.match(r.errors.join('\n'), /uep: sent but email_log still says pending/);
  assert.equal(h.sqlite.prepare('SELECT status FROM email_log').get().status, 'pending');
  calls = 0; failOn = 0;
  await runClientInstant(env, T0 + 7200e3);
  assert.equal(client.length, 1, 'pending is never resent');
  assert.equal(alerts.length, 1, 'Eric hears once a day');
});

test('Monday summary: nothing from before the client was turned on, and no testing window that has ended', async () => {
  const { h, env, client } = setup('live');
  h.sqlite.exec("UPDATE clients SET email_since = '2026-11-26 00:00:00' WHERE id = 1");
  const d = item(h, { kind: 'change', title: 'Before turn-on', done: 1 });
  event(h, { item: d, action: 'done', title: 'Before turn-on', kind: 'change', at: '2026-11-25 15:00:00' });
  h.sqlite.exec(`INSERT INTO releases (client_id, project_id, number, name, stage, uat_started, uat_days) VALUES (1, 1, 2, 'Phase 2', 'uat', '2026-10-01', 30)`);
  let r = await runClientDigest(env, MONDAY);
  assert.equal(client.length, 0, 'nothing left to say');
  h.sqlite.exec(`INSERT INTO releases (client_id, project_id, number, name, stage, uat_started, uat_days) VALUES (1, 1, 3, 'Phase 3', 'live', '2026-10-01', 30)`);
  h.sqlite.exec("UPDATE events SET at = '2026-11-27 16:00:00' WHERE action = 'live'");
  h.sqlite.exec("DELETE FROM email_log");
  r = await runClientDigest(env, MONDAY);
  assert.match(client[0].text, /Finished last week:\n- Scheduler Phase 3\n/);
  assert.doesNotMatch(client[0].text, /Before turn-on|Phase 2/);
});
