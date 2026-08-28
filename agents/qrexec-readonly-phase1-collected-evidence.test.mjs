import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { attestCoordinatorResponse } from './qrexec-response-attestation.mjs';
import { buildReadonlyServiceIdentityContract } from './qrexec-readonly-service-identity-contract.mjs';
import { runCollectedArtifactBoundReadonlyQrexecPhase1Qualification } from './qrexec-readonly-phase1-deployment.mjs';

const gitSha = 'a'.repeat(40);
const service = 'dig.ReadonlyProbe';
const sourceQube = 'dig-worker';
const coordinatorQube = 'dig-coordinator';
const serviceUser = 'dig-readonly';
const uid = 2201;
const keyId = 'collected-evidence-key';
const serviceTarget = '/opt/dig/current/agents/qrexec-readonly-service-process.mjs';

function identityContract() {
  return buildReadonlyServiceIdentityContract({ service, coordinatorQube, serviceUser, serviceUid: uid, configuredServiceUid: uid, gitSha });
}

function policyEvidence(overrides = {}) {
  return {
    path: '/etc/qubes/policy.d/30-dig-readonly.policy',
    text: `${service} + ${sourceQube} ${coordinatorQube} allow user=${serviceUser}\n${service} * * * deny\n`,
    ...overrides
  };
}

function coordinatorEvidence(overrides = {}) {
  return {
    serviceUser,
    serviceUid: uid,
    effectiveUid: uid,
    effectiveGid: 2201,
    serviceHandler: {
      path: `/usr/local/etc/qubes-rpc/${service}`,
      target: serviceTarget,
      executable: true,
      writableByServiceUser: false,
      targetGitSha: gitSha
    },
    ...overrides
  };
}

function scenarios() {
  return {
    'intended-service-allowed': { service, payload: '{"requestId":"phase1-ok"}\n' },
    'wrong-service-denied': { service: 'dig.NotAllowed', payload: '{}' },
    'wrong-identity-denied': { service, payload: '{"identity":"stale"}' },
    'auth-failure-denied': { service, payload: '{"mac":"invalid"}' },
    'malformed-framing-denied': { service, payload: '{}\n{}\n' }
  };
}

function fakeSpawn(allowedResponse, calls) {
  return (_command, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      if (args[1] === service) {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify(allowedResponse)}\n`));
        child.emit('close', 0);
      } else child.emit('close', 126);
    });
    return child;
  };
}

async function makeOptions(overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const response = attestCoordinatorResponse(
    { ok: true, probe: 'readonly' },
    { privateKey, keyId, gitSha, service },
    { requestId: 'phase1-ok' }
  );
  const calls = [];
  return {
    calls,
    options: {
      gitSha,
      runtimeFingerprint: 'node-split-domain-evidence-test',
      sourceQube,
      coordinatorQube,
      intendedService: service,
      expectedServiceUser: serviceUser,
      expectedServiceUid: uid,
      expectedServiceTarget: serviceTarget,
      serviceIdentityContract: identityContract(),
      policyEvidence: policyEvidence(),
      coordinatorEvidence: coordinatorEvidence(),
      scenarios: scenarios(),
      snapshotMutationState: async () => ({ missionStoreDigest: 'mission-stable', requestJournalDigest: 'journal-stable' }),
      verifyFilesystemEnforcement: async () => ({ enforcementVerified: true }),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      expectedKeyId: keyId,
      spawnImpl: fakeSpawn(response, calls),
      ...overrides
    }
  };
}

test('independently collected dom0 and coordinator evidence is assembled before qrexec scenarios run', async () => {
  const { options, calls } = await makeOptions();
  const report = await runCollectedArtifactBoundReadonlyQrexecPhase1Qualification(options);
  assert.equal(report.readiness, 'LAB READY');
  assert.equal(report.zeroMutationVerified, true);
  assert.equal(report.attestationVerified, true);
  assert.equal(calls.length, 5);
});

test('cross-domain collector injection is rejected by default before qrexec', async () => {
  const { options, calls } = await makeOptions({
    policyEvidence: undefined,
    coordinatorEvidence: undefined,
    collectDom0PolicyEvidence: async () => policyEvidence(),
    collectCoordinatorServiceEvidence: async () => coordinatorEvidence()
  });
  await assert.rejects(
    () => runCollectedArtifactBoundReadonlyQrexecPhase1Qualification(options),
    /cross-domain collector injection is test-only/
  );
  assert.equal(calls.length, 0);
});

test('explicit test seam may inject both collectors without changing production boundary', async () => {
  const collectorCalls = [];
  const { options, calls } = await makeOptions({
    policyEvidence: undefined,
    coordinatorEvidence: undefined,
    allowTestCrossDomainCollectors: true,
    collectDom0PolicyEvidence: async () => {
      collectorCalls.push('dom0');
      return policyEvidence();
    },
    collectCoordinatorServiceEvidence: async () => {
      collectorCalls.push('coordinator');
      return coordinatorEvidence();
    }
  });
  const report = await runCollectedArtifactBoundReadonlyQrexecPhase1Qualification(options);
  assert.equal(report.readiness, 'LAB READY');
  assert.deepEqual(collectorCalls, ['dom0', 'coordinator']);
  assert.equal(calls.length, 5);
});

test('invalid split-domain policy evidence fails before any qrexec invocation', async () => {
  const { options, calls } = await makeOptions({
    policyEvidence: policyEvidence({
      text: `${service} + * ${coordinatorQube} allow user=${serviceUser}\n${service} * * * deny\n`
    })
  });
  await assert.rejects(
    () => runCollectedArtifactBoundReadonlyQrexecPhase1Qualification(options),
    /exact allow-then-deny rules/
  );
  assert.equal(calls.length, 0);
});

test('coordinator identity drift in split-domain evidence fails before qrexec', async () => {
  const { options, calls } = await makeOptions({
    coordinatorEvidence: coordinatorEvidence({ serviceUid: uid + 1, effectiveUid: uid + 1 })
  });
  await assert.rejects(
    () => runCollectedArtifactBoundReadonlyQrexecPhase1Qualification(options),
    /coordinator evidence identity mismatch/
  );
  assert.equal(calls.length, 0);
});
