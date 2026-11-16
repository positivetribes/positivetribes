// Client satisfaction, asked quietly at the moments that matter and never in the way:
//   - phase: a phase is signed off ("How did Phase 2 go?", 1 to 5), asked of the director and whoever signed it off;
//   - care: a care request ships ("Did it turn out the way you wanted?", thumbs), asked of whoever asked for it;
//   - value: 30 days after a phase goes live ("Is <tool> saving you time?", Yes a lot / Some / Not yet), the director;
//   - pulse: once a quarter for clients on an active care plan ("How likely are you to recommend us?", 0 to 10), the director.
// Rules (enforced here, not in the page): one question at a time on the client's home, never a pop-up; an ask expires
// after 14 days; "Not now" hides it, and two "Not now"s in a row on one kind stop that kind for that person; at most one
// phase/value/pulse answer per person per 30 days (care thumbs don't count); Positive Tribes never answers for a client.
// Each answer becomes a completed Salesforce Task on the project's Opportunity (the client's Account if none); a low score
// also makes a High follow-up Task due the next business day. Comments stay in the hub; one that hits Patch's rule-1 word
// screen (health, personal, payment words) is not copied to Salesforce. Production host only (SF_TASK_SYNC_HOST).
// Reusable: nothing here knows about any one client.
import { InputError, clip } from './triage.js';
import { salesforceToken, sf } from './salesforce.js';
import { screenRule1 } from './patch.js';

export const EXPIRE_DAYS = 14, QUIET_DAYS = 30, VALUE_AFTER_DAYS = 30, VALUE_UNTIL_DAYS = 45, PULSE_GAP_DAYS = 80;
export const SCALES = {
  five: { min: 1, max: 5, low: 3 },
  thumbs: { min: 0, max: 1, low: 0 },
  value: { min: 1, max: 3, low: 1 },
  nps: { min: 0, max: 10, low: 6 }
};
const SCALE_OF = { phase: 'five', care: 'thumbs', value: 'value', pulse: 'nps' };
const VALUE_WORDS = { 1: 'Not yet', 2: 'Some', 3: 'Yes, a lot' };
// Kinds that share the 30-day quiet rule (care thumbs sit on a finished request and are not counted).
const QUIET_KINDS = "('phase', 'value', 'pulse')";

export const scoreText = (scale, score) => scale === 'five' ? `${score}/5` : scale === 'nps' ? `${score}/10`
  : scale === 'thumbs' ? (score ? 'thumbs up' : 'thumbs down') : VALUE_WORDS[score] || String(score);
export const isLow = (scale, score) => score != null && score <= SCALES[scale].low;
export function question(kind, label) {
  if (kind === 'phase') return `How did ${label} go?`;
  if (kind === 'care') return `Did “${label}” turn out the way you wanted?`;
  if (kind === 'value') return `Is ${label} saving you time?`;
  return 'How likely are you to recommend Positive Tribes to another organization?';
}
const quarterKey = day => Number(day.slice(0, 4)) * 10 + Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1;

// One ask for one person, unless they already have it or said "Not now" to this kind twice in a row.
// Only the client's own people (director or staff) are ever asked.
export function askRow(db, { clientId, userId, kind, refId, label }) {
  return db.prepare(
    `INSERT OR IGNORE INTO feedback (client_id, user_id, kind, ref_id, label, scale, expires_at)
     SELECT ?1, u.id, ?2, ?3, ?4, ?5, datetime('now', '+${EXPIRE_DAYS} days') FROM users u
     WHERE u.id = ?6 AND u.client_id = ?1 AND u.role IN ('ed', 'staff')
       AND (SELECT COUNT(*) FROM (SELECT dismissed_at FROM feedback WHERE user_id = ?6 AND kind = ?2 ORDER BY id DESC LIMIT 2) WHERE dismissed_at IS NOT NULL) < 2`
  ).bind(clientId, kind, refId, clip(label, 160), SCALE_OF[kind], userId);
}
const directors = async (db, clientId) => (await db.prepare("SELECT id FROM users WHERE client_id = ? AND role = 'ed'").bind(clientId).all()).results.map(r => r.id);

