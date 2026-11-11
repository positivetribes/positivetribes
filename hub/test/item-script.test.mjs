import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAddSql, buildSql, parseAddArgs, parseArgs, sq } from '../scripts/item.mjs';

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
  assert.match(sql, /'phase', 'T-shirt sizes', 'change', 'Not decided yet → In the build'/);
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

test('--add: defaults match the app, bad input is refused before anything runs', () => {
  const r = parseAddArgs(['uep', '--add', '--project', 'scheduler', '--title', 'Volunteer scheduling']);
  assert.deepEqual(r, { slug: 'uep', project: 'scheduler', add: { title: 'Volunteer scheduling', details: '', owner: '', kind: 'change', tier: 'idea', phase: 'review' }, apply: false });
  assert.equal(parseAddArgs(['uep', '--add', '--title', 'T', '--kind', 'problem']).add.phase, 'full');
  assert.equal(parseAddArgs(['uep', '--add', '--title', 'T', '--phase', 'later', '--apply']).apply, true);
  assert.throws(() => parseAddArgs(['uep', '--add']));                                   // title required
  assert.throws(() => parseAddArgs(['uep', '--add', '--title', ' ']));
  assert.throws(() => parseAddArgs(['uep', '--add', '--title', 'T', '--kind', 'request'])); // care requests are not added here
  assert.throws(() => parseAddArgs(['uep', '--add', '--title', 'T', '--tier', 'urgent']));
  assert.throws(() => parseAddArgs(['uep', '--add', '--title', 'T', '--project', 'x; drop']));
  assert.throws(() => parseAddArgs(['uep', '--add', '--title', 'x'.repeat(161)]));
  assert.throws(() => parseAddArgs(['uep', '--add', '--title', 'T', '--details', 'x'.repeat(2001)]));
});

test('--add writes the row and the event the app writes, with quotes escaped', () => {
  const sql = buildAddSql(1, 2, { title: "Molly's idea", details: "d'1", owner: '', kind: 'change', tier: 'idea', phase: 'later' });
  const [insert, event] = sql.split('\n');
  assert.match(insert, /^INSERT INTO items \(client_id, project_id, kind, title, details, owner, tier, phase, position, added_by\) VALUES \(1, 2, 'change', 'Molly''s idea', 'd''1', '', 'idea', 'later', \(SELECT COALESCE\(MAX\(position\), 0\) \+ 1 FROM items WHERE client_id = 1 AND project_id = 2 AND kind = 'change' AND tier = 'idea'\), 'Eric Roberts'\);$/);
  assert.match(event, /^INSERT INTO events \(.*\) VALUES \(1, last_insert_rowid\(\), 'added', 'Molly''s idea', 'change', 'd''1', 'eric@positivetribes.org', 'Eric Roberts', CURRENT_TIMESTAMP\);$/);
  assert.equal(sql.split('\n').length, 2);
});
