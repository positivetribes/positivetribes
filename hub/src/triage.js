// Sorting a care request: the one place a triage decision is applied, whether the Tribe Guide sorts it on the client's
// page or agrees with (or changes) Patch's suggestion on the Triage tab. Event details say what happened and what it
// costs, never a balance, so the bell shows nothing staff may not see.
import { SIZES, costLabel, ensureGrants, ledgerOf, balanceOf, todayUtc, monthOf } from './care.js';

export class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

export const CARE_TYPES = ['fix', 'courtesy', 'improvement', 'project'];
// Statuses as lists for checks in code, and as fixed SQL fragments built from the same lists (never from input).
export const PENDING_STATUSES = ['awaiting_confirm', 'waiting_credits'];
export const OPEN_STATUSES = ['new', ...PENDING_STATUSES];
const sqlList = list => `(${list.map(s => `'${s}'`).join(', ')})`;
export const PENDING = sqlList(PENDING_STATUSES);
export const OPEN = sqlList(OPEN_STATUSES);
export const clip = (value, max = 300) => value.length > max ? value.slice(0, max - 1) + '…' : value;

export const logEvent = (db, clientId, itemId, action, item, detail, user) => db.prepare(
  `INSERT INTO events (client_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name)
   VALUES (?, COALESCE(?, last_insert_rowid()), ?, ?, ?, ?, ?, ?)`
).bind(clientId, itemId, action, item.title, item.kind || '', detail, user.email, user.name);

// One spend for a request. With guardCredits, only while the request still waits for a decision at that size.
export const spendRow = (db, client, plan, item, credits, month, note, user, guardCredits = null) => db.prepare(
  `INSERT INTO credit_ledger (client_id, care_plan_id, kind, credits, month, item_id, note, actor_email)
   SELECT ?, ?, 'spend', ?, ?, ?, ?, ?
   WHERE ? IS NULL OR EXISTS (SELECT 1 FROM care_requests WHERE item_id = ? AND client_id = ? AND status IN ${PENDING} AND credits = ?)`
).bind(client.id, plan.id, -credits, month, item.id, clip(note, 200), user.email, guardCredits, item.id, client.id, guardCredits);

// Sorts one request: a fix goes straight to the queue, a new project is quoted separately (nothing used), an
// improvement waits for the client's OK at its size, and a courtesy edit is counted and always free.
// The caller has already checked that user is Positive Tribes and that client, plan, item and care belong together.
export async function applyTriage(db, { client, plan, item, care, type, size, note, user, today = todayUtc() }) {
  if (!OPEN_STATUSES.includes(care.status)) throw new InputError('This request has already been decided.', 409);
  if (care.type === 'courtesy') throw new InputError('This courtesy edit is already counted.', 409);
  if (!CARE_TYPES.includes(type)) throw new InputError('Choose fix, courtesy, improvement or project.');
  if (type === 'improvement' && !Object.hasOwn(SIZES, size)) throw new InputError('Choose a size: S, M or L.');
  if (type !== 'improvement') size = null;
  note = note || '';
  const month = monthOf(today);
  const who = user.name || user.email;
  const event = (name, detail) => logEvent(db, client.id, item.id, name, { title: item.title, kind: item.kind }, detail, user);
  const withNote = detail => detail + (note ? ': ' + clip(note, 200) : '');
  const closeItem = db.prepare('UPDATE items SET done = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND client_id = ?').bind(item.id, client.id);
  // Sorting answers any open question, so the request is no longer waiting on the client.
  const set = (status, credits) => db.prepare(
    `UPDATE care_requests SET type = ?, size = ?, credits = ?, status = ?, triage_note = ?, triaged_by = ?, triaged_at = CURRENT_TIMESTAMP
     WHERE item_id = ? AND client_id = ? AND status IN ${OPEN}`
  ).bind(type, size, credits, status, note, who, item.id, client.id);

  if (type === 'fix') return db.batch([set('queued', 0), event('triaged', withNote('Fix · free'))]);
  if (type === 'project') return db.batch([set('declined', 0), closeItem, event('triaged', withNote('New project · quoted separately, no credits used'))]);
  if (type === 'improvement') {
    const credits = SIZES[size];
    return db.batch([set('awaiting_confirm', credits), event('triaged', withNote(`${costLabel({ type, size, credits })} · waiting for your OK`))]);
  }
  // Courtesy edits are counted when sorted. The count row goes in first (once per request), and its place among this
  // month's count rows is its number, so two edits sorted at the same moment can never get the same one.
  await db.prepare(
    `INSERT OR IGNORE INTO credit_ledger (client_id, care_plan_id, kind, credits, month, item_id, note, actor_email) VALUES (?, ?, 'courtesy', 0, ?, ?, 'Courtesy edit', ?)`
  ).bind(client.id, plan.id, month, item.id, user.email).run();
  const mine = await db.prepare("SELECT id, month FROM credit_ledger WHERE item_id = ? AND client_id = ? AND kind = 'courtesy'").bind(item.id, client.id).first();
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE care_plan_id = ? AND client_id = ? AND kind = 'courtesy' AND month = ? AND id <= ?")
    .bind(plan.id, client.id, mine.month, mine.id).first()).n;
  return db.batch([set('queued', 0), event('triaged', withNote(`Courtesy edit ${n} this month · free`))]);
}

// "Needs more info": one clear question goes on the request; it stays with Positive Tribes (status new) until the
// client answers, and then goes back into Patch's next check. Only on a request that has not been sorted yet.
export async function askQuestion(db, { client, item, care, question, user }) {
  if (care.status !== 'new') throw new InputError('Only a request that has not been sorted yet can get a question.', 409);
  question = (question || '').trim();
  if (!question) throw new InputError('Write the question for the client.');
  if (question.length > 300) throw new InputError('The question must be at most 300 characters.');
  const [moved] = await db.batch([
    db.prepare(
      `UPDATE care_requests SET question = ?, question_at = CURRENT_TIMESTAMP, answer = '', answered_by = '', answered_at = NULL
       WHERE item_id = ? AND client_id = ? AND status = 'new'`
    ).bind(question, item.id, client.id),
    logEvent(db, client.id, item.id, 'care_question', { title: item.title, kind: item.kind }, clip(question, 300), user)
  ]);
  if (!moved.meta.changes) throw new InputError('This request changed. Please look again.', 409);
}
