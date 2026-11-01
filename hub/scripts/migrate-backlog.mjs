#!/usr/bin/env node
// Turns one old per-client backlog (uep-backlog, soberafe-backlog, coyote-backlog, unitedrocks-backlog) into SQL for
// the hub database. It only READS the old database and only WRITES a .sql file; applying that file is a separate,
// deliberate step. Re-running is safe: every insert is keyed by the old row id (migration 0002).
//
//   node scripts/migrate-backlog.mjs --client uep [--out uep.sql] [--ed "molly@uep.org=Molly Hart"]
//   node scripts/migrate-backlog.mjs --client safe --items items.json --events events.json   (offline, from saved JSON)
//   then review the file and apply:  wrangler d1 execute hub-db --remote --file uep.sql
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// What each old backlog becomes. `projects` maps the old `area` value to a hub project; a backlog with no areas
// uses the single project listed under '*'. Phases are where each project stands today: confirm before applying.
export const CLIENTS = {
  uep: {
    name: 'Up ENDing Parkinson\'s', accent: '#1f5fa8', database: 'uep-backlog-db', events: true,
    projects: {
      scheduler: { slug: 'scheduler', name: 'Scheduler', poc_url: 'https://positivetribes.org/uep/', phase: 'prototype', position: 1 },
      fundraising: { slug: 'fundraising', name: 'Fundraising', poc_url: 'https://positivetribes.org/uep/v3/', phase: 'prototype', position: 2 }
    }
  },
  safe: {
    name: 'Sober AF', accent: '#2440e0', database: 'soberafe-backlog-db', events: true,
    projects: { '*': { slug: 'chapters', name: 'Sober AF app', poc_url: 'https://positivetribes.org/soberafe/chapters/', phase: 'prototype', position: 1 } }
  },
  coyote: {
    name: 'Project Coyote', accent: '#a2593f', database: 'coyote-backlog-db', events: true,
    projects: { '*': { slug: 'coyote', name: 'Project Coyote', poc_url: '', phase: 'prototype', position: 1 } }
  },
  unitedrocks: {
    name: 'United Rocks', accent: '#127057', database: 'unitedrocks-backlog-db', events: false,
    projects: { '*': { slug: 'unitedrocks', name: 'United Rocks', poc_url: '', phase: 'prototype', position: 1 } }
  }
};

const KINDS = ['question', 'change', 'problem', 'request'];
const TIERS = ['must', 'nice', 'idea'];
const PHASES = ['review', 'prototype', 'full', 'later'];

const str = v => v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`;
const int = (v, label) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} is not a whole number: ${v}`);
  return String(n);
};
const check = (list, v, label) => {
  if (!list.includes(v)) throw new Error(`${label} has an unexpected value "${v}" (allowed: ${list.join(', ')}).`);
  return v;
};
// Old events say what was typed as a name; the hub wants an email too, which the old data never had.
const clientId = slug => `(SELECT id FROM clients WHERE slug = ${str(slug)})`;

