import assert from 'node:assert/strict';
import { test } from 'node:test';
import { database } from './helpers.mjs';
import worker from '../src/index.js';

const PASSCODE = 'test-only-passcode';
const SEEDS = 26;

const call = (db, method, path, payload, passcode = PASSCODE) => worker.fetch(
  new Request('https://example.test/api' + path, {
    method,
    headers: { 'x-backlog-passcode': passcode, 'content-type': 'application/json' },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  }),
  { DB: db, BACKLOG_PASSCODE: PASSCODE, ASSETS: { fetch: () => new Response('asset') } }
);
const items = async db => (await (await call(db, 'GET', '/items')).json()).items;
const titles = (list, tier, kind = 'question') => list.filter(i => i.kind === kind && i.tier === tier && !i.done).map(i => i.title);

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

test('seeds the open questions once and never brings deleted seeds back', async () => {
  const { sqlite, db } = database();
  try {
    const first = await items(db);
    assert.equal(first.length, SEEDS);
    assert.ok(first.every(i => i.kind === 'question' && i.added_by === 'Eric' && i.owner));
    assert.equal(first.filter(i => i.tier === 'must').length, 13);
    assert.equal(first.filter(i => i.tier === 'nice').length, 10);
    assert.ok(first.every(i => ['prototype', 'full', 'later'].includes(i.phase)));
    // Questions with a likely answer arrive with it filled in but still open.
    const seasons = first.find(i => i.title.startsWith('Do practices run in seasons'));
    assert.match(seasons.answer, /year-round/);
    assert.equal(seasons.done, false);
    assert.equal(first.filter(i => i.owner === 'United Rocks counsel').length, 2);
    await items(db);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM backlog_items').get().n, SEEDS);
    for (const item of first) assert.equal((await call(db, 'DELETE', '/items/' + item.id)).status, 200);
    assert.equal((await items(db)).length, 0);
  } finally { sqlite.close(); }
});

test('adds suggestions and questions at the bottom of their own tier, defaulting to a suggested change', async () => {
  const { sqlite, db } = database();
  try {
    await items(db);
    const added = await call(db, 'POST', '/items', { title: '  Show the next climb in large text  ', tier: 'nice', added_by: 'Mariana' });
    assert.equal(added.status, 201);
    let list = await items(db);
    const saved = list.find(i => i.title === 'Show the next climb in large text');
    assert.equal(saved.kind, 'change');
    assert.equal(saved.position, 1);
    assert.equal(saved.added_by, 'Mariana');
    await call(db, 'POST', '/items', { kind: 'question', title: 'Does each location need a backup coach?', tier: 'must', owner: 'Mariana' });
    list = await items(db);
    assert.equal(titles(list, 'must').at(-1), 'Does each location need a backup coach?');
    assert.equal(list.find(i => i.title === 'Does each location need a backup coach?').owner, 'Mariana');
    await call(db, 'POST', '/items', { title: 'Default tier' });
    list = await items(db);
    assert.equal(list.find(i => i.title === 'Default tier').tier, 'idea');
  } finally { sqlite.close(); }
});

