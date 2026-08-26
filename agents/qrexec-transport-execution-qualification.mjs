import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { DurableRequestJournal } from './durable-request-journal.mjs';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';
import { verifyCoordinatorResponseAttestation } from './qrexec-response-attestation.mjs';
import { buildQrexecTransportQualification, verifyQrexecTransportQualification } from './qrexec-transport-qualification.mjs';

const DEFAULT_SECRET = '0123456789abcdef0123456789abcdef';
const DEFAULT_SERVICE = 'dig.Coordinator';
const DEFAULT_KEY_ID = 'qrexec-execution-qualification-key';
const SERVICE_ENTRY = new URL('./qrexec-service-process.mjs', import.meta.url);
const CRASH_ENTRY = new URL('./qrexec-service-process-crash-child.mjs', import.meta.url);

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString()
  };
}

function serviceEnv({ dir, gitSha, privateKeyPem, secret, service, keyId, crashPoint }) {
  return {
    DIG_QREXEC_TRANSPORT_SECRET: secret,
    DIG_QREXEC_MISSION_STORE_PATH: join(dir, 'missions.json'),
    DIG_QREXEC_REQUEST_JOURNAL_PATH: join(dir, 'requests.json'),
    DIG_QREXEC_ATTESTATION_PRIVATE_KEY_B64: Buffer.from(privateKeyPem).toString('base64'),
    DIG_QREXEC_ATTESTATION_KEY_ID: keyId,
    DIG_QREXEC_GIT_SHA: gitSha,
    DIG_QREXEC_SERVICE: service,
    ...(crashPoint ? { DIG_TEST_QREXEC_CRASH_POINT: crashPoint } : {})
  };
}

function spawnEntry(entry, { env, envelope, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry.pathname], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('qrexec qualification child timed out'));
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

function verifyStdout(stdout, { publicKeyPem, gitSha, service, keyId, requestId }) {
  const lines = stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1, 'service must emit exactly one response line');
  return verifyCoordinatorResponseAttestation(JSON.parse(lines[0]), {
    publicKeyPem,
    expectedKeyId: keyId,
    expectedGitSha: gitSha,
    expectedService: service,
    expectedRequestId: requestId
  });
}

async function openCoordinator(storePath, queueOptions = {}) {
  return MissionCoordinator.open({
    store: new MissionQueueStore(storePath),
    queueOptions: { requireLeaseToken: true, preserveRunningLeasesOnRestore: true, ...queueOptions }
  });
}

async function seed(coordinator, count = 1, prefix = 'synthetic defensive qrexec qualification') {
  const missions = [];
  for (let i = 0; i < count; i += 1) {
    missions.push(await coordinator.enqueue({ task: `${prefix} ${i + 1}`, requiredCapabilities: ['coder'] }));
  }
  return missions;
}

function signedEnvelope({ requestId, op, body, secret }) {
  return signWorkerEnvelope({ requestId, issuedAt: Date.now(), op, body, secret });
}

async function journalStatus(path, requestId) {
  const journal = await DurableRequestJournal.open(path);
  return journal.get(requestId)?.status ?? 'missing';
}