// Pure function: old rows in, SQL text out. Throws on anything it does not understand rather than guessing.
export function buildMigrationSql(slug, { items, events = [] }, { users = [] } = {}) {
  const config = CLIENTS[slug];
  if (!config) throw new Error(`Unknown client "${slug}". Known: ${Object.keys(CLIENTS).join(', ')}.`);
  const target = area => {
    const project = config.projects[area] || config.projects['*'];
    if (!project) throw new Error(`Item has area "${area}", which has no hub project for ${slug}.`);
    return project;
  };
  const projectId = project => `(SELECT id FROM projects WHERE client_id = ${clientId(slug)} AND slug = ${str(project.slug)})`;
  const out = [`-- Backlog import for ${slug}: ${items.length} items, ${events.length} events. Safe to run more than once.`];

  out.push(`INSERT OR IGNORE INTO clients (slug, name, accent) VALUES (${str(slug)}, ${str(config.name)}, ${str(config.accent)});`);
  const seen = new Set();
  for (const project of Object.values(config.projects)) {
    if (seen.has(project.slug)) continue;
    seen.add(project.slug);
    out.push(`INSERT OR IGNORE INTO projects (client_id, slug, name, poc_url, phase, position) VALUES (${clientId(slug)}, ${str(project.slug)}, ${str(project.name)}, ${str(project.poc_url)}, ${str(project.phase)}, ${int(project.position, 'position')});`);
  }
  for (const { email, name, role } of [{ email: 'eric@positivetribes.org', name: 'Eric Roberts', role: 'pt' }, ...users]) {
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error(`"${email}" is not an email address.`);
    check(['ed', 'staff', 'pt'], role, `User ${email} role`);
    out.push(`INSERT OR IGNORE INTO users (email, name, role, client_id) VALUES (${str(email.toLowerCase())}, ${str(name)}, ${str(role)}, ${role === 'pt' ? 'NULL' : clientId(slug)});`);
  }

  for (const item of items) {
    const label = `Item ${item.id} "${item.title}"`;
    const project = target(item.area);
    out.push(
      `INSERT OR IGNORE INTO items (client_id, project_id, legacy_id, kind, title, details, owner, answer, tier, phase, position, done, added_by, created_at, updated_at) VALUES (` +
      [clientId(slug), projectId(project), int(item.id, label),
        str(check(KINDS, item.kind || 'change', `${label} kind`)), str(item.title), str(item.details || ''), str(item.owner || ''), str(item.answer || ''),
        str(check(TIERS, item.tier, `${label} tier`)), str(check(PHASES, item.phase || 'review', `${label} phase`)),
        int(item.position, `${label} position`), item.done ? '1' : '0', str(item.added_by || ''), str(item.created_at), str(item.updated_at || item.created_at)].join(', ') + ');'
    );
  }
  for (const event of events) {
    const label = `Event ${event.id}`;
    // Events about items that were later deleted have no item to point at; they keep item_id 0 and their title.
    out.push(
      `INSERT OR IGNORE INTO events (client_id, legacy_id, item_id, action, item_title, item_kind, detail, actor_email, actor_name, at) VALUES (` +
      [clientId(slug), int(event.id, label),
        `COALESCE((SELECT id FROM items WHERE client_id = ${clientId(slug)} AND legacy_id = ${int(event.item_id, label + ' item')}), 0)`,
        str(event.action), str(event.item_title), str(event.item_kind || ''), str(event.detail || ''), "''", str(event.actor || ''), str(event.at)].join(', ') + ');'
    );
  }
  return out.join('\n') + '\n';
}

// ---- command line ----
function readOld(config, sql) {
  const result = execFileSync('npx', ['wrangler', 'd1', 'execute', config.database, '--remote', '--json', '--command', sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const parsed = JSON.parse(result.slice(result.indexOf('[')));
  return parsed[0].results;
}

function main(argv) {
  const args = { ed: [], staff: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || argv[i + 1] === undefined) throw new Error(`Bad arguments near "${argv[i]}".`);
    if (key === 'ed' || key === 'staff') args[key].push(argv[i + 1]); else args[key] = argv[i + 1];
  }
  const slug = args.client;
  const config = CLIENTS[slug];
  if (!config) throw new Error('Usage: --client <' + Object.keys(CLIENTS).join('|') + '> [--out file.sql] [--items items.json --events events.json] [--ed "email=Name"] [--staff "email=Name"]');
  const person = role => spec => {
    const [email, ...name] = spec.split('=');
    return { email, name: name.join('=') || email, role };
  };
  const users = [...args.ed.map(person('ed')), ...args.staff.map(person('staff'))];
  const items = args.items ? JSON.parse(readFileSync(args.items, 'utf8')) : readOld(config, 'SELECT * FROM backlog_items ORDER BY id');
  const events = !config.events ? [] : args.events ? JSON.parse(readFileSync(args.events, 'utf8')) : readOld(config, 'SELECT * FROM backlog_events ORDER BY id');
  const sql = buildMigrationSql(slug, { items, events }, { users });
  const out = args.out || `${slug}-import.sql`;
  writeFileSync(out, sql);
  console.log(`Wrote ${out}: ${items.length} items, ${events.length} events. Nothing was changed in any database.`);
  console.log(`Review it, then apply with: npx wrangler d1 execute hub-db --remote --file ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exit(1); }
}
