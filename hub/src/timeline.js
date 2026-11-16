// The schedule (command center Timeline tab, #/command/timeline): every client's projects, phases, proposed work and key
// dates on one month axis. Rows live in timeline_entries (hub-db, migration 0033). A bar linked to a client phase
// (release_id) takes that phase's live stage, so a sign-off or a testing start shows here without editing the bar.
// Positive Tribes only: these routes sit behind handleAdmin's door, and nothing here is shown to a client yet.

import { InputError } from './triage.js';
import { windowEnd } from './dates.js';

export const TIMELINE_KINDS = ['work', 'ongoing', 'proposed', 'milestone', 'deadline'];
// Single dates drawn as a line across the whole timeline, not as a bar in a row.
const MARKS = ['milestone', 'deadline'];

const dateOf = (value, label, { required = false } = {}) => {
  if (value == null || value === '') {
    if (required) throw new InputError(`${label} is required.`);
    return '';
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value + 'T00:00:00Z'))
    || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) throw new InputError(`${label} must look like 2026-11-04.`);
  return value;
};
const idOf = (value, label) => {
  if (value == null || value === '') return null;
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(n) || n < 1) throw new InputError(`${label} is not valid.`);
  return n;
};

// Checks one entry and returns the columns to save. The project and phase must belong to the same client.
export async function entryInput(db, input, text, clientId) {
  const kind = input.kind ?? 'work';
  if (!TIMELINE_KINDS.includes(kind)) throw new InputError('Choose what kind of entry this is.');
  const label = text(input.label, 120, { required: true, label: 'Label' });
  const start = dateOf(input.start_date, 'Start date', { required: true });
  let end = MARKS.includes(kind) ? '' : dateOf(input.end_date, 'End date');
  if (end && end < start) throw new InputError('The end date is before the start date.');
  if (end === start) end = '';
  if (MARKS.includes(kind)) return { kind, label, start, end, project: null, release: null, lane: '' };

  let project = idOf(input.project_id, 'Project');
  const release = idOf(input.release_id, 'Phase');
  if (release) {
    if (kind !== 'work') throw new InputError('Only a work bar can follow a client phase.');
    const row = await db.prepare('SELECT project_id FROM releases WHERE id = ? AND client_id = ?').bind(release, clientId).first();
    if (!row) throw new InputError('That phase is not one of this client\'s.');
    project = row.project_id;
  }
  if (project && !await db.prepare('SELECT 1 FROM projects WHERE id = ? AND client_id = ?').bind(project, clientId).first()) {
    throw new InputError('That project is not one of this client\'s.');
  }
  const lane = project ? '' : text(input.lane, 60, { label: 'Row name' });
  if (!project && !lane) throw new InputError('Choose a project or name a row for it.');
  return { kind, label, start, end, project, release, lane };
}

export async function loadTimeline(db) {
  const [clients, projects, releases, entries] = await Promise.all([
    db.prepare('SELECT id, slug, name FROM clients ORDER BY id').all(),
    db.prepare('SELECT id, client_id, name, phase, position FROM projects ORDER BY client_id, position, id').all(),
    db.prepare('SELECT id, client_id, project_id, number, name, stage, uat_started, uat_days, uat_day_type FROM releases ORDER BY project_id, number').all(),
    db.prepare('SELECT id, client_id, project_id, release_id, lane, label, start_date, end_date, kind, updated_at FROM timeline_entries ORDER BY client_id, start_date, id').all()
  ]);
  const phases = releases.results.map(r => ({
    id: r.id, client_id: r.client_id, project_id: r.project_id, number: r.number, name: r.name, stage: r.stage,
    uat_started: r.uat_started, window_end: r.uat_started ? windowEnd(r.uat_started, r.uat_days, r.uat_day_type) : null
  }));
  return clients.results.map(c => ({
    ...c,
    projects: projects.results.filter(p => p.client_id === c.id),
    releases: phases.filter(r => r.client_id === c.id),
    entries: entries.results.filter(e => e.client_id === c.id)
  }));
}

export async function timelineAdmin({ request, env, route, path, method, json, body, text }) {
  const one = /^\/api\/admin\/timeline\/(\d+)$/.exec(path);
  if (!one && path !== '/api/admin/timeline') return null;
  if (!env.DB) return json({ error: 'The hub database is not connected.' }, 503);
  const db = env.DB;

  if (route === 'GET /api/admin/timeline') return json({ clients: await loadTimeline(db) });

  if (route === 'POST /api/admin/timeline') {
    const input = await body(request);
    const clientId = idOf(input.client_id, 'Client');
    if (!clientId || !await db.prepare('SELECT 1 FROM clients WHERE id = ?').bind(clientId).first()) throw new InputError('Choose a client.');
    const e = await entryInput(db, input, text, clientId);
    const done = await db.prepare('INSERT INTO timeline_entries (client_id, project_id, release_id, lane, label, start_date, end_date, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(clientId, e.project, e.release, e.lane, e.label, e.start, e.end, e.kind).run();
    return json({ ok: true, id: done.meta.last_row_id });
  }

  if (one && (method === 'PUT' || method === 'DELETE')) {
    const id = Number(one[1]);
    const row = await db.prepare('SELECT client_id FROM timeline_entries WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'That entry is gone. Reload the page.' }, 404);
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM timeline_entries WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
    const e = await entryInput(db, await body(request), text, row.client_id);
    await db.prepare('UPDATE timeline_entries SET project_id = ?, release_id = ?, lane = ?, label = ?, start_date = ?, end_date = ?, kind = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(e.project, e.release, e.lane, e.label, e.start, e.end, e.kind, id).run();
    return json({ ok: true });
  }
  return json({ error: 'Not found.' }, 404);
}
