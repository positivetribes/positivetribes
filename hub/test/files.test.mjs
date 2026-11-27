import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { cleanName, fileType, MAX_FILES } from '../src/files.js';
import { database } from './helpers.mjs';

// A fake R2 bucket: enough of get/put/delete (one key or a list) for the file routes.
function bucket() {
  const files = new Map();
  return {
    files,
    async put(key, bytes) { files.set(key, new Uint8Array(bytes)); },
    async get(key) { const b = files.get(key); return b ? { body: b } : null; },
    async delete(keys) { for (const k of [].concat(keys)) files.delete(k); }
  };
}

const MIGRATIONS = ['0001_init.sql', '0002_legacy_ids.sql', '0003_releases.sql', '0004_release_url.sql', '0005_release_script.sql', '0006_release_window.sql', '0007_project_live_url.sql', '0008_documents.sql', '0009_hub_ideas.sql', '0010_hub_idea_images.sql', '0011_documents_for_everyone.sql', '0012_notifications.sql', '0013_notification_clear.sql', '0014_last_seen.sql', '0015_care_plans.sql', '0016_patch_triage.sql', '0017_document_date.sql', '0018_client_salesforce_url.sql', '0019_project_has_prototype.sql', '0020_client_logo.sql', '0021_client_logo_soberaf.sql', '0022_project_next_note.sql', '0023_item_status.sql', '0024_patch_replies.sql', '0025_item_releases.sql', '0026_change_estimates.sql', '0027_donated_changes.sql', '0028_estimate_lines.sql', '0029_agreement_ref.sql', '0031_item_proposal.sql', '0033_timeline.sql', '0037_item_images.sql', '0041_item_asks_back.sql', '0043_client_email.sql', '0044_client_photos.sql', '0045_item_files.sql'];

