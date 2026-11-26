// Client emails: the hub tells each client person, by email, what is waiting on them, so they come back to the hub.
// Reusable: nothing here is about one client. Two kinds:
//  1. Instant (hourly cron, business hours only): a question named for them, an estimate they decide, a phase ready to
//     test or live, and a testing window ending within 3 days. One email per person per run, listing everything new.
//  2. The Monday summary (WEB_CRON): what's waiting on them, what's in testing, what was finished last week. Skipped when
//     all three are empty.
// Off for every client until Positive Tribes sets clients.email_mode (migration 0043): 'preview' sends every email to
// Eric (ALERT_TO, over ALERT_MAIL) with the person named in the subject; 'live' sends to the person over CLIENT_MAIL.
// Emails carry titles, names of phases and links only, never answers, details, screenshots or prices: the rest stays
// behind sign-in. Each person picks all, weekly or off (users.email_pref). Failures are retried next run and emailed
// to Eric once a day. Logs carry counts only, never addresses or titles.
import { isBusinessTime, dayMT } from './businesshours.js';
import { windowEnd } from './dates.js';
import { canDecideEstimate } from './estimates.js';

const HUB = 'https://hub.positivetribes.org';
const FROM = 'hello@positivetribes.org';
const REPLY_TO = 'eric@positivetribes.org';
// lookbackHours must outlast the longest gap between instant runs (Friday 5:30pm to Monday 8:30am is 63 hours); the
// email_log keys stop repeats, and email_since still caps it for a client just turned on.
export const MAIL = { lookbackHours: 7 * 24, testingDays: 3, listMax: 8, shippedDays: 7 };
// 'edited' only counts when it changed who answers a question (a question named for someone after it was added).
const INSTANT_ACTIONS = ['added', 'edited', 'estimate_offered', 'uat_started', 'live'];

const sqlTime = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const oneLine = (s, n = 140) => { const t = String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const q = t => '“' + oneLine(t) + '”';
const daysUntil = (from, to) => Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400e3);
const niceDay = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const validEmail = e => /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i.test(e || '');

