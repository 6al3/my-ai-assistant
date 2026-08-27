import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildReadonlyQrexecPolicyQualification,
  verifyReadonlyQrexecPolicyQualification
} from './qrexec-readonly-policy-qualification.mjs';

const SHA = '1234567890abcdef1234567890abcdef12345678';

function fixture(overrides = {}) {
  const base = {
    gitSha: SHA,
    runtimeFingerprint: 'node-v24.7.0|qubes-4.x|x86_64',
    sourceQube: 'dig-worker-lab',
    coordinatorQube: 'dig-coordinator-lab',
    intendedService: 'dig.QubesReadonlyProbe',
    scenarios: {
      'intended-service-allowed': { outcome: 'allowed', exitCode: 0 },
      'wrong-service-denied': { outcome: 'denied', exitCode: 1 },
      'wrong-identity-denied': { outcome: 'denied', exitCode: 2 },
      'auth-failure-denied': { outcome: 'denied', exitCode: 2 },
      'malformed-framing-denied': { outcome: 'denied', exitCode: 2 }
    },
    attestationVerified: true,
    responseBounded: true,
    singleResponseFrame: true,
    mutationEvidence: {
      missionStoreBefore: 'sha256:mission-same',
      missionStoreAfter: 'sha256:mission-same',
      requestJournalBefore: 'sha256:journal-same',
      requestJournalAfter: 'sha256:journal-same'
    }
  };
  return { ...base, ...overrides };
}

test('builds and verifies a fail-closed read-only qrexec policy qualification report', () => {
  const report = buildReadonlyQrexecPolicyQualification(fixture());
  assert.equal(report.readiness, 'LAB READY');
  assert.equal(report.zeroMutationVerified, true);
  assert.equal(report.scenarios['intended-service-allowed'].outcome, 'allowed');
  assert.equal(verifyReadonlyQrexecPolicyQualification(report), true);
});

test('wrong service must be denied', () => {
  const input = fixture();
  input.scenarios['wrong-service-denied'] = { outcome: 'allowed', exitCode: 0 };
  assert.throws(() => buildReadonlyQrexecPolicyQualification(input), /wrong-service-denied must be denied/);
});

test('qualification fails when mission or request-journal state changes', () => {
  const missionMutation = fixture({
    mutationEvidence: {
      missionStoreBefore: 'sha256:before',
      missionStoreAfter: 'sha256:after',
      requestJournalBefore: 'sha256:same',
      requestJournalAfter: 'sha256:same'
    }
  });
  assert.throws(() => buildReadonlyQrexecPolicyQualification(missionMutation), /mutated MissionStore/);

  const journalMutation = fixture({
    mutationEvidence: {
      missionStoreBefore: 'sha256:same',
      missionStoreAfter: 'sha256:same',
      requestJournalBefore: 'sha256:before',
      requestJournalAfter: 'sha256:after'
    }
  });
  assert.throws(() => buildReadonlyQrexecPolicyQualification(journalMutation), /mutated DurableRequestJournal/);
});

test('attestation, byte bound, and single-frame evidence are mandatory', () => {
  assert.throws(() => buildReadonlyQrexecPolicyQualification(fixture({ attestationVerified: false })), /attestation/);
  assert.throws(() => buildReadonlyQrexecPolicyQualification(fixture({ responseBounded: false })), /byte bound/);
  assert.throws(() => buildReadonlyQrexecPolicyQualification(fixture({ singleResponseFrame: false })), /one response frame/);
});

test('tampering invalidates the evidence digest', () => {
  const report = buildReadonlyQrexecPolicyQualification(fixture());
  const tampered = { ...report, sourceQube: 'other-worker' };
  assert.throws(() => verifyReadonlyQrexecPolicyQualification(tampered), /digest mismatch/);
});
