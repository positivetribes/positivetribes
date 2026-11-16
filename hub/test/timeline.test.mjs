import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import worker from '../src/index.js';
import { database } from './helpers.mjs';

function setup() {
  const { sqlite, db } = database();
  for (const file of readdirSync(new URL('../migrations/', import.meta.url)).filter(f => f.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  sqlite.exec(`
    INSERT INTO clients (slug, name) VALUES ('uep', 'UEP'), ('safe', 'Sober AF');
    INSERT INTO projects (client_id, slug, name, phase, position) VALUES (1, 'scheduler', 'Scheduler', 'uat', 1), (1, 'fundraising', 'Fundraising', 'build', 2), (2, 'chapters', 'Chapters', 'prototype', 1);
    INSERT INTO users (email, name, role, client_id) VALUES ('molly@uep.org', 'Molly', 'ed', 1), ('eric@positivetribes.org', 'Eric', 'pt', NULL);
    INSERT INTO releases (client_id, project_id, number, stage, uat_started, uat_days, uat_day_type) VALUES
      (1, 1, 2, 'signed_off', '2026-11-04', 10, 'business'), (1, 1, 3, 'uat', '2026-11-15', 10, 'business');
  `);
  const env = { DB: db, ADMIN_DB: database().db, HUB_DEV: '1', ASSETS: { fetch: () => new Response('asset') } };
  const call = async (who, path, method = 'GET', payload) => {
    const r = await worker.fetch(new Request('http://localhost/api/' + path, {
      method, headers: { 'x-dev-email': who, 'content-type': 'application/json', origin: 'http://localhost' },
      body: payload ? JSON.stringify(payload) : undefined
    }), env);
    return { status: r.status, body: await r.json() };
  };
  const row = id => sqlite.prepare('SELECT * FROM timeline_entries WHERE id = ?').get(id);
  return { sqlite, call, row };
}
const ERIC = 'eric@positivetribes.org';

test('a bar that follows a phase takes its project and shows the phase live', async () => {
  const { call, row } = setup();
  const made = await call(ERIC, 'admin/timeline', 'POST', { client_id: 1, kind: 'work', label: 'P3 testing', start_date: '2026-11-15', end_date: '2026-12-11', release_id: 2 });
  assert.equal(made.status, 200);
  assert.equal(row(made.body.id).project_id, 1);
  const { body } = await call(ERIC, 'admin/timeline');
  const uep = body.clients.find(c => c.slug === 'uep');
  assert.equal(uep.entries.length, 1);
  assert.equal(uep.releases.find(r => r.id === 2).window_end, '2026-11-27');
  assert.equal(body.clients.find(c => c.slug === 'safe').entries.length, 0);
});

test('a project or phase from another client is refused', async () => {
  const { call } = setup();
  const project = await call(ERIC, 'admin/timeline', 'POST', { client_id: 2, label: 'Build', start_date: '2027-01-04', project_id: 1 });
  assert.equal(project.status, 400);
  const phase = await call(ERIC, 'admin/timeline', 'POST', { client_id: 2, label: 'Build', start_date: '2027-01-04', release_id: 1 });
  assert.equal(phase.status, 400);
});

test('dates, kinds and rows are checked', async () => {
  const { call } = setup();
  const bad = [
    { client_id: 1, label: 'x', start_date: '2027-02-30', lane: 'Row' },
    { client_id: 1, label: 'x', start_date: '2027-03-01', end_date: '2027-02-01', lane: 'Row' },
    { client_id: 1, label: 'x', start_date: '2027-03-01', kind: 'party', lane: 'Row' },
    { client_id: 1, label: 'x', start_date: '2027-03-01' },
    { client_id: 1, label: '', start_date: '2027-03-01', lane: 'Row' },
    { client_id: 1, label: 'x', start_date: '2027-03-01', kind: 'proposed', lane: 'Row', release_id: 2 },
    { client_id: 9, label: 'x', start_date: '2027-03-01', lane: 'Row' }
  ];
  for (const input of bad) assert.equal((await call(ERIC, 'admin/timeline', 'POST', input)).status, 400, JSON.stringify(input));
});

test('a deadline is one date with no row; a proposed bar can have its own row', async () => {
  const { call, row } = setup();
  const mark = await call(ERIC, 'admin/timeline', 'POST', { client_id: 1, kind: 'deadline', label: 'Notice to cancel', start_date: '2027-08-10', end_date: '2027-09-01', project_id: 1, lane: 'x' });
  assert.equal(mark.status, 200);
  assert.deepEqual([row(mark.body.id).end_date, row(mark.body.id).project_id, row(mark.body.id).lane], ['', null, '']);
  const vomo = await call(ERIC, 'admin/timeline', 'POST', { client_id: 1, kind: 'proposed', label: 'Build', start_date: '2027-04-06', end_date: '2027-05-31', lane: 'Volunteer scheduling' });
  assert.equal(row(vomo.body.id).lane, 'Volunteer scheduling');
});

test('editing keeps the client; deleting removes the entry', async () => {
  const { call, row } = setup();
  const { body } = await call(ERIC, 'admin/timeline', 'POST', { client_id: 1, label: 'Build', start_date: '2027-01-04', end_date: '2027-02-12', project_id: 2 });
  const moved = await call(ERIC, 'admin/timeline/' + body.id, 'PUT', { client_id: 2, label: 'Build Jan 4 – Feb 12', start_date: '2027-01-04', end_date: '2027-02-12', project_id: 2 });
  assert.equal(moved.status, 200);
  assert.equal(row(body.id).client_id, 1);
  assert.equal(row(body.id).label, 'Build Jan 4 – Feb 12');
  assert.equal((await call(ERIC, 'admin/timeline/' + body.id, 'DELETE')).status, 200);
  assert.equal(row(body.id), undefined);
  assert.equal((await call(ERIC, 'admin/timeline/' + body.id, 'DELETE')).status, 404);
});

test('clients cannot read or change the timeline', async () => {
  const { call } = setup();
  assert.equal((await call('molly@uep.org', 'admin/timeline')).status, 404);
  assert.equal((await call('molly@uep.org', 'admin/timeline', 'POST', { client_id: 1, label: 'x', start_date: '2027-01-01', lane: 'Row' })).status, 404);
});
