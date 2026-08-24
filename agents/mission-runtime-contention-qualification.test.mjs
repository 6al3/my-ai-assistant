import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateContentionQualification, summarizeContentionTimings } from './mission-runtime-contention-qualification.mjs';

const sample = (lockWaitMs, durableCommitMs) => ({ lockWaitMs, durableCommitMs });
const budgets = (overrides = {}) => ({ lockWaitP95Ms: 5, durableCommitP95Ms: 8, minimumSamplesPerPath: 5, ...overrides });

function fixture() {
  return {
    enqueue: [sample(1, 3), sample(2, 4), sample(3, 5), sample(4, 6), sample(5, 7)],
    claim: [sample(1, 2), sample(1, 3), sample(2, 4), sample(2, 5), sample(3, 6)],
    journalCommit: [sample(2, 4), sample(2, 5), sample(3, 6), sample(3, 7), sample(4, 8)]
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

test('qualifies all mutation paths only when sample coverage and both p95 budgets pass', () => {
  const result = evaluateContentionQualification(fixture(), budgets());
  assert.equal(result.ready, true);
  assert.ok(Object.values(result.checks).every(Boolean));
  assert.equal(result.checks.claimSampleCoverage, true);
  assert.equal(result.checks.journalCommitSampleCoverage, true);
  assert.equal(result.qualifiedJournalPhase, 'commit');
});

test('fails closed when one path exceeds lock-wait budget', () => {
  const data = fixture();
  data.claim.push(sample(20, 21));
  const result = evaluateContentionQualification(data, budgets({ lockWaitP95Ms: 10, durableCommitP95Ms: 30 }));
  assert.equal(result.ready, false);
  assert.equal(result.checks.claimLockWaitWithinBudget, false);
});

test('fails closed when terminal journal commit exceeds budget despite acceptable lock wait', () => {
  const data = fixture();
  data.journalCommit.push(sample(4, 50));
  const result = evaluateContentionQualification(data, budgets({ lockWaitP95Ms: 10, durableCommitP95Ms: 20 }));
  assert.equal(result.ready, false);
  assert.equal(result.checks.journalCommitDurableCommitWithinBudget, false);
});

test('rejects ambiguous legacy journal evidence even when timings would otherwise pass', () => {
  const data = fixture();
  const legacy = { enqueue: data.enqueue, claim: data.claim, journal: data.journalCommit };
  assert.throws(() => evaluateContentionQualification(legacy, budgets()), /legacy journal contention evidence is ambiguous/);
});

test('rejects under-sampled p95 evidence instead of qualifying a lucky small sample', () => {
  const data = fixture();
  data.claim = data.claim.slice(0, 2);
  assert.throws(() => evaluateContentionQualification(data, budgets()), /requires at least 5 samples/);
});

test('rejects missing, malformed, or unbounded evidence and invalid coverage budgets', () => {
  assert.throws(() => evaluateContentionQualification({ enqueue: [], claim: [], journalCommit: [] }, budgets()), /samples are required/);
  assert.throws(() => summarizeContentionTimings([sample(Number.NaN, 1)]), /finite non-negative/);
  assert.throws(() => evaluateContentionQualification(fixture(), budgets({ lockWaitP95Ms: Infinity })), /budget/);
  assert.throws(() => evaluateContentionQualification(fixture(), budgets({ minimumSamplesPerPath: 1 })), /integer >= 2/);
});
