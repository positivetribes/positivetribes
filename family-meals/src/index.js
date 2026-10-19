import { validDate, addDays, weekDates } from '../public/planner.js';

// Applied once per database, only when there are no existing family meals.
const starterMeals = [
  [
    "Tacos",
    "Build your own with seasoned beef or black beans, lettuce, cheese, salsa, and tortillas."
  ],
  [
    "Spaghetti and Meatballs",
    "Serve with marinara, a green salad, and garlic bread; use beef or turkey meatballs."
  ],
  [
    "Grilled Chicken",
    "Pair with roasted potatoes and broccoli; season simply with lemon and herbs."
  ],
  [
    "Burgers",
    "Beef, turkey, or bean patties with favorite toppings, oven fries, and veggie sticks."
  ],
  [
    "Chicken Stir-Fry",
    "Toss chicken and colorful vegetables in a mild ginger-soy sauce; serve over rice."
  ],
  [
    "Homemade Pizza",
    "Use ready-made dough and let everyone choose cheese, vegetables, or pepperoni."
  ],
  [
    "Baked Salmon",
    "Serve lemon-baked salmon with rice and green beans."
  ],
  [
    "Chicken Fajitas",
    "Sizzle chicken, peppers, and onions; serve with warm tortillas and avocado."
  ],
  [
    "Baked Ziti",
    "Bake pasta with marinara, ricotta, and mozzarella; add spinach and a side salad."
  ],
  [
    "Pulled Pork Sandwiches",
    "Slow-cook pork with mild barbecue sauce; serve on buns with slaw and corn."
  ],
  [
    "Chicken Caesar Wraps",
    "Wrap cooked chicken, romaine, Parmesan, and Caesar dressing in tortillas; add fruit."
  ],
  [
    "Beef or Chicken Rice Bowls",
    "Top rice with beef or chicken, cucumber, carrots, and a favorite mild sauce."
  ],
  [
    "Breakfast for Dinner",
    "Scrambled eggs, pancakes, fresh fruit, and breakfast potatoes."
  ],
  [
    "Chili",
    "Make a mild beef-and-bean or all-bean chili; serve with cornbread and cheese."
  ],
  [
    "Cheese and Bean Quesadillas",
    "Fill tortillas with cheese and black beans; serve with salsa, avocado, and corn."
  ]
];
const starterMealsVersion = "family-dinners-v1";
const rosterSeedVersion = "family-members-v1";

