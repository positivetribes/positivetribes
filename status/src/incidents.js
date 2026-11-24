// Outages: a check that fails twice in a row (2 minutes) opens an incident and emails Eric at once; the first passing
// probe after that closes it and emails again. The hub reads closed incidents over the `Incidents` RPC entrypoint
// (src/worker.js) and turns each into a Salesforce Task for the after-outage note. Policy: kits/proposal-care-plan.md.
import { addBusinessHours, formatMT, SUPPORT } from "../../hub/src/businesshours.js";
import { CLIENTS } from "./config.js";

const CONFIRM = 2; // failed probes in a row before it counts as an outage
const FROM = "hello@positivetribes.org";

const nameOf = (client, checkId) => {
  const c = CLIENTS[client];
  const check = c && c.checks.find((k) => k.id === checkId);
  return { client: c ? c.name : client, check: check ? check.name : checkId };
};
const minutes = (secs) => {
  const m = Math.max(1, Math.round(secs / 60));
  return m < 120 ? `${m} minute${m === 1 ? "" : "s"}` : `${Math.round(m / 6) / 10} hours`;
};

async function alert(env, subject, text) {
  if (!env.ALERT_MAIL || !env.ALERT_TO) { console.error("incident_alert_off", subject); return false; }
  try {
    await env.ALERT_MAIL.send({ from: FROM, to: env.ALERT_TO, subject, text });
    return true;
  } catch (error) {
    console.error("incident_alert_failed", error.message);
    return false;
  }
}

// results: [{ client, check: { id }, r: { ok } }] from runChecks; now in unix seconds.
export async function trackIncidents(env, results, now) {
  const open = new Map(
    (await env.DB.prepare("SELECT id, client, check_id, started FROM incidents WHERE ended IS NULL").all()).results
      .map((i) => [i.client + "/" + i.check_id, i]),
  );
  const out = { opened: 0, closed: 0 };
  for (const { client, check, r } of results) {
    const key = client + "/" + check.id;
    const incident = open.get(key);
    const names = nameOf(client, check.id);
    if (r.ok && incident) {
      await env.DB.prepare("UPDATE incidents SET ended = ? WHERE id = ?").bind(now, incident.id).run();
      out.closed++;
      const noteBy = formatMT(addBusinessHours(now * 1000, SUPPORT.noteHours));
      await alert(env, `Back up: ${names.client}, ${names.check}`,
        `${names.check} (${names.client}) is passing its check again after ${minutes(now - incident.started)} (down since ${formatMT(incident.started * 1000)}).\n\n` +
        `Next: post a short note in the client's hub by ${noteBy}: what happened, how it was fixed, what changed. ` +
        `The hub adds a Salesforce Task for it within the hour.\n\nStatus page: https://status.positivetribes.org/${client}`);
    } else if (!r.ok && !incident) {
      const { results: last } = await env.DB.prepare(
        "SELECT ts, ok FROM check_results WHERE client = ? AND check_id = ? ORDER BY ts DESC LIMIT ?",
      ).bind(client, check.id, CONFIRM).all();
      if (last.length < CONFIRM || last.some((x) => x.ok)) continue;
      const started = last[last.length - 1].ts;
      await env.DB.prepare("INSERT INTO incidents (client, check_id, started) VALUES (?, ?, ?)").bind(client, check.id, started).run();
      out.opened++;
      const startBy = formatMT(addBusinessHours(started * 1000, SUPPORT.outageHours));
      await alert(env, `DOWN: ${names.client}, ${names.check}`,
        `${names.check} (${names.client}) has failed its check since ${formatMT(started * 1000)}.\n\n` +
        `Support target: start work by ${startBy} (4 business hours) and keep the client posted in their hub until it's back.\n\n` +
        `Status page: https://status.positivetribes.org/${client}`);
    }
  }
  return out;
}

// For the hub: incidents that ended since `sinceSecs`, with display names. Never URLs.
export async function closedSince(env, sinceSecs) {
  const { results } = await env.DB.prepare(
    "SELECT id, client, check_id, started, ended FROM incidents WHERE ended IS NOT NULL AND ended >= ? ORDER BY ended",
  ).bind(sinceSecs).all();
  return results.map((i) => ({ ...i, ...{ clientName: nameOf(i.client, i.check_id).client, checkName: nameOf(i.client, i.check_id).check } }));
}

// For the hub's coverage check: each client slug and how many checks it has.
export function coverage() {
  return Object.fromEntries(Object.entries(CLIENTS).map(([slug, c]) => [slug, c.checks.length]));
}
