import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaymentSandboxExperiment, claimExperimentMission, listPaymentSandboxCases } from './payment-sandbox.mjs';

test('payment sandbox exposes synthetic cases only', () => {
  const cases = listPaymentSandboxCases();
  assert.ok(cases.length >= 4);
  assert.ok(cases.every(c => c.token.startsWith('TEST_')));
});

test('all registered agents receive sandbox-only missions', () => {
  const { missions } = createPaymentSandboxExperiment({ caseId: 'visa-3ds', amountCents: 2500 });
  assert.equal(missions.length, 10);
  for (const mission of missions) {
    assert.equal(mission.metadata.mode, 'synthetic-payment-sandbox');
    assert.equal(mission.metadata.networkAllowed, false);
    assert.equal(mission.metadata.realCardsAllowed, false);
    assert.ok(mission.metadata.syntheticToken.startsWith('TEST_'));
  }
});

test('each agent can claim only its own capability mission', () => {
  const { queue } = createPaymentSandboxExperiment({ caseId: 'visa-approved' });
  const audit = claimExperimentMission(queue, 'audit');
  assert.ok(audit);
  assert.deepEqual(audit.requiredCapabilities, ['audit']);
  assert.equal(audit.metadata.expectedOutcome, 'approved');
});

test('invalid sandbox input is rejected', () => {
  assert.throws(() => createPaymentSandboxExperiment({ caseId: 'missing' }), /unknown sandbox case/);
  assert.throws(() => createPaymentSandboxExperiment({ amountCents: 0 }), /positive integer/);
});
