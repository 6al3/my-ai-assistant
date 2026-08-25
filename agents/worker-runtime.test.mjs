import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { WorkerRuntime } from './worker-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-worker-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return new MissionQueueStore(path.join(root, 'missions.json'));
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function blockEventLoop(ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Intentionally synchronous: models CPU-bound executor starvation.
  }
}

test('runOnce claims, executes and durably completes a mission', async t => {
  const store = await fixture(t);
  const runtime = await WorkerRuntime.open({ store, workerId: 'qa-1', capabilities: ['qa'], sessionId: 'boot-a' });
  const mission = await runtime.coordinator.enqueue({ task: 'review synthetic result', requiredCapabilities: ['qa'] });
  const outcome = await runtime.runOnce(async claimed => ({ reviewed: claimed.id }));
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.mission.id, mission.id);
  assert.deepEqual(outcome.mission.result, { reviewed: mission.id });

  const restarted = await WorkerRuntime.open({ store, workerId: 'qa-1', capabilities: ['qa'], sessionId: 'boot-b' });
  assert.equal(restarted.coordinator.get(mission.id).status, 'completed');
});

test('runOnce carries lease fencing tokens through heartbeat and completion', async t => {
  const store = await fixture(t);
  const runtime = await WorkerRuntime.open({
    store,
    workerId: 'fenced-worker',
    sessionId: 'fenced-session',
    queueOptions: { requireLeaseToken: true }
  });
  const mission = await runtime.coordinator.enqueue({ task: 'fenced synthetic work' });
  const outcome = await runtime.runOnce(async (claimed, control) => {
    assert.equal(typeof claimed.leaseToken, 'string');
    assert.ok(claimed.leaseToken.length > 0);
    const heartbeat = await control.heartbeat();
    assert.equal(heartbeat.id, claimed.id);
    assert.equal(heartbeat.leaseToken, claimed.leaseToken);
    return { fenced: true };
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.mission.id, mission.id);
  assert.deepEqual(outcome.mission.result, { fenced: true });
});

test('automatic heartbeat keeps long-running work inside its lease', async t => {
  const store = await fixture(t);
  const runtime = await WorkerRuntime.open({
    store,
    workerId: 'long-worker',
    sessionId: 'long-session',
    heartbeatIntervalMs: 5,
    queueOptions: { requireLeaseToken: true, leaseMs: 25 }
  });
  const mission = await runtime.coordinator.enqueue({ task: 'long synthetic work' });
  const outcome = await runtime.runOnce(async () => {
    await delay(80);
    return { completedAfterMultipleLeases: true };
  });
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.mission.id, mission.id);
  assert.deepEqual(outcome.mission.result, { completedAfterMultipleLeases: true });
});

test('event-loop starvation cannot commit after lease expiry and another worker can reclaim', async t => {
  const store = await fixture(t);
  const queueOptions = { requireLeaseToken: true, leaseMs: 25, maxAttempts: 3 };
  const starved = await WorkerRuntime.open({
    store,
    workerId: 'cpu-bound-worker',
    sessionId: 'starved-session',
    heartbeatIntervalMs: 5,
    queueOptions
  });
  const mission = await starved.coordinator.enqueue({ task: 'cpu-bound synthetic work' });

  await assert.rejects(
    () => starved.runOnce(async () => {
      blockEventLoop(60);
      return { staleResultMustNotCommit: true };
    }),
    error => {
      assert.ok(error instanceof AggregateError);
      assert.match(error.message, /mission failure could not be persisted/);
      return true;
    }
  );

  const observer = await WorkerRuntime.open({
    store,
    workerId: 'replacement-worker',
    sessionId: 'replacement-session',
    heartbeatIntervalMs: 5,
    queueOptions
  });
  const durableBeforeReclaim = observer.coordinator.get(mission.id);
  assert.notEqual(durableBeforeReclaim.status, 'completed', 'starved worker must never commit a stale result');

  const reclaimed = await observer.claim();
  assert.equal(reclaimed.id, mission.id);
  assert.equal(reclaimed.workerId, observer.workerSessionId);
  const completed = await observer.complete(mission.id, { recovered: true });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, { recovered: true });
});

