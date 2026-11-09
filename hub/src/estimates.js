// Change estimates: Positive Tribes enters hours for a suggested change that is outside the agreement; the hub turns
// hours into a price (the client's hourly rate) and credits (1 credit = 30 minutes), and the client's director, or the
// care plan's named contact, decides. Reusable: nothing here knows about any one client.
// Patch never sees an estimate (it is not in anything reply.js or patch.js send), and Positive Tribes never decides.
import { planFor } from './care.js';
import { InputError, clip, logEvent } from './triage.js';
import { salesforceToken, sf } from './salesforce.js';

export const DEFAULT_RATE_CENTS = 5000;
export const MIN_MINUTES = 30;
export const MAX_MINUTES = 12000;
// The largest care-plan size is L (4 credits), which is 2 hours. Anything bigger is better added as part of the build.
export const LATER_MAX_MINUTES = 120;
export const CHOICES = { now: 'approved_now', later: 'approved_later', not_now: 'not_now' };

export const creditsOf = minutes => minutes / 30;
export const priceCentsOf = (minutes, rateCents) => Math.round(minutes * rateCents / 60);
export const hoursLabel = minutes => {
  const h = minutes / 60;
  return h === 1 ? '1 hour' : minutes < 60 ? `${minutes} minutes` : `${Number.isInteger(h) ? h : h.toFixed(1)} hours`;
};
export const moneyLabel = cents => {
  const d = cents / 100;
  return '$' + (Number.isInteger(d) ? d.toLocaleString('en-US') : d.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
};
export const creditsLabel = credits => `${credits} credit${credits === 1 ? '' : 's'}`;

// Hours the way a person types them: a whole or half hour, from half an hour up.
export function minutesFromHours(value) {
  const hours = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (typeof hours !== 'number' || !Number.isFinite(hours)) throw new InputError('Enter the hours as a number.');
  const minutes = Math.round(hours * 60);
  if (minutes !== hours * 60 || minutes % 30 !== 0) throw new InputError('Use whole or half hours (0.5, 1, 1.5 ...).');
  if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) throw new InputError('Enter between 0.5 and 200 hours.');
  return minutes;
}

// Only the director, or the one named contact on the care plan, may decide. Positive Tribes never decides for them.
export const canDecideEstimate = (user, plan) =>
  user.role !== 'pt' && (user.role === 'ed' || Boolean(plan && user.id === plan.balance_contact_user_id));

// What a page may show. A draft (and a withdrawn estimate) is Positive Tribes' alone. Prices are for everyone on the
// client's hub; the Salesforce details are Positive Tribes'.
export function estimateView(row, user, plan) {
  if (!row) return null;
  const pt = user.role === 'pt';
  if (!pt && (row.status === 'draft' || row.status === 'withdrawn')) return null;
  const offered = row.status === 'offered';
  const planned = Boolean(plan) && plan.status !== 'ended';
  const donated = Boolean(row.donated);
  return {
    status: row.status, version: row.version, donated,
    hours: row.minutes / 60, hours_label: hoursLabel(row.minutes),
    price_cents: row.price_cents, price_label: moneyLabel(row.price_cents),
    credits: row.credits, credits_label: creditsLabel(row.credits),
    schedule_note: row.schedule_note, scope_note: row.scope_note,
    // "After launch" only for a client with a care plan, and only up to the largest care size.
    // A donated change costs nothing, so there is nothing to put off to the care plan.
    later_ok: offered && planned && !donated && row.minutes <= LATER_MAX_MINUTES,
    later_note: offered && planned && !donated && row.minutes > LATER_MAX_MINUTES ? 'Larger than one care-plan request, so better added now.' : '',
    can_decide: offered && canDecideEstimate(user, plan),
    offered_at: row.offered_at, decided_at: row.decided_at, decided_by: row.decided_by || '',
    ...pt ? { rate_label: moneyLabel(row.rate_cents) + '/h', handled_at: row.handled_at, sf_task_id: row.sf_task_id, sf_error: row.sf_error } : {}
  };
}

// Estimates on a client's items, keyed by item id, as the given person may see them.
export async function estimatesFor(db, clientId, user) {
  const [{ results }, plan] = await Promise.all([
    db.prepare(
      `SELECT e.*, u.name AS decided_by FROM change_estimates e LEFT JOIN users u ON u.id = e.decided_by_user_id WHERE e.client_id = ?`
    ).bind(clientId).all(),
    planFor(db, clientId)
  ]);
  const map = new Map();
  for (const row of results) {
    const view = estimateView(row, user, plan);
    if (view) map.set(row.item_id, view);
  }
  return map;
}

