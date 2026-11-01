// Client command center at /admin: one private view of every client's past, present and future.
// Salesforce stays the system of record and is read live. ADMIN_DB (D1) holds Eric's own notes, next steps,
// links and the activity a daily Claude routine posts from Gmail, Calendar and Fathom.
// Cloudflare Access guards /admin and /api/admin; the Worker checks the Access token again and fails closed.

import { salesforceToken, soql, quote } from './donations.mjs';

const OWN_ACCOUNT = 'Positive Tribes';
const TIME_ZONE = 'America/Denver';
const STALE_DAYS = 21, WINDOW_DAYS = 14;
const ACTIVITY_KINDS = ['email', 'meeting', 'calendar'];
const STEP_STATUSES = ['open', 'done', 'dismissed'];
// Shared mail providers say nothing about which client a message is from, so only exact addresses match them.
const GENERIC_DOMAINS = ['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'me.com', 'aol.com', 'live.com', 'msn.com', 'comcast.net', 'proton.me', 'protonmail.com'];

const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex' } });

class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function text(value, max, { required = false, label = 'Text', multiline = false } = {}) {
  if (value != null && typeof value !== 'string') throw new InputError(`${label} must be text.`);
  const result = (value || '').trim();
  if (required && !result) throw new InputError(`${label} is required.`);
  if (result.length > max) throw new InputError(`${label} must be at most ${max} characters.`);
  if ((multiline ? /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/ : /[\x00-\x1f\x7f]/).test(result)) throw new InputError(`${label} contains characters that are not allowed.`);
  return result;
}

const accountIdOf = value => {
  if (typeof value !== 'string' || !/^001[a-zA-Z0-9]{12}([a-zA-Z0-9]{3})?$/.test(value)) throw new InputError('Choose a client.');
  return value;
};
const dateOf = (value, label = 'Date') => {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value))) throw new InputError(`${label} must look like 2026-11-04.`);
  return value;
};
const timeOf = value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(value) || isNaN(Date.parse(value))) throw new InputError('occurred_at must be an ISO date or time.');
  return value.length === 10 ? value : new Date(value).toISOString();
};
// Only web links, so nothing typed or synced can become a javascript: link on the page.
const urlOf = (value, label = 'Link') => {
  const result = text(value, 1000, { label });
  if (!result) return '';
  let parsed;
  try { parsed = new URL(result); } catch { throw new InputError(`${label} must be a full web address.`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new InputError(`${label} must start with https://.`);
  return parsed.href;
};
const list = (value, max, each) => {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > max) throw new InputError(`Send a list of at most ${max}.`);
  return value.map(each);
};

async function body(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new InputError('Send JSON.', 415);
  let result;
  try { result = await request.json(); } catch { throw new InputError('Invalid JSON.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new InputError('Expected an object.');
  return result;
}

// ---- Access ----

const b64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - s.length % 4) % 4)), c => c.charCodeAt(0));
const b64json = s => JSON.parse(new TextDecoder().decode(b64url(s)));
let accessKeys = { team: '', at: 0, keys: new Map() };

