import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildQualificationRunPlan, evaluateQualificationCampaignSet, materializeQualificationManifest, runQualificationCampaignSet } from './qubes-qrexec-qualification-runner.mjs';

const REQUIRED_ENV = {
  DIG_QREXEC_TARGET: 'coordinator', DIG_QREXEC_SOURCE: 'worker', DIG_QREXEC_SERVICE: 'dig.Coordinator', DIG_QREXEC_FAULT_SERVICE: 'dig.CoordinatorFault',
  DIG_GIT_SHA: 'a'.repeat(40), DIG_TRANSPORT_SECRET: 'qualification-test-secret-000000000000', DIG_RESPONSE_ATTESTATION_KEY_ID: 'dig-coordinator-key-1'
};

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

test('qualification runner executes every planned campaign with a distinct run-scoped id', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-qualification-runner-')); const fakeHarness = path.join(dir, 'fake-harness.mjs');
  try {
    await writeFile(fakeHarness, `
      let input = ''; for await (const chunk of process.stdin) input += chunk; const manifest = JSON.parse(input);
      for (const step of manifest.steps ?? []) { if (step.faultService) { if (step.faultService !== 'dig.CoordinatorFault') throw new Error('unexpected fault service'); if (step.recoveryService !== 'dig.Coordinator') throw new Error('unexpected normal service'); } }
      const runId = process.env.DIG_CAMPAIGN_RUN_ID; const base = { runId, transport: 'qrexec', sourceQube: 'worker', targetQube: 'coordinator', service: 'dig.Coordinator', gitSha: '${'a'.repeat(40)}' };
      console.log(JSON.stringify({ type: 'campaign_start', ...base, startedAt: '2026-08-18T10:00:00.000Z' })); console.log(JSON.stringify({ type: 'campaign_end', runId, finishedAt: '2026-08-18T10:00:01.000Z' }));
    `);
    const campaigns = await runQualificationCampaignSet({ qualificationRunId: 'qual-live', recoveryRuns: 3, harnessPath: fakeHarness, env: { ...process.env, ...REQUIRED_ENV } });
    assert.equal(campaigns.length, 4); const runIds = campaigns.map(jsonl => JSON.parse(jsonl.split('\n')[0]).runId);
    assert.deepEqual(runIds, ['qual-live-lease', 'qual-live-recovery-1', 'qual-live-recovery-2', 'qual-live-recovery-3']); assert.equal(new Set(runIds).size, 4);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('qualification evaluation fails closed when cryptographic attestation evidence is missing', () => {
  const campaigns = Array.from({ length: 4 }, (_, index) => {
    const runId = `qual-eval-${index}`;
    return [JSON.stringify({ type: 'campaign_start', runId, transport: 'qrexec', sourceQube: 'worker', targetQube: 'coordinator', service: 'dig.Coordinator', gitSha: 'a'.repeat(40), startedAt: '2026-08-18T10:00:00.000Z' }), JSON.stringify({ type: 'campaign_end', runId, finishedAt: '2026-08-18T10:00:01.000Z' })].join('\n');
  });
  const qualification = evaluateQualificationCampaignSet(campaigns, { env: REQUIRED_ENV, nowMs: Date.parse('2026-08-18T10:00:02.000Z') });
  assert.equal(qualification.ready, false); assert.equal(qualification.classification, 'LAB READY');
  assert.ok(qualification.failedChecks.includes('verifiedAttestationEvidencePresent'));
  assert.ok(qualification.failedChecks.includes('verifiedNormalServiceAttestationObserved'));
  assert.ok(qualification.failedChecks.includes('verifiedFaultServiceAttestationObserved'));
});

test('qualification evaluation requires explicit deployment and attestation binding', () => {
  assert.throws(() => evaluateQualificationCampaignSet([], { env: {} }), /expectedGitSha is required/);
  const env = { ...REQUIRED_ENV }; delete env.DIG_RESPONSE_ATTESTATION_KEY_ID;
  assert.throws(() => evaluateQualificationCampaignSet([], { env }), /expectedAttestationKeyId is required/);
});
