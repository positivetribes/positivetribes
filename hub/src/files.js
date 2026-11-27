// Files attached to backlog items (migration 0045): the documents, logos, headshots and spreadsheets a client sends
// with an answer or a request. Bytes live in the private R2 bucket bound as FILES, keyed
// <client_id>/items/<item_id>/<uuid>; rows in item_files. Anyone who can see the client (scope() and requireItem() in
// index.js check that first) may add files to an open item and download them; the person who added one, or Positive
// Tribes, may remove it. The server decides each file's type from its bytes, not its name, takes only the kinds below,
// and always serves a file as a download (never shown in the hub's own pages), so a planted SVG or HTML file cannot run.
// Files never go to Patch or to Salesforce.
import { InputError, clip, logEvent } from './triage.js';

export const MAX_FILE_BYTES = 25 * 1024 * 1024, MAX_FILES = 10;

// What we take, by extension: the content type we record and how the bytes must look.
const PDF = b => starts(b, '%PDF-');
const ZIP = b => b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;
const PNG = b => b.length > 8 && b[0] === 0x89 && starts(b.subarray(1), 'PNG');
const JPEG = b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const WEBP = b => starts(b, 'RIFF') && starts(b.subarray(8), 'WEBP');
const GIF = b => starts(b, 'GIF87a') || starts(b, 'GIF89a');
const HEIC = b => starts(b.subarray(4), 'ftyp') && ['heic', 'heix', 'heif', 'mif1', 'msf1', 'hevc'].includes(ascii(b.subarray(8, 12)));
const EPS = b => starts(b, '%!PS') || (b.length > 4 && b[0] === 0xc5 && b[1] === 0xd0 && b[2] === 0xd3 && b[3] === 0xc6);
const TEXT = b => !b.includes(0) && utf8(b) !== null;
const SVG = b => { const t = utf8(b.subarray(0, 4096), true); return t !== null && /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE[^>]*>\s*)?<svg[\s>]/i.test(t); };
export const KINDS = {
  pdf: ['application/pdf', PDF],
  ai: ['application/pdf', PDF], // Illustrator files saved with PDF content, as logo files usually are
  eps: ['application/postscript', EPS],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ZIP],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ZIP],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation', ZIP],
  zip: ['application/zip', ZIP],
  png: ['image/png', PNG],
  jpg: ['image/jpeg', JPEG],
  jpeg: ['image/jpeg', JPEG],
  webp: ['image/webp', WEBP],
  gif: ['image/gif', GIF],
  heic: ['image/heic', HEIC],
  heif: ['image/heif', HEIC],
  svg: ['image/svg+xml', SVG],
  txt: ['text/plain', TEXT],
  csv: ['text/csv', TEXT],
  md: ['text/markdown', TEXT]
};
export const ACCEPT = Object.keys(KINDS).map(k => '.' + k).join(',');

function starts(bytes, text) {
  if (bytes.length < text.length) return false;
  for (let i = 0; i < text.length; i++) if (bytes[i] !== text.charCodeAt(i)) return false;
  return true;
}
const ascii = bytes => String.fromCharCode(...bytes);
// Strict UTF-8; `partial` allows a character cut off at the end of a slice.
function utf8(bytes, partial = false) {
  try { return new TextDecoder('utf-8', { fatal: !partial }).decode(bytes); } catch { return null; }
}