async function signingKey(team, kid) {
  const fresh = accessKeys.team === team && Date.now() - accessKeys.at < 3600e3;
  if (fresh && accessKeys.keys.has(kid)) return accessKeys.keys.get(kid);
  // Unknown key id: Access may have rotated keys, so fetch once more (at most every 30 s).
  if (fresh && Date.now() - accessKeys.at < 30e3) return null;
  const response = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error('access_certs_' + response.status);
  const keys = new Map();
  for (const jwk of (await response.json()).keys || []) {
    if (jwk.kty !== 'RSA' || !jwk.kid) continue;
    keys.set(jwk.kid, await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  accessKeys = { team, at: Date.now(), keys };
  return keys.get(kid) || null;
}

// Returns who is asking ({ email } for a person, { service } for the sync routine's service token) or a 403/503 Response.
export async function requireAccess(request, env, url) {
  const deny = (why) => { console.warn('admin_access_denied', why); return new Response('Not allowed.', { status: 403, headers: { 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } }); };
  // Local development only: wrangler dev on localhost with --var ADMIN_DEV:1. Never set in Cloudflare.
  if (env.ADMIN_DEV === '1' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) return { email: 'dev@localhost' };
  const team = env.ACCESS_TEAM_DOMAIN, aud = env.ACCESS_AUD;
  if (!team || !aud || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(team)) return deny('not_configured');
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return deny('no_token');
  try {
    const [head, payload, signature] = token.split('.');
    if (!signature) return deny('malformed');
    const header = b64json(head), claims = b64json(payload);
    if (header.alg !== 'RS256') return deny('alg');
    const key = await signingKey(team, header.kid);
    if (!key) return deny('unknown_key');
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(signature), new TextEncoder().encode(head + '.' + payload));
    if (!valid) return deny('signature');
    const now = Date.now() / 1000;
    if (!(claims.exp > now) || (claims.nbf && claims.nbf > now + 60)) return deny('expired');
    if (claims.iss !== `https://${team}`) return deny('issuer');
    if (!(Array.isArray(claims.aud) ? claims.aud : [claims.aud]).includes(aud)) return deny('audience');
    if (claims.email) {
      const allowed = (env.ADMIN_EMAILS || 'eric@positivetribes.org').toLowerCase().split(/[\s,]+/).filter(Boolean);
      if (!allowed.includes(String(claims.email).toLowerCase())) return deny('email');
      return { email: claims.email };
    }
    if (claims.common_name) return { service: claims.common_name };
    return deny('no_identity');
  } catch (error) {
    console.error('admin_access_error', error.message);
    return deny('error');
  }
}

export const isAdminPath = pathname => {
  let path = pathname;
  try { path = decodeURIComponent(pathname); } catch {}
  return /^\/+(api\/+)?admin(\/|\.|$)/i.test(path);
};

// ---- D1 ----

const schemaReady = new WeakMap();
// Once per isolate per database: running these on every request costs CPU the free plan does not have.
function ensureSchema(db) {
  if (!schemaReady.has(db)) {
    const ready = db.batch([
      db.prepare("CREATE TABLE IF NOT EXISTS client_meta (account_id TEXT PRIMARY KEY, links_json TEXT NOT NULL DEFAULT '[]', match_json TEXT NOT NULL DEFAULT '{}', pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)), hidden INTEGER NOT NULL DEFAULT 0 CHECK(hidden IN (0,1)))"),
      db.prepare("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, body TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))"),
      db.prepare("CREATE TABLE IF NOT EXISTS next_steps (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, title TEXT NOT NULL, due_date TEXT, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','dismissed')), source TEXT NOT NULL DEFAULT 'you' CHECK(source IN ('you','claude')), external_id TEXT UNIQUE, done_at TEXT, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))"),
      db.prepare("CREATE TABLE IF NOT EXISTS activity (id INTEGER PRIMARY KEY AUTOINCREMENT, account_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('email','meeting','calendar')), occurred_at TEXT NOT NULL, title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '', external_id TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')))"),
      db.prepare("CREATE TABLE IF NOT EXISTS backlog_cleared (backlog TEXT NOT NULL, event_id INTEGER NOT NULL, cleared_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), PRIMARY KEY (backlog, event_id))"),
      db.prepare("CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, ran_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), added INTEGER NOT NULL, updated INTEGER NOT NULL, removed INTEGER NOT NULL, steps INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '')"),
      db.prepare('CREATE INDEX IF NOT EXISTS notes_account ON notes(account_id)'),
      db.prepare('CREATE INDEX IF NOT EXISTS steps_account ON next_steps(account_id)'),
      db.prepare('CREATE INDEX IF NOT EXISTS activity_account ON activity(account_id, occurred_at)')
    ]);
    schemaReady.set(db, ready);
    ready.catch(() => schemaReady.delete(db));
  }
  return schemaReady.get(db);
}

const parse = (value, fallback) => { try { return JSON.parse(value); } catch { return fallback; } };
const metaRow = row => ({ links: parse(row?.links_json, []), match: parse(row?.match_json, {}), pinned: !!row?.pinned, hidden: !!row?.hidden });

// ---- Salesforce ----

const salesforceReady = env => !!(env.SF_DOMAIN && env.SF_CLIENT_ID && env.SF_CLIENT_SECRET);
let tokenCache = { at: 0, auth: null };
async function salesforce(env) {
  if (tokenCache.auth && Date.now() - tokenCache.at < 30 * 60e3) return tokenCache.auth;
  tokenCache = { at: Date.now(), auth: await salesforceToken(env) };
  return tokenCache.auth;
}
const sfLink = (env, object, id) => env.SF_DOMAIN.replace(/\/$/, '') + '/lightning/r/' + object + '/' + id + '/view';
const records = async (auth, q) => (await soql(auth, q)).records;

let overviewCache = { at: 0, data: null };
// Inviting another Salesforce user to an event adds a child copy owned by them (IsChild), so only originals are read.
async function salesforceOverview(env, refresh) {
  if (!refresh && overviewCache.data && Date.now() - overviewCache.at < 60e3) return overviewCache.data;
  const auth = await salesforce(env);
  const [accounts, tasks, events, cases, leads] = await Promise.all([
    records(auth, 'SELECT Id, Name, Type, Website, (SELECT Id, Name, StageName, CloseDate, NextStep, IsClosed, IsWon FROM Opportunities ORDER BY CloseDate) FROM Account WHERE IsPersonAccount = false AND Name != ' + quote(OWN_ACCOUNT) + ' ORDER BY Name LIMIT 200'),
    records(auth, 'SELECT Id, Subject, ActivityDate, CreatedDate, IsClosed, AccountId FROM Task WHERE AccountId != null AND (IsClosed = false OR CreatedDate = LAST_N_DAYS:60) ORDER BY CreatedDate DESC LIMIT 400'),
    records(auth, 'SELECT Id, Subject, StartDateTime, IsAllDayEvent, ActivityDate, AccountId FROM Event WHERE AccountId != null AND IsChild = false AND (ActivityDate = LAST_N_DAYS:60 OR ActivityDate = NEXT_N_DAYS:30) ORDER BY ActivityDate LIMIT 300'),
    records(auth, 'SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, AccountId FROM Case WHERE IsClosed = false ORDER BY CreatedDate DESC LIMIT 100'),
    records(auth, "SELECT Id, Name, Company, Status, Rating, LeadSource, CreatedDate FROM Lead WHERE IsConverted = false AND (Rating = null OR Rating != 'Cold') ORDER BY CreatedDate DESC LIMIT 50")
  ]);
  overviewCache = { at: Date.now(), data: { accounts, tasks, events, cases, leads } };
  return overviewCache.data;
}

async function salesforceClient(env, accountId) {
  const auth = await salesforce(env);
  const id = quote(accountId);
  const [accounts, tasks, events, cases, contacts, history] = await Promise.all([
    records(auth, 'SELECT Id, Name, Type, Website, Description, (SELECT Id, Name, StageName, CloseDate, NextStep, IsClosed, IsWon FROM Opportunities ORDER BY CloseDate) FROM Account WHERE Id = ' + id),
    records(auth, 'SELECT Id, Subject, ActivityDate, CreatedDate, IsClosed, AccountId FROM Task WHERE AccountId = ' + id + ' ORDER BY CreatedDate DESC LIMIT 300'),
    records(auth, 'SELECT Id, Subject, StartDateTime, IsAllDayEvent, ActivityDate, AccountId FROM Event WHERE AccountId = ' + id + ' AND IsChild = false ORDER BY ActivityDate DESC LIMIT 200'),
    records(auth, 'SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, ClosedDate, IsClosed, AccountId FROM Case WHERE AccountId = ' + id + ' ORDER BY CreatedDate DESC LIMIT 100'),
    records(auth, 'SELECT Id, Name, Title, Email, Phone FROM Contact WHERE AccountId = ' + id + ' ORDER BY Name LIMIT 100'),
    records(auth, "SELECT OpportunityId, Opportunity.Name, OldValue, NewValue, CreatedDate FROM OpportunityFieldHistory WHERE Field = 'StageName' AND Opportunity.AccountId = " + id + ' ORDER BY CreatedDate DESC LIMIT 100')
  ]);
  if (!accounts.length) throw new InputError('That client is not in Salesforce.', 404);
  return { account: accounts[0], tasks, events, cases, contacts, history };
}

// ---- Building the views (pure, so tests can check the rules) ----

export function localDay(value, timeZone = TIME_ZONE) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
export const addDays = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

// Every dated thing about a client becomes one timeline item: { day, at, type, title, detail, accountId, url, source, open, ... }.
function salesforceItems(env, { tasks = [], events = [], cases = [], history = [], accounts = [] }) {
  const items = [];
  for (const t of tasks) {
    const at = t.IsClosed ? (t.ActivityDate || t.CreatedDate) : (t.ActivityDate || null);
    if (!at) continue;
    const email = /^email:/i.test(t.Subject || '');
    items.push({ type: email ? 'email' : 'task', at, title: (t.Subject || 'Task').replace(/^email:\s*/i, ''), accountId: t.AccountId, url: sfLink(env, 'Task', t.Id), source: 'salesforce', open: !t.IsClosed, id: t.Id });
  }
  for (const e of events) items.push({ type: 'meeting', at: e.IsAllDayEvent ? e.ActivityDate : (e.StartDateTime || e.ActivityDate), title: e.Subject || 'Event', accountId: e.AccountId, url: sfLink(env, 'Event', e.Id), source: 'salesforce', id: e.Id });
  for (const c of cases) items.push({ type: 'case', at: c.CreatedDate, title: `Case ${c.CaseNumber}: ${c.Subject || ''}`.trim(), detail: [c.Status, c.Priority].filter(Boolean).join(' · '), accountId: c.AccountId, url: sfLink(env, 'Case', c.Id), source: 'salesforce', open: c.IsClosed !== true, id: c.Id });
  for (const h of history) items.push({ type: 'stage', at: h.CreatedDate, title: `${h.Opportunity?.Name || 'Opportunity'}: ${h.OldValue || '—'} → ${h.NewValue}`, url: sfLink(env, 'Opportunity', h.OpportunityId), source: 'salesforce' });
  for (const a of accounts) for (const o of a.Opportunities?.records || []) {
    if (!o.IsClosed && o.CloseDate) items.push({ type: 'close', at: o.CloseDate, title: o.Name, detail: 'Target close · ' + o.StageName, accountId: a.Id, url: sfLink(env, 'Opportunity', o.Id), source: 'salesforce', open: true, id: o.Id });
  }
  return items;
}

function localItems({ activity = [], notes = [], steps = [] }) {
  const items = [];
  for (const a of activity) items.push({ type: a.kind, at: a.occurred_at, title: a.title, detail: a.summary, accountId: a.account_id, url: a.url, source: 'sync', id: a.id });
  for (const n of notes) items.push({ type: 'note', at: n.created_at, title: n.body, accountId: n.account_id, source: 'you', id: n.id });
  for (const s of steps) {
    if (s.status === 'dismissed') continue;
    const at = s.status === 'done' ? s.done_at : s.due_date;
    if (!at) continue;
    items.push({ type: 'step', at, title: s.title, accountId: s.account_id, source: s.source, open: s.status === 'open', id: s.id });
  }
  return items;
}

const opportunityView = (env, o) => ({ id: o.Id, name: o.Name, stage: o.StageName, closeDate: o.CloseDate, nextStep: o.NextStep || '', open: !o.IsClosed, won: !!o.IsWon, url: sfLink(env, 'Opportunity', o.Id) });
const stepView = s => ({ id: s.id, accountId: s.account_id, title: s.title, dueDate: s.due_date, status: s.status, source: s.source });
// Things that count as being in touch: anything that already happened except a target close date.
const isTouch = item => !['close', 'stage'].includes(item.type) && !(item.type === 'step' && item.open) && !(item.type === 'task' && item.open);

// "Now": Eric's ranking rules, highest first. A rule returns a score and a one-line why, or null when it does not apply.
// Customer satisfaction first (missed commitments, due today, a client waiting), then leads that fit (Salesforce Rating:
// Hot = fits and high priority, Warm = fits; Cold never reaches here), then revenue dates, then quiet clients.
const daysBetween = (from, to) => Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / 86400e3);
function nowRule(i, today, now) {
  // A meeting that ended (started over an hour ago) no longer needs anything right now.
  if (i.type === 'meeting' && i.at?.length > 10 && Date.parse(i.at) < now - 3600e3) return null;
  const late = daysBetween(i.day, today);
  if (i.reason === 'Overdue step' || i.reason === 'Overdue Salesforce task') return { score: 100 + Math.min(late, 30), why: `Hard deadline missed ${late} day${late === 1 ? '' : 's'} ago` };
  if (i.type === 'meeting' && i.day === today) return { score: 95, why: 'Fixed time today' };
  if ((i.type === 'step' || i.type === 'task') && i.open && i.day === today) return { score: 90, why: 'Due today' };
  if (i.reason === 'Open support case') return { score: 80, why: 'A client is waiting on you' };
  if (i.type === 'lead') {
    if (i.rating === 'Hot') return { score: 78, why: 'Hot lead: fits Positive Tribes and is a high priority' };
    if (i.rating === 'Warm') return { score: 72, why: 'Warm lead: a good fit, follow up' };
    return { score: 66, why: 'Unrated lead: rate it in Salesforce (Hot, Warm or Cold)' };
  }
  if (i.reason === 'Past target close date') return { score: 62, why: 'Revenue: past its target close date' };
  if (i.type === 'close' && i.day >= today && daysBetween(today, i.day) <= 7) return { score: 55, why: `Revenue: closes ${daysBetween(today, i.day) === 0 ? 'today' : 'in ' + daysBetween(today, i.day) + ' days'}` };
  if (i.type === 'stale' && i.reason.includes('No next step')) return { score: 45, why: 'An active client with nothing queued, so it blocks progress' };
  if (i.type === 'stale') return { score: 30, why: 'An active client you have not touched lately' };
  return null;
}
export function rankNow(attention, upcoming, today, now = Date.now(), limit = 5) {
  const seen = new Set();
  return [...attention, ...upcoming]
    .map(i => ({ item: i, rule: nowRule(i, today, now) }))
    .filter(r => r.rule)
    .sort((a, b) => b.rule.score - a.rule.score || (a.item.day || '').localeCompare(b.item.day || '') || (a.item.title || '').localeCompare(b.item.title || ''))
    .filter(({ item }) => { const key = item.id ? item.type + item.id : item.type + item.title + item.accountId; return seen.has(key) ? false : (seen.add(key), true); })
    .slice(0, limit)
    .map(({ item, rule }) => ({ ...item, why: rule.why, score: rule.score }));
}

