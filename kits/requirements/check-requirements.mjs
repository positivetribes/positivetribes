#!/usr/bin/env node
// Drift check between a requirements file and the code. Read-only: it only reads files in the repo it is run from.
//
//   node check-requirements.mjs --file docs/requirements.md --prefix R [--verbose]
//
// Rows look like "| R27 | text | source | phase | ... |" (any prefix of capital letters). Fails (exit 1) when code,
// migrations, tests or scripts cite an ID (R27 and so on) that has no row. Prints, for information only, the rows no code cites.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : fallback; };
const file = arg('--file', 'docs/requirements.md');
const prefix = arg('--prefix', 'R');
if (!/^[A-Z]{1,3}$/.test(prefix)) { console.error('--prefix must be 1 to 3 capital letters.'); process.exit(2); }
const root = resolve(process.cwd());
if (!existsSync(join(root, file))) { console.error(`No ${file} here. Run this from the repo root.`); process.exit(2); }

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

const rows = new Set();
const rowPattern = new RegExp(`^\\|\\s*(${prefix}\\d+)\\s*\\|`);
for (const line of readFileSync(join(root, file), 'utf8').split('\n')) {
  const m = line.match(rowPattern);
  if (m) rows.add(m[1]);
}
const citePattern = new RegExp(`(?<![A-Za-z0-9])${prefix}\\d{1,3}(?![0-9A-Za-z])`, 'g');
const cited = new Map();
for (const dir of CODE_DIRS) {
  for (const f of walk(join(root, dir)).filter(f => CODE_EXT.test(f) && !f.endsWith('check-requirements.mjs'))) {
    for (const id of new Set(readFileSync(f, 'utf8').match(citePattern) || [])) {
      if (!cited.has(id)) cited.set(id, new Set());
      cited.get(id).add(relative(root, f));
    }
  }
}
const missing = [...cited.keys()].filter(id => !rows.has(id)).sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
const uncited = [...rows].filter(id => !cited.has(id));
console.log(`${rows.size} requirements in ${file}, ${cited.size} cited in code.`);
if (missing.length) {
  console.log(`\nCITED IN CODE BUT NOT IN ${file} (fix these):`);
  for (const id of missing) console.log(`  ${id}  ${[...cited.get(id)].slice(0, 3).join(', ')}`);
}
console.log(`\nFor information: ${uncited.length} requirements no code cites.`);
if (process.argv.includes('--verbose')) console.log('  Not cited in code: ' + (uncited.join(' ') || 'none'));
process.exit(missing.length ? 1 : 0);
