import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';
import { verifyCoordinatorResponseAttestation } from './qrexec-response-attestation.mjs';

const SECRET = '0123456789abcdef0123456789abcdef';
const SHA = 'f'.repeat(40);
const SERVICE = 'dig.Coordinator';
const KEY_ID = 'qrexec-process-lease-key';
const ENTRY = new URL('./qrexec-service-process.mjs', import.meta.url);

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString()
  };
}

function envFor(dir, privateKeyPem) {
  return {
    DIG_QREXEC_TRANSPORT_SECRET: SECRET,
    DIG_QREXEC_MISSION_STORE_PATH: join(dir, 'missions.json'),
    DIG_QREXEC_REQUEST_JOURNAL_PATH: join(dir, 'requests.json'),
    DIG_QREXEC_ATTESTATION_PRIVATE_KEY_B64: Buffer.from(privateKeyPem).toString('base64'),
    DIG_QREXEC_ATTESTATION_KEY_ID: KEY_ID,
    DIG_QREXEC_GIT_SHA: SHA,
    DIG_QREXEC_SERVICE: SERVICE
  };
}

function spawnService(env, envelope) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY.pathname], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
    child.stdin.end(JSON.stringify(envelope));
  });
}

function request(requestId, op, body) {
  return signWorkerEnvelope({ requestId, issuedAt: Date.now(), op, body, secret: SECRET });
}

function verify(result, publicKeyPem, requestId) {
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  return verifyCoordinatorResponseAttestation(JSON.parse(lines[0]), {
    publicKeyPem,
    expectedKeyId: KEY_ID,
    expectedGitSha: SHA,
    expectedService: SERVICE,
    expectedRequestId: requestId
  });
}

test('claim, heartbeat, and complete preserve the same live fenced lease across separate qrexec processes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-live-lease-'));
  try {
    const k = keys();
    const env = envFor(dir, k.privateKeyPem);
    const coordinator = await MissionCoordinator.open({
      store: new MissionQueueStore(env.DIG_QREXEC_MISSION_STORE_PATH),
      queueOptions: { requireLeaseToken: true }
    });
    await coordinator.enqueue({ task: 'synthetic defensive process lease job', requiredCapabilities: ['coder'] });

    const claimId = 'process-lease-claim';
    const claimed = verify(await spawnService(env, request(claimId, 'claim', { workerId: 'worker-a', capabilities: ['coder'], sessionId: 's1' })), k.publicKeyPem, claimId);
    assert.equal(claimed.ok, true);
    assert.equal(claimed.value.status, 'running');
    assert.equal(typeof claimed.value.leaseToken, 'string');

    const heartbeatId = 'process-lease-heartbeat';
    const heartbeat = verify(await spawnService(env, request(heartbeatId, 'heartbeat', {
      missionId: claimed.value.id,
      workerId: 'worker-a',
      leaseToken: claimed.value.leaseToken
    })), k.publicKeyPem, heartbeatId);
    assert.equal(heartbeat.ok, true);
    assert.equal(heartbeat.value.status, 'running');
    assert.equal(heartbeat.value.workerId, 'worker-a');
    assert.equal(heartbeat.value.leaseToken, claimed.value.leaseToken);

    const completeId = 'process-lease-complete';
    const result = { status: 'ok', source: 'synthetic-process-lease-lifecycle' };
    const completed = verify(await spawnService(env, request(completeId, 'complete', {
      missionId: claimed.value.id,
      workerId: 'worker-a',
      leaseToken: claimed.value.leaseToken,
      result
    })), k.publicKeyPem, completeId);
    assert.equal(completed.ok, true);
    assert.equal(completed.value.status, 'completed');
    assert.deepEqual(completed.value.result, result);

    const reopened = await MissionCoordinator.open({
      store: new MissionQueueStore(env.DIG_QREXEC_MISSION_STORE_PATH),
      queueOptions: { requireLeaseToken: true, preserveRunningLeasesOnRestore: true }
    });
    assert.equal(reopened.get(claimed.value.id).status, 'completed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
