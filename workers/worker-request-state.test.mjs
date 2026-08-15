import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkerRequestState } from './worker-request-state.mjs';

const makePath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dig-worker-requests-')), 'requests.json');

test('persists pending request across restart and clears it', async () => {
  const filePath = makePath();
  const first = new WorkerRequestState({ filePath, now: () => 100 });
  await first.reserve({ action: 'claim', payload: {}, requestId: 'req-1' });
  const second = new WorkerRequestState({ filePath, now: () => 200 });
  assert.equal(second.get('req-1').action, 'claim');
  assert.equal(second.listPending().length, 1);
  assert.equal(await second.clear('req-1'), true);
  assert.equal(second.get('req-1'), null);
});

test('serializes concurrent reservations and rejects duplicate pending ids', async () => {
  const filePath = makePath();
  const states = Array.from({ length: 8 }, () => new WorkerRequestState({ filePath }));
  await Promise.all(states.map((state, index) => state.reserve({ action: 'claim', requestId: `req-${index}` })));
  assert.equal(new WorkerRequestState({ filePath }).listPending().length, 8);
  await assert.rejects(() => states[0].reserve({ action: 'claim', requestId: 'req-0' }), /already pending/);
});

test('uses restrictive permissions on POSIX', async t => {
  if (process.platform === 'win32') return t.skip('POSIX permissions only');
  const filePath = makePath();
  const state = new WorkerRequestState({ filePath });
  await state.reserve({ action: 'claim', requestId: 'req-perms' });
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});