// A safe file name: no folders, no control or odd characters, at most 120 characters, keeping its extension.
export function cleanName(value) {
  const base = String(value ?? '').split(/[\\/]/).pop().normalize('NFC')
    .replace(/[\u0000-\u001f\u007f"<>:|?*]/g, '').replace(/\s+/g, ' ').trim().replace(/^\.+/, '');
  if (!base) return '';
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
  const stem = (dot > 0 ? base.slice(0, dot) : base).slice(0, 110).trim() || 'file';
  return ext ? `${stem}.${ext}` : stem;
}

// The file's type from its bytes, given the extension it claims. Null when they do not match or the kind is not taken.
export function fileType(bytes, name) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const kind = Object.hasOwn(KINDS, ext) ? KINDS[ext] : null;
  return kind && kind[1](bytes) ? kind[0] : null;
}

// Files on every item of a client, for listItems: name, size and whether this viewer added each (so they may remove
// it). Never who else did.
export async function filesFor(db, clientId, user) {
  const { results } = await db.prepare(
    `SELECT id, item_id, name, bytes, created_at, lower(added_email) = lower(?) AS mine FROM item_files WHERE client_id = ? ORDER BY id`
  ).bind(String(user?.email || ''), clientId).all();
  const map = new Map();
  for (const { item_id, mine, ...f } of results) {
    if (!map.has(item_id)) map.set(item_id, []);
    map.get(item_id).push({ ...f, mine: Boolean(mine) });
  }
  return map;
}

// The stored files of an item, removed when the item is deleted (rows go in the item's delete batch).
export async function itemFileKeys(db, clientId, itemId) {
  const { results } = await db.prepare('SELECT r2_key FROM item_files WHERE client_id = ? AND item_id = ?').bind(clientId, itemId).all();
  return results.map(r => r.r2_key);
}

const download = name => {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
};

// Routes under /api/c/<slug>/items/<id>/files. `client` and `item` are already scoped to this person.
//   POST   /files?name=<file name>   the file's bytes as the body
//   GET    /files/:fileId            the file, as a download
//   DELETE /files/:fileId            removes the row and the stored file (the person who added it, or Positive Tribes)
// Returns { json, status } or { response }; listItems is passed in so the reply carries the updated items.
export async function handleItemFiles({ db, env, request, url, user, client, item, fileId, listItems }) {
  const method = request.method;
  if (!fileId && method === 'POST') {
    if (!env.FILES) throw new InputError('File storage is not set up here.', 503);
    if (item.done) throw new InputError('This item is closed. Reopen it to add a file.', 409);
    if (Number(request.headers.get('content-length') || 0) > MAX_FILE_BYTES) throw new InputError('That file is too large. Files can be up to 25 MB.', 413);
    const name = cleanName(url.searchParams.get('name'));
    if (!name) throw new InputError('Choose a file to add.');
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length) throw new InputError('That file is empty.');
    if (bytes.length > MAX_FILE_BYTES) throw new InputError('That file is too large. Files can be up to 25 MB.', 413);
    const type = fileType(bytes, name);
    if (!type) throw new InputError('We can take PDF, Word, Excel, PowerPoint, text, CSV, ZIP and image files (PNG, JPEG, HEIC, SVG and the like). Check the file is one of those and its name ends the right way, such as .pdf or .docx.');
    const count = await db.prepare('SELECT COUNT(*) AS n FROM item_files WHERE client_id = ? AND item_id = ?').bind(client.id, item.id).first();
    if (count.n >= MAX_FILES) throw new InputError(`An item can have at most ${MAX_FILES} files. Put the rest in a ZIP file, or remove one first.`);
    const key = `${client.id}/items/${item.id}/${crypto.randomUUID()}`;
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: type } });
    try {
      await db.batch([
        db.prepare('INSERT INTO item_files (client_id, item_id, r2_key, name, type, bytes, added_by, added_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(client.id, item.id, key, name, type, bytes.length, user.name || user.email, user.email),
        // Shows in the command center Inbox, so Positive Tribes sees a file arrive. Clients' bells leave it out.
        logEvent(db, client.id, item.id, 'file_added', item, clip(name, 200), user)
      ]);
    } catch (error) {
      await env.FILES.delete(key); // no row, no orphaned file
      throw error;
    }
    return { json: { ok: true, items: await listItems(db, client.id, user) }, status: 201 };
  }

  const id = Number(fileId);
  const file = fileId && Number.isSafeInteger(id) && id > 0 && await db.prepare('SELECT * FROM item_files WHERE id = ? AND item_id = ? AND client_id = ?')
    .bind(id, item.id, client.id).first();
  if (!file) throw new InputError('File not found.', 404);

  if (method === 'GET') {
    const object = env.FILES && await env.FILES.get(file.r2_key);
    if (!object) throw new InputError('File not found.', 404);
    return { response: new Response(object.body, { headers: {
      // Always a download: the browser never renders it inside the hub.
      'content-type': 'application/octet-stream', 'content-disposition': download(file.name), 'content-length': String(file.bytes),
      'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox"
    } }) };
  }
  if (method === 'DELETE') {
    if (user.role !== 'pt' && String(file.added_email).toLowerCase() !== String(user.email).toLowerCase()) {
      throw new InputError('Only the person who added this file, or Positive Tribes, can remove it.', 403);
    }
    await db.prepare('DELETE FROM item_files WHERE id = ? AND client_id = ?').bind(file.id, client.id).run();
    if (env.FILES) await env.FILES.delete(file.r2_key);
    return { json: { ok: true, items: await listItems(db, client.id, user) } };
  }
  return { json: { error: 'Not found.' }, status: 404 };
}
