import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrameDecoder, encodeFrame } from './qubes-stdio-transport.mjs';
import { QubesWorkerClient } from './qubes-worker-client.mjs';
import { WorkerRequestState } from './worker-request-state.mjs';
import { TransactionalMissionStore } from './transactional-mission-store.mjs';
import { TransactionalWorkerRuntime } from './transactional-runtime.mjs';

const tempPaths = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-e2e-fault-'));
  return {
    store: path.join(dir, 'mission-store.json'),
    worker: name => path.join(dir, `${name}-requests.json`)
  };
};

const decode = bytes => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(bytes);
  decoder.finish();
  assert.equal(frames.length, 1);
  return frames[0];
};

const signer = workerId => ({ sign: async ({ action, payload }) => ({ workerId, action, payload }) });
const authenticator = { verify: async envelope => envelope };

const exchangeFor = (runtime, { loseAfterCommit = false } = {}) => async frame => {
  const envelope = decode(frame);
  try {
    const result = await runtime.handle(envelope);
    if (loseAfterCommit && envelope.action !== 'request-status') throw new Error('simulated response loss after commit');
    return encodeFrame({ ok: true, result });
  } catch (error) {
    if (error.message === 'simulated response loss after commit') throw error;
    return encodeFrame({ ok: false, error: { code: 'REMOTE_REJECTED', message: String(error?.message ?? error) } });
  }
};

async function seed(store, count = 1) {
  await store.transaction(state => {
    for (let i = 0; i < count; i += 1) {
      state.missions.push({
        id: `mission-${i + 1}`,
        task: `synthetic defensive task ${i + 1}`,
        priority: count - i,
        requiredCapabilities: [],
        dependsOn: [],
        status: 'queued',
        attempts: 0,
        leaseEpoch: 0,
        workerId: null,
        leaseToken: null,
        leaseUntil: null,
        createdAt: i + 1,
        updatedAt: i + 1
      });
    }
  });
}

test('lost response after commit is reconciled after worker and coordinator restart without duplicate claim', async () => {
  const files = tempPaths();
  const store = new TransactionalMissionStore({ filePath: files.store });
  await seed(store);
  let now = 1_000;
  const runtime1 = new TransactionalWorkerRuntime({ store, authenticator, now: () => now, leaseMs: 500 });
  const requestState1 = new WorkerRequestState({ filePath: files.worker('worker-a') });
  const client1 = new QubesWorkerClient({
    signer: signer('worker-a'),
    requestState: requestState1,
    requestIdFactory: () => 'req-claim-lost',
    exchange: exchangeFor(runtime1, { loseAfterCommit: true })
  });

  await assert.rejects(() => client1.claim(), error => error.requestId === 'req-claim-lost');
  assert.equal(store.read().missions[0].attempts, 1);
  assert.equal(new WorkerRequestState({ filePath: files.worker('worker-a') }).listPending().length, 1);

  now = 1_050;
  const runtime2 = new TransactionalWorkerRuntime({
    store: new TransactionalMissionStore({ filePath: files.store }),
    authenticator,
    now: () => now,
    leaseMs: 500
  });
  const restarted = new QubesWorkerClient({
    signer: signer('worker-a'),
    requestState: new WorkerRequestState({ filePath: files.worker('worker-a') }),
    exchange: exchangeFor(runtime2)
  });

  const recovered = await restarted.recoverPending();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, 'completed');
  assert.equal(restarted.requestState.listPending().length, 0);
  assert.equal(store.read().missions[0].attempts, 1, 'recovery must not execute a second claim');
});

test('expired stale owner cannot complete after another worker reclaims the lease', async () => {
  const files = tempPaths();
  const store = new TransactionalMissionStore({ filePath: files.store });
  await seed(store);
  let now = 5_000;
  const runtime = new TransactionalWorkerRuntime({ store, authenticator, now: () => now, leaseMs: 100, maxAttempts: 3 });

  const aState = new WorkerRequestState({ filePath: files.worker('worker-a') });
  const a = new QubesWorkerClient({ signer: signer('worker-a'), requestState: aState, exchange: exchangeFor(runtime) });
  const firstLease = await a.claim({ requestId: 'a-claim' });
  assert.equal(firstLease.leaseEpoch, 1);

  now = 5_200;
  const b = new QubesWorkerClient({ signer: signer('worker-b'), exchange: exchangeFor(runtime) });
  const secondLease = await b.claim({ requestId: 'b-claim' });
  assert.equal(secondLease.id, firstLease.id);
  assert.equal(secondLease.leaseEpoch, 2);
  assert.notEqual(secondLease.leaseToken, firstLease.leaseToken);

  await assert.rejects(() => a.complete(firstLease, { shouldNotCommit: true }, { requestId: 'a-stale-complete' }));
  const after = store.read().missions[0];
  assert.equal(after.status, 'running');
  assert.equal(after.workerId, 'worker-b');
  assert.equal(after.leaseEpoch, 2);
  assert.equal(after.result, undefined);

  const recovered = await a.recoverPending();
  assert.equal(recovered.find(x => x.requestId === 'a-stale-complete')?.state, 'failed');
  assert.equal(aState.get('a-stale-complete'), null);
});

test('8 concurrent workers finish 24 synthetic missions with zero duplicate mission completions', async () => {
  const files = tempPaths();
  const store = new TransactionalMissionStore({ filePath: files.store, lockRetryMs: 1 });
  await seed(store, 24);
  let requestSequence = 0;
  const runtime = new TransactionalWorkerRuntime({ store, authenticator, leaseMs: 5_000 });
  const completions = [];
  const started = performance.now();

  await Promise.all(Array.from({ length: 8 }, (_, index) => (async () => {
    const workerId = `worker-${index + 1}`;
    const client = new QubesWorkerClient({
      signer: signer(workerId),
      requestIdFactory: () => `${workerId}-req-${++requestSequence}`,
      exchange: exchangeFor(runtime)
    });
    while (true) {
      const mission = await client.claim();
      if (!mission) break;
      const completed = await client.complete(mission, { workerId });
      completions.push(completed.id);
    }
  })()));

  const elapsedMs = performance.now() - started;
  const finalState = store.read();
  assert.equal(finalState.missions.filter(m => m.status === 'completed').length, 24);
  assert.equal(new Set(completions).size, 24);
  assert.equal(completions.length, 24);
  assert.ok(elapsedMs < 10_000, `fault harness unexpectedly slow: ${elapsedMs.toFixed(1)}ms`);
});