async function scenarioBeforeMutation(ctx) {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-qual-before-'));
  try {
    const env = serviceEnv({ ...ctx, dir });
    const coordinator = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    await seed(coordinator, 1);
    const requestId = `qual-before-${randomUUID()}`;
    const request = signedEnvelope({ requestId, op: 'claim', body: { workerId: 'worker-a', capabilities: ['coder'], sessionId: 's1' }, secret: ctx.secret });
    const crashed = await spawnEntry(CRASH_ENTRY, { env: serviceEnv({ ...ctx, dir, crashPoint: 'before-mutation' }), envelope: request });
    assert.equal(crashed.code, 85);
    const afterCrash = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(afterCrash.list({ status: 'running' }).length, 0);
    assert.equal(await journalStatus(env.DIG_QREXEC_REQUEST_JOURNAL_PATH, requestId), 'missing');
    const retry = await spawnEntry(SERVICE_ENTRY, { env, envelope: request });
    assert.equal(retry.code, 0, retry.stderr);
    const response = verifyStdout(retry.stdout, { ...ctx, requestId });
    assert.equal(response.ok, true);
    const reopened = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(reopened.list({ status: 'running' }).length, 1);
    return { attestationVerified: true, duplicateMutations: 0, durableEffectCount: 0, journalStatus: 'missing', outcome: 'RETRY_EXECUTES_ONCE' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function scenarioAfterClaimMutation(ctx) {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-qual-claim-'));
  try {
    const env = serviceEnv({ ...ctx, dir });
    const coordinator = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    await seed(coordinator, 2);
    const requestId = `qual-claim-${randomUUID()}`;
    const request = signedEnvelope({ requestId, op: 'claim', body: { workerId: 'worker-a', capabilities: ['coder'], sessionId: 's1' }, secret: ctx.secret });
    const crashed = await spawnEntry(CRASH_ENTRY, { env: serviceEnv({ ...ctx, dir, crashPoint: 'after-mutation' }), envelope: request });
    assert.equal(crashed.code, 86);
    const beforeRetry = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(beforeRetry.list({ status: 'running' }).length, 1);
    assert.equal(beforeRetry.list({ status: 'queued' }).length, 1);
    const retry = await spawnEntry(SERVICE_ENTRY, { env, envelope: request });
    assert.equal(retry.code, 0, retry.stderr);
    const response = verifyStdout(retry.stdout, { ...ctx, requestId });
    assert.equal(response.error?.code, 'REQUEST_OUTCOME_INDETERMINATE');
    const afterRetry = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(afterRetry.list({ status: 'running' }).length, 1);
    assert.equal(afterRetry.list({ status: 'queued' }).length, 1);
    return { attestationVerified: true, duplicateMutations: 0, durableEffectCount: 1, journalStatus: await journalStatus(env.DIG_QREXEC_REQUEST_JOURNAL_PATH, requestId), outcome: 'REQUEST_OUTCOME_INDETERMINATE' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function setupRunning(ctx, dir, queueOptions = {}) {
  const env = serviceEnv({ ...ctx, dir });
  const coordinator = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH, queueOptions);
  await seed(coordinator, 1);
  const claimed = await coordinator.claim({ workerId: 'worker-a', capabilities: ['coder'], sessionId: 's1' });
  return { env, claimed };
}

async function scenarioAfterHeartbeatMutation(ctx) {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-qual-heartbeat-'));
  try {
    const { env, claimed } = await setupRunning(ctx, dir, { leaseMs: 60000 });
    const requestId = `qual-heartbeat-${randomUUID()}`;
    const request = signedEnvelope({ requestId, op: 'heartbeat', body: { missionId: claimed.id, workerId: 'worker-a', leaseToken: claimed.leaseToken }, secret: ctx.secret });
    const crashed = await spawnEntry(CRASH_ENTRY, { env: serviceEnv({ ...ctx, dir, crashPoint: 'after-mutation' }), envelope: request });
    assert.equal(crashed.code, 86);
    const beforeRetry = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH, { leaseMs: 60000 });
    const leaseAfterCrash = beforeRetry.get(claimed.id).leaseUntil;
    const retry = await spawnEntry(SERVICE_ENTRY, { env, envelope: request });
    assert.equal(retry.code, 0, retry.stderr);
    const response = verifyStdout(retry.stdout, { ...ctx, requestId });
    assert.equal(response.error?.code, 'REQUEST_OUTCOME_INDETERMINATE');
    const afterRetry = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH, { leaseMs: 60000 });
    assert.equal(afterRetry.get(claimed.id).leaseUntil, leaseAfterCrash);
    return { attestationVerified: true, duplicateMutations: 0, durableEffectCount: 1, journalStatus: await journalStatus(env.DIG_QREXEC_REQUEST_JOURNAL_PATH, requestId), outcome: 'REQUEST_OUTCOME_INDETERMINATE' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function scenarioAfterFailMutation(ctx) {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-qual-fail-'));
  try {
    const { env, claimed } = await setupRunning(ctx, dir, { maxAttempts: 3 });
    const requestId = `qual-fail-${randomUUID()}`;
    const request = signedEnvelope({ requestId, op: 'fail', body: { missionId: claimed.id, workerId: 'worker-a', leaseToken: claimed.leaseToken, error: 'synthetic defensive qualification failure' }, secret: ctx.secret });
    const crashed = await spawnEntry(CRASH_ENTRY, { env: serviceEnv({ ...ctx, dir, crashPoint: 'after-mutation' }), envelope: request });
    assert.equal(crashed.code, 86);
    const beforeRetry = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH, { maxAttempts: 3 });
    const snapshot = beforeRetry.get(claimed.id);
    assert.equal(snapshot.attempts, 1);
    const retry = await spawnEntry(SERVICE_ENTRY, { env, envelope: request });
    assert.equal(retry.code, 0, retry.stderr);
    const response = verifyStdout(retry.stdout, { ...ctx, requestId });
    assert.equal(response.error?.code, 'REQUEST_OUTCOME_INDETERMINATE');
    const afterRetry = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH, { maxAttempts: 3 });
    assert.deepEqual(afterRetry.get(claimed.id), snapshot);
    return { attestationVerified: true, duplicateMutations: 0, durableEffectCount: 1, journalStatus: await journalStatus(env.DIG_QREXEC_REQUEST_JOURNAL_PATH, requestId), outcome: 'REQUEST_OUTCOME_INDETERMINATE' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function scenarioAfterCompleteMutation(ctx) {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-qual-complete-'));
  try {
    const { env, claimed } = await setupRunning(ctx, dir);
    const result = { status: 'ok', source: 'execution-derived-qrexec-qualification' };
    const requestId = `qual-complete-${randomUUID()}`;
    const request = signedEnvelope({ requestId, op: 'complete', body: { missionId: claimed.id, workerId: 'worker-a', leaseToken: claimed.leaseToken, result }, secret: ctx.secret });
    const crashed = await spawnEntry(CRASH_ENTRY, { env: serviceEnv({ ...ctx, dir, crashPoint: 'after-mutation' }), envelope: request });
    assert.equal(crashed.code, 86);
    const retry = await spawnEntry(SERVICE_ENTRY, { env, envelope: request });
    assert.equal(retry.code, 0, retry.stderr);
    const response = verifyStdout(retry.stdout, { ...ctx, requestId });
    assert.equal(response.ok, true);
    assert.deepEqual(response.value.result, result);
    const reopened = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(reopened.list({ status: 'completed' }).length, 1);
    return { attestationVerified: true, duplicateMutations: 0, durableEffectCount: 1, journalStatus: await journalStatus(env.DIG_QREXEC_REQUEST_JOURNAL_PATH, requestId), outcome: 'RECONCILED_COMPLETE' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function scenarioAfterJournalCommit(ctx) {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-qual-journal-'));
  try {
    const env = serviceEnv({ ...ctx, dir });
    const coordinator = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    await seed(coordinator, 1);
    const requestId = `qual-journal-${randomUUID()}`;
    const request = signedEnvelope({ requestId, op: 'claim', body: { workerId: 'worker-a', capabilities: ['coder'], sessionId: 's1' }, secret: ctx.secret });
    const crashed = await spawnEntry(CRASH_ENTRY, { env: serviceEnv({ ...ctx, dir, crashPoint: 'after-journal-commit' }), envelope: request });
    assert.equal(crashed.code, 87);
    assert.equal(await journalStatus(env.DIG_QREXEC_REQUEST_JOURNAL_PATH, requestId), 'committed');
    const beforeRetry = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(beforeRetry.list({ status: 'running' }).length, 1);
    const retry = await spawnEntry(SERVICE_ENTRY, { env, envelope: request });
    assert.equal(retry.code, 0, retry.stderr);
    const response = verifyStdout(retry.stdout, { ...ctx, requestId });
    assert.equal(response.ok, true);
    const afterRetry = await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);
    assert.equal(afterRetry.list({ status: 'running' }).length, 1);
    return { attestationVerified: true, duplicateMutations: 0, durableEffectCount: 1, journalStatus: 'committed', outcome: 'REPLAY_COMMITTED' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function runExecutionDerivedQrexecTransportQualification({
  gitSha,
  secret = DEFAULT_SECRET,
  service = DEFAULT_SERVICE,
  keyId = DEFAULT_KEY_ID,
  runtime = { node: process.version, platform: process.platform, arch: process.arch }
} = {}) {
  if (typeof gitSha !== 'string' || !/^[0-9a-f]{40}$/i.test(gitSha)) throw new Error('gitSha must be a 40-character hex SHA');
  const { privateKeyPem, publicKeyPem } = keyPair();
  const ctx = { gitSha: gitSha.toLowerCase(), secret, service, keyId, privateKeyPem, publicKeyPem };
  const scenarios = {
    beforeMutation: await scenarioBeforeMutation(ctx),
    afterClaimMutation: await scenarioAfterClaimMutation(ctx),
    afterHeartbeatMutation: await scenarioAfterHeartbeatMutation(ctx),
    afterFailMutation: await scenarioAfterFailMutation(ctx),
    afterCompleteMutation: await scenarioAfterCompleteMutation(ctx),
    afterJournalCommit: await scenarioAfterJournalCommit(ctx)
  };
  const report = buildQrexecTransportQualification({ gitSha: ctx.gitSha, runtime, scenarios });
  verifyQrexecTransportQualification(report, { expectedGitSha: ctx.gitSha });
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const gitSha = process.env.DIG_GIT_SHA;
  try {
    const report = await runExecutionDerivedQrexecTransportQualification({ gitSha });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.readiness === 'LAB READY' ? 0 : 1;
  } catch {
    process.stderr.write('DIG_QREXEC_EXECUTION_QUALIFICATION_FAILED\n');
    process.exitCode = 1;
  }
}