// After a sign-off: the director(s), plus whoever signed it off if that was someone else on the client's side.
export async function askPhase(db, clientId, releaseId, signerId) {
  const r = await db.prepare(
    `SELECT r.id, r.number, r.name, p.name AS project FROM releases r LEFT JOIN projects p ON p.id = r.project_id AND p.client_id = r.client_id
     WHERE r.id = ? AND r.client_id = ?`
  ).bind(releaseId, clientId).first();
  if (!r) return 0;
  const label = (r.project ? r.project + ' ' : '') + (r.name || 'Phase ' + r.number);
  const ids = [...new Set([...await directors(db, clientId), signerId].filter(Boolean))];
  if (!ids.length) return 0;
  await db.batch(ids.map(userId => askRow(db, { clientId, userId, kind: 'phase', refId: r.id, label })));
  return ids.length;
}

// After a care request ships: whoever asked for it (from the 'added' event), or the director(s) if that person is gone.
export async function askCare(db, clientId, item) {
  const asker = await db.prepare(
    `SELECT u.id FROM events e JOIN users u ON lower(u.email) = lower(e.actor_email) AND u.client_id = e.client_id
     WHERE e.client_id = ? AND e.item_id = ? AND e.action = 'added' AND u.role IN ('ed', 'staff') ORDER BY e.id LIMIT 1`
  ).bind(clientId, item.id).first();
  const ids = asker ? [asker.id] : await directors(db, clientId);
  if (!ids.length) return 0;
  await db.batch(ids.map(userId => askRow(db, { clientId, userId, kind: 'care', refId: item.id, label: item.title })));
  return ids.length;
}

// Daily: value asks for phases that went live 30 to 45 days ago (so old launches are never asked about), and the
// quarterly pulse for directors of clients whose care plan has run at least 30 days.
export async function createScheduledAsks(db, today) {
  const rows = [];
  const live = await db.prepare(
    `SELECT DISTINCT e.client_id, r.id AS release_id, COALESCE(NULLIF(p.name, ''), NULLIF(r.name, ''), 'Phase ' || r.number) AS label
     FROM events e JOIN releases r ON r.id = e.item_id AND r.client_id = e.client_id
     LEFT JOIN projects p ON p.id = r.project_id AND p.client_id = r.client_id
     WHERE e.action = 'live' AND e.item_kind = 'release' AND r.stage = 'live'
       AND e.at <= datetime('now', '-${VALUE_AFTER_DAYS} days') AND e.at > datetime('now', '-${VALUE_UNTIL_DAYS} days')`
  ).all();
  for (const r of live.results) {
    for (const userId of await directors(db, r.client_id)) rows.push(askRow(db, { clientId: r.client_id, userId, kind: 'value', refId: r.release_id, label: r.label }));
  }
  const plans = await db.prepare(
    `SELECT client_id FROM care_plans WHERE status = 'active' AND starts_on != '' AND starts_on <= date(?, '-30 days')`
  ).bind(today).all();
  for (const p of plans.results) {
    for (const userId of await directors(db, p.client_id)) {
      const recent = await db.prepare(`SELECT 1 FROM feedback WHERE user_id = ? AND kind = 'pulse' AND asked_at > datetime('now', '-${PULSE_GAP_DAYS} days')`).bind(userId).first();
      if (!recent) rows.push(askRow(db, { clientId: p.client_id, userId, kind: 'pulse', refId: quarterKey(today), label: 'Positive Tribes' }));
    }
  }
  if (rows.length) await db.batch(rows);
  return rows.length;
}

