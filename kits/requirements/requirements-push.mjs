#!/usr/bin/env node
// Push this repo's requirements files to the Tribe Hub from CI (kit; copy to <client repo>/scripts/). The hub parses the
// markdown itself and replaces that project's rows (POST https://hub.positivetribes.org/api/sync/requirements).
//
//   node scripts/requirements-push.mjs            (in GitHub Actions; see requirements-to-hub.yml next to this file)
//
// Reads docs/requirements-sync.json: { "client": "uep", "branch": "phase-4", "projects": [{ "project", "file", "prefix" }] }.
// Runs only on the config's branch (other branches exit 0), so the hub always holds the latest phase's file.
// Needs HUB_SYNC_CLIENT_ID and HUB_SYNC_CLIENT_SECRET: an Access service token the hub lists in REQUIREMENTS_SYNC_TOKENS
// for this one client. It can replace only this client's requirement rows and read nothing. Fails loudly on any error,
// so GitHub reports a failed run. No dependencies: Node 20+.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const HUB = 'https://hub.positivetribes.org/api/sync/requirements';
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
const citedIn = (files, prefix) => {
  const pattern = new RegExp(`(?<![A-Za-z0-9])${prefix}\\d{1,4}(?![0-9A-Za-z])`, 'g');
  const found = new Set();
  for (const f of files) for (const id of readFileSync(f, 'utf8').match(pattern) || []) found.add(id);
  return [...found];
};
const git = args => { try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; } };

async function main() {
  const root = process.cwd();
  const config = JSON.parse(readFileSync(join(root, 'docs/requirements-sync.json'), 'utf8'));
  const branch = process.env.GITHUB_REF_NAME || git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const commit = (process.env.GITHUB_SHA || git(['rev-parse', 'HEAD'])).slice(0, 12);
  if (!config.branch) throw new Error('docs/requirements-sync.json needs "branch": the branch whose file the hub holds.');
  if (branch !== config.branch) { console.log(`On ${branch}; the hub syncs from ${config.branch}. Nothing to do.`); return; }
  const id = process.env.HUB_SYNC_CLIENT_ID, secret = process.env.HUB_SYNC_CLIENT_SECRET;
  if (!id || !secret) throw new Error('HUB_SYNC_CLIENT_ID and HUB_SYNC_CLIENT_SECRET are not set.');
  const code = CODE_DIRS.flatMap(d => walk(join(root, d))).filter(f => CODE_EXT.test(f) && !/check-requirements\.mjs$|requirements-push\.mjs$/.test(f));
  const uat = walk(join(root, 'docs')).filter(f => /uat/i.test(f) && f.endsWith('.md'));
  for (const p of config.projects) {
    const body = { project: p.project, prefix: p.prefix, file: p.file, branch, commit,
      markdown: readFileSync(join(root, p.file), 'utf8'), cited: citedIn(code, p.prefix), in_uat: citedIn(uat, p.prefix) };
    const response = await fetch(HUB, {
      method: 'POST', redirect: 'manual',
      headers: { 'CF-Access-Client-Id': id, 'CF-Access-Client-Secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${p.project}: hub answered ${response.status} ${text.slice(0, 300)}`);
    const r = JSON.parse(text);
    console.log(`${config.client}/${p.project}: ${r.rows} rows (${Object.entries(r.states).map(([k, v]) => `${v} ${k}`).join(', ')}); ${r.cited} cited in code, ${r.in_uat} in a UAT script.`);
  }
}

main().catch(error => { console.error(error.message); process.exit(1); });