// Time Positive Tribes gave on a client's items without an estimate, keyed by item id. Everyone on the client's hub
// sees it, like prices; who logged it is Positive Tribes' own detail.
export async function donatedTimeFor(db, clientId, user) {
  const { results } = await db.prepare(
    'SELECT id, item_id, minutes, value_cents, note, created_by, created_at FROM donated_time WHERE client_id = ? ORDER BY id'
  ).bind(clientId).all();
  const map = new Map();
  for (const r of results) {
    const entry = { id: r.id, minutes: r.minutes, hours_label: hoursLabel(r.minutes), value_cents: r.value_cents, value_label: moneyLabel(r.value_cents),
      note: r.note, created_at: r.created_at, ...user.role === 'pt' ? { created_by: r.created_by } : {} };
    map.set(r.item_id, [...map.get(r.item_id) || [], entry]);
  }
  return map;
}

// Donated so far, per client: approved donated changes plus logged donated time. Offered, withdrawn and Not now
// estimates do not count. `since` (YYYY-MM-DD) limits it to a year for funder reports.
export async function donatedTotals(db, since = '0000-01-01') {
  const { results } = await db.prepare(
    `SELECT c.id AS client_id, c.slug, c.name AS client, SUM(t.minutes) AS minutes, SUM(t.value_cents) AS value_cents
     FROM (SELECT client_id, minutes, price_cents AS value_cents, decided_at AS at FROM change_estimates WHERE donated = 1 AND status = 'approved_now'
           UNION ALL SELECT client_id, minutes, value_cents, created_at AS at FROM donated_time) t
     JOIN clients c ON c.id = t.client_id
     WHERE t.at >= ? GROUP BY c.id ORDER BY value_cents DESC`
  ).bind(since).all();
  return results.map(r => ({ ...r, hours_label: hoursLabel(r.minutes), value_label: moneyLabel(r.value_cents) }));
}

// ---- Salesforce Task for an approved change ----