// The one question to show this person now, or null. Phase first (freshest work), then care, value, pulse.
export async function pendingFor(db, user, clientId) {
  if (!user || user.role === 'pt' || user.client_id !== clientId) return null;
  const quiet = await db.prepare(
    `SELECT 1 FROM feedback WHERE user_id = ? AND kind IN ${QUIET_KINDS} AND answered_at > datetime('now', '-${QUIET_DAYS} days')`
  ).bind(user.id).first();
  const row = await db.prepare(
    `SELECT id, kind, label, scale FROM feedback
     WHERE user_id = ? AND client_id = ? AND answered_at IS NULL AND dismissed_at IS NULL AND expires_at > datetime('now')
       AND (? = 0 OR kind NOT IN ${QUIET_KINDS})
     ORDER BY CASE kind WHEN 'phase' THEN 0 WHEN 'care' THEN 1 WHEN 'value' THEN 2 ELSE 3 END, id LIMIT 1`
  ).bind(user.id, clientId, quiet ? 1 : 0).first();
  return row ? { ...row, question: question(row.kind, row.label), ...SCALES[row.scale] } : null;
}

// The person's answer: { score } (one tap), then optionally { comment } on the same ask within a day, or { dismiss: true }.
export async function answerAsk(env, db, host, user, client, rawId, input) {
  if (user.role === 'pt') throw new InputError('Only the client answers this.', 403);
  const id = Number(rawId);
  const row = Number.isSafeInteger(id) && id > 0 && await db.prepare('SELECT * FROM feedback WHERE id = ? AND client_id = ? AND user_id = ?').bind(id, client.id, user.id).first();
  if (!row) throw new InputError('Not found.', 404);
  if (input.dismiss === true) {
    const r = await db.prepare('UPDATE feedback SET dismissed_at = CURRENT_TIMESTAMP WHERE id = ? AND answered_at IS NULL AND dismissed_at IS NULL').bind(row.id).run();
    if (!r.meta.changes) throw new InputError('This was already answered.', 409);
    return { ok: true };
  }
  if (input.comment !== undefined) {
    if (typeof input.comment !== 'string') throw new InputError('Comment must be text.');
    const comment = input.comment.trim();
    if (comment.length > 1000) throw new InputError('Comment must be at most 1000 characters.');
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(comment)) throw new InputError('Comment contains characters that are not allowed.');
    const r = await db.prepare(
      "UPDATE feedback SET comment = ? WHERE id = ? AND answered_at IS NOT NULL AND answered_at > datetime('now', '-1 day')"
    ).bind(comment, row.id).run();
    if (!r.meta.changes) throw new InputError('Choose a rating first.', 409);
    await updateTaskComment(env, host, { ...row, comment });
    return { ok: true };
  }
  const s = SCALES[row.scale], score = input.score;
  if (!Number.isInteger(score) || score < s.min || score > s.max) throw new InputError(`Choose a rating from ${s.min} to ${s.max}.`);
  const r = await db.prepare(
    "UPDATE feedback SET score = ?, answered_at = CURRENT_TIMESTAMP WHERE id = ? AND answered_at IS NULL AND dismissed_at IS NULL AND expires_at > datetime('now')"
  ).bind(score, row.id).run();
  if (!r.meta.changes) throw new InputError('This was already answered or has closed.', 409);
  const salesforce = await pushFeedback(env, db, host, row.id);
  return { ok: true, salesforce };
}

// ---- Salesforce ----

const sfReady = env => Boolean(env.SF_DOMAIN && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET);
const sfOn = (env, host) => sfReady(env) && (!env.SF_TASK_SYNC_HOST || host === env.SF_TASK_SYNC_HOST);
const oppId = id => /^006[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id || '') ? id : '';
const acctId = id => /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id || '') ? id : '';
const taskId = id => /^00T[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id || '') ? id : '';
const nextBusinessDay = day => {
  let t = Date.parse(day + 'T12:00:00Z');
  do t += 864e5; while ([0, 6].includes(new Date(t).getUTCDay()));
  return new Date(t).toISOString().slice(0, 10);
};

