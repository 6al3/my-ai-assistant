import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { DurableRequestJournal } from './durable-request-journal.mjs';
import { withFileMutationLock } from './file-mutation-lock.mjs';

const worker = fileURLToPath(new URL('./mission-runtime-process-worker.mjs', import.meta.url));

function runWorker(args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process worker timeout: ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`process worker failed (${code}): ${stderr}`));
      try { resolve(JSON.parse(stdout)); } catch (error) { reject(new Error(`invalid process worker output: ${stdout}`, { cause: error })); }
    });
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-process-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    missionFile: path.join(root, 'missions.json'),
    journalFile: path.join(root, 'requests.json'),
    lockPath: path.join(root, 'crash.lock')
  };
}

test('spawned coordinators preserve concurrent enqueues and distinct claims', async t => {
  const { missionFile } = await fixture(t);
  const keys = Array.from({ length: 16 }, (_, index) => `spawn-${index}`);
  const created = await Promise.all(keys.map(key => runWorker(['enqueue', missionFile, key])));
  assert.equal(new Set(created.map(item => item.id)).size, keys.length);

  const reopened = await MissionCoordinator.open({ store: new MissionQueueStore(missionFile) });
  assert.equal(reopened.stats().total, keys.length);
  assert.deepEqual(reopened.list().map(item => item.idempotencyKey).sort(), [...keys].sort());

  const [a, b] = await Promise.all([
    runWorker(['claim', missionFile, 'spawn-worker-a']),
    runWorker(['claim', missionFile, 'spawn-worker-b'])
  ]);
  assert.ok(a.id && b.id);
  assert.notEqual(a.id, b.id);
});

test('spawned journals preserve concurrent request begins without lost updates', async t => {
  const { journalFile } = await fixture(t);
  const ids = Array.from({ length: 16 }, (_, index) => `request-${index}`);
  await Promise.all(ids.map(id => runWorker(['journal-begin', journalFile, id])));

  const reopened = await DurableRequestJournal.open(journalFile);
  for (const id of ids) assert.equal(reopened.get(id)?.requestId, id);
});

test('dead lock owner is reclaimed by a separate process boundary', async t => {
  const { lockPath } = await fixture(t);
  const child = spawn(process.execPath, [worker, 'hold-lock', lockPath, 'unused'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('lock holder did not acquire lock')), 5_000);
    child.stdout.on('data', chunk => {
      if (String(chunk).includes('LOCKED')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('error', reject);
  });
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));

  const started = performance.now();
  let entered = false;
  await withFileMutationLock(lockPath, async () => { entered = true; }, { timeoutMs: 2_000, retryMs: 10 });
  const recoveryMs = performance.now() - started;
  assert.equal(entered, true);
  assert.ok(recoveryMs < 2_000, `stale lock recovery took ${recoveryMs}ms`);
});
