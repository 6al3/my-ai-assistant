import assert from 'node:assert/strict';
import test from 'node:test';
import { runExecutionDerivedQrexecTransportQualification } from './qrexec-transport-execution-qualification.mjs';
import { QREXEC_TRANSPORT_REQUIRED_SCENARIOS, verifyQrexecTransportQualification } from './qrexec-transport-qualification.mjs';

const SHA = 'e'.repeat(40);

test('spawned qrexec crash execution directly produces a verified LAB READY qualification report', async () => {
  const report = await runExecutionDerivedQrexecTransportQualification({ gitSha: SHA });
  assert.equal(report.readiness, 'LAB READY');
  assert.equal(report.gitSha, SHA);
  assert.equal(report.metrics.duplicateMutations, 0);
  assert.equal(report.metrics.responseAttestationsVerified, true);
  assert.deepEqual(Object.keys(report.scenarios), QREXEC_TRANSPORT_REQUIRED_SCENARIOS);
  for (const name of QREXEC_TRANSPORT_REQUIRED_SCENARIOS) {
    assert.equal(report.checks[name], true, name);
    assert.equal(report.scenarios[name].attestationVerified, true, name);
    assert.equal(report.scenarios[name].duplicateMutations, 0, name);
  }
  assert.equal(report.scenarios.beforeMutation.durableEffectCount, 0);
  assert.equal(report.scenarios.beforeMutation.journalStatus, 'missing');
  assert.equal(report.scenarios.afterClaimMutation.outcome, 'REQUEST_OUTCOME_INDETERMINATE');
  assert.equal(report.scenarios.afterHeartbeatMutation.outcome, 'REQUEST_OUTCOME_INDETERMINATE');
  assert.equal(report.scenarios.afterFailMutation.outcome, 'REQUEST_OUTCOME_INDETERMINATE');
  assert.equal(report.scenarios.afterCompleteMutation.outcome, 'RECONCILED_COMPLETE');
  assert.equal(report.scenarios.afterJournalCommit.outcome, 'REPLAY_COMMITTED');
  assert.doesNotThrow(() => verifyQrexecTransportQualification(report, { expectedGitSha: SHA }));
});

test('execution-derived qualification remains digest protected', async () => {
  const report = await runExecutionDerivedQrexecTransportQualification({ gitSha: SHA });
  const tampered = structuredClone(report);
  tampered.scenarios.afterClaimMutation.duplicateMutations = 1;
  assert.throws(() => verifyQrexecTransportQualification(tampered, { expectedGitSha: SHA }), /digest/i);
});
