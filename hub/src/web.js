// Weekly website digest: last week's positivetribes.org numbers, saved once a week and shown on the command center's Today.
// No Google keys. Two read-only sources, each optional (a missing or failing one is noted, the rest still saves):
//  - Salesforce (the hub's existing read access): new web Leads (the site's contact Worker saves every form as a Lead,
//    Lead Source = Web) and paid Gift Transactions (the Stripe webhook records each gift).
//  - Cloudflare Web Analytics (cookieless beacon on the site's main pages, skipped on devices tagged ?internal=1):
//    visits, page views, top referrers and views of the pages that show interest. Needs CF_ACCOUNT_ID and
//    CF_WEB_SITE_TAG (public identifiers, in vars) and the CF_ANALYTICS_TOKEN secret (Account Analytics: Read only).
// Only counts are saved: no names, emails or addresses.

import { salesforceToken, soql } from './salesforce.js';

export const WEB_HOST = 'hub.positivetribes.org';
const TIME_ZONE = 'America/Denver';
// Pages that show interest in working with us or giving. The site redirects /care.html to /care, so the beacon
// records the short path; both spellings are asked for and counted together.
export const PAGES = ['/care', '/projects', '/contact', '/donate', '/support', '/volunteer', '/about'];
const PAGE_PATHS = PAGES.flatMap(p => [p, p + '.html']);
const pagePath = path => String(path || '').replace(/\.html$/, '').replace(/\/$/, '') || '/';

const salesforceOn = env => Boolean(env.SF_DOMAIN && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET);
const hex32 = v => /^[a-f0-9]{32}$/.test(String(v || ''));
const cloudflareOn = env => hex32(env.CF_ACCOUNT_ID) && hex32(env.CF_WEB_SITE_TAG) && Boolean(env.CF_ANALYTICS_TOKEN);
export const webReady = env => env.WEB_HOST === WEB_HOST && (salesforceOn(env) || cloudflareOn(env));

// ---- Dates ----

const addDays = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
// Last full Monday-to-Sunday week before `today` (YYYY-MM-DD, Denver), and the week before it.
export function weeksBefore(today) {
  const dow = new Date(today + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
  const end = addDays(today, -(dow === 0 ? 7 : dow));
  const start = addDays(end, -6);
  return { start, end, prevStart: addDays(start, -7), prevEnd: addDays(start, -1) };
}
// Midnight in Denver on `day`, as a UTC instant (MDT is UTC-6, MST UTC-7).
export function denverMidnight(day) {
  for (const h of ['06', '07']) {
    const at = new Date(`${day}T${h}:00:00Z`);
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, hour: '2-digit', hourCycle: 'h23' }).format(at);
    if (hour === '00') return at.toISOString().replace('.000Z', 'Z');
  }
  throw new Error('No Denver midnight for ' + day);
}
// The instants bounding the two weeks: the week before starts, last week starts, last week ends.
export const bounds = w => ({ before: denverMidnight(w.prevStart), start: denverMidnight(w.start), end: denverMidnight(addDays(w.end, 1)) });

// ---- Salesforce: leads and gifts ----

export async function salesforceCounts(env, w) {
  const b = bounds(w);
  const auth = await salesforceToken(env);
  const leads = await soql(auth, `SELECT CreatedDate FROM Lead WHERE LeadSource = 'Web' AND CreatedDate >= ${b.before} AND CreatedDate < ${b.end}`);
  const out = { leads: { now: 0, before: 0 } };
  // Salesforce returns CreatedDate like 2026-11-10T15:04:05.000+0000; compare as instants.
  for (const r of leads.records) out.leads[Date.parse(r.CreatedDate.replace(/\+0000$/, 'Z')) >= Date.parse(b.start) ? 'now' : 'before']++;
  // Gifts are optional: an integration user without Gift Transaction access still gets leads.
  try {
    const gifts = await soql(auth, `SELECT TransactionDate, OriginalAmount FROM GiftTransaction WHERE Status = 'Paid' AND TransactionDate >= ${w.prevStart} AND TransactionDate <= ${w.end}`);
    out.gifts = { now: 0, before: 0 }; out.given = { now: 0, before: 0 };
    for (const r of gifts.records) {
      const k = String(r.TransactionDate).slice(0, 10) >= w.start ? 'now' : 'before';
      out.gifts[k]++; out.given[k] += Number(r.OriginalAmount) || 0;
    }
  } catch (error) { out.giftsError = 'Donations could not be read (' + String(error.message).slice(0, 80) + ').'; }
  return out;
}

