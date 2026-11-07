// Care plans: monthly credits, rollover, boost packs and courtesy edits, from an append-only ledger (credit_ledger).
// Reusable: the plan terms below are config, and nothing here knows about any one client. Balances are always
// computed from the ledger, never stored, so the history explains every number.

export const SIZES = { S: 1, M: 2, L: 4 };
export const TIERS = {
  essentials: { name: 'Essentials', credits: 2, price: 300 },
  care: { name: 'Care', credits: 6, price: 500 },
  growth: { name: 'Growth', credits: 12, price: 750 }
};
export const BOOST = { credits: 8, months: 12, price: 300 };
// Courtesy edits (wording, labels, typos, images): the first 5 in a month are free, then every 5 count as 1 credit.
export const COURTESY = { free: 5, per: 5 };
// Monthly credits last the month they are granted plus this many more.
export const ROLLOVER_MONTHS = 1;
// The plan's history is backfilled at most this far, so a plan dated long ago cannot write an endless batch.
const MAX_BACKFILL = 24;

export const TYPE_NAMES = { fix: 'Fix', courtesy: 'Courtesy edit', improvement: 'Improvement', project: 'New project' };
export const STATUS_NAMES = {
  new: 'Being sorted', awaiting_confirm: 'Waiting for your OK', waiting_credits: 'Waiting for credits',
  queued: 'In the queue', declined: 'Not going ahead', shipped: 'Shipped'
};

export const todayUtc = () => new Date().toISOString().slice(0, 10);
export const monthOf = day => day.slice(0, 7);
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
// The last day of the month n months after this one.
export function endOfMonth(month, n = 0) {
  const [y, m] = addMonths(month, n).split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}
export function addYearsMonths(day, months) {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
}

// The credit cost of the nth courtesy edit in a month (n counts from 1): 0 for the free ones, then 1 at the start of
// each block of 5 (the 6th, 11th, ...), so a block is charged once, when it begins.
export const courtesyCost = n => n > COURTESY.free && (n - COURTESY.free - 1) % COURTESY.per === 0 ? 1 : 0;

export const costLabel = r => {
  if (r.type === 'fix') return 'Fix · free';
  if (r.type === 'courtesy') return r.credits ? 'Courtesy edit · 1 credit' : 'Courtesy edit · free';
  if (r.type === 'project') return 'New project · quoted separately';
  if (r.type === 'improvement') return `${r.size} · ${r.credits} credit${r.credits === 1 ? '' : 's'}`;
  return '';
};

// The balance on a day, from the ledger rows in the order they happened. Each grant, boost or refund is a bucket with
// an end date; each spend takes from the bucket that ends soonest (monthly credits before boost credits), among the
// buckets still open on the day of the spend. A spend that finds too little is owed and taken from the next bucket.
// drawn[spendId] lists what each spend took, so a cancelled request gets its credits back with the same end date.
export function balanceOf(rows, today) {
  const buckets = [];
  const drawn = {};
  const owing = [];
  const ordered = [...rows].sort((a, b) => a.at.localeCompare(b.at) || a.id - b.id);
  for (const r of ordered) {
    if (r.credits > 0) {
      // A refund that keeps a boost's end date counts as boost credit, so it is still used last.
      const boost = r.kind === 'boost' || (r.kind === 'refund' && r.expires_on > endOfMonth(r.month, ROLLOVER_MONTHS));
      const bucket = { boost, left: r.credits, expires: r.expires_on };
      for (const o of owing) {
        const take = Math.min(o.need, bucket.left);
        if (!take) continue;
        bucket.left -= take; o.need -= take;
        drawn[o.id].push({ credits: take, expires: bucket.expires });
      }
      buckets.push(bucket);
    } else if (r.credits < 0) {
      const day = r.at.slice(0, 10);
      let need = -r.credits;
      drawn[r.id] = [];
      const open = buckets.filter(b => b.left > 0 && b.expires >= day)
        .sort((a, b) => a.boost - b.boost || a.expires.localeCompare(b.expires));
      for (const b of open) {
        if (!need) break;
        const take = Math.min(need, b.left);
        b.left -= take; need -= take;
        drawn[r.id].push({ credits: take, expires: b.expires });
      }
      if (need) owing.push({ id: r.id, need });
    }
  }
  const owed = owing.reduce((n, o) => n + o.need, 0);
  const live = buckets.filter(b => b.left > 0 && b.expires >= today);
  const sum = list => list.reduce((n, b) => n + b.left, 0);
  const month = monthOf(today);
  const monthRows = rows.filter(r => r.month === month);
  const spentThisMonth = new Set(monthRows.filter(r => r.kind === 'spend').map(r => r.item_id));
  return {
    available: Math.max(0, sum(live) - owed),
    monthly: sum(live.filter(b => !b.boost)),
    boost: sum(live.filter(b => b.boost)),
    owed,
    // Rolled-over credits that end this month if they are not used.
    expiringSoon: sum(live.filter(b => !b.boost && b.expires <= endOfMonth(month))),
    grantedThisMonth: monthRows.filter(r => r.kind === 'grant').reduce((n, r) => n + r.credits, 0),
    // Spent this month, less what came back for those same spends (a refund of last month's spend is not counted).
    usedThisMonth: Math.max(0, -monthRows.filter(r => r.kind === 'spend').reduce((n, r) => n + r.credits, 0)
      - monthRows.filter(r => r.kind === 'refund' && spentThisMonth.has(r.item_id)).reduce((n, r) => n + r.credits, 0)),
    courtesyThisMonth: monthRows.filter(r => r.kind === 'courtesy').length,
    drawn
  };
}

