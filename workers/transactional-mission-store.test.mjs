import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TransactionalMissionStore } from './transactional-mission-store.mjs';

const makeStore = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-txn-'));
  const filePath = path.join(dir, 'state.json');
  return { dir, filePath, store: new TransactionalMissionStore({ filePath }) };
};

test('commits mission mutation and request result in one snapshot', async () => {
  const { store } = makeStore();
  const result = await store.mutateRequest({
    workerId: 'w1', requestId: 'r1', action: 'claim', now: 10,
    mutation: missions => {
      missions.push({ id: 'm1', status: 'running' });
      return { missionId: 'm1' };
    }
  });
  assert.deepEqual(result, { missionId: 'm1' });
  const state = store.read();
  assert.equal(state.missions[0].status, 'running');
  assert.equal(state.requests['w1:r1'].status, 'completed');
  assert.deepEqual(state.requests['w1:r1'].result, { missionId: 'm1' });
});

test('replays completed request without running mutation twice', async () => {
  const { store } = makeStore();
  let calls = 0;
  const run = () => store.mutateRequest({
    workerId: 'w1', requestId: 'r1', action: 'complete',
    mutation: missions => { calls += 1; missions.push({ id: `m${calls}` }); return calls; }
  });
  assert.equal(await run(), 1);
  assert.equal(await run(), 1);
  assert.equal(calls, 1);
  assert.equal(store.read().missions.length, 1);
});

test('before-commit crash leaves neither mission mutation nor request record', async () => {
  const { store } = makeStore();
  await assert.rejects(
    store.transaction(state => {
      state.missions.push({ id: 'm1', status: 'running' });
      state.requests['w1:r1'] = { workerId: 'w1', requestId: 'r1', action: 'claim', status: 'completed', result: { missionId: 'm1' } };
    }, { beforeCommit: () => { throw new Error('simulated crash'); } }),
    /simulated crash/
  );
  const state = store.read();
  assert.deepEqual(state.missions, []);
  assert.deepEqual(state.requests, {});
});

test('restart sees committed mission and request outcome together', async () => {
  const { filePath, store } = makeStore();
  await store.mutateRequest({
    workerId: 'w1', requestId: 'r1', action: 'claim',
    mutation: missions => { missions.push({ id: 'm1', status: 'running' }); return { missionId: 'm1' }; }
  });
  const restarted = new TransactionalMissionStore({ filePath });
  assert.equal(restarted.read().missions[0].id, 'm1');
  assert.equal(restarted.getRequest('w1', 'r1').status, 'completed');
});

test('concurrent duplicate requestId allows one mutation', async () => {
  const { filePath } = makeStore();
  const a = new TransactionalMissionStore({ filePath });
  const b = new TransactionalMissionStore({ filePath });
  let calls = 0;
  const op = store => store.mutateRequest({
    workerId: 'w1', requestId: 'same', action: 'claim',
    mutation: async missions => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 20));
      missions.push({ id: 'm1' });
      return 'ok';
    }
  });
  const results = await Promise.all([op(a), op(b)]);
  assert.deepEqual(results, ['ok', 'ok']);
  assert.equal(calls, 1);
  assert.equal(a.read().missions.length, 1);
});

test('requestId cannot be reused for a different action', async () => {
  const { store } = makeStore();
  await store.mutateRequest({ workerId: 'w1', requestId: 'r1', action: 'claim', mutation: () => 'ok' });
  await assert.rejects(
    store.mutateRequest({ workerId: 'w1', requestId: 'r1', action: 'complete', mutation: () => 'bad' }),
    /different action/
  );
});