export function buildOverview(env, sf, local, today) {
  const meta = new Map(local.meta.map(m => [m.account_id, metaRow(m)]));
  const accounts = sf.accounts.filter(a => !meta.get(a.Id)?.hidden);
  const names = new Map(accounts.map(a => [a.Id, a.Name]));
  const items = [...salesforceItems(env, { ...sf, accounts }), ...localItems(local)]
    .filter(i => !i.accountId || names.has(i.accountId))
    .map(i => ({ ...i, day: localDay(i.at), client: names.get(i.accountId) || '' }));
  const soon = addDays(today, WINDOW_DAYS), since = addDays(today, -WINDOW_DAYS), staleBefore = addDays(today, -STALE_DAYS);

  const lastTouch = new Map();
  for (const i of items) if (isTouch(i) && i.day <= today && i.accountId && (lastTouch.get(i.accountId) || '') < i.day) lastTouch.set(i.accountId, i.day);
  const openSteps = local.steps.filter(s => s.status === 'open');

  const clients = accounts.map(a => {
    const opportunities = (a.Opportunities?.records || []).map(o => opportunityView(env, o));
    const steps = openSteps.filter(s => s.account_id === a.Id).sort((x, y) => (x.due_date || '9999').localeCompare(y.due_date || '9999'));
    const m = meta.get(a.Id) || metaRow(null);
    return {
      id: a.Id, name: a.Name, type: a.Type || '', website: a.Website || '', url: sfLink(env, 'Account', a.Id),
      opportunities, active: opportunities.some(o => o.open), lastTouch: lastTouch.get(a.Id) || null,
      nextStep: steps[0] ? stepView(steps[0]) : null, openSteps: steps.length, links: m.links, pinned: m.pinned
    };
  }).sort((x, y) => (y.pinned - x.pinned) || (y.active - x.active) || x.name.localeCompare(y.name));

  const attention = [];
  for (const i of items) {
    if (i.type === 'step' && i.open && i.day < today) attention.push({ reason: 'Overdue step', ...i });
    else if (i.type === 'task' && i.open && i.day < today) attention.push({ reason: 'Overdue Salesforce task', ...i });
    else if (i.type === 'close' && i.day < today) attention.push({ reason: 'Past target close date', ...i });
    else if (i.type === 'case' && i.open) attention.push({ reason: 'Open support case', ...i });
  }
  for (const c of clients) {
    if (!c.active) continue;
    // One entry per client, naming everything that is missing.
    const reasons = [];
    if (!c.lastTouch || c.lastTouch < staleBefore) reasons.push(c.lastTouch ? `No activity in ${STALE_DAYS}+ days` : 'No activity logged');
    if (!c.nextStep && !c.opportunities.some(o => o.open && o.nextStep)) reasons.push('No next step');
    if (reasons.length) attention.push({ reason: reasons.join(' · '), type: 'stale', title: c.name, accountId: c.id, day: c.lastTouch || '', url: c.url });
  }
  for (const l of sf.leads) attention.push({ reason: l.Rating ? `${l.Rating} lead` : 'Unrated lead', type: 'lead', rating: l.Rating || '', title: l.Company && l.Company !== '[not provided]' ? `${l.Name} (${l.Company})` : l.Name, detail: [l.LeadSource, l.Status].filter(Boolean).join(' · '), day: localDay(l.CreatedDate), url: sfLink(env, 'Lead', l.Id), source: 'salesforce' });

  // Today's items sit under "Coming up" with the rest of the next two weeks; "Recent" ends yesterday.
  const upcoming = items.filter(i => i.day >= today && i.day <= soon && i.open !== false && !['note', 'stage', 'email'].includes(i.type)).sort((x, y) => x.at.localeCompare(y.at));
  const recent = items.filter(i => isTouch(i) && i.day >= since && (i.day < today || ['note', 'email'].includes(i.type))).sort((x, y) => y.at.localeCompare(x.at));
  return { today, clients, attention, upcoming, recent, now: rankNow(attention, upcoming, today) };
}

