// Rosie & Roxy vaccine tracker API. All /api/* requests require the DOGS_PIN secret in x-dogs-pin.
const DOGS = ["Rosie", "Roxy"];
const STATUSES = ["done", "scheduled", "tbd"];

// Applied once, only when the table is empty. Dates are ISO (yyyy-mm-dd).
const seed = [
  ["Rosie","Distemper/Adenovirus type 1&2","2022-09-19","done","Green Mountain Animal Hospital","52.4",""],
  ["Rosie","Parvo Virus","2022-09-19","done","Green Mountain Animal Hospital","",""],
  ["Rosie","Leptospira","2022-09-19","done","Green Mountain Animal Hospital","",""],
  ["Rosie","Rabies","2022-09-19","done","Green Mountain Animal Hospital","",""],
  ["Rosie","Rabies","2025-09-12","done","Mesa Veterinary Hospital","64",""],
  ["Roxy","DA2PPV","2026-05-26","done","Foothills Animal Shelter","",""],
  ["Roxy","Pyrantel Pamoate","2026-05-26","done","Foothills Animal Shelter","",""],
  ["Roxy","Bordetella","2026-05-26","done","Foothills Animal Shelter","",""],
  ["Roxy","Spayed","2026-05-28","done","Foothills Animal Shelter","14.11",""],
  ["Roxy","Rabies","2026-05-28","done","Foothills Animal Shelter","",""],
  ["Roxy","Pyrantel Pamoate","2026-06-11","done","Foothills Animal Shelter","",""],
  ["Roxy","DA2PP","2026-06-11","done","Foothills Animal Shelter","",""],
  ["Rosie","1 of 2: Leptospirosis","2026-06-24","done","Humane Colorado","",""],
  ["Roxy","1 of 2: Leptospirosis","2026-06-24","done","Humane Colorado","",""],
  ["Roxy","DA2PPV","2026-07-02","done","Foothills Animal Shelter","",""],
  ["Roxy","Pyrantel Pamoate","2026-07-02","done","Foothills Animal Shelter","",""],
  ["Rosie","2 of 2: Leptospirosis","2026-07-18","done","Humane Colorado","",""],
  ["Roxy","2 of 2: Leptospirosis","2026-07-18","done","Humane Colorado","",""],
  ["Rosie","Wellness check up","2026-08-01","done","Humane Colorado","60","Teeth extraction needed ~$550"],
  ["Roxy","Wellness check up","2026-08-01","done","Humane Colorado","30",""],
  ["Roxy","Bordetella","2027-05-26","tbd","Foothills Animal Shelter","",""],
  ["Roxy","Rabies","2027-05-28","tbd","Foothills Animal Shelter","",""],
  ["Rosie","Rabies","2028-09-12","tbd","","",""],
  ["Roxy","DA2PPV","2027-07-02","tbd","Foothills Animal Shelter","",""],
  ["Roxy","Pyrantel Pamoate","2027-07-02","tbd","Foothills Animal Shelter","",""]
];

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});

async function ensureSchema(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY AUTOINCREMENT, dog TEXT NOT NULL, item TEXT NOT NULL, date TEXT NOT NULL, status TEXT NOT NULL, vendor TEXT NOT NULL DEFAULT '', weight TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    db.prepare("CREATE TABLE IF NOT EXISTS app_seeds (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
  ]);
  const done = await db.prepare("SELECT 1 FROM app_seeds WHERE name = 'spreadsheet-v1'").first();
  if (done) return;
  const existing = await db.prepare("SELECT COUNT(*) AS n FROM records").first();
  const stmts = [];
  if (!existing.n) {
    for (const r of seed) stmts.push(db.prepare("INSERT INTO records (dog,item,date,status,vendor,weight,notes) VALUES (?,?,?,?,?,?,?)").bind(...r));
  }
  stmts.push(db.prepare("INSERT OR IGNORE INTO app_seeds (name) VALUES ('spreadsheet-v1')"));
  await db.batch(stmts);
}

function clean(body) {
  const text = (v, max) => String(v ?? "").trim().slice(0, max);
  const r = { dog: text(body.dog, 20), item: text(body.item, 120), date: text(body.date, 10), status: text(body.status, 12),
    vendor: text(body.vendor, 120), weight: text(body.weight, 20), notes: text(body.notes, 500) };
  if (!DOGS.includes(r.dog)) return null;
  if (!r.item) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date) || Number.isNaN(Date.parse(r.date))) return null;
  if (!STATUSES.includes(r.status)) return null;
  return r;
}

async function pinOk(request, env) {
  const given = request.headers.get("x-dogs-pin") || "";
  if (!env.DOGS_PIN || !given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([given, env.DOGS_PIN].map(v => crypto.subtle.digest("SHA-256", enc.encode(v))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (!(await pinOk(request, env))) return json({ error: "Wrong or missing PIN." }, 401);
    try {
      await ensureSchema(env.DB);
      const m = url.pathname.match(/^\/api\/records(?:\/(\d+))?$/);
      if (!m) return json({ error: "Not found." }, 404);
      const id = m[1] ? Number(m[1]) : null;
      if (!id && request.method === "GET") {
        const { results } = await env.DB.prepare("SELECT id,dog,item,date,status,vendor,weight,notes FROM records ORDER BY date,id").all();
        return json({ records: results });
      }
      if (!id && request.method === "POST") {
        const body = await request.json().catch(() => null);
        // One request may add the same record for several dogs.
        const list = Array.isArray(body) ? body : [body];
        const rows = list.map(b => b && clean(b));
        if (!rows.length || rows.length > 10 || rows.some(r => !r)) return json({ error: "Check the dog, name, date and status." }, 400);
        await env.DB.batch(rows.map(r => env.DB.prepare("INSERT INTO records (dog,item,date,status,vendor,weight,notes) VALUES (?,?,?,?,?,?,?)").bind(r.dog, r.item, r.date, r.status, r.vendor, r.weight, r.notes)));
        return json({ ok: true }, 201);
      }
      if (id && request.method === "PUT") {
        const r = clean(await request.json().catch(() => ({})));
        if (!r) return json({ error: "Check the dog, name, date and status." }, 400);
        const res = await env.DB.prepare("UPDATE records SET dog=?,item=?,date=?,status=?,vendor=?,weight=?,notes=? WHERE id=?").bind(r.dog, r.item, r.date, r.status, r.vendor, r.weight, r.notes, id).run();
        return res.meta.changes ? json({ ok: true }) : json({ error: "Record not found." }, 404);
      }
      if (id && request.method === "DELETE") {
        await env.DB.prepare("DELETE FROM records WHERE id=?").bind(id).run();
        return json({ ok: true });
      }
      return json({ error: "Method not allowed." }, 405);
    } catch {
      return json({ error: "Something went wrong. Try again." }, 500);
    }
  }
};
