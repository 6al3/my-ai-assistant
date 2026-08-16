import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { FrameDecoder, encodeFrame } from './qubes-stdio-transport.mjs';
import { QubesWorkerClient } from './qubes-worker-client.mjs';
import { WorkerRequestState } from './worker-request-state.mjs';
import { WorkerCounterState, PersistentWorkerSigner } from './worker-counter-state.mjs';
import { WorkerAuthenticator } from './worker-protocol.mjs';
import { DurableWorkerRegistry } from './durable-worker-registry.mjs';
import { TransactionalMissionStore } from './transactional-mission-store.mjs';
import { rotateWorkerSecret } from './worker-secret-rotation.mjs';
import { readWorkerSecret } from './qrexec-coordinator-entrypoint.mjs';

const entrypoint = fileURLToPath(new URL('./qrexec-coordinator-entrypoint.mjs', import.meta.url));

class CoordinatorProcess {
  constructor(env) {
    this.env = env;
    this.child = null;
  }

  async start() {
    this.child = spawn(process.execPath, [entrypoint], {
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stderr.setEncoding('utf8');
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 35);
      this.child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`coordinator exited during startup with code ${code}`));
      });
    });
    return this;
  }

  async exchange(frameBytes) {
    if (!this.child || this.child.exitCode !== null) throw new Error('coordinator process is not running');
    return new Promise((resolve, reject) => {
      const decoder = new FrameDecoder();
      const chunks = [];
      const onData = chunk => {
        chunks.push(Buffer.from(chunk));
        try {
          const frames = decoder.push(chunk);
          if (frames.length === 1) {
            cleanup();
            resolve(encodeFrame(frames[0]));
          }
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      const onExit = code => {
        cleanup();
        reject(new Error(`coordinator exited before response with code ${code}`));
      };
      const cleanup = () => {
        this.child?.stdout.off('data', onData);
        this.child?.off('exit', onExit);
      };
      this.child.stdout.on('data', onData);
      this.child.once('exit', onExit);
      this.child.stdin.write(frameBytes, error => {
        if (error) {
          cleanup();
          reject(error);
        }
      });
    });
  }

  async stop() {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill('SIGTERM');
    await once(this.child, 'exit');
  }
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dig-qrexec-process-'));
  const stateFile = path.join(root, 'missions.json');
  const registryFile = path.join(root, 'registry.json');
  const manifestFile = path.join(root, 'workers.json');
  const secretDirectory = path.join(root, 'secrets');
  fs.mkdirSync(secretDirectory, { mode: 0o700 });
  const workerId = 'coder-1';
  const oldSecret = 'P'.repeat(48);
  fs.writeFileSync(path.join(secretDirectory, `${workerId}.key`), `${oldSecret}\n`, { mode: 0o600 });
  fs.writeFileSync(manifestFile, JSON.stringify({ workers: [{ id: workerId, capabilities: ['code'] }] }), { mode: 0o600 });

  const store = new TransactionalMissionStore({ filePath: stateFile });
  await store.transaction(state => state.missions.push({
    id: 'mission-process-1', task: 'synthetic defensive financial-system validation', priority: 1,
    requiredCapabilities: [], dependsOn: [], status: 'queued', attempts: 0, leaseEpoch: 0,
    workerId: null, leaseToken: null, leaseUntil: null, createdAt: 1, updatedAt: 1
  }));

  const env = {
    DIG_STATE_FILE: stateFile,
    DIG_WORKER_REGISTRY_FILE: registryFile,
    DIG_WORKER_MANIFEST_FILE: manifestFile,
    DIG_WORKER_SECRET_DIR: secretDirectory
  };
  return { root, stateFile, registryFile, secretDirectory, workerId, oldSecret, env };
}

function makeClient({ f, secret, counterFile, requestFile, exchange }) {
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

test('stdio process boundary survives lost response, credential rotation, and coordinator restart without duplicate mutation', async t => {
  const f = await fixture();
  const session = await new CoordinatorProcess(f.env).start();
  t.after(() => session.stop());

  const counterFile = path.join(f.root, 'worker-counter-old.json');
  const requestFile = path.join(f.root, 'worker-requests.json');
  let loseNextResponse = true;
  const oldClient = makeClient({
    f,
    secret: f.oldSecret,
    counterFile,
    requestFile,
    exchange: async frame => {
      const response = await session.exchange(frame);
      if (loseNextResponse) {
        loseNextResponse = false;
        throw new Error('simulated qrexec session loss after committed response');
      }
      return response;
    }
  });

  const startedAt = performance.now();
  await assert.rejects(
    () => oldClient.claim({ requestId: 'process-boundary-claim' }),
    error => error.requestId === 'process-boundary-claim'
  );
  const commitRoundTripMs = performance.now() - startedAt;
  assert.equal(new TransactionalMissionStore({ filePath: f.stateFile }).read().missions[0].attempts, 1);
  assert.equal(oldClient.requestState.listPending().length, 1);

  const registry = new DurableWorkerRegistry({ filePath: f.registryFile, ttlMs: 60_000 });
  const rotated = await rotateWorkerSecret({ secretDirectory: f.secretDirectory, workerId: f.workerId, registry });
  assert.equal(rotated.oldCredentialRevoked, true);
  await assert.rejects(() => oldClient.requestStatus('process-boundary-claim'), /invalid worker signature/);

  await session.stop();
  await session.start();

  const newSecret = readWorkerSecret({ directory: f.secretDirectory, workerId: f.workerId });
  const newClient = makeClient({
    f,
    secret: newSecret,
    counterFile: path.join(f.root, 'worker-counter-new.json'),
    requestFile,
    exchange: frame => session.exchange(frame)
  });
  const recoveryStartedAt = performance.now();
  const recovered = await newClient.recoverPending();
  const recoveryMs = performance.now() - recoveryStartedAt;

  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].state, 'completed');
  assert.equal(newClient.requestState.listPending().length, 0);
  assert.equal(new TransactionalMissionStore({ filePath: f.stateFile }).read().missions[0].attempts, 1, 'process restart/reconciliation must not duplicate the committed mutation');
  assert.ok(Number.isFinite(commitRoundTripMs) && commitRoundTripMs >= 0);
  assert.ok(Number.isFinite(recoveryMs) && recoveryMs >= 0);
});