export function buildClient(env, sf, local, today) {
  const m = metaRow(local.meta);
  const account = sf.account;
  const items = [...salesforceItems(env, { tasks: sf.tasks, events: sf.events, cases: sf.cases, history: sf.history, accounts: [account] }), ...localItems(local)]
    .map(i => ({ ...i, day: localDay(i.at) }))
    .map(i => ({ ...i, future: i.day > today || (i.day === today && i.open !== false && !['note', 'email', 'stage', 'case'].includes(i.type)) }))
    .sort((x, y) => y.at.localeCompare(x.at));
  return {
    today,
    client: {
      id: account.Id, name: account.Name, type: account.Type || '', website: account.Website || '', description: account.Description || '', url: sfLink(env, 'Account', account.Id),
      opportunities: (account.Opportunities?.records || []).map(o => opportunityView(env, o)),
      contacts: sf.contacts.map(c => ({ name: c.Name, title: c.Title || '', email: c.Email || '', phone: c.Phone || '', url: sfLink(env, 'Contact', c.Id) })),
      links: m.links, match: m.match, pinned: m.pinned, hidden: m.hidden
    },
    steps: local.steps.filter(s => s.status === 'open').map(stepView).sort((x, y) => (x.dueDate || '9999').localeCompare(y.dueDate || '9999')),
    future: items.filter(i => i.future).reverse(),
    past: items.filter(i => !i.future)
  };
}

