import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FrameDecoder, encodeFrame } from './qubes-stdio-transport.mjs';
import { QubesWorkerClient } from './qubes-worker-client.mjs';
import { WorkerRequestState } from './worker-request-state.mjs';
import { WorkerCounterState, PersistentWorkerSigner } from './worker-counter-state.mjs';
import { WorkerAuthenticator } from './worker-protocol.mjs';
import { DurableWorkerRegistry } from './durable-worker-registry.mjs';
import { TransactionalMissionStore } from './transactional-mission-store.mjs';
import { TransactionalWorkerRuntime } from './transactional-runtime.mjs';
import { rotateWorkerSecret } from './worker-secret-rotation.mjs';
import { readWorkerSecret } from './qrexec-coordinator-entrypoint.mjs';

const decode = bytes => {
  const decoder = new FrameDecoder();
  const frames = decoder.push(bytes);
  decoder.finish();
  assert.equal(frames.length, 1);
  return frames[0];
};

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

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-rotation-campaign-'));
  const secretDirectory = path.join(root, 'secrets');
  fs.mkdirSync(secretDirectory, { mode: 0o700 });
  const workerId = 'coder-1';
  const oldSecret = 'A'.repeat(48);
  fs.writeFileSync(path.join(secretDirectory, `${workerId}.key`), `${oldSecret}\n`, { mode: 0o600 });
  const registry = new DurableWorkerRegistry({ filePath: path.join(root, 'registry.json'), ttlMs: 60_000 });
  await registry.register({ id: workerId, capabilities: ['code'] });
  const store = new TransactionalMissionStore({ filePath: path.join(root, 'missions.json') });
  await store.transaction(state => state.missions.push({
    id: 'mission-1', task: 'synthetic defensive payment-system validation', priority: 1,
    requiredCapabilities: [], dependsOn: [], status: 'queued', attempts: 0, leaseEpoch: 0,
    workerId: null, leaseToken: null, leaseUntil: null, createdAt: 1, updatedAt: 1
  }));
  const verifier = new WorkerAuthenticator({
    secrets: id => readWorkerSecret({ directory: secretDirectory, workerId: id }), replayStore: registry
  });
  const runtime = new TransactionalWorkerRuntime({ store, authenticator: verifier, registry, leaseMs: 5_000 });
  return { root, secretDirectory, workerId, oldSecret, registry, store, runtime };
}

function persistentClient({ f, secret, counterFile, requestFile, exchange }) {
  const signingAuth = new WorkerAuthenticator({ secrets: { [f.workerId]: secret } });
  const signer = new PersistentWorkerSigner({
    workerId: f.workerId,
    authenticator: signingAuth,
    counterState: new WorkerCounterState({ filePath: counterFile })
  });
  return new QubesWorkerClient({
    signer,
    requestState: new WorkerRequestState({ filePath: requestFile }),
    exchange
  });
}

test('rotation during a committed pending mutation rejects old key and reconciles with re-enrolled worker without duplicate mutation', async () => {
  const f = await fixture();
  const counterFile = path.join(f.root, 'worker-counter.json');
  const requestFile = path.join(f.root, 'worker-requests.json');
  const oldClient = persistentClient({
    f, secret: f.oldSecret, counterFile, requestFile,
    exchange: exchangeFor(f.runtime, { loseAfterCommit: true })
  });

  await assert.rejects(() => oldClient.claim({ requestId: 'rotation-pending-claim' }), error => error.requestId === 'rotation-pending-claim');
  assert.equal(f.store.read().missions[0].attempts, 1);
  assert.equal(oldClient.requestState.listPending().length, 1);

  const rotated = await rotateWorkerSecret({ secretDirectory: f.secretDirectory, workerId: f.workerId, registry: f.registry });
  assert.equal(rotated.oldCredentialRevoked, true);
  assert.equal(rotated.counterResetTo, 0);

  oldClient.exchange = exchangeFor(f.runtime);
  await assert.rejects(() => oldClient.requestStatus('rotation-pending-claim'), /invalid worker signature/);

  const newSecret = readWorkerSecret({ directory: f.secretDirectory, workerId: f.workerId });
  const reenrolledCounter = path.join(f.root, 'worker-counter-generation-2.json');
  const restarted = persistentClient({
    f, secret: newSecret, counterFile: reenrolledCounter, requestFile,
    exchange: exchangeFor(f.runtime)
  });
  const recovered = await restarted.recoverPending();

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, 'completed');
  assert.equal(restarted.requestState.listPending().length, 0);
  assert.equal(f.store.read().missions[0].attempts, 1, 'status reconciliation must not duplicate the committed claim');
  assert.equal(new WorkerCounterState({ filePath: reenrolledCounter }).peek(), 2, 'new credential generation starts from counter 1');
});