// Whole-word owner matching, the same rule as ownedBy in public/index.html: the person's first name must be a word of
// the item's owner ("Al" is not "Sally").
const nameWords = s => (s || '').toLowerCase().split(/[\s,;/&+()]+/u)
  .map(w => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}\p{M}]+$/gu, '').replace(/['’]s$/u, '')).filter(Boolean);
export const ownedBy = (owner, personName) => {
  const want = nameWords((personName || '').split(/\s+/)[0]), have = nameWords(owner);
  return want.length > 0 && want.every(w => have.includes(w));
};

// A phase event's title is only the phase ("Phase 3"); name the project too, as the testing reminders do.
const phaseName = e => oneLine(e.project ? `${e.project} ${e.item_title}` : e.item_title);
const link = (slug, path) => `${HUB}/#/${slug}/${path}`;
const itemLink = (slug, id) => link(slug, 'backlog/' + Number(id));

async function clientsOn(db) {
  return (await db.prepare("SELECT id, slug, name, email_mode, email_since FROM clients WHERE email_mode != 'off' AND status != 'closed' ORDER BY id").all()).results;
}
async function peopleOf(db, clientId, prefs) {
  const marks = prefs.map(() => '?').join(', ');
  return (await db.prepare(`SELECT id, email, name, role FROM users WHERE client_id = ? AND role IN ('ed', 'staff') AND email_pref IN (${marks}) ORDER BY id`)
    .bind(clientId, ...prefs).all()).results.filter(u => validEmail(u.email));
}
const planOf = (db, clientId) => db.prepare('SELECT balance_contact_user_id FROM care_plans WHERE client_id = ?').bind(clientId).first();
// Keys already handled. Failed ones are retried; once a client is live, what only went to Eric in preview counts as unsent.
async function loggedKeys(db, client) {
  const { results } = await db.prepare("SELECT key FROM email_log WHERE client_id = ? AND status != 'failed' AND NOT (status = 'preview' AND ? = 'live')")
    .bind(client.id, client.email_mode).all();
  return new Set(results.map(r => r.key));
}
// The Monday of this Mountain-time week, which names the week's summary.
const mondayMT = now => { const d = new Date(dayMT(now) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7); return d.toISOString().slice(0, 10); };
async function testingReleases(db, clientId) {
  const { results } = await db.prepare(
    `SELECT r.id, r.number, r.name, r.uat_started, r.uat_days, r.uat_day_type, p.name AS project FROM releases r JOIN projects p ON p.id = r.project_id
     WHERE r.client_id = ? AND r.stage = 'uat' AND r.uat_started IS NOT NULL ORDER BY p.position, r.number`
  ).bind(clientId).all();
  return results.map(r => ({ ...r, label: `${r.project} ${r.name || 'Phase ' + r.number}`, ends: windowEnd(r.uat_started, r.uat_days, r.uat_day_type) }));
}

// The email itself: a short list of lines, each with its link, in plain text and simple HTML.
export function compose(client, person, { subject, intro, sections }) {
  const foot = `You get these emails because you're on ${client.name}'s Tribe Hub. To get fewer, open the bell at the top of the hub and change "Email me".`;
  const text = [`Hi ${oneLine(person.name).split(' ')[0] || 'there'},`, '', intro, '',
    ...sections.flatMap(s => [s.title + ':', ...s.lines.map(l => `- ${l.text}\n  ${l.url}`), '']),
    `Open your hub: ${link(client.slug, 'home')}`, '', foot].join('\n');
  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:15px;line-height:1.5;color:#1f1f1f;max-width:560px">` +
    `<p>Hi ${esc(oneLine(person.name).split(' ')[0] || 'there')},</p><p>${esc(intro)}</p>` +
    sections.map(s => `<p style="margin:18px 0 6px;font-weight:600">${esc(s.title)}</p><ul style="margin:0;padding-left:20px">` +
      s.lines.map(l => `<li style="margin:4px 0"><a href="${esc(l.url)}" style="color:#a8492c">${esc(l.text)}</a></li>`).join('') + '</ul>').join('') +
    `<p style="margin-top:22px"><a href="${esc(link(client.slug, 'home'))}" style="color:#a8492c;font-weight:600">Open your hub</a></p>` +
    `<p style="margin-top:22px;color:#6b6b6b;font-size:13px">${esc(foot)}</p></div>`;
  return { subject: oneLine(subject, 160), text, html };
}

// Preview sends to Eric over the existing alert binding; live sends to the person over CLIENT_MAIL.
async function deliver(env, client, person, mail) {
  if (client.email_mode === 'preview') {
    if (!env.ALERT_MAIL || !env.ALERT_TO) throw new Error('ALERT_MAIL is not bound');
    await env.ALERT_MAIL.send({ from: FROM, to: env.ALERT_TO, subject: oneLine(`[Preview for ${person.name || 'client'}, ${person.email}] ${mail.subject}`, 200), text: mail.text, html: mail.html });
    return 'preview';
  }
  if (client.email_mode !== 'live') throw new Error('email is off');
  if (!env.CLIENT_MAIL) throw new Error('CLIENT_MAIL is not bound');
  // CLIENT_MAIL_BCC (a wrangler var): Eric gets a blind copy of every live email while the feature settles in. Blank it to stop.
  const bcc = validEmail(env.CLIENT_MAIL_BCC) ? { bcc: env.CLIENT_MAIL_BCC } : {};
  await env.CLIENT_MAIL.send({ from: { email: FROM, name: 'Tribe Hub' }, to: { email: person.email, name: oneLine(person.name, 80) || person.email }, ...bcc, replyTo: REPLY_TO, subject: mail.subject, text: mail.text, html: mail.html });
  return 'sent';
}

// The keys are marked 'pending' before sending: if that write fails nothing is sent, and if the write after sending
// fails the 'pending' rows still stop the next run from sending the same email again (and Eric hears about it).
async function sendAndLog(env, client, person, kind, keys, mail, out) {
  const db = env.DB;
  const log = (status, error = '') => db.batch(keys.map(k => db.prepare(
    `INSERT INTO email_log (key, client_id, user_id, kind, status, error) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET status = excluded.status, error = excluded.error, at = CURRENT_TIMESTAMP`
  ).bind(k, client.id, person.id, kind, status, error)));
  try { await log('pending'); } catch (e) { out.failed++; out.errors.push(`${client.slug}: not sent, could not write email_log: ${oneLine(e.message, 200)}`); return; }
  let status, error = '';
  try { status = await deliver(env, client, person, mail); } catch (e) { status = 'failed'; error = oneLine(e.message, 200); }
  out[status === 'failed' ? 'failed' : status === 'preview' ? 'previewed' : 'sent']++;
  if (status === 'failed') out.errors.push(`${client.slug}: ${error}`);
  try { await log(status, error); } catch (e) { out.errors.push(`${client.slug}: ${status} but email_log still says pending: ${oneLine(e.message, 200)}`); }
}

// 1. Instant emails.
export async function runClientInstant(env, now = Date.now()) {
  if (!env.DB) return { ran: false, reason: 'no database' };
  if (!isBusinessTime(now)) return { ran: false, reason: 'outside business hours' };
  const db = env.DB;
  const out = { ran: true, sent: 0, previewed: 0, failed: 0, errors: [] };
  let clients = [];
  try { clients = await clientsOn(db); } catch (e) { out.errors.push(`could not list clients: ${oneLine(e.message, 200)}`); }
  for (const client of clients) {
    try { await instantFor(env, client, now, out); } catch (e) { out.errors.push(`${client.slug}: stopped: ${oneLine(e.message, 200)}`); }
  }
  await reportFailures(env, now, out, 'instant');
  return out;
}

// 2. The Monday summary. With retryOnly (the hourly cron, business hours), it resends only this week's failed summaries.
export async function runClientDigest(env, now = Date.now(), { retryOnly = false } = {}) {
  if (!env.DB) return { ran: false, reason: 'no database' };
  if (retryOnly && !isBusinessTime(now)) return { ran: false, reason: 'outside business hours' };
  const db = env.DB, week = mondayMT(now);
  const out = { ran: true, week, sent: 0, previewed: 0, failed: 0, skipped: 0, errors: [] };
  let clients = [];
  try { clients = await clientsOn(db); } catch (e) { out.errors.push(`could not list clients: ${oneLine(e.message, 200)}`); }
  for (const client of clients) {
    try { await digestFor(env, client, now, out, week, retryOnly); } catch (e) { out.errors.push(`${client.slug}: stopped: ${oneLine(e.message, 200)}`); }
  }
  await reportFailures(env, now, out, 'digest');
  return out;
}

// Failures reach Eric once a day (support_alerts, migration 0042), never silently. No client content in the email.
async function reportFailures(env, now, out, kind) {
  if (!out.errors.length || !env.ALERT_MAIL || !env.ALERT_TO) return;
  const key = `client-mail-errors:${kind}:${dayMT(now)}`;
  if (await env.DB.prepare('SELECT 1 FROM support_alerts WHERE key = ?').bind(key).first()) return;
  try {
    await env.ALERT_MAIL.send({ from: FROM, to: env.ALERT_TO, subject: out.failed ? `Client email: ${out.failed} ${kind} email${out.failed === 1 ? '' : 's'} failed` : `Client email: the ${kind} run hit a problem`,
      text: `The hub could not send these client emails. They are retried on the next run.\n\n${[...new Set(out.errors)].map(e => '- ' + e).join('\n')}\n\nSee email_log in hub-db (status 'failed' or 'pending').` });
    await env.DB.prepare('INSERT OR REPLACE INTO support_alerts (key, stage) VALUES (?, ?)').bind(key, 'sent').run();
  } catch (error) { console.error('client_mail_report_failed', error.message); }
}

// A person's own choice, from the bell. Only their own row.
export const EMAIL_PREFS = ['all', 'weekly', 'off'];
export async function setEmailPref(db, user, pref) {
  if (!EMAIL_PREFS.includes(pref)) return false;
  await db.prepare('UPDATE users SET email_pref = ? WHERE id = ?').bind(pref, user.id).run();
  return true;
}

// One client's instant emails; an error here stops only this client (runClientInstant reports it).
async function instantFor(env, client, now, out) {
  const db = env.DB, today = dayMT(now);
  const people = await peopleOf(db, client.id, ['all']);
  if (!people.length) return;
  const since = [sqlTime(now - MAIL.lookbackHours * 3600e3), client.email_since || ''].sort().at(-1);
  const marks = INSTANT_ACTIONS.map(() => '?').join(', ');
  const { results: events } = await db.prepare(
    `SELECT e.id, e.action, e.item_id, e.item_title, e.item_kind, e.detail, e.actor_email, i.owner, i.done, i.answer, i.asks_back, ce.status AS estimate, p.name AS project
     FROM events e
     LEFT JOIN items i ON i.id = e.item_id AND i.client_id = e.client_id AND e.item_kind NOT IN ('release', 'idea', 'document')
     LEFT JOIN change_estimates ce ON ce.item_id = i.id AND ce.client_id = e.client_id
     LEFT JOIN releases r ON r.id = e.item_id AND r.client_id = e.client_id AND e.item_kind = 'release'
     LEFT JOIN projects p ON p.id = r.project_id
     WHERE e.client_id = ? AND e.at >= ? AND e.action IN (${marks}) ORDER BY e.id`
  ).bind(client.id, since, ...INSTANT_ACTIONS).all();
  const testing = (await testingReleases(db, client.id)).filter(r => { const left = daysUntil(today, r.ends); return left >= 0 && left <= MAIL.testingDays; });
  const plan = await planOf(db, client.id);
  const logged = await loggedKeys(db, client);
  for (const person of people) {
    const lines = [];
    for (const e of events) {
      if (e.actor_email && e.actor_email.toLowerCase() === person.email.toLowerCase()) continue;
      // A question is told once per person (keyed by the item), whether it was named for them when added or later.
      const named = e.action === 'added' || (e.action === 'edited' && String(e.detail || '').includes('who answers'));
      if (named && e.item_kind === 'question') {
        const qkey = `question:${person.id}:${e.item_id}`;
        if (!logged.has(qkey) && e.done === 0 && (!e.answer || e.asks_back) && ownedBy(e.owner, person.name)) lines.push({ key: qkey, group: 'For you', text: `A question for you: ${q(e.item_title)}`, url: itemLink(client.slug, e.item_id) });
        continue;
      }
      const key = `instant:${person.id}:${e.id}`;
      if (logged.has(key)) continue;
      if (e.action === 'estimate_offered' && e.estimate === 'offered' && canDecideEstimate(person, plan)) lines.push({ key, group: 'For you', text: `An estimate for you to decide: ${q(e.item_title)}`, url: itemLink(client.slug, e.item_id) });
      else if (e.action === 'uat_started') lines.push({ key, group: 'News', text: `${phaseName(e)} is ready for you to test`, url: link(client.slug, 'home') });
      else if (e.action === 'live') lines.push({ key, group: 'News', text: `${phaseName(e)} is live`, url: link(client.slug, 'home') });
    }
    for (const r of testing) {
      const key = `testing:${person.id}:${r.id}:${r.ends}`;
      if (logged.has(key)) continue;
      const left = daysUntil(today, r.ends);
      lines.push({ key, group: 'For you', text: `Testing for ${oneLine(r.label)} ends ${left === 0 ? 'today' : left === 1 ? 'tomorrow' : niceDay(r.ends)}`, url: link(client.slug, 'home') });
    }
    // The same news twice (a phase restarted, an item re-added) reads as one line; every key is still logged.
    const seen = new Map();
    for (const l of lines) { const k = l.text + ' ' + l.url; if (seen.has(k)) seen.get(k).keys.push(l.key); else seen.set(k, { ...l, keys: [l.key] }); }
    lines.length = 0; lines.push(...seen.values());
    if (!lines.length) continue;
    const sections = ['For you', 'News'].map(g => ({ title: g === 'For you' ? 'Waiting on you' : 'News', lines: lines.filter(l => l.group === g) })).filter(s => s.lines.length);
    const subject = lines.length === 1 ? lines[0].text : `${lines.length} updates on your ${client.name} hub`;
    const mail = compose(client, person, { subject, intro: `Here's what's new on your ${client.name} hub.`, sections });
    await sendAndLog(env, client, person, 'instant', lines.flatMap(l => l.keys), mail, out);
  }
}

// One client's digest emails; an error here stops only this client (runClientDigest reports it).
async function digestFor(env, client, now, out, week, retryOnly) {
  const db = env.DB;
  let retry = null;
  if (retryOnly) {
    const { results } = await db.prepare("SELECT key FROM email_log WHERE client_id = ? AND kind = 'digest' AND status = 'failed' AND key LIKE ?")
      .bind(client.id, '%:' + week).all();
    if (!results.length) return;
    retry = new Set(results.map(r => r.key));
  }
  const people = await peopleOf(db, client.id, ['all', 'weekly']);
  if (!people.length) return;
  const { results: open } = await db.prepare(
    `SELECT i.id, i.kind, i.title, i.owner, i.status, i.proposal_state, i.due_date, i.answer, i.asks_back, ce.status AS estimate
     FROM items i LEFT JOIN change_estimates ce ON ce.item_id = i.id AND ce.client_id = i.client_id
     WHERE i.client_id = ? AND i.done = 0 AND i.kind IN ('question', 'change')
     ORDER BY CASE WHEN i.due_date = '' THEN 1 ELSE 0 END, i.due_date, i.id`
  ).bind(client.id).all();
  // A window that has ended but isn't signed off yet is not "in testing" any more.
  const testing = (await testingReleases(db, client.id)).filter(r => daysUntil(dayMT(now), r.ends) >= 0);
  const { results: finished } = await db.prepare(
    `SELECT e.action, e.item_title, p.name AS project FROM events e
     LEFT JOIN releases r ON r.id = e.item_id AND r.client_id = e.client_id AND e.item_kind = 'release'
     LEFT JOIN projects p ON p.id = r.project_id
     WHERE e.client_id = ? AND e.at >= ?
     AND (e.action IN ('live', 'shipped') OR (e.action = 'done' AND e.item_kind IN ('change', 'problem', 'request'))) ORDER BY e.id DESC`
  ).bind(client.id, [sqlTime(now - MAIL.shippedDays * 86400e3), client.email_since || ''].sort().at(-1)).all();
  const shipped = [...new Set(finished.map(phaseName))];
  const plan = await planOf(db, client.id);
  const logged = await loggedKeys(db, client);
  for (const person of people) {
    const key = `digest:${person.id}:${week}`;
    if (logged.has(key) || (retry && !retry.has(key))) continue;
    // Questions named for them (not ones they already answered, which wait on us to close, unless we asked something
    // back), undecided changes named for them, and estimates they decide.
    const undecided = i => i.kind === 'change' && i.status === 'new' && !i.proposal_state && !(i.estimate && i.estimate !== 'withdrawn' && i.estimate !== 'draft');
    const waiting = open.filter(i => (i.estimate === 'offered' && canDecideEstimate(person, plan)) || (((i.kind === 'question' && (!i.answer || i.asks_back)) || undecided(i)) && ownedBy(i.owner, person.name)));
    if (!waiting.length && !testing.length && !shipped.length) { out.skipped++; continue; }
    const cap = (rows, more) => rows.length > MAIL.listMax ? [...rows.slice(0, MAIL.listMax), { text: `and ${rows.length - MAIL.listMax} more`, url: more }] : rows;
    const sections = [
      { title: `Waiting on you (${waiting.length})`, lines: cap(waiting.map(i => ({ text: (i.estimate === 'offered' ? 'Estimate to decide: ' : i.kind === 'change' ? 'To decide: ' : '') + q(i.title) + (i.due_date ? ` (due ${niceDay(i.due_date)})` : ''), url: itemLink(client.slug, i.id) })), link(client.slug, 'waiting')) },
      { title: 'In testing', lines: testing.map(r => ({ text: `${oneLine(r.label)}, testing until ${niceDay(r.ends)}`, url: link(client.slug, 'home') })) },
      { title: 'Finished last week', lines: cap(shipped.map(t => ({ text: t, url: link(client.slug, 'backlog') })), link(client.slug, 'backlog')) }
    ].filter(s => s.lines.length);
    const subject = waiting.length ? `Your week on the ${client.name} hub: ${waiting.length} waiting on you` : `Your week on the ${client.name} hub`;
    const mail = compose(client, person, { subject, intro: `Here's your week on the ${client.name} hub.`, sections });
    await sendAndLog(env, client, person, 'digest', [key], mail, out);
  }
}
