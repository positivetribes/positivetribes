// Shared feedback backlog for the Project Coyote prototype.
// Items live in three priority tiers: must have, nice to have, idea for now.
// Order inside a tier is the priority order, moved up or down one step at a time.

const TIERS = ['must', 'nice', 'idea'];
// When something gets built, separate from how much it matters.
// review = new and not sorted yet, prototype = next prototype round, full = full build, later = parked.
const PHASES = ['review', 'prototype', 'full', 'later'];

// Applied once per database, only when the backlog has never been seeded.
// [tier, title, details, added_by, phase]
const seedItems = [
  ['must', 'Let people submit a sighting report',
    'Rainer put data and a photo into the prototype but could not submit the report. The prototype shows the flow only; saving real reports is part of the full build.', 'Rainer', 'full'],
  ['idea', 'Record the animal size: pup or adult', 'From Rainer: size, pup or adult.', 'Rainer', 'prototype'],
  ['idea', 'Record what the animal is doing',
    'From Rainer: behavior such as mobility, immobile, down, unresponsive, or laying in the sun (seeking warmth).', 'Rainer', 'prototype'],
  ['idea', 'Record the time of day and daytime activity',
    'From Rainer: time of day, including whether the animal is active in daylight when coyotes would normally avoid it.', 'Rainer', 'prototype'],
  ['idea', 'Note if the animal is lingering near people',
    'From Rainer: walking down streets, too weak to hunt, looking for food handouts from humans.', 'Rainer', 'prototype'],
  ['idea', 'Flag a repeated sighting',
    'From Rainer: it may be hard to recognize an individual, but coyotes can survive with mange for close to 2 years, so repeat sightings matter.', 'Rainer', 'prototype']
];
const seedVersion = 'rainer-feedback-v1';
const phaseMigration = 'phase-v1';

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

const tierOf = value => {
  if (!TIERS.includes(value)) throw new InputError('Choose must, nice, or idea.');
  return value;
};
const phaseOf = value => {
  if (!PHASES.includes(value)) throw new InputError('Choose review, prototype, full, or later.');
  return value;
};

async function body(request) {
  let result;
  try { result = await request.json(); } catch { throw new InputError('Invalid JSON.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new InputError('Expected an object.');
  return result;
}

// Hash both sides first so the comparison does not leak the passcode length or matching prefix.
async function samePasscode(given, expected) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given || '')),
    crypto.subtle.digest('SHA-256', encoder.encode(expected))
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

async function ensureSchema(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS backlog_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      tier TEXT NOT NULL CHECK(tier IN ('must','nice','idea')),
      phase TEXT NOT NULL DEFAULT 'review',
      position INTEGER NOT NULL,
      done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
      added_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS backlog_items_tier ON backlog_items(tier, position)'),
    db.prepare('CREATE TABLE IF NOT EXISTS app_seeds (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
  ]);
  // Databases created before phases existed get the column added once. Rows keep their data.
  const columns = (await db.prepare('PRAGMA table_info(backlog_items)').all()).results;
  if (!columns.some(column => column.name === 'phase')) {
    try { await db.prepare("ALTER TABLE backlog_items ADD COLUMN phase TEXT NOT NULL DEFAULT 'review'").run(); }
    catch (error) { if (!/duplicate column/i.test(String(error && error.message))) throw error; }
  }
  // One transaction: the inserts and the marker succeed together, so a second
  // simultaneous first request cannot seed twice, and removed items never return.
  await db.batch([
    ...seedItems.map(([tier, title, details, by, phase], index) => db.prepare(
      `INSERT INTO backlog_items (title, details, tier, position, added_by, phase)
       SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM app_seeds WHERE name = ?)`
    ).bind(title, details, tier, index + 1, by, phase, seedVersion)),
    db.prepare('INSERT OR IGNORE INTO app_seeds (name) VALUES (?)').bind(seedVersion)
  ]);
  // One time: sort the six starting items that were added before phases existed.
  // Skipped for databases seeded after phases, and never run again, so later edits stick.
  await db.batch([
    ...seedItems.map(([, title, , by, phase]) => db.prepare(
      `UPDATE backlog_items SET phase = ? WHERE title = ? AND added_by = ? AND phase = 'review'
       AND NOT EXISTS (SELECT 1 FROM app_seeds WHERE name = ?)`
    ).bind(phase, title, by, phaseMigration)),
    db.prepare('INSERT OR IGNORE INTO app_seeds (name) VALUES (?)').bind(phaseMigration)
  ]);
}

