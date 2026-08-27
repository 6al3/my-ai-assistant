import assert from 'node:assert/strict';
import test from 'node:test';
import { collectReadonlyQrexecPolicyQualification } from './qrexec-readonly-policy-collector.mjs';

const BASE = { gitSha: 'a'.repeat(40), runtimeFingerprint: 'node:test/qubes:synthetic', sourceQube: 'worker-test', coordinatorQube: 'coordinator-test', intendedService: 'dig.ReadonlyProbe', maxResponseBytes: 1024 };
function harness(overrides = {}) {
  let snapshots = 0;
  return {
    ...BASE,
    invokeScenario: async (name) => name === 'intended-service-allowed' ? { exitCode: 0, response: { requestId: 'req-1', signature: 'synthetic' }, responseBytes: 128, responseFrames: 1 } : { exitCode: 2, response: null, responseBytes: 0, responseFrames: 0 },
    snapshotMutationState: async () => { snapshots += 1; return { missionStoreDigest: 'mission:unchanged', requestJournalDigest: 'journal:unchanged' }; },
    verifyAllowedResponse: async () => true,
    ...overrides,
    snapshotCount: () => snapshots
  };
}

test('collector derives LAB READY only from per-scenario zero-mutation observations', async () => {
  const input = harness();
  const report = await collectReadonlyQrexecPolicyQualification(input);
  assert.equal(input.snapshotCount(), 12);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.readiness, 'LAB READY');
  assert.equal(report.zeroMutationVerified, true);
  assert.equal(Object.keys(report.scenarioMutationEvidence).length, 5);
  assert.match(report.evidenceDigest, /^[0-9a-f]{64}$/);
});

test('collector fails closed if any denied scenario is unexpectedly allowed', async () => {
  const input = harness({ invokeScenario: async (name) => name === 'wrong-service-denied' ? { exitCode: 0, response: null, responseBytes: 0, responseFrames: 0 } : name === 'intended-service-allowed' ? { exitCode: 0, response: { ok: true }, responseBytes: 32, responseFrames: 1 } : { exitCode: 2, response: null, responseBytes: 0, responseFrames: 0 } });
  await assert.rejects(() => collectReadonlyQrexecPolicyQualification(input), /wrong-service-denied must fail non-zero/);
});

test('collector catches scenario-local mutation even when campaign begins and ends unchanged', async () => {
  let snapshots = 0;
  const sequence = [
    'base',
    'base','base',
    'base','temporary',
    'base','base',
    'base','base',
    'base','base',
    'base'
  ];
  const input = harness({ snapshotMutationState: async () => ({ missionStoreDigest: `mission:${sequence[snapshots++]}`, requestJournalDigest: 'journal:base' }) });
  await assert.rejects(() => collectReadonlyQrexecPolicyQualification(input), /scenarioMutationEvidence\.wrong-service-denied mutated MissionStore/);
});

test('collector requires verified, bounded, single-frame allowed response', async () => {
  await assert.rejects(() => collectReadonlyQrexecPolicyQualification(harness({ verifyAllowedResponse: async () => false })), /attestation verification failed/);
  await assert.rejects(() => collectReadonlyQrexecPolicyQualification(harness({ invokeScenario: async (name) => name === 'intended-service-allowed' ? { exitCode: 0, response: { ok: true }, responseBytes: 2048, responseFrames: 1 } : { exitCode: 2, response: null, responseBytes: 0, responseFrames: 0 } })), /exceeds configured byte bound/);
  await assert.rejects(() => collectReadonlyQrexecPolicyQualification(harness({ invokeScenario: async (name) => name === 'intended-service-allowed' ? { exitCode: 0, response: { ok: true }, responseBytes: 64, responseFrames: 2 } : { exitCode: 2, response: null, responseBytes: 0, responseFrames: 0 } })), /exactly one response frame/);
});
