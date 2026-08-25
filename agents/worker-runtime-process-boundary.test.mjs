import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';

const processWorker = fileURLToPath(new URL('./mission-runtime-process-worker.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-long-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { missionFile: path.join(root, 'missions.json') };
}

function runProcessWorker(args, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [processWorker, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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

function startLongWorker(missionFile, workerId, { durationMs = 420, leaseMs = 120, heartbeatIntervalMs = 30 } = {}) {
  const child = spawn(process.execPath, [
    processWorker,
    'worker-run-long',
    missionFile,
    workerId,
    String(durationMs),
    String(leaseMs),
    String(heartbeatIntervalMs)
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdout = '';
  let stderr = '';
  let claimedId = null;
  let claimedResolve;
  let claimedReject;
  const claimed = new Promise((resolve, reject) => {
    claimedResolve = resolve;
    claimedReject = reject;
  });

  child.stdout.on('data', chunk => {
    stdout += String(chunk);
    for (const line of stdout.split('\n')) {
      if (!claimedId && line.startsWith('CLAIMED:')) {
        claimedId = line.slice('CLAIMED:'.length).trim();
        claimedResolve(claimedId);
      }
    }
  });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  child.on('error', claimedReject);
  child.on('exit', code => {
    if (!claimedId && code !== 0) claimedReject(new Error(`long worker exited before claim (${code}): ${stderr}`));
  });

  const result = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code !== 0) return reject(new Error(`long worker failed (${code ?? signal}): ${stderr}`));
      const resultLine = stdout.split('\n').find(line => line.startsWith('RESULT:'));
      if (!resultLine) return reject(new Error(`long worker produced no result: ${stdout}`));
      try { resolve(JSON.parse(resultLine.slice('RESULT:'.length))); }
      catch (error) { reject(new Error(`invalid long-worker result: ${resultLine}`, { cause: error })); }
    });
  });

  return { child, claimed, result };
}

async function enqueueOne(missionFile, key) {
  const coordinator = await MissionCoordinator.open({ store: new MissionQueueStore(missionFile) });
  return coordinator.enqueue({ task: `long-running-${key}`, idempotencyKey: key });
}

test('spawned long-running worker renews its fenced lease and blocks a competing process reclaim', async t => {
  const { missionFile } = await fixture(t);
  const mission = await enqueueOne(missionFile, 'heartbeat-keeps-authority');
  const longWorker = startLongWorker(missionFile, 'heartbeat-owner');
  assert.equal(await longWorker.claimed, mission.id);

  // Wait beyond the original lease. Automatic heartbeats must keep authority alive.
  await sleep(240);
  const contender = await runProcessWorker(['claim', missionFile, 'competing-worker']);
  assert.equal(contender.id, null, 'competing process must not reclaim a mission with a healthy heartbeat');

  const result = await longWorker.result;
  assert.equal(result.status, 'completed');
  assert.equal(result.id, mission.id);

  const reopened = await MissionCoordinator.open({ store: new MissionQueueStore(missionFile) });
  assert.equal(reopened.get(mission.id)?.status, 'completed');
  assert.equal(reopened.stats().completed, 1);
});

test('spawned worker crash stops heartbeats and permits reclaim only after lease expiry', async t => {
  const { missionFile } = await fixture(t);
  const mission = await enqueueOne(missionFile, 'crash-releases-authority');
  const longWorker = startLongWorker(missionFile, 'crashing-owner', { durationMs: 5_000 });
  assert.equal(await longWorker.claimed, mission.id);

  // While the original process is alive and heartbeating, a contender is blocked.
  await sleep(180);
  const beforeCrash = await runProcessWorker(['claim', missionFile, 'reclaimer-before-crash']);
  assert.equal(beforeCrash.id, null);

  longWorker.child.kill('SIGKILL');
  await new Promise(resolve => longWorker.child.once('exit', resolve));
  await longWorker.result.catch(() => {});

  // The last heartbeat can extend the lease; allow a bounded interval beyond leaseMs.
  await sleep(220);
  const reclaimed = await runProcessWorker(['claim', missionFile, 'reclaimer-after-crash']);
  assert.equal(reclaimed.id, mission.id, 'mission must become reclaimable after heartbeats stop and the lease expires');

  const reopened = await MissionCoordinator.open({
    store: new MissionQueueStore(missionFile),
    queueOptions: { requireLeaseToken: true, preserveRunningLeasesOnRestore: true }
  });
  assert.equal(reopened.get(mission.id)?.status, 'running');
});
