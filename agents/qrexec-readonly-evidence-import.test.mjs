import assert from 'node:assert/strict';
import test from 'node:test';
import { importReadonlyQrexecDeploymentEvidence } from './qrexec-readonly-evidence-import.mjs';

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

function validExports() {
  return [
    JSON.stringify({
      schemaVersion: 1,
      domain: 'dom0-policy',
      evidence: {
        path: '/etc/qubes/policy.d/30-dig-readonly.policy',
        text: `${SERVICE} + AI DIG-Coordinator allow user=dig-readonly\n${SERVICE} * * * deny\n`
      }
    }),
    JSON.stringify({
      schemaVersion: 1,
      domain: 'coordinator-service',
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

test('joins exactly one export from each trust domain and verifies the artifact', () => {
  const artifact = importReadonlyQrexecDeploymentEvidence({ exports: validExports(), expected });
  assert.equal(artifact.gitSha, SHA);
  assert.equal(artifact.policy.path, '/etc/qubes/policy.d/30-dig-readonly.policy');
  assert.equal(artifact.serviceHandler.target, TARGET);
});

test('accepts reversed export order without weakening domain checks', () => {
  const exports = validExports().reverse();
  const artifact = importReadonlyQrexecDeploymentEvidence({ exports, expected });
  assert.equal(artifact.service, SERVICE);
});

test('rejects duplicate or wrong-domain evidence', () => {
  const [dom0] = validExports();
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: [dom0, dom0], expected }), /duplicate deployment evidence domain/);
  const bad = JSON.stringify({ schemaVersion: 1, domain: 'worker-qube', evidence: {} });
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: [dom0, bad], expected }), /domain mismatch/);
});

test('rejects stale coordinator git SHA before artifact qualification', () => {
  const exports = validExports();
  const coordinator = JSON.parse(exports[1]);
  coordinator.evidence.serviceHandler.targetGitSha = 'ffffffffffffffffffffffffffffffffffffffff';
  exports[1] = JSON.stringify(coordinator);
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports, expected }), /coordinator evidence git sha mismatch/);
});

test('rejects malformed, oversized, incomplete, or schema-drifted exports', () => {
  const exports = validExports();
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: [exports[0]], expected }), /exactly two/);
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: ['{', exports[1]], expected }), /valid JSON/);
  const schemaDrift = JSON.stringify({ schemaVersion: 2, domain: 'dom0-policy', evidence: {} });
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: [schemaDrift, exports[1]], expected }), /schema mismatch/);
  const oversized = JSON.stringify({ schemaVersion: 1, domain: 'dom0-policy', evidence: { path: '/etc/qubes/policy.d/x.policy', text: 'x'.repeat(100000) } });
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports: [oversized, exports[1]], expected }), /exceeds byte limit/);
});

test('rejects policy identity drift through the existing artifact authority', () => {
  const exports = validExports();
  const dom0 = JSON.parse(exports[0]);
  dom0.evidence.text = `${SERVICE} + OtherWorker DIG-Coordinator allow user=dig-readonly\n${SERVICE} * * * deny\n`;
  exports[0] = JSON.stringify(dom0);
  assert.throws(() => importReadonlyQrexecDeploymentEvidence({ exports, expected }), /allow-then-deny/);
});
