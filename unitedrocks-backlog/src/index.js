// Shared backlog for the United Rocks scheduling prototype, copied from the Project Coyote backlog.
// Two kinds of items: open questions (with who answers them and the answer) and suggested changes.
// Items live in three priority tiers. Order inside a tier is the priority order, moved up or down one step at a time.

const TIERS = ['must', 'nice', 'idea'];
// When something gets built, separate from how much it matters.
// review = new and not sorted yet, prototype = next prototype round, full = full build, later = parked.
const PHASES = ['review', 'prototype', 'full', 'later'];
const KINDS = ['question', 'change'];

// Applied once per database, only when the backlog has never been seeded.
// [tier, title, details, owner, phase, answer]. Open questions Eric added when the United Rocks prototype was set up.
const seedItems = [
  ['must', 'What do you use today for team sign-ups, waivers and attendance?', 'Tells us what the new system replaces, and what has to move over.', 'Mariana', 'prototype', ''],
  ['must', 'Can you export your current climbers, families and signed waivers?', 'Real data from one or two locations would make the next demo far more convincing.', 'Mariana', 'prototype', ''],
  ['must', 'Who holds the account: the climber, a parent, or both?', 'Many climbers are kids or adults who rely on a parent or caregiver. The prototype lets a parent sign for a climber.', 'Mariana', 'prototype', ''],
  ['must', 'Can one parent manage several climbers, such as siblings?', 'If so, a parent signs in once and switches between their climbers.', 'Mariana', 'prototype', ''],
  ['must', 'How are teams organized: by age, ability, location, or a mix?', 'Decides how practices are set up and how families find the right one.', 'Mariana', 'prototype', ''],
  ['must', 'Do practices run in seasons with a registration window, or year-round?', 'Seasons change how sign-up, waitlists and reminders work.', 'Mariana', 'prototype', 'Likely year-round: the website describes weekly practices all year. Confirm there are no registration windows.'],
  ['must', 'Does each coach manage their own roster and schedule, or does staff set them centrally?', 'Sets what a coach is allowed to change in the app.', 'Mariana', 'prototype', ''],
  ['must', 'What should a coach see about each climber at practice?', 'For example medical notes, behavior support plans, or communication needs. This is sensitive, so we would show only what is needed, to that location\'s coaches only.', 'Mariana', 'prototype', ''],
  ['must', 'Do volunteer mentors sign up for practices too?', 'Coaches could see whether there are enough mentors for each practice before it starts.', 'Mariana', 'prototype', ''],
  ['must', 'Should reminders go to the climber, the parent, or both, and by text or email?', 'Texts reach families quickly but cost a little per message.', 'Mariana', 'prototype', ''],
  ['must', 'Is a checkbox plus typed name an acceptable way to sign the waiver, including a parent signing for a minor?', 'Avoids drawing a signature on a phone. Needs sign-off from whoever wrote the waiver.', 'United Rocks counsel', 'prototype', ''],
  ['must', 'How should signing work for adult climbers who have a legal guardian?', 'The guardian may need to sign, and the system may need to record that authority.', 'United Rocks counsel', 'prototype', ''],
  ['must', 'Which reports matter most, and for whom: board, funders, partner gyms, coaches?', 'Decides what the admin dashboard shows first.', 'Mariana', 'prototype', ''],
  ['nice', 'Are there fees, scholarships or donations tied to signing up?', 'If the program is free, sign-up can skip payment entirely.', 'Mariana', 'full', 'The website mentions no fees. Confirm sign-up is free.'],
  ['nice', 'How many locations and states are active today, and which gym hosts each?', 'The website lists 14 locations in 8 states in one place and 12 in 7 in another. The prototype uses sample cities.', 'Mariana', 'full', ''],
  ['nice', 'Is photo or media consent collected at sign-up?', 'It is common for youth programs and easy to add to the waiver step.', 'Mariana', 'full', ''],
  ['nice', 'Do volunteer mentors need background checks or training tracked?', 'Many youth and disability programs require it. The app could show whether each mentor is cleared.', 'Mariana', 'full', ''],
  ['nice', 'Do partner gyms need their own waiver, or a list of who is coming each practice?', 'Some gyms require their own release or a headcount ahead of time.', 'Mariana', 'full', ''],
  ['nice', 'What counts as an "active" climber for reports?', 'For example, attended at least once in the last 30 days. Needs to be the same at every location.', 'Mariana', 'full', ''],
  ['nice', 'Where does the sign-up link live: the United Rocks site or a separate address?', 'Affects sign-in emails and how families find it.', 'Eric and Mariana', 'full', ''],
  ['nice', 'What privacy notice do families see, given records include disability and support needs?', 'Keep data minimal, limit access by location, and never sell or share it.', 'Eric and Mariana', 'full', ''],
  ['nice', 'Who looks after the system after launch: updates, fixes and support for coaches?', 'A live sign-up system needs ongoing care. Agree on how that is handled before families depend on it.', 'Eric and Mariana', 'full', ''],
  ['nice', 'What timeline and monthly budget do you have in mind for running costs?', 'Shapes which version of the full build makes sense.', 'Mariana', 'full', ''],
  ['idea', 'Should families be able to message their coach in the app?', 'Useful, but it adds moderation and safeguarding work. Could come later.', 'Mariana', 'later', ''],
  ['idea', 'Should the app track mentor hours for the Mentor Certificate of Service?', 'Check-ins already record who was there, so hours could add up automatically.', 'Mariana', 'later', ''],
  ['idea', 'Is there interest in tracking skills or progress over a season?', 'Could be motivating for climbers and useful for funders. Not needed for scheduling.', 'Mariana', 'later', '']
];
const seedVersion = 'unitedrocks-questions-v1';

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
const kindOf = value => {
  if (!KINDS.includes(value)) throw new InputError('Choose question or change.');
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
      kind TEXT NOT NULL DEFAULT 'change' CHECK(kind IN ('question','change')),
      title TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT '',
      answer TEXT NOT NULL DEFAULT '',
      tier TEXT NOT NULL CHECK(tier IN ('must','nice','idea')),
      phase TEXT NOT NULL DEFAULT 'review',
      position INTEGER NOT NULL,
      done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
      added_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare('CREATE INDEX IF NOT EXISTS backlog_items_tier ON backlog_items(kind, tier, position)'),
    db.prepare('CREATE TABLE IF NOT EXISTS app_seeds (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)')
  ]);
  // One transaction: the inserts and the marker succeed together, so a second
  // simultaneous first request cannot seed twice, and removed items never return.
  await db.batch([
    ...seedItems.map(([tier, title, details, owner, phase, answer], index) => db.prepare(
      `INSERT INTO backlog_items (kind, title, details, owner, answer, tier, position, added_by, phase)
       SELECT 'question', ?, ?, ?, ?, ?, ?, 'Eric', ? WHERE NOT EXISTS (SELECT 1 FROM app_seeds WHERE name = ?)`
    ).bind(title, details, owner, answer, tier, index + 1, phase, seedVersion)),
    db.prepare('INSERT OR IGNORE INTO app_seeds (name) VALUES (?)').bind(seedVersion)
  ]);
}

