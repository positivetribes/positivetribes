import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { dumpDatabase, sqlLiteral, gzip, gunzip, encrypt, decrypt } from "../src/dump.js";
import { runBackups, handle } from "../src/index.js";

const KEY = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");

// A D1 stand-in over a real in-memory SQLite, so the dump is tested against the real SQL dialect.
function d1(sqlite) {
  return { prepare: (sql) => ({ async all() { return { results: sqlite.prepare(sql).all().map((r) => ({ ...r })) }; } }) };
}
function seeded() {
  const s = new DatabaseSync(":memory:");
  s.exec(`
    CREATE TABLE clients (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE items (id INTEGER PRIMARY KEY AUTOINCREMENT, client_id INTEGER NOT NULL REFERENCES clients(id), title TEXT, done INTEGER, note BLOB, score REAL);
    CREATE INDEX idx_items_client ON items (client_id);
    CREATE TABLE "odd name" (a TEXT);
    CREATE TABLE _cf_KV (k TEXT);
    INSERT INTO _cf_KV VALUES ('skip me');
  `);
  s.prepare("INSERT INTO clients VALUES (?, ?)").run(1, "Up ENDing Parkinson's");
  s.prepare("INSERT INTO items (client_id, title, done, note, score) VALUES (?,?,?,?,?)").run(1, "it's \"quoted\"\nnew line; DROP TABLE x;--", 0, new Uint8Array([0, 255, 16]), 1.5);
  s.prepare("INSERT INTO items (client_id, title, done, note, score) VALUES (?,?,?,?,?)").run(1, null, 1, null, null);
  s.prepare('INSERT INTO "odd name" VALUES (?)').run("x");
  return s;
}
const rows = (s, t) => s.prepare(`SELECT * FROM "${t}" ORDER BY 1`).all();

test("sqlLiteral escapes quotes and encodes blobs", () => {
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral(null), "NULL");
  assert.equal(sqlLiteral([0, 255, 16]), "X'00ff10'");
  assert.equal(sqlLiteral(NaN), "NULL");
});

test("restore drill: dump, gzip, encrypt, decrypt, load into a fresh database, rows identical", async () => {
  const src = seeded();
  const { sql, tables, rows: n } = await dumpDatabase(d1(src));
  assert.equal(tables, 3); // _cf_ internal table skipped
  assert.equal(n, 4);
  assert.ok(!sql.includes("skip me"));
  const back = new TextDecoder().decode(await gunzip(await decrypt(await encrypt(await gzip(new TextEncoder().encode(sql)), KEY), KEY)));
  assert.equal(back, sql);
  const fresh = new DatabaseSync(":memory:");
  fresh.exec(back);
  for (const t of ["clients", "items", "odd name"]) assert.deepEqual(rows(fresh, t), rows(src, t), t);
  assert.ok(fresh.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_items_client'").get()); // index restored
});

test("encryption: wrong key and tampering fail, output is not plaintext", async () => {
  const data = new TextEncoder().encode("secret climber data");
  const enc = await encrypt(data, KEY);
  assert.ok(!Buffer.from(enc).includes("secret"));
  const other = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  await assert.rejects(decrypt(enc, other));
  enc[enc.length - 1] ^= 1;
  await assert.rejects(decrypt(enc, KEY));
  await assert.rejects(encrypt(data, Buffer.from("short").toString("base64")), /32 bytes/);
});

// Minimal R2 stand-in.
function fakeR2() {
  const m = new Map();
  return {
    m,
    async put(k, v) { m.set(k, v); },
    async get(k) { return m.has(k) ? { json: async () => JSON.parse(m.get(k)) } : null; },
    async list({ prefix }) { return { objects: [...m.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }; },
    async delete(keys) { for (const k of [].concat(keys)) m.delete(k); },
  };
}
const DAY = 86400000;
const NOW = Date.UTC(2026, 10, 8, 8, 0, 0);
const envWith = (r2) => ({ BACKUPS: r2, BACKUP_KEY: KEY, HUB_DB: d1(seeded()), ADMIN_DB: d1(seeded()), UEP_SCHEDULER_DB: d1(seeded()) });
const get = (env, path, now) => handle(new Request("https://backup.test" + path), env, now);

test("runBackups writes encrypted files, latest.json, and prunes old ones", async () => {
  const r2 = fakeR2();
  r2.m.set("hub/2026-09-01.sql.gz.enc", "old");
  r2.m.set("hub/2026-10-20.sql.gz.enc", "recent");
  const res = await runBackups(envWith(r2), NOW);
  assert.equal(res.hub.ok, true);
  assert.ok(r2.m.has("hub/2026-11-08.sql.gz.enc") && r2.m.has("admin/2026-11-08.sql.gz.enc"));
  assert.ok(!r2.m.has("hub/2026-09-01.sql.gz.enc"), "older than 30 days is deleted");
  assert.ok(r2.m.has("hub/2026-10-20.sql.gz.enc"));
  assert.ok(r2.m.has("hub/latest.json"));
});

test("a failing database leaves its latest.json alone and doesn't stop the others", async () => {
  const r2 = fakeR2();
  const env = envWith(r2);
  env.HUB_DB = { prepare() { throw new Error("boom"); } };
  const res = await runBackups(env, NOW);
  assert.equal(res.hub.ok, false);
  assert.equal(res.admin.ok, true);
  assert.ok(!r2.m.has("hub/latest.json"));
});

test("health: ok when fresh, 503 stale when old or never run, 404 for unknown", async () => {
  const r2 = fakeR2();
  const env = envWith(r2);
  let res = await get(env, "/health/uep", NOW);
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { backup: "stale", age_hours: null });
  await runBackups(env, NOW);
  res = await get(env, "/health/uep", NOW + 3 * 3600000);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { backup: "ok", age_hours: 3 });
  res = await get(env, "/health/uep", NOW + 27 * 3600000);
  assert.equal(res.status, 503);
  assert.equal((await res.json()).backup, "stale");
  assert.equal((await get(env, "/health/nobody", NOW)).status, 404);
  assert.equal((await get(env, "/health/uep/../x", NOW)).status, 404);
  assert.equal((await handle(new Request("https://backup.test/health/uep", { method: "POST" }), env, NOW)).status, 404);
});

test("health body exposes nothing beyond ok/stale and age", async () => {
  const r2 = fakeR2();
  const env = envWith(r2);
  await runBackups(env, NOW);
  const text = await (await get(env, "/health/uep", NOW)).text();
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ["age_hours", "backup"]);
});

test("a client's row is stale if any one of its databases is missing a fresh backup", async () => {
  const r2 = fakeR2();
  const env = envWith(r2);
  env.UEP_SCHEDULER_DB = { prepare() { throw new Error("boom"); } };
  await runBackups(env, NOW);
  const res = await get(env, "/health/uep", NOW + 3600000);
  assert.equal(res.status, 503);
});
