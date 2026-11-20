// PoC use on Today: how often a prospect opens the proof of concept we built for them.
// Each PoC Worker exposes a `Usage` RPC entrypoint (Workers RPC over a service binding, never the internet)
// whose week() returns the last 7 days of its own visit log: { people: [{ email, days, screens, sites, last }], lastEver }.
// Add a PoC here and a matching "services" binding in wrangler.jsonc. Our own visits are left out by the PoC.
export const POCS = [
  { binding: 'POC_WFA', client: 'Wildlife for All', workspace: 'wfa', name: 'Commission meeting tracker' }
];

const TIMEOUT_MS = 3000;
const num = v => Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0;
const str = (v, max) => typeof v === 'string' ? v.slice(0, max) : '';
const SITE = /^[a-z][a-z0-9-]{0,19}$/;

// Keep only the fields Today shows, as plain numbers and short strings.
export function cleanUsage(raw) {
  const people = (Array.isArray(raw && raw.people) ? raw.people : []).slice(0, 20).map(p => ({
    email: str(p && p.email, 120),
    days: num(p && p.days),
    screens: num(p && p.screens),
    last: str(p && p.last, 19),
    sites: Object.fromEntries(Object.entries((p && p.sites) || {}).filter(([k]) => SITE.test(k)).slice(0, 6).map(([k, v]) => [k, num(v)]))
  })).filter(p => p.email);
  return { people, lastEver: str(raw && raw.lastEver, 19) || null };
}

// One entry per connected PoC; a slow or broken PoC shows as ok: false and never hides Today.
export async function pocUsage(env, pocs = POCS) {
  return Promise.all(pocs.filter(p => env[p.binding]).map(async p => {
    const base = { client: p.client, workspace: p.workspace, name: p.name };
    try {
      const raw = await Promise.race([env[p.binding].week(), new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS))]);
      return { ...base, ok: true, ...cleanUsage(raw) };
    } catch (error) {
      console.error('admin_poc_usage_failed', p.binding, error.message);
      return { ...base, ok: false, people: [], lastEver: null };
    }
  }));
}