// What the sync routine needs to put each email, meeting or event with the right client.
export function buildMatch(accounts, contacts, meta) {
  const metaMap = new Map(meta.map(m => [m.account_id, metaRow(m)]));
  return accounts.filter(a => !metaMap.get(a.Id)?.hidden).map(a => {
    const extra = metaMap.get(a.Id)?.match || {};
    const emails = new Set((extra.emails || []).map(e => e.toLowerCase()));
    const domains = new Set((extra.domains || []).map(d => d.toLowerCase()));
    const people = [];
    for (const c of contacts.filter(c => c.AccountId === a.Id)) {
      people.push(c.Name);
      if (!c.Email) continue;
      const email = c.Email.toLowerCase(), domain = email.split('@')[1];
      emails.add(email);
      // A contact linked from another account brings their address, not their employer's whole domain.
      if (domain && c.IsDirect !== false && !GENERIC_DOMAINS.includes(domain)) domains.add(domain);
    }
    if (a.Website) {
      try { const host = new URL(/^https?:/i.test(a.Website) ? a.Website : 'https://' + a.Website).hostname.replace(/^www\./, ''); if (host) domains.add(host); } catch {}
    }
    return { accountId: a.Id, name: a.Name, people, emails: [...emails], domains: [...domains], keywords: extra.keywords || [] };
  });
}

// ---- Backlog inbox ----

// Each client backlog is its own Worker with its own D1 database, bound here read-only by convention.
// Every add, edit and delete there is logged in backlog_events with the name the person typed.
export const BACKLOGS = [
  // Every client lives in Tribe Hub (one database for all of them); events are read from hub-db by client slug.
  // The -hub keys keep hub event ids apart from the old backlogs' cleared ids.
  { key: 'uep-hub', name: "Up ENDing Parkinson's", url: 'https://hub.positivetribes.org/#/uep/home', binding: 'HUB_DB', hub: 'uep', accountId: '001Pr00000yy8o9IAA' },
  { key: 'coyote-hub', name: 'Project Coyote', url: 'https://hub.positivetribes.org/#/coyote/home', binding: 'HUB_DB', hub: 'coyote', accountId: '001Pr00000yyAOXIA2' },
  { key: 'safe-hub', name: 'Sober AF', url: 'https://hub.positivetribes.org/#/safe/home', binding: 'HUB_DB', hub: 'safe', accountId: '001Pr00000yyXUuIAM' }
];
const INBOX_DAYS = 60;
// Eric's own edits are not news. Names are typed on the backlog page, so this matches the first word only.
const ownNamesOf = env => (env.BACKLOG_OWN_NAMES || 'eric').toLowerCase().split(/[\s,]+/).filter(Boolean);
const isOwn = (actor, own) => own.includes(String(actor || '').trim().split(/\s+/)[0].toLowerCase());

