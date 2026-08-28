import assert from 'node:assert/strict';
import test from 'node:test';
import { importReadonlyQrexecDeploymentEvidence } from './qrexec-readonly-evidence-import.mjs';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const SERVICE = 'dig.ReadonlyProbe';
const TARGET = '/opt/dig/current/agents/qrexec-readonly-service-process.mjs';
const CHALLENGE = 'phase1_0123456789abcdefABCDEF';

const expected = {
  expectedService: SERVICE,
  expectedSourceQube: 'AI',
  expectedCoordinatorQube: 'DIG-Coordinator',
  expectedServiceUser: 'dig-readonly',
  expectedServiceUid: 1001,
  expectedGitSha: SHA,
  expectedServiceTarget: TARGET,
  evidenceChallenge: CHALLENGE
};

function validExports(challenge = CHALLENGE) {
  return [
    JSON.stringify({
      schemaVersion: 2,
      domain: 'dom0-policy',
      evidenceChallenge: challenge,
      evidence: {
        path: '/etc/qubes/policy.d/30-dig-readonly.policy',
        text: `${SERVICE} + AI DIG-Coordinator allow user=dig-readonly\n${SERVICE} * * * deny\n`
      }
    }),
    JSON.stringify({
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
    })
  ];
}

test('joins exactly one fresh export from each trust domain and verifies the artifact', () => {
  const artifact = importReadonlyQrexecDeploymentEvidence({ exports: validExports(), expected });
  assert.equal(artifact.gitSha, SHA);
  assert.equal(artifact.policy.path, '/etc/qubes/policy.d/30-dig-readonly.policy');
  assert.equal(artifact.serviceHandler.target, TARGET);
});

test('accepts reversed export order without weakening domain or freshness checks', () => {
  const exports = validExports().reverse();
  const artifact = importReadonlyQrexecDeploymentEvidence({ exports, expected });
  assert.equal(artifact.service, SERVICE);
});

test('rejects stale replay and cross-run evidence mixing', () => {
  const staleChallenge = 'phase1_ffffffffffffffffFFFFFF';
  assert.throws(
    () => importReadonlyQrexecDeploymentEvidence({ exports: validExports(staleChallenge), expected }),
    /challenge mismatch/
  );

  const mixed = validExports();
  const coordinator = JSON.parse(mixed[1]);
  coordinator.evidenceChallenge = staleChallenge;
  mixed[1] = JSON.stringify(coordinator);
  assert.throws(
    () => importReadonlyQrexecDeploymentEvidence({ exports: mixed, expected }),
    /challenge mismatch/
  );
});

test('rejects missing, malformed, or too-short challenge binding', () => {
  const missingExpected = { ...expected };
  delete missingExpected.evidenceChallenge;
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: validExports(), expected: missingExpected }), /evidenceChallenge is invalid/);

  const exports = validExports();
  const dom0 = JSON.parse(exports[0]);
  delete dom0.evidenceChallenge;
  exports[0] = JSON.stringify(dom0);
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports, expected }), /evidenceChallenge is invalid/);

  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: validExports('short'), expected }), /evidenceChallenge is invalid|challenge mismatch/);
});

test('rejects duplicate or wrong-domain evidence', () => {
  const [dom0] = validExports();
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: [dom0, dom0], expected }), /duplicate deployment evidence domain/);
  const bad = JSON.stringify({ schemaVersion: 2, domain: 'worker-qube', evidenceChallenge: CHALLENGE, evidence: {} });
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: [dom0, bad], expected }), /domain mismatch/);
});

test('rejects stale coordinator git SHA before artifact qualification', () => {
  const exports = validExports();
  const coordinator = JSON.parse(exports[1]);
  coordinator.evidence.serviceHandler.targetGitSha = 'ffffffffffffffffffffffffffffffffffffffff';
  exports[1] = JSON.stringify(coordinator);
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports, expected }), /coordinator evidence git sha mismatch/);
});

test('rejects malformed, oversized, incomplete, schema-drifted, or pre-parsed exports', () => {
  const exports = validExports();
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: [exports[0]], expected }), /exactly two/);
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: ['{', exports[1]], expected }), /valid JSON/);
  const schemaDrift = JSON.stringify({ schemaVersion: 1, domain: 'dom0-policy', evidenceChallenge: CHALLENGE, evidence: {} });
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: [schemaDrift, exports[1]], expected }), /schema mismatch/);
  const oversized = JSON.stringify({ schemaVersion: 2, domain: 'dom0-policy', evidenceChallenge: CHALLENGE, evidence: { path: '/etc/qubes/policy.d/x.policy', text: 'x'.repeat(100000) } });
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: [oversized, exports[1]], expected }), /exceeds byte limit/);

  const preParsed = JSON.parse(exports[0]);
  assert.throws(
    () => importReadonlyQrexecDeploymentEvidence({ exports: [preParsed, exports[1]], expected }),
    /bounded wire JSON/
  );

  const oversizedPreParsed = JSON.parse(oversized);
  assert.throws(
    () => importReadonlyQrexecDeploymentEvidence({ exports: [oversizedPreParsed, exports[1]], expected }),
    /bounded wire JSON/
  );
});

test('rejects policy identity drift through the existing artifact authority', () => {
  const exports = validExports();
  const dom0 = JSON.parse(exports[0]);
  dom0.evidence.text = `${SERVICE} + OtherWorker DIG-Coordinator allow user=dig-readonly\n${SERVICE} * * * deny\n`;
  exports[0] = JSON.stringify(dom0);
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports, expected }), /allow-then-deny/);
});
