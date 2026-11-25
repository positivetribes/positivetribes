// Map step 3: the per-project view and its risk flags (src/map.js, GET /api/admin/map).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { database } from './helpers.mjs';
import { loadMap, risksFor, RISK } from '../src/map.js';

function setup() {
  const { sqlite, db } = database();
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  sqlite.exec(`
    INSERT INTO clients (slug, name, salesforce_account_id) VALUES ('uep', 'UEP', '001AAAAAAAAAAAAAAA'), ('safe', 'Sober AF', '001BBBBBBBBBBBBBBB');
    INSERT INTO projects (client_id, slug, name, phase, position) VALUES (1, 'scheduler', 'Scheduler', 'uat', 1), (1, 'fundraising', 'Fundraising', 'build', 2), (2, 'chapters', 'Chapters', 'prototype', 1);
    INSERT INTO users (email, name, role, client_id) VALUES ('molly@uep.org', 'Molly', 'ed', 1), ('eric@positivetribes.org', 'Eric', 'pt', NULL);
    INSERT INTO releases (client_id, project_id, number, stage, uat_started, uat_days, uat_day_type) VALUES
      (1, 1, 2, 'signed_off', '2026-11-04', 10, 'business'), (1, 1, 3, 'uat', '2026-11-15', 10, 'business');
    INSERT INTO timeline_entries (client_id, project_id, release_id, label, start_date, end_date, kind) VALUES
      (1, 1, 2, 'Phase 3 testing', '2026-11-15', '2026-11-27', 'work'), (1, 1, NULL, 'Pilot', '2027-01-11', '2027-01-29', 'work'),
      (1, NULL, NULL, 'Pages open', '2027-03-01', '2027-03-01', 'milestone'), (2, 3, NULL, 'Chapters build', '2026-12-01', '2027-01-15', 'work');
    INSERT INTO items (client_id, project_id, kind, title, tier, phase, position, due_date, created_at) VALUES
      (1, 1, 'question', 'Gym list', 'must', 'full', 1, '2026-11-10', '2026-11-01 10:00:00'),
      (1, 1, 'change', 'Bigger logo', 'nice', 'review', 2, '', '2026-11-20 10:00:00'),
      (1, 1, 'question', 'Answered in review', 'must', 'review', 3, '', '2026-11-01 10:00:00'),
      (1, 1, 'question', 'Answered in full', 'must', 'full', 4, '', '2026-11-01 10:00:00'),
      (2, 3, 'question', 'Other client secret', 'must', 'full', 1, '', '2026-11-01 10:00:00');
    UPDATE items SET answer = 'Yes', updated_at = '2026-11-20 09:00:00' WHERE title LIKE 'Answered%';
    INSERT INTO items (client_id, project_id, kind, title, tier, phase, position, answer, asks_back, created_at) VALUES
      (1, 1, 'question', 'Asked back', 'must', 'review', 5, 'Yes to 1; for 2, (a) or (b)?', 1, '2026-11-20 10:00:00');
    INSERT INTO requirements (client_id, project_id, ref, text, phase, state, cited, position) VALUES
      (1, 1, 'R1', 'Sign in', '2', 'agreed', 1, 1), (1, 1, 'R2', 'Roster email', '3', 'agreed', 1, 2), (1, 1, 'R3', 'Report', '3', 'agreed', 0, 3),
      (1, 1, 'P5', 'Text reminders', '4', 'proposed', 0, 4);
    INSERT INTO decisions (client_id, project_id, decided_on, decided_by, summary) VALUES (1, 1, '2026-11-18', 'Molly', 'Lead email 6 days out'), (1, NULL, '2026-11-06', 'Molly', 'Sync to Salesforce');
    INSERT INTO dependencies (client_id, blocker_kind, blocker_ref, blocked_kind, blocked_ref, kind, label, needed_by) VALUES
      (1, 'release', '1', 'timeline', '1', 'blocks', '', ''), (1, 'release', '1', 'timeline', '2', 'blocks', '', '2026-11-20'),
      (1, 'sf_task', '00TAAAAAAAAAAAAAAA', 'timeline', '2', 'needs_input', 'Jack approves terms', '2026-12-04'),
      (1, 'release', '2', 'timeline', '3', 'needs_signoff', '', '2026-11-20');
  `);
  const env = { DB: db, ADMIN_DB: database().db, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') } };
  const call = async who => {
    const r = await worker.fetch(new Request('http://localhost/api/admin/map', { headers: { 'x-dev-email': who } }), env);
    return { status: r.status, body: await r.json() };
  };
  return { db, call };
}

test('a card shows phase, now and next, current-phase requirements, waits, questions and decisions', async () => {
  const { db } = setup();
  const tasks = [
    { Id: '00T1', Subject: 'Reload demo', ActivityDate: '2026-11-20', IsClosed: false, AccountId: '001AAAAAAAAAAAAAAA' },
    { Id: '00T2', Subject: 'Call Molly', ActivityDate: '2026-11-25', IsClosed: false, AccountId: '001AAAAAAAAAAAAAAA' },
    { Id: '00T3', Subject: 'Done one', ActivityDate: '2026-11-01', IsClosed: true, AccountId: '001AAAAAAAAAAAAAAA' },
    { Id: '00T4', Subject: 'Other client', ActivityDate: '2026-11-01', IsClosed: false, AccountId: '001BBBBBBBBBBBBBBB' }];
  const map = await loadMap(db, { today: '2026-11-22', tasks });
  const uep = map.find(c => c.slug === 'uep');
  const s = uep.projects.find(p => p.slug === 'scheduler');
  assert.equal(s.phase.number, 3);
  assert.equal(s.phase.stage, 'uat');
  assert.equal(s.now.label, 'Phase 3 testing');
  assert.equal(s.next.label, 'Pilot');
  assert.deepEqual(s.requirements.current, { phase: 3, total: 2, built: 1, accepted: 0, in_uat: 0 });
  assert.deepEqual(s.requirements.proposed.map(r => r.ref), ['P5']);
  // Release 2 is signed off, so only the Jack Task (unknown done) is still waiting.
  assert.deepEqual(s.waiting.map(d => d.blocker.name), ['Jack approves terms']);
  assert.equal(s.waiting[0].late, false);
  // Answered questions (any phase) leave the waiting list and show as ready to close; they never count as undecided.
  // An answer that asks something back stays waiting on the client, not ready to close.
  assert.deepEqual(s.questions.map(q => q.title), ['Gym list', 'Asked back']);
  assert.deepEqual(s.to_close.map(q => q.title).sort(), ['Answered in full', 'Answered in review']);
  assert.equal(s.to_close[0].age, 2, 'age counts from the answer (updated_at)');
  assert.ok(s.risks.some(r => r.kind === 'answered_open' && /2 questions answered, ready to close/.test(r.text)));
  assert.equal(s.undecided, 1);
  assert.deepEqual(s.decisions.map(d => d.summary), ['Lead email 6 days out']);
  assert.ok(s.risks.some(r => r.kind === 'question_overdue'));
  assert.ok(s.risks.some(r => r.kind === 'question_waiting'));
  assert.ok(s.risks.some(r => r.kind === 'milestone_open'), 'Phase 3 window ends within 14 days with R3 not built');
  // Fundraising has no timeline entries.
  assert.deepEqual(uep.projects.find(p => p.slug === 'fundraising').risks.map(r => r.kind), ['no_timeline']);
  // Client level: only this client's open, dated Tasks; key dates and client-wide decisions.
  assert.deepEqual(uep.tasks.overdue.map(t => t.id), ['00T1']);
  assert.deepEqual(uep.tasks.week.map(t => t.id), ['00T2']);
  assert.equal(uep.tasks.open, 2);
  assert.deepEqual(uep.dates.map(d => d.label), ['Pages open']);
  assert.deepEqual(uep.decisions.map(d => d.summary), ['Sync to Salesforce']);
  // A wait on a key date with no project sits at client level, and it is late.
  assert.deepEqual(uep.across.map(d => [d.blocker.name, d.blocked.name, d.late]), [['Scheduler Phase 3', 'Pages open', true]]);
  assert.ok(uep.risks.some(r => r.kind === 'late_blocker' && r.level === 'high'));
  const overdueRisk = uep.risks.find(r => r.kind === 'task_overdue');
  assert.ok(overdueRisk, 'overdue Task flagged');
  // The flag names the Task and how late it is, not just a count.
  assert.deepEqual(overdueRisk.items.map(t => t.id), ['00T1']);
  assert.ok(overdueRisk.items[0].late > 0);
  assert.match(overdueRisk.text, /overdue: ".+" \(\d+ days? late\)/);
  // Nothing from the other client leaks into UEP's cards.
  assert.ok(!JSON.stringify(uep).includes('Other client'));
});

test('without Salesforce the map still loads, with no Task counts', async () => {
  const { db } = setup();
  const map = await loadMap(db, { today: '2026-11-22' });
  assert.equal(map.find(c => c.slug === 'uep').tasks, null);
});

test('risk rules: a late blocker is high; the rest wait for their thresholds', () => {
  const base = { waiting: [], requirements: null, phase: null, now: null, questions: [], scheduled: true };
  assert.deepEqual(risksFor(base, '2026-11-22'), []);
  const late = risksFor({ ...base, waiting: [{ late: true, blocker: { name: 'Gym list' } }] }, '2026-11-22');
  assert.equal(late[0].level, 'high');
  assert.match(late[0].text, /Gym list/);
  const young = risksFor({ ...base, questions: [{ age: RISK.questionDays - 1 }] }, '2026-11-22');
  assert.deepEqual(young, []);
  const answered = risksFor({ ...base, to_close: [{ number: 133, age: 1 }] }, '2026-11-22');
  assert.deepEqual(answered.map(r => r.kind), ['answered_open'], 'an answered question needs closing at any age');
  assert.match(answered[0].text, /ready to close: #133 \(oldest answer 1 day\)/, 'the flag names the question by its number');
  const far = risksFor({ ...base, phase: { number: 4, window_end: '2027-02-01' }, requirements: { current: { total: 5, built: 1 } } }, '2026-11-22');
  assert.deepEqual(far, [], 'a phase ending beyond the window is not flagged');
});

test('only Positive Tribes can open the map', async () => {
  const { call } = setup();
  assert.equal((await call('molly@uep.org')).status, 404);
  const r = await call('eric@positivetribes.org');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.clients.map(c => c.slug), ['uep', 'safe']);
  assert.equal(r.body.salesforceError, null);
});

test('a closed Salesforce Task clears its blocker; an open one waits; one Salesforce did not report stays Check', async () => {
  const { db } = setup();
  const { loadDependencies } = await import('../src/decisions.js');
  const jack = deps => deps.find(d => d.blocker.kind === 'sf_task');
  const unknown = jack(await loadDependencies(db, 1, '2026-12-10'));
  assert.equal(unknown.blocker.done, null);
  assert.equal(unknown.late, true, 'past needed_by with no status: late, as before');
  // Salesforce returns 18-character Ids; the stored one may be 15 or 18.
  const open = jack(await loadDependencies(db, 1, '2026-12-10', new Map([['00TAAAAAAAAAAAA', { closed: false, due: '2026-12-01' }]])));
  assert.equal(open.blocker.done, false);
  assert.equal(open.waiting, true);
  const closed = jack(await loadDependencies(db, 1, '2026-12-10', new Map([['00TAAAAAAAAAAAA', { closed: true, due: '2026-12-01' }]])));
  assert.equal(closed.blocker.done, true);
  assert.equal(closed.waiting, false);
  assert.equal(closed.late, false);
  const map = await loadMap(db, { today: '2026-12-10', taskStatus: new Map([['00TAAAAAAAAAAAA', { closed: true, due: null }]]) });
  assert.ok(!map[0].projects[0].waiting.some(d => d.blocker.kind === 'sf_task'));
});