test('rejects bad input', async () => {
  const { sqlite, db } = database();
  try {
    const bad = [
      { title: '' }, { title: '   ' }, { title: 'x'.repeat(161) }, { title: 'ok', tier: 'urgent' }, { title: 'ok', kind: 'task' },
      { title: 'ok', details: 'y'.repeat(2001) }, { title: 5 }, { title: 'bad\u0000char' }, { title: 'ok', added_by: 'n'.repeat(41) },
      { title: 'ok', owner: 'o'.repeat(61) }
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
    assert.equal((await call(db, 'PATCH', '/items/' + first.id, { answer: 'a'.repeat(2001) })).status, 400);
  } finally { sqlite.close(); }
});

test('move up and down reorders inside a tier and stops at the ends', async () => {
  const { sqlite, db } = database();
  try {
    let list = await items(db);
    const before = titles(list, 'nice');
    assert.equal(before.length, 10);
    const second = list.find(i => i.title === before[1]);
    await call(db, 'POST', `/items/${second.id}/move`, { direction: 'up' });
    assert.deepEqual(titles(await items(db), 'nice').slice(0, 2), [before[1], before[0]]);
    // Moving the top item up does nothing.
    await call(db, 'POST', `/items/${second.id}/move`, { direction: 'up' });
    assert.deepEqual(titles(await items(db), 'nice').slice(0, 2), [before[1], before[0]]);
    const last = (await items(db)).find(i => i.title === before.at(-1));
    await call(db, 'POST', `/items/${last.id}/move`, { direction: 'down' });
    assert.equal(titles(await items(db), 'nice').at(-1), before.at(-1));
  } finally { sqlite.close(); }
});

test('questions and suggestions keep separate orders, even in the same tier', async () => {
  const { sqlite, db } = database();
  try {
    await call(db, 'POST', '/items', { title: 'Change A', tier: 'must' });
    await call(db, 'POST', '/items', { title: 'Change B', tier: 'must' });
    let list = await items(db);
    const questionsBefore = titles(list, 'must');
    const b = list.find(i => i.title === 'Change B');
    await call(db, 'POST', `/items/${b.id}/move`, { direction: 'up' });
    list = await items(db);
    assert.deepEqual(titles(list, 'must', 'change'), ['Change B', 'Change A']);
    assert.deepEqual(titles(list, 'must'), questionsBefore);
    // Moving the first question down swaps with the next question, never with a change.
    const q = list.find(i => i.title === questionsBefore[0]);
    await call(db, 'POST', `/items/${q.id}/move`, { direction: 'down' });
    list = await items(db);
    assert.deepEqual(titles(list, 'must').slice(0, 2), [questionsBefore[1], questionsBefore[0]]);
    assert.deepEqual(titles(list, 'must', 'change'), ['Change B', 'Change A']);
  } finally { sqlite.close(); }
});

test('changing tier lands at the bottom of the new tier for that kind', async () => {
  const { sqlite, db } = database();
  try {
    let list = await items(db);
    const idea = list.find(i => i.tier === 'idea');
    const mustBefore = titles(list, 'must');
    const niceBefore = titles(list, 'nice');
    await call(db, 'PATCH', '/items/' + idea.id, { tier: 'nice' });
    list = await items(db);
    assert.deepEqual(titles(list, 'nice'), [...niceBefore, idea.title]);
    assert.deepEqual(titles(list, 'must'), mustBefore);
    const positions = list.filter(i => i.kind === 'question' && i.tier === 'nice').map(i => i.position);
    assert.equal(new Set(positions).size, positions.length);
  } finally { sqlite.close(); }
});

test('answering a question saves the answer and marks it answered; reopening keeps the answer', async () => {
  const { sqlite, db } = database();
  try {
    const list = await items(db);
    const [a, b, c] = list.filter(i => i.tier === 'nice');
    const res = await call(db, 'PATCH', '/items/' + b.id, { answer: '  About 300 athletes climbed in the last year.  ', done: true, owner: 'Mariana' });
    assert.equal(res.status, 200);
    let saved = (await items(db)).find(i => i.id === b.id);
    assert.equal(saved.answer, 'About 300 athletes climbed in the last year.');
    assert.equal(saved.done, true);
    assert.equal(saved.tier, 'nice');
    // Moving a down now swaps it with c, skipping the answered item.
    await call(db, 'POST', `/items/${a.id}/move`, { direction: 'down' });
    assert.deepEqual(titles(await items(db), 'nice').slice(0, 2), [c.title, a.title]);
    await call(db, 'PATCH', '/items/' + b.id, { done: false });
    saved = (await items(db)).find(i => i.id === b.id);
    assert.equal(saved.done, false);
    assert.equal(saved.answer, 'About 300 athletes climbed in the last year.');
  } finally { sqlite.close(); }
});

test('edits title and details without changing tier, order, or answer', async () => {
  const { sqlite, db } = database();
  try {
    const first = (await items(db)).find(i => i.answer);
    const res = await call(db, 'PATCH', '/items/' + first.id, { title: 'Are practices year-round?', details: '' });
    assert.equal(res.status, 200);
    const updated = (await items(db)).find(i => i.id === first.id);
    assert.equal(updated.title, 'Are practices year-round?');
    assert.equal(updated.details, '');
    assert.equal(updated.answer, first.answer);
    assert.equal(updated.tier, first.tier);
    assert.equal(updated.position, first.position);
    assert.equal((await call(db, 'PATCH', '/items/' + first.id, { title: '  ' })).status, 400);
  } finally { sqlite.close(); }
});

test('stored text is returned as plain data and SQL in input is inert', async () => {
  const { sqlite, db } = database();
  try {
    const nasty = `'); DROP TABLE backlog_items; -- <img src=x onerror=alert(1)>`;
    assert.equal((await call(db, 'POST', '/items', { kind: 'question', title: nasty, details: nasty, owner: nasty.slice(0, 60) })).status, 201);
    const list = await items(db);
    const saved = list.find(i => i.title === nasty);
    assert.equal(saved.details, nasty);
    await call(db, 'PATCH', '/items/' + saved.id, { answer: nasty });
    assert.equal((await items(db)).find(i => i.id === saved.id).answer, nasty);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='backlog_items'").get().n, 1);
  } finally { sqlite.close(); }
});

test('new items start as to review and the phase can be set on create', async () => {
  const { sqlite, db } = database();
  try {
    await items(db);
    await call(db, 'POST', '/items', { title: 'Plain suggestion', added_by: 'Mariana' });
    await call(db, 'POST', '/items', { title: 'Pre-sorted', phase: 'later' });
    const list = await items(db);
    assert.equal(list.find(i => i.title === 'Plain suggestion').phase, 'review');
    assert.equal(list.find(i => i.title === 'Pre-sorted').phase, 'later');
    assert.equal((await call(db, 'POST', '/items', { title: 'Bad', phase: 'soon' })).status, 400);
  } finally { sqlite.close(); }
});

test('moving with a phase filter swaps with the next item in that phase', async () => {
  const { sqlite, db } = database();
  try {
    const list = (await items(db)).filter(i => i.tier === 'must');
    await call(db, 'PATCH', '/items/' + list[1].id, { phase: 'later' });
    await call(db, 'PATCH', '/items/' + list[2].id, { phase: 'later' });
    // Within prototype, the fourth item moving up passes over the two parked ones and swaps with the first.
    await call(db, 'POST', `/items/${list[3].id}/move`, { direction: 'up', phase: 'prototype' });
    const order = (await items(db)).filter(i => i.tier === 'must').map(i => i.id);
    assert.deepEqual(order.slice(0, 4), [list[3].id, list[1].id, list[2].id, list[0].id]);
    assert.equal((await call(db, 'POST', `/items/${list[3].id}/move`, { direction: 'up', phase: 'soon' })).status, 400);
  } finally { sqlite.close(); }
});

test('the committed backlog page has no analytics tag baked in; deploy adds it from GA_MEASUREMENT_ID', async () => {
  const { readFile } = await import('node:fs/promises');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.equal(html.includes('googletagmanager.com'), false);
  assert.match(html, /<\/head>/);
  assert.match(html, /typeof gtag === 'function'/);
  // The viewer cannot rely on browser confirm dialogs, so deleting asks on the page itself.
  assert.equal(html.includes('confirm('), false);
});