const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store"}});
async function ensureSchema(db){await db.batch([
db.prepare("CREATE TABLE IF NOT EXISTS meals (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,notes TEXT DEFAULT '',recipe_url TEXT DEFAULT '',suggested_by TEXT DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
db.prepare("CREATE TABLE IF NOT EXISTS ratings (id INTEGER PRIMARY KEY AUTOINCREMENT,meal_id INTEGER NOT NULL,member TEXT NOT NULL,rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),comment TEXT DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(meal_id,member))"),
db.prepare("CREATE TABLE IF NOT EXISTS meal_votes (id INTEGER PRIMARY KEY AUTOINCREMENT,meal_id INTEGER NOT NULL,member TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,UNIQUE(meal_id,member))"),
db.prepare("CREATE TABLE IF NOT EXISTS app_seeds (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
db.prepare("CREATE TABLE IF NOT EXISTS plan_revision (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL DEFAULT 0)"),
db.prepare("INSERT OR IGNORE INTO plan_revision (id,revision) VALUES (1,0)"),
db.prepare("CREATE TABLE IF NOT EXISTS meal_details (meal_id INTEGER PRIMARY KEY,tags TEXT NOT NULL DEFAULT '[]',ingredients TEXT NOT NULL DEFAULT '[]')"),
db.prepare("CREATE TABLE IF NOT EXISTS grocery_items (id INTEGER PRIMARY KEY AUTOINCREMENT,week_start TEXT NOT NULL,label TEXT NOT NULL,checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)))"),
db.prepare("CREATE TABLE IF NOT EXISTS grocery_checks (week_start TEXT NOT NULL,item_key TEXT NOT NULL,checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)),PRIMARY KEY(week_start,item_key))"),
db.prepare("CREATE INDEX IF NOT EXISTS grocery_items_week ON grocery_items(week_start)"),
db.prepare("CREATE TABLE IF NOT EXISTS family_members (name TEXT PRIMARY KEY COLLATE NOCASE,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
db.prepare("CREATE TABLE IF NOT EXISTS family_claims (name TEXT PRIMARY KEY COLLATE NOCASE,claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
db.prepare("CREATE TABLE IF NOT EXISTS dinner_absences (plan_date TEXT NOT NULL,member TEXT NOT NULL COLLATE NOCASE,PRIMARY KEY(plan_date,member))"),
db.prepare("CREATE TABLE IF NOT EXISTS lists (id INTEGER PRIMARY KEY AUTOINCREMENT,owner TEXT NOT NULL DEFAULT '' COLLATE NOCASE,shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0,1)),name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('grocery','basic')),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
db.prepare("CREATE TABLE IF NOT EXISTS list_items (id INTEGER PRIMARY KEY AUTOINCREMENT,list_id INTEGER NOT NULL,label TEXT NOT NULL,store TEXT NOT NULL DEFAULT '',checked INTEGER NOT NULL DEFAULT 0 CHECK(checked IN (0,1)),created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
db.prepare("CREATE INDEX IF NOT EXISTS list_items_list ON list_items(list_id)"),
db.prepare("CREATE TABLE IF NOT EXISTS grocery_labels (week_start TEXT NOT NULL,item_key TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(week_start,item_key))"),
db.prepare("CREATE TABLE IF NOT EXISTS grocery_stores (week_start TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('generated','manual')),item_key TEXT NOT NULL,store TEXT NOT NULL,PRIMARY KEY(week_start,kind,item_key))"),
db.prepare("CREATE TABLE IF NOT EXISTS weekly_plan (plan_date TEXT PRIMARY KEY,meal_id INTEGER,note TEXT DEFAULT '',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
db.prepare("CREATE TABLE IF NOT EXISTS chores (id INTEGER PRIMARY KEY AUTOINCREMENT,title TEXT NOT NULL,repeat TEXT NOT NULL CHECK(repeat IN ('once','daily','weekly')),days TEXT NOT NULL DEFAULT '[]',start_date TEXT NOT NULL,assignees TEXT NOT NULL DEFAULT '[]',created_by TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
db.prepare("CREATE TABLE IF NOT EXISTS chore_done (chore_id INTEGER NOT NULL,due_date TEXT NOT NULL,done_by TEXT NOT NULL,done_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,PRIMARY KEY(chore_id,due_date))")
]);
// Lists made before lists belonged to a profile have no owner column yet.
if (!(await db.prepare("SELECT 1 FROM pragma_table_info('lists') WHERE name='owner'").first()))
  await db.prepare("ALTER TABLE lists ADD COLUMN owner TEXT NOT NULL DEFAULT '' COLLATE NOCASE").run();
if (!(await db.prepare("SELECT 1 FROM pragma_table_info('lists') WHERE name='shared'").first()))
  await db.prepare("ALTER TABLE lists ADD COLUMN shared INTEGER NOT NULL DEFAULT 0 CHECK(shared IN (0,1))").run();
// D1 batches are transactional. Keep the empty-table check, all 15 inserts,
// and the marker together so simultaneous first requests cannot seed twice.
// Record the marker for existing databases too; never replace family content.
await db.batch([
  db.prepare(`
    WITH starter_meals(name, notes) AS (
      VALUES ${starterMeals.map(() => "(?, ?)").join(", ")}
    )
    INSERT INTO meals (name, notes)
    SELECT name, notes FROM starter_meals
    WHERE NOT EXISTS (SELECT 1 FROM meals)
      AND NOT EXISTS (SELECT 1 FROM app_seeds WHERE name = ?)
  `).bind(...starterMeals.flat(), starterMealsVersion),
  db.prepare("INSERT OR IGNORE INTO app_seeds (name) VALUES (?)").bind(starterMealsVersion)
]);
// Start the family list from names already used on ratings and votes, once. Removing someone later sticks.
await db.batch([
  db.prepare(`INSERT OR IGNORE INTO family_members (name)
    SELECT DISTINCT member FROM (SELECT member FROM ratings UNION SELECT member FROM meal_votes)
    WHERE trim(member)<>'' AND NOT EXISTS (SELECT 1 FROM app_seeds WHERE name=?)`).bind(rosterSeedVersion),
  db.prepare("INSERT OR IGNORE INTO app_seeds (name) VALUES (?)").bind(rosterSeedVersion)
]);
}

class InputError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const text = (value, max = 2000) => {
  if (value != null && typeof value !== 'string') throw new InputError('Expected text.');
  const result = (value || '').trim();
  if (result.length > max) throw new InputError(`Text must be at most ${max} characters.`);
  return result;
};
async function body(request) {
  let result;
  try { result = await request.json(); } catch { throw new InputError('Invalid JSON.'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new InputError('Expected an object.');
  return result;
}
function list(value, limit, max, lower = false) {
  if (!Array.isArray(value) || value.length > limit) throw new InputError(`Use at most ${limit} items.`);
  return [...new Set(value.map(item => {
    const entry = text(item, max);
    return lower ? entry.toLowerCase() : entry;
  }).filter(Boolean))];
}
function mealInput(b) {
  const name = text(b.name, 80);
  if (!name) throw new InputError('Meal name is required.');
  const recipe = text(b.recipe_url, 2000);
  if (recipe) {
    let url;
    try { url = new URL(recipe); } catch { throw new InputError('Use a valid recipe URL.'); }
    if (!['https:', 'http:'].includes(url.protocol)) throw new InputError('Recipe links must use https or http.');
  }
  return { name, recipe, notes: text(b.notes), tags: b.tags === undefined ? undefined : list(b.tags, 12, 40, true),
    ingredients: b.ingredients === undefined ? undefined : list(b.ingredients, 80, 200) };
}
async function requireMeal(db, value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new InputError('Valid meal ID required.');
  if (!await db.prepare('SELECT id FROM meals WHERE id=?').bind(id).first()) throw new InputError('Meal not found.', 404);
  return id;
}
function detailsStatement(db, id, input) {
  return db.prepare(`INSERT INTO meal_details (meal_id,tags,ingredients) VALUES (?,COALESCE(?, '[]'),COALESCE(?, '[]'))
    ON CONFLICT(meal_id) DO UPDATE SET tags=COALESCE(?,meal_details.tags),ingredients=COALESCE(?,meal_details.ingredients)`)
    .bind(id, input.tags === undefined ? null : JSON.stringify(input.tags), input.ingredients === undefined ? null : JSON.stringify(input.ingredients),
      input.tags === undefined ? null : JSON.stringify(input.tags), input.ingredients === undefined ? null : JSON.stringify(input.ingredients));
}
async function requireMember(db, value) {
  const name = text(value, 30);
  const row = name && await db.prepare('SELECT name FROM family_members WHERE name=?').bind(name).first();
  if (!row) throw new InputError('Family member not found.', 404);
  return row.name;
}
const rows = async (db, sql, ...values) => (await db.prepare(sql).bind(...values).all()).results;
async function summary(db) {
  const meals = await rows(db, `SELECT m.*,COALESCE(d.tags,'[]') tags,COALESCE(d.ingredients,'[]') ingredients,
    (SELECT ROUND(AVG(rating),1) FROM ratings WHERE meal_id=m.id) average_rating,
    (SELECT COUNT(*) FROM ratings WHERE meal_id=m.id) rating_count,
    (SELECT COUNT(*) FROM meal_votes WHERE meal_id=m.id) vote_count
    FROM meals m LEFT JOIN meal_details d ON d.meal_id=m.id ORDER BY COALESCE(average_rating,0) DESC,m.id`);
  return { plan_revision: (await db.prepare('SELECT revision FROM plan_revision WHERE id=1').first()).revision, meals: meals.map(m => ({ ...m, tags: JSON.parse(m.tags), ingredients: JSON.parse(m.ingredients) })),
    ratings: await rows(db, 'SELECT * FROM ratings ORDER BY created_at DESC'),
    votes: await rows(db, 'SELECT * FROM meal_votes'),
    plan: await rows(db, `SELECT p.*,m.name meal_name FROM weekly_plan p LEFT JOIN meals m ON m.id=p.meal_id ORDER BY p.plan_date`),
    members: (await rows(db, 'SELECT name FROM family_members ORDER BY created_at,rowid')).map(r => r.name),
    // Names nobody has picked as their own yet, offered to people opening the app for the first time.
    unclaimed: (await rows(db, 'SELECT m.name FROM family_members m WHERE NOT EXISTS (SELECT 1 FROM family_claims c WHERE c.name=m.name) ORDER BY m.created_at,m.rowid')).map(r => r.name),
    absences: await rows(db, 'SELECT plan_date,member FROM dinner_absences ORDER BY plan_date,member') };
}
function weekStart(value) {
  if (!validDate(value) || new Date(value + 'T12:00:00Z').getUTCDay() !== 1) throw new InputError('A valid Monday is required.');
  return value;
}
async function planInput(db, b) {
  if (!validDate(b.plan_date)) throw new InputError('Valid plan date required.');
  return { plan_date: b.plan_date, meal_id: b.meal_id === null || b.meal_id === '' || b.meal_id === undefined ? null : await requireMeal(db, b.meal_id), note: text(b.note, 500) };
}
const planStatement = (db, p) => db.prepare(`INSERT INTO weekly_plan (plan_date,meal_id,note) VALUES (?,?,?)
  ON CONFLICT(plan_date) DO UPDATE SET meal_id=excluded.meal_id,note=excluded.note,updated_at=CURRENT_TIMESTAMP`).bind(p.plan_date, p.meal_id, p.note);
const itemKey = label => label.trim().replace(/\s+/g, ' ').toLowerCase();
const storeName = value => text(value, 40).replace(/\s+/g, ' ');
// Reuse the spelling already in use ("costco" becomes "Costco") so filters do not split.
// Custom lists are private to their owner, so only the shared weekly stores and that owner's own list stores are consulted.
async function canonicalStore(db, name, owner = null) {
  if (!name) return '';
  const existing = await db.prepare(`SELECT store FROM (SELECT store,0 src,rowid r FROM grocery_stores UNION ALL
      SELECT i.store,1 src,i.id r FROM list_items i JOIN lists l ON l.id=i.list_id WHERE i.store<>'' AND (l.owner=? OR l.shared=1))
    WHERE lower(store)=lower(?) ORDER BY src,r LIMIT 1`).bind(owner ?? '', name).first();
  return existing ? existing.store : name;
}
const storeStatement = (db, start, kind, key, store) => store
  ? db.prepare(`INSERT INTO grocery_stores (week_start,kind,item_key,store) VALUES (?,?,?,?)
      ON CONFLICT(week_start,kind,item_key) DO UPDATE SET store=excluded.store`).bind(start, kind, key, store)
  : db.prepare('DELETE FROM grocery_stores WHERE week_start=? AND kind=? AND item_key=?').bind(start, kind, key);
const allStores = async (db, owner = null) => (await rows(db, `SELECT store FROM (SELECT store FROM grocery_stores UNION
  SELECT i.store FROM list_items i JOIN lists l ON l.id=i.list_id WHERE i.store<>'' AND (l.owner=? OR l.shared=1)) ORDER BY lower(store)`, owner ?? '')).map(r => r.store);
// Custom lists belong to one family profile, sent by the app as x-family-member. Everyone shares the PIN, so this keeps lists separate, not secret.
async function requireOwner(db, request, message = 'Choose your name in your profile to see your own lists.') {
  let name = '';
  try { name = decodeURIComponent(request.headers.get('x-family-member') || ''); } catch {}
  const row = name.trim() && await db.prepare('SELECT name FROM family_members WHERE name=?').bind(name.trim()).first();
  if (!row) throw new InputError(message, 403);
  return row.name;
}
// Custom lists: not tied to a week. 'grocery' lists can tag items with a store; 'basic' lists are just items.
const LIST_KINDS = ['grocery', 'basic'];
function listInput(b) {
  const name = text(b.name, 40).replace(/\s+/g, ' ');
  if (!name) throw new InputError('List name is required.');
  if (!LIST_KINDS.includes(b.kind)) throw new InputError('Choose a Grocery list or a Basic list.');
  return { name, kind: b.kind };
}
// A list is visible to its creator, and to every profile while the creator shares it.
// Anyone who can see a list can work with its items; only the creator can rename, retype, share, unshare, or delete it.
const listView = (row, me) => ({ id: row.id, name: row.name, kind: row.kind, owner: row.owner, shared: !!row.shared, mine: row.owner.toLowerCase() === me.toLowerCase() });
async function requireList(db, value, me, { mine = false } = {}) {
  const id = Number(value);
  const row = Number.isSafeInteger(id) && id > 0 && await db.prepare('SELECT id,owner,shared,name,kind FROM lists WHERE id=? AND (owner=? OR shared=1)').bind(id, me).first();
  if (!row) throw new InputError('List not found. It may have been deleted or is no longer shared.', 404);
  const list = listView(row, me);
  if (mine && !list.mine) throw new InputError(`Only ${list.owner} can change this list's settings.`, 403);
  return list;
}
async function requireListItem(db, list, value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || !await db.prepare('SELECT id FROM list_items WHERE id=? AND list_id=?').bind(id, list.id).first()) throw new InputError('List item not found.', 404);
  return id;
}
const allLists = async (db, me) => (await rows(db, `SELECT l.id,l.owner,l.shared,l.name,l.kind,COUNT(i.id) item_count,COALESCE(SUM(i.checked),0) checked_count
  FROM lists l LEFT JOIN list_items i ON i.list_id=l.id WHERE l.owner=? OR l.shared=1 GROUP BY l.id ORDER BY l.id`, me))
  .map(r => ({ ...listView(r, me), item_count: r.item_count, checked_count: r.checked_count }));
const sharedInput = value => {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new InputError('Shared must be true or false.');
  return Number(value);
};
async function listDetail(db, list, owner) {
  return { list, items: (await rows(db, 'SELECT id,label,store,checked FROM list_items WHERE list_id=? ORDER BY id', list.id)).map(r => ({ ...r, checked: !!r.checked })), stores: await allStores(db, owner) };
}
// Chores: a chore is one-time (on its date), daily, or weekly on chosen days (ISO 1=Mon … 7=Sun), from start_date on.
// Completions are kept per chore and date, so history survives edits and a daily chore resets itself each day.
const CHORE_REPEATS = ['once', 'daily', 'weekly'];
const isoDay = date => new Date(date + 'T12:00:00Z').getUTCDay() || 7;
const choreOn = (c, date) => date >= c.start_date && (c.repeat === 'daily' || (c.repeat === 'once' && date === c.start_date) || (c.repeat === 'weekly' && c.days.includes(isoDay(date))));
const choreView = r => ({ id: r.id, title: r.title, repeat: r.repeat, days: JSON.parse(r.days), start_date: r.start_date, assignees: JSON.parse(r.assignees), created_by: r.created_by });
async function choreInput(db, b) {
  const title = text(b.title, 80).replace(/\s+/g, ' ');
  if (!title) throw new InputError('Chore name is required.');
  if (!CHORE_REPEATS.includes(b.repeat)) throw new InputError('Choose one time, daily, or weekly.');
  if (!validDate(b.start_date)) throw new InputError('A valid date is required.');
  let days = [];
  if (b.repeat === 'weekly') {
    days = Array.isArray(b.days) ? [...new Set(b.days.map(Number))].sort((a, z) => a - z) : [];
    if (!days.length || days.some(d => !Number.isInteger(d) || d < 1 || d > 7)) throw new InputError('Choose at least one day of the week.');
  }
  if (b.assignees !== undefined && (!Array.isArray(b.assignees) || b.assignees.length > 20)) throw new InputError('Choose who it is for from the family list.');
  const assignees = [];
  for (const name of b.assignees || []) {
    const canonical = await requireMember(db, name);
    if (!assignees.some(a => a.toLowerCase() === canonical.toLowerCase())) assignees.push(canonical);
  }
  return { title, repeat: b.repeat, days, start_date: b.start_date, assignees };
}
async function requireChore(db, value) {
  const id = Number(value);
  const row = Number.isSafeInteger(id) && id > 0 && await db.prepare('SELECT * FROM chores WHERE id=?').bind(id).first();
  if (!row) throw new InputError('Chore not found. It may have been deleted.', 404);
  return choreView(row);
}
async function choresForWeek(db, start) {
  const end = addDays(start, 6);
  return { week_start: start, chores: (await rows(db, 'SELECT * FROM chores ORDER BY id')).map(choreView),
    // One-time chores need their whole history to tell what is overdue; other chores only need this week.
    done: await rows(db, `SELECT chore_id,due_date,done_by,done_at FROM chore_done WHERE (due_date>=? AND due_date<=?) OR chore_id IN (SELECT id FROM chores WHERE repeat='once') ORDER BY chore_id,due_date`, start, end),
    recent: await rows(db, 'SELECT d.chore_id,c.title,d.due_date,d.done_by,d.done_at FROM chore_done d JOIN chores c ON c.id=d.chore_id ORDER BY d.done_at DESC,d.rowid DESC LIMIT 30') };
}
async function groceries(db, start) {
  const planned = await rows(db, `SELECT p.plan_date,m.id,m.name,COALESCE(d.ingredients,'[]') ingredients
    FROM weekly_plan p JOIN meals m ON m.id=p.meal_id LEFT JOIN meal_details d ON d.meal_id=m.id
    WHERE p.plan_date>=? AND p.plan_date<=? ORDER BY p.plan_date`, start, addDays(start, 6));
  const checks = new Map((await rows(db, 'SELECT item_key,checked FROM grocery_checks WHERE week_start=?', start)).map(r => [r.item_key, !!r.checked]));
  const stores = new Map((await rows(db, 'SELECT kind,item_key,store FROM grocery_stores WHERE week_start=?', start)).map(r => [`${r.kind}:${r.item_key}`, r.store]));
  const labels = new Map((await rows(db, 'SELECT item_key,label FROM grocery_labels WHERE week_start=?', start)).map(r => [r.item_key, r.label]));
  const combined = new Map();
  const missing = new Map();
  for (const meal of planned) {
    const ingredients = JSON.parse(meal.ingredients);
    if (!ingredients.length) missing.set(meal.id, meal.name);
    for (const label of ingredients) {
      const key = itemKey(label);
      if (!combined.has(key)) combined.set(key, { key, label: labels.get(key) || label, original_label: label, edited: labels.has(key), count: 0, meals: [], checked: checks.get(key) || false, store: stores.get('generated:' + key) || '' });
      const item = combined.get(key);
      item.count++;
      if (!item.meals.includes(meal.name)) item.meals.push(meal.name);
    }
  }
  return { week_start: start, generated: [...combined.values()],
    manual: (await rows(db, 'SELECT * FROM grocery_items WHERE week_start=? ORDER BY id', start)).map(r => ({ ...r, checked: !!r.checked, store: stores.get('manual:' + r.id) || '' })),
    stores: (await rows(db, 'SELECT DISTINCT store FROM grocery_stores ORDER BY lower(store)')).map(r => r.store),
    missing: [...missing].map(([id, name]) => ({ id, name })), planned_count: planned.length };
}

// Read-only numbers for the home-server dashboard. It has its own token (DASHBOARD_TOKEN), so the dashboard never holds the family PIN.
// "Today" is the family's local date (DASHBOARD_TZ, default America/Denver); ?date=YYYY-MM-DD overrides it.
const sameSecret = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
const localDate = (zone, now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
async function dashboard(db, today) {
  const start = addDays(today, 1 - isoDay(today));
  const { chores, done } = await choresForWeek(db, start);
  const finished = new Set(done.map(d => d.chore_id + '|' + d.due_date));
  // Due today, plus one-time chores whose day has passed without being finished.
  const due = chores.filter(c => choreOn(c, today) || (c.repeat === 'once' && c.start_date < today && !done.some(d => d.chore_id === c.id)))
    .map(c => ({ title: c.title, assignees: c.assignees, overdue: c.start_date < today && c.repeat === 'once', done: finished.has(c.id + '|' + today) || (c.repeat === 'once' && done.some(d => d.chore_id === c.id)) }));
  const list = await groceries(db, start);
  const items = [...list.generated, ...list.manual];
  return {
    date: today, week_start: start,
    chores: { total: due.length, done: due.filter(c => c.done).length, left: due.filter(c => !c.done).length, items: due },
    groceries: { total: items.length, left: items.filter(i => !i.checked).length }
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!env.DB) return json({ error: 'Database is not configured yet.' }, 503);
    if (url.pathname === '/api/dashboard' && request.method === 'GET') {
      if (!env.DASHBOARD_TOKEN) return json({ error: 'Dashboard token is not configured.' }, 503);
      if (!sameSecret(request.headers.get('x-dashboard-token'), env.DASHBOARD_TOKEN)) return json({ error: 'Incorrect dashboard token.' }, 401);
      try {
        await ensureSchema(env.DB);
        const asked = url.searchParams.get('date');
        if (asked && !validDate(asked)) return json({ error: 'Use a date like 2026-10-18.' }, 400);
        return json(await dashboard(env.DB, asked || localDate(env.DASHBOARD_TZ || 'America/Denver')));
      } catch {
        return json({ error: 'Unable to load right now.' }, 500);
      }
    }
    if (!env.FAMILY_PIN) return json({ error: 'Family PIN is not configured yet.', setupRequired: true }, 503);
    if (request.headers.get('x-family-pin') !== env.FAMILY_PIN) return json({ error: 'Incorrect family PIN.' }, 401);
    try {
      const db = env.DB;
      await ensureSchema(db);
      const method = request.method, path = url.pathname;
      if (path === '/api/summary' && method === 'GET') return json(await summary(db));
      if (path === '/api/meals' && (method === 'POST' || method === 'PUT')) {
        const b = await body(request), input = mealInput(b);
        if (method === 'PUT') {
          const id = await requireMeal(db, b.id);
          await db.batch([db.prepare('UPDATE meals SET name=?,notes=?,recipe_url=? WHERE id=?').bind(input.name, input.notes, input.recipe, id), detailsStatement(db, id, input)]);
          return json({ ok: true });
        }
        // The subquery refers to the row just inserted within this transaction.
        const result = await db.batch([
          db.prepare('INSERT INTO meals (name,notes,recipe_url,suggested_by) VALUES (?,?,?,?)').bind(input.name, input.notes, input.recipe, text(b.suggested_by, 30)),
          db.prepare('INSERT INTO meal_details (meal_id,tags,ingredients) VALUES (last_insert_rowid(),?,?)').bind(JSON.stringify(input.tags || []), JSON.stringify(input.ingredients || []))
        ]);
        return json({ ok: true, id: result[0].meta.last_row_id }, 201);
      }
      if (path === '/api/meals' && method === 'DELETE') {
        const id = await requireMeal(db, (await body(request)).id);
        await db.batch([
          db.prepare('UPDATE weekly_plan SET meal_id=NULL WHERE meal_id=?').bind(id),
          db.prepare('UPDATE plan_revision SET revision=revision+1 WHERE id=1'),
          db.prepare('DELETE FROM ratings WHERE meal_id=?').bind(id),
          db.prepare('DELETE FROM meal_votes WHERE meal_id=?').bind(id),
          db.prepare('DELETE FROM meal_details WHERE meal_id=?').bind(id),
          db.prepare('DELETE FROM meals WHERE id=?').bind(id)
        ]);
        return json({ ok: true });
      }
      if (path === '/api/rate' && method === 'POST') {
        const b = await body(request), id = await requireMeal(db, b.meal_id), rating = Number(b.rating), member = text(b.member, 30);
        if (!member || !Number.isInteger(rating) || rating < 1 || rating > 5) throw new InputError('Family member and a whole-number 1–5 rating are required.');
        await db.prepare(`INSERT INTO ratings (meal_id,member,rating,comment) VALUES (?,?,?,?)
          ON CONFLICT(meal_id,member) DO UPDATE SET rating=excluded.rating,comment=excluded.comment,created_at=CURRENT_TIMESTAMP`)
          .bind(id, member, rating, text(b.comment)).run();
        return json({ ok: true });
      }
      if (path === '/api/vote' && method === 'POST') {
        const b = await body(request), id = await requireMeal(db, b.meal_id), member = text(b.member, 30);
        if (!member) throw new InputError('Family member is required.');
        const existing = await db.prepare('SELECT id FROM meal_votes WHERE meal_id=? AND member=?').bind(id, member).first();
        if (existing) await db.prepare('DELETE FROM meal_votes WHERE id=?').bind(existing.id).run();
        else await db.prepare('INSERT INTO meal_votes (meal_id,member) VALUES (?,?)').bind(id, member).run();
        return json({ ok: true, voted: !existing });
      }
      if (path === '/api/plan' && method === 'POST') {
        await db.batch([planStatement(db, await planInput(db, await body(request))), db.prepare('UPDATE plan_revision SET revision=revision+1 WHERE id=1')]);
        return json({ ok: true });
      }
      if (path === '/api/plan/week' && method === 'POST') {
        const b = await body(request), start = weekStart(b.week_start), dates = weekDates(start);
        if (!Array.isArray(b.days) || b.days.length !== 7 || new Set(b.days.map(p => p?.plan_date)).size !== 7 || b.days.some(p => !dates.includes(p?.plan_date))) throw new InputError('Provide exactly the seven days of this week.');
        const days = [];
        for (const day of b.days) days.push(await planInput(db, day));
        // Validate every entry before the transactional batch, so no partial week can be saved.
        if (!Number.isSafeInteger(b.expected_revision) || b.expected_revision < 0) throw new InputError('Refresh the plan before accepting.');
        try {
          await db.batch([
            db.prepare('UPDATE plan_revision SET revision=CASE WHEN revision=? THEN revision+1 ELSE NULL END WHERE id=1').bind(b.expected_revision),
            ...days.map(p => planStatement(db, p))
          ]);
        } catch (error) {
          const current = await db.prepare('SELECT revision FROM plan_revision WHERE id=1').first();
          if (current.revision !== b.expected_revision) throw new InputError('The family plan changed while you were previewing. Cancel the preview and refresh before planning again.', 409);
          throw error;
        }
        return json({ ok: true });
      }
      if (path === '/api/members' && method === 'POST') {
        const b = await body(request), name = text(b.name, 30).replace(/\s+/g, ' ');
        if (!name) throw new InputError('Name is required.');
        if (b.claim !== undefined && typeof b.claim !== 'boolean') throw new InputError('Claim must be true or false.');
        const release = b.release == null ? '' : text(b.release, 30).replace(/\s+/g, ' ');
        await db.prepare('INSERT OR IGNORE INTO family_members (name) VALUES (?)').bind(name).run();
        const canonical = await requireMember(db, name);
        // Claiming means "this is me on this phone". It only hides the name from other first-time pickers.
        const changes = [];
        if (b.claim) {
          changes.push(db.prepare('INSERT OR IGNORE INTO family_claims (name) VALUES (?)').bind(canonical));
          if (release && release.toLowerCase() !== canonical.toLowerCase()) changes.push(db.prepare('DELETE FROM family_claims WHERE name=?').bind(release));
        }
        if (changes.length) await db.batch(changes);
        return json({ ok: true, name: canonical });
      }
      if (path === '/api/members' && method === 'DELETE') {
        const name = await requireMember(db, (await body(request)).name);
        // Chores assigned to someone who leaves the family go back to "anyone". Their completion history stays.
        const unassign = (await rows(db, 'SELECT id,assignees FROM chores')).filter(r => JSON.parse(r.assignees).some(a => a.toLowerCase() === name.toLowerCase()))
          .map(r => db.prepare('UPDATE chores SET assignees=? WHERE id=?').bind(JSON.stringify(JSON.parse(r.assignees).filter(a => a.toLowerCase() !== name.toLowerCase())), r.id));
        await db.batch([db.prepare('DELETE FROM dinner_absences WHERE member=?').bind(name), db.prepare('DELETE FROM family_claims WHERE name=?').bind(name), ...unassign, db.prepare('DELETE FROM family_members WHERE name=?').bind(name)]);
        return json({ ok: true });
      }
      if (path === '/api/absence' && method === 'POST') {
        const b = await body(request);
        if (!validDate(b.plan_date)) throw new InputError('Valid plan date required.');
        if (typeof b.out !== 'boolean') throw new InputError('Out must be true or false.');
        const name = await requireMember(db, b.member);
        await (b.out ? db.prepare('INSERT OR IGNORE INTO dinner_absences (plan_date,member) VALUES (?,?)') : db.prepare('DELETE FROM dinner_absences WHERE plan_date=? AND member=?')).bind(b.plan_date, name).run();
        return json({ ok: true });
      }
      if (path.startsWith('/api/lists')) {
      const owner = await requireOwner(db, request);
      if (path === '/api/lists' && method === 'GET') {
        // Lists made before lists had owners go to the first person who opens their lists.
        await db.prepare("UPDATE lists SET owner=? WHERE owner=''").bind(owner).run();
        return json({ lists: await allLists(db, owner) });
      }
      if (path === '/api/lists' && method === 'POST') {
        const b = await body(request), input = listInput(b);
        if ((await db.prepare('SELECT COUNT(*) n FROM lists WHERE owner=?').bind(owner).first()).n >= 50) throw new InputError('You can have up to 50 lists. Delete one to make room.');
        const result = await db.prepare('INSERT INTO lists (owner,name,kind,shared) VALUES (?,?,?,?)').bind(owner, input.name, input.kind, sharedInput(b.shared) ?? 0).run();
        return json({ ok: true, id: result.meta.last_row_id }, 201);
      }
      if (path === '/api/lists' && method === 'PUT') {
        const b = await body(request), list = await requireList(db, b.id, owner, { mine: true }), input = listInput(b), shared = sharedInput(b.shared);
        await db.prepare('UPDATE lists SET name=?,kind=?,shared=COALESCE(?,shared) WHERE id=?').bind(input.name, input.kind, shared ?? null, list.id).run();
        return json({ ok: true });
      }
      if (path === '/api/lists' && method === 'DELETE') {
        const list = await requireList(db, (await body(request)).id, owner, { mine: true });
        await db.batch([db.prepare('DELETE FROM list_items WHERE list_id=?').bind(list.id), db.prepare('DELETE FROM lists WHERE id=?').bind(list.id)]);
        return json({ ok: true });
      }
      if (path === '/api/lists/items' && method === 'GET') return json(await listDetail(db, await requireList(db, url.searchParams.get('list'), owner), owner));
      if (path === '/api/lists/items' && method === 'POST') {
        const b = await body(request), list = await requireList(db, b.list_id, owner), label = text(b.label, 200);
        if (!label) throw new InputError('Item is required.');
        if ((await db.prepare('SELECT COUNT(*) n FROM list_items WHERE list_id=?').bind(list.id).first()).n >= 500) throw new InputError('A list can hold up to 500 items. Clear checked items to make room.');
        const store = list.kind === 'grocery' ? await canonicalStore(db, storeName(b.store), owner) : '';
        const result = await db.prepare('INSERT INTO list_items (list_id,label,store) VALUES (?,?,?)').bind(list.id, label, store).run();
        return json({ ok: true, id: result.meta.last_row_id }, 201);
      }
      if (path === '/api/lists/items' && method === 'PATCH') {
        const b = await body(request), list = await requireList(db, b.list_id, owner), id = await requireListItem(db, list, b.id);
        const sets = [], values = [];
        if (b.label !== undefined) { const label = text(b.label, 200); if (!label) throw new InputError('Item is required.'); sets.push('label=?'); values.push(label); }
        if (b.checked !== undefined) { if (typeof b.checked !== 'boolean') throw new InputError('Checked must be true or false.'); sets.push('checked=?'); values.push(Number(b.checked)); }
        if (b.store !== undefined) { if (typeof b.store !== 'string') throw new InputError('Store must be text. Use an empty value to clear it.'); sets.push('store=?'); values.push(await canonicalStore(db, storeName(b.store), owner)); }
        if (!sets.length) throw new InputError('Nothing to change.');
        await db.prepare(`UPDATE list_items SET ${sets.join(',')} WHERE id=? AND list_id=?`).bind(...values, id, list.id).run();
        return json({ ok: true, store: b.store === undefined ? undefined : values[sets.indexOf('store=?')] });
      }
      if (path === '/api/lists/items' && method === 'DELETE') {
        const b = await body(request), list = await requireList(db, b.list_id, owner);
        if (b.checked === true) {
          const result = await db.prepare('DELETE FROM list_items WHERE list_id=? AND checked=1').bind(list.id).run();
          return json({ ok: true, removed: result.meta.changes });
        }
        await db.prepare('DELETE FROM list_items WHERE id=? AND list_id=?').bind(await requireListItem(db, list, b.id), list.id).run();
        return json({ ok: true });
      }
        return json({ error: 'Not found.' }, 404);
      }
      if (path.startsWith('/api/chores')) {
      if (path === '/api/chores' && method === 'GET') return json(await choresForWeek(db, weekStart(url.searchParams.get('week'))));
      const me = await requireOwner(db, request, 'Choose your name in your profile to work with chores.');
      if (path === '/api/chores' && method === 'POST') {
        const input = await choreInput(db, await body(request));
        if ((await db.prepare('SELECT COUNT(*) n FROM chores').first()).n >= 100) throw new InputError('The family can have up to 100 chores. Delete one to make room.');
        const result = await db.prepare('INSERT INTO chores (title,repeat,days,start_date,assignees,created_by) VALUES (?,?,?,?,?,?)')
          .bind(input.title, input.repeat, JSON.stringify(input.days), input.start_date, JSON.stringify(input.assignees), me).run();
        return json({ ok: true, id: result.meta.last_row_id }, 201);
      }
      if (path === '/api/chores' && method === 'PUT') {
        const b = await body(request), chore = await requireChore(db, b.id), input = await choreInput(db, b);
        await db.prepare('UPDATE chores SET title=?,repeat=?,days=?,start_date=?,assignees=? WHERE id=?')
          .bind(input.title, input.repeat, JSON.stringify(input.days), input.start_date, JSON.stringify(input.assignees), chore.id).run();
        return json({ ok: true });
      }
      if (path === '/api/chores' && method === 'DELETE') {
        const chore = await requireChore(db, (await body(request)).id);
        await db.batch([db.prepare('DELETE FROM chore_done WHERE chore_id=?').bind(chore.id), db.prepare('DELETE FROM chores WHERE id=?').bind(chore.id)]);
        return json({ ok: true });
      }
      if (path === '/api/chores/done' && method === 'POST') {
        const b = await body(request), chore = await requireChore(db, b.chore_id);
        if (!validDate(b.date) || !choreOn(chore, b.date)) throw new InputError('This chore is not scheduled for that day.');
        if (typeof b.done !== 'boolean') throw new InputError('Done must be true or false.');
        // The first person to finish a chore keeps the credit if someone else taps it again.
        await (b.done ? db.prepare('INSERT OR IGNORE INTO chore_done (chore_id,due_date,done_by) VALUES (?,?,?)').bind(chore.id, b.date, me)
          : db.prepare('DELETE FROM chore_done WHERE chore_id=? AND due_date=?').bind(chore.id, b.date)).run();
        return json({ ok: true });
      }
        return json({ error: 'Not found.' }, 404);
      }
      if (path === '/api/groceries' && method === 'GET') return json(await groceries(db, weekStart(url.searchParams.get('week'))));
      if (path === '/api/groceries' && method === 'POST') {
        const b = await body(request), start = weekStart(b.week_start), label = text(b.label, 200);
        if (!label) throw new InputError('Grocery item is required.');
        const store = await canonicalStore(db, storeName(b.store));
        const result = await db.batch([
          db.prepare('INSERT INTO grocery_items (week_start,label) VALUES (?,?)').bind(start, label),
          ...(store ? [db.prepare("INSERT INTO grocery_stores (week_start,kind,item_key,store) VALUES (?,'manual',CAST(last_insert_rowid() AS TEXT),?)").bind(start, store)] : [])
        ]);
        return json({ ok: true, id: result[0].meta.last_row_id }, 201);
      }
      // Rename a grocery line. Meal-generated lines are renamed for this week only (the recipe is untouched); an empty label restores the original.
      if (path === '/api/groceries/label' && method === 'POST') {
        const b = await body(request), start = weekStart(b.week_start);
        if (typeof b.label !== 'string') throw new InputError('Item name must be text.');
        const label = text(b.label, 200);
        if (b.kind === 'generated') {
          const key = text(b.key, 200), item = (await groceries(db, start)).generated.find(i => i.key === key);
          if (!item) throw new InputError('This ingredient is no longer on the plan. Refresh the list.', 409);
          await (label && label !== item.original_label
            ? db.prepare(`INSERT INTO grocery_labels (week_start,item_key,label) VALUES (?,?,?)
                ON CONFLICT(week_start,item_key) DO UPDATE SET label=excluded.label`).bind(start, key, label)
            : db.prepare('DELETE FROM grocery_labels WHERE week_start=? AND item_key=?').bind(start, key)).run();
          return json({ ok: true, label: label || item.original_label });
        }
        if (b.kind === 'manual') {
          if (!label) throw new InputError('Grocery item is required.');
          const id = Number(b.id);
          if (!Number.isSafeInteger(id) || !await db.prepare('SELECT id FROM grocery_items WHERE id=? AND week_start=?').bind(id, start).first()) throw new InputError('Grocery item not found.', 404);
          await db.prepare('UPDATE grocery_items SET label=? WHERE id=? AND week_start=?').bind(label, id, start).run();
          return json({ ok: true, label });
        }
        throw new InputError('Choose a manual item or generated ingredient.');
      }
      if (path === '/api/groceries/store' && method === 'POST') {
        const b = await body(request), start = weekStart(b.week_start);
        if (typeof b.store !== 'string') throw new InputError('Store must be text. Use an empty value to clear it.');
        const store = await canonicalStore(db, storeName(b.store));
        let key;
        if (b.kind === 'generated') {
          key = text(b.key, 200);
          if (!(await groceries(db, start)).generated.some(item => item.key === key)) throw new InputError('This ingredient is no longer on the plan. Refresh the list.', 409);
        } else if (b.kind === 'manual') {
          const id = Number(b.id);
          if (!Number.isSafeInteger(id) || !await db.prepare('SELECT id FROM grocery_items WHERE id=? AND week_start=?').bind(id, start).first()) throw new InputError('Grocery item not found.', 404);
          key = String(id);
        } else throw new InputError('Choose a manual item or generated ingredient.');
        await storeStatement(db, start, b.kind, key, store).run();
        return json({ ok: true, store });
      }
      if (path === '/api/groceries' && (method === 'PATCH' || method === 'DELETE')) {
        const b = await body(request), start = weekStart(b.week_start);
        if (method === 'PATCH' && typeof b.checked !== 'boolean') throw new InputError('Checked must be true or false.');
        if (b.kind === 'generated' && method === 'PATCH') {
          const key = text(b.key, 200), current = await groceries(db, start);
          if (!current.generated.some(item => item.key === key)) throw new InputError('This ingredient is no longer on the plan. Refresh the list.', 409);
          await db.prepare(`INSERT INTO grocery_checks (week_start,item_key,checked) VALUES (?,?,?)
            ON CONFLICT(week_start,item_key) DO UPDATE SET checked=excluded.checked`).bind(start, key, Number(b.checked)).run();
        } else if (b.kind === 'manual') {
          const id = Number(b.id);
          if (!Number.isSafeInteger(id) || !await db.prepare('SELECT id FROM grocery_items WHERE id=? AND week_start=?').bind(id, start).first()) throw new InputError('Grocery item not found.', 404);
          if (method === 'DELETE') await db.batch([db.prepare('DELETE FROM grocery_items WHERE id=? AND week_start=?').bind(id, start), storeStatement(db, start, 'manual', String(id), '')]);
          else await db.prepare('UPDATE grocery_items SET checked=? WHERE id=? AND week_start=?').bind(Number(b.checked), id, start).run();
        } else throw new InputError('Choose a manual item or generated ingredient.');
        return json({ ok: true });
      }
      return json({ error: 'Not found.' }, 404);
    } catch (error) {
      // Do not send bindings, PINs, SQL errors, or stack traces to clients/logs.
      return json({ error: error instanceof InputError ? error.message : 'Unable to save or load right now. Please try again.' }, error instanceof InputError ? error.status : 500);
    }
  }
};
