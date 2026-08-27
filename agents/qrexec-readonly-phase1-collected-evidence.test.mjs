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
  return buildReadonlyServiceIdentityContract({
    service,
    coordinatorQube,
    serviceUser,
    serviceUid: uid,
    configuredServiceUid: uid,
    gitSha
  });
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
      } else {
        child.emit('close', 126);
      }
    });
    return child;
  };
}

function stableSnapshots() {
  return async () => ({ missionStoreDigest: 'mission-stable', requestJournalDigest: 'journal-stable' });
}

function filesystemPass() {
  return async () => ({ enforcementVerified: true });
}

async function makeOptions(overrides = {}) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const allowedResponse = attestCoordinatorResponse(
    { ok: true, probe: 'readonly' },
    { privateKey, keyId, gitSha, service },
    { requestId: 'phase1-ok' }
  );
  const calls = [];
  const collectorCalls = [];
  return {
    calls,
    collectorCalls,
    options: {
      gitSha,
      runtimeFingerprint: 'node-collected-evidence-test',
      sourceQube,
      coordinatorQube,
      intendedService: service,
      expectedServiceUser: serviceUser,
      expectedServiceUid: uid,
      expectedServiceTarget: serviceTarget,
      serviceIdentityContract: identityContract(),
      policyPath: '/etc/qubes/policy.d/30-dig-readonly.policy',
      serviceHandlerPath: `/usr/local/etc/qubes-rpc/${service}`,
      deploymentMarkerPath: '/opt/dig/current/deployment.json',
      collectDom0PolicyEvidence: async ({ policyPath }) => {
        collectorCalls.push(['dom0', policyPath]);
        return {
          path: policyPath,
          text: `${service} + ${sourceQube} ${coordinatorQube} allow user=${serviceUser}\n${service} * * * deny\n`
        };
      },
      collectCoordinatorServiceEvidence: async ({ service: collectedService, serviceUid }) => {
        collectorCalls.push(['coordinator', collectedService, serviceUid]);
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
          }
        };
      },
      scenarios: scenarios(),
      snapshotMutationState: stableSnapshots(),
      verifyFilesystemEnforcement: filesystemPass(),
      publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      expectedKeyId: keyId,
      spawnImpl: fakeSpawn(allowedResponse, calls),
      ...overrides
    }
  };
}

test('collected deployment evidence is assembled, verified, and consumed before qrexec scenarios run', async () => {
  const { options, calls, collectorCalls } = await makeOptions();
  const report = await runCollectedArtifactBoundReadonlyQrexecPhase1Qualification(options);
  assert.equal(report.readiness, 'LAB READY');
  assert.equal(report.zeroMutationVerified, true);
  assert.equal(report.attestationVerified, true);
  assert.deepEqual(collectorCalls.map(([domain]) => domain), ['dom0', 'coordinator']);
  assert.equal(calls.length, 5);
});

test('invalid collected policy evidence fails before any qrexec invocation', async () => {
  const { options, calls } = await makeOptions({
    collectDom0PolicyEvidence: async ({ policyPath }) => ({
      path: policyPath,
      text: `${service} + * ${coordinatorQube} allow user=${serviceUser}\n${service} * * * deny\n`
    })
  });
  await assert.rejects(
    () => runCollectedArtifactBoundReadonlyQrexecPhase1Qualification(options),
    /exact allow-then-deny rules/
  );
  assert.equal(calls.length, 0);
});

test('coordinator identity drift in collected evidence fails before any qrexec invocation', async () => {
  const { options, calls } = await makeOptions({
    collectCoordinatorServiceEvidence: async () => ({
      serviceUser,
      serviceUid: uid + 1,
      effectiveUid: uid + 1,
      effectiveGid: 2201,
      serviceHandler: {
        path: `/usr/local/etc/qubes-rpc/${service}`,
        target: serviceTarget,
        executable: true,
        writableByServiceUser: false,
        targetGitSha: gitSha
      }
    })
  });
  await assert.rejects(
    () => runCollectedArtifactBoundReadonlyQrexecPhase1Qualification(options),
    /coordinator evidence identity mismatch/
  );
  assert.equal(calls.length, 0);
});