// ---- Cloudflare Web Analytics ----

const GRAPHQL = 'https://api.cloudflare.com/client/v4/graphql';
const RUM_QUERY = `query($acct: string!, $site: string!, $before: Time!, $start: Time!, $end: Time!, $pages: [string!]) {
  viewer { accounts(filter: { accountTag: $acct }) {
    now: rumPageloadEventsAdaptiveGroups(limit: 1, filter: { siteTag: $site, datetime_geq: $start, datetime_lt: $end }) { count sum { visits } }
    before: rumPageloadEventsAdaptiveGroups(limit: 1, filter: { siteTag: $site, datetime_geq: $before, datetime_lt: $start }) { count sum { visits } }
    sources: rumPageloadEventsAdaptiveGroups(limit: 8, orderBy: [sum_visits_DESC], filter: { siteTag: $site, datetime_geq: $start, datetime_lt: $end }) { sum { visits } dimensions { refererHost } }
    pagesNow: rumPageloadEventsAdaptiveGroups(limit: 40, filter: { siteTag: $site, datetime_geq: $start, datetime_lt: $end, requestPath_in: $pages }) { count dimensions { requestPath } }
    pagesBefore: rumPageloadEventsAdaptiveGroups(limit: 40, filter: { siteTag: $site, datetime_geq: $before, datetime_lt: $start, requestPath_in: $pages }) { count dimensions { requestPath } }
  } }
}`;

// Turn the GraphQL answer into counts. Pure, so tests can feed it a canned answer.
export function visitsFrom(account) {
  const one = rows => ({ visits: rows?.[0]?.sum?.visits || 0, views: rows?.[0]?.count || 0 });
  const now = one(account?.now), before = one(account?.before);
  const pageCount = (rows, path) => (rows || []).filter(r => pagePath(r.dimensions?.requestPath) === path).reduce((n, r) => n + (r.count || 0), 0);
  return {
    visits: { now: now.visits, before: before.visits },
    views: { now: now.views, before: before.views },
    // A blank referrer is someone typing the address, a bookmark or an app; our own host is people moving between pages,
    // and cloudflareaccess.com is us coming back from a sign-in.
    sources: (account?.sources || [])
      .map(r => ({ source: r.dimensions?.refererHost || 'Direct or app', visits: r.sum?.visits || 0 }))
      .filter(s => !/(^|\.)positivetribes\.org$|\.cloudflareaccess\.com$/.test(s.source) && s.visits > 0).slice(0, 6),
    pages: PAGES.map(path => ({ path, now: pageCount(account?.pagesNow, path), before: pageCount(account?.pagesBefore, path) }))
  };
}

export async function cloudflareVisits(env, w, fetchFn = fetch) {
  const res = await fetchFn(GRAPHQL, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.CF_ANALYTICS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: RUM_QUERY, variables: { acct: env.CF_ACCOUNT_ID, site: env.CF_WEB_SITE_TAG, ...bounds(w), pages: PAGE_PATHS } })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.errors?.length) throw new Error('Cloudflare analytics refused the query (' + res.status + (body.errors?.[0]?.message ? ': ' + String(body.errors[0].message).slice(0, 120) : '') + ').');
  return visitsFrom(body.data?.viewer?.accounts?.[0]);
}

// ---- One run ----

