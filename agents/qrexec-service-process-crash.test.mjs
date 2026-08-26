import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { DurableRequestJournal } from './durable-request-journal.mjs';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';
import { verifyCoordinatorResponseAttestation } from './qrexec-response-attestation.mjs';

const SECRET = '0123456789abcdef0123456789abcdef';
const SHA = 'd'.repeat(40);
const SERVICE = 'dig.Coordinator';
const KEY_ID = 'qrexec-crash-lab-key';
const ENTRY = new URL('./qrexec-service-process.mjs', import.meta.url);
const CRASH_ENTRY = new URL('./qrexec-service-process-crash-child.mjs', import.meta.url);

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString()
  };
}

function serviceEnv({ dir, privateKeyPem, crashPoint }) {
  return {
    DIG_QREXEC_TRANSPORT_SECRET: SECRET,
    DIG_QREXEC_MISSION_STORE_PATH: join(dir, 'missions.json'),
    DIG_QREXEC_REQUEST_JOURNAL_PATH: join(dir, 'requests.json'),
    DIG_QREXEC_ATTESTATION_PRIVATE_KEY_B64: Buffer.from(privateKeyPem, 'utf8').toString('base64'),
    DIG_QREXEC_ATTESTATION_KEY_ID: KEY_ID,
    DIG_QREXEC_GIT_SHA: SHA,
    DIG_QREXEC_SERVICE: SERVICE,
    ...(crashPoint ? { DIG_TEST_QREXEC_CRASH_POINT: crashPoint } : {})
  };
}

function spawnEntry(entry, { env, envelope }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry.pathname], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8')
    }));
    child.stdin.end(JSON.stringify(envelope));
  });
}

function verify(stdout, publicKeyPem, requestId) {
  const lines = stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  return verifyCoordinatorResponseAttestation(JSON.parse(lines[0]), {
    publicKeyPem,
    expectedKeyId: KEY_ID,
    expectedGitSha: SHA,
    expectedService: SERVICE,
    expectedRequestId: requestId
  });
}

function assertIndeterminate(response, op) {
  assert.equal(response.ok, false);
  assert.equal(response.op, op);
  assert.equal(response.error.code, 'REQUEST_OUTCOME_INDETERMINATE');
  assert.equal(response.error.retryable, false);
  assert.equal(response.error.reconciliationRequired, true);
}

async function openCoordinator(storePath, extra = {}) {
  return MissionCoordinator.open({
    store: new MissionQueueStore(storePath),
    queueOptions: { requireLeaseToken: true, preserveRunningLeasesOnRestore: true, ...extra }
  });
}

async function seed(coordinator, count = 1) {
  const missions = [];
  for (let i = 0; i < count; i += 1) {
    missions.push(await coordinator.enqueue({
      task: `synthetic defensive qrexec crash job ${i + 1}`,
      requiredCapabilities: ['coder']
    }));
  }
  return missions;
}