const sfReady = env => Boolean(env.SF_DOMAIN && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET);
const addDaysIso = n => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
const oppId = id => /^006[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id || '') ? id : '';
const acctId = id => /^001[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(id || '') ? id : '';

// One Task, once, on the project's Opportunity (or the client's Account when no Opportunity is linked). It is a
// reminder to bill and schedule the change. Salesforce access stays what it was: Task writes only. Pull request
// previews share the Salesforce secrets but not the database, so only the configured host writes Tasks.
export async function pushEstimateTask(env, db, url, itemId) {
  if (!sfReady(env) || (env.SF_TASK_SYNC_HOST && url.hostname !== env.SF_TASK_SYNC_HOST)) return 'off';
  const row = await db.prepare(
    `SELECT e.*, i.title, i.project_id, c.salesforce_account_id, c.name AS client_name, p.salesforce_opportunity_id, u.name AS decided_by
     FROM change_estimates e JOIN items i ON i.id = e.item_id AND i.client_id = e.client_id
     JOIN clients c ON c.id = e.client_id LEFT JOIN projects p ON p.id = i.project_id AND p.client_id = e.client_id
     LEFT JOIN users u ON u.id = e.decided_by_user_id
     WHERE e.item_id = ? AND e.status IN ('approved_now', 'approved_later')`
  ).bind(itemId).first();
  if (!row) return 'none';
  // Claim first, so two requests cannot create two Tasks.
  const claim = await db.prepare("UPDATE change_estimates SET sf_task_id = 'pending' WHERE item_id = ? AND sf_task_id = ''").bind(itemId).run();
  if (!claim.meta.changes) return 'exists';
  try {
    const what = oppId(row.salesforce_opportunity_id) || acctId(row.salesforce_account_id);
    if (!what) throw new Error('no Opportunity or Account is linked to this client in the hub');
    const now = row.status === 'approved_now', donated = Boolean(row.donated);
    const terms = donated ? `donated, ${moneyLabel(row.price_cents)} value` : now ? moneyLabel(row.price_cents) + ', add now' : creditsLabel(row.credits) + ', after launch';
    const task = {
      Subject: clip(`Change approved: ${row.title} (${hoursLabel(row.minutes)}, ${terms})`, 250),
      ActivityDate: addDaysIso(7), WhatId: what, Status: 'Not Started',
      Description: `${row.decided_by || 'The client'} approved this change in the Tribe Hub.\n${donated ? 'Donated by Positive Tribes: schedule it in the build, no invoice.' : now ? 'Bill it and schedule it in the build.' : 'Add it to the care queue once the tool is live.'}`
    };
    if (env.SF_TASK_OWNER_ID) task.OwnerId = env.SF_TASK_OWNER_ID;
    const { id } = await sf(await salesforceToken(env), 'POST', '/sobjects/Task', task);
    await db.prepare("UPDATE change_estimates SET sf_task_id = ?, sf_error = '' WHERE item_id = ?").bind(id, itemId).run();
    return 'created';
  } catch (error) {
    console.error('estimate_task_failed', itemId, error.message);
    await db.prepare("UPDATE change_estimates SET sf_task_id = '', sf_error = ? WHERE item_id = ?").bind(clip(String(error.message), 200), itemId).run();
    return 'failed';
  }
}

// ---- The client's decision ----

export async function decideEstimate({ db, env, url, client, user, item, input }) {
  const choice = input.choice;
  if (!Object.hasOwn(CHOICES, choice)) throw new InputError('Choose add it now, after launch, or not now.');
  if (!Number.isSafeInteger(input.version) || input.version < 1) throw new InputError('Reload the page: the estimate may have changed.');
  const plan = await planFor(db, client.id);
  if (!canDecideEstimate(user, plan)) throw new InputError('Only the director, or the person named on the care plan, can decide.', 403);
  const est = await db.prepare('SELECT * FROM change_estimates WHERE item_id = ? AND client_id = ?').bind(item.id, client.id).first();
  if (!est || est.status === 'draft' || est.status === 'withdrawn') throw new InputError('There is no estimate to decide on this item.', 404);
  if (est.status !== 'offered') throw new InputError('This estimate has already been decided.', 409);
  if (est.version !== input.version) throw new InputError('The estimate changed. Reload the page to see the new one.', 409);
  if (choice === 'later') {
    if (est.donated) throw new InputError('This change is donated, so there is nothing to put off. Add it now or choose not now.', 409);
    if (!plan || plan.status === 'ended') throw new InputError('After launch needs a care plan.', 409);
    if (est.minutes > LATER_MAX_MINUTES) throw new InputError('This is larger than one care-plan request. Add it now instead.', 409);
  }
  const status = CHOICES[choice];
  const phase = choice === 'now' ? 'full' : choice === 'later' ? 'later' : item.phase;
  const tier = choice === 'not_now' && item.tier === 'must' ? 'idea' : item.tier;
  const token = crypto.randomUUID();
  const detail = choice === 'now' ? `Add it now · ${hoursLabel(est.minutes)} · ${est.donated ? `donated (${moneyLabel(est.price_cents)} value)` : moneyLabel(est.price_cents)}`
    : choice === 'later' ? `After launch · ${hoursLabel(est.minutes)} · ${creditsLabel(est.credits)}` : 'Not now';
  const [won] = await db.batch([
    db.prepare(
      `UPDATE change_estimates SET status = ?, decided_at = CURRENT_TIMESTAMP, decided_by_user_id = ?, decided_version = version, decided_token = ?, updated_at = CURRENT_TIMESTAMP
       WHERE item_id = ? AND client_id = ? AND status = 'offered' AND version = ?`
    ).bind(status, user.id, token, item.id, client.id, input.version),
    db.prepare(
      `UPDATE items SET status = 'planned', phase = ?, tier = ?,
         position = CASE WHEN tier = ? THEN position ELSE (SELECT COALESCE(MAX(p.position), 0) + 1 FROM items p WHERE p.client_id = ? AND p.project_id = ? AND p.kind = ? AND p.tier = ?) END,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND client_id = ? AND EXISTS (SELECT 1 FROM change_estimates WHERE item_id = ? AND decided_token = ?)`
    ).bind(phase, tier, tier, client.id, item.project_id, item.kind, tier, item.id, client.id, item.id, token),
    db.prepare(
      `INSERT INTO events (client_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name)
       SELECT ?, ?, 'estimate_decided', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM change_estimates WHERE item_id = ? AND decided_token = ?)`
    ).bind(client.id, item.id, item.title, item.kind || '', detail, user.email, user.name, item.id, token)
  ]);
  if (!won.meta.changes) throw new InputError('This estimate has already been decided.', 409);
  const task = choice === 'not_now' ? 'none' : await pushEstimateTask(env, db, url, item.id);
  return { choice, task };
}

// ---- Positive Tribes' side ----

const itemOf = async (db, itemId) => {
  const id = Number(itemId);
  const item = Number.isSafeInteger(id) && id > 0 && await db.prepare('SELECT * FROM items WHERE id = ?').bind(id).first();
  if (!item) throw new InputError('Item not found.', 404);
  return item;
};
const rowOf = async (db, itemId) => {
  const item = await itemOf(db, itemId);
  if (item.kind !== 'change') throw new InputError('Only suggested changes get estimates.', 409);
  return item;
};

// For Today: estimates waiting on a client's decision, and approved changes still to bill and schedule.
export async function estimateLists(db) {
  const { results } = await db.prepare(
    `SELECT e.item_id, e.client_id, c.slug, c.name AS client, i.title, e.minutes, e.price_cents, e.credits, e.status, e.offered_at, e.decided_at,
            e.handled_at, e.sf_error, e.sf_task_id, e.donated, u.name AS decided_by,
            CAST(julianday('now') - julianday(e.offered_at) AS INTEGER) AS days_waiting
     FROM change_estimates e JOIN items i ON i.id = e.item_id AND i.client_id = e.client_id JOIN clients c ON c.id = e.client_id
     LEFT JOIN users u ON u.id = e.decided_by_user_id
     WHERE e.status = 'offered' OR (e.status IN ('approved_now', 'approved_later') AND e.handled_at IS NULL)
     ORDER BY e.offered_at`
  ).all();
  const fmt = r => ({ ...r, hours_label: hoursLabel(r.minutes), price_label: moneyLabel(r.price_cents), credits_label: creditsLabel(r.credits), url: `#/${r.slug}/backlog/${r.item_id}` });
  return {
    waiting: results.filter(r => r.status === 'offered').map(fmt),
    toHandle: results.filter(r => r.status !== 'offered').map(fmt),
    taskFailed: results.filter(r => r.status !== 'offered' && r.sf_error).map(fmt)
  };
}

export async function estimateAdmin({ request, env, url, route, path, method, who, json, body, text }) {
  const mine = /^\/api\/admin\/items\/(\d+)\/estimate(?:\/(offer|withdraw|handled|retry-task))?$/.exec(path);
  const rate = /^\/api\/admin\/clients\/(\d+)\/rate$/.exec(path);
  const give = /^\/api\/admin\/items\/(\d+)\/donated-time$/.exec(path);
  const ungive = /^\/api\/admin\/donated-time\/(\d+)$/.exec(path);
  if (!mine && !rate && !give && !ungive && route !== 'GET /api/admin/estimates') return null;
  if (!env.DB) return json({ error: 'The hub database is not connected.' }, 503);
  const db = env.DB;
  const actor = { email: who.email || '', name: who.name || who.email || 'Positive Tribes' };
  try {
    if (route === 'GET /api/admin/estimates') return json(await estimateLists(db));

    if (rate) {
      if (method !== 'PUT') return json({ error: 'Not found.' }, 404);
      const id = Number(rate[1]);
      const dollars = (await body(request)).rate;
      if (typeof dollars !== 'number' || !Number.isFinite(dollars) || dollars < 0 || dollars > 1000 || Math.round(dollars * 100) !== dollars * 100) {
        throw new InputError('Enter an hourly rate from $0 to $1,000.');
      }
      const done = await db.prepare('UPDATE clients SET hourly_rate_cents = ? WHERE id = ?').bind(Math.round(dollars * 100), id).run();
      if (!done.meta.changes) throw new InputError('That client is not in the hub.', 404);
      return json({ ok: true, rate_cents: Math.round(dollars * 100) });
    }

    if (give) {
      if (method !== 'POST') return json({ error: 'Not found.' }, 404);
      const item = await itemOf(db, give[1]);
      const input = await body(request);
      const minutes = minutesFromHours(input.hours);
      const note = text(input.note, 200, { label: 'Note' });
      const rateCents = (await db.prepare('SELECT hourly_rate_cents FROM clients WHERE id = ?').bind(item.client_id).first()).hourly_rate_cents;
      const value = priceCentsOf(minutes, rateCents);
      await db.batch([
        db.prepare('INSERT INTO donated_time (client_id, item_id, minutes, rate_cents, value_cents, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .bind(item.client_id, item.id, minutes, rateCents, value, note, actor.name),
        logEvent(db, item.client_id, item.id, 'donated_time', { title: item.title, kind: item.kind }, `${hoursLabel(minutes)} donated (${moneyLabel(value)} value)`, actor)
      ]);
      return json({ ok: true }, 201);
    }
    if (ungive) {
      if (method !== 'DELETE') return json({ error: 'Not found.' }, 404);
      const done = await db.prepare('DELETE FROM donated_time WHERE id = ?').bind(Number(ungive[1])).run();
      if (!done.meta.changes) throw new InputError('That entry is not in the hub.', 404);
      return json({ ok: true });
    }

    const item = await rowOf(db, mine[1]);
    const action = mine[2];
    const current = await db.prepare('SELECT * FROM change_estimates WHERE item_id = ?').bind(item.id).first();
    const clientRate = (await db.prepare('SELECT hourly_rate_cents FROM clients WHERE id = ?').bind(item.client_id).first()).hourly_rate_cents;
    const reply = async status => {
      const row = await db.prepare('SELECT e.*, u.name AS decided_by FROM change_estimates e LEFT JOIN users u ON u.id = e.decided_by_user_id WHERE e.item_id = ?').bind(item.id).first();
      return json({ ok: true, estimate: estimateView(row, { role: 'pt' }, null) }, status);
    };

    if (!action && method === 'PUT') {
      if (item.done) throw new InputError('This change is already done.', 409);
      const input = await body(request);
      const minutes = minutesFromHours(input.hours);
      const schedule = text(input.schedule_note, 200, { label: 'Schedule note' });
      const scope = text(input.scope_note, 200, { label: 'Why it is outside the agreement' });
      if (input.donated !== undefined && typeof input.donated !== 'boolean') throw new InputError('Donated must be true or false.');
      const donated = input.donated ? 1 : 0;
      if (current && ['approved_now', 'approved_later'].includes(current.status)) throw new InputError('The client already approved this one. Add a new change for anything else.', 409);
      const price = priceCentsOf(minutes, clientRate), credits = creditsOf(minutes);
      if (!current) {
        await db.prepare(
          `INSERT INTO change_estimates (item_id, client_id, minutes, rate_cents, price_cents, credits, schedule_note, scope_note, donated, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(item.id, item.client_id, minutes, clientRate, price, credits, schedule, scope, donated, actor.name).run();
      } else {
        // Re-estimating goes back to a draft with a new version, so an old decision can never apply to a new number.
        await db.prepare(
          `UPDATE change_estimates SET minutes = ?, rate_cents = ?, price_cents = ?, credits = ?, schedule_note = ?, scope_note = ?, donated = ?, status = 'draft',
             version = version + 1, offered_at = NULL, decided_at = NULL, decided_by_user_id = NULL, decided_version = NULL, decided_token = '', updated_at = CURRENT_TIMESTAMP
           WHERE item_id = ? AND status IN ('draft', 'offered', 'not_now', 'withdrawn')`
        ).bind(minutes, clientRate, price, credits, schedule, scope, donated, item.id).run();
      }
      return reply(current ? 200 : 201);
    }
    if (!current) throw new InputError('There is no estimate on this item yet.', 404);

    if (action === 'offer' && method === 'POST') {
      await body(request);
      const price = priceCentsOf(current.minutes, clientRate);
      const done = await db.prepare(
        `UPDATE change_estimates SET status = 'offered', rate_cents = ?, price_cents = ?, offered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE item_id = ? AND status = 'draft'`
      ).bind(clientRate, price, item.id).run();
      if (!done.meta.changes) throw new InputError('Only a draft can be sent to the client.', 409);
      await logEvent(db, item.client_id, item.id, 'estimate_offered', { title: item.title, kind: item.kind },
        `About ${hoursLabel(current.minutes)} · ${current.donated ? `donated (${moneyLabel(price)} value)` : moneyLabel(price)}`, actor).run();
      return reply();
    }
    if (action === 'withdraw' && method === 'POST') {
      await body(request);
      const done = await db.prepare("UPDATE change_estimates SET status = 'withdrawn', updated_at = CURRENT_TIMESTAMP WHERE item_id = ? AND status IN ('draft', 'offered')").bind(item.id).run();
      if (!done.meta.changes) throw new InputError('Only an estimate that is not decided can be withdrawn.', 409);
      return reply();
    }
    if (action === 'handled' && method === 'POST') {
      await body(request);
      const done = await db.prepare("UPDATE change_estimates SET handled_at = CURRENT_TIMESTAMP WHERE item_id = ? AND status IN ('approved_now', 'approved_later')").bind(item.id).run();
      if (!done.meta.changes) throw new InputError('Only an approved change can be marked handled.', 409);
      return reply();
    }
    if (action === 'retry-task' && method === 'POST') {
      await body(request);
      const result = await pushEstimateTask(env, db, url, item.id);
      return json({ ok: result === 'created' || result === 'exists', result });
    }
    return json({ error: 'Not found.' }, 404);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, error.status);
    throw error;
  }
}
