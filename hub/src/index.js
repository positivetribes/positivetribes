// Tribe Hub API: one Worker for every client. Sign-in is Cloudflare Access (emailed one-time PIN); the email is
// mapped to a users row, which decides which client the person may see. Tenant checks happen in one place (scope).
import { signedInEmail } from './access.js';

const TIERS = ['must', 'nice', 'idea'];
const PHASES = ['review', 'prototype', 'full', 'later'];
const KINDS = ['question', 'change', 'problem', 'request'];
const TIER_NAMES = { must: 'Must have', nice: 'Nice to have', idea: 'Idea for now' };
const PHASE_NAMES = { review: 'To review', prototype: 'Prototype', full: 'Full build', later: 'Later' };
const FIELD_NAMES = { title: 'title', details: 'details', owner: 'who answers', project_id: 'list' };

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
});

class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function text(value, max, { required = false, label = 'Text' } = {}) {
  if (value != null && typeof value !== 'string') throw new InputError(`${label} must be text.`);
  const result = (value || '').trim();
  if (required && !result) throw new InputError(`${label} is required.`);
  if (result.length > max) throw new InputError(`${label} must be at most ${max} characters.`);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result)) throw new InputError(`${label} contains characters that are not allowed.`);
  return result;
}
const oneOf = (list, message) => value => { if (!list.includes(value)) throw new InputError(message); return value; };
const tierOf = oneOf(TIERS, 'Choose must, nice, or idea.');
const phaseOf = oneOf(PHASES, 'Choose review, prototype, full, or later.');
const kindOf = oneOf(KINDS, 'Choose question, change, problem, or request.');
const clip = (value, max = 300) => value.length > max ? value.slice(0, max - 1) + '…' : value;

