// The deployed entry point. index.js stays importable from node tests; this file adds what only runs on Cloudflare:
// outage tracking after each probe run, and the `Incidents` RPC entrypoint the hub reaches over a service binding.
import { WorkerEntrypoint } from "cloudflare:workers";
import { handle, runChecks } from "./index.js";
import { trackIncidents, closedSince, coverage } from "./incidents.js";

export class Incidents extends WorkerEntrypoint {
  async closedSince(sinceSecs) {
    if (!Number.isSafeInteger(sinceSecs) || sinceSecs < 0) throw new Error("sinceSecs must be unix seconds");
    return closedSince(this.env, sinceSecs);
  }
  async coverage() { return coverage(); }
}

export default {
  fetch: (request, env) => handle(request, env),
  scheduled: (_event, env, ctx) => {
    const now = Math.floor(Date.now() / 1000);
    ctx.waitUntil(runChecks(env, now)
      .then((results) => trackIncidents(env, results, now))
      .then((r) => { if (r.opened || r.closed) console.log("incidents", JSON.stringify(r)); })
      .catch((error) => console.error("status_run_failed", error.message)));
  },
};