// The comment as it may go to Salesforce: none, as written, or a note that it stays in the hub.
export function commentForSalesforce(comment) {
  if (!comment) return 'No comment.';
  const hits = screenRule1(comment);
  return hits.length ? `Comment left in the Tribe Hub (not copied here: it mentions ${hits.join(', ')}).` : `Comment: ${clip(comment, 1000)}`;
}

export function tasksFor(row, today) {
  const words = scoreText(row.scale, row.score);
  const asked = `${row.person || 'Someone'} at ${row.client_name} answered in the Tribe Hub: ${question(row.kind, row.label)}`;
  const description = [asked, `Answer: ${words}`, commentForSalesforce(row.comment)].join('\n');
  const main = { Subject: clip(`CSAT · ${row.client_name} · ${row.label}: ${words}`, 250), ActivityDate: today, Status: 'Completed', Priority: 'Normal', Description: description };
  const followup = isLow(row.scale, row.score) ? {
    Subject: clip(`Follow up: ${row.client_name} rated ${row.label} ${words}`, 250), ActivityDate: nextBusinessDay(today), Status: 'Not Started', Priority: 'High',
    Description: description + '\n\nCall or write to them: thank them, ask what would have made it better, and log what you change.'
  } : null;
  return { main, followup };
}

async function rowWithContext(db, id) {
  return db.prepare(
    `SELECT f.*, c.name AS client_name, c.salesforce_account_id, u.name AS person,
            COALESCE(rp.salesforce_opportunity_id, ip.salesforce_opportunity_id, '') AS opportunity_id
     FROM feedback f JOIN clients c ON c.id = f.client_id LEFT JOIN users u ON u.id = f.user_id
     LEFT JOIN releases r ON f.kind IN ('phase', 'value') AND r.id = f.ref_id AND r.client_id = f.client_id
     LEFT JOIN projects rp ON rp.id = r.project_id AND rp.client_id = f.client_id
     LEFT JOIN items i ON f.kind = 'care' AND i.id = f.ref_id AND i.client_id = f.client_id
     LEFT JOIN projects ip ON ip.id = i.project_id AND ip.client_id = f.client_id
     WHERE f.id = ?`
  ).bind(id).first();
}

// The answer's Task, then (for a low score) its follow-up. Each is claimed first, so a retry never makes a second one.
// Returns 'off', 'created', 'exists' or 'failed'. An answer never fails because of Salesforce.
export async function pushFeedback(env, db, host, id, today = new Date().toISOString().slice(0, 10)) {
  if (!sfOn(env, host)) return 'off';
  const row = await rowWithContext(db, id);
  if (!row || row.score == null) return 'off';
  const { main, followup } = tasksFor(row, today);
  let result = 'exists';
  try {
    const what = (row.kind !== 'pulse' && oppId(row.opportunity_id)) || acctId(row.salesforce_account_id);
    if (!what) throw new Error('no Opportunity or Account is linked to this client in the hub');
    const extra = env.SF_TASK_OWNER_ID ? { OwnerId: env.SF_TASK_OWNER_ID } : {};
    const claim = await db.prepare("UPDATE feedback SET sf_task_id = 'pending' WHERE id = ? AND sf_task_id = ''").bind(id).run();
    if (claim.meta.changes) {
      const auth = await salesforceToken(env);
      try {
        const { id: sfId } = await sf(auth, 'POST', '/sobjects/Task', { ...main, WhatId: what, ...extra });
        await db.prepare("UPDATE feedback SET sf_task_id = ?, sf_error = '' WHERE id = ?").bind(sfId, id).run();
        result = 'created';
      } catch (error) {
        await db.prepare("UPDATE feedback SET sf_task_id = '' WHERE id = ?").bind(id).run();
        throw error;
      }
    }
    if (followup) {
      const fclaim = await db.prepare("UPDATE feedback SET sf_followup_id = 'pending' WHERE id = ? AND sf_followup_id = ''").bind(id).run();
      if (fclaim.meta.changes) {
        try {
          const { id: fId } = await sf(await salesforceToken(env), 'POST', '/sobjects/Task', { ...followup, WhatId: what, ...extra });
          await db.prepare("UPDATE feedback SET sf_followup_id = ?, sf_error = '' WHERE id = ?").bind(fId, id).run();
          result = 'created';
        } catch (error) {
          await db.prepare("UPDATE feedback SET sf_followup_id = '' WHERE id = ?").bind(id).run();
          throw error;
        }
      }
    }
    return result;
  } catch (error) {
    console.error('feedback_task_failed', id, error.message);
    await db.prepare('UPDATE feedback SET sf_error = ? WHERE id = ?').bind(clip(String(error.message), 200), id).run();
    return 'failed';
  }
}

