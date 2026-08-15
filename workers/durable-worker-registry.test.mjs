import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DurableWorkerRegistry } from './durable-worker-registry.mjs';
import { WorkerAuthenticator, AuthenticatedCoordinator } from './worker-protocol.mjs';
import { DurableMissionQueue } from '../agents/durable-mission-queue.mjs';

const SECRET = 's'.repeat(64);
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-worker-registry-'));
  return { dir, registryPath: path.join(dir, 'workers.json'), queuePath: path.join(dir, 'missions.json') };
};

test('worker registration persists across registry restart', async t => {
  const f = temp(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const r1 = new DurableWorkerRegistry({ filePath: f.registryPath });
  await r1.register({ id: 'coder-1', capabilities: ['coder'], maxConcurrent: 2 });
  const r2 = new DurableWorkerRegistry({ filePath: f.registryPath });
  const worker = await r2.get('coder-1');
  assert.deepEqual(worker.capabilities, ['coder']);
  assert.equal(worker.maxConcurrent, 2);
  assert.equal(worker.lastCounter, 0);
});

test('monotonic replay counter survives coordinator restart', async t => {
  const f = temp(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const registry1 = new DurableWorkerRegistry({ filePath: f.registryPath });
  await registry1.register({ id: 'w', capabilities: ['coder'] });
  const auth1 = new WorkerAuthenticator({ secrets: { w: SECRET }, replayStore: registry1 });
  const signed = auth1.sign({ workerId: 'w', action: 'claim', counter: 1 });
  await auth1.verify(signed);

  const registry2 = new DurableWorkerRegistry({ filePath: f.registryPath });
  const auth2 = new WorkerAuthenticator({ secrets: { w: SECRET }, replayStore: registry2 });
  await assert.rejects(() => auth2.verify(signed), /replay or counter regression/);
  const next = auth2.sign({ workerId: 'w', action: 'claim', counter: 2 });
  await auth2.verify(next);
  assert.equal((await registry2.get('w')).lastCounter, 2);
});

test('concurrent duplicate counter is accepted once', async t => {
  const f = temp(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const seed = new DurableWorkerRegistry({ filePath: f.registryPath, lockRetryMs: 1 });
  await seed.register({ id: 'w' });
  const a = new DurableWorkerRegistry({ filePath: f.registryPath, lockRetryMs: 1 });
  const b = new DurableWorkerRegistry({ filePath: f.registryPath, lockRetryMs: 1 });
  const results = await Promise.allSettled([a.acceptCounter('w', 1), b.acceptCounter('w', 1)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter(r => r.status === 'rejected').length, 1);
});

test('registered capabilities override self-asserted claim capabilities', async t => {
  const f = temp(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const registry = new DurableWorkerRegistry({ filePath: f.registryPath });
  await registry.register({ id: 'w', capabilities: ['qa'] });
  const queue = new DurableMissionQueue({ filePath: f.queuePath });
  await queue.enqueue({ task: 'coder-only', requiredCapabilities: ['coder'] });
  const auth = new WorkerAuthenticator({ secrets: { w: SECRET }, replayStore: registry });
  const coordinator = new AuthenticatedCoordinator({ queue, authenticator: auth, registry });
  const result = await coordinator.handle(auth.sign({ workerId: 'w', action: 'claim', counter: 1, payload: { capabilities: ['coder', 'qa'] } }));
  assert.equal(result, null);
});

test('offline worker is refused after TTL expiry', async t => {
  const f = temp(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  let now = 100;
  const registry = new DurableWorkerRegistry({ filePath: f.registryPath, ttlMs: 10, now: () => now });
  await registry.register({ id: 'w', capabilities: [] });
  const queue = new DurableMissionQueue({ filePath: f.queuePath, now: () => now });
  const auth = new WorkerAuthenticator({ secrets: { w: SECRET }, replayStore: registry, now: () => now });
  const coordinator = new AuthenticatedCoordinator({ queue, authenticator: auth, registry });
  now = 111;
  await assert.rejects(() => coordinator.handle(auth.sign({ workerId: 'w', action: 'claim', counter: 1 })), /offline/);
});