function setup() {
  const { sqlite, db } = database();
  for (const file of MIGRATIONS) sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  sqlite.exec(`
    INSERT INTO clients (slug, name) VALUES ('jg', 'JG'), ('safe', 'Sober AF');
    INSERT INTO projects (client_id, slug, name) VALUES (1, 'site', 'Website'), (2, 'app', 'App');
    INSERT INTO users (email, name, role, client_id) VALUES
      ('glenn@jg.com', 'Glenn', 'ed', 1), ('eric@positivetribes.org', 'Eric', 'pt', NULL), ('dana@safe.org', 'Dana', 'ed', 2), ('joe@jg.com', 'Joe', 'staff', 1);
    INSERT INTO items (client_id, project_id, kind, title, tier, status, done, position) VALUES
      (1, 1, 'question', 'Send the logo', 'must', 'new', 0, 1), (1, 1, 'question', 'Closed one', 'must', 'new', 1, 2), (2, 2, 'problem', 'Other client', 'nice', 'new', 0, 1);
  `);
  const FILES = bucket();
  const env = { DB: db, FILES, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') } };
  const call = (who, path, method = 'GET', payload) => worker.fetch(new Request('http://localhost' + path, {
    method, headers: { 'x-dev-email': who, 'content-type': 'application/json', ...(method !== 'GET' ? { origin: 'http://localhost' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined
  }), env);
  const send = (who, path, name, bytes, headers = {}) => worker.fetch(new Request('http://localhost' + path + '?' + new URLSearchParams({ name }), {
    method: 'POST', headers: { 'x-dev-email': who, 'content-type': 'application/octet-stream', origin: 'http://localhost', ...headers }, body: bytes
  }), env);
  return { sqlite, call, send, FILES, env };
}

const enc = text => new TextEncoder().encode(text);
const PDF = enc('%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n');
const ZIP = Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 8, 0);
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);

test('fileType trusts the bytes, not the name', () => {
  assert.equal(fileType(PDF, 'bio.pdf'), 'application/pdf');
  assert.equal(fileType(PDF, 'logo.ai'), 'application/pdf');
  assert.equal(fileType(ZIP, 'bio.docx'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(fileType(ZIP, 'logos.zip'), 'application/zip');
  assert.equal(fileType(PNG, 'logo.png'), 'image/png');
  assert.equal(fileType(enc('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'logo.svg'), 'image/svg+xml');
  assert.equal(fileType(enc('name,role\nJoe,CEO\n'), 'team.csv'), 'text/csv');
  assert.equal(fileType(PDF, 'bio.docx'), null, 'a PDF named .docx');
  assert.equal(fileType(enc('<html><script>alert(1)</script></html>'), 'page.html'), null, 'HTML is not taken');
  assert.equal(fileType(enc('<html><script>alert(1)</script></html>'), 'logo.svg'), null, 'HTML named .svg');
  assert.equal(fileType(Uint8Array.of(0x4d, 0x5a, 0x90, 0), 'setup.exe'), null);
  assert.equal(fileType(ZIP, 'macro.docm'), null, 'macro-enabled Office files are not taken');
  assert.equal(fileType(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0), 'old.doc'), null, 'old Office files are not taken');
  assert.equal(fileType(Uint8Array.of(0x41, 0, 0x42), 'notes.txt'), null, 'binary named .txt');
  assert.equal(fileType(PDF, 'noextension'), null);
});

test('cleanName strips folders and odd characters and keeps the extension', () => {
  assert.equal(cleanName('../../etc/passwd'), 'passwd');
  assert.equal(cleanName('C:\\Users\\glenn\\Joe headshot.JPG'), 'Joe headshot.jpg');
  assert.equal(cleanName('bad"<name>\u0000.pdf'), 'badname.pdf');
  assert.equal(cleanName('...hidden.pdf'), 'hidden.pdf');
  assert.equal(cleanName('   '), '');
  assert.equal(cleanName('x'.repeat(300) + '.pdf').length, 114);
});

test('client people add, list and download files on their own items', async () => {
  const { sqlite, call, send, FILES } = setup();
  const added = await send('glenn@jg.com', '/api/c/jg/items/1/files', 'Jimmy bio.pdf', PDF);
  assert.equal(added.status, 201);
  const { items } = await added.json();
  const files = items.find(i => i.id === 1).files;
  assert.equal(files.length, 1);
  assert.equal(files[0].name, 'Jimmy bio.pdf');
  assert.equal(files[0].mine, true);
  assert.equal(files[0].bytes, PDF.length);
  assert.equal('added_email' in files[0], false, 'never who added it');
  const row = sqlite.prepare('SELECT * FROM item_files').get();
  assert.match(row.r2_key, /^1\/items\/1\/[0-9a-f-]{36}$/);
  assert.ok(FILES.files.has(row.r2_key));
  // The command center sees it arrive.
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE action = 'file_added' AND item_id = 1").get().n, 1);

  const teammate = await (await call('joe@jg.com', '/api/c/jg/projects')).json();
  assert.ok(teammate);
  const list = await (await call('joe@jg.com', '/api/c/jg/items')).json();
  assert.equal(list.items.find(i => i.id === 1).files[0].mine, false);

  const got = await call('joe@jg.com', '/api/c/jg/items/1/files/' + row.id);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/octet-stream');
  assert.match(got.headers.get('content-disposition'), /^attachment; filename="Jimmy bio.pdf"; filename\*=UTF-8''Jimmy%20bio.pdf$/);
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('content-security-policy'), /sandbox/);
  assert.match(got.headers.get('cache-control'), /private/);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), PDF);
});

test('files stay inside their client', async () => {
  const { sqlite, call, send } = setup();
  await send('glenn@jg.com', '/api/c/jg/items/1/files', 'bio.pdf', PDF);
  const id = sqlite.prepare('SELECT id FROM item_files').get().id;
  assert.equal((await call('dana@safe.org', '/api/c/jg/items/1/files/' + id)).status, 404);
  assert.equal((await call('dana@safe.org', '/api/c/safe/items/1/files/' + id)).status, 404);
  assert.equal((await send('dana@safe.org', '/api/c/jg/items/1/files', 'x.pdf', PDF)).status, 404);
  // An item of another client, through this client's slug.
  assert.equal((await send('glenn@jg.com', '/api/c/jg/items/3/files', 'x.pdf', PDF)).status, 404);
  assert.equal((await call('dana@safe.org', '/api/c/jg/items/1/files/' + id, 'DELETE')).status, 404);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM item_files').get().n, 1);
});

test('the server refuses the wrong kinds, sizes and places', async () => {
  const { send, sqlite } = setup();
  assert.equal((await send('glenn@jg.com', '/api/c/jg/items/1/files', 'page.html', enc('<html></html>'))).status, 400);
  assert.equal((await send('glenn@jg.com', '/api/c/jg/items/1/files', 'bio.docx', PDF)).status, 400);
  assert.equal((await send('glenn@jg.com', '/api/c/jg/items/1/files', 'empty.pdf', new Uint8Array(0))).status, 400);
  assert.equal((await send('glenn@jg.com', '/api/c/jg/items/1/files', '', PDF)).status, 400);
  assert.equal((await send('glenn@jg.com', '/api/c/jg/items/1/files', 'big.pdf', PDF, { 'content-length': String(26 * 1024 * 1024) })).status, 413);
  assert.equal((await send('glenn@jg.com', '/api/c/jg/items/2/files', 'late.pdf', PDF)).status, 409, 'closed item');
  const noOrigin = await send('glenn@jg.com', '/api/c/jg/items/1/files', 'bio.pdf', PDF, { origin: 'https://evil.example' });
  assert.equal(noOrigin.status, 403);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM item_files').get().n, 0);
});

test('at most ten files on an item', async () => {
  const { send } = setup();
  for (let n = 0; n < MAX_FILES; n++) assert.equal((await send('glenn@jg.com', '/api/c/jg/items/1/files', `f${n}.pdf`, PDF)).status, 201);
  assert.equal((await send('glenn@jg.com', '/api/c/jg/items/1/files', 'one-more.pdf', PDF)).status, 400);
});

test('only the person who added a file, or Positive Tribes, removes it; removing deletes the stored file', async () => {
  const { sqlite, call, send, FILES } = setup();
  await send('glenn@jg.com', '/api/c/jg/items/1/files', 'a.pdf', PDF);
  await send('glenn@jg.com', '/api/c/jg/items/1/files', 'b.pdf', PDF);
  const [a, b] = sqlite.prepare('SELECT id, r2_key FROM item_files ORDER BY id').all();
  assert.equal((await call('joe@jg.com', '/api/c/jg/items/1/files/' + a.id, 'DELETE')).status, 403);
  assert.equal((await call('glenn@jg.com', '/api/c/jg/items/1/files/' + a.id, 'DELETE')).status, 200);
  assert.equal(FILES.files.has(a.r2_key), false);
  assert.equal((await call('eric@positivetribes.org', '/api/c/jg/items/1/files/' + b.id, 'DELETE')).status, 200);
  assert.equal(FILES.files.size, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM item_files').get().n, 0);
});

test('deleting an item deletes its files', async () => {
  const { sqlite, call, send, FILES } = setup();
  await send('glenn@jg.com', '/api/c/jg/items/1/files', 'a.pdf', PDF);
  assert.equal(FILES.files.size, 1);
  assert.equal((await call('eric@positivetribes.org', '/api/c/jg/items/1', 'DELETE')).status, 200);
  assert.equal(FILES.files.size, 0);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM item_files').get().n, 0);
});

test('without the bucket, adding a file says so', async () => {
  const { env, send } = setup();
  delete env.FILES;
  assert.equal((await send('glenn@jg.com', '/api/c/jg/items/1/files', 'a.pdf', PDF)).status, 503);
});
