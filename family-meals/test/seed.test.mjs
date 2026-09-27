import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const { default: worker } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));

// SQLite-backed D1 adapter: execute the Worker's real SQL, including batch rollback.
function database() {
  const sqlite = new DatabaseSync(':memory:');
  const db = {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async all() { return { results: sqlite.prepare(sql).all(...values) }; },
        async first() { return sqlite.prepare(sql).get(...values); },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { meta: { last_row_id: Number(result.lastInsertRowid) } };
        }
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const result = [];
        for (const statement of statements) result.push(await statement.run());
        sqlite.exec('COMMIT');
        return result;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return { sqlite, db };
}
const request = (db, path = '/summary', payload) => worker.fetch(
  new Request('https://example.test/api' + path, {
    method: payload ? 'POST' : 'GET',
    headers: { 'x-family-pin': 'test-only-pin', 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  }),
  { DB: db, FAMILY_PIN: 'test-only-pin' }
);

test('empty database gets 15 usable dinners; repeated requests do not duplicate them', async () => {
  const { sqlite, db } = database();
  try {
    const first = await (await request(db)).json();
    assert.equal(first.meals.length, 15);
    assert.equal(new Set(first.meals.map(m => m.name)).size, 15);
    assert.ok(first.meals.every(m => m.notes && !m.suggested_by));
    await request(db);
    assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM meals').get().n, 15);
    const id = first.meals[0].id;
    assert.equal((await request(db, '/rate', { meal_id: id, member: 'Test', rating: 5 })).status, 200);
    assert.equal((await request(db, '/vote', { meal_id: id, member: 'Test' })).status, 200);
    assert.equal((await request(db, '/plan', { meal_id: id, plan_date: '2026-09-28' })).status, 200);
    const summary = await (await request(db)).json();
    assert.equal(summary.ratings.length, 1);
    assert.equal(summary.votes.length, 1);
    assert.equal(summary.plan[0].meal_name, first.meals[0].name);
    // Editing/removing starter meals must not cause them to reappear.
    sqlite.exec("UPDATE meals SET name = 'Our tacos' WHERE id = " + id);
    await request(db);
    assert.equal(sqlite.prepare('SELECT name FROM meals WHERE id = ?').get(id).name, 'Our tacos');
    sqlite.exec('DELETE FROM meals');
    assert.equal((await (await request(db)).json()).meals.length, 0);
  } finally { sqlite.close(); }
});

test('existing user meals are preserved and initialization stays skipped', async () => {
  const { sqlite, db } = database();
  try {
    sqlite.exec("CREATE TABLE meals (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,notes TEXT DEFAULT '',recipe_url TEXT DEFAULT '',suggested_by TEXT DEFAULT '',created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    sqlite.exec("INSERT INTO meals (name, notes, recipe_url, suggested_by) VALUES ('Tacos', 'Family recipe', 'https://example.test/recipe', 'Test')");
    const before = sqlite.prepare('SELECT * FROM meals').all();
    await request(db);
    await request(db);
    assert.deepEqual(sqlite.prepare('SELECT * FROM meals').all(), before);
    sqlite.exec('DELETE FROM meals');
    assert.equal((await (await request(db)).json()).meals.length, 0);
  } finally { sqlite.close(); }
});

test('unauthorized requests cannot initialize the database', async () => {
  const { sqlite, db } = database();
  try {
    const response = await worker.fetch(new Request('https://example.test/api/summary'), { DB: db, FAMILY_PIN: 'test-only-pin' });
    assert.equal(response.status, 401);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
  } finally { sqlite.close(); }
});
