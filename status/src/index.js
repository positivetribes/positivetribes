import { CLIENTS } from "./config.js";

const DAY = 86400;
const DAYS_SHOWN = 90;
const KEEP_DAYS = 100;
const TIMEOUT_MS = 10000;
// A check is "stale" (shown as unknown, not up) if no result in this long.
const STALE_SECS = 300;

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export async function probe(check, fetchImpl = fetch) {
  const started = Date.now();
  try {
    const res = await fetchImpl(check.url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "user-agent": "PositiveTribesStatus/1.0" },
    });
    let ok = res.status >= 200 && res.status < 300;
    if (ok && check.keyword) ok = (await res.text()).includes(check.keyword);
    return { ok: ok ? 1 : 0, ms: Date.now() - started };
  } catch {
    return { ok: 0, ms: Date.now() - started };
  }
}

export async function runChecks(env, now = Math.floor(Date.now() / 1000), fetchImpl = fetch) {
  const jobs = [];
  for (const [client, cfg] of Object.entries(CLIENTS)) {
    for (const check of cfg.checks) jobs.push({ client, check });
  }
  const results = await Promise.all(jobs.map(async (j) => ({ ...j, r: await probe(j.check, fetchImpl) })));
  const stmts = results.map(({ client, check, r }) =>
    env.DB.prepare("INSERT OR REPLACE INTO check_results (client, check_id, ts, ok, ms) VALUES (?, ?, ?, ?, ?)").bind(client, check.id, now, r.ok, r.ms),
  );
  stmts.push(env.DB.prepare("DELETE FROM check_results WHERE ts < ?").bind(now - KEEP_DAYS * DAY));
  await env.DB.batch(stmts);
}

async function loadCheck(env, client, checkId, now) {
  const since = now - DAYS_SHOWN * DAY;
  const { results } = await env.DB.prepare(
    "SELECT ts, ok FROM check_results WHERE client = ? AND check_id = ? AND ts >= ? ORDER BY ts",
  ).bind(client, checkId, since).all();
  const days = new Map(); // day index -> {up, total}
  for (const row of results) {
    const d = Math.floor(row.ts / DAY);
    const e = days.get(d) || { up: 0, total: 0 };
    e.total += 1;
    e.up += row.ok ? 1 : 0;
    days.set(d, e);
  }
  const last = results[results.length - 1];
  const state = !last || now - last.ts > STALE_SECS ? "unknown" : last.ok ? "up" : "down";
  const up = results.filter((r) => r.ok).length;
  return { days, state, pct: results.length ? (up / results.length) * 100 : null };
}

function renderPage(slug, cfg, data, now) {
  const todayIdx = Math.floor(now / DAY);
  const states = data.map((d) => d.state);
  const overall = states.includes("down") ? "down" : states.includes("unknown") ? "unknown" : "up";
  const headline = { up: "All systems running", down: "A system is having problems", unknown: "Status unavailable right now" }[overall];
  const rows = cfg.checks.map((c, i) => {
    const d = data[i];
    const bars = [];
    for (let k = DAYS_SHOWN - 1; k >= 0; k--) {
      const e = d.days.get(todayIdx - k);
      const cls = !e ? "none" : e.up === e.total ? "up" : e.up / e.total >= 0.99 ? "warn" : "down";
      const label = new Date((todayIdx - k) * DAY * 1000).toISOString().slice(0, 10) + (e ? `: ${((e.up / e.total) * 100).toFixed(1)}% up` : ": no data");
      bars.push(`<i class="${cls}" title="${esc(label)}"></i>`);
    }
    const pct = d.pct === null ? "no data yet" : `${d.pct.toFixed(2)}% up, last ${DAYS_SHOWN} days`;
    return `<section><div class="row"><h2>${esc(c.name)}</h2><span class="pill ${d.state}">${{ up: "Up", down: "Down", unknown: "Unknown" }[d.state]}</span></div><div class="bars" role="img" aria-label="${esc(c.name)} daily uptime">${bars.join("")}</div><p class="meta">${esc(pct)}</p></section>`;
  });
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta http-equiv="refresh" content="60"><title>${esc(cfg.name)} status</title><style>
:root{--bg:#fff;--fg:#1d2433;--mut:#5b6577;--card:#f4f6f9;--up:#2e9e5b;--warn:#d9a21b;--down:#d64545;--none:#d5d9e0}
@media(prefers-color-scheme:dark){:root{--bg:#10141c;--fg:#e8ecf3;--mut:#9aa5b8;--card:#1a202b;--none:#303846}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px}h1{font-size:1.4rem;margin:0 0 4px}
.banner{margin:16px 0 24px;padding:16px;border-radius:12px;font-weight:600;color:#fff;background:var(--${overall === "unknown" ? "none" : overall})}
.banner{${overall === "unknown" ? "color:var(--fg)" : ""}}
section{background:var(--card);border-radius:12px;padding:16px;margin-bottom:16px}
.row{display:flex;justify-content:space-between;align-items:center;gap:8px}h2{font-size:1.05rem;margin:0}
.pill{font-size:.8rem;font-weight:600;padding:2px 10px;border-radius:99px;color:#fff}.pill.up{background:var(--up)}.pill.down{background:var(--down)}.pill.unknown{background:var(--none);color:var(--fg)}
.bars{display:flex;gap:2px;height:32px;margin:12px 0 6px}.bars i{flex:1;border-radius:2px;background:var(--none)}.bars i.up{background:var(--up)}.bars i.warn{background:var(--warn)}.bars i.down{background:var(--down)}
.meta,footer{color:var(--mut);font-size:.85rem;margin:0}</style></head><body><main><h1>${esc(cfg.name)}</h1><div class="banner">${headline}</div>${rows.join("")}<footer>Checked every minute. Updated ${new Date(now * 1000).toUTCString()}. Run by <a href="https://positivetribes.org" style="color:inherit">Positive Tribes</a>.</footer></main></body></html>`;
}

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, max-age=30",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

export async function handle(request, env, now = Math.floor(Date.now() / 1000)) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  const slug = new URL(request.url).pathname.replace(/^\/+|\/+$/g, "");
  if (!Object.prototype.hasOwnProperty.call(CLIENTS, slug)) return new Response("Not found", { status: 404, headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" } });
  const cfg = CLIENTS[slug];
  const data = await Promise.all(cfg.checks.map((c) => loadCheck(env, slug, c.id, now)));
  return new Response(renderPage(slug, cfg, data, now), { headers: HEADERS });
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: (_event, env, ctx) => ctx.waitUntil(runChecks(env)),
};
