import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  attestCoordinatorResponse,
  loadResponseAttestationConfig,
  verifyCoordinatorResponseAttestation
} from './qrexec-response-attestation.mjs';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';

const SECRET = 'dig-qrexec-attestation-secret-000000000000';
const GIT_SHA = 'a'.repeat(40);
const SERVICE_ID = 'dig.Coordinator';
const KEY_ID = 'dig-lab-ed25519-1';
const SERVICE = new URL('./qubes-qrexec-coordinator-service.mjs', import.meta.url);

function keyMaterial() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
    publicKeyPem: publicKey.export({ format: 'pem', type: 'spki' }).toString()
  };
}

function invokeService({ storePath, journalPath, envelope, privateKeyPem }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVICE.pathname], {
      env: {
        ...process.env,
        DIG_ORCHESTRATION_STORE: storePath,
        DIG_REQUEST_JOURNAL: journalPath,
        DIG_TRANSPORT_SECRET: SECRET,
        DIG_RESPONSE_ATTESTATION_PRIVATE_KEY: privateKeyPem,
        DIG_RESPONSE_ATTESTATION_KEY_ID: KEY_ID,
        DIG_GIT_SHA: GIT_SHA,
        DIG_QREXEC_SERVICE_ID: SERVICE_ID
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      resolve({ code, stderr, responses: lines.map(line => JSON.parse(line)) });
    });
    child.stdin.end(`${JSON.stringify(envelope)}\n`);
  });
}

test('Ed25519 response attestation binds response, git SHA, service, and key identity', () => {
  const { privateKeyPem, publicKeyPem } = keyMaterial();
  const config = loadResponseAttestationConfig({
    DIG_RESPONSE_ATTESTATION_PRIVATE_KEY: privateKeyPem,
    DIG_RESPONSE_ATTESTATION_KEY_ID: KEY_ID,
    DIG_GIT_SHA: GIT_SHA,
    DIG_QREXEC_SERVICE_ID: SERVICE_ID
  });
  const attested = attestCoordinatorResponse({ ok: true, result: { total: 3, nested: { value: 'synthetic' } } }, config);
  const verified = verifyCoordinatorResponseAttestation(attested, {
    publicKeyPem,
    expectedKeyId: KEY_ID,
    expectedGitSha: GIT_SHA,
    expectedService: SERVICE_ID
  });
  assert.deepEqual(verified, { ok: true, result: { total: 3, nested: { value: 'synthetic' } } });

  const tampered = structuredClone(attested);
  tampered.result.total = 4;
  assert.throws(() => verifyCoordinatorResponseAttestation(tampered, { publicKeyPem }), /verification failed/);
  assert.throws(() => verifyCoordinatorResponseAttestation(attested, { publicKeyPem, expectedGitSha: 'b'.repeat(40) }), /gitSha mismatch/);
  assert.throws(() => verifyCoordinatorResponseAttestation(attested, { publicKeyPem, expectedService: 'dig.Other' }), /service mismatch/);
});

test('response attestation configuration is all-or-none and Ed25519-only', () => {
  const { privateKeyPem } = keyMaterial();
  assert.equal(loadResponseAttestationConfig({}), null);
  assert.throws(() => loadResponseAttestationConfig({ DIG_RESPONSE_ATTESTATION_PRIVATE_KEY: privateKeyPem }), /requires .* together/);
  assert.throws(() => loadResponseAttestationConfig({
    DIG_RESPONSE_ATTESTATION_PRIVATE_KEY: privateKeyPem,
    DIG_RESPONSE_ATTESTATION_KEY_ID: KEY_ID,
    DIG_GIT_SHA: 'not-a-sha',
    DIG_QREXEC_SERVICE_ID: SERVICE_ID
  }), /40-character hex SHA/);
});

test('qrexec coordinator emits verifiable coordinator-side attestation on authenticated response', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'dig-qrexec-attestation-'));
  const storePath = path.join(dir, 'queue.json');
  const journalPath = path.join(dir, 'journal.json');
  const { privateKeyPem, publicKeyPem } = keyMaterial();
  try {
    const envelope = signWorkerEnvelope({ requestId: randomUUID(), op: 'stats', body: null, secret: SECRET });
    const result = await invokeService({ storePath, journalPath, envelope, privateKeyPem });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.responses.length, 1);
    const unsigned = verifyCoordinatorResponseAttestation(result.responses[0], {
      publicKeyPem,
      expectedKeyId: KEY_ID,
      expectedGitSha: GIT_SHA,
      expectedService: SERVICE_ID
    });
    assert.equal(unsigned.ok, true);
    assert.equal(typeof unsigned.result.total, 'number');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
