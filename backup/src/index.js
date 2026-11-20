import { DATABASES, CLIENT_CHECKS, KEEP_DAYS, STALE_HOURS } from "./config.js";
import { dumpDatabase, gzip, encrypt } from "./dump.js";

const HOUR = 3600 * 1000;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// Back up every configured database. One failing database doesn't stop the others, and a failure leaves
// latest.json alone, so the health check goes stale and the client's status row turns red.
export async function runBackups(env, now = Date.now()) {
  const results = {};
  for (const [id, cfg] of Object.entries(DATABASES)) {
    try {
      const { sql, tables, rows } = await dumpDatabase(env[cfg.binding]);
      const body = await encrypt(await gzip(new TextEncoder().encode(sql)), env.BACKUP_KEY);
      const key = `${id}/${dayOf(now)}.sql.gz.enc`;
      await env.BACKUPS.put(key, body, { httpMetadata: { contentType: "application/octet-stream" } });
      await env.BACKUPS.put(`${id}/latest.json`, JSON.stringify({ ok_at: now, key, bytes: body.length, tables, rows }));
      await prune(env, id, now);
      results[id] = { ok: true, tables, rows, bytes: body.length };
    } catch (e) {
      // Log which database and the error type only: error text could include row data.
      console.error(`backup failed for ${id}: ${e && e.name}`);
      results[id] = { ok: false };
    }
  }
  return results;
}

async function prune(env, id, now) {
  const cutoff = dayOf(now - KEEP_DAYS * 24 * HOUR);
  const { objects } = await env.BACKUPS.list({ prefix: id + "/" });
  const old = objects.map((o) => o.key).filter((k) => /\/\d{4}-\d{2}-\d{2}\.sql\.gz\.enc$/.test(k) && k.split("/")[1].slice(0, 10) < cutoff);
  if (old.length) await env.BACKUPS.delete(old);
}

async function age(env, id, now) {
  const obj = await env.BACKUPS.get(`${id}/latest.json`);
  if (!obj) return null;
  const { ok_at } = await obj.json();
  return typeof ok_at === "number" ? (now - ok_at) / HOUR : null;
}

const HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

// Public, read-only. Says only whether a client's backups are fresh: no names, sizes, counts or data.
export async function handle(request, env, now = Date.now()) {
  const m = new URL(request.url).pathname.match(/^\/health\/([a-z0-9-]+)$/);
  if (request.method !== "GET" || !m || !Object.hasOwn(CLIENT_CHECKS, m[1])) {
    return new Response("Not found", { status: 404, headers: { "content-type": "text/plain", "x-content-type-options": "nosniff" } });
  }
  const ages = await Promise.all(CLIENT_CHECKS[m[1]].map((id) => age(env, id, now)));
  const worst = ages.some((a) => a === null) ? null : Math.max(...ages);
  const ok = worst !== null && worst <= STALE_HOURS;
  const body = { backup: ok ? "ok" : "stale", age_hours: worst === null ? null : Math.round(worst) };
  return new Response(JSON.stringify(body), { status: ok ? 200 : 503, headers: HEADERS });
}

// Healthchecks.io dead-man switch (check "Tribe backup"): ping on a full success, /fail if any database failed.
// A missed run sends nothing, which Healthchecks also alerts on. The URL is the secret HC_PING_URL; without it
// this does nothing. The body names only failed database ids, never data. A ping error never fails the backup.
export async function heartbeat(env, results, fetchFn = fetch) {
  const url = env.HC_PING_URL;
  if (!url || !/^https:\/\//.test(url)) return;
  const failed = Object.keys(results).filter((id) => !results[id].ok);
  try {
    await fetchFn(failed.length ? `${url.replace(/\/$/, "")}/fail` : url, {
      method: "POST",
      body: failed.length ? `failed: ${failed.join(", ")}` : `ok: ${Object.keys(results).length} databases`,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    console.error(`healthchecks ping failed: ${e && e.name}`);
  }
}

export default {
  fetch: (request, env) => handle(request, env),
  async scheduled(_event, env, ctx) { ctx.waitUntil(runBackups(env).then((r) => heartbeat(env, r))); },
};