// A backlog that is not bound, not yet redeployed with its change log, or failing never hides the others.
async function backlogEvents(env, backlog, since) {
  const db = env[backlog.binding];
  if (!db) return { status: 'off', events: [] };
  try {
    const { results } = await db.prepare(
      `SELECT e.id, e.item_id, e.action, e.item_title, e.item_kind, e.detail, COALESCE(NULLIF(e.actor_name, ''), e.actor_email) AS actor, e.at
       FROM events e JOIN clients c ON c.id = e.client_id WHERE c.slug = ? AND e.at >= ? ORDER BY e.id`
    ).bind(backlog.hub, since).all();
    return { status: 'ok', events: results };
  } catch (error) {
    if (/no such table/i.test(error.message)) return { status: 'not_ready', events: [] };
    console.error('admin_backlog_failed', backlog.key, error.message);
    return { status: 'error', events: [] };
  }
}

// One row per backlog item: its latest unread event, carrying every unread event id so clearing the row clears them all.
export function buildInbox(backlogs, results, cleared, ownNames) {
  const done = new Set(cleared.map(c => c.backlog + ':' + c.event_id));
  const items = [];
  const summary = backlogs.map((b, n) => {
    const { status, events } = results[n];
    const rows = new Map();
    for (const e of events) {
      if (done.has(b.key + ':' + e.id) || isOwn(e.actor, ownNames)) continue;
      const earlier = rows.get(e.item_id);
      rows.set(e.item_id, {
        backlog: b.key, client: b.name, accountId: b.accountId, itemId: e.item_id,
        action: e.action, kind: e.item_kind, title: e.item_title, detail: e.detail, actor: e.actor,
        at: e.at.replace(' ', 'T') + (e.at.endsWith('Z') ? '' : 'Z'),
        url: e.action === 'deleted' || !e.item_id ? b.url : `https://hub.positivetribes.org/#/${b.hub}/backlog/${e.item_id}`,
        eventIds: [...earlier?.eventIds || [], e.id],
        // An item added and then changed before Eric looked still reads as new.
        added: earlier?.added || e.action === 'added'
      });
    }
    items.push(...rows.values());
    return { key: b.key, name: b.name, url: b.url, accountId: b.accountId, status, unread: rows.size };
  });
  return { backlogs: summary, items: items.sort((x, y) => y.at.localeCompare(x.at)) };
}

async function loadInbox(env, db, today) {
  const since = addDays(today, -INBOX_DAYS);
  const [cleared, ...results] = await Promise.all([
    db.prepare('SELECT backlog, event_id FROM backlog_cleared WHERE cleared_at >= ?').bind(since).all(),
    ...BACKLOGS.map(b => backlogEvents(env, b, since))
  ]);
  return buildInbox(BACKLOGS, results, cleared.results, ownNamesOf(env));
}

function clearInput(input) {
  const keys = BACKLOGS.map(b => b.key);
  const rows = list(input.items, 200, row => {
    if (!row || !keys.includes(row.backlog)) throw new InputError('Choose a backlog.');
    return { backlog: row.backlog, eventIds: list(row.eventIds, 500, id => {
      if (!Number.isSafeInteger(id) || id < 1) throw new InputError('Event ids must be whole numbers.');
      return id;
    }) };
  });
  const pairs = rows.flatMap(r => r.eventIds.map(id => [r.backlog, id]));
  if (pairs.length > 1000) throw new InputError('Clear at most 1000 events at a time.');
  return pairs;
}

// ---- Writes ----

