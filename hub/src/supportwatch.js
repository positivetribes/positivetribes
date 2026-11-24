// The support watch: keeps Eric to the published support targets (kits/proposal-care-plan.md, "Support and outages";
// public at positivetribes.org/care#support-title). Runs hourly from the cron, but only acts in business hours:
//  1. Replies: every client item waiting on a first reply (admin.js waitingForReply) and every open Salesforce Case is due
//     1 business day after it arrived. One email lists what is due within 2 business hours, and what is late.
//  2. After-outage notes: each outage tribe-status closed (its `Incidents` RPC entrypoint) becomes a Salesforce Task on the
//     client's Account, due 2 business days after the tool came back.
//  3. Coverage: a project with a live address but no uptime check is flagged once, so a launch can't skip monitoring.
// Outages themselves are emailed by tribe-status the minute they're confirmed; this watch doesn't repeat them.
// Each alert is sent once per stage (support_alerts, migration 0042); a failed email is retried the next hour.
import { waitingForReply, replyClock, ownNamesOf, isOwn } from './admin.js';
import { addBusinessHours, dayMT, formatMT, isBusinessTime, parseUtc, SUPPORT } from './businesshours.js';
import { salesforceToken, sf, soql } from './salesforce.js';

const HUB = 'https://hub.positivetribes.org';
const FROM = 'hello@positivetribes.org';
const sfReady = env => Boolean(env.SF_DOMAIN && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET);
const clip = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const LOOKBACK_SECS = 14 * 86400; // closed outages older than this are not turned into Tasks

