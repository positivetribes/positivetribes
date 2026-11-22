#!/usr/bin/env node
// Add decisions and dependencies to the production hub from a session (Map step 2, migration 0039). Positive Tribes only.
//
//   node scripts/map.mjs decision <client-slug> --on YYYY-MM-DD --summary "text" [--by "Molly"] [--why "text"]
//        [--affects "R101, #198"] [--project <slug>] [--source "email Nov 18"] [--price] [--supersedes <id>] [--apply]
//   node scripts/map.mjs depends <client-slug> --blocker <kind>:<ref> --blocked <kind>:<ref> [--kind blocks|needs_input|needs_signoff]
//        [--label "text"] [--needed-by YYYY-MM-DD] [--apply]
//   node scripts/map.mjs list <client-slug>
//
// Kinds for each end: timeline:<entry id>, release:<release id>, item:<client-shown #>, sf_task:<00T... Id>.
// Every hub end is checked against the live hub and must belong to the client. Without --apply it prints the SQL only.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sq } from './item.mjs';

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const KINDS = ['timeline', 'release', 'item', 'sf_task'];
const DEP_KINDS = ['blocks', 'needs_input', 'needs_signoff'];
const FLAGS = new Set(['--apply', '--price']);

export function parse(argv) {
  const [command, client, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected "${a}".`);
    if (FLAGS.has(a)) { opts[a.slice(2)] = true; continue; }
    if (rest[i + 1] === undefined) throw new Error(`${a} needs a value.`);
    opts[a.slice(2)] = rest[++i];
  }
  if (!['decision', 'depends', 'list'].includes(command)) throw new Error('Command: decision, depends or list.');
  if (!/^[a-z0-9-]{1,60}$/.test(client || '')) throw new Error('Give the client slug, e.g. uep.');
  return { command, client, opts };
}

export function checkDate(value, label, required = false) {
  if (value == null || value === '') { if (required) throw new Error(`${label} is required.`); return ''; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must look like 2026-11-04.`);
  }
  return value;
}
const limit = (value, max, label, required = false) => {
  const t = String(value ?? '').trim();
  if (required && !t) throw new Error(`${label} is required.`);
  if (t.length > max) throw new Error(`${label} is over ${max} characters.`);
  return t;
};

