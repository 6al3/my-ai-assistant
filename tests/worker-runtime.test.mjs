import test from 'node:test';
import assert from 'node:assert/strict';
import { MissionQueue } from '../agents/mission-queue.mjs';
import { WorkerRegistry } from '../workers/worker-registry.mjs';
import { Dispatcher } from '../workers/dispatcher.mjs';

function fixture({ leaseMs = 100, ttlMs = 100 } = {}) {
  let now = 1_000;
  const clock = () => now;
  const queue = new MissionQueue({ leaseMs, now: clock, maxAttempts: 3 });
  const registry = new WorkerRegistry({ ttlMs, now: clock });
  const dispatcher = new Dispatcher({ queue, registry });
  return { queue, registry, dispatcher, advance: ms => { now += ms; } };
}

test('dispatches only to a compatible worker and tracks capacity', () => {
  const { queue, registry, dispatcher } = fixture();
  registry.register({ id: 'files-1', capabilities: ['files'] });
  registry.register({ id: 'coder-1', capabilities: ['coder'] });
  queue.enqueue({ task: 'fix bug', requiredCapabilities: ['coder'], priority: 10 });

  const dispatch = dispatcher.dispatchNext();
  assert.equal(dispatch.status, 'dispatched');
  assert.equal(dispatch.worker.id, 'coder-1');
  assert.equal(dispatch.mission.status, 'running');
  assert.equal(registry.get('coder-1').activeJobs, 1);

  const done = dispatcher.complete({ missionId: dispatch.mission.id, workerId: 'coder-1', result: { ok: true } });
  assert.equal(done.status, 'completed');
  assert.equal(registry.get('coder-1').activeJobs, 0);
});

test('least-loaded worker wins deterministically', () => {
  const { queue, registry, dispatcher } = fixture();
  registry.register({ id: 'b', capabilities: ['coder'], maxConcurrent: 2 });
  registry.register({ id: 'a', capabilities: ['coder'], maxConcurrent: 2 });
  queue.enqueue({ task: 'one', requiredCapabilities: ['coder'] });
  queue.enqueue({ task: 'two', requiredCapabilities: ['coder'] });

  const first = dispatcher.dispatchNext();
  const second = dispatcher.dispatchNext();
  assert.equal(first.worker.id, 'a');
  assert.equal(second.worker.id, 'b');
});

test('expired mission lease is fenced and mission can be reclaimed', () => {
  const { queue, registry, dispatcher, advance } = fixture({ leaseMs: 50, ttlMs: 500 });
  registry.register({ id: 'coder-a', capabilities: ['coder'] });
  registry.register({ id: 'coder-b', capabilities: ['coder'] });
  queue.enqueue({ task: 'recover me', requiredCapabilities: ['coder'] });

  const first = dispatcher.dispatchNext();
  advance(60);
  assert.throws(() => dispatcher.complete({ missionId: first.mission.id, workerId: first.worker.id }), /lease expired/);
  dispatcher.recover();
  registry.release(first.worker.id);

  const second = dispatcher.dispatchNext();
  assert.equal(second.status, 'dispatched');
  assert.equal(second.mission.id, first.mission.id);
  assert.equal(second.mission.attempts, 2);
});

test('expired workers are removed from dispatch eligibility', () => {
  const { queue, registry, dispatcher, advance } = fixture({ ttlMs: 50 });
  registry.register({ id: 'stale', capabilities: ['coder'] });
  advance(60);
  queue.enqueue({ task: 'wait', requiredCapabilities: ['coder'] });

  assert.equal(dispatcher.dispatchNext().status, 'idle');
  assert.equal(registry.get('stale').status, 'offline');
  assert.equal(queue.stats().queued, 1);
});

test('heartbeat renews both worker and mission leases', () => {
  const { queue, registry, dispatcher, advance } = fixture({ leaseMs: 50, ttlMs: 50 });
  registry.register({ id: 'coder', capabilities: ['coder'] });
  queue.enqueue({ task: 'long job', requiredCapabilities: ['coder'] });
  const dispatch = dispatcher.dispatchNext();

  advance(40);
  const beat = dispatcher.heartbeat({ missionId: dispatch.mission.id, workerId: 'coder' });
  assert.ok(beat.mission.leaseUntil > 1_040);
  assert.ok(beat.worker.expiresAt > 1_040);
});
