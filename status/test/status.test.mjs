import { test } from "node:test";
import assert from "node:assert/strict";
import { probe, handle, runChecks, esc } from "../src/index.js";

// Minimal in-memory D1 stand-in covering the three statements the Worker uses.
function fakeDb() {
  const rows = [];
  const stmt = (sql) => ({
    args: [],
    bind(...a) { this.args = a; return this; },
    async all() {
      const [client, check, since] = this.args;
      return { results: rows.filter((r) => r.client === client && r.check_id === check && r.ts >= since).sort((a, b) => a.ts - b.ts) };
    },
    run() {
      if (sql.startsWith("INSERT")) { const [client, check_id, ts, ok, ms] = this.args; rows.push({ client, check_id, ts, ok, ms }); }
      else if (sql.startsWith("DELETE")) { const [cut] = this.args; for (let i = rows.length - 1; i >= 0; i--) if (rows[i].ts < cut) rows.splice(i, 1); }
    },
  });
  return { rows, prepare: stmt, async batch(list) { list.forEach((s) => s.run()); } };
}
const res = (status, body) => async () => new Response(body, { status });
const check = { url: "https://x.test/h", keyword: '"database":"ready"' };

test("probe: up only on 2xx with keyword", async () => {
  assert.equal((await probe(check, res(200, '"database":"ready"'))).ok, 1);
  assert.equal((await probe(check, res(200, '"database":"down"'))).ok, 0);
  assert.equal((await probe(check, res(500, '"database":"ready"'))).ok, 0);
  assert.equal((await probe(check, async () => { throw new Error("net"); })).ok, 0);
});

test("page: unknown slug 404, public page hides URL, shows up", async () => {
  const env = { DB: fakeDb() };
  assert.equal((await handle(new Request("https://s.test/nope"), env, 1000000)).status, 404);
  assert.equal((await handle(new Request("https://s.test/__proto__"), env, 1000000)).status, 404);
  assert.equal((await handle(new Request("https://s.test/uep", { method: "POST" }), env, 1000000)).status, 405);
  const now = 1_800_000_000;
  await runChecks(env, now, res(200, '{"ok":true,"database":"ready"}'));
  const html = await (await handle(new Request("https://s.test/uep/"), env, now + 30)).text();
  assert.match(html, /All systems running/);
  assert.doesNotMatch(html, /workers\.dev/);
});

test("page: down and stale states", async () => {
  const env = { DB: fakeDb() };
  const now = 1_800_000_000;
  await runChecks(env, now, res(500, "err"));
  assert.match(await (await handle(new Request("https://s.test/uep"), env, now + 30)).text(), /having problems/);
  assert.match(await (await handle(new Request("https://s.test/uep"), env, now + 3600)).text(), /unavailable/);
});

test("esc escapes html", () => assert.equal(esc(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;"));
