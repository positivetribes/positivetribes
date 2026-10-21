// Shared backlog for the Sober AF Chapters prototype, copied from the United Rocks backlog.
// Two kinds of items: open questions (with who answers them and the answer) and suggested changes.
// Items live in three priority tiers. Order inside a tier is the priority order, moved up or down one step at a time.

const TIERS = ['must', 'nice', 'idea'];
// When something gets built, separate from how much it matters.
// review = new and not sorted yet, prototype = next prototype round, full = full build, later = parked.
const PHASES = ['review', 'prototype', 'full', 'later'];
const KINDS = ['question', 'change'];

// Applied once per database, only when the backlog has never been seeded.
// [tier, title, details, owner, phase, answer]. Open questions Eric added from the placeholders in the Sober AF Chapters prototype.
const seedItems = [
  ['must', 'Who reviews host applications today, and how quickly can SAFE respond?', 'The prototype tells applicants to expect an answer within about a week. Sets who gets the SAFE admin view.', 'Duke', 'prototype', ''],
  ['must', 'Can your existing peer training become the five host training modules?', 'The prototype has draft modules on peer support, safety, events, money and the brand. Real content would replace them.', 'Duke', 'prototype', 'SAFE already runs peer training (soberafe.com/peer-training). Confirm what it covers and whether hosts would take it too.'],
  ['must', 'How many peers should be on site for a given number of attendees?', 'Hosts plan staffing from this ratio. The prototype shows it as a placeholder.', 'Duke', 'prototype', ''],
  ['must', 'Who approves a host\'s event: SAFE staff, the chapter lead, or either one?', 'The prototype lets either approve. Some events may need both.', 'Duke', 'prototype', ''],
  ['must', 'How far ahead must a host submit an event?', 'The prototype uses 3 weeks as a placeholder. Leaves time for approval, the venue waiver and promotion.', 'Duke', 'prototype', ''],
  ['must', 'Do hosts need a background check, and who pays for it?', 'Hosts run public events for people in recovery. The host agreement has a placeholder for this.', 'Duke', 'prototype', ''],
  ['must', 'How often does host certification renew, and what does the refresher cover?', 'The prototype shows yearly renewal with a short refresher as a placeholder.', 'Duke', 'prototype', ''],
  ['must', 'How should ticket and donation money flow to SAFE?', 'Hosts are told money never goes through a personal account. The app needs to know the approved process, such as a ticketing link or donation page.', 'Duke', 'prototype', ''],
  ['must', 'Does SAFE have a brand guide hosts can follow for the Sober AF name and logo?', 'Training tells hosts to use the brand only for approved events. A guide or logo kit would be linked there.', 'Duke', 'prototype', ''],
  ['must', 'What should a host do and file after an incident, such as an overdose or a safety issue?', 'Training tells hosts to call 911 or 988 and then tell their chapter lead. The incident form is a placeholder.', 'Duke', 'prototype', ''],
  ['must', 'How should the venue waiver handle alcohol sold near the sober section?', 'Many venues will still sell alcohol elsewhere. The waiver says none is sold inside the section.', 'Duke', 'prototype', ''],
  ['must', 'What release wording should the host agreement use?', 'Hosts volunteer and release SAFE from claims arising from their own conduct. Needs counsel\'s wording.', 'SAFE counsel', 'prototype', ''],
  ['must', 'What insurance amount and indemnity wording should the venue waiver use?', 'The host site waiver asks venues to carry liability insurance and name SAFE as additional insured.', 'SAFE counsel', 'prototype', ''],
  ['nice', 'Which cities would the first chapters be in?', 'The prototype uses sample chapters. Starting with real cities makes the next demo concrete.', 'Duke', 'full', ''],
  ['nice', 'Who could serve as the first chapter leads?', 'Chapter leads sign off on new hosts after they shadow an event, and review their hosts\' events.', 'Duke', 'full', ''],
  ['nice', 'How much notice should a venue or host give to cancel?', 'The venue waiver uses 7 days as a placeholder, or any time for safety reasons.', 'Duke', 'full', ''],
  ['nice', 'How long should the host training take?', 'The prototype says about 2 hours. Shorter training brings in more hosts, longer training builds confidence.', 'Duke', 'full', ''],
  ['nice', 'What does SAFE use today to track peers, volunteers, events and donors?', 'Sets what the chapters system connects to. If SAFE gets Salesforce through Power of Us, hosts and events could sync there.', 'Duke', 'full', ''],
  ['nice', 'Should approved events show up on soberafe.com/events automatically?', 'Saves posting each event twice and keeps the public calendar complete.', 'Duke', 'full', ''],
  ['nice', 'Where should the chapters site live: soberafe.com or a separate address?', 'Affects sign-in emails and how hosts and attendees find it.', 'Eric and Duke', 'full', ''],
  ['nice', 'Which numbers matter most for the board and funders?', 'For example events held, attendees reached, certified hosts and active chapters. Decides what the admin view shows first.', 'Duke', 'full', ''],
  ['nice', 'What privacy notice should hosts and attendees see, given attending can imply someone is in recovery?', 'Keep data minimal, limit access by chapter, never post anyone without consent, and never sell or share it.', 'Eric and Duke', 'full', ''],
  ['nice', 'Who looks after the system after launch: updates, fixes and support for hosts?', 'A live system needs ongoing care. Agree on how that is handled before hosts depend on it.', 'Eric and Duke', 'full', ''],
  ['nice', 'What timeline and monthly budget do you have in mind for running costs?', 'Shapes which version of the full build makes sense.', 'Duke', 'full', ''],
  ['idea', 'Should attendees check in at sober sections so SAFE can count who it reaches?', 'Useful for funders, but it adds a step at the door and more personal data to protect.', 'Duke', 'later', ''],
  ['idea', 'Should the app track volunteer hours for hosts and peers?', 'Events already record who hosted, so hours could add up automatically.', 'Duke', 'later', ''],
  ['idea', 'Should hosts in a chapter be able to message each other and their lead in the app?', 'Useful for coordinating, but a group chat may already cover it. Could come later.', 'Duke', 'later', '']
];
const seedVersion = 'soberafe-questions-v1';

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
