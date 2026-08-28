import assert from 'node:assert/strict';
import test from 'node:test';
import {
  generateReadonlyEvidenceChallenge,
  runReadonlyEvidenceChallengeQualification
} from './qrexec-readonly-evidence-challenge-driver.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const SERVICE = 'dig.ReadonlyProbe';
const TARGET = '/opt/dig/current/agents/qrexec-readonly-service-process.mjs';

const expected = {
  expectedService: SERVICE,
  expectedSourceQube: 'AI',
  expectedCoordinatorQube: 'DIG-Coordinator',
  expectedServiceUser: 'dig-readonly',
  expectedServiceUid: 1001,
  expectedGitSha: SHA,
  expectedServiceTarget: TARGET
};

function dom0Export(challenge) {
  return JSON.stringify({
    schemaVersion: 2,
    domain: 'dom0-policy',
    evidenceChallenge: challenge,
    evidence: {
      path: '/etc/qubes/policy.d/30-dig-readonly.policy',
      text: `${SERVICE} + AI DIG-Coordinator allow user=dig-readonly\n${SERVICE} * * * deny\n`
    }
  });
}

function coordinatorExport(challenge) {
  return JSON.stringify({
    schemaVersion: 2,
    domain: 'coordinator-service',
    evidenceChallenge: challenge,
    evidence: {
      serviceUser: 'dig-readonly',
      serviceUid: 1001,
      effectiveUid: 1001,
      effectiveGid: 1001,
      serviceHandler: {
        path: `/usr/local/etc/qubes-rpc/${SERVICE}`,
        target: TARGET,
        executable: true,
        writableByServiceUser: false,
        targetGitSha: SHA
      }
    }
  });
}

test('generates a bounded base64url challenge from exactly 24 random bytes', () => {
  const challenge = generateReadonlyEvidenceChallenge({ randomBytesFn: () => Buffer.alloc(24, 0xab) });
  assert.match(challenge, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(challenge, Buffer.alloc(24, 0xab).toString('base64url'));
});

test('supplies the same one-run challenge exactly once to both trust-domain collectors', async () => {
  const calls = [];
  const result = await runReadonlyEvidenceChallengeQualification({
    expected,
    randomBytesFn: () => Buffer.alloc(24, 0x11),
    collectDom0Export: async ({ evidenceChallenge }) => {
      calls.push(['dom0', evidenceChallenge]);
      return dom0Export(evidenceChallenge);
    },
    collectCoordinatorExport: async ({ evidenceChallenge }) => {
      calls.push(['coordinator', evidenceChallenge]);
      return coordinatorExport(evidenceChallenge);
    }
  });

  assert.equal(calls.length, 2);
  assert.equal(calls.filter(([domain]) => domain === 'dom0').length, 1);
  assert.equal(calls.filter(([domain]) => domain === 'coordinator').length, 1);
  assert.equal(calls[0][1], calls[1][1]);
  assert.equal(result.evidenceChallenge, calls[0][1]);
  assert.equal(result.artifact.gitSha, SHA);
});

test('rejects stale or cross-run exporter output through the authoritative importer', async () => {
  const stale = Buffer.alloc(24, 0x22).toString('base64url');
  await assert.rejects(
    () => runReadonlyEvidenceChallengeQualification({
      expected,
      randomBytesFn: () => Buffer.alloc(24, 0x33),
      collectDom0Export: async () => dom0Export(stale),
      collectCoordinatorExport: async ({ evidenceChallenge }) => coordinatorExport(evidenceChallenge)
    }),
    /challenge mismatch/
  );
});

test('fails closed on invalid entropy source or collector failure without retrying either collector', async () => {
  assert.throws(
    () => generateReadonlyEvidenceChallenge({ randomBytesFn: () => Buffer.alloc(8) }),
    /exactly 24 bytes/
  );

  let dom0Calls = 0;
  let coordinatorCalls = 0;
  await assert.rejects(
    () => runReadonlyEvidenceChallengeQualification({
      expected,
      randomBytesFn: () => Buffer.alloc(24, 0x44),
      collectDom0Export: async () => {
        dom0Calls += 1;
        throw new Error('dom0 unavailable');
      },
      collectCoordinatorExport: async ({ evidenceChallenge }) => {
        coordinatorCalls += 1;
        return coordinatorExport(evidenceChallenge);
      }
    }),
    /dom0 unavailable/
  );
  assert.equal(dom0Calls, 1);
  assert.equal(coordinatorCalls, 1);
});
