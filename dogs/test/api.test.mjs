import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';

function d1() {
  const sql = new DatabaseSync(':memory:');
  const prep = (q) => ({
    q, args: [],
    bind(...a) { this.args = a; return this; },
    async all() { return { results: sql.prepare(q).all(...this.args) }; },
    async first() { return sql.prepare(q).get(...this.args) ?? null; },
    async run() { const r = sql.prepare(q).run(...this.args); return { meta: { changes: Number(r.changes) } }; },
    exec() { return sql.prepare(q).run(...this.args); }
  });
  return { prepare: prep, async batch(stmts) { sql.exec('BEGIN'); try { for (const s of stmts) s.exec(); sql.exec('COMMIT'); } catch (e) { sql.exec('ROLLBACK'); throw e; } return []; } };
}
const env = () => ({ DB: d1(), DOGS_PIN: 'secret', ASSETS: { fetch: () => new Response('asset') } });
const call = (e, path, opts = {}, pin = 'secret') => worker.fetch(new Request('https://x' + path, { ...opts, headers: { 'x-dogs-pin': pin, 'content-type': 'application/json' } }), e);

test('requires the PIN', async () => {
  const e = env();
  assert.equal((await call(e, '/api/records', {}, 'nope')).status, 401);
  assert.equal((await call(e, '/api/records', {}, '')).status, 401);
});
test('seeds once and lists 25 records', async () => {
  const e = env();
  assert.equal((await (await call(e, '/api/records')).json()).records.length, 25);
  const id = (await (await call(e, '/api/records')).json()).records[0].id;
  await call(e, '/api/records/' + id, { method: 'DELETE' });
  assert.equal((await (await call(e, '/api/records')).json()).records.length, 24);
});
test('add for both dogs, edit, delete, and reject bad input', async () => {
  const e = env();
  const row = { item: 'Rabies', date: '2027-01-02', status: 'tbd', vendor: '', weight: '', notes: '' };
  assert.equal((await call(e, '/api/records', { method: 'POST', body: JSON.stringify(['Rosie', 'Roxy'].map(dog => ({ ...row, dog }))) })).status, 201);
  assert.equal((await call(e, '/api/records', { method: 'POST', body: JSON.stringify({ ...row, dog: 'Fido' }) })).status, 400);
  assert.equal((await call(e, '/api/records', { method: 'POST', body: JSON.stringify({ ...row, dog: 'Rosie', date: '2027-13-40' }) })).status, 400);
  const list = (await (await call(e, '/api/records')).json()).records;
  assert.equal(list.length, 27);
  const r = list.find(x => x.date === '2027-01-02');
  assert.equal((await call(e, '/api/records/' + r.id, { method: 'PUT', body: JSON.stringify({ ...r, status: 'done' }) })).status, 200);
  assert.equal((await call(e, '/api/records/99999', { method: 'PUT', body: JSON.stringify({ ...row, dog: 'Rosie' }) })).status, 404);
});
test('non-api paths serve static assets', async () => {
  const e = env();
  assert.equal(await (await worker.fetch(new Request('https://x/'), e)).text(), 'asset');
});
