// Map step 4: the Monday "state of all projects" digest. The Monday cron (WEB_CRON in index.js) saves a compact
// snapshot of the Map (src/map.js) in map_snapshots (migration 0040); Today compares the newest snapshot with the one
// before it ("what changed since last week") and lists drift: things in the hub that have quietly gone out of date.
// Plain SQL and string rules, no AI, no new secrets. Positive Tribes only (Today and the run route sit behind handleAdmin).

import { loadMap, daysBetween } from './map.js';

export const DIGEST = { staleSyncDays: 7, keepWeeks: 26 };
const ACTIVE_STAGES = ['build', 'uat'];

// The Monday of the week `today` falls in: one snapshot per week, a second run that week replaces it.
export function weekOf(today) {
  const d = new Date(today + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}

// Drift: (a) a requirements copy that has not synced for a while on a project in build or testing (the push runs on
// every push to the sync branch, so a quiet week usually means the workflow broke or the branch moved on), and (b) a
// Salesforce Task blocker past its date that Salesforce no longer reports (deleted, or the Id is wrong), so it can go.
// (b) is skipped when Salesforce did not answer at all, since then every Task blocker looks unknown.
export function driftOf(clients, today, salesforceOk) {
  const out = [];
  for (const c of clients) {
    for (const p of c.projects) {
      const sync = p.requirements?.last_sync;
      if (sync && ACTIVE_STAGES.includes(p.stage)) {
        const age = daysBetween(String(sync).slice(0, 10), today);
        if (age > DIGEST.staleSyncDays) out.push({ kind: 'stale_requirements', client: c.name, project: p.name, text: `Requirements copy last synced ${age} days ago; check the "Requirements to hub" run or the sync branch` });
      }
    }
    if (!salesforceOk) continue;
    const deps = [...c.projects.flatMap(p => p.waiting.map(d => ({ ...d, project: p.name }))), ...c.across.map(d => ({ ...d, project: null }))];
    for (const d of deps) {
      if (d.blocker.kind === 'sf_task' && d.blocker.done == null && d.needed_by && d.needed_by < today) {
        out.push({ kind: 'missing_task', client: c.name, project: d.project, text: `Salesforce no longer reports the Task "${d.blocker.name}" (needed by ${d.needed_by}); remove the dependency or fix its Task Id` });
      }
    }
  }
  return out;
}

// What a later week is compared against. Small on purpose: names, counts and ids, no item text beyond titles we already show.
export function snapshotOf(clients, today, salesforceOk) {
  return {
    today, salesforceOk,
    projects: clients.flatMap(c => c.projects.map(p => ({
      key: c.slug + '/' + p.slug, client: c.name, name: p.name,
      phase: p.phase ? { number: p.phase.number, stage: p.phase.stage } : null,
      req: p.requirements?.current ? { phase: p.requirements.current.phase, total: p.requirements.current.total, built: p.requirements.current.built, accepted: p.requirements.current.accepted } : null,
      waiting: p.waiting.map(d => ({ id: d.id, name: d.blocker.name, late: d.late })),
      questions: p.questions.length,
      to_close: (p.to_close || []).length,
      risks: p.risks.map(r => r.kind)
    }))),
    decisions: clients.flatMap(c => [...c.decisions, ...c.projects.flatMap(p => p.decisions)].map(d => ({ id: d.id, client: c.name, summary: d.summary, decided_on: d.decided_on, price_change: d.price_change }))),
    drift: driftOf(clients, today, salesforceOk)
  };
}

const RISK_NAMES = { late_blocker: 'a late blocker', milestone_open: 'a phase ending with requirements not built', question_waiting: 'a question waiting too long', question_overdue: 'a question past due', answered_open: 'answered questions not closed', no_timeline: 'no timeline' };

// What changed between two snapshots, as one line each. Pure, so it is tested on its own.
export function changesBetween(prev, cur) {
  if (!prev) return null;
  const out = [];
  const before = new Map(prev.projects.map(p => [p.key, p]));
  for (const p of cur.projects) {
    const was = before.get(p.key);
    const line = text => out.push({ client: p.client, project: p.name, text });
    if (!was) { line('New project in the hub'); continue; }
    if (p.phase && (!was.phase || was.phase.number !== p.phase.number || was.phase.stage !== p.phase.stage)) {
      line(`Phase ${p.phase.number} is now ${String(p.phase.stage).replace(/_/g, ' ')}` + (was.phase ? ` (was Phase ${was.phase.number} ${String(was.phase.stage).replace(/_/g, ' ')})` : ''));
    }
    if (p.req && (!was.req || was.req.phase !== p.req.phase || was.req.built !== p.req.built || was.req.total !== p.req.total)) {
      const from = was.req && was.req.phase === p.req.phase ? ` (was ${was.req.built}/${was.req.total})` : '';
      line(`Phase ${p.req.phase}: ${p.req.built}/${p.req.total} requirements built${from}`);
    }
    const ids = new Set(was.waiting.map(d => d.id)), now = new Set(p.waiting.map(d => d.id));
    for (const d of p.waiting.filter(d => !ids.has(d.id))) line(`New blocker: ${d.name}`);
    for (const d of was.waiting.filter(d => !now.has(d.id))) line(`Blocker cleared: ${d.name}`);
    for (const d of p.waiting.filter(d => d.late && ids.has(d.id) && !was.waiting.find(w => w.id === d.id).late)) line(`Now late: ${d.name}`);
    for (const k of p.risks.filter(k => !was.risks.includes(k))) line('New risk: ' + (RISK_NAMES[k] || k));
    if (p.questions !== was.questions) line(`Open questions ${p.questions} (was ${was.questions})`);
  }
  const known = new Set(prev.decisions.map(d => d.id));
  for (const d of cur.decisions.filter(d => !known.has(d.id))) out.push({ client: d.client, project: null, text: `Decided ${d.decided_on}: ${d.summary}${d.price_change ? ' (changes price)' : ''}`, decision: true });
  return out;
}

// Run once (Monday cron, or Run now on Today). A failure is saved too, so Today says so instead of going quiet.
export async function runMapDigest(env, today, { taskStatus = async () => null } = {}) {
  const db = env.DB;
  if (!db) return { ran: false, reason: 'The hub database is not connected.' };
  const week = weekOf(today);
  try {
    const tasks = await taskStatus();
    const clients = await loadMap(db, { today, taskStatus: tasks });
    const snap = snapshotOf(clients, today, tasks !== null);
    await db.batch([
      db.prepare("INSERT INTO map_snapshots (week_start, data_json, error, ran_at) VALUES (?, ?, '', strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(week_start) DO UPDATE SET data_json = excluded.data_json, error = '', ran_at = excluded.ran_at")
        .bind(week, JSON.stringify(snap)),
      db.prepare('DELETE FROM map_snapshots WHERE week_start < ?').bind(new Date(Date.parse(week + 'T12:00:00Z') - DIGEST.keepWeeks * 7 * 864e5).toISOString().slice(0, 10))
    ]);
    return { ran: true, week, projects: snap.projects.length, drift: snap.drift.length };
  } catch (error) {
    // Keep a good earlier save for the same week; only the error is new.
    await db.prepare("INSERT INTO map_snapshots (week_start, error, ran_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(week_start) DO UPDATE SET error = excluded.error, ran_at = excluded.ran_at")
      .bind(week, String(error.message).slice(0, 300)).run();
    return { ran: false, reason: error.message };
  }
}

// For Today: the newest saved week, its changes against the week before, and its drift.
export async function latestMapDigest(db) {
  const rows = (await db.prepare('SELECT week_start, data_json, error, ran_at FROM map_snapshots ORDER BY week_start DESC LIMIT 2').all()).results;
  if (!rows.length) return null;
  const parse = r => { try { const d = JSON.parse(r.data_json); return d && d.projects ? d : null; } catch { return null; } };
  const [top, prev] = rows, cur = parse(top);
  return {
    week: top.week_start, ranAt: top.ran_at, error: top.error || '',
    projects: cur ? cur.projects.length : 0,
    salesforceOk: cur ? cur.salesforceOk : null,
    changes: cur ? changesBetween(prev ? parse(prev) : null, cur) : null,
    drift: cur ? cur.drift : []
  };
}
