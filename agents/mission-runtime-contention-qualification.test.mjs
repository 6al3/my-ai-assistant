import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateContentionQualification, summarizeContentionTimings } from './mission-runtime-contention-qualification.mjs';

const sample = (lockWaitMs, durableCommitMs) => ({ lockWaitMs, durableCommitMs });

function fixture() {
  return {
    enqueue: [sample(1, 3), sample(2, 4), sample(3, 5), sample(4, 6), sample(5, 7)],
    claim: [sample(1, 2), sample(1, 3), sample(2, 4), sample(2, 5), sample(3, 6)],
    journal: [sample(2, 4), sample(2, 5), sample(3, 6), sample(3, 7), sample(4, 8)]
  };
}

test('summarizes direct lock-wait and durable-commit timing evidence', () => {
  assert.deepEqual(summarizeContentionTimings(fixture().enqueue), {
    count: 5,
    lockWaitP50Ms: 3,
    lockWaitP95Ms: 5,
    durableCommitP50Ms: 5,
    durableCommitP95Ms: 7
  });
});

test('qualifies all mutation paths only when both p95 budgets pass', () => {
  const result = evaluateContentionQualification(fixture(), { lockWaitP95Ms: 5, durableCommitP95Ms: 8 });
  assert.equal(result.ready, true);
  assert.ok(Object.values(result.checks).every(Boolean));
});

test('fails closed when one path exceeds lock-wait budget', () => {
  const data = fixture();
  data.claim.push(sample(20, 21));
  const result = evaluateContentionQualification(data, { lockWaitP95Ms: 10, durableCommitP95Ms: 30 });
  assert.equal(result.ready, false);
  assert.equal(result.checks.claimLockWaitWithinBudget, false);
});

test('fails closed when durable commit exceeds budget despite acceptable lock wait', () => {
  const data = fixture();
  data.journal.push(sample(4, 50));
  const result = evaluateContentionQualification(data, { lockWaitP95Ms: 10, durableCommitP95Ms: 20 });
  assert.equal(result.ready, false);
  assert.equal(result.checks.journalDurableCommitWithinBudget, false);
});

test('rejects missing, malformed, or unbounded evidence', () => {
  assert.throws(() => evaluateContentionQualification({ enqueue: [], claim: [], journal: [] }, { lockWaitP95Ms: 5, durableCommitP95Ms: 10 }), /samples are required/);
  assert.throws(() => summarizeContentionTimings([sample(Number.NaN, 1)]), /finite non-negative/);
  assert.throws(() => evaluateContentionQualification(fixture(), { lockWaitP95Ms: Infinity, durableCommitP95Ms: 10 }), /budget/);
});
