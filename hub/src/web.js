// Weekly website digest: last week's positivetribes.org numbers from Google Analytics 4 (visitors, leads, donations,
// where people came from, the pages that show buying interest), saved once a week and shown on the command center's Today.
// Read-only: a Google service account with only Viewer on the GA property and the analytics.readonly scope.
// Its JSON key is the GA_SA_KEY Worker secret; GA_PROPERTY_ID (the numeric property id) is a public identifier in vars.
// GA4 already drops traffic its Internal Traffic data filter removes (Eric's devices, tagged with ?internal=1).

export const WEB_HOST = 'hub.positivetribes.org';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

// The site's own events (positivetribes.org build.mjs, index.html, donate.html, support.html), in the order shown.
export const EVENTS = [
  ['generate_lead', 'Contact and volunteer forms sent'],
  ['contact_email_click', 'Email link clicked'],
  ['contact_email_copy', 'Email address copied'],
  ['support_request', 'Help requests'],
  ['begin_checkout', 'Donations started'],
  ['donation_complete', 'Donations completed']
];
// Pages that show interest in working with us or giving.
export const PAGES = ['/care.html', '/projects.html', '/contact.html', '/donate.html', '/about.html'];

export const webReady = env => env.WEB_HOST === WEB_HOST && /^\d+$/.test(String(env.GA_PROPERTY_ID || '')) && Boolean(env.GA_SA_KEY);

// ---- Dates ----

const addDays = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
// Last full Monday-to-Sunday week before `today` (YYYY-MM-DD, local), and the week before it.
export function weeksBefore(today) {
  const dow = new Date(today + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
  const end = addDays(today, -(dow === 0 ? 7 : dow));
  const start = addDays(end, -6);
  return { start, end, prevStart: addDays(start, -7), prevEnd: addDays(start, -1) };
}

// ---- Google sign-in (service account JWT, RS256 with Web Crypto) ----

const b64url = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = text => b64url(new TextEncoder().encode(text));

export function serviceAccount(env) {
  let key;
  try { key = JSON.parse(env.GA_SA_KEY); } catch { throw new Error('GA_SA_KEY is not valid JSON.'); }
  if (!key?.client_email || !key?.private_key) throw new Error('GA_SA_KEY needs client_email and private_key.');
  return key;
}

async function googleToken(env, fetchFn) {
  const key = serviceAccount(env);
  const pem = key.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const signer = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' })) + '.' +
    b64urlText(JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer, new TextEncoder().encode(unsigned));
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64url(sig) })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) throw new Error('Google sign-in failed (' + res.status + (body.error ? ': ' + body.error : '') + ').');
  return body.access_token;
}

// ---- Reports ----

const inList = (field, values) => ({ filter: { fieldName: field, inListFilter: { values } } });

export function reportRequests(w) {
  const both = [{ startDate: w.start, endDate: w.end, name: 'now' }, { startDate: w.prevStart, endDate: w.prevEnd, name: 'before' }];
  const now = [both[0]];
  return [
    { dateRanges: both, metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'screenPageViews' }] },
    { dateRanges: both, dimensions: [{ name: 'eventName' }], metrics: [{ name: 'eventCount' }, { name: 'eventValue' }], dimensionFilter: inList('eventName', EVENTS.map(e => e[0])) },
    { dateRanges: now, dimensions: [{ name: 'sessionSource' }], metrics: [{ name: 'sessions' }, { name: 'keyEvents' }], orderBys: [{ metric: { metricName: 'sessions' }, desc: true }], limit: 6 },
    { dateRanges: both, dimensions: [{ name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }], dimensionFilter: inList('pagePath', PAGES) }
  ];
}

// GA adds a dateRange dimension (last) when a report has two ranges; values come back as strings.
const num = v => Number(v?.value ?? v ?? 0) || 0;
function byRange(report, dims) {
  const out = { now: {}, before: {} };
  for (const row of report?.rows || []) {
    const d = row.dimensionValues || [];
    const range = dims < d.length ? d[d.length - 1].value : 'now';
    const key = dims ? d[0].value : 'total';
    (out[range] ||= {})[key] = (row.metricValues || []).map(num);
  }
  return out;
}

