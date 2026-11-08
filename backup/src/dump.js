// Turn a D1 database into a SQL script that `wrangler d1 execute --file` can restore, then gzip and encrypt it.

export function sqlLiteral(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "string") return "'" + v.replaceAll("'", "''") + "'";
  // D1 returns BLOBs as arrays of byte values.
  const bytes = Array.isArray(v) ? v : Array.from(new Uint8Array(v));
  return "X'" + bytes.map((b) => b.toString(16).padStart(2, "0")).join("") + "'";
}

const quoteId = (name) => '"' + String(name).replaceAll('"', '""') + '"';

// Read-only: only SELECTs. Skips SQLite and Cloudflare internal tables. Returns the script and counts, never logs rows.
export async function dumpDatabase(db) {
  const { results: objects } = await db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY rowid")
    .all();
  const tables = objects.filter((o) => o.type === "table");
  const later = objects.filter((o) => o.type !== "table"); // indexes, views, triggers go after the data
  const out = ["PRAGMA defer_foreign_keys=TRUE;"];
  let rowCount = 0;
  for (const t of tables) out.push(t.sql + ";");
  for (const t of tables) {
    const { results } = await db.prepare("SELECT * FROM " + quoteId(t.name)).all();
    for (const row of results) {
      const cols = Object.keys(row);
      out.push("INSERT INTO " + quoteId(t.name) + " (" + cols.map(quoteId).join(", ") + ") VALUES (" + cols.map((c) => sqlLiteral(row[c])).join(", ") + ");");
      rowCount++;
    }
  }
  for (const o of later) out.push(o.sql + ";");
  return { sql: out.join("\n") + "\n", tables: tables.length, rows: rowCount };
}

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}
export const gzip = (bytes) => pipe(bytes, new CompressionStream("gzip"));
export const gunzip = (bytes) => pipe(bytes, new DecompressionStream("gzip"));

const MAGIC = new TextEncoder().encode("TBK1"); // format marker, so a future change can be told apart

async function importKey(keyB64) {
  const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("BACKUP_KEY must be 32 bytes, base64");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

// TBK1 + 12-byte random IV + AES-256-GCM ciphertext.
export async function encrypt(bytes, keyB64) {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  const out = new Uint8Array(MAGIC.length + 12 + ct.length);
  out.set(MAGIC, 0); out.set(iv, MAGIC.length); out.set(ct, MAGIC.length + 12);
  return out;
}

export async function decrypt(bytes, keyB64) {
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) throw new Error("Not a TBK1 backup file");
  const key = await importKey(keyB64);
  const iv = bytes.slice(MAGIC.length, MAGIC.length + 12);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, bytes.slice(MAGIC.length + 12)));
}
