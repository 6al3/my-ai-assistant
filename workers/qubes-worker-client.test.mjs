import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { DurableMissionQueue } from '../agents/durable-mission-queue.mjs';
import { DurableWorkerRegistry } from './durable-worker-registry.mjs';
import { WorkerAuthenticator, AuthenticatedCoordinator } from './worker-protocol.mjs';
import { WorkerCounterState, PersistentWorkerSigner } from './worker-counter-state.mjs';
import { QubesStdioCoordinatorTransport, FrameDecoder } from './qubes-stdio-transport.mjs';
import { QubesWorkerClient } from './qubes-worker-client.mjs';

const SECRET = 'q'.repeat(64);
const temp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-qubes-client-'));
  return { dir, queuePath: path.join(dir, 'missions.json'), registryPath: path.join(dir, 'workers.json'), counterPath: path.join(dir, 'counter.json') };
};

async function exchangeThrough(transport, requestFrame) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on('data', chunk => chunks.push(Buffer.from(chunk)));
  const serving = transport.serve({ input, output });
  input.end(requestFrame);
  await serving;
  return Buffer.concat(chunks);
}

async function fixture(t) {
  const f = temp(); t.after(() => fs.rmSync(f.dir, { recursive: true, force: true }));
  const registry = new DurableWorkerRegistry({ filePath: f.registryPath, ttlMs: 60_000 });
  await registry.register({ id: 'worker', capabilities: ['coder'] });
  const queue = new DurableMissionQueue({ filePath: f.queuePath, leaseMs: 500 });
  const auth = new WorkerAuthenticator({ secrets: { worker: SECRET }, replayStore: registry });
  const coordinator = new AuthenticatedCoordinator({ queue, authenticator: auth, registry });
  const transport = new QubesStdioCoordinatorTransport({ coordinator });
  const signer = new PersistentWorkerSigner({ workerId: 'worker', authenticator: auth, counterState: new WorkerCounterState({ filePath: f.counterPath }) });
  const client = new QubesWorkerClient({ signer, exchange: frame => exchangeThrough(transport, frame) });
  return { ...f, registry, queue, auth, coordinator, transport, signer, client };
}

test('worker client performs signed claim and completion end to end', async t => {
  const f = await fixture(t);
  const mission = await f.queue.enqueue({ task: 'safe synthetic benchmark', requiredCapabilities: ['coder'] });
  const claim = await f.client.claim();
  assert.equal(claim.id, mission.id);
  const done = await f.client.complete(claim, { score: 1 });
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result, { score: 1 });
});

test('worker restart keeps counters monotonic and coordinator accepts next request', async t => {
  const f = await fixture(t);
  await f.queue.enqueue({ task: 'one', requiredCapabilities: ['coder'] });
  const first = await f.client.claim();
  await f.client.complete(first);
  await f.queue.enqueue({ task: 'two', requiredCapabilities: ['coder'] });

  const restartedSigner = new PersistentWorkerSigner({ workerId: 'worker', authenticator: f.auth, counterState: new WorkerCounterState({ filePath: f.counterPath }) });
  const restarted = new QubesWorkerClient({ signer: restartedSigner, exchange: frame => exchangeThrough(f.transport, frame) });
  const second = await restarted.claim();
  assert.equal(second.task, 'two');
  assert.ok((await f.registry.get('worker')).lastCounter >= 3);
});

test('duplicate signed request is rejected exactly once by durable replay fencing', async t => {
  const f = await fixture(t);
  await f.queue.enqueue({ task: 'dup', requiredCapabilities: ['coder'] });
  const envelope = await f.signer.sign({ action: 'claim', payload: {} });
  const { encodeFrame } = await import('./qubes-stdio-transport.mjs');
  const request = encodeFrame(envelope);
  const first = await exchangeThrough(f.transport, request);
  const second = await exchangeThrough(f.transport, request);
  const decode = bytes => { const d = new FrameDecoder(); const out = d.push(bytes); d.finish(); return out[0]; };
  assert.equal(decode(first).ok, true);
  assert.equal(decode(second).ok, false);
  assert.match(decode(second).error.message, /replay|counter regression/);
});

test('truncated transport response fails closed without mutating a second mission', async t => {
  const f = await fixture(t);
  await f.queue.enqueue({ task: 'first', requiredCapabilities: ['coder'] });
  await f.queue.enqueue({ task: 'second', requiredCapabilities: ['coder'] });
  const client = new QubesWorkerClient({ signer: f.signer, exchange: async frame => {
    const full = await exchangeThrough(f.transport, frame);
    return full.subarray(0, Math.max(0, full.length - 1));
  } });
  await assert.rejects(() => client.claim(), /truncated/);
  const stats = await f.queue.stats();
  assert.equal(stats.running, 1);
  assert.equal(stats.queued, 1);
});