// Turn the four GA reports into the digest saved and shown. Pure, so tests can feed it canned reports.
export function digestFrom(week, reports) {
  const [totals, events, sources, pages] = reports;
  const t = byRange(totals, 0), e = byRange(events, 1), p = byRange(pages, 1);
  const pair = (r, key, i = 0) => ({ now: r.now?.[key]?.[i] || 0, before: r.before?.[key]?.[i] || 0 });
  return {
    week,
    visitors: pair(t, 'total', 0),
    sessions: pair(t, 'total', 1),
    views: pair(t, 'total', 2),
    events: EVENTS.map(([name, label]) => ({ name, label, ...pair(e, name) })),
    donated: pair(e, 'donation_complete', 1),
    sources: (sources?.rows || []).map(r => ({ source: r.dimensionValues?.[0]?.value || '(not set)', sessions: num(r.metricValues?.[0]), keyEvents: num(r.metricValues?.[1]) })),
    pages: PAGES.map(path => ({ path, ...pair(p, path) }))
  };
}

async function fetchDigest(env, today, fetchFn) {
  const token = await googleToken(env, fetchFn);
  const week = weeksBefore(today);
  const res = await fetchFn(`https://analyticsdata.googleapis.com/v1beta/properties/${env.GA_PROPERTY_ID}:batchRunReports`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: reportRequests(week) })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Google Analytics refused the report (' + res.status + (body.error?.status ? ': ' + body.error.status : '') + ').');
  return digestFrom(week, body.reports || []);
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
  if (!webReady(env)) return { ran: false, reason: 'The website digest needs GA_PROPERTY_ID and the GA_SA_KEY secret, on hub.positivetribes.org.' };
  const db = env.ADMIN_DB;
  await ensureTable(db);
  const week = weeksBefore(today);
  try {
    const digest = await fetchDigest(env, today, fetchFn);
    await db.prepare("INSERT INTO web_digest (week_start, data_json, error, ran_at) VALUES (?, ?, '', strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(week_start) DO UPDATE SET data_json = excluded.data_json, error = '', ran_at = excluded.ran_at")
      .bind(week.start, JSON.stringify(digest)).run();
    return { ran: true, week: week.start };
  } catch (error) {
    // Keep a good earlier save for the same week; only the error is new.
    await db.prepare("INSERT INTO web_digest (week_start, error, ran_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(week_start) DO UPDATE SET error = excluded.error, ran_at = excluded.ran_at")
      .bind(week.start, String(error.message).slice(0, 300)).run();
    return { ran: false, reason: error.message };
  }
}

// The newest saved week (and the 8 before it, for the leads trend), for Today.
export async function latestWebDigest(db) {
  await ensureTable(db);
  const rows = (await db.prepare('SELECT week_start, data_json, error, ran_at FROM web_digest ORDER BY week_start DESC LIMIT 9').all()).results;
  if (!rows.length) return null;
  const parse = r => { try { return JSON.parse(r.data_json); } catch { return {}; } };
  const [top] = rows;
  const leadsOf = d => (d.events || []).filter(e => ['generate_lead', 'contact_email_click', 'contact_email_copy'].includes(e.name)).reduce((n, e) => n + e.now, 0);
  return {
    week: top.week_start, ranAt: top.ran_at, error: top.error || '',
    digest: top.data_json && top.data_json !== '{}' ? parse(top) : null,
    trend: rows.filter(r => r.data_json && r.data_json !== '{}').reverse().map(r => ({ week: r.week_start, leads: leadsOf(parse(r)) }))
  };
}

// POST /api/admin/web/run (Positive Tribes only): run it now, only on the production host.
export async function webAdmin({ env, url, route, json }, today) {
  if (route !== 'POST /api/admin/web/run') return null;
  if (url.host !== WEB_HOST) return json({ ran: false, reason: 'The website digest runs only on hub.positivetribes.org.' }, 409);
  const result = await runWebDigest(env, today);
  return json({ ...result, web: await latestWebDigest(env.ADMIN_DB) });
}
