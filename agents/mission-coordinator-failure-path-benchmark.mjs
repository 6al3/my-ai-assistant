import { performance } from 'node:perf_hooks';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueue } from './mission-queue.mjs';

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(values, queueSize) {
  const summary = { p50Ms: percentile(values, 50), p95Ms: percentile(values, 95), maxMs: Math.max(...values) };
  return { ...summary, p95UsPerMission: (summary.p95Ms * 1000) / queueSize };
}

function seedSnapshot(queueSize) {
  const queue = new MissionQueue({ requireLeaseToken: true });
  for (let i = 0; i < queueSize; i += 1) queue.enqueue({ task: `seed-${i}`, idempotencyKey: `seed-${i}` });
  return queue.snapshot();
}

async function failingCoordinator(snapshot) {
  return MissionCoordinator.open({
    queueOptions: { requireLeaseToken: true },
    store: {
      load: async () => structuredClone(snapshot),
      save: async () => { throw new Error('benchmark persistence failure'); }
    }
  });
}

export async function benchmarkCoordinatorFailurePath({ queueSizes = [10, 100, 1000, 5000], samples = 15 } = {}) {
  if (!Array.isArray(queueSizes) || queueSizes.length === 0 || queueSizes.some(n => !Number.isInteger(n) || n < 1)) throw new Error('queueSizes must contain positive integers');
  if (!Number.isInteger(samples) || samples < 3 || samples > 200) throw new Error('samples must be an integer between 3 and 200');

  const results = [];
  for (const queueSize of queueSizes) {
    const snapshot = seedSnapshot(queueSize);
    const enqueueMs = [];
    const claimMs = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const enqueueCoordinator = await failingCoordinator(snapshot);
      const enqueueStart = performance.now();
      await enqueueCoordinator.enqueue({ task: `failed-enqueue-${sample}`, idempotencyKey: `failed-enqueue-${sample}` }).then(
        () => { throw new Error('benchmark enqueue unexpectedly persisted'); },
        error => { if (!/mission persistence failed/.test(error.message)) throw error; }
      );
      enqueueMs.push(performance.now() - enqueueStart);
      if (enqueueCoordinator.stats().total !== queueSize) throw new Error('failed enqueue leaked a ghost mission');
      if (enqueueCoordinator.list().some(m => m.idempotencyKey === `failed-enqueue-${sample}`)) throw new Error('failed enqueue leaked idempotency state');
      if (enqueueCoordinator.healthy) throw new Error('coordinator did not fail closed after enqueue persistence failure');

      const claimCoordinator = await failingCoordinator(snapshot);
      const claimStart = performance.now();
      await claimCoordinator.claim({ id: 'benchmark-worker' }).then(
        () => { throw new Error('benchmark claim unexpectedly persisted'); },
        error => { if (!/mission persistence failed/.test(error.message)) throw error; }
      );
      claimMs.push(performance.now() - claimStart);
      const first = claimCoordinator.list()[0];
      if (first.status !== 'queued' || first.workerId !== null || first.leaseToken !== null || first.attempts !== 0) throw new Error('failed claim leaked ownership state');
      if (claimCoordinator.healthy) throw new Error('coordinator did not fail closed after claim persistence failure');
    }
    results.push({ queueSize, samples, failedEnqueue: summarize(enqueueMs, queueSize), failedClaim: summarize(claimMs, queueSize) });
  }
  return results;
}

export function evaluateCoordinatorFailurePathBudget(results, {
  maxP95MsByQueueSize = { 10: 5, 100: 10, 1000: 50, 5000: 250 },
  maxGrowthRatio1000To5000 = 6,
  maxNormalizedGrowth1000To5000 = 1.2
} = {}) {
  if (!Array.isArray(results) || results.length === 0) throw new Error('benchmark results are required');
  const checks = results.map(result => {
    const budgetMs = maxP95MsByQueueSize[result.queueSize];
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error(`missing coordinator failure-path budget for queue size ${result.queueSize}`);
    const enqueueP95Ms = result.failedEnqueue?.p95Ms;
    const claimP95Ms = result.failedClaim?.p95Ms;
    if (![enqueueP95Ms, claimP95Ms].every(value => Number.isFinite(value) && value >= 0)) throw new Error(`invalid coordinator failure-path measurement for queue size ${result.queueSize}`);
    return { queueSize: result.queueSize, budgetMs, enqueueP95Ms, claimP95Ms, pass: Math.max(enqueueP95Ms, claimP95Ms) <= budgetMs };
  });

  let growth = null;
  const at1000 = results.find(result => result.queueSize === 1000);
  const at5000 = results.find(result => result.queueSize === 5000);
  if (at1000 || at5000) {
    if (!at1000 || !at5000) throw new Error('1000 and 5000 mission measurements are both required for growth evaluation');
    if (!Number.isFinite(maxGrowthRatio1000To5000) || maxGrowthRatio1000To5000 <= 0) throw new Error('maxGrowthRatio1000To5000 must be positive');
    if (!Number.isFinite(maxNormalizedGrowth1000To5000) || maxNormalizedGrowth1000To5000 <= 0) throw new Error('maxNormalizedGrowth1000To5000 must be positive');
    const queueGrowth = at5000.queueSize / at1000.queueSize;
    const enqueueRatio = at5000.failedEnqueue.p95Ms / Math.max(at1000.failedEnqueue.p95Ms, Number.EPSILON);
    const claimRatio = at5000.failedClaim.p95Ms / Math.max(at1000.failedClaim.p95Ms, Number.EPSILON);
    const enqueueNormalized = enqueueRatio / queueGrowth;
    const claimNormalized = claimRatio / queueGrowth;
    growth = {
      queueGrowth,
      enqueueRatio,
      claimRatio,
      enqueueNormalized,
      claimNormalized,
      maxAllowedRatio: maxGrowthRatio1000To5000,
      maxAllowedNormalizedGrowth: maxNormalizedGrowth1000To5000,
      pass: Math.max(enqueueRatio, claimRatio) <= maxGrowthRatio1000To5000 && Math.max(enqueueNormalized, claimNormalized) <= maxNormalizedGrowth1000To5000
    };
  }

  return { ready: checks.every(check => check.pass) && (growth?.pass ?? true), checks, growth };
}
