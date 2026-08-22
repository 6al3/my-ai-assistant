import { performance } from 'node:perf_hooks';
import { MissionQueue } from './mission-queue.mjs';

function percentile(values, p) {
  if (!values.length) throw new Error('benchmark samples are required');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

export function benchmarkRollbackSnapshotCost({ queueSizes = [10, 100, 1000], samples = 25 } = {}) {
  if (!Array.isArray(queueSizes) || queueSizes.length === 0 || queueSizes.some(size => !Number.isInteger(size) || size < 0)) throw new Error('queueSizes must contain non-negative integers');
  if (!Number.isInteger(samples) || samples < 3 || samples > 500) throw new Error('samples must be an integer between 3 and 500');

  return queueSizes.map(queueSize => {
    const queue = new MissionQueue();
    for (let index = 0; index < queueSize; index += 1) queue.enqueue({ task: `benchmark-${index}`, idempotencyKey: `benchmark-${index}` });
    const timings = [];
    for (let sample = 0; sample < samples; sample += 1) {
      const started = performance.now();
      const snapshot = queue.snapshot();
      const elapsed = performance.now() - started;
      if (snapshot.missions.length !== queueSize) throw new Error('snapshot size mismatch');
      timings.push(elapsed);
    }
    return {
      queueSize,
      samples,
      p50Ms: percentile(timings, 50),
      p95Ms: percentile(timings, 95),
      maxMs: Math.max(...timings)
    };
  });
}

export function evaluateRollbackSnapshotBudget(results, { maxP95MsByQueueSize = { 10: 2, 100: 5, 1000: 25 } } = {}) {
  if (!Array.isArray(results) || results.length === 0) throw new Error('benchmark results are required');
  const checks = results.map(result => {
    const budgetMs = maxP95MsByQueueSize[result.queueSize];
    if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new Error(`missing snapshot budget for queue size ${result.queueSize}`);
    return { queueSize: result.queueSize, p95Ms: result.p95Ms, budgetMs, pass: result.p95Ms <= budgetMs };
  });
  return { ready: checks.every(check => check.pass), checks };
}
