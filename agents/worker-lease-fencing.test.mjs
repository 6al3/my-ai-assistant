import assert from 'node:assert/strict';
import test from 'node:test';
import { MissionQueue } from './mission-queue.mjs';

test('same worker identity cannot complete with a stale lease token after reclaim', () => {
  let now = 0;
  const queue = new MissionQueue({ leaseMs: 10, now: () => now, requireLeaseToken: true });
  const mission = queue.enqueue({ task: 'synthetic fenced work' });
  const first = queue.claim({ id: 'worker@stable' });
  now = 11;
  queue.requeueExpired();
  const second = queue.claim({ id: 'worker@stable' });
  assert.equal(second.id, mission.id);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.throws(() => queue.complete(mission.id, 'worker@stable', { generation: 1 }, first.leaseToken), /lease token is stale or missing/);
  assert.equal(queue.get(mission.id).status, 'running');
  assert.equal(queue.complete(mission.id, 'worker@stable', { generation: 2 }, second.leaseToken).status, 'completed');
});

test('fenced queue rejects missing tokens for worker mutations', () => {
  for (const op of ['heartbeat', 'fail', 'complete']) {
    const queue = new MissionQueue({ requireLeaseToken: true });
    const mission = queue.enqueue({ task: `synthetic ${op}` });
    queue.claim({ id: 'worker' });
    assert.throws(() => {
      if (op === 'heartbeat') queue.heartbeat(mission.id, 'worker');
      else if (op === 'fail') queue.fail(mission.id, 'worker', 'synthetic');
      else queue.complete(mission.id, 'worker', { ok: true });
    }, /lease token is stale or missing/);
  }
});

test('completed-response replay requires the original lease token in fenced mode', () => {
  const queue = new MissionQueue({ requireLeaseToken: true });
  const mission = queue.enqueue({ task: 'synthetic idempotent completion' });
  const claim = queue.claim({ id: 'worker' });
  const first = queue.complete(mission.id, 'worker', { value: 7 }, claim.leaseToken);
  assert.deepEqual(queue.complete(mission.id, 'worker', { value: 7 }, claim.leaseToken), first);
  assert.throws(() => queue.complete(mission.id, 'worker', { value: 7 }, '00000000-0000-4000-8000-000000000000'), /conflicts with committed result/);
});
