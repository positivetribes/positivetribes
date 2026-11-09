// Tribe Hub API: one Worker for every client. Sign-in is Cloudflare Access (emailed one-time PIN); the email is
// mapped to a users row, which decides which client the person may see. Tenant checks happen in one place (scope).
import { accessIdentity } from './access.js';
import { handleAdmin } from './admin.js';
import { windowEnd } from './dates.js';
import { listForClient, markRead } from './notifications.js';
import {
  TYPE_NAMES, costLabel, planFor, ensureGrants, ledgerOf, balanceOf, canConfirm, isLive,
  careView, todayUtc, monthOf, endOfMonth, ROLLOVER_MONTHS
} from './care.js';
import { InputError, PENDING, PENDING_STATUSES, clip, logEvent, spendRow, applyTriage, askQuestion } from './triage.js';
import { scoreManualTriage, careAnswer, runPatch } from './patch.js';
export { windowEnd };

// Credit routes take JSON only (the Origin check for every client write is in fetch below).
const isJson = request => (request.headers.get('content-type') || '').startsWith('application/json');

const TIERS = ['must', 'nice', 'idea'];
const PHASES = ['review', 'prototype', 'full', 'later'];
const KINDS = ['question', 'change', 'problem', 'request'];
const TIER_NAMES = { must: 'Must have', nice: 'Nice to have', idea: 'Idea for now' };
const PHASE_NAMES = { review: 'To review', prototype: 'Prototype', full: 'Full build', later: 'Later' };
const FIELD_NAMES = { title: 'title', details: 'details', owner: 'who answers', project_id: 'list' };

// Remembers that this person has the hub open: once per 10 minutes at most, so a page left open costs little.
const markSeen = (db, user) => db.prepare(
  "UPDATE users SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ? AND (last_seen_at IS NULL OR last_seen_at < datetime('now', '-10 minutes'))"
).bind(user.id).run();

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
});

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

// Newest first: position grows with each new document. Positive Tribes also sees documents not yet shown to the client (visible = 0).
// The client's Salesforce address is shown as a link only if it is a plain https address on Salesforce's own domains.
function safeSalesforceUrl(v) {
  try {
    const u = new URL(String(v || ''));
    return u.protocol === 'https:' && !u.username && !u.password && /(^|\.)(salesforce|force)\.com$/.test(u.hostname) ? u.href : '';
  } catch { return ''; }
}

async function listDocuments(db, clientId, everything) {
  const { results } = await db.prepare(
    `SELECT id, project_id, kind, title, url, note, status, visible, doc_date FROM documents
     WHERE client_id = ? AND (visible = 1 OR ?) ORDER BY position DESC, id DESC`
  ).bind(clientId, everything ? 1 : 0).all();
  return results.map(d => ({ ...d, visible: Boolean(d.visible) }));
}

