import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { database } from "../../hub/test/helpers.mjs";
import { runChecks } from "../src/index.js";
import { trackIncidents, closedSince, coverage } from "../src/incidents.js";

function env() {
  const { sqlite, db } = database();
  for (const f of ["0001_checks.sql", "0002_incidents.sql"]) sqlite.exec(readFileSync(new URL("../migrations/" + f, import.meta.url), "utf8"));
  const sent = [];
  return { sent, env: { DB: db, ALERT_TO: "eric@example.org", ALERT_MAIL: { send: async (m) => { sent.push(m); } } } };
}
const res = (status, body) => async () => new Response(body, { status });
const UP = res(200, '{"database":"ready","backup":"ok"}');
const DOWN = res(500, "err");
const T = 1_795_550_000; // Tue 2026-11-24, about 12:53pm MT

async function minute(e, n, fetchImpl) {
  const now = T + n * 60;
  return trackIncidents(e, await runChecks(e, now, fetchImpl), now);
}

test("one failed probe is not an outage; two in a row open one and email once", async () => {
  const { env: e, sent } = env();
  await minute(e, 0, UP);
  assert.deepEqual(await minute(e, 1, DOWN), { opened: 0, closed: 0 });
  assert.equal(sent.length, 0);
  assert.deepEqual(await minute(e, 2, DOWN), { opened: 2, closed: 0 }); // both UEP checks failed
  assert.equal(sent.length, 2);
  assert.match(sent[0].subject, /^DOWN: Up ENDing Parkinson's, Climb Scheduler$/);
  assert.match(sent[0].text, /start work by Tue, Nov 24, 4:5\dpm MT/);
  assert.doesNotMatch(sent[0].text, /workers\.dev/);
  await minute(e, 3, DOWN);
  assert.equal(sent.length, 2, "no repeat email while it stays down");
});

test("recovery closes the incident, emails, and the hub can read it", async () => {
  const { env: e, sent } = env();
  await minute(e, 0, DOWN); await minute(e, 1, DOWN);
  assert.deepEqual(await minute(e, 31, UP), { opened: 0, closed: 2 });
  assert.match(sent[2].subject, /^Back up: /);
  assert.match(sent[2].text, /after 31 minutes/);
  assert.match(sent[2].text, /note in the client's hub by Thu, Nov 26/);
  const closed = await closedSince(e, T);
  assert.equal(closed.length, 2);
  assert.equal(closed[0].clientName, "Up ENDing Parkinson's");
  assert.equal(closed[0].started, T);
  assert.doesNotMatch(JSON.stringify(closed), /https?:/);
  assert.equal((await closedSince(e, T + 99999)).length, 0);
});

test("a failed alert email never stops tracking", async () => {
  const { env: e } = env();
  e.ALERT_MAIL = { send: async () => { throw new Error("not verified"); } };
  await minute(e, 0, DOWN);
  assert.deepEqual(await minute(e, 1, DOWN), { opened: 2, closed: 0 });
});

test("coverage lists each client and its check count", () => assert.deepEqual(coverage(), { uep: 2 }));
