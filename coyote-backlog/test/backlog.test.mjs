import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database } from './helpers.mjs';
import worker from '../src/index.js';

const PASSCODE = 'test-only-passcode';

const call = (db, method, path, payload, passcode = PASSCODE) => worker.fetch(
  new Request('https://example.test/api' + path, {
    method,
    headers: { 'x-backlog-passcode': passcode, 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  }),
  { DB: db, BACKLOG_PASSCODE: PASSCODE, ASSETS: { fetch: () => new Response('asset') } }
);
const items = async db => (await (await call(db, 'GET', '/items')).json()).items;
const titles = (list, tier) => list.filter(i => i.tier === tier && !i.done).map(i => i.title);

test('requires the passcode and never leaks it', async () => {
  const { sqlite, db } = database();
  try {
    assert.equal((await call(db, 'GET', '/items', null, 'wrong')).status, 401);
    assert.equal((await call(db, 'GET', '/items', null, '')).status, 401);
    const missing = await worker.fetch(new Request('https://example.test/api/items'), { DB: db, ASSETS: {} });
    assert.equal(missing.status, 503);
    assert.doesNotMatch(await missing.text(), /test-only-passcode/);
    // Nothing is written to the database before a correct passcode.
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='backlog_items'").get().n, 0);
  } finally { sqlite.close(); }
});

test('static pages are served without a passcode', async () => {
  const { sqlite, db } = database();
  try {
    const response = await worker.fetch(new Request('https://example.test/'), { DB: db, BACKLOG_PASSCODE: PASSCODE, ASSETS: { fetch: () => new Response('asset') } });
    assert.equal(await response.text(), 'asset');
  } finally { sqlite.close(); }
});

test('seeds Rainer feedback once and never brings deleted seeds back', async () => {
  const { sqlite, db } = database();
  try {
    const first = await items(db);
    assert.equal(first.length, 6);
    assert.ok(first.every(i => i.added_by === 'Rainer'));
    assert.equal(first.filter(i => i.tier === 'must').length, 1);
    await items(db);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM backlog_items').get().n, 6);
    for (const item of first) assert.equal((await call(db, 'DELETE', '/items/' + item.id)).status, 200);
    assert.equal((await items(db)).length, 0);
  } finally { sqlite.close(); }
});

test('adds items to the chosen tier at the bottom, defaulting to idea', async () => {
  const { sqlite, db } = database();
  try {
    await items(db);
    const added = await call(db, 'POST', '/items', { title: '  Add a photo guide  ', details: 'Show what mange looks like', tier: 'nice', added_by: 'Mark' });
    assert.equal(added.status, 201);
    let list = await items(db);
    assert.equal(titles(list, 'nice').at(-1), 'Add a photo guide');
    const saved = list.find(i => i.title === 'Add a photo guide');
    assert.equal(saved.added_by, 'Mark');
    await call(db, 'POST', '/items', { title: 'Default tier' });
    list = await items(db);
    assert.equal(list.find(i => i.title === 'Default tier').tier, 'idea');
  } finally { sqlite.close(); }
});

test('rejects bad input', async () => {
  const { sqlite, db } = database();
  try {
    const bad = [
      { title: '' }, { title: '   ' }, { title: 'x'.repeat(141) }, { title: 'ok', tier: 'urgent' },
      { title: 'ok', details: 'y'.repeat(2001) }, { title: 5 }, { title: 'bad\u0000char' }, { title: 'ok', added_by: 'n'.repeat(41) }
    ];
    for (const payload of bad) assert.equal((await call(db, 'POST', '/items', payload)).status, 400, JSON.stringify(payload).slice(0, 40));
    const raw = await worker.fetch(new Request('https://example.test/api/items', { method: 'POST', body: 'not json', headers: { 'x-backlog-passcode': PASSCODE } }), { DB: db, BACKLOG_PASSCODE: PASSCODE });
    assert.equal(raw.status, 400);
    assert.equal((await call(db, 'PATCH', '/items/9999', { title: 'x' })).status, 404);
    assert.equal((await call(db, 'DELETE', '/items/9999')).status, 404);
    assert.equal((await call(db, 'POST', '/items/9999/move', { direction: 'up' })).status, 404);
    assert.equal((await call(db, 'GET', '/nope')).status, 404);
    const [first] = await items(db);
    assert.equal((await call(db, 'POST', '/items/' + first.id + '/move', { direction: 'sideways' })).status, 400);
    assert.equal((await call(db, 'PATCH', '/items/' + first.id, { done: 'yes' })).status, 400);
    assert.equal((await call(db, 'PATCH', '/items/' + first.id, { tier: 'urgent' })).status, 400);
  } finally { sqlite.close(); }
});

test('move up and down reorders inside a tier and stops at the ends', async () => {
  const { sqlite, db } = database();
  try {
    let list = await items(db);
    const before = titles(list, 'idea');
    assert.equal(before.length, 5);
    const second = list.find(i => i.title === before[1]);
    await call(db, 'POST', `/items/${second.id}/move`, { direction: 'up' });
    assert.deepEqual(titles(await items(db), 'idea').slice(0, 2), [before[1], before[0]]);
    // Moving the top item up does nothing.
    await call(db, 'POST', `/items/${second.id}/move`, { direction: 'up' });
    assert.deepEqual(titles(await items(db), 'idea').slice(0, 2), [before[1], before[0]]);
    const last = (await items(db)).find(i => i.title === before.at(-1));
    await call(db, 'POST', `/items/${last.id}/move`, { direction: 'down' });
    assert.equal(titles(await items(db), 'idea').at(-1), before.at(-1));
    await call(db, 'POST', `/items/${second.id}/move`, { direction: 'down' });
    assert.equal(titles(await items(db), 'idea')[1], before[1]);
  } finally { sqlite.close(); }
});

test('changing tier lands at the bottom of the new tier and leaves other tiers alone', async () => {
  const { sqlite, db } = database();
  try {
    await call(db, 'POST', '/items', { title: 'A', tier: 'nice' });
    await call(db, 'POST', '/items', { title: 'B', tier: 'nice' });
    let list = await items(db);
    const idea = list.find(i => i.tier === 'idea');
    const mustBefore = titles(list, 'must');
    await call(db, 'PATCH', '/items/' + idea.id, { tier: 'nice' });
    list = await items(db);
    assert.deepEqual(titles(list, 'nice'), ['A', 'B', idea.title]);
    assert.equal(titles(list, 'idea').includes(idea.title), false);
    assert.deepEqual(titles(list, 'must'), mustBefore);
    const positions = list.filter(i => i.tier === 'nice').map(i => i.position);
    assert.equal(new Set(positions).size, positions.length);
  } finally { sqlite.close(); }
});

test('done items leave the ordering, and reopening puts them back in their place', async () => {
  const { sqlite, db } = database();
  try {
    let list = await items(db);
    const [a, b, c] = list.filter(i => i.tier === 'idea');
    await call(db, 'PATCH', '/items/' + b.id, { done: true });
    list = await items(db);
    assert.equal(list.find(i => i.id === b.id).done, true);
    // Moving a down now swaps it with c, skipping the done item.
    await call(db, 'POST', `/items/${a.id}/move`, { direction: 'down' });
    const open = titles(await items(db), 'idea');
    assert.deepEqual(open.slice(0, 2), [c.title, a.title]);
    await call(db, 'PATCH', '/items/' + b.id, { done: false });
    assert.equal(titles(await items(db), 'idea').includes(b.title), true);
  } finally { sqlite.close(); }
});

test('edits title and details without changing tier or order', async () => {
  const { sqlite, db } = database();
  try {
    const [first] = (await items(db)).filter(i => i.tier === 'must');
    const res = await call(db, 'PATCH', '/items/' + first.id, { title: 'Reports save for real', details: '' });
    assert.equal(res.status, 200);
    const updated = (await items(db)).find(i => i.id === first.id);
    assert.equal(updated.title, 'Reports save for real');
    assert.equal(updated.details, '');
    assert.equal(updated.tier, 'must');
    assert.equal(updated.position, first.position);
    assert.equal((await call(db, 'PATCH', '/items/' + first.id, { title: '  ' })).status, 400);
  } finally { sqlite.close(); }
});

test('stored text is returned as plain data and SQL in input is inert', async () => {
  const { sqlite, db } = database();
  try {
    const nasty = `'); DROP TABLE backlog_items; -- <img src=x onerror=alert(1)>`;
    assert.equal((await call(db, 'POST', '/items', { title: nasty, details: nasty })).status, 201);
    const list = await items(db);
    assert.equal(list.find(i => i.title === nasty).details, nasty);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='backlog_items'").get().n, 1);
  } finally { sqlite.close(); }
});

test('seeds are sorted into phases: submit is full build, Rainer fields are prototype', async () => {
  const { sqlite, db } = database();
  try {
    const list = await items(db);
    const phaseOf = title => list.find(i => i.title === title).phase;
    assert.equal(phaseOf('Let people submit a sighting report'), 'full');
    assert.equal(list.filter(i => i.phase === 'prototype').length, 5);
    assert.ok(list.every(i => ['review', 'prototype', 'full', 'later'].includes(i.phase)));
  } finally { sqlite.close(); }
});

test('new suggestions start as to review and the phase can be set on create', async () => {
  const { sqlite, db } = database();
  try {
    await items(db);
    await call(db, 'POST', '/items', { title: 'Plain suggestion', added_by: 'Mark' });
    await call(db, 'POST', '/items', { title: 'Pre-sorted', phase: 'later' });
    const list = await items(db);
    assert.equal(list.find(i => i.title === 'Plain suggestion').phase, 'review');
    assert.equal(list.find(i => i.title === 'Pre-sorted').phase, 'later');
    assert.equal((await call(db, 'POST', '/items', { title: 'Bad', phase: 'soon' })).status, 400);
  } finally { sqlite.close(); }
});

test('changing phase leaves tier and order alone, and rejects unknown phases', async () => {
  const { sqlite, db } = database();
  try {
    const before = (await items(db)).filter(i => i.tier === 'idea');
    const target = before[2];
    assert.equal((await call(db, 'PATCH', '/items/' + target.id, { phase: 'later' })).status, 200);
    const after = (await items(db)).filter(i => i.tier === 'idea');
    assert.deepEqual(after.map(i => i.id), before.map(i => i.id));
    const changed = after.find(i => i.id === target.id);
    assert.equal(changed.phase, 'later');
    assert.equal(changed.position, target.position);
    assert.equal((await call(db, 'PATCH', '/items/' + target.id, { phase: 'soon' })).status, 400);
  } finally { sqlite.close(); }
});

test('moving with a phase filter swaps with the next item in that phase', async () => {
  const { sqlite, db } = database();
  try {
    const list = (await items(db)).filter(i => i.tier === 'idea');
    // Order is [size, behavior, time, lingering, repeat]; park behavior and lingering as later.
    await call(db, 'PATCH', '/items/' + list[1].id, { phase: 'later' });
    await call(db, 'PATCH', '/items/' + list[3].id, { phase: 'later' });
    // Within prototype, the third prototype item (repeat) moving up should pass over the hidden ones and swap with time.
    const repeat = list[4];
    await call(db, 'POST', `/items/${repeat.id}/move`, { direction: 'up', phase: 'prototype' });
    const order = (await items(db)).filter(i => i.tier === 'idea').map(i => i.id);
    assert.deepEqual(order, [list[0].id, list[1].id, list[4].id, list[3].id, list[2].id]);
    assert.equal((await call(db, 'POST', `/items/${repeat.id}/move`, { direction: 'up', phase: 'soon' })).status, 400);
  } finally { sqlite.close(); }
});

test('an existing database without phases is upgraded once, keeping its data and edits', async () => {
  const { sqlite, db } = database();
  try {
    // Shape of the live database before this feature: no phase column, six seeded rows.
    sqlite.exec(`CREATE TABLE backlog_items (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, details TEXT NOT NULL DEFAULT '',
      tier TEXT NOT NULL CHECK(tier IN ('must','nice','idea')), position INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
      added_by TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      CREATE TABLE app_seeds (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
      INSERT INTO app_seeds (name) VALUES ('rainer-feedback-v1');
      INSERT INTO backlog_items (title, details, tier, position, added_by) VALUES
        ('Let people submit a sighting report', 'x', 'must', 1, 'Rainer'),
        ('Record the animal size: pup or adult', 'x', 'idea', 2, 'Rainer'),
        ('Mark added this', 'keep me', 'nice', 1, 'Mark');`);
    let list = await items(db);
    assert.equal(list.length, 3);
    const phase = title => list.find(i => i.title === title).phase;
    assert.equal(phase('Let people submit a sighting report'), 'full');
    assert.equal(phase('Record the animal size: pup or adult'), 'prototype');
    assert.equal(phase('Mark added this'), 'review');
    assert.equal(list.find(i => i.title === 'Mark added this').details, 'keep me');
    // The sorting is a one-time step: a later edit is not undone by the next request.
    const submit = list.find(i => i.title === 'Let people submit a sighting report');
    await call(db, 'PATCH', '/items/' + submit.id, { phase: 'review' });
    list = await items(db);
    assert.equal(phase('Let people submit a sighting report'), 'review');
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM pragma_table_info('backlog_items') WHERE name='phase'").get().n, 1);
  } finally { sqlite.close(); }
});
