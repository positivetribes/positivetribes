// Bell notifications for a client's people, read from the events log. Reusable: the rules below are data about
// actions and kinds, nothing about any one client. Positive Tribes' own bell is the command center Inbox (admin.js).
import { windowEnd } from './dates.js';

// What a client person hears about. Edits, priority changes, deletes and reordering are left out as noise.
export const CLIENT_ACTIONS = ['added', 'answered', 'done', 'reopened', 'phase', 'signed_off', 'uat_started', 'live', 'shared', 'idea_status'];
export const NOTIFY_DAYS = 30;
const LIMIT = 50;
// A testing window this close to its end shows as a pinned reminder.
const REMINDER_DAYS = 3;

const addDays = (day, n) => { const d = new Date(day + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daysUntil = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400e3);
const iso = at => at.replace(' ', 'T') + (at.endsWith('Z') ? '' : 'Z');

// Where a notification opens, as an in-app hash route.
export function linkOf(slug, e) {
  if (e.item_kind === 'idea') return `#/${slug}/ideas`;
  if (e.item_kind === 'release' || e.item_kind === 'document' || !e.item_id) return `#/${slug}/home`;
  return `#/${slug}/backlog/${e.item_id}`;
}

// A teammate adding their own change is not news; Positive Tribes adding to the list, or anyone asking a question, is.
const worthTelling = e => e.action !== 'added' || (e.item_kind !== 'idea' && (e.from_pt || e.item_kind === 'question'));

export async function listForClient(db, viewer, client, today = new Date().toISOString().slice(0, 10)) {
  const marks = CLIENT_ACTIONS.map(() => '?').join(', ');
  const { results } = await db.prepare(
    `SELECT e.id, e.item_id, e.action, e.item_title, e.item_kind, e.detail, e.at,
            COALESCE(NULLIF(e.actor_name, ''), e.actor_email) AS actor,
            (r.event_id IS NOT NULL) AS read, (e.actor_email = '' OR pu.id IS NOT NULL) AS from_pt
     FROM events e
     LEFT JOIN notification_reads r ON r.event_id = e.id AND r.user_id = ?
     LEFT JOIN users pu ON pu.email = e.actor_email AND pu.role = 'pt'
     WHERE e.client_id = ? AND e.at >= ? AND e.actor_email != ? AND e.action IN (${marks})
     ORDER BY e.id DESC LIMIT ?`
  ).bind(viewer.id, client.id, addDays(today, -NOTIFY_DAYS), viewer.email, ...CLIENT_ACTIONS, LIMIT * 2).all();
  const items = results.filter(worthTelling).slice(0, LIMIT).map(e => ({
    id: e.id, action: e.action, kind: e.item_kind, title: e.item_title, detail: e.detail, actor: e.actor,
    fromPt: Boolean(e.from_pt), at: iso(e.at), read: Boolean(e.read), url: linkOf(client.slug, e)
  }));
  return { unread: items.filter(i => !i.read).length, items, reminders: await remindersFor(db, client, today) };
}

// Pinned at the top while true; they cannot be cleared and are not counted on the bell.
async function remindersFor(db, client, today) {
  const reminders = [];
  const { results: testing } = await db.prepare(
    `SELECT id, number, name, uat_started, uat_days, uat_day_type, auto_accept FROM releases
     WHERE client_id = ? AND stage = 'uat' AND uat_started IS NOT NULL ORDER BY project_id, number`
  ).bind(client.id).all();
  for (const r of testing) {
    const due = windowEnd(r.uat_started, r.uat_days, r.uat_day_type);
    const left = daysUntil(today, due);
    if (left >= 0 && left <= REMINDER_DAYS) {
      reminders.push({ type: 'testing_ends', title: r.name || 'Phase ' + r.number, due, daysLeft: left, autoAccept: Boolean(r.auto_accept), url: `#/${client.slug}/home` });
    }
  }
  const waiting = await db.prepare(
    `SELECT COUNT(*) AS n FROM items WHERE client_id = ? AND kind = 'question' AND tier = 'must' AND done = 0 AND answer = ''`
  ).bind(client.id).first();
  if (waiting.n) reminders.push({ type: 'questions', count: waiting.n, url: `#/${client.slug}/backlog` });
  return reminders;
}

// Marks the given events (or every recent one) read for this person, only ever within their own client.
export async function markRead(db, viewer, clientId, ids, today = new Date().toISOString().slice(0, 10)) {
  if (ids === 'all') {
    await db.prepare(
      'INSERT OR IGNORE INTO notification_reads (user_id, event_id) SELECT ?, id FROM events WHERE client_id = ? AND at >= ?'
    ).bind(viewer.id, clientId, addDays(today, -NOTIFY_DAYS)).run();
    return;
  }
  if (!ids.length) return;
  await db.prepare(
    `INSERT OR IGNORE INTO notification_reads (user_id, event_id) SELECT ?, id FROM events WHERE client_id = ? AND id IN (${ids.map(() => '?').join(', ')})`
  ).bind(viewer.id, clientId, ...ids).run();
}
