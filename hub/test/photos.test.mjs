import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { stripJpeg } from '../src/photos.js';
import { database } from './helpers.mjs';

// A fake R2 bucket: enough of get/put/delete for the photo routes.
function bucket() {
  const files = new Map();
  return {
    files,
    async put(key, bytes) { files.set(key, new Uint8Array(bytes)); },
    async get(key) { const b = files.get(key); return b ? { body: b } : null; },
    async delete(key) { files.delete(key); }
  };
}

function setup() {
  const { sqlite, db } = database();
  for (const file of ['0001_init.sql', '0002_legacy_ids.sql', '0003_releases.sql', '0004_release_url.sql', '0005_release_script.sql', '0006_release_window.sql', '0007_project_live_url.sql', '0008_documents.sql', '0009_hub_ideas.sql', '0010_hub_idea_images.sql', '0011_documents_for_everyone.sql', '0012_notifications.sql', '0013_notification_clear.sql', '0014_last_seen.sql', '0015_care_plans.sql', '0016_patch_triage.sql', '0017_document_date.sql', '0018_client_salesforce_url.sql', '0019_project_has_prototype.sql', '0020_client_logo.sql', '0021_client_logo_soberaf.sql', '0022_project_next_note.sql', '0023_item_status.sql', '0024_patch_replies.sql', '0025_item_releases.sql', '0026_change_estimates.sql', '0027_donated_changes.sql', '0028_estimate_lines.sql', '0029_agreement_ref.sql', '0031_item_proposal.sql', '0033_timeline.sql', '0037_item_images.sql', '0041_item_asks_back.sql', '0043_client_email.sql', '0044_client_photos.sql']) sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  sqlite.exec(`
    INSERT INTO clients (slug, name) VALUES ('uep', 'UEP'), ('safe', 'Sober AF');
    INSERT INTO projects (client_id, slug, name) VALUES (1, 'scheduler', 'Scheduler');
    INSERT INTO users (email, name, role, client_id) VALUES
      ('molly@uep.org', 'Molly', 'ed', 1), ('eric@positivetribes.org', 'Eric', 'pt', NULL), ('dana@safe.org', 'Dana', 'ed', 2), ('tammie@uep.org', 'Tammie', 'staff', 1);
  `);
  const PHOTOS = bucket();
  const env = { DB: db, PHOTOS, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') } };
  const call = (who, path, method = 'GET', payload) => worker.fetch(new Request('http://localhost' + path, {
    method, headers: { 'x-dev-email': who, 'content-type': 'application/json', ...(method !== 'GET' ? { origin: 'http://localhost' } : {}) },
    body: payload ? JSON.stringify(payload) : undefined
  }), env);
  const send = (who, query, bytes) => worker.fetch(new Request('http://localhost/api/c/uep/photos?' + new URLSearchParams(query), {
    method: 'POST', headers: { 'x-dev-email': who, 'content-type': 'image/jpeg', origin: 'http://localhost' }, body: bytes
  }), env);
  return { sqlite, call, send, PHOTOS };
}

const seg = (marker, payload) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
const ascii = t => [...new TextEncoder().encode(t)];
// SOI, JFIF, EXIF with a fake GPS string, IPTC, a comment, a quant table, then the scan and EOI.
const jpeg = Uint8Array.from([0xff, 0xd8, ...seg(0xe0, ascii('JFIF\0')), ...seg(0xe1, ascii('Exif\0\0GPS 39.7N 105.0W')), ...seg(0xed, ascii('Photoshop 3.0 Molly Smith')),
  ...seg(0xfe, ascii('taken at home')), ...seg(0xdb, [0, 1, 2, 3]), 0xff, 0xda, 0, 4, 9, 9, 0x12, 0x34, 0xff, 0xd9]);
const has = (bytes, t) => Buffer.from(bytes).includes(Buffer.from(t));

test('stripJpeg keeps the image and drops location, captions and comments', () => {
  const clean = stripJpeg(jpeg);
  assert.ok(has(clean, 'JFIF'));
  for (const t of ['GPS', 'Molly', 'taken at home']) assert.ok(!has(clean, t), t);
  // The quant table, the scan and the end marker come through unchanged.
  assert.ok(Buffer.from(clean).includes(Buffer.from([0xff, 0xdb, 0, 6, 0, 1, 2, 3])));
  assert.deepEqual([...clean.slice(-10)], [0xff, 0xda, 0, 4, 9, 9, 0x12, 0x34, 0xff, 0xd9]);
  assert.equal(stripJpeg(new TextEncoder().encode('<svg onload=alert(1)>')), null);
  assert.equal(stripJpeg(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(stripJpeg(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1])), null); // length runs past the end
});

test('client photos: only Positive Tribes adds them, only the client and Positive Tribes see them', async () => {
  const { call, send, sqlite, PHOTOS } = setup();
  const meta = { role: 'banner', alt: 'A climber smiling on the rope', consent: 'Molly, by email Nov 27, 2026', focus: 'upper' };
  // Clients cannot add photos, even to their own workspace; another client cannot reach it at all.
  assert.equal((await send('molly@uep.org', meta, jpeg)).status, 403);
  assert.equal((await send('dana@safe.org', meta, jpeg)).status, 404);
  // Description and permission are required; only real JPEGs; size capped.
  assert.equal((await send('eric@positivetribes.org', { ...meta, consent: '' }, jpeg)).status, 400);
  assert.equal((await send('eric@positivetribes.org', { ...meta, alt: '' }, jpeg)).status, 400);
  assert.equal((await send('eric@positivetribes.org', { ...meta, role: 'hero' }, jpeg)).status, 400);
  assert.equal((await send('eric@positivetribes.org', meta, new TextEncoder().encode('<script>alert(1)</script>'))).status, 400);
  assert.equal((await send('eric@positivetribes.org', meta, new Uint8Array(4000001))).status, 413);
  assert.equal(PHOTOS.files.size, 0);

  const r = await send('eric@positivetribes.org', meta, jpeg);
  assert.equal(r.status, 201);
  const [photo] = (await r.json()).photos;
  assert.equal(photo.consent, meta.consent);
  // Stored under the client's own id, without the metadata.
  const [key] = [...PHOTOS.files.keys()];
  assert.match(key, /^1\/[0-9a-f-]{36}\.jpg$/);
  assert.ok(!has(PHOTOS.files.get(key), 'GPS'));

  // The client's people see it in the home payload, without the permission note or who added it.
  const molly = await (await call('tammie@uep.org', '/api/c/uep/projects')).json();
  assert.deepEqual(molly.photos, [{ id: photo.id, role: 'banner', alt: meta.alt, focus: 'upper', position: 1 }]);
  const got = await call('tammie@uep.org', '/api/c/uep/photos/' + photo.id);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'image/jpeg');
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('cache-control'), /^private/);
  // Another client gets nothing, by either slug.
  assert.equal((await call('dana@safe.org', '/api/c/uep/photos/' + photo.id)).status, 404);
  assert.equal((await call('dana@safe.org', '/api/c/safe/photos/' + photo.id)).status, 404);
  assert.deepEqual((await (await call('dana@safe.org', '/api/c/safe/projects')).json()).photos, []);

  // A second banner replaces the first, which moves to the strip.
  const second = (await (await send('eric@positivetribes.org', { ...meta, alt: 'Four climbers arm in arm' }, jpeg)).json()).photos;
  assert.deepEqual(second.map(p => [p.alt, p.role]), [['Four climbers arm in arm', 'banner'], [meta.alt, 'strip']]);
  // Clients cannot edit or remove; Positive Tribes can.
  assert.equal((await call('molly@uep.org', '/api/c/uep/photos/' + photo.id, 'PATCH', { alt: 'x' })).status, 403);
  assert.equal((await call('molly@uep.org', '/api/c/uep/photos/' + photo.id, 'DELETE')).status, 403);
  const moved = (await (await call('eric@positivetribes.org', '/api/c/uep/photos/' + photo.id, 'PATCH', { role: 'banner', focus: 'top' })).json()).photos;
  assert.deepEqual(moved.map(p => [p.id, p.role, p.focus]).find(p => p[0] === photo.id), [photo.id, 'banner', 'top']);
  assert.equal(moved.filter(p => p.role === 'banner').length, 1);
  assert.equal((await call('eric@positivetribes.org', '/api/c/uep/photos/' + photo.id, 'PATCH', { focus: 'sideways' })).status, 400);
  assert.equal((await call('eric@positivetribes.org', '/api/c/uep/photos/' + photo.id, 'DELETE')).status, 200);
  assert.equal(PHOTOS.files.size, 1);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM client_photos').get().n, 1);
  assert.equal((await call('molly@uep.org', '/api/c/uep/photos/' + photo.id)).status, 404);
});

test('client photos: at most nine per client', async () => {
  const { send } = setup();
  const meta = { role: 'strip', alt: 'Climbers', consent: 'Molly, Nov 27, 2026' };
  for (let n = 0; n < 9; n++) assert.equal((await send('eric@positivetribes.org', meta, jpeg)).status, 201);
  assert.equal((await send('eric@positivetribes.org', meta, jpeg)).status, 400);
});
