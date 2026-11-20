import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanUsage, pocUsage } from '../src/pocusage.js';

const POC = [{ binding: 'POC_X', client: 'Example', workspace: 'ex', name: 'Tracker' }];

test('usage keeps only plain numbers and short strings', () => {
  const u = cleanUsage({ people: [{ email: 'a@b.org', days: 2, screens: '5', last: '2026-11-20 02:20:50', sites: { concept: 4, review: 1, '<x>': 9 }, extra: 'no' }, { days: 1 }], lastEver: '2026-11-20 02:20:50' });
  assert.deepEqual(u, { people: [{ email: 'a@b.org', days: 2, screens: 5, last: '2026-11-20 02:20:50', sites: { concept: 4, review: 1 } }], lastEver: '2026-11-20 02:20:50' });
  assert.deepEqual(cleanUsage(null), { people: [], lastEver: null });
});

test('a connected PoC is read; a missing binding is skipped', async () => {
  const env = { POC_X: { week: async () => ({ people: [{ email: 'a@b.org', days: 1, screens: 3, sites: { concept: 3 }, last: '2026-11-20 01:00:00' }], lastEver: '2026-11-20 01:00:00' }) } };
  const [r] = await pocUsage(env, POC);
  assert.equal(r.ok, true);
  assert.equal(r.people[0].screens, 3);
  assert.deepEqual(await pocUsage({}, POC), []);
});

test('a broken PoC shows as unreadable instead of failing Today', async () => {
  const [r] = await pocUsage({ POC_X: { week: async () => { throw new Error('down'); } } }, POC);
  assert.deepEqual([r.ok, r.people.length, r.client], [false, 0, 'Example']);
});
