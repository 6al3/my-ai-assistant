import { performance } from 'node:perf_hooks';
import { MissionQueue } from './mission-queue.mjs';

function percentile(values, p) {
  if (!values.length) throw new Error('benchmark samples are required');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function summarize(values) {
  return {
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
    maxMs: Math.max(...values)
  };
}

export function benchmarkRollbackSnapshotCost({ queueSizes = [10, 100, 1000], samples = 25 } = {}) {
  if (!Array.isArray(queueSizes) || queueSizes.length === 0 || queueSizes.some(size => !Number.isInteger(size) || size < 0)) throw new Error('queueSizes must contain non-negative integers');
  if (!Number.isInteger(samples) || samples < 3 || samples > 500) throw new Error('samples must be an integer between 3 and 500');

  return queueSizes.map(queueSize => {
    const queue = new MissionQueue();
    for (let index = 0; index < queueSize; index += 1) queue.enqueue({ task: `benchmark-${index}`, idempotencyKey: `benchmark-${index}` });
    const snapshotTimings = [];
    const rollbackTimings = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const snapshotStarted = performance.now();
      const snapshot = queue.snapshot();
      snapshotTimings.push(performance.now() - snapshotStarted);
      if (snapshot.missions.length !== queueSize) throw new Error('snapshot size mismatch');

      // Measure the actual failure-path restoration used by MissionCoordinator,
      // not only the pre-mutation clone. recoverRunning:false preserves exact state.
      const rollbackStarted = performance.now();
      queue.restore(snapshot, { recoverRunning: false });
      rollbackTimings.push(performance.now() - rollbackStarted);
      if (queue.snapshot().missions.length !== queueSize) throw new Error('rollback size mismatch');
    }
    const snapshotSummary = summarize(snapshotTimings);
    const rollbackSummary = summarize(rollbackTimings);
    return {
      queueSize,
      samples,
      ...snapshotSummary,
      snapshot: snapshotSummary,
      rollback: rollbackSummary,
      fullRollbackP95Ms: snapshotSummary.p95Ms + rollbackSummary.p95Ms
    };
  });
}

export function evaluateRollbackSnapshotBudget(results, {
  maxP95MsByQueueSize = { 10: 2, 100: 5, 1000: 25 },
  maxFullRollbackP95MsByQueueSize = null
} = {}) {
  if (!Array.isArray(results) || results.length === 0) throw new Error('benchmark results are required');
  const checks = results.map(result => {
    const snapshotBudgetMs = maxP95MsByQueueSize[result.queueSize];
    if (!Number.isFinite(snapshotBudgetMs) || snapshotBudgetMs <= 0) throw new Error(`missing snapshot budget for queue size ${result.queueSize}`);
    const snapshotP95Ms = result.snapshot?.p95Ms ?? result.p95Ms;
    if (!Number.isFinite(snapshotP95Ms) || snapshotP95Ms < 0) throw new Error(`invalid snapshot benchmark result for queue size ${result.queueSize}`);

    const fullBudgetMs = maxFullRollbackP95MsByQueueSize?.[result.queueSize] ?? null;
    const fullRollbackP95Ms = result.fullRollbackP95Ms ?? null;
    if (maxFullRollbackP95MsByQueueSize && (!Number.isFinite(fullBudgetMs) || fullBudgetMs <= 0)) throw new Error(`missing full rollback budget for queue size ${result.queueSize}`);
    if (maxFullRollbackP95MsByQueueSize && (!Number.isFinite(fullRollbackP95Ms) || fullRollbackP95Ms < 0)) throw new Error(`missing full rollback measurement for queue size ${result.queueSize}`);

    const snapshotPass = snapshotP95Ms <= snapshotBudgetMs;
    const fullRollbackPass = fullBudgetMs === null ? true : fullRollbackP95Ms <= fullBudgetMs;
    return {
      queueSize: result.queueSize,
      p95Ms: snapshotP95Ms,
      budgetMs: snapshotBudgetMs,
      snapshotPass,
      fullRollbackP95Ms,
      fullRollbackBudgetMs: fullBudgetMs,
      fullRollbackPass,
      pass: snapshotPass && fullRollbackPass
    };
  });
  return { ready: checks.every(check => check.pass), checks };
}
