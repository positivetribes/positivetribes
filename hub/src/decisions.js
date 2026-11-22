// Decisions and dependencies (Map step 2, migration 0039). Positive Tribes only: the routes sit behind handleAdmin's door
// and nothing here is sent to a client.
//   GET/POST /api/admin/decisions, PUT/DELETE /api/admin/decisions/<id>
//   GET/POST /api/admin/dependencies, DELETE /api/admin/dependencies/<id>
// A dependency says "blocker must happen before blocked". loadDependencies resolves both ends to a name, a due date and
// whether it is done, so the Timeline (and later the Map) can show what each piece waits on and which waits are late.
// Salesforce Tasks are not copied here: their end shows the dependency's label and needed_by date.

import { InputError } from './triage.js';
import { windowEnd } from './dates.js';

export const END_KINDS = ['timeline', 'release', 'item', 'sf_task'];
export const DEPENDENCY_KINDS = ['blocks', 'needs_input', 'needs_signoff'];
const DONE_STAGES = ['signed_off', 'live'];

// Today in Denver, YYYY-MM-DD (the hub's working day).
export const hubToday = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

const dateOf = (value, label, { required = false } = {}) => {
  if (value == null || value === '') { if (required) throw new InputError(`${label} is required.`); return ''; }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value + 'T00:00:00Z'))
    || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) {
    throw new InputError(`${label} must look like 2026-11-04.`);
  }
  return value;
};
const idOf = (value, label, { required = false } = {}) => {
  if (value == null || value === '') { if (required) throw new InputError(`${label} is required.`); return null; }
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 1) throw new InputError(`${label} is not valid.`);
  return n;
};
const safeDate = v => { try { return dateOf(v, 'Date'); } catch { return null; } };

async function clientOf(db, value) {
  const id = idOf(value, 'Client', { required: true });
  if (!await db.prepare('SELECT 1 FROM clients WHERE id = ?').bind(id).first()) throw new InputError('Choose a client.');
  return id;
}
async function projectOf(db, value, clientId) {
  const id = idOf(value, 'Project');
  if (id && !await db.prepare('SELECT 1 FROM projects WHERE id = ? AND client_id = ?').bind(id, clientId).first()) throw new InputError('That project is not one of this client\'s.');
  return id;
}

export async function decisionInput(db, input, text, clientId) {
  const project = await projectOf(db, input.project_id, clientId);
  const decided = dateOf(input.decided_on, 'Decision date', { required: true });
  const summary = text(input.summary, 300, { required: true, label: 'What was decided' });
  const why = text(input.why, 1000, { label: 'Why', multiline: true });
  const by = text(input.decided_by, 80, { label: 'Decided by' });
  const affects = text(input.affects, 200, { label: 'What it changes' });
  const source = text(input.source, 200, { label: 'Where it was decided' });
  if (input.price_change !== undefined && typeof input.price_change !== 'boolean') throw new InputError('Say whether the price changes.');
  const supersedes = idOf(input.supersedes_id, 'Replaces');
  if (supersedes && !await db.prepare('SELECT 1 FROM decisions WHERE id = ? AND client_id = ?').bind(supersedes, clientId).first()) {
    throw new InputError('The decision it replaces is not one of this client\'s.');
  }
  return { project, decided, summary, why, by, affects, source, price: input.price_change ? 1 : 0, supersedes };
}

