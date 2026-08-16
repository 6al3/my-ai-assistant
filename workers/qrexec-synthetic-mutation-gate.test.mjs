import test from 'node:test';
import assert from 'node:assert/strict';
import { runSyntheticMutationGate } from './qrexec-synthetic-mutation-gate.mjs';

function healthy(overrides = {}) {
  return {
    syntheticOnly: true,
    duplicateMutations: 0,
    unresolvedCommittedRequests: 0,
    oldKeyAcceptance: 0,
    missionAttempts: 1,
    recoveryMs: 25,
    roundTripMs: 30,
    ...overrides
  };
}

test('passes only when synthetic mutation invariants remain exact', async () => {
  const result = await runSyntheticMutationGate({ scenario: async () => healthy(), samples: 5 });
  assert.equal(result.readiness, 'SYNTHETIC_MUTATION_GATE_PASS');
  assert.equal(result.passed, true);
  assert.equal(result.duplicateMutations, 0);
  assert.equal(result.unresolvedCommittedRequests, 0);
  assert.equal(result.oldKeyAcceptance, 0);
  assert.equal(result.checks.missionAttemptsExactlyOnce, true);
});

test('fails closed on any duplicate mutation or unresolved committed request', async () => {
  const outputs = [healthy(), healthy({ duplicateMutations: 1 }), healthy({ unresolvedCommittedRequests: 1 })];
  const result = await runSyntheticMutationGate({ scenario: async index => outputs[index], samples: 3 });
  assert.equal(result.readiness, 'SYNTHETIC_MUTATION_GATE_FAIL');
  assert.equal(result.checks.zeroDuplicateMutations, false);
  assert.equal(result.checks.zeroUnresolvedCommittedRequests, false);
});

test('fails on old-key acceptance or a repeated mission attempt', async () => {
  const outputs = [healthy(), healthy({ oldKeyAcceptance: 1 }), healthy({ missionAttempts: 2 })];
  const result = await runSyntheticMutationGate({ scenario: async index => outputs[index], samples: 3 });
  assert.equal(result.passed, false);
  assert.equal(result.checks.zeroOldKeyAcceptance, false);
  assert.equal(result.checks.missionAttemptsExactlyOnce, false);
});

test('enforces p95 recovery and transport budgets', async () => {
  const outputs = [healthy(), healthy(), healthy({ recoveryMs: 5000, roundTripMs: 5000 })];
  const result = await runSyntheticMutationGate({
    scenario: async index => outputs[index],
    samples: 3,
    maxP95RecoveryMs: 1000,
    maxP95RoundTripMs: 1000
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.recoveryLatencyWithinBudget, false);
  assert.equal(result.checks.roundTripLatencyWithinBudget, false);
});

test('rejects non-synthetic scenarios', async () => {
  await assert.rejects(
    () => runSyntheticMutationGate({ scenario: async () => healthy({ syntheticOnly: false }), samples: 3 }),
    /syntheticOnly=true/
  );
});