// A comment added after the tap: rewrite the Tasks' descriptions. Best effort; the comment is safe in the hub either way.
async function updateTaskComment(env, host, row) {
  if (!sfOn(env, host)) return;
  const ids = [taskId(row.sf_task_id), taskId(row.sf_followup_id)].filter(Boolean);
  if (!ids.length) return;
  try {
    const auth = await salesforceToken(env);
    for (const tid of ids) {
      const current = await sf(auth, 'GET', '/sobjects/Task/' + tid + '?fields=Description');
      const text = String(current?.Description || '').replace(/^(No comment\.|Comment: .*|Comment left in the Tribe Hub.*)$/m, commentForSalesforce(row.comment));
      await sf(auth, 'PATCH', '/sobjects/Task/' + tid, { Description: clip(text, 32000) });
    }
  } catch (error) {
    console.error('feedback_comment_sync_failed', row.id, error.message);
  }
}

// Daily: make the scheduled asks and retry any answer whose Salesforce Tasks failed.
export async function runFeedback(env, db, today) {
  const asked = await createScheduledAsks(db, today);
  const host = env.SF_TASK_SYNC_HOST || '';
  const failed = await db.prepare("SELECT id FROM feedback WHERE score IS NOT NULL AND sf_error != '' LIMIT 20").all();
  const retried = [];
  for (const r of failed.results) retried.push({ id: r.id, result: await pushFeedback(env, db, host, r.id, today) });
  return { asked, retried };
}

// ---- Command center ----

// Answers from the last 90 days (newest first) and the 30-day summary for Today.
export async function feedbackOverview(db) {
  const { results } = await db.prepare(
    `SELECT f.id, f.kind, f.label, f.scale, f.score, f.comment, f.answered_at, f.sf_error, c.name AS client, c.slug AS workspace, u.name AS person, f.ref_id
     FROM feedback f JOIN clients c ON c.id = f.client_id LEFT JOIN users u ON u.id = f.user_id
     WHERE f.answered_at > datetime('now', '-90 days') ORDER BY f.answered_at DESC, f.id DESC LIMIT 200`
  ).all();
  const waiting = await db.prepare(
    "SELECT COUNT(*) AS n FROM feedback WHERE answered_at IS NULL AND dismissed_at IS NULL AND expires_at > datetime('now')"
  ).first();
  const cutoff = new Date(Date.now() - 30 * 864e5).toISOString().replace('T', ' ').slice(0, 19);
  const recent = results.map(r => ({ ...r, words: scoreText(r.scale, r.score), low: isLow(r.scale, r.score), question: question(r.kind, r.label) }));
  const last30 = recent.filter(r => r.answered_at > cutoff);
  const fives = last30.filter(r => r.scale === 'five');
  return {
    recent,
    waiting: waiting.n,
    answered30: last30.length,
    low30: last30.filter(r => r.low).length,
    avgFive30: fives.length ? Math.round(fives.reduce((t, r) => t + r.score, 0) / fives.length * 10) / 10 : null
  };
}
