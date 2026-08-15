import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableMissionQueue } from '../agents/durable-mission-queue.mjs';
import { DurableWorkerRegistry } from './durable-worker-registry.mjs';
import { WorkerAuthenticator, AuthenticatedCoordinator } from './worker-protocol.mjs';
import { DurableRequestJournal, JournaledCoordinator } from './durable-request-journal.mjs';

const SECRET = 'j'.repeat(64);
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-request-journal-'));
  return { dir, queuePath: path.join(dir, 'missions.json'), registryPath: path.join(dir, 'workers.json'), journalPath: path.join(dir, 'requests.json') };
};

async function fixture(t) {
  const f = temp(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const queue = new DurableMissionQueue({ filePath: f.queuePath, leaseMs: 10_000 });
  const registry = new DurableWorkerRegistry({ filePath: f.registryPath, ttlMs: 60_000 });
  await registry.register({ id: 'w', capabilities: ['coder'] });
  const auth = new WorkerAuthenticator({ secrets: { w: SECRET }, replayStore: registry });
  const base = new AuthenticatedCoordinator({ queue, authenticator: auth, registry });
  const journal = new DurableRequestJournal({ filePath: f.journalPath });
  const coordinator = new JournaledCoordinator({ coordinator: base, authenticator: auth, journal });
  let counter = 0;
  const sign = (action, payload = {}) => auth.sign({ workerId: 'w', action, counter: ++counter, payload });
  return { ...f, queue, registry, auth, base, journal, coordinator, sign };
}

test('lost response can be recovered through durable request status without repeating mutation', async t => {
  const f = await fixture(t);
  await f.queue.enqueue({ task: 'one', requiredCapabilities: ['coder'] });
  const requestId = 'req-claim-1';
  const first = await f.coordinator.handle(f.sign('claim', { requestId }));
  assert.ok(first?.id);
  const status = await f.coordinator.handle(f.sign('request-status', { requestId }));
  assert.equal(status.status, 'completed');
  assert.equal(status.result.id, first.id);
  assert.equal((await f.queue.stats()).running, 1);
});

test('same requestId with a fresh authenticated envelope returns stored result exactly once', async t => {
  const f = await fixture(t);
  await f.queue.enqueue({ task: 'one', requiredCapabilities: ['coder'] });
  const requestId = 'req-claim-2';
  const first = await f.coordinator.handle(f.sign('claim', { requestId }));
  const retry = await f.coordinator.handle(f.sign('claim', { requestId }));
  assert.equal(retry.id, first.id);
  assert.equal((await f.queue.stats()).running, 1);
  assert.equal((await f.queue.stats()).queued, 0);
});

test('journal survives coordinator restart and preserves completed result', async t => {
  const f = await fixture(t);
  await f.queue.enqueue({ task: 'restart-safe', requiredCapabilities: ['coder'] });
  const requestId = 'req-restart';
  const first = await f.coordinator.handle(f.sign('claim', { requestId }));
  const restartedJournal = new DurableRequestJournal({ filePath: f.journalPath });
  const restarted = new JournaledCoordinator({ coordinator: f.base, authenticator: f.auth, journal: restartedJournal });
  const status = await restarted.handle(f.sign('request-status', { requestId }));
  assert.equal(status.result.id, first.id);
});

test('requestId cannot be reused for a different mutation action', async t => {
  const f = await fixture(t);
  await f.queue.enqueue({ task: 'action-bind', requiredCapabilities: ['coder'] });
  const requestId = 'req-bound';
  const claim = await f.coordinator.handle(f.sign('claim', { requestId }));
  await assert.rejects(() => f.coordinator.handle(f.sign('complete', { requestId, missionId: claim.id, leaseToken: claim.leaseToken })), /different action/);
});

test('failed mutation is journaled and retry does not re-execute it', async t => {
  const f = await fixture(t);
  const requestId = 'req-fail';
  await assert.rejects(() => f.coordinator.handle(f.sign('complete', { requestId, missionId: 'missing', leaseToken: 'none' })), /mission not found/);
  const status = await f.coordinator.handle(f.sign('request-status', { requestId }));
  assert.equal(status.status, 'failed');
  await assert.rejects(() => f.coordinator.handle(f.sign('complete', { requestId, missionId: 'missing', leaseToken: 'none' })), /previous request failed/);
});
