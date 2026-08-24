import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { DurableRequestJournal } from './durable-request-journal.mjs';
import { evaluateContentionQualification } from './mission-runtime-contention-qualification.mjs';

const defaultWorker = fileURLToPath(new URL('./mission-runtime-process-worker.mjs', import.meta.url));

function validateCount(value, label) {
  if (!Number.isInteger(value) || value < 2 || value > 64) throw new Error(`${label} must be an integer between 2 and 64`);
}

function runWorker(workerPath, args, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [workerPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
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
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`invalid process worker output: ${stdout}`, { cause: error }));
      }
    });
  });
}

export async function runMissionRuntimeContentionCampaign({
  enqueueCount = 12,
  claimCount = 8,
  journalCount = 12,
  minimumSamplesPerPath = 8,
  lockWaitP95Ms = 9_000,
  durableCommitP95Ms = 9_500,
  timeoutMs = 10_000,
  workerPath = defaultWorker,
  root = null,
  runId = randomUUID()
} = {}) {
  for (const [value, label] of [[enqueueCount, 'enqueueCount'], [claimCount, 'claimCount'], [journalCount, 'journalCount']]) {
    validateCount(value, label);
  }
  if (!Number.isInteger(minimumSamplesPerPath) || minimumSamplesPerPath < 2) throw new Error('minimumSamplesPerPath must be an integer >= 2');
  if (minimumSamplesPerPath > Math.min(enqueueCount, claimCount, journalCount)) throw new Error('minimumSamplesPerPath exceeds campaign sample counts');
  if (typeof runId !== 'string' || runId.length < 8) throw new Error('runId is required');

  const ownsRoot = !root;
  const campaignRoot = root ?? await mkdtemp(path.join(os.tmpdir(), 'dig-contention-campaign-'));
  const missionFile = path.join(campaignRoot, 'missions.json');
  const journalFile = path.join(campaignRoot, 'requests.json');
  const run = (...args) => runWorker(workerPath, args, { timeoutMs });

  try {
    const enqueueKeys = Array.from({ length: enqueueCount }, (_, index) => `${runId}-enqueue-${index}`);
    const enqueue = await Promise.all(enqueueKeys.map(key => run('enqueue', missionFile, key)));
    if (new Set(enqueue.map(item => item.id)).size !== enqueueCount) throw new Error('contention campaign detected duplicate/lost enqueue identities');

    const claimWorkers = Array.from({ length: claimCount }, (_, index) => `${runId}-worker-${index}`);
    const claim = await Promise.all(claimWorkers.map(workerId => run('claim', missionFile, workerId)));
    if (claim.some(item => !item.id)) throw new Error('contention campaign did not claim enough missions');
    if (new Set(claim.map(item => item.id)).size !== claimCount) throw new Error('contention campaign detected double claim');

    const requestIds = Array.from({ length: journalCount }, (_, index) => `${runId}-request-${index}`);
    const journal = await Promise.all(requestIds.map(requestId => run('journal-begin', journalFile, requestId)));

    const evaluation = evaluateContentionQualification({ enqueue, claim, journal }, {
      minimumSamplesPerPath,
      lockWaitP95Ms,
      durableCommitP95Ms
    });
    if (!evaluation.ready) throw new Error('contention campaign failed per-run qualification');

    const reopened = await MissionCoordinator.open({ store: new MissionQueueStore(missionFile) });
    const stats = reopened.stats();
    if (stats.total !== enqueueCount) throw new Error(`lost missions after reopen: expected ${enqueueCount}, got ${stats.total}`);
    if (stats.running !== claimCount) throw new Error(`claim durability mismatch: expected ${claimCount}, got ${stats.running}`);

    const reopenedJournal = await DurableRequestJournal.open(journalFile);
    for (const requestId of requestIds) {
      if (reopenedJournal.get(requestId)?.requestId !== requestId) throw new Error(`lost durable request: ${requestId}`);
    }

    return {
      schemaVersion: 1,
      runId,
      counts: { enqueue: enqueueCount, claim: claimCount, journal: journalCount },
      correctness: {
        lostMissions: 0,
        lostRequests: 0,
        doubleClaims: 0,
        durableMissionTotal: stats.total,
        durableRunningTotal: stats.running
      },
      evaluation
    };
  } finally {
    if (ownsRoot) await rm(campaignRoot, { recursive: true, force: true }).catch(() => {});
  }
}
