import test from 'node:test';
import assert from 'node:assert/strict';
import { runQrexecReadinessGate } from './qrexec-readiness-gate.mjs';

function ready(overrides = {}) {
  return {
    readiness: 'transport-auth-ready',
    unresolved: 0,
    probeRoundTripMs: 10,
    recoveryMs: 5,
    mutationPerformed: false,
    ...overrides
  };
}

test('readiness gate passes repeated read-only healthy probes', async () => {
  const result = await runQrexecReadinessGate({
    samples: 5,
    probe: async index => ready({ probeRoundTripMs: 10 + index, recoveryMs: 2 + index })
  });
  assert.equal(result.passed, true);
  assert.equal(result.readiness, 'READ_ONLY_GATE_PASS');
  assert.equal(result.unresolvedTotal, 0);
  assert.equal(result.mutationPerformed, false);
});

test('readiness gate fails when any pending recovery is unresolved', async () => {
  const result = await runQrexecReadinessGate({
    samples: 3,
    probe: async index => index === 1 ? ready({ readiness: 'recovery-pending', unresolved: 1 }) : ready()
  });
  assert.equal(result.passed, false);
  assert.equal(result.checks.zeroUnresolved, false);
  assert.equal(result.checks.allTransportAuthReady, false);
});

test('readiness gate enforces p95 latency budgets', async () => {
  const values = [10, 11, 12, 13, 500];
  const result = await runQrexecReadinessGate({
    samples: values.length,
    maxP95ProbeRoundTripMs: 100,
    probe: async index => ready({ probeRoundTripMs: values[index] })
  });
  assert.equal(result.passed, false);
  assert.equal(result.p95ProbeRoundTripMs, 500);
  assert.equal(result.checks.probeLatencyWithinBudget, false);
});

test('readiness gate rejects any probe that reports a mutation', async () => {
  await assert.rejects(
    () => runQrexecReadinessGate({ samples: 3, probe: async () => ready({ mutationPerformed: true }) }),
    /requires mutationPerformed=false/
  );
});