async function listItems(db, clientId) {
  const { results } = await db.prepare(
    `SELECT i.id, i.project_id, p.slug AS project, i.kind, i.title, i.details, i.owner, i.answer, i.tier, i.phase,
            i.position, i.done, i.due_date, i.added_by, i.created_at, i.updated_at, i.legacy_id
     FROM items i JOIN projects p ON p.id = i.project_id
     WHERE i.client_id = ?
     ORDER BY p.position, p.id, i.kind DESC, CASE i.tier WHEN 'must' THEN 0 WHEN 'nice' THEN 1 ELSE 2 END, i.done, i.position, i.id`
  ).bind(clientId).all();
  return results.map(item => ({ ...item, done: Boolean(item.done) }));
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

// Ideas for the hub itself. Positive Tribes sees every client's (with the client's name); a client sees its own.
const IDEA_STATUSES = ['new', 'next', 'later', 'shipped', 'declined'];
const ideaStatusOf = oneOf(IDEA_STATUSES, 'Choose new, next, later, shipped, or declined.');
const IDEA_STATUS_NAMES = { new: 'To review', next: 'In the next hub build', later: 'Planned for later', shipped: 'Shipped', declined: 'Not planned' };
async function listIdeas(db, user) {
  const { results } = await db.prepare(
    `SELECT h.id, h.title, h.details, h.tier, h.status, h.note, h.added_by, h.created_at, h.updated_at, h.shipped_at,
            c.slug AS client_slug, COALESCE(c.name, 'Positive Tribes') AS client_name,
            (SELECT group_concat(id) FROM (SELECT id FROM hub_idea_images WHERE idea_id = h.id ORDER BY id)) AS image_ids
     FROM hub_ideas h LEFT JOIN clients c ON c.id = h.client_id
     WHERE ? OR h.client_id = ?
     ORDER BY CASE h.tier WHEN 'must' THEN 0 WHEN 'nice' THEN 1 ELSE 2 END, h.id`
  ).bind(user.role === 'pt' ? 1 : 0, user.client_id).all();
  return results.map(({ image_ids, ...idea }) => ({ ...idea, images: image_ids ? String(image_ids).split(',').map(Number) : [] }));
}
// Clients may change their own idea (wording, screenshots) until Positive Tribes has reviewed it.
function mayEditIdea(user, idea) {
  if (user.role !== 'pt' && idea.status !== 'new') throw new InputError('Positive Tribes has already reviewed this idea. Add a new one instead.', 403);
}
const MAX_IMAGE_BYTES = 1500000, MAX_IMAGES = 4;
// The type comes from the file's own first bytes, never from what the browser claims.
function imageType(bytes) {
  const at = (i, ...b) => b.every((v, n) => bytes[i + n] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}
async function requireIdea(db, user, value) {
  const id = Number(value);
  const idea = Number.isSafeInteger(id) && id > 0 && await db.prepare('SELECT * FROM hub_ideas WHERE id = ?').bind(id).first();
  if (!idea || (user.role !== 'pt' && idea.client_id !== user.client_id)) throw new InputError('Idea not found.', 404);
  return idea;
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

// The slug is [a-z0-9-] only (the route pattern), so it is safe in the URL. A client with no checks, an unset STATUS_URL or
// an unreachable status Worker all give an empty answer, so the hub never fails because of it.
export async function clientStatus(env, slug) {
  const empty = { checks: [], overall: null, page_url: null };
  if (!env.STATUS_URL) return empty;
  try {
    const res = await fetch(env.STATUS_URL + '/' + slug + '.json', { signal: AbortSignal.timeout(4000), headers: { accept: 'application/json' } });
    if (!res.ok) return empty;
    const body = await res.json();
    const checks = (Array.isArray(body.checks) ? body.checks : []).slice(0, 20).map(c => ({
      name: String(c.name || '').slice(0, 80),
      state: ['up', 'down', 'unknown'].includes(c.state) ? c.state : 'unknown',
      pct: typeof c.pct === 'number' ? c.pct : null
    }));
    return { checks, overall: ['up', 'down', 'unknown'].includes(body.overall) ? body.overall : 'unknown', page_url: env.STATUS_URL + '/' + slug };
  } catch {
    return empty;
  }
}

// A null item id means the item was just inserted in the same batch.
// Care requests: the Tribe Guide sorts each one (fix, courtesy edit, improvement with a size, or a new project), the
// director or named contact confirms improvements before any credit is used, and Positive Tribes ships it.
// Event details say what happened and what it costs, never a balance, so the bell shows nothing staff may not see.
async function careRoute({ request, db, user, client, rawId, action, method }) {
  if (!rawId && !action && method === 'GET') return json(await careView(db, client, user));
  if (!rawId || method !== 'POST' || !action || action === 'move' || action === 'signoff') return json({ error: 'Not found.' }, 404);
  if (!isJson(request)) throw new InputError('Send JSON.', 415);
  const plan = await planFor(db, client.id);
  if (!plan || plan.status !== 'active') throw new InputError('This client has no active care plan.', 409);
  const item = await requireItem(db, client.id, rawId);
  const care = await db.prepare('SELECT * FROM care_requests WHERE item_id = ? AND client_id = ?').bind(item.id, client.id).first();
  if (!care) throw new InputError('That is not a care request.', 404);
  const b = await body(request);
  const today = todayUtc(), month = monthOf(today);
  const who = user.name || user.email;
  const done = async () => json({ ok: true, care: await careView(db, client, user, today) });
  const event = (name, detail) => logEvent(db, client.id, item.id, name, { title: item.title, kind: item.kind }, detail, user);
  // An event written only while the request is still in the given state, so a losing double click logs nothing.
  const eventIf = (name, detail, statuses, credits) => db.prepare(
    `INSERT INTO events (client_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name)
     SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM care_requests WHERE item_id = ? AND client_id = ? AND status IN ${statuses} AND credits = ?)`
  ).bind(client.id, item.id, name, item.title, item.kind || '', detail, user.email, user.name, item.id, client.id, credits);
  const closeItem = db.prepare('UPDATE items SET done = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND client_id = ?').bind(item.id, client.id);
  const balanceNow = async () => { await ensureGrants(db, plan, today); return balanceOf(await ledgerOf(db, plan), today); };

  if (action === 'triage') {
    if (user.role !== 'pt') throw new InputError('Only Positive Tribes sorts requests.', 403);
    if (b.type === 'question') {
      await askQuestion(db, { client, item, care, question: text(b.question, 300, { label: 'Question', required: true }), user });
    } else {
      const note = text(b.note, 500, { label: 'Note' });
      await applyTriage(db, { client, plan, item, care, type: b.type, size: b.size, note, user, today });
    }
    // Sorting by hand still answers any suggestion Patch has waiting, so its agreement numbers stay honest.
    await scoreManualTriage(db, { client, item, kind: b.type === 'question' ? 'needs_info' : b.type, size: b.size, user });
    return done();
  }

  if (action === 'answer') {
    if (user.role === 'pt') throw new InputError('The client answers this question.', 403);
    await careAnswer(db, { client, item, care, answer: text(b.answer, 1000, { label: 'Answer', required: true }), user });
    return done();
  }

  if (action === 'confirm' || action === 'decline') {
    if (!canConfirm(user, plan)) throw new InputError('Only the director or the named care plan contact can decide this.', 403);
    if (!PENDING_STATUSES.includes(care.status)) throw new InputError('This request is not waiting for a decision.', 409);
    if (action === 'decline') {
      await db.batch([
        eventIf('declined', 'Not now · no credits used', PENDING, care.credits),
        db.prepare(`UPDATE care_requests SET status = 'declined' WHERE item_id = ? AND client_id = ? AND status IN ${PENDING}`).bind(item.id, client.id),
        closeItem
      ]);
      return done();
    }
    // Running out never blocks: the request waits for next month's credits at no cost.
    if ((await balanceNow()).available < care.credits) {
      await db.prepare("UPDATE care_requests SET status = 'waiting_credits' WHERE item_id = ? AND client_id = ? AND status = 'awaiting_confirm'").bind(item.id, client.id).run();
      return json({ ok: true, waiting: true, care: await careView(db, client, user, today) });
    }
    // The spend and the event go in only while the request still waits for a decision at the size the client saw (a
    // re-sort to another size in the meantime makes this a no-op), and the unique index allows one spend per request.
    let moved;
    try {
      [, , moved] = await db.batch([
        spendRow(db, client, plan, item, care.credits, month, `${costLabel(care)} confirmed by ${who}`, user, care.credits),
        eventIf('confirmed', `${costLabel(care)} · confirmed`, PENDING, care.credits),
        db.prepare(
          `UPDATE care_requests SET status = 'queued', confirmed_by = ?, confirmed_at = CURRENT_TIMESTAMP
           WHERE item_id = ? AND client_id = ? AND status IN ${PENDING} AND credits = ?`
        ).bind(who, item.id, client.id, care.credits)
      ]);
    } catch (error) {
      if (/UNIQUE/i.test(error.message)) throw new InputError('This request was already confirmed.', 409);
      throw error;
    }
    if (!moved.meta.changes) throw new InputError('This request changed or was already decided. Please look again.', 409);
    return done();
  }

  if (user.role !== 'pt') throw new InputError('Only Positive Tribes can do that.', 403);
  if (care.status !== 'queued') throw new InputError('Only a request in the queue can be ' + (action === 'ship' ? 'shipped.' : 'cancelled.'), 409);
  if (action === 'ship') {
    await db.batch([
      db.prepare("UPDATE care_requests SET status = 'shipped', shipped_at = CURRENT_TIMESTAMP WHERE item_id = ? AND client_id = ? AND status = 'queued'").bind(item.id, client.id),
      closeItem,
      event('shipped', `${TYPE_NAMES[care.type] || 'Request'} is live`)
    ]);
    return done();
  }
  if (action === 'cancel') {
    const spent = await db.prepare("SELECT id, -credits AS n FROM credit_ledger WHERE item_id = ? AND client_id = ? AND kind = 'spend'").bind(item.id, client.id).first();
    // Credits come back with the latest end date of what they were taken from, so returned boost credits keep their year.
    const back = spent && balanceOf(await ledgerOf(db, plan), today).drawn[spent.id];
    const expires = [endOfMonth(month, ROLLOVER_MONTHS), ...(back || []).map(d => d.expires)].sort().at(-1);
    await db.batch([
      db.prepare("UPDATE care_requests SET status = 'declined' WHERE item_id = ? AND client_id = ? AND status = 'queued'").bind(item.id, client.id),
      closeItem,
      ...spent ? [db.prepare(
        `INSERT INTO credit_ledger (client_id, care_plan_id, kind, credits, month, expires_on, item_id, note, actor_email)
         VALUES (?, ?, 'refund', ?, ?, ?, ?, ?, ?)`
      ).bind(client.id, plan.id, spent.n, month, expires, item.id, 'Cancelled before work, credits returned', user.email)] : [],
      event('cancelled', spent ? `Cancelled · ${spent.n} credit${spent.n === 1 ? '' : 's'} returned` : 'Cancelled')
    ]);
    return done();
  }
  return json({ error: 'Not found.' }, 404);
}

export default {
  // Patch's morning check (cron in wrangler.jsonc). runPatch refuses to run off the production host or without the key.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPatch(env, 'cron').then(r => console.log('patch_run', r.ran ? `checked ${r.checked}, failed ${r.failed}` : r.reason))
      .catch(error => console.error('patch_run_failed', error.message)));
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      const who = await accessIdentity(request, env, url);
      if (!who) return json({ error: 'Please sign in.' }, 401);
      const db = env.DB;
      const commandCenter = url.pathname === '/api/admin' || url.pathname.startsWith('/api/admin/');
      if (who.service) {
        // Only the command center's sync token, listed in SYNC_SERVICE_TOKENS, and only on the command center's sync routes.
        const allowed = String(env.SYNC_SERVICE_TOKENS || '').split(/[\s,]+/).filter(Boolean);
        if (!commandCenter || !allowed.includes(who.service)) return json({ error: 'Not allowed.' }, 403);
        return handleAdmin(request, env, url, { service: who.service });
      }
      const email = who.email;
      const user = await db.prepare('SELECT id, email, name, role, client_id, created_at FROM users WHERE email = ?').bind(email).first();
      // The command center is Positive Tribes' own; to anyone else it does not exist.
      if (commandCenter) {
        if (!user || user.role !== 'pt') return json({ error: 'Not found.' }, 404);
        return handleAdmin(request, env, url, { email: user.email, name: user.name });
      }
      // Signed in through Access but not invited to any workspace.
      if (!user) return json({ error: 'This email has not been invited yet. Please ask Positive Tribes.' }, 403);
      const method = request.method;
      // Every browser write must come from the hub's own page, so another site cannot make changes as a signed-in person.
      if (method !== 'GET' && method !== 'HEAD' && request.headers.get('Origin') !== url.origin) throw new InputError('Not allowed.', 403);

      if (url.pathname === '/api/me' && method === 'GET') {
        await markSeen(db, user);
        const { results: clients } = user.role === 'pt'
          ? await db.prepare('SELECT slug, name, accent, status FROM clients ORDER BY name').all()
          : await db.prepare('SELECT slug, name, accent, status FROM clients WHERE id = ?').bind(user.client_id).all();
        // Positive Tribes' own Salesforce, for the command center link; only Positive Tribes is told it.
        return json({ user: { email: user.email, name: user.name, role: user.role }, clients, ...(user.role === 'pt' ? { salesforce_url: safeSalesforceUrl(env.SF_DOMAIN) } : {}) });
      }

      // The bell, for a client's people. Positive Tribes' bell is the command center Inbox.
      if (url.pathname === '/api/notifications' || url.pathname === '/api/notifications/read' || url.pathname === '/api/notifications/clear') {
        if (user.role === 'pt') throw new InputError('Positive Tribes\' notifications are the command center Inbox.', 404);
        const client = await db.prepare('SELECT id, slug FROM clients WHERE id = ?').bind(user.client_id).first();
        if (url.pathname === '/api/notifications' && method === 'GET') {
          await markSeen(db, user);
          return json(await listForClient(db, user, client));
        }
        if (method === 'POST') {
          const b = await body(request);
          let ids = 'all';
          if (b.all !== true) {
            if (!Array.isArray(b.ids) || b.ids.length > 200 || !b.ids.every(id => Number.isSafeInteger(id) && id > 0)) throw new InputError('Choose the notifications.');
            ids = b.ids;
          }
          await markRead(db, user, client.id, ids, { clear: url.pathname.endsWith('/clear') });
          return json({ ok: true, ...await listForClient(db, user, client) });
        }
        return json({ error: 'Not found.' }, 404);
      }

      const idea = url.pathname.match(/^\/api\/ideas(?:\/(\d+)(?:\/(images)(?:\/(\d+))?)?)?$/);
      if (idea) {
        const [, ideaId, images, imageId] = idea;
        if (images) {
          const current = await requireIdea(db, user, ideaId);
          if (!imageId && method === 'POST') {
            mayEditIdea(user, current);
            const bytes = new Uint8Array(await request.arrayBuffer());
            if (!bytes.length) throw new InputError('Choose a screenshot to add.');
            if (bytes.length > MAX_IMAGE_BYTES) throw new InputError('That screenshot is too large. Try a smaller one.', 413);
            const type = imageType(bytes);
            if (!type) throw new InputError('Screenshots must be PNG, JPEG or WebP images.');
            const count = await db.prepare('SELECT COUNT(*) AS n FROM hub_idea_images WHERE idea_id = ?').bind(current.id).first();
            if (count.n >= MAX_IMAGES) throw new InputError(`An idea can have at most ${MAX_IMAGES} screenshots.`);
            await db.prepare('INSERT INTO hub_idea_images (idea_id, type, data, added_by) VALUES (?, ?, ?, ?)')
              .bind(current.id, type, bytes.buffer, user.name || user.email).run();
            return json({ ok: true, ideas: await listIdeas(db, user) }, 201);
          }
          const id = Number(imageId);
          const image = imageId && await db.prepare('SELECT * FROM hub_idea_images WHERE id = ? AND idea_id = ?').bind(id, current.id).first();
          if (!image) throw new InputError('Screenshot not found.', 404);
          if (method === 'GET') {
            return new Response(new Uint8Array(image.data), { headers: {
              'content-type': image.type, 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff',
              'content-security-policy': "default-src 'none'", 'content-disposition': 'inline'
            } });
          }
          if (method === 'DELETE') {
            mayEditIdea(user, current);
            await db.prepare('DELETE FROM hub_idea_images WHERE id = ?').bind(image.id).run();
            return json({ ok: true, ideas: await listIdeas(db, user) });
          }
          return json({ error: 'Not found.' }, 404);
        }
        if (!ideaId && method === 'GET') return json({ ideas: await listIdeas(db, user) });
        if (!ideaId && method === 'POST') {
          const b = await body(request);
          const title = text(b.title, 160, { required: true, label: 'Title' });
          const details = text(b.details, 2000, { label: 'Details' });
          const tier = b.tier === undefined ? 'idea' : tierOf(b.tier);
          const insert = db.prepare(
            'INSERT INTO hub_ideas (client_id, title, details, tier, added_by, added_email) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(user.role === 'pt' ? null : user.client_id, title, details, tier, user.name || user.email, user.email);
          // A client's idea goes to the command center Inbox; Positive Tribes' own ideas belong to no client.
          const [added] = user.role === 'pt' ? [await insert.run()]
            : await db.batch([insert, logEvent(db, user.client_id, null, 'added', { title, kind: 'idea' }, clip(details), user)]);
          // The id lets the page attach screenshots to the idea it just sent.
          return json({ ok: true, id: added.meta.last_row_id, ideas: await listIdeas(db, user) }, 201);
        }
        if (ideaId && method === 'PATCH') {
          const current = await requireIdea(db, user, ideaId);
          const b = await body(request);
          const pt = user.role === 'pt';
          // Clients may fix the wording of their idea until Positive Tribes has decided on it; only Positive Tribes decides.
          if (!pt && (current.status !== 'new' || b.status !== undefined || b.note !== undefined)) {
            throw new InputError('Positive Tribes has already reviewed this idea. Add a new one instead.', 403);
          }
          const title = b.title === undefined ? current.title : text(b.title, 160, { required: true, label: 'Title' });
          const details = b.details === undefined ? current.details : text(b.details, 2000, { label: 'Details' });
          const tier = b.tier === undefined ? current.tier : tierOf(b.tier);
          const status = b.status === undefined ? current.status : ideaStatusOf(b.status);
          const note = b.note === undefined ? current.note : text(b.note, 2000, { label: 'Reply' });
          // A decision or reply on a client's idea tells that client.
          const decided = pt && current.client_id && (status !== current.status || note !== current.note);
          await db.batch([
            db.prepare(
              `UPDATE hub_ideas SET title = ?, details = ?, tier = ?, status = ?, note = ?, updated_at = CURRENT_TIMESTAMP,
                 shipped_at = CASE WHEN ? = 'shipped' THEN COALESCE(shipped_at, CURRENT_TIMESTAMP) ELSE NULL END
               WHERE id = ?`
            ).bind(title, details, tier, status, note, status, current.id),
            ...decided ? [logEvent(db, current.client_id, current.id, 'idea_status', { title, kind: 'idea' },
              clip(IDEA_STATUS_NAMES[status] + (note ? ': ' + note : '')), user)] : []
          ]);
          return json({ ok: true, ideas: await listIdeas(db, user) });
        }
        if (ideaId && method === 'DELETE') {
          if (user.role !== 'pt') throw new InputError('Only Positive Tribes can delete ideas.', 403);
          const current = await requireIdea(db, user, ideaId);
          await db.batch([
            db.prepare('DELETE FROM hub_idea_images WHERE idea_id = ?').bind(current.id),
            db.prepare('DELETE FROM hub_ideas WHERE id = ?').bind(current.id)
          ]);
          return json({ ok: true, ideas: await listIdeas(db, user) });
        }
        return json({ error: 'Not found.' }, 404);
      }

      const match = url.pathname.match(/^\/api\/c\/([a-z0-9-]+)\/(projects|items|releases|people|notifications|status|care)(?:\/(\d+))?(?:\/(move|signoff|triage|answer|confirm|decline|ship|cancel))?$/);
      if (!match) return json({ error: 'Not found.' }, 404);
      const [, slug, resource, rawId, action] = match;
      const client = await scope(db, user, slug);

      if (resource === 'care') return await careRoute({ request, db, user, client, rawId, action, method });

      // The client's people, for Positive Tribes' "Preview as" menu. Clients never see this list.
      if (resource === 'people' && !rawId && method === 'GET') {
        if (user.role !== 'pt') return json({ error: 'Not found.' }, 404);
        const { results } = await db.prepare(
          "SELECT email, name, role FROM users WHERE client_id = ? ORDER BY CASE role WHEN 'ed' THEN 0 ELSE 1 END, name"
        ).bind(client.id).all();
        return json({ people: results });
      }

      // Positive Tribes previewing the bell as one of the client's people. Read-only: nothing is marked read.
      if (resource === 'notifications' && !rawId && method === 'GET') {
        if (user.role !== 'pt') return json({ error: 'Not found.' }, 404);
        const person = await db.prepare('SELECT id, email, name, role, client_id, created_at FROM users WHERE email = ? AND client_id = ?')
          .bind(String(url.searchParams.get('as') || ''), client.id).first();
        if (!person) throw new InputError('Choose one of this client\'s people.', 404);
        return json(await listForClient(db, person, client));
      }

      // Live system status for the client's page, read from the status Worker's public JSON view (names and up/down only).
      // scope() above already limited this to the signed-in person's own client (or Positive Tribes).
      if (resource === 'status' && !rawId && method === 'GET') return json(await clientStatus(env, client.slug));

      if (resource === 'projects' && !rawId && method === 'GET') {
        const { results } = await db.prepare(
          'SELECT id, slug, name, poc_url, live_url, phase, has_prototype FROM projects WHERE client_id = ? ORDER BY position, id'
        ).bind(client.id).all();
        return json({
          client: { slug: client.slug, name: client.name, accent: client.accent, status: client.status, go_live_date: client.go_live_date, salesforce_url: safeSalesforceUrl(client.salesforce_url) },
          projects: results,
          releases: await listReleases(db, client.id),
          documents: await listDocuments(db, client.id, user.role === 'pt')
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
        if (b.care !== undefined && b.care !== false) {
          // "Request an improvement": a backlog item plus its care request, only on a live tool with an active plan.
          if (b.care !== true) throw new InputError('care must be true or false.');
          if (!isJson(request)) throw new InputError('Send JSON.', 415);
          const plan = await planFor(db, client.id);
          if (!isLive(project, plan)) throw new InputError('Requests open once this tool is live and the care plan has started.', 409);
          await db.batch([
            db.prepare(
              `INSERT INTO items (client_id, project_id, kind, title, details, owner, tier, phase, position, added_by)
               VALUES (?, ?, 'request', ?, ?, '', 'nice', 'review', (SELECT COALESCE(MAX(position), 0) + 1 FROM items WHERE client_id = ? AND project_id = ? AND kind = 'request' AND tier = 'nice'), ?)`
            ).bind(client.id, project.id, title, details, client.id, project.id, user.name || user.email),
            // care_requests.item_id is its rowid, so last_insert_rowid() still names the item for the event below.
            db.prepare('INSERT INTO care_requests (item_id, client_id, care_plan_id) VALUES (last_insert_rowid(), ?, ?)').bind(client.id, plan.id),
            logEvent(db, client.id, null, 'added', { title, kind: 'request' }, clip(details), user)
          ]);
          return json({ ok: true, items: await listItems(db, client.id), care: await careView(db, client, user) }, 201);
        }
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
        // A care request finishes through its own steps (ship, cancel, decline) and stays on the tool it was asked for,
        // so its credits and the "shipped this month" meter always match what really happened.
        if (done !== item.done || projectId !== item.project_id) {
          const care = await db.prepare('SELECT 1 FROM care_requests WHERE item_id = ? AND client_id = ?').bind(item.id, client.id).first();
          if (care) throw new InputError('This is a care request: it closes when it ships or is cancelled, and stays on its tool.', 409);
        }
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
        // A care request with credits held is cancelled (credits returned) before it can go; its ledger rows stay.
        const care = await db.prepare('SELECT status FROM care_requests WHERE item_id = ? AND client_id = ?').bind(item.id, client.id).first();
        if (care?.status === 'queued') throw new InputError('Cancel this request first, so any credits are returned.', 409);
        await db.batch([
          db.prepare('DELETE FROM care_requests WHERE item_id = ? AND client_id = ?').bind(item.id, client.id),
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
