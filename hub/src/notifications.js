// Bell notifications for a client's people, read from the events log. Reusable: the rules below are data about
// actions and kinds, nothing about any one client. Positive Tribes' own bell is the command center Inbox (admin.js).
import { windowEnd } from './dates.js';

// What a client person hears about. Edits, priority changes, deletes and reordering are left out as noise.
export const CLIENT_ACTIONS = ['added', 'answered', 'done', 'reopened', 'phase', 'signed_off', 'uat_started', 'live', 'shared', 'idea_status',
  // Care requests: sorted, confirmed or declined, shipped, cancelled (details carry the cost, never a balance).
  'triaged', 'confirmed', 'declined', 'shipped', 'cancelled'];
export const NOTIFY_DAYS = 30;
// The bell went live here; what was logged before (including history imported from the old backlog sites) is not
// news. A person invited later starts from the day they were invited.
export const NOTIFY_SINCE = '2026-11-02 13:00:00';
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
// A move between build phases is news only on something the client's own people suggested.
const worthTelling = e => {
  if (e.action === 'added') return e.item_kind !== 'idea' && Boolean(e.from_pt || e.item_kind === 'question');
  if (e.action === 'phase') return Boolean(e.client_added);
  return true;
};
// The later of: 30 days ago, the bell's start, the day this person was invited.
const startFor = (viewer, today) => [addDays(today, -NOTIFY_DAYS), NOTIFY_SINCE, viewer.created_at || ''].sort().at(-1);

export async function listForClient(db, viewer, client, today = new Date().toISOString().slice(0, 10)) {
  const marks = CLIENT_ACTIONS.map(() => '?').join(', ');
  const { results } = await db.prepare(
    `SELECT e.id, e.item_id, e.action, e.item_title, e.item_kind, e.detail, e.at,
            COALESCE(NULLIF(e.actor_name, ''), e.actor_email) AS actor,
            (r.event_id IS NOT NULL) AS read, (e.actor_email = '' OR pu.id IS NOT NULL) AS from_pt,
            EXISTS (SELECT 1 FROM items i JOIN users cu ON cu.client_id = i.client_id AND i.added_by IN (cu.name, cu.email)
                    WHERE i.id = e.item_id AND i.client_id = e.client_id AND e.item_kind NOT IN ('idea', 'release', 'document')) AS client_added
     FROM events e
     LEFT JOIN notification_reads r ON r.event_id = e.id AND r.user_id = ?
     LEFT JOIN users pu ON pu.email = e.actor_email AND pu.role = 'pt'
     WHERE e.client_id = ? AND e.at >= ? AND e.actor_email != ? AND e.action IN (${marks}) AND COALESCE(r.cleared, 0) = 0
     ORDER BY e.id DESC LIMIT ?`
  ).bind(viewer.id, client.id, startFor(viewer, today), viewer.email, ...CLIENT_ACTIONS, LIMIT * 2).all();
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

// Marks the given events (or every recent one) read, or clears them from the list, for this person; only ever
// within their own client.
export async function markRead(db, viewer, clientId, ids, { clear = false, today = new Date().toISOString().slice(0, 10) } = {}) {
  if (ids !== 'all' && !ids.length) return;
  const which = ids === 'all' ? 'at >= ?' : `id IN (${ids.map(() => '?').join(', ')})`;
  const values = ids === 'all' ? [startFor(viewer, today)] : ids;
  await db.prepare(
    `INSERT INTO notification_reads (user_id, event_id, cleared) SELECT ?, id, ? FROM events WHERE client_id = ? AND ${which} AND true
     ON CONFLICT (user_id, event_id) DO UPDATE SET cleared = MAX(cleared, excluded.cleared)`
  ).bind(viewer.id, clear ? 1 : 0, clientId, ...values).run();
}
