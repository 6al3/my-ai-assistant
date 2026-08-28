import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';
import { verifyCoordinatorResponseAttestation } from './qrexec-response-attestation.mjs';
import { runReadonlyQrexecService } from './qrexec-readonly-service-process.mjs';

const SECRET = '0123456789abcdef0123456789abcdef';
const GIT_SHA = '1234567890abcdef1234567890abcdef12345678';
const SERVICE = 'dig.QubesReadonlyProbe';
const KEY_ID = 'probe-key-1';

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    env: {
      DIG_QREXEC_TRANSPORT_SECRET: SECRET,
      DIG_QREXEC_ATTESTATION_PRIVATE_KEY_B64: Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64'),
      DIG_QREXEC_ATTESTATION_KEY_ID: KEY_ID,
      DIG_QREXEC_GIT_SHA: GIT_SHA,
      DIG_QREXEC_SERVICE: SERVICE
    },
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' })
  };
}

function sink() {
  let text = '';
  return {
    stream: new Writable({ write(chunk, _enc, cb) { text += chunk.toString(); cb(); } }),
    text: () => text
  };
}

async function invoke({ env, envelope, raw } = {}) {
  const stdout = sink();
  const stderr = sink();
  const payload = raw ?? JSON.stringify(envelope);
  const code = await runReadonlyQrexecService({
    input: Readable.from([payload]),
    output: stdout.stream,
    error: stderr.stream,
    env
  });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

function probeEnvelope({ requestId = 'probe-1', secret = SECRET, service = SERVICE, gitSha = GIT_SHA, keyId = KEY_ID } = {}) {
  return signWorkerEnvelope({
    requestId,
    issuedAt: Date.now(),
    op: 'probe',
    body: { service, gitSha, keyId },
    secret
  });
}

test('read-only qrexec probe returns deployment-bound attested response without mission store configuration', async () => {
  const { env, publicKeyPem } = fixture();
  const envelope = probeEnvelope();
  const result = await invoke({ env, envelope });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  const response = JSON.parse(result.stdout);
  const unsigned = verifyCoordinatorResponseAttestation(response, {
    publicKeyPem,
    expectedKeyId: KEY_ID,
    expectedGitSha: GIT_SHA,
    expectedService: SERVICE,
    expectedRequestId: envelope.requestId
  });
  assert.deepEqual(unsigned, {
    ok: true,
    op: 'probe',
    value: { protocolVersion: 1, readOnly: true, service: SERVICE, gitSha: GIT_SHA, keyId: KEY_ID }
  });
  assert.equal('DIG_QREXEC_MISSION_STORE_PATH' in env, false);
  assert.equal('DIG_QREXEC_REQUEST_JOURNAL_PATH' in env, false);
});

test('stale deployment identity fails closed before any response is emitted', async () => {
  const { env } = fixture();
  const result = await invoke({ env, envelope: probeEnvelope({ gitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }) });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'DIG_QREXEC_PROBE_REJECTED\n');
});

test('authentication failure and malformed framing fail closed with constant non-diagnostic stderr', async () => {
  const { env } = fixture();
  const badAuth = await invoke({ env, envelope: probeEnvelope({ secret: 'abcdef0123456789abcdef0123456789' }) });
  assert.equal(badAuth.code, 2);
  assert.equal(badAuth.stdout, '');
  assert.equal(badAuth.stderr, 'DIG_QREXEC_PROBE_REJECTED\n');

  const malformed = await invoke({ env, raw: '{"version":1}{"version":1}' });
  assert.equal(malformed.code, 2);
  assert.equal(malformed.stdout, '');
  assert.equal(malformed.stderr, 'DIG_QREXEC_PROBE_REJECTED\n');
});

test('probe byte limits fail closed and do not reflect secrets or request material', async () => {
  const { env } = fixture();
  env.DIG_QREXEC_PROBE_MAX_INPUT_BYTES = '32';
  const envelope = probeEnvelope({ requestId: 'secret-probe-marker' });
  const result = await invoke({ env, envelope });
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'DIG_QREXEC_PROBE_REJECTED\n');
  assert.equal(result.stderr.includes(SECRET), false);
  assert.equal(result.stderr.includes('secret-probe-marker'), false);
});
