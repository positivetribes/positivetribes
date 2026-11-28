// Client photos: banner photos that take turns at the top of the client's home page, and a strip of up to three photos
// near its foot (migration 0044).
// Bytes live in the private R2 bucket bound as PHOTOS, keyed <client_id>/<uuid>.jpg; rows in client_photos.
// Anyone who can see the client sees the photos (scope() in index.js checks that before any call here); only Positive
// Tribes adds, edits or removes them, and only Positive Tribes sees the consent note. JPEG only: the browser re-draws
// each photo before upload, and stripJpeg() below drops any metadata (location, camera, captions) that is left.
import { InputError } from './triage.js';

export const MAX_PHOTO_BYTES = 4000000, MAX_PHOTOS = 30, MAX_BANNERS = 15, STRIP_SHOWN = 3;
const ROLES = ['banner', 'strip'];
const FOCUS = ['top', 'upper', 'center', 'lower', 'bottom'];

// Rebuilds a JPEG without metadata segments. Keeps only what decoding needs: APP0 (JFIF), APP2 (colour profile),
// APP14 (Adobe colour transform) and the image segments. Drops APP1 (EXIF and XMP, where GPS lives), APP13 (IPTC
// captions and names), the other APPn segments and comments. Returns null if the file is not a well-formed JPEG.
export function stripJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const out = [bytes.subarray(0, 2)];
  let i = 2;
  while (i < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    while (i < bytes.length && bytes[i] === 0xff) i++; // fill bytes
    if (i >= bytes.length) return null;
    const marker = bytes[i];
    const start = i - 1;
    i++;
    // Start of scan: the compressed image follows to the end; keep the rest as it is.
    if (marker === 0xda) { out.push(Uint8Array.of(0xff), bytes.subarray(start + 1)); break; }
    if (marker === 0xd9) { out.push(Uint8Array.of(0xff, 0xd9)); break; }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) return null; // not expected before the scan
    if (i + 2 > bytes.length) return null;
    const length = (bytes[i] << 8) | bytes[i + 1];
    if (length < 2 || i + length > bytes.length) return null;
    const drop = (marker >= 0xe0 && marker <= 0xef && ![0xe0, 0xe2, 0xee].includes(marker)) || marker === 0xfe;
    if (!drop) out.push(Uint8Array.of(0xff, marker), bytes.subarray(i, i + length));
    i += length;
  }
  const size = out.reduce((n, part) => n + part.length, 0);
  const clean = new Uint8Array(size);
  let at = 0;
  for (const part of out) { clean.set(part, at); at += part.length; }
  return clean;
}

const isPt = user => user.role === 'pt';
const text = (value, max, name) => {
  const v = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (!v) throw new InputError(`Add ${name}.`);
  if (v.length > max) throw new InputError(`Keep ${name} under ${max} characters.`);
  return v;
};
const roleOf = v => { if (!ROLES.includes(v)) throw new InputError('Choose banner or strip.'); return v; };
const focusOf = v => { if (!FOCUS.includes(v)) throw new InputError('Choose top, upper, center, lower or bottom.'); return v; };

// What the client's page needs. Positive Tribes also gets the consent note and when it was added.
export async function listPhotos(db, clientId, user) {
  const { results } = await db.prepare(
    'SELECT id, role, alt, focus, position, consent, added_email, created_at FROM client_photos WHERE client_id = ? ORDER BY role, position, id'
  ).bind(clientId).all();
  return results.map(({ consent, added_email, created_at, ...p }) => (isPt(user) ? { ...p, consent, added_email, created_at } : p));
}

// Banner photos take turns on the home page, in position order; a client can have up to MAX_BANNERS of them.
async function roomForBanner(db, clientId) {
  const banners = await db.prepare("SELECT COUNT(*) AS n FROM client_photos WHERE client_id = ? AND role = 'banner'").bind(clientId).first();
  if (banners.n >= MAX_BANNERS) throw new InputError(`A client can have at most ${MAX_BANNERS} banner photos. Move one to the strip or remove one first.`);
}

async function requirePhoto(db, clientId, value) {
  const id = Number(value);
  const photo = Number.isSafeInteger(id) && id > 0 && await db.prepare('SELECT * FROM client_photos WHERE id = ? AND client_id = ?').bind(id, clientId).first();
  if (!photo) throw new InputError('Photo not found.', 404);
  return photo;
}