export const planFor = (db, clientId) => db.prepare('SELECT * FROM care_plans WHERE client_id = ?').bind(clientId).first();

// Writes each month's grant from the plan's start through this month, once (the unique index makes repeats no-ops).
// Lazy, on every care read, so no scheduled job is needed. Only an active plan earns credits.
export async function ensureGrants(db, plan, today) {
  if (!plan || plan.status !== 'active' || !plan.starts_on || plan.starts_on > today) return;
  const last = monthOf(today);
  let month = monthOf(plan.starts_on);
  if (month < addMonths(last, -MAX_BACKFILL)) month = addMonths(last, -MAX_BACKFILL);
  const statements = [];
  for (; month <= last; month = addMonths(month, 1)) {
    statements.push(db.prepare(
      `INSERT OR IGNORE INTO credit_ledger (client_id, care_plan_id, kind, credits, month, expires_on, note, at)
       VALUES (?, ?, 'grant', ?, ?, ?, ?, ?)`
    ).bind(plan.client_id, plan.id, plan.monthly_credits, month, endOfMonth(month, ROLLOVER_MONTHS),
      `${TIERS[plan.tier]?.name || plan.tier} plan, ${month}`, month + '-01 00:00:00'));
  }
  if (statements.length) await db.batch(statements);
}

export async function ledgerOf(db, plan) {
  const { results } = await db.prepare(
    'SELECT id, kind, credits, month, expires_on, item_id, note, at FROM credit_ledger WHERE client_id = ? AND care_plan_id = ? ORDER BY at, id'
  ).bind(plan.client_id, plan.id).all();
  return results;
}

// Only the director, the one named contact and Positive Tribes see balances and credit history.
export const canSeeBalance = (user, plan) => Boolean(plan) && (user.role === 'pt' || user.role === 'ed' || user.id === plan.balance_contact_user_id);
// Only the director or the named contact may say yes to spending credits. Positive Tribes never confirms for them.
export const canConfirm = (user, plan) => Boolean(plan) && user.role !== 'pt' && (user.role === 'ed' || user.id === plan.balance_contact_user_id);
// A tool takes care requests once it was sold (Opportunity closed-won), signed off and released (phase support),
// and the client's plan is active.
export const isLive = (project, plan) => Boolean(plan && plan.status === 'active' && project.phase === 'support' && project.opportunity_won);

export async function careRequests(db, clientId) {
  const { results } = await db.prepare(
    `SELECT r.item_id, r.type, r.size, r.credits, r.status, r.triage_note, r.triaged_at, r.confirmed_by, r.confirmed_at, r.shipped_at,
            r.question, r.answer, r.created_at, i.title, i.project_id, p.name AS project
     FROM care_requests r JOIN items i ON i.id = r.item_id AND i.client_id = r.client_id JOIN projects p ON p.id = i.project_id
     WHERE r.client_id = ? ORDER BY r.created_at DESC, r.item_id DESC LIMIT 200`
  ).bind(clientId).all();
  return results.map(r => ({ ...r, cost: costLabel(r), status_name: STATUS_NAMES[r.status] }));
}

// What the client's hub shows. The plan appears only once active; the balance and history only for those allowed.
export async function careView(db, client, user, today = todayUtc()) {
  const plan = await planFor(db, client.id);
  const { results: projects } = await db.prepare('SELECT id, name, phase, opportunity_won FROM projects WHERE client_id = ? ORDER BY position, id').bind(client.id).all();
  const live = projects.filter(p => isLive(p, plan)).map(p => ({ id: p.id, name: p.name }));
  if (!plan || plan.status !== 'active') return { plan: null, live: [], requests: [], balance: null, history: null, canConfirm: false };
  await ensureGrants(db, plan, today);
  const requests = await careRequests(db, client.id);
  const month = monthOf(today);
  const shippedThisMonth = requests.filter(r => r.status === 'shipped' && (r.shipped_at || '').slice(0, 7) === month).length;
  const allowed = canSeeBalance(user, plan);
  const ledger = allowed ? await ledgerOf(db, plan) : null;
  return {
    plan: { tier: plan.tier, name: TIERS[plan.tier]?.name || plan.tier, monthly_credits: plan.monthly_credits, starts_on: plan.starts_on },
    live, requests, shippedThisMonth,
    balance: allowed ? (({ drawn, ...b }) => b)(balanceOf(ledger, today)) : null,
    history: allowed ? ledger.slice(-100).reverse().map(({ id, kind, credits, month, expires_on, item_id, note, at }) => ({ id, kind, credits, month, expires_on, item_id, note, at })) : null,
    canConfirm: canConfirm(user, plan),
    courtesy: { ...COURTESY }
  };
}
