import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateContentionQualification, summarizeContentionTimings } from './mission-runtime-contention-qualification.mjs';

const sample = (lockWaitMs, durableCommitMs, ownerPublicationMs = 1) => ({ lockWaitMs, ownerPublicationMs, durableCommitMs });
const budgets = (overrides = {}) => ({ lockWaitP95Ms: 5, ownerPublicationP95Ms: 6, durableCommitP95Ms: 8, terminalRenewalP95Ms: 7, minimumSamplesPerPath: 5, ...overrides });

function fixture() {
  return {
    enqueue: [sample(1, 3, 1), sample(2, 4, 2), sample(3, 5, 2), sample(4, 6, 3), sample(5, 7, 4)],
    claim: [sample(1, 2, 1), sample(1, 3, 1), sample(2, 4, 2), sample(2, 5, 2), sample(3, 6, 3)],
    terminalRenewal: [sample(1, 2, 1), sample(1, 3, 1), sample(2, 4, 2), sample(2, 5, 2), sample(3, 6, 3)],
    journalCommit: [sample(2, 4, 1), sample(2, 5, 2), sample(3, 6, 2), sample(3, 7, 3), sample(4, 8, 4)]
  };
}

test('summarizes direct lock-wait, owner-publication, and durable-commit timing evidence', () => {
  assert.deepEqual(summarizeContentionTimings(fixture().enqueue), {
    count: 5,
    lockWaitP50Ms: 3,
    lockWaitP95Ms: 5,
    ownerPublicationP50Ms: 2,
    ownerPublicationP95Ms: 4,
    durableCommitP50Ms: 5,
    durableCommitP95Ms: 7
  });
});

test('qualifies all mutation paths including terminal renewal only when coverage and p95 budgets pass', () => {
  const result = evaluateContentionQualification(fixture(), budgets());
  assert.equal(result.ready, true);
  assert.ok(Object.values(result.checks).every(Boolean));
  assert.equal(result.checks.terminalRenewalSampleCoverage, true);
  assert.equal(result.checks.terminalRenewalDurableCommitWithinBudget, true);
  assert.equal(result.qualifiedWorkerPhase, 'terminalRenewal');
  assert.equal(result.qualifiedJournalPhase, 'commit');
});

test('fails readiness when terminal renewal alone exceeds its dedicated budget', () => {
  const data = fixture();
  data.terminalRenewal.push(sample(2, 9, 2));
  const result = evaluateContentionQualification(data, budgets({ lockWaitP95Ms: 10, durableCommitP95Ms: 20, terminalRenewalP95Ms: 7 }));
  assert.equal(result.ready, false);
  assert.equal(result.checks.terminalRenewalLockWaitWithinBudget, true);
  assert.equal(result.checks.terminalRenewalDurableCommitWithinBudget, false);
  assert.equal(result.checks.enqueueDurableCommitWithinBudget, true);
});

test('uses durable-commit budget as migration-safe terminal-renewal ceiling when dedicated budget is omitted', () => {
  const result = evaluateContentionQualification(fixture(), {
    lockWaitP95Ms: 5,
    ownerPublicationP95Ms: 6,
    durableCommitP95Ms: 8,
    minimumSamplesPerPath: 5
  });
  assert.equal(result.ready, true);
  assert.equal(result.budgets.terminalRenewalP95Ms, 8);
});

test('fails readiness when durable owner publication exceeds its budget', () => {
  const data = fixture();
  data.enqueue.push(sample(2, 9, 8));
  const result = evaluateContentionQualification(data, budgets({ lockWaitP95Ms: 10, ownerPublicationP95Ms: 7, durableCommitP95Ms: 20 }));
  assert.equal(result.ready, false);
  assert.equal(result.checks.enqueueOwnerPublicationWithinBudget, false);
});

test('rejects ambiguous legacy journal evidence', () => {
  const data = fixture();
  const legacy = { enqueue: data.enqueue, claim: data.claim, terminalRenewal: data.terminalRenewal, journal: data.journalCommit };
  assert.throws(() => evaluateContentionQualification(legacy, budgets()), /legacy journal contention evidence is ambiguous/);
});

test('rejects missing terminal-renewal evidence instead of silently qualifying worker completion cost', () => {
  const data = fixture();
  delete data.terminalRenewal;
  assert.throws(() => evaluateContentionQualification(data, budgets()), /contention results are required/);
});

test('rejects under-sampled or malformed evidence and invalid budgets', () => {
  const data = fixture();
  data.terminalRenewal = data.terminalRenewal.slice(0, 2);
  assert.throws(() => evaluateContentionQualification(data, budgets()), /requires at least 5 samples/);
  assert.throws(() => evaluateContentionQualification(fixture(), budgets({ terminalRenewalP95Ms: Infinity })), /budget/);
  assert.throws(() => evaluateContentionQualification(fixture(), budgets({ minimumSamplesPerPath: 1 })), /integer >= 2/);
});
