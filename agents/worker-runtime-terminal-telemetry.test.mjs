import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerRuntime } from './worker-runtime.mjs';

function coordinatorFor({ shouldFail = false } = {}) {
  return {
    claim: async () => ({ id: 'mission-1', leaseToken: 'lease-1' }),
    heartbeat: async (id, workerId, leaseToken) => ({ id, workerId, leaseToken }),
    complete: async (id, workerId, result) => ({ id, workerId, result, status: 'completed' }),
    fail: async (id, workerId, error) => ({ id, workerId, error, status: 'queued', attempts: 1 }),
    shouldFail
  };
}

test('successful terminal path emits one terminalRenewal event before completion', async () => {
  const events = [];
  const runtime = new WorkerRuntime({
    coordinator: coordinatorFor(),
    workerId: 'worker-a',
    sessionId: 'session-a',
    heartbeatIntervalMs: 10000,
    onLeaseTelemetry: event => events.push(event)
  });
  const outcome = await runtime.runOnce(async () => ({ ok: true }));
  assert.equal(outcome.status, 'completed');
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, 'terminalRenewal');
  assert.equal(events[0].missionId, 'mission-1');
  assert.equal(events[0].workerSessionId, 'worker-a@session-a');
  assert.equal('leaseToken' in events[0], false, 'telemetry must not expose fencing secrets');
  assert.ok(Number.isFinite(events[0].durationMs) && events[0].durationMs >= 0);
});

test('failure terminal path emits terminalRenewal before persisting failure', async () => {
  const events = [];
  const runtime = new WorkerRuntime({
    coordinator: coordinatorFor({ shouldFail: true }),
    workerId: 'worker-b',
    sessionId: 'session-b',
    heartbeatIntervalMs: 10000,
    onLeaseTelemetry: event => events.push(event)
  });
  const outcome = await runtime.runOnce(async () => { throw new Error('synthetic failure'); });
  assert.equal(outcome.status, 'queued');
  assert.equal(events.length, 1);
  assert.equal(events[0].phase, 'terminalRenewal');
  assert.equal('leaseToken' in events[0], false);
});