export async function runSupportWatch(env, now = Date.now()) {
  if (!env.DB) return { ran: false, reason: 'no database' };
  if (!isBusinessTime(now)) return { ran: false, reason: 'outside business hours' };
  const db = env.DB;
  const sent = new Map((await db.prepare('SELECT key, stage FROM support_alerts').all()).results.map(r => [r.key, r.stage]));
  const auth = sfReady(env) ? await salesforceToken(env).catch(error => { console.error('support_watch_sf_auth', error.message); return null; }) : null;
  const out = { ran: true, soon: 0, late: 0, notes: 0, uncovered: 0, emailed: false, errors: [] };

  // 1. Replies: hub items and Salesforce Cases.
  const due = [];
  const own = ownNamesOf(env);
  for (const r of await waitingForReply(db)) {
    if (isOwn(r.added_by, own)) continue; // Eric's own notes: no client is waiting on them
    const c = replyClock(r.created_at, now);
    if (c.soon || c.late) due.push({ key: 'item:' + r.id, stage: c.late ? 'late' : 'soon', due: c.due, line: `${r.name}: ${clip(r.title, 90)}`, url: `${HUB}/#/${r.slug}/backlog/${r.id}` });
  }
  if (auth) {
    try {
      const cases = (await soql(auth, 'SELECT Id, CaseNumber, Subject, CreatedDate, Account.Name FROM Case WHERE IsClosed = false ORDER BY CreatedDate LIMIT 100')).records;
      for (const k of cases) {
        const c = replyClock(k.CreatedDate, now);
        if (c.soon || c.late) due.push({ key: 'case:' + k.Id, stage: c.late ? 'late' : 'soon', due: c.due, line: `Case ${k.CaseNumber} (${k.Account ? k.Account.Name : 'no account'}): ${clip(k.Subject, 80)}`, url: env.SF_DOMAIN.replace(/\/$/, '') + '/lightning/r/Case/' + k.Id + '/view' });
      }
    } catch (error) { out.errors.push('cases: ' + error.message.slice(0, 120)); }
  }
  // Only what moved to a new stage since the last email: soon, then late (a late item is never re-sent).
  const fresh = due.filter(d => sent.get(d.key) !== d.stage && sent.get(d.key) !== 'late');

  // 2. After-outage notes, and 3. coverage, both from tribe-status.
  const clients = new Map((await db.prepare("SELECT id, slug, name, salesforce_account_id FROM clients WHERE status != 'closed'").all()).results.map(c => [c.slug, c]));
  const uncovered = [];
  if (env.STATUS) {
    try {
      const closed = await env.STATUS.closedSince(Math.floor(now / 1000) - LOOKBACK_SECS);
      for (const i of closed) {
        const key = 'outage:' + i.id;
        if (sent.has(key)) continue;
        const client = clients.get(i.client);
        if (!auth || !client || !/^001[A-Za-z0-9]{12,15}$/.test(client.salesforce_account_id || '')) { out.errors.push(`outage ${i.id}: no Salesforce Account or connection`); continue; }
        const mins = Math.max(1, Math.round((i.ended - i.started) / 60));
        const task = {
          Subject: `Post the after-outage note in the hub for ${client.name}: ${i.checkName}`,
          ActivityDate: dayMT(addBusinessHours(i.ended * 1000, SUPPORT.noteHours)),
          Status: 'Not Started', Priority: 'High', WhatId: client.salesforce_account_id,
          Description: `${i.checkName} was down about ${mins} minute${mins === 1 ? '' : 's'}, from ${formatMT(i.started * 1000)} to ${formatMT(i.ended * 1000)}. ` +
            `Support policy: a short note in the client's hub within 2 business days on what happened, how it was fixed and what changed (kits/proposal-care-plan.md). Status: https://status.positivetribes.org/${i.client}`
        };
        if (env.SF_TASK_OWNER_ID) task.OwnerId = env.SF_TASK_OWNER_ID;
        try {
          await sf(auth, 'POST', '/sobjects/Task', task);
          await db.prepare('INSERT OR REPLACE INTO support_alerts (key, stage) VALUES (?, ?)').bind(key, 'task').run();
          out.notes++;
        } catch (error) { out.errors.push(`outage ${i.id}: ${error.message.slice(0, 120)}`); }
      }
    } catch (error) { out.errors.push('status: ' + error.message.slice(0, 120)); }
    try {
      const checks = await env.STATUS.coverage();
      const { results: live } = await db.prepare(
        "SELECT p.id, p.name, c.slug, c.name AS client FROM projects p JOIN clients c ON c.id = p.client_id WHERE p.live_url != '' AND c.status != 'closed'"
      ).all();
      for (const p of live) if (!checks[p.slug] && !sent.has('coverage:' + p.id)) uncovered.push({ key: 'coverage:' + p.id, line: `${p.client}: ${p.name} has a live address but no uptime check. Add it to status/src/config.js.` });
    } catch (error) { out.errors.push('coverage: ' + error.message.slice(0, 120)); }
  }

  // One email for everything new this hour.
  if (fresh.length || uncovered.length || out.errors.length && !sent.has('errors:' + dayMT(now))) {
    const late = fresh.filter(d => d.stage === 'late');
    const soon = fresh.filter(d => d.stage === 'soon');
    const block = (title, rows, fmt) => rows.length ? `${title}\n${rows.map(fmt).join('\n')}\n\n` : '';
    const text =
      block('LATE (reply target: 1 business day):', late, d => `- ${d.line}\n  was due ${formatMT(d.due)}\n  ${d.url}`) +
      block('Reply due within 2 business hours:', soon, d => `- ${d.line}\n  reply by ${formatMT(d.due)}\n  ${d.url}`) +
      block('Not monitored yet:', uncovered, d => `- ${d.line}`) +
      block('The support watch could not finish:', out.errors, e => `- ${e}`) +
      'Targets: outage work started within 4 business hours; everything else answered within 1 business day (Mon-Fri, 8am-6pm MT).\nhttps://positivetribes.org/care#support-title';
    const parts = [late.length && `${late.length} late`, soon.length && `${soon.length} due soon`, uncovered.length && `${uncovered.length} unmonitored`, out.errors.length && 'errors'].filter(Boolean);
    try {
      if (!env.ALERT_MAIL || !env.ALERT_TO) throw new Error('ALERT_MAIL is not bound');
      await env.ALERT_MAIL.send({ from: FROM, to: env.ALERT_TO, subject: 'Support watch: ' + parts.join(', '), text });
      out.emailed = true;
      const marks = [...fresh.map(d => [d.key, d.stage]), ...uncovered.map(d => [d.key, 'flagged'])];
      if (out.errors.length) marks.push(['errors:' + dayMT(now), 'sent']);
      if (marks.length) await db.batch(marks.map(([k, s]) => db.prepare('INSERT OR REPLACE INTO support_alerts (key, stage) VALUES (?, ?)').bind(k, s)));
    } catch (error) {
      console.error('support_watch_email_failed', error.message);
      out.errors.push('email: ' + error.message.slice(0, 120));
    }
  }
  out.soon = fresh.filter(d => d.stage === 'soon').length;
  out.late = fresh.filter(d => d.stage === 'late').length;
  out.uncovered = uncovered.length;
  // Answered items drop out of waitingForReply; forget their marks after 60 days so the table stays small.
  await db.prepare("DELETE FROM support_alerts WHERE at < datetime('now', '-60 days')").run();
  return out;
}