// Routes under /api/c/<slug>/photos. `client` is already scoped to this person.
//   GET    /photos            list (everyone who can see the client)
//   GET    /photos/:id        the image (same)
//   POST   /photos?role=&alt=&focus=&consent=   JPEG body (Positive Tribes only)
//   PATCH  /photos/:id        { role, alt, focus, position } (Positive Tribes only)
//   DELETE /photos/:id        removes the row and the stored file (Positive Tribes only)
export async function handlePhotos({ db, env, request, url, user, client, photoId }) {
  const method = request.method;
  if (!photoId && method === 'GET') return { json: { photos: await listPhotos(db, client.id, user) } };

  if (photoId && method === 'GET') {
    const photo = await requirePhoto(db, client.id, photoId);
    const object = env.PHOTOS && await env.PHOTOS.get(photo.r2_key);
    if (!object) throw new InputError('Photo not found.', 404);
    return { response: new Response(object.body, { headers: {
      'content-type': 'image/jpeg', 'cache-control': 'private, max-age=86400', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'", 'content-disposition': 'inline'
    } }) };
  }

  if (!isPt(user)) throw new InputError('Only Positive Tribes can change photos.', 403);
  if (!env.PHOTOS) throw new InputError('Photo storage is not set up here.', 503);

  if (!photoId && method === 'POST') {
    const q = url.searchParams;
    const role = roleOf(q.get('role'));
    const alt = text(q.get('alt'), 200, 'a short description of the photo');
    const consent = text(q.get('consent'), 300, 'who gave permission to use it, and when');
    const focus = focusOf(q.get('focus') || 'center');
    const raw = new Uint8Array(await request.arrayBuffer());
    if (!raw.length) throw new InputError('Choose a photo to add.');
    if (raw.length > MAX_PHOTO_BYTES) throw new InputError('That photo is too large. Try a smaller one.', 413);
    const clean = stripJpeg(raw);
    if (!clean) throw new InputError('Photos must be JPEG images.');
    const count = await db.prepare('SELECT COUNT(*) AS n FROM client_photos WHERE client_id = ?').bind(client.id).first();
    if (count.n >= MAX_PHOTOS) throw new InputError(`A client can have at most ${MAX_PHOTOS} photos. Remove one first.`);
    if (role === 'banner') await roomForBanner(db, client.id);
    const key = `${client.id}/${crypto.randomUUID()}.jpg`;
    await env.PHOTOS.put(key, clean, { httpMetadata: { contentType: 'image/jpeg' } });
    const next = await db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM client_photos WHERE client_id = ? AND role = ?').bind(client.id, role).first();
    try {
      await db.batch([
        db.prepare('INSERT INTO client_photos (client_id, r2_key, type, bytes, role, alt, focus, position, consent, added_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(client.id, key, 'image/jpeg', clean.length, role, alt, focus, next.n, consent, user.email)
      ]);
    } catch (error) {
      await env.PHOTOS.delete(key); // no row, no orphaned file
      throw error;
    }
    return { json: { ok: true, photos: await listPhotos(db, client.id, user) }, status: 201 };
  }

  const photo = photoId && await requirePhoto(db, client.id, photoId);
  if (photo && method === 'PATCH') {
    const b = await request.json().catch(() => { throw new InputError('Send JSON.'); });
    const alt = b.alt === undefined ? photo.alt : text(b.alt, 200, 'a short description of the photo');
    const focus = b.focus === undefined ? photo.focus : focusOf(b.focus);
    const position = b.position === undefined ? photo.position : Number(b.position);
    if (!Number.isSafeInteger(position) || position < 0 || position > 1000) throw new InputError('Choose a position from 0 to 1000.');
    const role = b.role === undefined ? photo.role : roleOf(b.role);
    if (role === 'banner' && photo.role !== 'banner') await roomForBanner(db, client.id);
    await db.prepare('UPDATE client_photos SET role = ?, alt = ?, focus = ?, position = ? WHERE id = ? AND client_id = ?').bind(role, alt, focus, position, photo.id, client.id).run();
    return { json: { ok: true, photos: await listPhotos(db, client.id, user) } };
  }
  if (photo && method === 'DELETE') {
    await db.prepare('DELETE FROM client_photos WHERE id = ? AND client_id = ?').bind(photo.id, client.id).run();
    await env.PHOTOS.delete(photo.r2_key);
    return { json: { ok: true, photos: await listPhotos(db, client.id, user) } };
  }
  return { json: { error: 'Not found.' }, status: 404 };
}
