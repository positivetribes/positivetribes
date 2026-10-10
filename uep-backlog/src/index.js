// Shared backlog for the Up ENDing Parkinson's scheduling prototype, copied from the Project Coyote backlog.
// Two kinds of items: open questions (with who answers them and the answer) and suggested changes.
// Items live in three priority tiers. Order inside a tier is the priority order, moved up or down one step at a time.

const TIERS = ['must', 'nice', 'idea'];
// When something gets built, separate from how much it matters.
// review = new and not sorted yet, prototype = next prototype round, full = full build, later = parked.
const PHASES = ['review', 'prototype', 'full', 'later'];
const KINDS = ['question', 'change'];

// Applied once per database, only when the backlog has never been seeded.
// [tier, title, details, owner, phase, answer]. All are open questions added by Eric after the Oct 9 call and Gymdesk walkthrough.
const seedItems = [
  ['must', 'Are all 84 locations separate Gymdesk accounts?', 'Each account means a separate login and a separate export. This sets how much migration work there is.', 'Molly', 'prototype', 'Likely yes: "Movement Climbing Gyms (East)" is its own account with 71 members. Confirm the full list of accounts.'],
  ['must', 'Can every Gymdesk account export members, attendance and signed waivers as CSV?', 'Real data from a few sites would make the demo far more convincing, and decides how the switch-over works.', 'Molly', 'prototype', ''],
  ['must', 'What does "FREE - PD Climber" mean compared with the site options like "Movement - Timonium"?', 'People appear twice, once under each. The prototype treats them as one person with a home site.', 'Molly', 'prototype', ''],
  ['must', 'Do care partners need their own accounts, or are they attached to a climber?', 'The "Family" option suggests care partners attend. They may also sign or book for a climber.', 'Molly', 'prototype', ''],
  ['must', 'Who creates and changes each site\'s schedule: site leads or UEP staff?', 'Sets what a site lead is allowed to do in the app.', 'Molly', 'prototype', ''],
  ['must', 'Is a checkbox plus typed name an acceptable way to sign the waiver?', 'Drawing a signature is hard with tremor. Needs sign-off from whoever wrote the waiver.', 'UEP counsel', 'prototype', ''],
  ['must', 'May a care partner sign the waiver on a climber\'s behalf, and what proof is needed?', 'Common in this group. Usually requires legal authority, such as power of attorney.', 'UEP counsel', 'prototype', ''],
  ['must', 'Is there one waiver for all sites, or do host gyms require their own as well?', 'One UEP waiver covers "gyms affiliated with UEP". Host gyms usually have their own release too.', 'Molly', 'prototype', 'Eric believes there is one UEP waiver. Confirm whether host gym waivers are tracked.'],
  ['must', 'Is the 2 sessions per week limit on free climbers deliberate?', 'If it reflects a host gym agreement, it becomes a per-site setting. Otherwise drop it.', 'Molly', 'prototype', ''],
  ['must', 'When a session is full, should the waitlist promote people automatically?', 'Capacity limits and waitlists were requested. Auto-promotion needs a notice that reaches people in time.', 'Molly', 'prototype', ''],
  ['must', 'Should reminders go by email, text, or both?', 'Texts reach more people in this age group but cost a little per message.', 'Molly', 'prototype', ''],
  ['must', 'Which reports matter most, and for whom: board, funders, grant applications, site leads?', 'Decides what the admin dashboard shows first.', 'Molly', 'prototype', ''],
  ['must', 'What counts as an "active" climber for reports?', 'For example, attended at least once in the last 30 days. Needs to be consistent across sites.', 'Molly', 'prototype', ''],
  ['nice', 'Of the roughly 1,500 climbers, how many are currently active?', 'Tells us whether the gap to about 400 weekly sign-ups is a retention problem or a stale list.', 'Molly', 'full', ''],
  ['nice', 'Some partner gyms use their own registration pages. Should those sites move to this system too?', 'Those sites send no climber data or waivers to UEP today, so they are invisible in reports.', 'Molly', 'full', ''],
  ['nice', 'Which CRM does UEP use, and what should flow into it?', 'Gymdesk does not connect to it today. A nightly sync of new climbers may be enough.', 'Molly', 'full', ''],
  ['nice', 'Does the waiver expire or need yearly renewal?', 'Decides when climbers are asked to sign again.', 'Molly', 'full', ''],
  ['nice', 'Is medical clearance required, or is the self-certification in the waiver enough?', 'The waiver lets climbers certify they consulted a provider or declined to.', 'Molly', 'full', ''],
  ['nice', 'Do the optional donation tiers ($10, $25, $40) unlock anything?', 'None have members today. If they are only donations, they become a "Support UEP" link and leave booking.', 'Molly', 'full', ''],
  ['nice', 'Where does the climber-facing link live: upendingparkinsons.org or a separate address?', 'Affects sign-in emails and how climbers find it.', 'Eric and Molly', 'full', ''],
  ['nice', 'Who looks after the system after launch: updates, fixes and support for site leads?', 'A live booking system needs ongoing care. Agree on how that is handled before climbers depend on it.', 'Eric and Molly', 'full', ''],
  ['nice', 'Confirm the target timeline and monthly budget for running costs.', 'Earlier notes said early 2027 and under $700 per month.', 'Molly', 'full', 'From the earlier email exchange. Confirm both still hold.'],
  ['nice', 'What privacy notice do climbers see, given the program implies a Parkinson\'s diagnosis?', 'Membership alone is sensitive. Keep data minimal, limit access by site, and never sell or share it.', 'Eric and Molly', 'full', ''],
  ['idea', 'Besides the site lead, do other volunteer roles need sign-ups, such as belayers?', 'Volunteer coordination came up early. It could be a later phase.', 'Molly', 'later', '']
];
const seedVersion = 'uep-questions-v1';

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
