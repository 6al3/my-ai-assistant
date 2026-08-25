import assert from 'node:assert/strict';
import test from 'node:test';
import { qualifyMissionRuntimeContention, verifyContentionEvidenceDigest } from './mission-runtime-contention-evidence.mjs';

const SHA = 'a'.repeat(40);
const budgets = {
  minimumSamplesPerPath: 8,
  lockWaitP95Ms: 100,
  ownerPublicationP95Ms: 120,
  durableCommitP95Ms: 200,
  terminalRenewalP95Ms: 180
};

function evaluation(lockWait, durableCommit) {
  const summaries = Object.fromEntries(['enqueue', 'claim', 'terminalRenewal', 'journalCommit'].map(path => [path, {
    count: 8,
    lockWaitP50Ms: lockWait / 2,
    lockWaitP95Ms: lockWait,
    ownerPublicationP50Ms: lockWait / 4,
    ownerPublicationP95Ms: lockWait / 2,
    durableCommitP50Ms: durableCommit / 2,
    durableCommitP95Ms: durableCommit
  }]));
  return {
    ready: true,
    qualifiedJournalPhase: 'commit',
    qualifiedWorkerPhase: 'terminalRenewal',
    checks: {},
    summaries,
    budgets: { ...budgets }
  };
}

function campaignFactory(values, {
  duplicateRunId = false,
  correctness = true,
  committedResponses = true,
  terminalRenewal = true
} = {}) {
  let index = 0;
  return async ({ runId }) => {
    const value = values[index++] ?? values.at(-1);
    const runEvaluation = evaluation(value, value * 2);
    if (!committedResponses) runEvaluation.qualifiedJournalPhase = 'begin';
    if (!terminalRenewal) runEvaluation.qualifiedWorkerPhase = 'claim';
    return {
      schemaVersion: 5,
      runId: duplicateRunId ? 'duplicate-run' : runId,
      counts: { enqueue: 8, claim: 8, terminalRenewal: 8, journalBegin: 8, journalCommit: 8 },
      correctness: {
        lostMissions: correctness ? 0 : 1,
        lostRequests: 0,
        uncommittedResponses: committedResponses ? 0 : 1,
        doubleClaims: 0,
        durableMissionTotal: 8,
        durableRunningTotal: 8,
        terminalPathMissionTotal: 8,
        terminalPathCompletedTotal: 8
      },
      evidence: {
        terminalRenewalCount: 8,
        terminalRenewalSource: 'worker-runtime',
        qualifiedWorkerPhase: terminalRenewal ? 'terminalRenewal' : 'claim',
        journalBeginCount: 8,
        journalCommitCount: 8,
        qualifiedJournalPhase: committedResponses ? 'commit' : 'begin'
      },
      evaluation: runEvaluation
    };
  };
}

function gitReadFactory({ dirty = false } = {}) {
  return async args => args[0] === 'rev-parse' ? SHA : (dirty ? ' M agents/file.mjs' : '');
}

function runIdFactory() {
  let index = 0;
  return () => `run-id-${String(index++).padStart(4, '0')}`;
}

const runtimeFingerprint = () => ({
  nodeVersion: 'v22.0.0',
  platform: 'linux',
  arch: 'x64',
  cpuModel: 'Synthetic CPU',
  logicalCpus: 8,
  totalMemoryMiB: 8192
});

test('contention qualification emits LAB READY evidence only when three independent terminal-renewal and committed-response runs are stable', async () => {
  const report = await qualifyMissionRuntimeContention({
    expectedSha: SHA,
    campaign: campaignFactory([10, 11, 12]),
    gitRead: gitReadFactory(),
    runtimeFingerprint,
    runIdFactory: runIdFactory(),
    now: (() => { let value = 1_000; return () => (value += 100); })()
  });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.readiness, 'LAB READY');
  assert.equal(report.stability.ready, true);
  assert.equal(report.stability.qualifiedJournalPhase, 'commit');
  assert.equal(report.stability.qualifiedWorkerPhase, 'terminalRenewal');
  assert.equal(report.correctnessReady, true);
  assert.equal(report.runCount, 3);
  assert.equal(new Set(report.runs.map(run => run.runId)).size, 3);
  assert.equal(verifyContentionEvidenceDigest(report), true);
});

test('contention qualification reports NOT READY when p95 spread exceeds 25 percent', async () => {
  const report = await qualifyMissionRuntimeContention({
    expectedSha: SHA,
    campaign: campaignFactory([10, 10, 20]),
    gitRead: gitReadFactory(),
    runtimeFingerprint,
    runIdFactory: runIdFactory()
  });
  assert.equal(report.readiness, 'NOT READY');
  assert.equal(report.stability.ready, false);
});

test('contention qualification refuses begin-only journal evidence even when timings are stable', async () => {
  await assert.rejects(() => qualifyMissionRuntimeContention({
    expectedSha: SHA,
    campaign: campaignFactory([10, 10, 10], { committedResponses: false }),
    gitRead: gitReadFactory(),
    runtimeFingerprint,
    runIdFactory: runIdFactory()
  }), /terminal journal commit/);
});

test('contention qualification refuses non-terminal worker evidence even when timings are stable', async () => {
  await assert.rejects(() => qualifyMissionRuntimeContention({
    expectedSha: SHA,
    campaign: campaignFactory([10, 10, 10], { terminalRenewal: false }),
    gitRead: gitReadFactory(),
    runtimeFingerprint,
    runIdFactory: runIdFactory()
  }), /terminal worker renewal/);
});

test('contention qualification refuses copied campaign run identities', async () => {
  await assert.rejects(() => qualifyMissionRuntimeContention({
    expectedSha: SHA,
    campaign: campaignFactory([10, 10, 10], { duplicateRunId: true }),
    gitRead: gitReadFactory(),
    runtimeFingerprint,
    runIdFactory: runIdFactory()
  }), /unique campaign run IDs/);
});

test('contention qualification fails closed for dirty worktree before running campaigns', async () => {
  let calls = 0;
  await assert.rejects(() => qualifyMissionRuntimeContention({
    expectedSha: SHA,
    campaign: async () => { calls += 1; },
    gitRead: gitReadFactory({ dirty: true }),
    runtimeFingerprint,
    runIdFactory: runIdFactory()
  }), /clean worktree/);
  assert.equal(calls, 0);
});

test('contention evidence digest detects post-qualification tampering', async () => {
  const report = await qualifyMissionRuntimeContention({
    expectedSha: SHA,
    campaign: campaignFactory([10, 11, 12]),
    gitRead: gitReadFactory(),
    runtimeFingerprint,
    runIdFactory: runIdFactory()
  });
  report.runs[0].evaluation.summaries.terminalRenewal.ownerPublicationP95Ms += 1;
  assert.equal(verifyContentionEvidenceDigest(report), false);
});
