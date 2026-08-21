import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildQualificationRunPlan, evaluateQualificationCampaignSet, materializeQualificationManifest, runQualificationCampaignSet, validateCalibrationSelectionBinding } from './qubes-qrexec-qualification-runner.mjs';

const REQUIRED_ENV = {
  DIG_QREXEC_TARGET: 'coordinator', DIG_QREXEC_SOURCE: 'worker', DIG_QREXEC_SERVICE: 'dig.Coordinator', DIG_QREXEC_FAULT_SERVICE: 'dig.CoordinatorFault',
  DIG_GIT_SHA: 'a'.repeat(40), DIG_TRANSPORT_SECRET: 'qualification-test-secret-000000000000', DIG_RESPONSE_ATTESTATION_KEY_ID: 'dig-coordinator-key-1', DIG_RESPONSE_ATTESTATION_PUBLIC_KEY: 'test-public-key'
};
const CALIBRATION = { topologyId: 'two-worker-fused', calibrationEvidenceDigest: 'b'.repeat(64) };
const verified = service => ({ service, keyId: REQUIRED_ENV.DIG_RESPONSE_ATTESTATION_KEY_ID, gitSha: REQUIRED_ENV.DIG_GIT_SHA });
const campaignStart = (runId, extra = {}) => ({ type: 'campaign_start', runId, transport: 'qrexec', sourceQube: 'worker', targetQube: 'coordinator', service: 'dig.Coordinator', gitSha: REQUIRED_ENV.DIG_GIT_SHA, topologyId: CALIBRATION.topologyId, calibrationEvidenceDigest: CALIBRATION.calibrationEvidenceDigest, startedAt: '2026-08-18T10:00:00.000Z', ...extra });

test('qualification binds to exact calibrated topology selection evidence', () => {
  const selection = { schemaVersion: 2, gitSha: REQUIRED_ENV.DIG_GIT_SHA, calibrationEvidenceDigest: CALIBRATION.calibrationEvidenceDigest, winner: { id: CALIBRATION.topologyId } };
  assert.deepEqual(validateCalibrationSelectionBinding(selection, { expectedGitSha: REQUIRED_ENV.DIG_GIT_SHA, expectedTopologyId: CALIBRATION.topologyId }), {
    gitSha: REQUIRED_ENV.DIG_GIT_SHA, topologyId: CALIBRATION.topologyId, calibrationEvidenceDigest: CALIBRATION.calibrationEvidenceDigest
  });
  assert.throws(() => validateCalibrationSelectionBinding({ ...selection, gitSha: 'c'.repeat(40) }, { expectedGitSha: REQUIRED_ENV.DIG_GIT_SHA, expectedTopologyId: CALIBRATION.topologyId }), /git SHA mismatch/);
  assert.throws(() => validateCalibrationSelectionBinding(selection, { expectedGitSha: REQUIRED_ENV.DIG_GIT_SHA, expectedTopologyId: 'four-worker-isolated' }), /topology mismatch/);
  assert.throws(() => validateCalibrationSelectionBinding({ ...selection, calibrationEvidenceDigest: 'not-a-digest' }, { expectedGitSha: REQUIRED_ENV.DIG_GIT_SHA, expectedTopologyId: CALIBRATION.topologyId }), /SHA-256/);
  assert.throws(() => validateCalibrationSelectionBinding({ ...selection, schemaVersion: 1 }, { expectedGitSha: REQUIRED_ENV.DIG_GIT_SHA, expectedTopologyId: CALIBRATION.topologyId }), /schemaVersion must be 2/);
});

test('qualification plan uses one lease/QA run plus at least three independent recovery runs', () => {
  const plan = buildQualificationRunPlan({ qualificationRunId: 'qual-1', recoveryRuns: 3 });
  assert.equal(plan.length, 4); assert.deepEqual(plan.map(item => item.kind), ['lease-qa', 'recovery', 'recovery', 'recovery']);
  assert.equal(new Set(plan.map(item => item.runId)).size, 4); assert.ok(plan.every(item => item.runId.startsWith('qual-1-')));
  assert.throws(() => buildQualificationRunPlan({ qualificationRunId: 'qual-2', recoveryRuns: 2 }), /between 3 and 10/);
  assert.throws(() => buildQualificationRunPlan({ qualificationRunId: 'bad id', recoveryRuns: 3 }), /qualificationRunId/);
});

test('qualification manifest binds recovery services to the same deployment probed by preflight', () => {
  const manifest = materializeQualificationManifest(JSON.stringify({ steps: [{ faultService: '{{FAULT_SERVICE}}', recoveryService: '{{NORMAL_SERVICE}}' }] }), { env: { ...REQUIRED_ENV, DIG_QREXEC_SERVICE: 'dig.CustomCoordinator', DIG_QREXEC_FAULT_SERVICE: 'dig.CustomFault' } });
  assert.deepEqual(JSON.parse(manifest), { steps: [{ faultService: 'dig.CustomFault', recoveryService: 'dig.CustomCoordinator' }] });
  assert.throws(() => materializeQualificationManifest('{bad', { env: REQUIRED_ENV }), /must be valid JSON/);
});

