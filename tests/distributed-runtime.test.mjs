import assert from 'node:assert/strict';
import { createMission } from '../agents/mission-queue.mjs';
import { registerWorker, resetWorkersForTest } from '../workers/worker-registry.mjs';
import { dispatchNext, heartbeatDispatch, completeDispatch } from '../workers/distributed-coordinator.mjs';

resetWorkersForTest();
registerWorker({ id: 'hp-coder', capabilities: ['orchestration','planning','coding','qa'], maxConcurrent: 2 });
registerWorker({ id: 'hp-media', capabilities: ['orchestration','planning','media'], maxConcurrent: 1 });

const mission = createMission({ goal: 'Refactor the DIG service and verify the result', priority: 95 });
const dispatched = dispatchNext(30_000);
assert.equal(dispatched.status, 'dispatched');
assert.equal(dispatched.worker.id, 'hp-coder');
assert.equal(dispatched.mission.id, mission.id);
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
console.log('distributed runtime test passed');