export async function buildDigest(env, today, fetchFn = fetch) {
  const week = weeksBefore(today);
  const digest = { week, notes: [] };
  const [sf, cf] = await Promise.allSettled([
    salesforceOn(env) ? salesforceCounts(env, week) : Promise.reject(new Error('Salesforce is not connected.')),
    cloudflareOn(env) ? cloudflareVisits(env, week, fetchFn) : Promise.reject(new Error('Cloudflare Web Analytics is not set up yet.'))
  ]);
  if (sf.status === 'fulfilled') {
    const { giftsError, ...counts } = sf.value;
    Object.assign(digest, counts);
    if (giftsError) digest.notes.push(giftsError);
  } else digest.notes.push('Leads and donations: ' + String(sf.reason?.message || sf.reason).slice(0, 160));
  if (cf.status === 'fulfilled') Object.assign(digest, cf.value);
  else digest.notes.push('Visits: ' + String(cf.reason?.message || cf.reason).slice(0, 160));
  if (sf.status === 'rejected' && cf.status === 'rejected') throw new Error(digest.notes.join(' '));
  return digest;
}

// ---- Storage (positivetribes-admin-db) ----

const ready = new WeakSet();
async function ensureTable(db) {
  if (ready.has(db)) return;
  await db.prepare("CREATE TABLE IF NOT EXISTS web_digest (week_start TEXT PRIMARY KEY, data_json TEXT NOT NULL DEFAULT '{}', error TEXT NOT NULL DEFAULT '', ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))").run();
  ready.add(db);
}

// Run once (cron on Mondays, or "Run now"). A failure is saved too, so Today says so instead of going quiet.
export async function runWebDigest(env, today, fetchFn = fetch) {
  if (!webReady(env)) return { ran: false, reason: 'The website digest runs only on hub.positivetribes.org, with Salesforce or Cloudflare Web Analytics set up.' };
  const db = env.ADMIN_DB;
  await ensureTable(db);
  const week = weeksBefore(today);
  try {
    const digest = await buildDigest(env, today, fetchFn);
    await db.prepare("INSERT INTO web_digest (week_start, data_json, error, ran_at) VALUES (?, ?, '', strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(week_start) DO UPDATE SET data_json = excluded.data_json, error = '', ran_at = excluded.ran_at")
      .bind(week.start, JSON.stringify(digest)).run();
    return { ran: true, week: week.start, notes: digest.notes };
  } catch (error) {
    // Keep a good earlier save for the same week; only the error is new.
    await db.prepare("INSERT INTO web_digest (week_start, error, ran_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(week_start) DO UPDATE SET error = excluded.error, ran_at = excluded.ran_at")
      .bind(week.start, String(error.message).slice(0, 300)).run();
    return { ran: false, reason: error.message };
  }
}

// The newest saved week, plus up to 9 weeks of leads for the trend, for Today.
export async function latestWebDigest(db) {
  await ensureTable(db);
  const rows = (await db.prepare('SELECT week_start, data_json, error, ran_at FROM web_digest ORDER BY week_start DESC LIMIT 9').all()).results;
  if (!rows.length) return null;
  const parse = r => { try { return JSON.parse(r.data_json); } catch { return {}; } };
  const saved = r => r.data_json && r.data_json !== '{}';
  const [top] = rows;
  return {
    week: top.week_start, ranAt: top.ran_at, error: top.error || '',
    digest: saved(top) ? parse(top) : null,
    trend: rows.filter(saved).reverse().map(r => ({ week: r.week_start, leads: parse(r).leads?.now ?? null })).filter(t => t.leads !== null)
  };
}

// POST /api/admin/web/run (Positive Tribes only): run it now, only on the production host.
export async function webAdmin({ env, url, route, json }, today) {
  if (route !== 'POST /api/admin/web/run') return null;
  if (url.host !== WEB_HOST) return json({ ran: false, reason: 'The website digest runs only on hub.positivetribes.org.' }, 409);
  const result = await runWebDigest(env, today);
  return json({ ...result, web: await latestWebDigest(env.ADMIN_DB) });
}