async function listItems(db) {
  const { results } = await db.prepare(
    `SELECT id, kind, title, details, owner, answer, tier, phase, position, done, added_by, created_at, updated_at
     FROM backlog_items
     ORDER BY kind DESC, CASE tier WHEN 'must' THEN 0 WHEN 'nice' THEN 1 ELSE 2 END, done, position, id`
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

// Order is kept per kind and tier: questions and changes are listed separately.
const nextPosition = (db, kind, tier) => db.prepare(
  'SELECT COALESCE(MAX(position), 0) + 1 AS next FROM backlog_items WHERE kind = ? AND tier = ?'
).bind(kind, tier).first().then(row => row.next);

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
        const title = text(b.title, 160, { required: true, label: 'Title' });
        const details = text(b.details, 2000, { label: 'Details' });
        const tier = b.tier === undefined ? 'idea' : tierOf(b.tier);
        const by = text(b.added_by, 40, { label: 'Name' });
        const phase = b.phase === undefined ? 'review' : phaseOf(b.phase);
        const kind = b.kind === undefined ? 'change' : kindOf(b.kind);
        const owner = text(b.owner, 60, { label: 'Who answers' });
        await db.prepare(
          `INSERT INTO backlog_items (kind, title, details, owner, tier, phase, position, added_by)
           VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM backlog_items WHERE kind = ? AND tier = ?), ?)`
        ).bind(kind, title, details, owner, tier, phase, kind, tier, by).run();
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
           WHERE kind = ? AND tier = ? AND done = ? AND position ${up ? '<' : '>'} ? AND (? IS NULL OR phase = ?)
           ORDER BY position ${up ? 'DESC' : 'ASC'} LIMIT 1`
        ).bind(item.kind, item.tier, item.done, item.position, phase, phase).first();
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
        const title = b.title === undefined ? item.title : text(b.title, 160, { required: true, label: 'Title' });
        const details = b.details === undefined ? item.details : text(b.details, 2000, { label: 'Details' });
        if (b.done !== undefined && typeof b.done !== 'boolean') throw new InputError('Done must be true or false.');
        const done = b.done === undefined ? item.done : Number(b.done);
        const tier = b.tier === undefined ? item.tier : tierOf(b.tier);
        const phase = b.phase === undefined ? item.phase : phaseOf(b.phase);
        const owner = b.owner === undefined ? item.owner : text(b.owner, 60, { label: 'Who answers' });
        const answer = b.answer === undefined ? item.answer : text(b.answer, 2000, { label: 'Answer' });
        // A change of tier lands at the bottom of the new tier so it never jumps ahead of settled priorities.
        const position = tier === item.tier ? item.position : await nextPosition(db, item.kind, tier);
        await db.prepare(
          `UPDATE backlog_items SET title = ?, details = ?, owner = ?, answer = ?, done = ?, tier = ?, phase = ?, position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
        ).bind(title, details, owner, answer, done, tier, phase, position, item.id).run();
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
