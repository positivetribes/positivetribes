// The Map (step 3, #/command/map): one card per hub project across every client, built only from what the hub and
// Salesforce already hold. Positive Tribes only (GET /api/admin/map behind handleAdmin's door); nothing here is stored.
// Per project: where it is (current phase, the bar running now, the next one), requirements progress for the current
// phase, what it waits on (dependencies + open hub questions), open decisions (proposed requirements, items not decided)
// and the last decisions, plus risk flags worked out by the rules in RISK. Per client: overdue and due-this-week
// Salesforce Tasks (from the command center's cached Salesforce read) and the dependencies that sit on no project.

import { loadRequirements } from './requirements.js';
import { loadDependencies, hubToday } from './decisions.js';
import { windowEnd } from './dates.js';

// Risk rules, kept as config so they can be tuned without touching the logic.
export const RISK = { milestoneDays: 14, questionDays: 10, taskWeekDays: 7 };
const DONE_STAGES = ['signed_off', 'live'];

const addDays = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);

// The flags for one project card. Pure, so the rules are tested on their own.
export function risksFor(p, today) {
  const out = [];
  const late = p.waiting.filter(d => d.late);
  if (late.length) out.push({ kind: 'late_blocker', level: 'high', text: `${late.length} late blocker${late.length > 1 ? 's' : ''}: ${late.slice(0, 2).map(d => d.blocker.name).join('; ')}` });
  const ph = p.requirements?.current;
  const end = p.phase?.window_end || p.now?.end_date || null;
  if (ph && end && end >= today && daysBetween(today, end) <= RISK.milestoneDays && ph.total - ph.built > 0) {
    out.push({ kind: 'milestone_open', level: 'medium', text: `Phase ${p.phase.number} ends ${end}: ${ph.total - ph.built} of ${ph.total} requirements not built` });
  }
  const stale = p.questions.filter(q => q.age >= RISK.questionDays);
  if (stale.length) out.push({ kind: 'question_waiting', level: 'medium', text: `${stale.length} question${stale.length > 1 ? 's' : ''} waiting ${RISK.questionDays}+ days (oldest ${Math.max(...stale.map(q => q.age))} days)` });
  const overdue = p.questions.filter(q => q.due_date && q.due_date < today);
  if (overdue.length) out.push({ kind: 'question_overdue', level: 'medium', text: `${overdue.length} question${overdue.length > 1 ? 's' : ''} past due` });
  if (!p.scheduled) out.push({ kind: 'no_timeline', level: 'low', text: 'No timeline entries' });
  return out;
}

