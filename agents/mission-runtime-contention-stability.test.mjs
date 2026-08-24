import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateContentionStability } from './mission-runtime-contention-stability.mjs';

const budgets = {
  minimumSamplesPerPath: 8,
  lockWaitP95Ms: 100,
  durableCommitP95Ms: 200
};

function evaluation({
  enqueueLock = 20,
  enqueueCommit = 70,
  claimLock = 18,
  claimCommit = 65,
  journalLock = 22,
  journalCommit = 75,
  ready = true,
  journalPhase = 'commit',
  budgetOverrides = {}
} = {}) {
  return {
    ready,
    qualifiedJournalPhase: journalPhase,
    budgets: { ...budgets, ...budgetOverrides },
    summaries: {
      enqueue: { lockWaitP95Ms: enqueueLock, durableCommitP95Ms: enqueueCommit },
      claim: { lockWaitP95Ms: claimLock, durableCommitP95Ms: claimCommit },
      journalCommit: { lockWaitP95Ms: journalLock, durableCommitP95Ms: journalCommit }
    }
  };
}

test('contention stability accepts repeated ready runs with bounded terminal-commit p95 drift', () => {
  const result = evaluateContentionStability([
    evaluation(),
    evaluation({ enqueueLock: 21, claimCommit: 66, journalCommit: 76 }),
    evaluation({ enqueueCommit: 72, claimLock: 19, journalLock: 23 })
  ]);

  assert.equal(result.ready, true);
  assert.equal(result.runCount, 3);
  assert.equal(result.qualifiedJournalPhase, 'commit');
  assert.ok(result.spreads.enqueue.lockWaitP95Ms < 0.25);
  assert.ok(result.spreads.journalCommit.durableCommitP95Ms < 0.25);
  assert.ok(Object.values(result.checks).every(Boolean));
});

test('contention stability rejects a noisy p95 even when every run is individually within budget', () => {
  const result = evaluateContentionStability([
    evaluation({ claimLock: 10 }),
    evaluation({ claimLock: 11 }),
    evaluation({ claimLock: 40 })
  ]);

  assert.equal(result.ready, false);
  assert.equal(result.checks.claimLockWaitP95MsStable, false);
});

test('contention stability rejects incomplete, not-ready, budget-mismatched, or begin-only evidence', () => {
  assert.throws(() => evaluateContentionStability([evaluation(), evaluation()]), /at least 3/);
  assert.throws(() => evaluateContentionStability([
    evaluation(),
    evaluation({ ready: false }),
    evaluation()
  ]), /not contention-ready/);
  assert.throws(() => evaluateContentionStability([
    evaluation(),
    evaluation({ budgetOverrides: { lockWaitP95Ms: 101 } }),
    evaluation()
  ]), /identical budgets/);
  assert.throws(() => evaluateContentionStability([
    evaluation(),
    evaluation({ journalPhase: 'begin' }),
    evaluation()
  ]), /terminal journal commit/);
});

test('contention stability fails closed on malformed timing evidence and invalid policy', () => {
  const malformed = evaluation();
  malformed.summaries.journalCommit.lockWaitP95Ms = Number.NaN;
  assert.throws(() => evaluateContentionStability([evaluation(), evaluation(), malformed]), /invalid journalCommit.lockWaitP95Ms/);
  assert.throws(() => evaluateContentionStability([evaluation(), evaluation(), evaluation()], { minimumRuns: 1 }), /minimumRuns/);
  assert.throws(() => evaluateContentionStability([evaluation(), evaluation(), evaluation()], { maxRelativeP95Spread: 1.1 }), /maxRelativeP95Spread/);
});