async function listItems(db) {
  const { results } = await db.prepare(
    `SELECT id, title, details, tier, phase, position, done, added_by, created_at, updated_at
     FROM backlog_items
     ORDER BY CASE tier WHEN 'must' THEN 0 WHEN 'nice' THEN 1 ELSE 2 END, done, position, id`
  ).all();
  return results.map(item => ({ ...item, done: Boolean(item.done) }));
}

async function requireItem(db, value) {
  const id = Number(value);
  const item = Number.isSafeInteger(id) && id > 0
    && await db.prepare('SELECT * FROM backlog_items WHERE id = ?').bind(id).first();
  if (!item) throw new InputError('Item not found.', 404);
  return item;
}

const nextPosition = (db, tier) => db.prepare(
  'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM backlog_items WHERE tier = ?'
).bind(tier).first().then(row => row.next);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (!env.BACKLOG_PASSCODE) return json({ error: 'The backlog passcode is not configured yet.', setupRequired: true }, 503);
      if (!await samePasscode(request.headers.get('x-backlog-passcode'), env.BACKLOG_PASSCODE)) {
        return json({ error: 'Incorrect passcode.' }, 401);
      }
      const db = env.DB;
      await ensureSchema(db);
      const method = request.method;
      const match = url.pathname.match(/^\/api\/items(?:\/(\d+))?(?:\/(move))?$/);
      if (!match) return json({ error: 'Not found.' }, 404);
      const [, rawId, action] = match;

      if (!rawId && method === 'GET') return json({ items: await listItems(db) });

      if (!rawId && method === 'POST') {
        const b = await body(request);
        const title = text(b.title, 140, { required: true, label: 'Title' });
        const details = text(b.details, 2000, { label: 'Details' });
        const tier = b.tier === undefined ? 'idea' : tierOf(b.tier);
        const by = text(b.added_by, 40, { label: 'Name' });
        const phase = b.phase === undefined ? 'review' : phaseOf(b.phase);
        await db.prepare(
          `INSERT INTO backlog_items (title, details, tier, phase, position, added_by)
           VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM backlog_items WHERE tier = ?), ?)`
        ).bind(title, details, tier, phase, tier, by).run();
        return json({ ok: true, items: await listItems(db) }, 201);
      }

      if (rawId && action === 'move' && method === 'POST') {
        const item = await requireItem(db, rawId);
        const b = await body(request);
        if (!['up', 'down'].includes(b.direction)) throw new InputError('Direction must be up or down.');
        const up = b.direction === 'up';
        // When the page is filtered by phase, swap with the next item in that phase so the move is visible.
        const phase = b.phase === undefined ? null : phaseOf(b.phase);
        const neighbor = await db.prepare(
          `SELECT id, position FROM backlog_items
           WHERE tier = ? AND done = ? AND position ${up ? '<' : '>'} ? AND (? IS NULL OR phase = ?)
           ORDER BY position ${up ? 'DESC' : 'ASC'} LIMIT 1`
        ).bind(item.tier, item.done, item.position, phase, phase).first();
        if (neighbor) {
          await db.batch([
            db.prepare('UPDATE backlog_items SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(neighbor.position, item.id),
            db.prepare('UPDATE backlog_items SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(item.position, neighbor.id)
          ]);
        }
        return json({ ok: true, items: await listItems(db) });
      }

      if (rawId && method === 'PATCH' && !action) {
        const item = await requireItem(db, rawId);
        const b = await body(request);
        const title = b.title === undefined ? item.title : text(b.title, 140, { required: true, label: 'Title' });
        const details = b.details === undefined ? item.details : text(b.details, 2000, { label: 'Details' });
        if (b.done !== undefined && typeof b.done !== 'boolean') throw new InputError('Done must be true or false.');
        const done = b.done === undefined ? item.done : Number(b.done);
        const tier = b.tier === undefined ? item.tier : tierOf(b.tier);
        const phase = b.phase === undefined ? item.phase : phaseOf(b.phase);
        // A change of tier lands at the bottom of the new tier so it never jumps ahead of settled priorities.
        const position = tier === item.tier ? item.position : await nextPosition(db, tier);
        await db.prepare(
          `UPDATE backlog_items SET title = ?, details = ?, done = ?, tier = ?, phase = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(title, details, done, tier, phase, position, item.id).run();
        return json({ ok: true, items: await listItems(db) });
      }

      if (rawId && method === 'DELETE' && !action) {
        const item = await requireItem(db, rawId);
        await db.prepare('DELETE FROM backlog_items WHERE id = ?').bind(item.id).run();
        return json({ ok: true, items: await listItems(db) });
      }

      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      // Never send bindings, passcodes, SQL errors, or stack traces to clients.
      const known = error instanceof InputError;
      return json({ error: known ? error.message : 'Unable to save or load right now. Please try again.' }, known ? error.status : 500);
    }
  }
};
