#!/usr/bin/env node
// Copy a client repo's requirements files into the hub (Map step 1, migration 0038). Run it from the client repo's root
// after a requirement changes (the "Changing a requirement" checklist), on the latest phase branch:
//
//   node ~/Projects/PositiveTribes/hub/scripts/requirements-sync.mjs [--config docs/requirements-sync.json] [--apply] [--local]
//
// The config names the hub client and, per project, its file and ID prefix:
//   { "client": "uep", "projects": [{ "project": "scheduler", "file": "docs/requirements.md", "prefix": "R" }] }
// For each project it replaces that project's rows in hub-db: rows gone from the file are removed, so the file stays the
// source of truth. It also records whether code cites each ID (the same scan as kits/requirements/check-requirements.mjs)
// and whether a UAT script (docs/*uat*.md) names it. Reads only the repo; writes only the requirements tables.
// Without --apply it prints what it would do. --local writes to wrangler's local copy instead of the live hub.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRequirements } from '../src/requirements.js';
import { sq } from './item.mjs';

const HUB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'data', '.wrangler']);
const CODE_DIRS = ['src', 'migrations', 'test', 'scripts', 'public'];
const CODE_EXT = /\.(m?js|sql|html|css)$/;

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out); else out.push(path);
  }
  return out;
};

// IDs with this prefix that appear in the given files.
export function citedIn(files, prefix) {
  const pattern = new RegExp(`(?<![A-Za-z0-9])${prefix}\\d{1,4}(?![0-9A-Za-z])`, 'g');
  const found = new Set();
  for (const f of files) for (const id of readFileSync(f, 'utf8').match(pattern) || []) found.add(id);
  return found;
}

export function readConfig(text) {
  const config = JSON.parse(text);
  if (!/^[a-z0-9-]{1,60}$/.test(config.client || '')) throw new Error('config.client: the hub client slug (a-z, 0-9, -).');
  if (!Array.isArray(config.projects) || !config.projects.length) throw new Error('config.projects: at least one project.');
  for (const p of config.projects) {
    if (!/^[a-z0-9-]{1,60}$/.test(p.project || '')) throw new Error('Each project needs its hub project slug.');
    if (!/^[A-Z]{1,3}$/.test(p.prefix || '')) throw new Error(`${p.project}: prefix must be 1 to 3 capital letters.`);
    if (typeof p.file !== 'string' || !/^[\w./-]+\.md$/.test(p.file) || p.file.includes('..')) throw new Error(`${p.project}: file must be a .md path inside the repo.`);
  }
  return config;
}

// The SQL that replaces one project's rows. ids = { client_id, project_id } looked up from the live hub first.
export function syncSql(ids, rows, { file, branch, commit }) {
  const c = Number(ids.client_id), p = Number(ids.project_id);
  if (!Number.isSafeInteger(c) || !Number.isSafeInteger(p)) throw new Error('Bad client or project id.');
  const refs = rows.map(r => sq(r.ref)).join(', ');
  const out = [`DELETE FROM requirements WHERE project_id = ${p}${rows.length ? ` AND ref NOT IN (${refs})` : ''};`];
  for (const r of rows) {
    out.push(`INSERT INTO requirements (client_id, project_id, ref, text, section, source, phase, hub_refs, state, cited, in_uat, position, synced_at)
VALUES (${c}, ${p}, ${sq(r.ref)}, ${sq(r.text)}, ${sq(r.section)}, ${sq(r.source)}, ${sq(r.phase)}, ${sq(r.hub_refs)}, ${sq(r.state)}, ${r.cited ? 1 : 0}, ${r.in_uat ? 1 : 0}, ${Number(r.position)}, CURRENT_TIMESTAMP)
ON CONFLICT (project_id, ref) DO UPDATE SET text = excluded.text, section = excluded.section, source = excluded.source, phase = excluded.phase,
  hub_refs = excluded.hub_refs, state = excluded.state, cited = excluded.cited, in_uat = excluded.in_uat, position = excluded.position, synced_at = CURRENT_TIMESTAMP;`);
  }
  out.push(`INSERT INTO requirement_syncs (client_id, project_id, file, branch, commit_sha, rows) VALUES (${c}, ${p}, ${sq(file)}, ${sq(branch)}, ${sq(commit)}, ${rows.length});`);
  return out.join('\n');
}

function wrangler(args) {
  return execFileSync('npx', ['wrangler', '-c', join(HUB, 'wrangler.jsonc'), 'd1', 'execute', 'hub-db', ...args], { cwd: HUB, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = name => { const i = argv.indexOf(name); return i > -1 ? argv[i + 1] : undefined; };
  const apply = argv.includes('--apply'), where = argv.includes('--local') ? '--local' : '--remote';
  const root = process.cwd();
  const configPath = join(root, arg('--config') || 'docs/requirements-sync.json');
  if (!existsSync(configPath)) throw new Error(`No ${configPath}. Run this from the client repo's root.`);
  const config = readConfig(readFileSync(configPath, 'utf8'));
  const git = args => { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; } };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']), commit = git(['rev-parse', '--short', 'HEAD']);
  const code = CODE_DIRS.flatMap(d => walk(join(root, d))).filter(f => CODE_EXT.test(f) && !f.endsWith('check-requirements.mjs'));
  const uat = walk(join(root, 'docs')).filter(f => /uat/i.test(f) && f.endsWith('.md'));

  const statements = [];
  for (const p of config.projects) {
    const path = join(root, p.file);
    if (!existsSync(path)) throw new Error(`${p.project}: no ${p.file}.`);
    const cited = citedIn(code, p.prefix), tested = citedIn(uat, p.prefix);
    const rows = parseRequirements(readFileSync(path, 'utf8'), { prefix: p.prefix }).map(r => ({ ...r, cited: cited.has(r.ref), in_uat: tested.has(r.ref) }));
    const found = JSON.parse(wrangler([where, '--json', '--command',
      `SELECT p.id AS project_id, p.client_id FROM projects p JOIN clients c ON c.id = p.client_id WHERE c.slug = ${sq(config.client)} AND p.slug = ${sq(p.project)}`]))[0].results;
    if (found.length !== 1) throw new Error(`No hub project ${config.client}/${p.project}. Check the slugs in the config.`);
    const by = rows.reduce((n, r) => { n[r.state] = (n[r.state] || 0) + 1; return n; }, {});
    console.log(`${config.client}/${p.project}: ${rows.length} rows from ${p.file} (${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ')}); ${rows.filter(r => r.cited).length} cited in code, ${rows.filter(r => r.in_uat).length} in a UAT script.`);
    statements.push(syncSql(found[0], rows, { file: p.file, branch, commit }));
  }
  if (!apply) { console.log(`\nDry run on ${branch || 'no branch'} ${commit}. Add --apply to write to the ${where === '--local' ? 'local' : 'live'} hub.`); return; }
  const dir = mkdtempSync(join(tmpdir(), 'req-sync-'));
  try {
    const file = join(dir, 'sync.sql');
    writeFileSync(file, statements.join('\n'), { mode: 0o600 });
    wrangler([where, '--yes', '--file', file]);
    console.log(`Synced to the ${where === '--local' ? 'local' : 'live'} hub from ${branch} ${commit}.`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