export function end(text, label) {
  const m = /^([a-z_]+):(.+)$/.exec(text || '');
  if (!m || !KINDS.includes(m[1])) throw new Error(`${label}: use timeline:<id>, release:<id>, item:<#> or sf_task:<00T Id>.`);
  if (m[1] === 'sf_task' ? !/^00T[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?$/.test(m[2]) : !/^[1-9]\d{0,8}$/.test(m[2])) throw new Error(`${label}: "${m[2]}" is not a valid ${m[1]} ref.`);
  return { kind: m[1], ref: m[2] };
}

export function decisionSql(clientId, projectId, o) {
  const cols = [Number(clientId), projectId == null ? 'NULL' : Number(projectId), sq(checkDate(o.on, '--on', true)), sq(limit(o.by, 80, '--by')),
    sq(limit(o.summary, 300, '--summary', true)), sq(limit(o.why, 1000, '--why')), sq(limit(o.affects, 200, '--affects')),
    o.price ? 1 : 0, o.supersedes ? Number(o.supersedes) : 'NULL', sq(limit(o.source, 200, '--source'))];
  if (o.supersedes && !/^[1-9]\d{0,8}$/.test(o.supersedes)) throw new Error('--supersedes takes a decision id.');
  return `INSERT INTO decisions (client_id, project_id, decided_on, decided_by, summary, why, affects, price_change, supersedes_id, source) VALUES (${cols.join(', ')});`;
}

export function dependencySql(clientId, blocker, blocked, o) {
  if (blocker.kind === blocked.kind && blocker.ref === blocked.ref) throw new Error('Something cannot wait on itself.');
  const kind = o.kind || 'blocks';
  if (!DEP_KINDS.includes(kind)) throw new Error('--kind: blocks, needs_input or needs_signoff.');
  const label = limit(o.label, 160, '--label', blocker.kind === 'sf_task' || blocked.kind === 'sf_task');
  return `INSERT INTO dependencies (client_id, blocker_kind, blocker_ref, blocked_kind, blocked_ref, kind, label, needed_by) VALUES (${Number(clientId)}, ${sq(blocker.kind)}, ${sq(blocker.ref)}, ${sq(blocked.kind)}, ${sq(blocked.ref)}, ${sq(kind)}, ${sq(label)}, ${sq(checkDate(o['needed-by'], '--needed-by'))});`;
}

const wrangler = args => execFileSync('npx', ['wrangler', '-c', 'wrangler.jsonc', 'd1', 'execute', 'hub-db', '--remote', ...args], { cwd: HUB, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const query = sql => JSON.parse(wrangler(['--json', '--command', sql])).map(b => b.results);

// A hub end must be this client's. Items are given by the number the client sees; store the item's real id.
async function resolveEnd(e, clientId) {
  if (e.kind === 'sf_task') return e;
  const sql = {
    timeline: `SELECT id, label AS name FROM timeline_entries WHERE id = ${Number(e.ref)} AND client_id = ${clientId}`,
    release: `SELECT r.id, p.name || ' Phase ' || r.number AS name FROM releases r JOIN projects p ON p.id = r.project_id WHERE r.id = ${Number(e.ref)} AND r.client_id = ${clientId}`,
    item: `SELECT id, title AS name FROM items WHERE COALESCE(legacy_id, id) = ${Number(e.ref)} AND client_id = ${clientId}`
  }[e.kind];
  const [rows] = query(sql);
  if (rows.length !== 1) throw new Error(`No ${e.kind} ${e.ref} for this client.`);
  console.log(`  ${e.kind} ${e.ref}: ${rows[0].name}`);
  return { kind: e.kind, ref: String(rows[0].id) };
}

async function main() {
  const { command, client, opts } = parse(process.argv.slice(2));
  const [clients] = query(`SELECT id FROM clients WHERE slug = ${sq(client)}`);
  if (clients.length !== 1) throw new Error(`No hub client "${client}".`);
  const clientId = Number(clients[0].id);
  if (command === 'list') {
    const [decisions, deps] = query(`SELECT id, decided_on, decided_by, summary, affects FROM decisions WHERE client_id = ${clientId} ORDER BY decided_on, id; SELECT id, blocker_kind, blocker_ref, blocked_kind, blocked_ref, kind, label, needed_by FROM dependencies WHERE client_id = ${clientId} ORDER BY id`);
    for (const d of decisions) console.log(`D${d.id} ${d.decided_on} ${d.decided_by ? d.decided_by + ': ' : ''}${d.summary}${d.affects ? ` [${d.affects}]` : ''}`);
    for (const d of deps) console.log(`dep${d.id} ${d.blocker_kind}:${d.blocker_ref} → ${d.blocked_kind}:${d.blocked_ref} (${d.kind})${d.label ? ' ' + d.label : ''}${d.needed_by ? ' by ' + d.needed_by : ''}`);
    return;
  }
  let sql;
  if (command === 'decision') {
    let projectId = null;
    if (opts.project) {
      if (!/^[a-z0-9-]{1,60}$/.test(opts.project)) throw new Error('--project takes a project slug.');
      const [rows] = query(`SELECT id FROM projects WHERE client_id = ${clientId} AND slug = ${sq(opts.project)}`);
      if (rows.length !== 1) throw new Error(`No project "${opts.project}" for this client.`);
      projectId = rows[0].id;
    }
    if (opts.supersedes) {
      const [rows] = query(`SELECT id FROM decisions WHERE id = ${Number(opts.supersedes) || 0} AND client_id = ${clientId}`);
      if (rows.length !== 1) throw new Error(`No decision ${opts.supersedes} for this client.`);
    }
    sql = decisionSql(clientId, projectId, opts);
  } else {
    const blocker = await resolveEnd(end(opts.blocker, '--blocker'), clientId), blocked = await resolveEnd(end(opts.blocked, '--blocked'), clientId);
    sql = dependencySql(clientId, blocker, blocked, opts);
  }
  console.log(sql);
  if (!opts.apply) return console.log('Dry run. Add --apply to write it.');
  const dir = mkdtempSync(join(tmpdir(), 'hub-map-'));
  try {
    writeFileSync(join(dir, 'change.sql'), sql, { mode: 0o600 });
    wrangler(['--file', join(dir, 'change.sql')]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('Applied.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