async function saveActivity(db, input) {
  const items = list(input.items, 200, item => {
    if (!item || typeof item !== 'object') throw new InputError('Each item must be an object.');
    const externalId = text(item.external_id, 300, { required: true, label: 'external_id' });
    if (item.cancelled === true) return { externalId, cancelled: true };
    if (!ACTIVITY_KINDS.includes(item.kind)) throw new InputError('kind must be email, meeting or calendar.');
    return {
      externalId, accountId: accountIdOf(item.account_id), kind: item.kind, at: timeOf(item.occurred_at),
      title: text(item.title, 300, { required: true, label: 'title' }), summary: text(item.summary, 2000, { label: 'summary', multiline: true }), url: urlOf(item.url, 'url')
    };
  });
  const steps = list(input.steps, 50, step => {
    if (!step || typeof step !== 'object') throw new InputError('Each step must be an object.');
    return { accountId: accountIdOf(step.account_id), title: text(step.title, 300, { required: true, label: 'Step' }), due: dateOf(step.due_date, 'due_date'), externalId: text(step.external_id, 300, { required: true, label: 'external_id' }) };
  });
  const note = text(input.note, 1000, { label: 'note', multiline: true });
  const ids = [...items.map(i => i.externalId), ...steps.map(s => s.externalId)];
  const known = new Set();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const marks = chunk.map(() => '?').join(',');
    const found = await db.prepare(`SELECT external_id FROM activity WHERE external_id IN (${marks}) UNION SELECT external_id FROM next_steps WHERE external_id IN (${marks})`).bind(...chunk, ...chunk).all();
    for (const row of found.results) known.add(row.external_id);
  }
  const counts = { added: 0, updated: 0, removed: 0, steps: 0 };
  const statements = [];
  for (const i of items) {
    if (i.cancelled) { if (known.has(i.externalId)) { counts.removed++; statements.push(db.prepare('DELETE FROM activity WHERE external_id = ?').bind(i.externalId)); } continue; }
    counts[known.has(i.externalId) ? 'updated' : 'added']++;
    statements.push(db.prepare('INSERT INTO activity (account_id, kind, occurred_at, title, summary, url, external_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(external_id) DO UPDATE SET account_id = excluded.account_id, kind = excluded.kind, occurred_at = excluded.occurred_at, title = excluded.title, summary = excluded.summary, url = excluded.url')
      .bind(i.accountId, i.kind, i.at, i.title, i.summary, i.url, i.externalId));
  }
  // Suggested steps are added once. Dismissing one keeps its row, so the next run does not bring it back.
  for (const s of steps) {
    if (known.has(s.externalId)) continue;
    counts.steps++;
    statements.push(db.prepare("INSERT OR IGNORE INTO next_steps (account_id, title, due_date, source, external_id) VALUES (?, ?, ?, 'claude', ?)").bind(s.accountId, s.title, s.due, s.externalId));
  }
  statements.push(db.prepare('INSERT INTO sync_runs (added, updated, removed, steps, note) VALUES (?, ?, ?, ?, ?)').bind(counts.added, counts.updated, counts.removed, counts.steps, note));
  await db.batch(statements);
  return counts;
}

