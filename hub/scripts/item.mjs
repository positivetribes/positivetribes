#!/usr/bin/env node
// Change one backlog item in the production hub the same way the app does: the item row plus the matching
// events rows, so the client's bell and the item history stay right. For Positive Tribes use from Eric's machine.
//
//   node scripts/item.mjs <client-slug> <item-id> [changes] [--apply]
//
// Changes: --done | --reopen   --answer "text"   --phase review|prototype|full|later   --tier must|nice|idea
//          --due YYYY-MM-DD|none   --title "text"   --details "text"
// Without --apply it only looks the item up and prints the SQL it would run.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIER_NAMES = { must: 'Must have', nice: 'Nice to have', idea: 'Idea for now' };
export const PHASE_NAMES = { review: 'Not decided yet', prototype: 'Prototype', full: 'In the build', later: 'After launch' };
const LIMITS = { title: 200, details: 4000, answer: 2000 };
const ACTOR = { email: 'eric@positivetribes.org', name: 'Eric Roberts' };
const clip = (value, max = 300) => value.length > max ? value.slice(0, max - 1) + '…' : value;

// SQL string literal. wrangler d1 execute has no bound parameters, so every value goes through here.
export function sq(value) {
  const text = String(value);
  if (/[\u0000]/.test(text)) throw new Error('Text contains a NUL character.');
  return "'" + text.replace(/'/g, "''") + "'";
}

export function parseArgs(argv) {
  const [slug, rawId, ...rest] = argv;
  if (!/^[a-z0-9-]{1,60}$/.test(slug || '')) throw new Error('First argument: the client slug (a-z, 0-9, -).');
  if (!/^[1-9][0-9]{0,8}$/.test(rawId || '')) throw new Error('Second argument: the item id (a number).');
  const changes = {};
  let apply = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    const value = () => {
      const v = rest[++i];
      if (v === undefined) throw new Error(`${flag} needs a value.`);
      return v;
    };
    if (flag === '--apply') apply = true;
    else if (flag === '--done') changes.done = 1;
    else if (flag === '--reopen') changes.done = 0;
    else if (flag === '--answer') changes.answer = value();
    else if (flag === '--title') changes.title = value();
    else if (flag === '--details') changes.details = value();
    else if (flag === '--phase') {
      changes.phase = value();
      if (!PHASE_NAMES[changes.phase]) throw new Error(`--phase is one of ${Object.keys(PHASE_NAMES).join(', ')}.`);
    } else if (flag === '--tier') {
      changes.tier = value();
      if (!TIER_NAMES[changes.tier]) throw new Error(`--tier is one of ${Object.keys(TIER_NAMES).join(', ')}.`);
    } else if (flag === '--due') {
      const v = value();
      if (v !== 'none' && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error('--due is YYYY-MM-DD or none.');
      changes.due_date = v === 'none' ? '' : v;
    } else throw new Error(`Unknown option ${flag}.`);
  }
  for (const [key, max] of Object.entries(LIMITS)) {
    if (changes[key] !== undefined && changes[key].length > max) throw new Error(`--${key} is longer than ${max} characters.`);
  }
  if (changes.title !== undefined && !changes.title.trim()) throw new Error('--title cannot be empty.');
  if (!Object.keys(changes).length) throw new Error('Nothing to change. Add --done, --answer, --phase, --tier, --due, --title or --details.');
  return { slug, id: Number(rawId), changes, apply };
}

// The UPDATE plus one event per kind of change, in the same words the app uses (src/index.js changeOf),
// so the bell (src/notifications.js reads the events log) tells the client exactly what the app would.
export function buildSql(item, changes, actor = ACTOR) {
  const next = { ...item, ...changes };
  const sets = [];
  const events = [];
  const event = (action, detail = '') => events.push(
    `INSERT INTO events (client_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name, at) VALUES (` +
    `${item.client_id}, ${item.id}, ${sq(action)}, ${sq(next.title)}, ${sq(item.kind)}, ${sq(detail)}, ${sq(actor.email)}, ${sq(actor.name)}, CURRENT_TIMESTAMP);`);
  const edited = [];
  for (const key of ['title', 'details']) {
    if (changes[key] !== undefined && changes[key] !== item[key]) { sets.push(`${key} = ${sq(changes[key])}`); edited.push(key); }
  }
  if (changes.answer !== undefined && changes.answer !== item.answer) {
    sets.push(`answer = ${sq(changes.answer)}`);
    if (changes.answer) event('answered', clip(changes.answer));
  }
  if (changes.done !== undefined && changes.done !== item.done) {
    sets.push(`done = ${changes.done}`);
    event(changes.done ? 'done' : 'reopened');
  }
  if (changes.tier !== undefined && changes.tier !== item.tier) {
    sets.push(`tier = ${sq(changes.tier)}`);
    sets.push(`position = (SELECT COALESCE(MAX(position), 0) + 1 FROM items WHERE client_id = ${item.client_id} AND project_id IS ${item.project_id ?? 'NULL'} AND kind = ${sq(item.kind)} AND tier = ${sq(changes.tier)})`);
    event('tier', `${TIER_NAMES[item.tier]} → ${TIER_NAMES[changes.tier]}`);
  }
  if (changes.phase !== undefined && changes.phase !== item.phase) {
    sets.push(`phase = ${sq(changes.phase)}`);
    event('phase', `${PHASE_NAMES[item.phase] || item.phase} → ${PHASE_NAMES[changes.phase]}`);
  }
  if (changes.due_date !== undefined && changes.due_date !== item.due_date) sets.push(`due_date = ${sq(changes.due_date)}`);
  if (edited.length) event('edited', 'Changed ' + edited.join(', '));
  if (!sets.length) return '';
  return [`UPDATE items SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ${item.id} AND client_id = ${item.client_id};`, ...events].join('\n');
}

const HUB = join(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = args => execFileSync('npx', ['wrangler', '-c', 'wrangler.jsonc', 'd1', 'execute', 'hub-db', '--remote', ...args],
  { cwd: HUB, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

async function main() {
  const { slug, id, changes, apply } = parseArgs(process.argv.slice(2));
  const out = JSON.parse(wrangler(['--json', '--command',
    `SELECT i.id, i.client_id, i.project_id, i.kind, i.title, i.details, i.answer, i.tier, i.phase, i.done, i.due_date
     FROM items i JOIN clients c ON c.id = i.client_id WHERE c.slug = ${sq(slug)} AND i.id = ${id}`]));
  const item = out[0].results[0];
  if (!item) throw new Error(`No item ${id} for client ${slug}.`);
  if (changes.done !== undefined && item.kind === 'request') {
    const care = JSON.parse(wrangler(['--json', '--command', `SELECT 1 AS yes FROM care_requests WHERE item_id = ${id} AND client_id = ${item.client_id}`]));
    if (care[0].results.length) throw new Error('This is a care request: it closes through ship or cancel in the hub, not here.');
  }
  console.log(`Item ${id} (${item.kind}, ${PHASE_NAMES[item.phase] || item.phase}, ${item.done ? 'done' : 'open'}): ${item.title}`);
  const sql = buildSql(item, changes);
  if (!sql) return console.log('Already like that. Nothing to change.');
  console.log('\n' + sql + '\n');
  if (!apply) return console.log('Dry run. Add --apply to write it.');
  const dir = mkdtempSync(join(tmpdir(), 'hub-item-'));
  try {
    writeFileSync(join(dir, 'change.sql'), sql, { mode: 0o600 });
    wrangler(['--file', join(dir, 'change.sql')]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('Applied. The client sees it on their bell where the app would tell them.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exit(1); });
}
