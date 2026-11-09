import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSql, parseArgs, sq } from '../scripts/item.mjs';

const item = { id: 121, client_id: 1, project_id: 2, kind: 'change', title: 'T-shirt sizes', details: 'd', answer: '', tier: 'must', phase: 'review', done: 0, due_date: '' };

test('quotes are escaped in every value', () => {
  assert.equal(sq("didn't"), "'didn''t'");
  assert.throws(() => sq('a\u0000b'));
  const sql = buildSql(item, { answer: "It's fixed'); DROP TABLE items;--" });
  assert.match(sql, /answer = 'It''s fixed''\); DROP TABLE items;--'/);
});

test('each change writes the event the app would, so the bell matches', () => {
  const sql = buildSql(item, { done: 1, answer: 'Fixed.', phase: 'full', due_date: '2026-11-20' });
  assert.match(sql, /^UPDATE items SET answer = 'Fixed\.', done = 1, phase = 'full', due_date = '2026-11-20', updated_at = CURRENT_TIMESTAMP WHERE id = 121 AND client_id = 1;/);
  assert.match(sql, /'answered', 'T-shirt sizes', 'change', 'Fixed\.'/);
  assert.match(sql, /'done', 'T-shirt sizes', 'change', ''/);
  assert.match(sql, /'phase', 'T-shirt sizes', 'change', 'To review → Full build'/);
  assert.equal(sql.split('\n').length, 4);
});

test('a tier change moves it to the end of its new tier; title edits log under the new title', () => {
  const sql = buildSql(item, { tier: 'nice', title: 'Shirts' });
  assert.match(sql, /position = \(SELECT COALESCE\(MAX\(position\), 0\) \+ 1 FROM items WHERE client_id = 1 AND project_id IS 2 AND kind = 'change' AND tier = 'nice'\)/);
  assert.match(sql, /'tier', 'Shirts', 'change', 'Must have → Nice to have'/);
  assert.match(sql, /'edited', 'Shirts', 'change', 'Changed title'/);
});

test('no change, no SQL', () => {
  assert.equal(buildSql(item, { phase: 'review', done: 0 }), '');
});

test('arguments are checked before anything runs', () => {
  assert.deepEqual(parseArgs(['uep', '121', '--done', '--due', 'none']), { slug: 'uep', id: 121, changes: { done: 1, due_date: '' }, apply: false });
  assert.throws(() => parseArgs(['UEP; drop', '1', '--done']));
  assert.throws(() => parseArgs(['uep', '1 OR 1=1', '--done']));
  assert.throws(() => parseArgs(['uep', '1', '--phase', 'shipped']));
  assert.throws(() => parseArgs(['uep', '1', '--due', 'tomorrow']));
  assert.throws(() => parseArgs(['uep', '1']));
  assert.throws(() => parseArgs(['uep', '1', '--answer']));
});

test('a new item is one INSERT plus its added event, values quoted', async () => {
  const { buildNewSql } = await import('../scripts/item.mjs');
  const args = parseArgs(['uep', 'new', '--project', '1', '--title', "Lead's waiver link", '--tier', 'nice', '--details', 'd', '--owner', 'Molly']);
  assert.equal(args.isNew, true);
  assert.equal(args.item.phase, 'review');
  const sql = buildNewSql(1, args.item, { email: 'e@x', name: 'Eric Roberts' });
  const [insert, event] = sql.split('\n');
  assert.match(insert, /^INSERT INTO items \(client_id, project_id, kind, title, details, owner, tier, phase, position, added_by\) VALUES \(1, 1, 'change', 'Lead''s waiver link', 'd', 'Molly', 'nice', 'review', \(SELECT COALESCE\(MAX\(position\), 0\) \+ 1 FROM items WHERE client_id = 1 AND project_id = 1 AND kind = 'change' AND tier = 'nice'\), 'Eric Roberts'\);$/);
  assert.match(event, /VALUES \(1, last_insert_rowid\(\), 'added', 'Lead''s waiver link', 'change', 'd', 'e@x', 'Eric Roberts', CURRENT_TIMESTAMP\);$/);
});

test('new items check their arguments too', () => {
  assert.throws(() => parseArgs(['uep', 'new', '--title', 'x', '--tier', 'nice']));
  assert.throws(() => parseArgs(['uep', 'new', '--project', '1', '--tier', 'nice']));
  assert.throws(() => parseArgs(['uep', 'new', '--project', '1', '--title', 'x']));
  assert.throws(() => parseArgs(['uep', 'new', '--project', '1 OR 1=1', '--title', 'x', '--tier', 'nice']));
  assert.throws(() => parseArgs(['uep', 'new', '--project', '1', '--title', 'x', '--tier', 'nice', '--kind', 'request']));
  assert.equal(parseArgs(['uep', 'new', '--project', '1', '--title', 'x', '--tier', 'must', '--kind', 'problem']).item.phase, 'full');
});
