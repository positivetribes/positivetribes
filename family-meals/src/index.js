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
db.prepare("CREATE TABLE IF NOT EXISTS grocery_labels (week_start TEXT NOT NULL,item_key TEXT NOT NULL,label TEXT NOT NULL,PRIMARY KEY(week_start,item_key))"),
db.prepare("CREATE TABLE IF NOT EXISTS grocery_stores (week_start TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('generated','manual')),item_key TEXT NOT NULL,store TEXT NOT NULL,PRIMARY KEY(week_start,kind,item_key))"),
db.prepare("CREATE TABLE IF NOT EXISTS weekly_plan (plan_date TEXT PRIMARY KEY,meal_id INTEGER,note TEXT DEFAULT '',updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)")
]);
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
async function canonicalStore(db, name) {
  if (!name) return '';
  const existing = await db.prepare('SELECT store FROM grocery_stores WHERE lower(store)=lower(?) ORDER BY rowid LIMIT 1').bind(name).first();
  return existing ? existing.store : name;
}
const storeStatement = (db, start, kind, key, store) => store
  ? db.prepare(`INSERT INTO grocery_stores (week_start,kind,item_key,store) VALUES (?,?,?,?)
      ON CONFLICT(week_start,kind,item_key) DO UPDATE SET store=excluded.store`).bind(start, kind, key, store)
  : db.prepare('DELETE FROM grocery_stores WHERE week_start=? AND kind=? AND item_key=?').bind(start, kind, key);
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (!env.DB) return json({ error: 'Database is not configured yet.' }, 503);
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
        await db.batch([db.prepare('DELETE FROM dinner_absences WHERE member=?').bind(name), db.prepare('DELETE FROM family_claims WHERE name=?').bind(name), db.prepare('DELETE FROM family_members WHERE name=?').bind(name)]);
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