export async function loadMap(db, { today = hubToday(), tasks = null, taskStatus = null } = {}) {
  const [clients, projects, releases, entries, items, decisions, requirements, deps] = await Promise.all([
    db.prepare('SELECT id, slug, name, salesforce_account_id FROM clients ORDER BY id').all(),
    db.prepare('SELECT id, client_id, slug, name, phase, position FROM projects ORDER BY client_id, position, id').all(),
    db.prepare('SELECT id, client_id, project_id, number, name, stage, uat_started, uat_days, uat_day_type FROM releases ORDER BY project_id, number').all(),
    db.prepare('SELECT id, client_id, project_id, release_id, label, start_date, end_date, kind FROM timeline_entries ORDER BY start_date, id').all(),
    db.prepare(`SELECT id, client_id, project_id, COALESCE(legacy_id, id) AS number, kind, title, owner, due_date, phase, created_at
      FROM items WHERE done = 0 AND ((kind = 'question' AND answer = '') OR phase = 'review')`).all(),
    db.prepare('SELECT id, client_id, project_id, decided_on, decided_by, summary, affects, price_change FROM decisions ORDER BY decided_on DESC, id DESC').all(),
    loadRequirements(db, null),
    loadDependencies(db, null, today, taskStatus)
  ]);
  const entryProject = new Map(entries.results.map(e => [String(e.id), e.project_id]));
  const releaseProject = new Map(releases.results.map(r => [String(r.id), r.project_id]));
  const itemProject = new Map(items.results.map(i => [String(i.id), i.project_id]));
  const projectOf = end => end.kind === 'timeline' ? entryProject.get(end.ref) ?? null
    : end.kind === 'release' ? releaseProject.get(end.ref) ?? null
    : end.kind === 'item' ? itemProject.get(end.ref) ?? null : null;
  const slim = d => ({ id: d.id, kind: d.kind, label: d.label, late: d.late, waiting: d.waiting, needed_by: d.needed_by || d.blocker.due || null, blocker: { kind: d.blocker.kind, name: d.blocker.name, done: d.blocker.done }, blocked: { name: d.blocked.name } });

  const tasksBy = new Map();
  for (const t of tasks || []) {
    if (t.IsClosed || !t.ActivityDate) continue;
    if (!tasksBy.has(t.AccountId)) tasksBy.set(t.AccountId, []);
    tasksBy.get(t.AccountId).push(t);
  }
  const week = addDays(today, RISK.taskWeekDays);

  return clients.results.map(c => {
    const own = arr => arr.filter(x => x.client_id === c.id);
    const cDeps = own(deps);
    const cards = own(projects.results).map(p => {
      const phases = releases.results.filter(r => r.project_id === p.id);
      const cur = phases.find(r => !DONE_STAGES.includes(r.stage));
      const phase = cur ? { number: cur.number, name: cur.name, stage: cur.stage, window_end: cur.uat_started ? windowEnd(cur.uat_started, cur.uat_days, cur.uat_day_type) : null }
        : phases.length ? { number: phases.at(-1).number, name: phases.at(-1).name, stage: phases.at(-1).stage, window_end: null } : null;
      const bars = entries.results.filter(e => e.project_id === p.id && ['work', 'ongoing', 'proposed'].includes(e.kind));
      // Now: the running bar for the current phase, else the running bar that ends soonest (long umbrella bars lose).
      const running = bars.filter(e => e.start_date <= today && (e.end_date || e.start_date) >= today && e.kind !== 'ongoing')
        .sort((a, b) => (a.end_date || a.start_date).localeCompare(b.end_date || b.start_date));
      const now = (cur && running.find(e => e.release_id === cur.id)) || running[0] || null;
      const next = bars.find(e => e.start_date > today) || null;
      const req = requirements.find(r => r.project_id === p.id);
      const n = phase ? String(phase.number) : null;
      const requirements_ = req ? {
        counts: req.counts, current: n && req.phases[n] ? { phase: phase.number, ...req.phases[n] } : null,
        proposed: req.rows.filter(r => r.state === 'proposed').map(r => ({ ref: r.ref, text: r.text })),
        last_sync: req.last_sync?.synced_at || null
      } : null;
      const questions = own(items.results).filter(i => i.project_id === p.id && i.kind === 'question')
        .map(i => ({ number: i.number, title: i.title, owner: i.owner, due_date: i.due_date || null, age: daysBetween(String(i.created_at).slice(0, 10), today) }))
        .sort((a, b) => (a.due_date || '9').localeCompare(b.due_date || '9') || b.age - a.age);
      const undecided = own(items.results).filter(i => i.project_id === p.id && i.kind !== 'question' && i.phase === 'review').length;
      const card = {
        id: p.id, slug: p.slug, name: p.name, stage: p.phase, phase, now, next,
        scheduled: entries.results.some(e => e.project_id === p.id),
        requirements: requirements_,
        waiting: cDeps.filter(d => d.waiting && projectOf(d.blocked) === p.id).map(slim),
        questions, undecided,
        decisions: own(decisions.results).filter(d => d.project_id === p.id).slice(0, 3).map(d => ({ ...d, price_change: Boolean(d.price_change) }))
      };
      card.risks = risksFor(card, today);
      return card;
    });
    const open = tasksBy.get(c.salesforce_account_id) || [];
    const task = t => ({ id: t.Id, subject: t.Subject, due: t.ActivityDate });
    const clientRisks = [];
    const overdue = open.filter(t => t.ActivityDate < today).sort((a, b) => a.ActivityDate.localeCompare(b.ActivityDate));
    if (overdue.length) clientRisks.push({ kind: 'task_overdue', level: 'medium', text: `${overdue.length} Salesforce Task${overdue.length > 1 ? 's' : ''} overdue` });
    const across = cDeps.filter(d => d.waiting && projectOf(d.blocked) == null);
    if (across.some(d => d.late)) clientRisks.push({ kind: 'late_blocker', level: 'high', text: `${across.filter(d => d.late).length} late blocker${across.filter(d => d.late).length > 1 ? 's' : ''} on a key date` });
    return {
      id: c.id, slug: c.slug, name: c.name,
      tasks: tasks ? { overdue: overdue.map(task), week: open.filter(t => t.ActivityDate >= today && t.ActivityDate <= week).sort((a, b) => a.ActivityDate.localeCompare(b.ActivityDate)).map(task), open: open.length } : null,
      across: across.map(slim),
      decisions: own(decisions.results).filter(d => d.project_id == null).slice(0, 3).map(d => ({ ...d, price_change: Boolean(d.price_change) })),
      dates: own(entries.results).filter(e => ['milestone', 'deadline'].includes(e.kind) && e.start_date >= today).slice(0, 3).map(e => ({ label: e.label, date: e.start_date, kind: e.kind })),
      risks: clientRisks,
      projects: cards
    };
  }).filter(c => c.projects.length);
}