test('qualification runner binds every raw campaign to the calibrated topology and digest', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-qualification-runner-')); const fakeHarness = path.join(dir, 'fake-harness.mjs');
  try {
    await writeFile(fakeHarness, `
      let input = ''; for await (const chunk of process.stdin) input += chunk; const manifest = JSON.parse(input);
      for (const step of manifest.steps ?? []) { if (step.faultService) { if (step.faultService !== 'dig.CoordinatorFault') throw new Error('unexpected fault service'); if (step.recoveryService !== 'dig.Coordinator') throw new Error('unexpected normal service'); } }
      const runId = process.env.DIG_CAMPAIGN_RUN_ID; const base = { runId, transport: 'qrexec', sourceQube: 'worker', targetQube: 'coordinator', service: 'dig.Coordinator', gitSha: '${'a'.repeat(40)}' };
      console.log(JSON.stringify({ type: 'campaign_start', ...base, startedAt: '2026-08-18T10:00:00.000Z' })); console.log(JSON.stringify({ type: 'campaign_end', runId, finishedAt: '2026-08-18T10:00:01.000Z' }));
    `);
    const campaigns = await runQualificationCampaignSet({ qualificationRunId: 'qual-live', recoveryRuns: 3, harnessPath: fakeHarness, env: { ...process.env, ...REQUIRED_ENV }, calibrationBinding: CALIBRATION });
    assert.equal(campaigns.length, 4);
    const starts = campaigns.map(jsonl => JSON.parse(jsonl.split('\n')[0]));
    assert.deepEqual(starts.map(item => item.runId), ['qual-live-lease', 'qual-live-recovery-1', 'qual-live-recovery-2', 'qual-live-recovery-3']);
    assert.equal(new Set(starts.map(item => item.runId)).size, 4);
    assert.ok(starts.every(item => item.topologyId === CALIBRATION.topologyId));
    assert.ok(starts.every(item => item.calibrationEvidenceDigest === CALIBRATION.calibrationEvidenceDigest));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('qualification runner rejects missing or malformed calibration binding before campaign execution', async () => {
  await assert.rejects(() => runQualificationCampaignSet({ qualificationRunId: 'qual-missing', recoveryRuns: 3, env: REQUIRED_ENV }), /calibrationBinding.topologyId/);
  await assert.rejects(() => runQualificationCampaignSet({ qualificationRunId: 'qual-bad', recoveryRuns: 3, env: REQUIRED_ENV, calibrationBinding: { ...CALIBRATION, calibrationEvidenceDigest: 'bad' } }), /SHA-256/);
});

test('qualification evaluation fails closed when campaign or preflight cryptographic attestation evidence is missing', () => {
  const campaigns = Array.from({ length: 4 }, (_, index) => {
    const runId = `qual-eval-${index}`;
    return [JSON.stringify(campaignStart(runId)), JSON.stringify({ type: 'campaign_end', runId, finishedAt: '2026-08-18T10:00:01.000Z' })].join('\n');
  });
  const qualification = evaluateQualificationCampaignSet(campaigns, { env: REQUIRED_ENV, calibrationBinding: CALIBRATION, nowMs: Date.parse('2026-08-18T10:00:02.000Z') });
  assert.equal(qualification.ready, false); assert.equal(qualification.classification, 'LAB READY');
  assert.equal(qualification.checks.calibrationExecutionProvenanceBound, true);
  assert.ok(qualification.failedChecks.includes('verifiedAttestationEvidencePresent'));
  assert.ok(qualification.failedChecks.includes('verifiedNormalServiceCampaignAttestationObserved'));
  assert.ok(qualification.failedChecks.includes('verifiedFaultServicePreflightAttestationObserved'));
});

test('qualification evaluation rejects wrong or mixed calibration execution provenance', () => {
  const good = [JSON.stringify(campaignStart('good')), JSON.stringify({ type: 'campaign_end', runId: 'good', finishedAt: '2026-08-18T10:00:01.000Z' })].join('\n');
  const wrongTopology = [JSON.stringify(campaignStart('wrong-topology', { topologyId: 'four-worker-isolated' })), JSON.stringify({ type: 'campaign_end', runId: 'wrong-topology', finishedAt: '2026-08-18T10:00:01.000Z' })].join('\n');
  const wrongDigest = [JSON.stringify(campaignStart('wrong-digest', { calibrationEvidenceDigest: 'c'.repeat(64) })), JSON.stringify({ type: 'campaign_end', runId: 'wrong-digest', finishedAt: '2026-08-18T10:00:01.000Z' })].join('\n');
  assert.throws(() => evaluateQualificationCampaignSet([good, wrongTopology], { env: REQUIRED_ENV, calibrationBinding: CALIBRATION }), /topologyId does not match/);
  assert.throws(() => evaluateQualificationCampaignSet([good, wrongDigest], { env: REQUIRED_ENV, calibrationBinding: CALIBRATION }), /digest does not match/);
});

test('qualification evaluation requires explicit deployment, attestation, and calibration binding', () => {
  assert.throws(() => evaluateQualificationCampaignSet([], { env: {}, calibrationBinding: CALIBRATION }), /expectedGitSha is required/);
  const env = { ...REQUIRED_ENV }; delete env.DIG_RESPONSE_ATTESTATION_KEY_ID;
  assert.throws(() => evaluateQualificationCampaignSet([], { env, calibrationBinding: CALIBRATION }), /expectedAttestationKeyId is required/);
  assert.throws(() => evaluateQualificationCampaignSet([], { env: REQUIRED_ENV }), /campaigns must be a non-empty array|expected.topologyId/);
});
