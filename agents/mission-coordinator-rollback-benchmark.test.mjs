import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkRollbackSnapshotCost, evaluateRollbackSnapshotBudget } from './mission-coordinator-rollback-benchmark.mjs';

test('rollback snapshot benchmark measures increasing queue sizes', () => {
  const results = benchmarkRollbackSnapshotCost({ queueSizes: [10, 100, 1000], samples: 5 });
  assert.deepEqual(results.map(result => result.queueSize), [10, 100, 1000]);
  for (const result of results) {
    assert.equal(result.samples, 5);
    assert.ok(result.p50Ms >= 0);
    assert.ok(result.p95Ms >= result.p50Ms);
    assert.ok(result.maxMs >= result.p95Ms);
  }
});

test('rollback snapshot budget is fail-closed and reports the violating queue size', () => {
  const evaluation = evaluateRollbackSnapshotBudget([
    { queueSize: 10, p95Ms: 1 },
    { queueSize: 100, p95Ms: 8 }
  ], { maxP95MsByQueueSize: { 10: 2, 100: 5 } });
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.checks.find(check => check.queueSize === 100).pass, false);
  assert.throws(() => evaluateRollbackSnapshotBudget([{ queueSize: 1000, p95Ms: 1 }], { maxP95MsByQueueSize: {} }), /missing snapshot budget/);
});
