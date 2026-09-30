import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { database } from './helpers.mjs';
import { validDate, addDays, recommendMeal, proposeWeek, weekDates } from '../public/planner.js';

const start = '2026-09-28';
async function fixture() {
  const { db, sqlite } = database();
  const call = async (path, method = 'GET', payload, authorized = true) => {
    const response = await worker.fetch(new Request('https://test.invalid/api' + path, {
      method, headers: { 'content-type': 'application/json', ...(authorized ? { 'x-family-pin': 'test-only-pin' } : {}) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    }), { DB: db, FAMILY_PIN: 'test-only-pin' });
    return { status: response.status, body: await response.json() };
  };
  const summary = await call('/summary');
  assert.equal(summary.status, 200);
  return { sqlite, db, call, meals: summary.body.meals };
}

test('additive migration preserves every existing V1 record and repeats safely', async () => {
  const { db, sqlite } = database();
  try {
    sqlite.exec(`CREATE TABLE meals(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,notes TEXT DEFAULT '',recipe_url TEXT DEFAULT '',suggested_by TEXT DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE ratings(id INTEGER PRIMARY KEY,meal_id INTEGER,member TEXT,rating INTEGER,comment TEXT,created_at TEXT,UNIQUE(meal_id,member));
      CREATE TABLE meal_votes(id INTEGER PRIMARY KEY,meal_id INTEGER,member TEXT,created_at TEXT,UNIQUE(meal_id,member));
      CREATE TABLE weekly_plan(plan_date TEXT PRIMARY KEY,meal_id INTEGER,note TEXT,updated_at TEXT);
      INSERT INTO meals(name,notes) VALUES('Our edited meal','Keep this');
      INSERT INTO ratings VALUES(1,1,'Julia',5,'Family favorite','2026-09-20');
      INSERT INTO meal_votes VALUES(1,1,'Eric','2026-09-20');
      INSERT INTO weekly_plan VALUES('2026-09-21',1,'Keep note','2026-09-20');`);
    const before = ['meals', 'ratings', 'meal_votes', 'weekly_plan'].map(table => sqlite.prepare(`SELECT * FROM ${table}`).all());
    for (let i = 0; i < 3; i++) {
      const result = await worker.fetch(new Request('https://test.invalid/api/summary', { headers: { 'x-family-pin': 'test-only-pin' } }), { DB: db, FAMILY_PIN: 'test-only-pin' });
      assert.equal(result.status, 200);
    }
    assert.deepEqual(['meals', 'ratings', 'meal_votes', 'weekly_plan'].map(table => sqlite.prepare(`SELECT * FROM ${table}`).all()), before);
  } finally { sqlite.close(); }
});

test('create/edit normalizes tags, saves ingredients, and preserves ratings and votes', async () => {
  const { call, sqlite } = await fixture();
  try {
    const result = await call('/meals', 'POST', { name: 'New Dinner', tags: ['Quick', 'quick', ' Chicken '], ingredients: ['1 lb chicken', '2 peppers'], suggested_by: 'Eric' });
    assert.equal(result.status, 201);
    const id = result.body.id;
    await call('/rate', 'POST', { meal_id: id, member: 'Julia', rating: 5 });
    await call('/vote', 'POST', { meal_id: id, member: 'Eric' });
    const before = (await call('/summary')).body.meals.find(m => m.id === id);
    assert.deepEqual(before.tags, ['quick', 'chicken']);
    assert.deepEqual(before.ingredients, ['1 lb chicken', '2 peppers']);
    assert.equal((await call('/meals', 'PUT', { id, name: 'Edited Dinner' })).status, 200);
    const meal = (await call('/summary')).body.meals.find(m => m.id === id);
    assert.deepEqual(meal.tags, before.tags);
    assert.deepEqual(meal.ingredients, before.ingredients);
    assert.equal(meal.average_rating, 5); assert.equal(meal.vote_count, 1);
    assert.equal((await call('/meals', 'PUT', { id, name: meal.name, tags: [], ingredients: [] })).status, 200);
    assert.deepEqual((await call('/summary')).body.meals.find(m => m.id === id).ingredients, []);
  } finally { sqlite.close(); }
});

test('delete cleans new details while preserving manual groceries and plan notes', async () => {
  const { call, sqlite, meals } = await fixture();
  try {
    const id = meals[0].id;
    await call('/meals', 'PUT', { id, name: 'Dinner', tags: ['quick'], ingredients: ['1 onion'] });
    await call('/plan', 'POST', { plan_date: start, meal_id: id, note: 'Family night' });
    await call('/groceries', 'POST', { week_start: start, label: 'Milk' });
    await call('/rate', 'POST', { meal_id: id, member: 'Eric', rating: 4 });
    await call('/vote', 'POST', { meal_id: id, member: 'Julia' });
    assert.equal((await call('/meals', 'DELETE', { id })).status, 200);
    const summary = (await call('/summary')).body;
    assert.equal(summary.plan[0].meal_id, null); assert.equal(summary.plan[0].note, 'Family night');
    for (const table of ['ratings', 'meal_votes', 'meal_details']) assert.equal(sqlite.prepare(`SELECT count(*) n FROM ${table} WHERE meal_id=?`).get(id).n, 0);
    const list = (await call('/groceries?week=' + start)).body;
    assert.equal(list.generated.length, 0); assert.equal(list.manual.length, 1);
  } finally { sqlite.close(); }
});

test('week acceptance is atomic, validates all entries, and rejects stale previews', async () => {
  const { call, sqlite, meals } = await fixture();
  try {
    const days = weekDates(start).map((date, i) => ({ plan_date: date, meal_id: meals[i].id, note: '' }));
    const broken = structuredClone(days); broken[6].meal_id = 999999;
    assert.equal((await call('/plan/week', 'POST', { week_start: start, days: broken, expected_revision: 0 })).status, 404);
    assert.equal((await call('/summary')).body.plan.length, 0);
    assert.equal((await call('/plan/week', 'POST', { week_start: start, days, expected_revision: 0 })).status, 200);
    const saved = (await call('/summary')).body;
    assert.equal(saved.plan.length, 7);
    await call('/plan', 'POST', { plan_date: start, meal_id: meals[9].id, note: 'Julia changed Monday' });
    assert.equal((await call('/plan/week', 'POST', { week_start: start, days, expected_revision: saved.plan_revision })).status, 409);
    const after = (await call('/summary')).body;
    assert.equal(after.plan.find(p => p.plan_date === start).note, 'Julia changed Monday');
    assert.equal(after.plan_revision, saved.plan_revision + 1);
    assert.equal((await call('/plan', 'POST', { plan_date: '2026-02-30', meal_id: meals[0].id })).status, 400);
    assert.equal((await call('/plan/week', 'POST', { week_start: start, days: [...days.slice(0, 6), days[0]], expected_revision: after.plan_revision })).status, 400);
  } finally { sqlite.close(); }
});

test('groceries group identical amounts, persist checks/manual items, and follow swaps and weeks', async () => {
  const { call, sqlite, meals } = await fixture();
  try {
    const [a, b, c] = meals;
    for (const m of [a, b]) await call('/meals', 'PUT', { id: m.id, name: m.name, ingredients: ['1 onion', '2 cups rice'] });
    await call('/plan', 'POST', { plan_date: start, meal_id: a.id });
    await call('/plan', 'POST', { plan_date: addDays(start, 1), meal_id: b.id });
    let list = (await call('/groceries?week=' + start)).body;
    assert.equal(list.generated.length, 2); assert.equal(list.generated[0].count, 2);
    assert.equal((await call('/groceries', 'PATCH', { week_start: start, kind: 'generated', key: '1 onion', checked: true })).status, 200);
    const manual = await call('/groceries', 'POST', { week_start: start, label: 'Milk' });
    await call('/groceries', 'PATCH', { week_start: start, kind: 'manual', id: manual.body.id, checked: true });
    await call('/plan', 'POST', { plan_date: addDays(start, 1), meal_id: c.id });
    list = (await call('/groceries?week=' + start)).body;
    assert.equal(list.generated[0].count, 1); assert.equal(list.generated[0].checked, true);
    assert.equal(list.manual[0].checked, true); assert.equal(list.missing[0].id, c.id);
    const nextWeek = (await call('/groceries?week=' + addDays(start, 7))).body;
    assert.equal(nextWeek.generated.length, 0); assert.equal(nextWeek.manual.length, 0);
    assert.equal((await call('/groceries', 'PATCH', { week_start: addDays(start, 7), kind: 'manual', id: manual.body.id, checked: false })).status, 404);
    await call('/plan', 'POST', { plan_date: start, meal_id: null });
    assert.equal((await call('/groceries?week=' + start)).body.generated.length, 0);
    assert.equal((await call('/groceries', 'PATCH', { week_start: start, kind: 'generated', key: '1 onion', checked: false })).status, 409);
    assert.equal((await call('/groceries', 'DELETE', { week_start: start, kind: 'manual', id: manual.body.id })).status, 200);
    assert.equal((await call('/groceries?week=' + start)).body.manual.length, 0);
  } finally { sqlite.close(); }
});

test('new and existing APIs stay PIN protected; invalid inputs cannot corrupt records', async () => {
  const { call, sqlite, meals } = await fixture();
  try {
    for (const [path, method, payload] of [
      ['/summary', 'GET'], ['/meals', 'PUT', { id: meals[0].id, name: 'Changed' }],
      ['/plan/week', 'POST', {}], ['/groceries?week=' + start, 'GET'],
      ['/groceries', 'POST', {}], ['/groceries', 'PATCH', {}], ['/groceries', 'DELETE', {}]
    ]) assert.equal((await call(path, method, payload, false)).status, 401);
    for (const payload of [ { name: 'Bad', tags: 'not-array' }, { name: 'Bad', ingredients: [{}] }, { name: 'Bad', recipe_url: 'javascript:alert(1)' } ]) {
      assert.equal((await call('/meals', 'POST', payload)).status, 400);
    }
    assert.equal((await call('/rate', 'POST', { meal_id: meals[0].id, member: 'Eric', rating: 2.5 })).status, 400);
    assert.equal((await call('/meals', 'POST', null)).status, 400);
    assert.equal((await call('/summary')).body.meals.length, 15);
    assert.equal((await call('/groceries?week=2026-09-29')).status, 400);
  } finally { sqlite.close(); }
});

const meal = (id, options = {}) => ({ id, name: `Meal ${id}`, tags: [], rating_count: 0, average_rating: null, vote_count: 0, ...options });
test('planner is deterministic, uses ratings/votes, avoids repeats, and respects existing nights and past dates', () => {
  const meals = Array.from({ length: 12 }, (_, i) => meal(i + 1));
  meals[6] = meal(7, { average_rating: 5, rating_count: 4, vote_count: 3 });
  const existing = [{ plan_date: start, meal_id: 1, note: 'Keep this' }, { plan_date: addDays(start, 1), meal_id: null, note: 'Eating out' }];
  const first = proposeWeek(meals, existing, start, start);
  assert.deepEqual(first, proposeWeek(meals, existing, start, start));
  assert.equal(first[0].meal_id, 1); assert.equal(first[0].note, 'Keep this');
  assert.equal(first[1].meal_id, null); assert.equal(first[2].meal_id, 7);
  assert.equal(new Set(first.filter(p => p.meal_id).map(p => p.meal_id)).size, 6);
  assert.equal(proposeWeek(meals, [], start, addDays(start, 2))[0].meal_id, null);
});

test('planner prioritizes recency and tag variety and explains a limited library', () => {
  const meals = [meal(1, { tags: ['chicken'], rating_count: 4, average_rating: 5, vote_count: 4 }), meal(2, { tags: ['chicken'] }), meal(3, { tags: ['fish'] })];
  const recent = [{ plan_date: addDays(start, -1), meal_id: 1 }];
  const week = [{ plan_date: start, meal_id: 2 }, { plan_date: addDays(start, 1), meal_id: null }];
  assert.equal(recommendMeal(meals, recent, week, addDays(start, 1)).meal_id, 3);
  assert.equal(recommendMeal(meals, [], week, start, 2).meal_id, 1);
  const varied = [meal(1, { tags: ['chicken'] }), meal(2, { tags: ['chicken'] }), meal(3, { tags: ['fish'] })];
  assert.equal(recommendMeal(varied, [], [{ plan_date: start, meal_id: 1 }], addDays(start, 1)).meal_id, 3);
  const limited = proposeWeek([meal(1)], recent, start, start);
  assert.match(limited[0].reason, /limited options/); assert.equal(limited[1].meal_id, null);
  assert.match(limited[1].reason, /No unused alternative/);
});

test('calendar rules handle month/year boundaries and invalid dates', () => {
  assert.equal(validDate('2026-02-29'), false); assert.equal(validDate('2028-02-29'), true);
  assert.equal(validDate('bad'), false); assert.equal(validDate(null), false);
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(weekDates('2026-09-28')[6], '2026-10-04');
});

test('grocery stores: assign to generated and manual items, keep spelling consistent, isolate weeks, and validate', async () => {
  const { call, sqlite, meals } = await fixture();
  try {
    const [a] = meals;
    await call('/meals', 'PUT', { id: a.id, name: a.name, ingredients: ['1 onion', '2 cups rice'] });
    await call('/plan', 'POST', { plan_date: start, meal_id: a.id });
    // Manual item created with a store, and another without one.
    const milk = await call('/groceries', 'POST', { week_start: start, label: 'Milk', store: '  Whole   Foods ' });
    assert.equal(milk.status, 201);
    const chips = await call('/groceries', 'POST', { week_start: start, label: 'Chips' });
    let list = (await call('/groceries?week=' + start)).body;
    assert.equal(list.manual.find(i => i.label === 'Milk').store, 'Whole Foods');
    assert.equal(list.manual.find(i => i.label === 'Chips').store, '');
    assert.equal(list.generated[0].store, '');
    // Generated ingredient and manual item can be assigned/changed; case variants reuse the first spelling.
    assert.equal((await call('/groceries/store', 'POST', { week_start: start, kind: 'generated', key: '1 onion', store: 'Costco' })).body.store, 'Costco');
    assert.equal((await call('/groceries/store', 'POST', { week_start: start, kind: 'manual', id: chips.body.id, store: 'costco' })).body.store, 'Costco');
    list = (await call('/groceries?week=' + start)).body;
    assert.equal(list.generated.find(i => i.key === '1 onion').store, 'Costco');
    assert.equal(list.manual.find(i => i.label === 'Chips').store, 'Costco');
    assert.deepEqual(list.stores, ['Costco', 'Whole Foods']);
    // Checking an item and re-planning do not disturb its store; stores are per week.
    await call('/groceries', 'PATCH', { week_start: start, kind: 'generated', key: '1 onion', checked: true });
    assert.equal((await call('/groceries?week=' + start)).body.generated.find(i => i.key === '1 onion').store, 'Costco');
    const next = (await call('/groceries?week=' + addDays(start, 7))).body;
    assert.equal(next.manual.length, 0); assert.deepEqual(next.stores, ['Costco', 'Whole Foods']);
    assert.equal((await call('/groceries/store', 'POST', { week_start: addDays(start, 7), kind: 'manual', id: milk.body.id, store: 'Target' })).status, 404);
    // Clearing removes the assignment; removing a manual item removes its store.
    await call('/groceries/store', 'POST', { week_start: start, kind: 'generated', key: '1 onion', store: '' });
    assert.equal((await call('/groceries?week=' + start)).body.generated.find(i => i.key === '1 onion').store, '');
    await call('/groceries', 'DELETE', { week_start: start, kind: 'manual', id: milk.body.id });
    assert.deepEqual((await call('/groceries?week=' + start)).body.stores, ['Costco']);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM grocery_stores WHERE kind='manual' AND item_key=?").get(String(milk.body.id)).n, 0);
    // Validation and auth.
    for (const payload of [
      { week_start: start, kind: 'generated', key: 'not on plan', store: 'Costco' },
    ]) assert.equal((await call('/groceries/store', 'POST', payload)).status, 409);
    for (const payload of [
      { week_start: start, kind: 'manual', id: chips.body.id },
      { week_start: start, kind: 'manual', id: chips.body.id, store: 5 },
      { week_start: start, kind: 'manual', id: chips.body.id, store: 'x'.repeat(41) },
      { week_start: start, kind: 'other', store: 'Costco' },
      { week_start: '2026-09-29', kind: 'manual', id: chips.body.id, store: 'Costco' }
    ]) assert.equal((await call('/groceries/store', 'POST', payload)).status, 400);
    assert.equal((await call('/groceries', 'POST', { week_start: start, label: 'Eggs', store: 'x'.repeat(41) })).status, 400);
    assert.equal((await call('/groceries/store', 'POST', { week_start: start, kind: 'manual', id: chips.body.id, store: 'Costco' }, false)).status, 401);
  } finally { sqlite.close(); }
});

test('family list starts from existing ratings and votes once; removals stick', async () => {
  const { db, sqlite } = database();
  try {
    sqlite.exec(`CREATE TABLE meals(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,notes TEXT DEFAULT '',recipe_url TEXT DEFAULT '',suggested_by TEXT DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE ratings(id INTEGER PRIMARY KEY,meal_id INTEGER,member TEXT,rating INTEGER,comment TEXT,created_at TEXT,UNIQUE(meal_id,member));
      CREATE TABLE meal_votes(id INTEGER PRIMARY KEY,meal_id INTEGER,member TEXT,created_at TEXT,UNIQUE(meal_id,member));
      CREATE TABLE weekly_plan(plan_date TEXT PRIMARY KEY,meal_id INTEGER,note TEXT,updated_at TEXT);
      INSERT INTO meals(name) VALUES('Our meal');
      INSERT INTO ratings VALUES(1,1,'Julia',5,'',''),(2,1,'Eric',4,'','');
      INSERT INTO meal_votes VALUES(1,1,'Eric',''),(2,1,'  ','');`);
    const call = async (path, method = 'GET', payload) => {
      const response = await worker.fetch(new Request('https://test.invalid/api' + path, { method, headers: { 'content-type': 'application/json', 'x-family-pin': 'test-only-pin' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) }), { DB: db, FAMILY_PIN: 'test-only-pin' });
      return { status: response.status, body: await response.json() };
    };
    assert.deepEqual((await call('/summary')).body.members.sort(), ['Eric', 'Julia']);
    assert.equal((await call('/members', 'DELETE', { name: 'julia' })).status, 200);
    assert.deepEqual((await call('/summary')).body.members, ['Eric']);
  } finally { sqlite.close(); }
});

test("who's home: family list, in/out marks, case-insensitive names, cleanup, validation, and PIN", async () => {
  const { call, sqlite } = await fixture();
  try {
    assert.deepEqual((await call('/summary')).body.members, []);
    assert.equal((await call('/members', 'POST', { name: '  Eric   R ' })).body.name, 'Eric R');
    assert.equal((await call('/members', 'POST', { name: 'eric r' })).body.name, 'Eric R');
    await call('/members', 'POST', { name: 'Ava' });
    let summary = (await call('/summary')).body;
    assert.deepEqual(summary.members, ['Eric R', 'Ava']); assert.deepEqual(summary.absences, []);
    // Marking out is idempotent, works with any capitalization, and is stored under the canonical name.
    assert.equal((await call('/absence', 'POST', { plan_date: start, member: 'ava', out: true })).status, 200);
    assert.equal((await call('/absence', 'POST', { plan_date: start, member: 'Ava', out: true })).status, 200);
    await call('/absence', 'POST', { plan_date: addDays(start, 1), member: 'Ava', out: true });
    assert.deepEqual((await call('/summary')).body.absences, [{ plan_date: start, member: 'Ava' }, { plan_date: addDays(start, 1), member: 'Ava' }]);
    assert.equal((await call('/absence', 'POST', { plan_date: start, member: 'Ava', out: false })).status, 200);
    assert.deepEqual((await call('/summary')).body.absences, [{ plan_date: addDays(start, 1), member: 'Ava' }]);
    // Removing a person clears their marks but not other people's.
    await call('/absence', 'POST', { plan_date: start, member: 'Eric R', out: true });
    assert.equal((await call('/members', 'DELETE', { name: 'AVA' })).status, 200);
    summary = (await call('/summary')).body;
    assert.deepEqual(summary.members, ['Eric R']); assert.deepEqual(summary.absences, [{ plan_date: start, member: 'Eric R' }]);
    // Validation.
    for (const payload of [{}, { name: '   ' }, { name: 'x'.repeat(31) }, { name: 5 }]) assert.equal((await call('/members', 'POST', payload)).status, 400);
    assert.equal((await call('/members', 'DELETE', { name: 'Nobody' })).status, 404);
    assert.equal((await call('/absence', 'POST', { plan_date: start, member: 'Nobody', out: true })).status, 404);
    for (const payload of [{ plan_date: '2026-02-30', member: 'Eric R', out: true }, { plan_date: start, member: 'Eric R' }, { plan_date: start, member: 'Eric R', out: 'yes' }])
      assert.equal((await call('/absence', 'POST', payload)).status, 400);
    for (const [path, method, payload] of [['/members', 'POST', { name: 'Sam' }], ['/members', 'DELETE', { name: 'Eric R' }], ['/absence', 'POST', { plan_date: start, member: 'Eric R', out: true }]])
      assert.equal((await call(path, method, payload, false)).status, 401);
    assert.deepEqual((await call('/summary')).body.members, ['Eric R']);
  } finally { sqlite.close(); }
});
