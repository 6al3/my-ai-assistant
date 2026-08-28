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
import { encodeBoundedResponse, readSingleEnvelope } from './qrexec-service-process.mjs';

const SECRET = '0123456789abcdef0123456789abcdef';
const SHA = 'c'.repeat(40);
const SERVICE = 'dig.Coordinator';
const KEY_ID = 'qrexec-lab-key';
const ENTRY = new URL('./qrexec-service-process.mjs', import.meta.url);

function keys() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString()
  };
}

function spawnService({ env, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ENTRY.pathname], {
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
    child.stdin.end(input);
  });
}

function serviceEnv({ dir, privateKeyPem, extra = {} }) {
  return {
    DIG_QREXEC_TRANSPORT_SECRET: SECRET,
    DIG_QREXEC_MISSION_STORE_PATH: join(dir, 'missions.json'),
    DIG_QREXEC_REQUEST_JOURNAL_PATH: join(dir, 'requests.json'),
    DIG_QREXEC_ATTESTATION_PRIVATE_KEY_B64: Buffer.from(privateKeyPem, 'utf8').toString('base64'),
    DIG_QREXEC_ATTESTATION_KEY_ID: KEY_ID,
    DIG_QREXEC_GIT_SHA: SHA,
    DIG_QREXEC_SERVICE: SERVICE,
    ...extra
  };
}

async function seedMission(storePath) {
  const coordinator = await MissionCoordinator.open({
    store: new MissionQueueStore(storePath),
    queueOptions: { requireLeaseToken: true }
  });
  await coordinator.enqueue({ task: 'synthetic defensive transport job', requiredCapabilities: ['coder'] });
}

test('spawned one-envelope service authenticates stdin and emits one attested stdout response', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-service-'));
  try {
    const k = keys();
    const env = serviceEnv({ dir, privateKeyPem: k.privateKeyPem });
    await seedMission(env.DIG_QREXEC_MISSION_STORE_PATH);
    const requestId = 'service-claim-1';
    const envelope = signWorkerEnvelope({
      requestId,
      issuedAt: Date.now(),
      op: 'claim',
      body: { workerId: 'worker-a', capabilities: ['coder'], sessionId: 's1' },
      secret: SECRET
    });
    const result = await spawnService({ env, input: JSON.stringify(envelope) });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, '');
    const lines = result.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 1);
    const response = JSON.parse(lines[0]);
    const verified = verifyCoordinatorResponseAttestation(response, {
      publicKeyPem: k.publicKeyPem,
      expectedKeyId: KEY_ID,
      expectedGitSha: SHA,
      expectedService: SERVICE,
      expectedRequestId: requestId
    });
    assert.equal(verified.ok, true);
    assert.equal(verified.op, 'claim');
    assert.equal(verified.value.workerId, 'worker-a');
    assert.equal(typeof verified.value.leaseToken, 'string');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spawned service rejects oversized input without reflecting request secrets or tokens', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-service-'));
  try {
    const k = keys();
    const leaked = 'LEASE_TOKEN_SHOULD_NOT_LEAK';
    const env = serviceEnv({
      dir,
      privateKeyPem: k.privateKeyPem,
      extra: { DIG_QREXEC_MAX_INPUT_BYTES: '128' }
    });
    const input = JSON.stringify({ token: leaked, padding: 'x'.repeat(1024) });
    const result = await spawnService({ env, input });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'DIG_QREXEC_REQUEST_REJECTED\n');
    assert.equal(result.stderr.includes(leaked), false);
    assert.equal(result.stderr.includes(SECRET), false);
    assert.equal(result.stderr.includes(k.privateKeyPem.slice(0, 20)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('spawned service accepts exactly one JSON object and rejects concatenated envelopes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dig-qrexec-service-'));
  try {
    const k = keys();
    const env = serviceEnv({ dir, privateKeyPem: k.privateKeyPem });
    const result = await spawnService({ env, input: '{"a":1}\n{"b":2}' });
    assert.equal(result.code, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'DIG_QREXEC_REQUEST_REJECTED\n');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('bounded response encoder fails closed before writing oversized stdout', () => {
  assert.throws(() => encodeBoundedResponse({ ok: true, value: 'x'.repeat(100) }, { maxOutputBytes: 32 }), /output limit/);
});

test('single-envelope reader rejects empty input', async () => {
  async function* empty() {}
  await assert.rejects(() => readSingleEnvelope(empty(), { maxInputBytes: 64 }), /empty/);
});
