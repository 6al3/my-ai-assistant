import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-runtime-'));
process.env.DIG_MISSION_STORE = path.join(root, 'missions.json');
process.env.DIG_WORKER_STORE = path.join(root, 'workers.json');

const { createMission, getMission } = await import('../agents/mission-queue.mjs');
const { registerWorker, resetWorkersForTest } = await import('../workers/worker-registry.mjs');
const { workerStorePath } = await import('../workers/worker-store.mjs');
const { dispatchNext, heartbeatDispatch, completeDispatch } = await import('../workers/distributed-coordinator.mjs');

resetWorkersForTest();
registerWorker({ id: 'hp-coder', capabilities: ['orchestration','planning','coding','qa'], maxConcurrent: 2 });

assert.equal(workerStorePath(), process.env.DIG_WORKER_STORE);
assert.ok(fs.existsSync(process.env.DIG_WORKER_STORE));
const persisted = JSON.parse(fs.readFileSync(process.env.DIG_WORKER_STORE, 'utf8'));
assert.equal(persisted.workers[0].id, 'hp-coder');

const blocked = createMission({ goal: 'Process this video media workload', priority: 100 });
const runnable = createMission({ goal: 'Refactor code and verify the result', priority: 95 });

const dispatched = dispatchNext(30_000);
assert.equal(dispatched.status, 'dispatched');
assert.equal(dispatched.worker.id, 'hp-coder');
assert.equal(dispatched.mission.id, runnable.id);
assert.equal(getMission(blocked.id).status, 'queued');
assert.ok(dispatched.skipped.some(x => x.missionId === blocked.id));
assert.ok(dispatched.mission.leaseToken);

const beat = heartbeatDispatch({
  missionId: dispatched.mission.id,
  workerId: dispatched.worker.id,
  leaseToken: dispatched.mission.leaseToken,
  leaseMs: 30_000
});
assert.equal(beat.status, 'running');

const done = completeDispatch({
  missionId: dispatched.mission.id,
  workerId: dispatched.worker.id,
  leaseToken: dispatched.mission.leaseToken,
  result: { ok: true }
});
assert.equal(done.status, 'completed');
console.log('distributed runtime reliability test passed');