// One end of a dependency: hub ends must exist and belong to this client; a Salesforce Task end must be a Task Id.
async function endOf(db, kind, ref, clientId, label) {
  if (!END_KINDS.includes(kind)) throw new InputError(`${label}: choose a timeline bar, phase, hub item or Salesforce Task.`);
  if (kind === 'sf_task') {
    if (typeof ref !== 'string' || !/^00T[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(ref)) throw new InputError(`${label}: a Salesforce Task Id starts with 00T.`);
    return ref;
  }
  const id = idOf(ref, label, { required: true });
  const table = { timeline: 'timeline_entries', release: 'releases', item: 'items' }[kind];
  if (!await db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND client_id = ?`).bind(id, clientId).first()) throw new InputError(`${label} is not one of this client's.`);
  return String(id);
}

export async function dependencyInput(db, input, text, clientId) {
  const blockerKind = input.blocker_kind, blockedKind = input.blocked_kind;
  const blocker = await endOf(db, blockerKind, input.blocker_ref, clientId, 'What has to happen first');
  const blocked = await endOf(db, blockedKind, input.blocked_ref, clientId, 'What waits on it');
  if (blockerKind === blockedKind && blocker === blocked) throw new InputError('Something cannot wait on itself.');
  const kind = input.kind ?? 'blocks';
  if (!DEPENDENCY_KINDS.includes(kind)) throw new InputError('Choose how it depends: blocks, needs input or needs sign-off.');
  const label = text(input.label, 160, { label: 'Label', required: blockerKind === 'sf_task' || blockedKind === 'sf_task' });
  const needed = dateOf(input.needed_by, 'Needed by');
  return { blockerKind, blocker, blockedKind, blocked, kind, label, needed };
}

// Every dependency (one client, or all) with both ends resolved: { name, due, done (true/false, null = not known here) }.
// waiting: the blocker is not known to be done. late: still waiting and its date (needed_by, else the blocker's due) has passed.
export async function loadDependencies(db, clientId = null, today = hubToday()) {
  const w = clientId ? ' WHERE client_id = ?' : '';
  const q = s => clientId ? db.prepare(s).bind(clientId) : db.prepare(s);
  const [deps, entries, releases, items, projects] = await Promise.all([
    q(`SELECT * FROM dependencies${w} ORDER BY id`).all(),
    q(`SELECT id, client_id, project_id, release_id, label, start_date, end_date, kind FROM timeline_entries${w}`).all(),
    q(`SELECT id, client_id, project_id, number, name, stage, uat_started, uat_days, uat_day_type FROM releases${w}`).all(),
    q(`SELECT id, client_id, COALESCE(legacy_id, id) AS number, kind, title, done, status, answer, due_date FROM items${w}`).all(),
    q(`SELECT id, name FROM projects${w}`).all()
  ]);
  const projectName = id => projects.results.find(p => p.id === id)?.name || '';
  const release = id => releases.results.find(r => r.id === id);
  const resolve = (kind, ref, dep) => {
    if (kind === 'sf_task') return { kind, ref, name: dep.label || 'Salesforce Task', due: dep.needed_by || null, done: null };
    const id = Number(ref);
    if (kind === 'timeline') {
      const e = entries.results.find(x => x.id === id);
      if (!e) return { kind, ref, name: '(removed timeline entry)', due: null, done: null, missing: true };
      const r = e.release_id ? release(e.release_id) : null;
      return { kind, ref, name: e.label, project: projectName(e.project_id), due: e.end_date || e.start_date, start: e.start_date, done: r ? DONE_STAGES.includes(r.stage) : false };
    }
    if (kind === 'release') {
      const r = release(id);
      if (!r) return { kind, ref, name: '(removed phase)', due: null, done: null, missing: true };
      const end = r.uat_started ? windowEnd(r.uat_started, r.uat_days, r.uat_day_type) : null;
      return { kind, ref, name: `${projectName(r.project_id)} Phase ${r.number}${r.name ? ' · ' + r.name : ''}`, project: projectName(r.project_id), due: end, done: DONE_STAGES.includes(r.stage) };
    }
    const i = items.results.find(x => x.id === id);
    if (!i) return { kind, ref, name: '(removed item)', due: null, done: null, missing: true };
    const done = Boolean(i.done) || ['built', 'declined'].includes(i.status) || (i.kind === 'question' && Boolean(String(i.answer || '').trim()));
    return { kind, ref, name: `#${i.number} ${i.title}`, due: i.due_date || null, done };
  };
  return deps.results.map(d => {
    const blocker = resolve(d.blocker_kind, d.blocker_ref, d), blocked = resolve(d.blocked_kind, d.blocked_ref, d);
    const waiting = blocker.done !== true;
    const by = safeDate(d.needed_by) || blocker.due;
    return { id: d.id, client_id: d.client_id, kind: d.kind, label: d.label, needed_by: d.needed_by, blocker, blocked, waiting, late: Boolean(waiting && by && by < today) };
  });
}

export async function decisionsAdmin({ request, env, url, route, path, method, json, body, text }) {
  const oneDecision = /^\/api\/admin\/decisions\/(\d+)$/.exec(path), oneDep = /^\/api\/admin\/dependencies\/(\d+)$/.exec(path);
  if (!oneDecision && !oneDep && path !== '/api/admin/decisions' && path !== '/api/admin/dependencies') return null;
  if (!env.DB) return json({ error: 'The hub database is not connected.' }, 503);
  const db = env.DB;
  const filter = () => {
    const raw = url.searchParams.get('client_id');
    if (raw != null && !/^[1-9]\d{0,8}$/.test(raw)) throw new InputError('Client is not valid.');
    return raw ? Number(raw) : null;
  };

  if (route === 'GET /api/admin/decisions') {
    const c = filter();
    const { results } = await (c ? db.prepare('SELECT * FROM decisions WHERE client_id = ? ORDER BY decided_on DESC, id DESC').bind(c)
      : db.prepare('SELECT * FROM decisions ORDER BY decided_on DESC, id DESC')).all();
    return json({ decisions: results.map(d => ({ ...d, price_change: Boolean(d.price_change) })) });
  }
  if (route === 'POST /api/admin/decisions') {
    const input = await body(request);
    const clientId = await clientOf(db, input.client_id);
    const d = await decisionInput(db, input, text, clientId);
    const done = await db.prepare('INSERT INTO decisions (client_id, project_id, decided_on, decided_by, summary, why, affects, price_change, supersedes_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(clientId, d.project, d.decided, d.by, d.summary, d.why, d.affects, d.price, d.supersedes, d.source).run();
    return json({ ok: true, id: done.meta.last_row_id });
  }
  if (oneDecision && (method === 'PUT' || method === 'DELETE')) {
    const id = Number(oneDecision[1]);
    const row = await db.prepare('SELECT client_id FROM decisions WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'That decision is gone. Reload the page.' }, 404);
    if (method === 'DELETE') {
      // A later decision that pointed at this one now stands alone.
      await db.batch([
        db.prepare('UPDATE decisions SET supersedes_id = NULL WHERE supersedes_id = ?').bind(id),
        db.prepare('DELETE FROM decisions WHERE id = ?').bind(id)
      ]);
      return json({ ok: true });
    }
    const d = await decisionInput(db, await body(request), text, row.client_id);
    if (d.supersedes === id) throw new InputError('A decision cannot replace itself.');
    await db.prepare('UPDATE decisions SET project_id = ?, decided_on = ?, decided_by = ?, summary = ?, why = ?, affects = ?, price_change = ?, supersedes_id = ?, source = ? WHERE id = ?')
      .bind(d.project, d.decided, d.by, d.summary, d.why, d.affects, d.price, d.supersedes, d.source, id).run();
    return json({ ok: true });
  }

  if (route === 'GET /api/admin/dependencies') return json({ dependencies: await loadDependencies(db, filter()) });
  if (route === 'POST /api/admin/dependencies') {
    const input = await body(request);
    const clientId = await clientOf(db, input.client_id);
    const d = await dependencyInput(db, input, text, clientId);
    if (await db.prepare('SELECT 1 FROM dependencies WHERE blocker_kind = ? AND blocker_ref = ? AND blocked_kind = ? AND blocked_ref = ?').bind(d.blockerKind, d.blocker, d.blockedKind, d.blocked).first()) {
      throw new InputError('That dependency is already there.');
    }
    const done = await db.prepare('INSERT INTO dependencies (client_id, blocker_kind, blocker_ref, blocked_kind, blocked_ref, kind, label, needed_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(clientId, d.blockerKind, d.blocker, d.blockedKind, d.blocked, d.kind, d.label, d.needed).run();
    return json({ ok: true, id: done.meta.last_row_id });
  }
  if (oneDep && method === 'DELETE') {
    const id = Number(oneDep[1]);
    if (!await db.prepare('SELECT 1 FROM dependencies WHERE id = ?').bind(id).first()) return json({ error: 'That dependency is gone. Reload the page.' }, 404);
    await db.prepare('DELETE FROM dependencies WHERE id = ?').bind(id).run();
    return json({ ok: true });
  }
  return json({ error: 'Not found.' }, 404);
}
