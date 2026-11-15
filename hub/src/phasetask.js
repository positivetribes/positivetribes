// When a phase is accepted, Positive Tribes needs to send its acceptance invoice. The hub makes one Salesforce Task on
// the project's Opportunity (the client's Account if none) for it, listing the approved changes that ship in that phase
// (billing rule, 2026-11-15: a change is invoiced with the phase it ships in). Two ways a phase is accepted:
//   - the client's director signs it off in the hub (reason 'signed_off');
//   - an auto-accept testing window ends with no open problems (reason 'window_ended'). The hub does not sign the
//     phase off by itself: the Task asks Positive Tribes to confirm, sign it off on the client's behalf, and invoice.
// Reusable: nothing here knows about any one client. Salesforce access stays Task writes only; only the configured
// host writes, so pull request previews never do. No emails or personal details go in the Task, only titles and prices.
import { clip } from './triage.js';
import { salesforceToken, sf } from './salesforce.js';
import { windowEnd } from './dates.js';
import { hoursLabel, moneyLabel } from './estimates.js';

const sfReady = env => Boolean(env.SF_DOMAIN && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET);
const oppId = id => /^006[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id || '') ? id : '';
const acctId = id => /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id || '') ? id : '';
const addDaysIso = (n, from = Date.now()) => new Date(from + n * 864e5).toISOString().slice(0, 10);

// The approved changes tagged to ship in this phase: billable ones go on the invoice, donated ones are listed so the
// invoice can show them at no charge.
export async function changesFor(db, release) {
  const { results } = await db.prepare(
    `SELECT i.id, i.title, e.minutes, e.price_cents, e.donated FROM items i
     JOIN change_estimates e ON e.item_id = i.id AND e.client_id = i.client_id
     WHERE i.client_id = ? AND i.release_id = ? AND e.status = 'approved_now' ORDER BY i.id`
  ).bind(release.client_id, release.id).all();
  const billable = results.filter(r => !r.donated), donated = results.filter(r => r.donated);
  return { billable, donated, totalCents: billable.reduce((t, r) => t + r.price_cents, 0) };
}

export function taskFor(release, reason, changes, today) {
  const label = release.name || 'Phase ' + release.number;
  const project = release.project_name ? release.project_name + ' ' : '';
  const line = r => `- #${r.id} ${r.title} (${hoursLabel(r.minutes)}, ${moneyLabel(r.price_cents)}${r.donated ? ' value, donated' : ''})`;
  const how = reason === 'signed_off'
    ? `${release.signed_off_by || 'The client'} signed off ${project}${label} in the Tribe Hub.`
    : `The testing window for ${project}${label} ended on ${release.uat_due} with no problems listed, so under the agreement it is accepted. Confirm with the client and sign it off in the hub on their behalf.`;
  const parts = [how, '', 'Send the acceptance invoice for this phase (amount per the signed agreement).'];
  if (changes.billable.length) {
    parts.push('', `Add the approved changes that shipped in it (${moneyLabel(changes.totalCents)}):`, ...changes.billable.map(line));
  } else parts.push('No approved changes to add.');
  if (changes.donated.length) parts.push('', 'Donated, no charge (list them on the invoice at $0):', ...changes.donated.map(line));
  const extra = changes.billable.length ? ` + ${moneyLabel(changes.totalCents)} in changes` : '';
  return {
    Subject: clip(`${project}${label} accepted (${reason === 'signed_off' ? 'signed off' : 'testing window ended'}): send the invoice${extra}`, 250),
    ActivityDate: addDaysIso(1, Date.parse(today + 'T12:00:00Z')),
    Status: 'Not Started',
    Priority: 'High',
    Description: clip(parts.join('\n'), 32000)
  };
}

// One Task per phase, ever. Returns 'off', 'none', 'exists', 'created' or 'failed'.
export async function pushPhaseTask(env, db, host, releaseId, reason, today) {
  if (!sfReady(env) || (env.SF_TASK_SYNC_HOST && host !== env.SF_TASK_SYNC_HOST)) return 'off';
  const release = await db.prepare(
    `SELECT r.*, p.name AS project_name, p.salesforce_opportunity_id, c.salesforce_account_id FROM releases r
     JOIN clients c ON c.id = r.client_id LEFT JOIN projects p ON p.id = r.project_id AND p.client_id = r.client_id
     WHERE r.id = ?`
  ).bind(releaseId).first();
  if (!release) return 'none';
  const claim = await db.prepare(
    "UPDATE releases SET sf_task_id = 'pending', sf_task_reason = ? WHERE id = ? AND sf_task_id = ''"
  ).bind(reason, releaseId).run();
  if (!claim.meta.changes) return 'exists';
  try {
    const what = oppId(release.salesforce_opportunity_id) || acctId(release.salesforce_account_id);
    if (!what) throw new Error('no Opportunity or Account is linked to this client in the hub');
    if (release.uat_started) release.uat_due = windowEnd(release.uat_started, release.uat_days, release.uat_day_type);
    const task = { ...taskFor(release, reason, await changesFor(db, release), today), WhatId: what };
    if (env.SF_TASK_OWNER_ID) task.OwnerId = env.SF_TASK_OWNER_ID;
    const { id } = await sf(await salesforceToken(env), 'POST', '/sobjects/Task', task);
    await db.prepare("UPDATE releases SET sf_task_id = ?, sf_error = '' WHERE id = ?").bind(id, releaseId).run();
    return 'created';
  } catch (error) {
    console.error('phase_task_failed', releaseId, error.message);
    // Keep the reason, so the daily check retries a failed sign-off Task (the phase is no longer in testing then).
    await db.prepare("UPDATE releases SET sf_task_id = '', sf_error = ? WHERE id = ?")
      .bind(clip(String(error.message), 200), releaseId).run();
    return 'failed';
  }
}

// Daily: auto-accept phases still in testing whose window ended before today with no open problems on the project,
// plus a retry for any sign-off whose Task failed.
export async function checkTestingWindows(env, db, today) {
  const host = env.SF_TASK_SYNC_HOST || env.PATCH_HOST || '';
  const out = [];
  const failed = await db.prepare(
    "SELECT id, sf_task_reason FROM releases WHERE sf_task_id = '' AND sf_task_reason != '' AND sf_error != ''"
  ).all();
  for (const r of failed.results) out.push({ id: r.id, result: await pushPhaseTask(env, db, host, r.id, r.sf_task_reason, today) });
  const { results } = await db.prepare(
    `SELECT r.id, r.uat_started, r.uat_days, r.uat_day_type FROM releases r
     WHERE r.stage = 'uat' AND r.auto_accept = 1 AND r.uat_started IS NOT NULL AND r.sf_task_id = ''
       AND NOT EXISTS (SELECT 1 FROM items i WHERE i.client_id = r.client_id AND i.project_id = r.project_id AND i.kind = 'problem' AND i.done = 0)`
  ).all();
  for (const r of results) {
    if (windowEnd(r.uat_started, r.uat_days, r.uat_day_type) >= today) continue;
    out.push({ id: r.id, result: await pushPhaseTask(env, db, host, r.id, 'window_ended', today) });
  }
  return out;
}
