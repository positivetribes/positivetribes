// Requirements the hub can see (Map step 1, migration 0038). The rows come from each project's requirements markdown
// file through scripts/requirements-sync.mjs; parseRequirements is shared by that script and the tests.
// GET /api/admin/requirements (Positive Tribes only, behind handleAdmin's door) returns each project's rows with a status
// worked out from facts, never typed by hand:
//   accepted  its phase (the Phase column's number) is signed off or live in the hub
//   built     code, migrations, tests or scripts on the synced branch cite it (// R27)
//   planned   neither yet
// plus in_uat (a UAT script names it), and the hub items its Source or Hub column points at (#76, BL-63).

const clean = s => String(s ?? '').replace(/\*\*|__|`/g, '').replace(/~~/g, '').replace(/\s+/g, ' ').trim();
const cells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const isRule = line => /^\|?\s*:?-{3,}/.test(line.trim());

// Hub numbers a row points at: "#76", "Hub #125", "BL-63" (backlog n, imported with legacy_id n). Unique, in order.
export function hubRefs(text) {
  const out = [];
  for (const m of String(text).matchAll(/(?:#|\bBL-)(\d{1,4})\b/g)) if (!out.includes(Number(m[1]))) out.push(Number(m[1]));
  return out;
}

// Reads a requirements file. prefix: the ID letters (R, F, V). Rows under a "Proposed" heading with a P or PF/PV number are
// proposals: "decided" once the file has a line starting "P5 DECIDED". Rows under "Not in scope" are out_of_scope;
// a row whose text starts with "Dropped" is dropped.
export function parseRequirements(markdown, { prefix = 'R' } = {}) {
  if (!/^[A-Z]{1,3}$/.test(prefix)) throw new Error('prefix must be 1 to 3 capital letters.');
  const lines = String(markdown).split('\n');
  const decided = new Set(lines.map(l => /^\**(P[A-Z]?\d+)\s+DECIDED\b/.exec(l.trim())?.[1]).filter(Boolean));
  const own = new RegExp(`^${prefix}\\d{1,4}$`);
  const rows = [];
  let heading = '', header = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) { heading = clean(h[1]); header = null; continue; }
    if (!line.trim().startsWith('|')) { header = null; continue; }
    if (isRule(line)) continue;
    const c = cells(line);
    if (!header) {
      if (isRule(lines[i + 1] || '')) { header = c.map(x => clean(x).toLowerCase()); continue; }
      header = [];
    }
    const ref = clean(c[0]);
    const proposed = /proposed/i.test(heading) && /^P[A-Z]?\d{1,4}$/.test(ref);
    if (!own.test(ref) && !proposed) continue;
    const col = (...names) => { const at = header.findIndex(x => names.includes(x)); return at > -1 ? clean(c[at]) : ''; };
    const text = col('requirement', 'proposal') || clean(c[1]);
    const source = col('source', 'notes');
    const state = proposed ? (decided.has(ref) ? 'decided' : 'proposed')
      : /not in scope|out of scope/i.test(heading) ? 'out_of_scope'
      : /^dropped\b/i.test(text) ? 'dropped' : 'agreed';
    rows.push({
      ref, text: text.slice(0, 1000), section: heading.slice(0, 120), source: source.slice(0, 400),
      phase: col('phase').slice(0, 40), hub_refs: hubRefs(c.slice(1).join(' ')).join(','), state, position: rows.length + 1
    });
  }
  const seen = new Set();
  for (const r of rows) {
    if (seen.has(r.ref)) throw new Error(`${r.ref} appears twice in the file. Give each requirement one row.`);
    seen.add(r.ref);
  }
  return rows;
}

// The phase numbers a Phase cell names ("1", "1, 4", "W1" has none). Empty when the project has no phases.
export const phaseNumbers = phase => [...String(phase).matchAll(/(?<![A-Za-z])(\d{1,2})(?!\d)/g)].map(m => Number(m[1]));

const DONE = ['signed_off', 'live'];
export function statusOf(row, releases) {
  if (row.state !== 'agreed') return row.state;
  const numbers = phaseNumbers(row.phase);
  const mine = numbers.map(n => releases.find(r => r.project_id === row.project_id && r.number === n));
  if (numbers.length && mine.every(r => r && DONE.includes(r.stage))) return 'accepted';
  return row.cited ? 'built' : 'planned';
}

// Per project: the rows with their status and linked items, a count by status, and counts per phase.
export async function loadRequirements(db, clientId) {
  const where = clientId ? ' WHERE client_id = ?' : '';
  const bind = s => clientId ? db.prepare(s).bind(clientId) : db.prepare(s);
  const [rows, releases, items, syncs] = await Promise.all([
    bind(`SELECT id, client_id, project_id, ref, text, section, source, phase, hub_refs, state, cited, in_uat, position FROM requirements${where} ORDER BY project_id, position`).all(),
    bind(`SELECT id, client_id, project_id, number, stage FROM releases${where}`).all(),
    bind(`SELECT id, client_id, COALESCE(legacy_id, id) AS number, title, kind, done, status FROM items${where}`).all(),
    bind(`SELECT s.project_id, s.file, s.branch, s.commit_sha, s.rows, s.synced_at FROM requirement_syncs s
      WHERE s.id IN (SELECT MAX(id) FROM requirement_syncs GROUP BY project_id)${clientId ? ' AND s.client_id = ?' : ''}`).all()
  ]);
  const projects = new Map();
  for (const r of rows.results) {
    const status = statusOf(r, releases.results);
    const linked = r.hub_refs ? r.hub_refs.split(',').map(Number)
      .map(n => items.results.find(i => i.client_id === r.client_id && i.number === n)).filter(Boolean)
      .map(i => ({ id: i.id, number: i.number, title: i.title, kind: i.kind, done: Boolean(i.done) })) : [];
    if (!projects.has(r.project_id)) projects.set(r.project_id, { project_id: r.project_id, client_id: r.client_id, counts: {}, phases: {}, rows: [] });
    const p = projects.get(r.project_id);
    p.counts[status] = (p.counts[status] || 0) + 1;
    if (r.state === 'agreed') {
      for (const n of phaseNumbers(r.phase).length ? phaseNumbers(r.phase) : ['']) {
        const ph = p.phases[n] ||= { total: 0, built: 0, accepted: 0, in_uat: 0 };
        ph.total++; if (status === 'built' || status === 'accepted') ph.built++; if (status === 'accepted') ph.accepted++; if (r.in_uat) ph.in_uat++;
      }
    }
    p.rows.push({ ...r, cited: Boolean(r.cited), in_uat: Boolean(r.in_uat), status, items: linked });
  }
  for (const s of syncs.results) if (projects.has(s.project_id)) projects.get(s.project_id).last_sync = s;
  return [...projects.values()];
}

export async function requirementsAdmin({ env, url, route, json }) {
  if (route !== 'GET /api/admin/requirements') return null;
  if (!env.DB) return json({ error: 'The hub database is not connected.' }, 503);
  const raw = url.searchParams.get('client_id');
  if (raw != null && !/^[1-9]\d{0,8}$/.test(raw)) return json({ error: 'Client is not valid.' }, 400);
  return json({ projects: await loadRequirements(env.DB, raw ? Number(raw) : null) });
}