test('process death before mutation leaves no durable request effect and normal retry executes once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-crash-before-'));
  try {
    const k = keys();
    const env = serviceEnv({ dir, privateKeyPem: k.privateKeyPem });
    const coordinator = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    await seed(coordinator, 1);
    const requestId = 'process-crash-before-claim';
    const envelope = signWorkerEnvelope({
      requestId,
      issuedAt: Date.now(),
      op: 'claim',
      body: { workerId: 'worker-a', capabilities: ['coder'], sessionId: 's1' },
      secret: SECRET
    });

    const crashed = await spawnEntry(CRASH_ENTRY, {
      env: serviceEnv({ dir, privateKeyPem: k.privateKeyPem, crashPoint: 'before-mutation' }),
      envelope
    });
    assert.equal(crashed.code, 85);
    assert.equal(crashed.stdout, '');

    const afterCrash = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(afterCrash.list({ status: 'queued' }).length, 1);
    assert.equal(afterCrash.list({ status: 'running' }).length, 0);
    const missingJournal = await DurableRequestJournal.open(env.DIG_QREXEC_REQUEST_JOURNAL_PATH);
    assert.equal(missingJournal.get(requestId), null);

    const retry = await spawnEntry(ENTRY, { env, envelope });
    assert.equal(retry.code, 0, retry.stderr);
    const verified = verify(retry.stdout, k.publicKeyPem, requestId);
    assert.equal(verified.ok, true);
    assert.equal(verified.op, 'claim');
    const afterRetry = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(afterRetry.list({ status: 'running' }).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('process death after durable claim mutation yields attested indeterminate retry without second claim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-crash-after-mutation-'));
  try {
    const k = keys();
    const env = serviceEnv({ dir, privateKeyPem: k.privateKeyPem });
    const coordinator = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    await seed(coordinator, 2);
    const requestId = 'process-crash-after-claim';
    const envelope = signWorkerEnvelope({
      requestId,
      issuedAt: Date.now(),
      op: 'claim',
      body: { workerId: 'worker-a', capabilities: ['coder'], sessionId: 's1' },
      secret: SECRET
    });

    const crashed = await spawnEntry(CRASH_ENTRY, {
      env: serviceEnv({ dir, privateKeyPem: k.privateKeyPem, crashPoint: 'after-mutation' }),
      envelope
    });
    assert.equal(crashed.code, 86);
    assert.equal(crashed.stdout, '');

    const afterCrash = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(afterCrash.list({ status: 'running' }).length, 1);
    assert.equal(afterCrash.list({ status: 'queued' }).length, 1);
    const journal = await DurableRequestJournal.open(env.DIG_QREXEC_REQUEST_JOURNAL_PATH);
    assert.equal(journal.get(requestId).status, 'pending');

    const retry = await spawnEntry(ENTRY, { env, envelope });
    assert.equal(retry.code, 0, retry.stderr);
    assertIndeterminate(verify(retry.stdout, k.publicKeyPem, requestId), 'claim');
    const afterRetry = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(afterRetry.list({ status: 'running' }).length, 1);
    assert.equal(afterRetry.list({ status: 'queued' }).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('process death after journal commit but before stdout replays the committed attested outcome without mutation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-crash-after-commit-'));
  try {
    const k = keys();
    const env = serviceEnv({ dir, privateKeyPem: k.privateKeyPem });
    const coordinator = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    await seed(coordinator, 2);
    const requestId = 'process-crash-after-journal-commit';
    const envelope = signWorkerEnvelope({
      requestId,
      issuedAt: Date.now(),
      op: 'claim',
      body: { workerId: 'worker-a', capabilities: ['coder'], sessionId: 's1' },
      secret: SECRET
    });

    const crashed = await spawnEntry(CRASH_ENTRY, {
      env: serviceEnv({ dir, privateKeyPem: k.privateKeyPem, crashPoint: 'after-journal-commit' }),
      envelope
    });
    assert.equal(crashed.code, 87);
    assert.equal(crashed.stdout, '');

    const journal = await DurableRequestJournal.open(env.DIG_QREXEC_REQUEST_JOURNAL_PATH);
    assert.equal(journal.get(requestId).status, 'committed');
    const afterCrash = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(afterCrash.list({ status: 'running' }).length, 1);
    assert.equal(afterCrash.list({ status: 'queued' }).length, 1);

    const retry = await spawnEntry(ENTRY, { env, envelope });
    assert.equal(retry.code, 0, retry.stderr);
    const verified = verify(retry.stdout, k.publicKeyPem, requestId);
    assert.equal(verified.ok, true);
    assert.equal(verified.op, 'claim');
    const afterRetry = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(afterRetry.list({ status: 'running' }).length, 1);
    assert.equal(afterRetry.list({ status: 'queued' }).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('process death after durable complete is reconciled read-only through the spawned service boundary', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-crash-complete-'));
  try {
    const k = keys();
    const env = serviceEnv({ dir, privateKeyPem: k.privateKeyPem });
    const coordinator = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    await seed(coordinator, 1);
    const claimed = await coordinator.claim({ workerId: 'worker-a', capabilities: ['coder'], sessionId: 's1' });
    const result = { status: 'ok', source: 'synthetic-qrexec-process-crash' };
    const requestId = 'process-crash-complete';
    const envelope = signWorkerEnvelope({
      requestId,
      issuedAt: Date.now(),
      op: 'complete',
      body: { missionId: claimed.id, workerId: 'worker-a', leaseToken: claimed.leaseToken, result },
      secret: SECRET
    });

    const crashed = await spawnEntry(CRASH_ENTRY, {
      env: serviceEnv({ dir, privateKeyPem: k.privateKeyPem, crashPoint: 'after-mutation' }),
      envelope
    });
    assert.equal(crashed.code, 86);
    assert.equal(crashed.stdout, '');
    const pending = await DurableRequestJournal.open(env.DIG_QREXEC_REQUEST_JOURNAL_PATH);
    assert.equal(pending.get(requestId).status, 'pending');

    const retry = await spawnEntry(ENTRY, { env, envelope });
    assert.equal(retry.code, 0, retry.stderr);
    const verified = verify(retry.stdout, k.publicKeyPem, requestId);
    assert.equal(verified.ok, true);
    assert.equal(verified.op, 'complete');
    assert.deepEqual(verified.value.result, result);
    const committed = await DurableRequestJournal.open(env.DIG_QREXEC_REQUEST_JOURNAL_PATH);
    assert.equal(committed.get(requestId).status, 'committed');
    const reopened = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(reopened.list({ status: 'completed' }).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