async function body(request) {
  let result;
  try { result = await request.json(); } catch { throw new InputError('Invalid JSON.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new InputError('Expected an object.');
  return result;
}

// Who is asking, and which client they are looking at. PT staff (client_id NULL) may open any client;
// everyone else only their own. A client someone may not see answers 404, the same as one that does not exist.
async function scope(db, user, slug) {
  const client = await db.prepare('SELECT * FROM clients WHERE slug = ?').bind(slug).first();
  if (!client || (user.role !== 'pt' && user.client_id !== client.id)) throw new InputError('Not found.', 404);
  return client;
}

async function listItems(db, clientId) {
  const { results } = await db.prepare(
    `SELECT i.id, i.project_id, p.slug AS project, i.kind, i.title, i.details, i.owner, i.answer, i.tier, i.phase,
            i.position, i.done, i.due_date, i.added_by, i.created_at, i.updated_at
     FROM items i JOIN projects p ON p.id = i.project_id
     WHERE i.client_id = ?
     ORDER BY p.position, p.id, i.kind DESC, CASE i.tier WHEN 'must' THEN 0 WHEN 'nice' THEN 1 ELSE 2 END, i.done, i.position, i.id`
  ).bind(clientId).all();
  return results.map(item => ({ ...item, done: Boolean(item.done) }));
}

// The last day of a testing window: uat_days calendar days, or uat_days weekdays (weekends skipped), after it starts.
export function windowEnd(start, days, type) {
  const date = new Date(start + 'T00:00:00Z');
  if (type !== 'business') { date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
  for (let left = days; left > 0;) {
    date.setUTCDate(date.getUTCDate() + 1);
    if (date.getUTCDay() % 6 !== 0) left--;
  }
  return date.toISOString().slice(0, 10);
}

async function listReleases(db, clientId) {
  const { results } = await db.prepare(
    `SELECT id, project_id, number, name, summary, url, script_url, stage, uat_started, uat_days, uat_day_type, auto_accept,
            signed_off_by, signed_off_at
     FROM releases WHERE client_id = ? ORDER BY project_id, number`
  ).bind(clientId).all();
  return results.map(r => ({ ...r, auto_accept: Boolean(r.auto_accept), uat_due: r.uat_started ? windowEnd(r.uat_started, r.uat_days, r.uat_day_type) : null }));
}

async function requireItem(db, clientId, value) {
  const id = Number(value);
  const item = Number.isSafeInteger(id) && id > 0
    && await db.prepare('SELECT * FROM items WHERE id = ? AND client_id = ?').bind(id, clientId).first();
  if (!item) throw new InputError('Item not found.', 404);
  return item;
}

async function requireProject(db, clientId, value) {
  const id = Number(value);
  const project = Number.isSafeInteger(id) && id > 0
    && await db.prepare('SELECT * FROM projects WHERE id = ? AND client_id = ?').bind(id, clientId).first();
  if (!project) throw new InputError('Choose one of this client\'s lists.');
  return project;
}

const nextPosition = (db, clientId, projectId, kind, tier) => db.prepare(
  'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM items WHERE client_id = ? AND project_id = ? AND kind = ? AND tier = ?'
).bind(clientId, projectId, kind, tier).first().then(row => row.next);

function changeOf(item, next) {
  if (next.answer && next.answer !== item.answer) return ['answered', clip(next.answer)];
  if (next.done !== item.done) return [next.done ? 'done' : 'reopened', ''];
  if (next.tier !== item.tier) return ['tier', `${TIER_NAMES[item.tier]} → ${TIER_NAMES[next.tier]}`];
  if (next.phase !== item.phase) return ['phase', `${PHASE_NAMES[item.phase] || item.phase} → ${PHASE_NAMES[next.phase]}`];
  const edited = Object.keys(FIELD_NAMES).filter(key => next[key] !== undefined && next[key] !== item[key]);
  return edited.length ? ['edited', 'Changed ' + edited.map(key => FIELD_NAMES[key]).join(', ')] : null;
}

// A null item id means the item was just inserted in the same batch.
const logEvent = (db, clientId, itemId, action, item, detail, user) => db.prepare(
  `INSERT INTO events (client_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name)
   VALUES (?, COALESCE(?, last_insert_rowid()), ?, ?, ?, ?, ?, ?)`
).bind(clientId, itemId, action, item.title, item.kind || '', detail, user.email, user.name);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      const email = await signedInEmail(request, env, url);
      if (!email) return json({ error: 'Please sign in.' }, 401);
      const db = env.DB;
      const user = await db.prepare('SELECT id, email, name, role, client_id FROM users WHERE email = ?').bind(email).first();
      // Signed in through Access but not invited to any workspace.
      if (!user) return json({ error: 'This email has not been invited yet. Please ask Positive Tribes.' }, 403);
      const method = request.method;

      if (url.pathname === '/api/me' && method === 'GET') {
        const { results: clients } = user.role === 'pt'
          ? await db.prepare('SELECT slug, name, accent, status FROM clients ORDER BY name').all()
          : await db.prepare('SELECT slug, name, accent, status FROM clients WHERE id = ?').bind(user.client_id).all();
        return json({ user: { email: user.email, name: user.name, role: user.role }, clients });
      }

      const match = url.pathname.match(/^\/api\/c\/([a-z0-9-]+)\/(projects|items|releases)(?:\/(\d+))?(?:\/(move|signoff))?$/);
      if (!match) return json({ error: 'Not found.' }, 404);
      const [, slug, resource, rawId, action] = match;
      const client = await scope(db, user, slug);

      if (resource === 'projects' && !rawId && method === 'GET') {
        const { results } = await db.prepare(
          'SELECT id, slug, name, poc_url, phase FROM projects WHERE client_id = ? ORDER BY position, id'
        ).bind(client.id).all();
        return json({
          client: { slug: client.slug, name: client.name, accent: client.accent, status: client.status, go_live_date: client.go_live_date },
          projects: results,
          releases: await listReleases(db, client.id)
        });
      }

      if (resource === 'releases' && rawId && action === 'signoff' && method === 'POST') {
        // The director (or Positive Tribes on their behalf) accepts a phase after testing it.
        if (user.role === 'staff') throw new InputError('Only the director can sign off a phase.', 403);
        const id = Number(rawId);
        const release = await db.prepare('SELECT * FROM releases WHERE id = ? AND client_id = ?').bind(id, client.id).first();
        if (!release) throw new InputError('Phase not found.', 404);
        if (release.stage !== 'uat') throw new InputError('Only a phase that is being tested can be signed off.');
        const blocking = await db.prepare(
          `SELECT COUNT(*) AS n FROM items WHERE client_id = ? AND project_id = ? AND kind = 'problem' AND tier = 'must' AND done = 0`
        ).bind(client.id, release.project_id).first();
        if (blocking.n) throw new InputError('Fix the problems that stop sign-off first.');
        // The next built phase that was waiting on this one starts its own testing window today.
        const next = await db.prepare(
          `SELECT * FROM releases WHERE client_id = ? AND project_id = ? AND number > ? AND stage = 'waiting' ORDER BY number LIMIT 1`
        ).bind(client.id, release.project_id, release.number).first();
        const label = release.name || 'Phase ' + release.number;
        await db.batch([
          db.prepare(
            `UPDATE releases SET stage = 'signed_off', signed_off_by = ?, signed_off_email = ?, signed_off_at = CURRENT_TIMESTAMP
             WHERE id = ? AND client_id = ? AND stage = 'uat'`
          ).bind(user.name || user.email, user.email, release.id, client.id),
          ...next ? [db.prepare(`UPDATE releases SET stage = 'uat', uat_started = date('now') WHERE id = ? AND client_id = ?`).bind(next.id, client.id)] : [],
          logEvent(db, client.id, 0, 'signed_off', { title: label, kind: 'release' }, next ? `${next.name || 'Phase ' + next.number} starts testing` : '', user)
        ]);
        return json({ ok: true, releases: await listReleases(db, client.id) });
      }
      if (resource !== 'items') return json({ error: 'Not found.' }, 404);

      if (!rawId && method === 'GET') return json({ items: await listItems(db, client.id) });

      if (!rawId && method === 'POST') {
        const b = await body(request);
        const title = text(b.title, 160, { required: true, label: 'Title' });
        const details = text(b.details, 2000, { label: 'Details' });
        const tier = b.tier === undefined ? 'idea' : tierOf(b.tier);
        const kind = b.kind === undefined ? 'change' : kindOf(b.kind);
        const phase = b.phase === undefined ? (kind === 'problem' ? 'full' : 'review') : phaseOf(b.phase);
        const owner = text(b.owner, 60, { label: 'Who answers' });
        const project = await requireProject(db, client.id, b.project_id);
        await db.batch([
          db.prepare(
            `INSERT INTO items (client_id, project_id, kind, title, details, owner, tier, phase, position, added_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM items WHERE client_id = ? AND project_id = ? AND kind = ? AND tier = ?), ?)`
          ).bind(client.id, project.id, kind, title, details, owner, tier, phase, client.id, project.id, kind, tier, user.name || user.email),
          logEvent(db, client.id, null, 'added', { title, kind }, clip(details), user)
        ]);
        return json({ ok: true, items: await listItems(db, client.id) }, 201);
      }

      if (rawId && action === 'move' && method === 'POST') {
        const item = await requireItem(db, client.id, rawId);
        const b = await body(request);
        if (!['up', 'down'].includes(b.direction)) throw new InputError('Direction must be up or down.');
        const up = b.direction === 'up';
        const phase = b.phase === undefined ? null : phaseOf(b.phase);
        const neighbor = await db.prepare(
          `SELECT id, position FROM items
           WHERE client_id = ? AND project_id = ? AND kind = ? AND tier = ? AND done = ? AND position ${up ? '<' : '>'} ? AND (? IS NULL OR phase = ?)
           ORDER BY position ${up ? 'DESC' : 'ASC'} LIMIT 1`
        ).bind(client.id, item.project_id, item.kind, item.tier, item.done, item.position, phase, phase).first();
        if (neighbor) {
          await db.batch([
            db.prepare('UPDATE items SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND client_id = ?').bind(neighbor.position, item.id, client.id),
            db.prepare('UPDATE items SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND client_id = ?').bind(item.position, neighbor.id, client.id)
          ]);
        }
        return json({ ok: true, items: await listItems(db, client.id) });
      }

      if (rawId && method === 'PATCH' && !action) {
        const item = await requireItem(db, client.id, rawId);
        const b = await body(request);
        const title = b.title === undefined ? item.title : text(b.title, 160, { required: true, label: 'Title' });
        const details = b.details === undefined ? item.details : text(b.details, 2000, { label: 'Details' });
        if (b.done !== undefined && typeof b.done !== 'boolean') throw new InputError('Done must be true or false.');
        const done = b.done === undefined ? item.done : Number(b.done);
        const tier = b.tier === undefined ? item.tier : tierOf(b.tier);
        const phase = b.phase === undefined ? item.phase : phaseOf(b.phase);
        const owner = b.owner === undefined ? item.owner : text(b.owner, 60, { label: 'Who answers' });
        const answer = b.answer === undefined ? item.answer : text(b.answer, 2000, { label: 'Answer' });
        const projectId = b.project_id === undefined ? item.project_id : (await requireProject(db, client.id, b.project_id)).id;
        const position = tier === item.tier && projectId === item.project_id ? item.position : await nextPosition(db, client.id, projectId, item.kind, tier);
        const change = changeOf(item, { title, details, owner, answer, done, tier, phase, project_id: projectId });
        await db.batch([
          db.prepare(
            `UPDATE items SET title = ?, details = ?, owner = ?, answer = ?, done = ?, tier = ?, phase = ?, project_id = ?, position = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND client_id = ?`
          ).bind(title, details, owner, answer, done, tier, phase, projectId, position, item.id, client.id),
          ...change ? [logEvent(db, client.id, item.id, change[0], { title, kind: item.kind }, change[1], user)] : []
        ]);
        return json({ ok: true, items: await listItems(db, client.id) });
      }

      if (rawId && method === 'DELETE' && !action) {
        // Clients can finish or reopen items, but only Positive Tribes removes them.
        if (user.role !== 'pt') throw new InputError('Only Positive Tribes can delete items. Mark it done instead.', 403);
        const item = await requireItem(db, client.id, rawId);
        await db.batch([
          db.prepare('DELETE FROM items WHERE id = ? AND client_id = ?').bind(item.id, client.id),
          logEvent(db, client.id, item.id, 'deleted', item, '', user)
        ]);
        return json({ ok: true, items: await listItems(db, client.id) });
      }

      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      const known = error instanceof InputError;
      if (!known) console.error('hub_error', error.message);
      return json({ error: known ? error.message : 'Unable to save or load right now. Please try again.' }, known ? error.status : 500);
    }
  }
};
