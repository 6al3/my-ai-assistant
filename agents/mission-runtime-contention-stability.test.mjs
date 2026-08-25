import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateContentionStability } from './mission-runtime-contention-stability.mjs';

const budgets = {
  minimumSamplesPerPath: 8,
  lockWaitP95Ms: 100,
  ownerPublicationP95Ms: 50,
  durableCommitP95Ms: 200,
  terminalRenewalP95Ms: 180
};

function evaluation({
  enqueueLock = 20,
  enqueuePublication = 8,
  enqueueCommit = 70,
  claimLock = 18,
  claimPublication = 7,
  claimCommit = 65,
  renewalLock = 19,
  renewalPublication = 8,
  renewalCommit = 68,
  journalLock = 22,
  journalPublication = 9,
  journalCommit = 75,
  ready = true,
  journalPhase = 'commit',
  workerPhase = 'terminalRenewal',
  budgetOverrides = {}
} = {}) {
  return {
    ready,
    qualifiedJournalPhase: journalPhase,
    qualifiedWorkerPhase: workerPhase,
    budgets: { ...budgets, ...budgetOverrides },
    summaries: {
      enqueue: { lockWaitP95Ms: enqueueLock, ownerPublicationP95Ms: enqueuePublication, durableCommitP95Ms: enqueueCommit },
      claim: { lockWaitP95Ms: claimLock, ownerPublicationP95Ms: claimPublication, durableCommitP95Ms: claimCommit },
      terminalRenewal: { lockWaitP95Ms: renewalLock, ownerPublicationP95Ms: renewalPublication, durableCommitP95Ms: renewalCommit },
      journalCommit: { lockWaitP95Ms: journalLock, ownerPublicationP95Ms: journalPublication, durableCommitP95Ms: journalCommit }
    }
  };
}

test('contention stability accepts repeated ready runs with bounded terminal-renewal and commit p95 drift', () => {
  const result = evaluateContentionStability([
    evaluation(),
    evaluation({ enqueueLock: 21, enqueuePublication: 9, claimCommit: 66, renewalCommit: 69, journalCommit: 76 }),
    evaluation({ enqueueCommit: 72, claimLock: 19, claimPublication: 8, renewalLock: 20, journalLock: 23 })
  ]);

  assert.equal(result.ready, true);
  assert.equal(result.runCount, 3);
  assert.equal(result.qualifiedJournalPhase, 'commit');
  assert.equal(result.qualifiedWorkerPhase, 'terminalRenewal');
  assert.ok(result.spreads.terminalRenewal.durableCommitP95Ms < 0.25);
  assert.ok(Object.values(result.checks).every(Boolean));
});

test('contention stability rejects noisy terminal-renewal p95 even when every run is individually ready', () => {
  const result = evaluateContentionStability([
    evaluation({ renewalCommit: 40 }),
    evaluation({ renewalCommit: 42 }),
    evaluation({ renewalCommit: 100 })
  ]);

  assert.equal(result.ready, false);
  assert.equal(result.checks.terminalRenewalDurableCommitP95MsStable, false);
});

test('contention stability treats terminal-renewal budget changes as incompatible evidence', () => {
  assert.throws(() => evaluateContentionStability([
    evaluation(),
    evaluation({ budgetOverrides: { terminalRenewalP95Ms: 181 } }),
    evaluation()
  ]), /identical budgets/);
});

test('contention stability rejects incomplete, not-ready, budget-mismatched, or wrong-phase evidence', () => {
  assert.throws(() => evaluateContentionStability([evaluation(), evaluation()]), /at least 3/);
  assert.throws(() => evaluateContentionStability([
    evaluation(), evaluation({ ready: false }), evaluation()
  ]), /not contention-ready/);
  assert.throws(() => evaluateContentionStability([
    evaluation(), evaluation({ budgetOverrides: { lockWaitP95Ms: 101 } }), evaluation()
  ]), /identical budgets/);
  assert.throws(() => evaluateContentionStability([
    evaluation(), evaluation({ journalPhase: 'begin' }), evaluation()
  ]), /terminal journal commit/);
  assert.throws(() => evaluateContentionStability([
    evaluation(), evaluation({ workerPhase: 'claim' }), evaluation()
  ]), /terminal worker renewal/);
});

test('contention stability fails closed on missing or malformed terminal-renewal evidence', () => {
  const missing = evaluation();
  delete missing.summaries.terminalRenewal;
  assert.throws(() => evaluateContentionStability([evaluation(), evaluation(), missing]), /missing terminalRenewal summary/);

  const malformed = evaluation();
  malformed.summaries.terminalRenewal.ownerPublicationP95Ms = Number.NaN;
  assert.throws(() => evaluateContentionStability([evaluation(), evaluation(), malformed]), /invalid terminalRenewal.ownerPublicationP95Ms/);
});