test('automatic heartbeat failure prevents successful completion and fails closed', async () => {
  let heartbeatCalls = 0;
  let completeCalls = 0;
  let failCalls = 0;
  const coordinator = {
    claim: async () => ({ id: 'mission-1', leaseToken: 'lease-1' }),
    heartbeat: async () => {
      heartbeatCalls += 1;
      throw new Error('synthetic heartbeat failure');
    },
    complete: async () => {
      completeCalls += 1;
      return { id: 'mission-1', status: 'completed' };
    },
    fail: async (id, workerId, error, leaseToken) => {
      failCalls += 1;
      assert.equal(id, 'mission-1');
      assert.equal(workerId, 'worker-1@session-1');
      assert.equal(leaseToken, 'lease-1');
      assert.match(error, /automatic mission heartbeat failed/);
      return { id, status: 'queued', attempts: 1 };
    }
  };
  const runtime = new WorkerRuntime({
    coordinator,
    workerId: 'worker-1',
    sessionId: 'session-1',
    heartbeatIntervalMs: 1
  });
  const outcome = await runtime.runOnce(async () => {
    await delay(15);
    return { shouldNotCommit: true };
  });
  assert.ok(heartbeatCalls >= 1);
  assert.equal(completeCalls, 0, 'completion must not happen after heartbeat authority is lost');
  assert.equal(failCalls, 1);
  assert.equal(outcome.status, 'queued');
  assert.match(outcome.error.message, /automatic mission heartbeat failed/);
});

test('same logical worker gets a distinct ownership identity after restart', async t => {
  const store = await fixture(t);
  const first = await WorkerRuntime.open({ store, workerId: 'coder-1', sessionId: 'boot-old', queueOptions: { maxAttempts: 3 } });
  const mission = await first.coordinator.enqueue({ task: 'restart-sensitive work' });
  const oldClaim = await first.claim();
  assert.equal(oldClaim.workerId, 'coder-1@boot-old');

  const restarted = await WorkerRuntime.open({ store, workerId: 'coder-1', sessionId: 'boot-new', queueOptions: { maxAttempts: 3 } });
  const newClaim = await restarted.claim();
  assert.equal(newClaim.id, mission.id);
  assert.equal(newClaim.attempts, 2);
  assert.equal(newClaim.workerId, 'coder-1@boot-new');
  assert.notEqual(first.workerSessionId, restarted.workerSessionId);

  await assert.rejects(
    () => restarted.coordinator.complete(mission.id, first.workerSessionId, { stale: true }),
    /not owned/
  );
  const completed = await restarted.complete(mission.id, { fresh: true });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, { fresh: true });
});

test('lease token fences a stale runtime even when worker session identity is reused', async t => {
  const store = await fixture(t);
  const options = { maxAttempts: 3, requireLeaseToken: true };
  const first = await WorkerRuntime.open({ store, workerId: 'coder-1', sessionId: 'stable-session', queueOptions: options });
  const mission = await first.coordinator.enqueue({ task: 'same-session fencing' });
  const oldClaim = await first.claim();

  const restarted = await WorkerRuntime.open({ store, workerId: 'coder-1', sessionId: 'stable-session', queueOptions: options });
  const newClaim = await restarted.claim();
  assert.equal(newClaim.id, mission.id);
  assert.equal(newClaim.workerId, oldClaim.workerId, 'worker identity is intentionally reused');
  assert.notEqual(newClaim.leaseToken, oldClaim.leaseToken, 'reclaim must issue a new fencing token');

  await assert.rejects(
    () => first.complete(mission.id, { stale: true }),
    /lease token is stale or missing/
  );
  const completed = await restarted.complete(mission.id, { fresh: true });
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result, { fresh: true });
});

test('execution failure is persisted and retryable under fenced queue policy', async t => {
  const store = await fixture(t);
  const queueOptions = { maxAttempts: 2, requireLeaseToken: true };
  const first = await WorkerRuntime.open({ store, workerId: 'worker-a', sessionId: 'a', queueOptions });
  const mission = await first.coordinator.enqueue({ task: 'synthetic fault' });
  const failedAttempt = await first.runOnce(async () => { throw new Error('synthetic worker failure'); });
  assert.equal(failedAttempt.status, 'queued');
  assert.equal(failedAttempt.mission.attempts, 1);

  const second = await WorkerRuntime.open({ store, workerId: 'worker-a', sessionId: 'b', queueOptions });
  const recovered = await second.runOnce(async () => ({ ok: true }));
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.mission.id, mission.id);
  assert.equal(recovered.mission.attempts, 2);
});

test('capabilities are enforced through runtime claims', async t => {
  const store = await fixture(t);
  const runtime = await WorkerRuntime.open({ store, workerId: 'coder', capabilities: ['coder'], sessionId: 'cap' });
  await runtime.coordinator.enqueue({ task: 'qa-only mission', requiredCapabilities: ['qa'] });
  const outcome = await runtime.runOnce(async () => ({ shouldNotRun: true }));
  assert.equal(outcome.status, 'idle');
  assert.equal(runtime.coordinator.stats().queued, 1);
});