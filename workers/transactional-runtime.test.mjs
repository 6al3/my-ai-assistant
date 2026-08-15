import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { TransactionalMissionStore } from './transactional-mission-store.mjs';
import { TransactionalWorkerRuntime } from './transactional-runtime.mjs';

const fakeAuth = { async verify(envelope) { return structuredClone(envelope); } };

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-txn-runtime-'));
  const store = new TransactionalMissionStore({ filePath: path.join(dir, 'state.json') });
  return { dir, store, runtime: new TransactionalWorkerRuntime({ store, authenticator: fakeAuth, leaseMs: 10_000, now: () => 1_000 }) };
}

async function seed(store, mission) {
  await store.transaction(state => { state.missions.push(structuredClone(mission)); });
}

const baseMission = {
  id: 'm1', task: 'synthetic defensive simulation', priority: 1,
  requiredCapabilities: ['qa'], dependsOn: [], metadata: {},
  status: 'queued', attempts: 0, workerId: null, leaseUntil: null,
  leaseEpoch: 0, leaseToken: null, createdAt: 1, updatedAt: 1, result: null, error: null
};

test('claim commits mission mutation and request outcome in one snapshot', async () => {
  const { store, runtime } = fixture();
  await seed(store, baseMission);
  const result = await runtime.handle({ workerId: 'w1', action: 'claim', payload: { requestId: 'r1', capabilities: ['qa'] } });
  const state = store.read();
  assert.equal(result.id, 'm1');
  assert.equal(state.missions[0].status, 'running');
  assert.equal(state.requests['w1:r1'].status, 'completed');
  assert.equal(state.requests['w1:r1'].result.id, 'm1');
});

test('duplicate requestId returns stored claim without incrementing attempts', async () => {
  const { store, runtime } = fixture();
  await seed(store, baseMission);
  const req = { workerId: 'w1', action: 'claim', payload: { requestId: 'r1', capabilities: ['qa'] } };
  const first = await runtime.handle(req);
  const second = await runtime.handle(req);
  assert.equal(second.leaseToken, first.leaseToken);
  assert.equal(store.read().missions[0].attempts, 1);
});

test('failed mutation is durably recorded and retry cannot re-execute it', async () => {
  const { store, runtime } = fixture();
  await seed(store, baseMission);
  const bad = { workerId: 'w1', action: 'complete', payload: { requestId: 'bad1', missionId: 'm1', leaseToken: 'wrong' } };
  await assert.rejects(runtime.handle(bad), /mission is not owned by worker/);
  const record = store.getRequest('w1', 'bad1');
  assert.equal(record.status, 'failed');
  await assert.rejects(runtime.handle(bad), /previous request failed/);
  assert.equal(store.read().missions[0].status, 'queued');
});

test('request-status reads the same transactional outcome store', async () => {
  const { store, runtime } = fixture();
  await seed(store, baseMission);
  await runtime.handle({ workerId: 'w1', action: 'claim', payload: { requestId: 'r1', capabilities: ['qa'] } });
  const status = await runtime.handle({ workerId: 'w1', action: 'request-status', payload: { requestId: 'r1' } });
  assert.equal(status.status, 'completed');
  assert.equal(status.result.id, 'm1');
});
