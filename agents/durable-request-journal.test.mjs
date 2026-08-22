import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableRequestJournal, digestWorkerCommand } from './durable-request-journal.mjs';
import { MissionQueue } from './mission-queue.mjs';

test('journal survives restart and rejects requestId command substitution', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-journal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'requests.json');
  const digest = digestWorkerCommand({ op: 'complete', body: { id: 'm1', workerId: 'w1', result: { ok: true } } });
  const first = await DurableRequestJournal.open(file);
  await first.begin({ requestId: 'r1', digest });
  await first.commit('r1', { ok: true, result: { id: 'm1' } });
  const restarted = await DurableRequestJournal.open(file);
  assert.equal(restarted.get('r1').status, 'committed');
  assert.deepEqual(restarted.get('r1').response, { ok: true, result: { id: 'm1' } });
  await assert.rejects(() => restarted.begin({ requestId: 'r1', digest: digestWorkerCommand({ op: 'complete', body: { id: 'm2' } }) }), /different command/);
});

test('duplicate completion after committed-response loss returns same result without a second mutation', () => {
  const queue = new MissionQueue();
  const mission = queue.enqueue({ task: 'synthetic work' });
  queue.claim({ id: 'worker-a' });
  const first = queue.complete(mission.id, 'worker-a', { value: 7 });
  const updatedAt = first.updatedAt;
  const retry = queue.complete(mission.id, 'worker-a', { value: 7 });
  assert.deepEqual(retry.result, { value: 7 });
  assert.equal(retry.updatedAt, updatedAt);
  assert.equal(queue.stats().completed, 1);
  assert.throws(() => queue.complete(mission.id, 'worker-a', { value: 8 }), /conflicts with committed result/);
  assert.throws(() => queue.complete(mission.id, 'worker-b', { value: 7 }), /conflicts with committed result/);
});
