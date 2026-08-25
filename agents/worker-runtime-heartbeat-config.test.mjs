import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkerRuntime } from './worker-runtime.mjs';

test('WorkerRuntime.open rejects heartbeat intervals that can outlive the lease before touching storage', async () => {
  let storeTouched = false;
  const store = {
    load: async () => {
      storeTouched = true;
      throw new Error('store should not be touched for invalid heartbeat configuration');
    }
  };

  await assert.rejects(
    () => WorkerRuntime.open({
      store,
      workerId: 'unsafe-heartbeat-worker',
      sessionId: 'unsafe-heartbeat-session',
      heartbeatIntervalMs: 100,
      queueOptions: { leaseMs: 100, requireLeaseToken: true }
    }),
    /heartbeatIntervalMs must be positive and less than leaseMs/
  );
  assert.equal(storeTouched, false, 'invalid lease/heartbeat configuration must fail before coordinator storage I/O');
});

test('WorkerRuntime.open rejects heartbeat intervals longer than the lease', async () => {
  const store = { load: async () => ({ version: 1, missions: [], idempotency: [] }) };
  await assert.rejects(
    () => WorkerRuntime.open({
      store,
      workerId: 'late-heartbeat-worker',
      sessionId: 'late-heartbeat-session',
      heartbeatIntervalMs: 250,
      queueOptions: { leaseMs: 100, requireLeaseToken: true }
    }),
    /heartbeatIntervalMs must be positive and less than leaseMs/
  );
});
