import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkRollbackSnapshotCost, evaluateRollbackSnapshotBudget } from './mission-coordinator-rollback-benchmark.mjs';

test('rollback benchmark measures snapshot and exact restore across increasing queue sizes', () => {
  const results = benchmarkRollbackSnapshotCost({ queueSizes: [10, 100, 1000], samples: 5 });
  assert.deepEqual(results.map(result => result.queueSize), [10, 100, 1000]);
  for (const result of results) {
    assert.equal(result.samples, 5);
    assert.ok(result.snapshot.p50Ms >= 0);
    assert.ok(result.snapshot.p95Ms >= result.snapshot.p50Ms);
    assert.ok(result.snapshot.maxMs >= result.snapshot.p95Ms);
    assert.ok(result.rollback.p50Ms >= 0);
    assert.ok(result.rollback.p95Ms >= result.rollback.p50Ms);
    assert.ok(result.rollback.maxMs >= result.rollback.p95Ms);
    assert.equal(result.p95Ms, result.snapshot.p95Ms);
    assert.equal(result.fullRollbackP95Ms, result.snapshot.p95Ms + result.rollback.p95Ms);
  }
});

test('rollback budget remains backward compatible for snapshot-only planning budgets', () => {
  const evaluation = evaluateRollbackSnapshotBudget([
    { queueSize: 10, p95Ms: 1 },
    { queueSize: 100, p95Ms: 8 }
  ], { maxP95MsByQueueSize: { 10: 2, 100: 5 } });
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.checks.find(check => check.queueSize === 100).pass, false);
  assert.throws(() => evaluateRollbackSnapshotBudget([{ queueSize: 1000, p95Ms: 1 }], { maxP95MsByQueueSize: {} }), /missing snapshot budget/);
});

test('full rollback budget fails closed on expensive restore or missing measurements', () => {
  const evaluation = evaluateRollbackSnapshotBudget([
    { queueSize: 100, snapshot: { p95Ms: 2 }, fullRollbackP95Ms: 9 }
  ], {
    maxP95MsByQueueSize: { 100: 5 },
    maxFullRollbackP95MsByQueueSize: { 100: 7 }
  });
  assert.equal(evaluation.ready, false);
  assert.equal(evaluation.checks[0].snapshotPass, true);
  assert.equal(evaluation.checks[0].fullRollbackPass, false);
  assert.throws(() => evaluateRollbackSnapshotBudget([
    { queueSize: 100, snapshot: { p95Ms: 2 } }
  ], {
    maxP95MsByQueueSize: { 100: 5 },
    maxFullRollbackP95MsByQueueSize: { 100: 7 }
  }), /missing full rollback measurement/);
});