function metaInput(input) {
  const links = list(input.links, 20, link => ({ label: text(link?.label, 60, { required: true, label: 'Link name' }), url: urlOf(link?.url) }));
  const words = (value, label, pattern) => list(value, 50, v => {
    const result = text(v, 120, { required: true, label }).toLowerCase();
    if (pattern && !pattern.test(result)) throw new InputError(`${label} "${result}" does not look right.`);
    return result;
  });
  const match = input.match || {};
  return {
    links,
    match: { domains: words(match.domains, 'Domain', /^[a-z0-9.-]+\.[a-z]{2,}$/), emails: words(match.emails, 'Email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/), keywords: words(match.keywords, 'Keyword') },
    pinned: input.pinned ? 1 : 0, hidden: input.hidden ? 1 : 0
  };
}

// ---- Routes ----

const SERVICE_ROUTES = ['GET /api/admin/match', 'POST /api/admin/activity'];

export async function handleAdmin(request, env, url, who) {
  const method = request.method, path = url.pathname.replace(/\/+$/, '');
  const route = `${method} ${path}`;
  // The sync routine's service token can only read match rules and post activity.
  if (who.service && !SERVICE_ROUTES.includes(route)) return json({ error: 'Not allowed.' }, 403);
  // Browser writes must come from this site (a JSON body is also required, which plain forms cannot send).
  if (!who.service && method !== 'GET' && request.headers.get('Origin') !== url.origin) return json({ error: 'Not allowed.' }, 403);
  if (!env.ADMIN_DB) return json({ error: 'The admin database is not connected.' }, 503);
  const db = env.ADMIN_DB;
  try {
    await ensureSchema(db);
    const today = localDay(Date.now());

    if (route === 'GET /api/admin/overview') {
      const [meta, steps, notes, activity, lastSync, inbox] = await Promise.all([
        db.prepare('SELECT * FROM client_meta').all(),
        db.prepare("SELECT * FROM next_steps WHERE status = 'open' OR done_at >= ?").bind(addDays(today, -60)).all(),
        db.prepare('SELECT * FROM notes WHERE created_at >= ?').bind(addDays(today, -60)).all(),
        db.prepare('SELECT * FROM activity WHERE occurred_at >= ? ORDER BY occurred_at').bind(addDays(today, -60)).all(),
        db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').first(),
        loadInbox(env, db, today)
      ]);
      let sf = { accounts: [], tasks: [], events: [], cases: [], leads: [] }, salesforceStatus = 'off';
      if (salesforceReady(env)) {
        try { sf = await salesforceOverview(env, url.searchParams.get('refresh') === '1'); salesforceStatus = 'ok'; }
        catch (error) { console.error('admin_salesforce_failed', error.message); salesforceStatus = 'error'; }
      }
      const view = buildOverview(env, sf,{ meta: meta.results, steps: steps.results, notes: notes.results, activity: activity.results }, today);
      return json({ ...view, salesforce: salesforceStatus, lastSync: lastSync || null, inboxCount: inbox.items.length, user: who.email });
    }

    if (route === 'GET /api/admin/inbox') return json(await loadInbox(env, db, today));
    if (route === 'POST /api/admin/inbox/clear') {
      const pairs = clearInput(await body(request));
      if (pairs.length) await db.batch(pairs.map(([backlog, id]) => db.prepare('INSERT OR IGNORE INTO backlog_cleared (backlog, event_id) VALUES (?, ?)').bind(backlog, id)));
      return json({ ok: true, cleared: pairs.length });
    }

    const client = path.match(/^\/api\/admin\/clients\/([^/]+)(\/meta)?$/);
    if (client && method === 'GET' && !client[2]) {
      const accountId = accountIdOf(client[1]);
      if (!salesforceReady(env)) return json({ error: 'Salesforce is not connected.' }, 503);
      const [sf, meta, steps, notes, activity] = await Promise.all([
        salesforceClient(env, accountId),
        db.prepare('SELECT * FROM client_meta WHERE account_id = ?').bind(accountId).first(),
        db.prepare('SELECT * FROM next_steps WHERE account_id = ?').bind(accountId).all(),
        db.prepare('SELECT * FROM notes WHERE account_id = ?').bind(accountId).all(),
        db.prepare('SELECT * FROM activity WHERE account_id = ?').bind(accountId).all()
      ]);
      return json(buildClient(env, sf, { meta, steps: steps.results, notes: notes.results, activity: activity.results }, today));
    }
    if (client && method === 'PUT' && client[2]) {
      const accountId = accountIdOf(client[1]);
      const m = metaInput(await body(request));
      await db.prepare('INSERT INTO client_meta (account_id, links_json, match_json, pinned, hidden) VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET links_json = excluded.links_json, match_json = excluded.match_json, pinned = excluded.pinned, hidden = excluded.hidden')
        .bind(accountId, JSON.stringify(m.links), JSON.stringify(m.match), m.pinned, m.hidden).run();
      overviewCache.at = 0;
      return json({ ok: true });
    }

    if (route === 'POST /api/admin/notes') {
      const input = await body(request);
      const accountId = accountIdOf(input.accountId);
      const note = text(input.body, 4000, { required: true, label: 'Note', multiline: true });
      const { meta } = await db.prepare('INSERT INTO notes (account_id, body, created_by) VALUES (?, ?, ?)').bind(accountId, note, who.email || '').run();
      return json({ ok: true, id: meta.last_row_id }, 201);
    }
    const noteId = path.match(/^\/api\/admin\/notes\/(\d+)$/);
    if (noteId && method === 'DELETE') {
      await db.prepare('DELETE FROM notes WHERE id = ?').bind(Number(noteId[1])).run();
      return json({ ok: true });
    }

    if (route === 'POST /api/admin/steps') {
      const input = await body(request);
      const accountId = accountIdOf(input.accountId);
      const title = text(input.title, 300, { required: true, label: 'Step' });
      const { meta } = await db.prepare('INSERT INTO next_steps (account_id, title, due_date) VALUES (?, ?, ?)').bind(accountId, title, dateOf(input.dueDate, 'Due date')).run();
      return json({ ok: true, id: meta.last_row_id }, 201);
    }
    const stepId = path.match(/^\/api\/admin\/steps\/(\d+)$/);
    if (stepId && method === 'PATCH') {
      const id = Number(stepId[1]);
      const step = await db.prepare('SELECT * FROM next_steps WHERE id = ?').bind(id).first();
      if (!step) throw new InputError('That step no longer exists.', 404);
      const input = await body(request);
      const title = 'title' in input ? text(input.title, 300, { required: true, label: 'Step' }) : step.title;
      const due = 'dueDate' in input ? dateOf(input.dueDate, 'Due date') : step.due_date;
      let status = step.status;
      if ('status' in input) {
        if (!STEP_STATUSES.includes(input.status)) throw new InputError('Choose open, done or dismissed.');
        status = input.status;
      }
      const doneAt = status === 'done' ? (step.status === 'done' ? step.done_at : new Date().toISOString()) : null;
      // Editing or keeping a suggestion makes it Eric's own step.
      const source = 'title' in input || 'dueDate' in input || input.keep === true ? 'you' : step.source;
      await db.prepare('UPDATE next_steps SET title = ?, due_date = ?, status = ?, done_at = ?, source = ? WHERE id = ?').bind(title, due, status, doneAt, source, id).run();
      return json({ ok: true });
    }

    if (route === 'GET /api/admin/match') {
      if (!salesforceReady(env)) return json({ error: 'Salesforce is not connected.' }, 503);
      const auth = await salesforce(env);
      // AccountContactRelation covers each contact's own account plus any other accounts they are linked to.
      const [accounts, relations, meta, lastSync] = await Promise.all([
        records(auth, 'SELECT Id, Name, Website FROM Account WHERE IsPersonAccount = false AND Name != ' + quote(OWN_ACCOUNT) + ' ORDER BY Name LIMIT 200'),
        records(auth, 'SELECT AccountId, IsDirect, Contact.Name, Contact.Email FROM AccountContactRelation WHERE IsActive = true AND Account.IsPersonAccount = false LIMIT 2000'),
        db.prepare('SELECT * FROM client_meta').all(),
        db.prepare('SELECT ran_at FROM sync_runs ORDER BY id DESC LIMIT 1').first()
      ]);
      const contacts = relations.map(r => ({ AccountId: r.AccountId, IsDirect: r.IsDirect, Name: r.Contact?.Name, Email: r.Contact?.Email }));
      return json({ today, timeZone: TIME_ZONE, lastSync: lastSync?.ran_at || null, clients: buildMatch(accounts, contacts, meta.results) });
    }
    if (route === 'POST /api/admin/activity') {
      return json({ ok: true, ...await saveActivity(db, await body(request)) });
    }
    return json({ error: 'Not found.' }, 404);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, error.status);
    console.error('admin_failed', route, error.message);
    return json({ error: 'Something went wrong. Please try again.' }, 500);
  }
}
