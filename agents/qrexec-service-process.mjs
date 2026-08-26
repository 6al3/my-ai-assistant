import process from 'node:process';
import { Buffer } from 'node:buffer';
import { handleQrexecEnvelope } from './qrexec-coordinator-adapter.mjs';

const DEFAULT_MAX_INPUT_BYTES = 64 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

function positiveInt(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function required(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function decodePrivateKey(value) {
  const encoded = required(value, 'DIG_QREXEC_ATTESTATION_PRIVATE_KEY_B64');
  const pem = Buffer.from(encoded, 'base64').toString('utf8');
  if (!pem.includes('PRIVATE KEY')) throw new Error('invalid attestation private key');
  return pem;
}

export function loadQrexecServiceConfig(env = process.env) {
  return {
    maxInputBytes: positiveInt(env.DIG_QREXEC_MAX_INPUT_BYTES, 'DIG_QREXEC_MAX_INPUT_BYTES', DEFAULT_MAX_INPUT_BYTES),
    maxOutputBytes: positiveInt(env.DIG_QREXEC_MAX_OUTPUT_BYTES, 'DIG_QREXEC_MAX_OUTPUT_BYTES', DEFAULT_MAX_OUTPUT_BYTES),
    adapterOptions: {
      secret: required(env.DIG_QREXEC_TRANSPORT_SECRET, 'DIG_QREXEC_TRANSPORT_SECRET'),
      missionStorePath: required(env.DIG_QREXEC_MISSION_STORE_PATH, 'DIG_QREXEC_MISSION_STORE_PATH'),
      journalPath: required(env.DIG_QREXEC_REQUEST_JOURNAL_PATH, 'DIG_QREXEC_REQUEST_JOURNAL_PATH'),
      queueOptions: { requireLeaseToken: true },
      attestationConfig: {
        privateKey: decodePrivateKey(env.DIG_QREXEC_ATTESTATION_PRIVATE_KEY_B64),
        keyId: required(env.DIG_QREXEC_ATTESTATION_KEY_ID, 'DIG_QREXEC_ATTESTATION_KEY_ID'),
        gitSha: required(env.DIG_QREXEC_GIT_SHA, 'DIG_QREXEC_GIT_SHA'),
        service: required(env.DIG_QREXEC_SERVICE, 'DIG_QREXEC_SERVICE')
      }
    }
  };
}

export async function readSingleEnvelope(stream, { maxInputBytes = DEFAULT_MAX_INPUT_BYTES } = {}) {
  if (!Number.isSafeInteger(maxInputBytes) || maxInputBytes < 1) throw new Error('maxInputBytes must be a positive integer');
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxInputBytes) throw new Error('request exceeds input limit');
    chunks.push(bytes);
  }
  if (total === 0) throw new Error('request body is empty');
  const text = Buffer.concat(chunks, total).toString('utf8');
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch {
    throw new Error('request is not valid JSON');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('request must be one JSON object');
  return envelope;
}

export function encodeBoundedResponse(response, { maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('maxOutputBytes must be a positive integer');
  const output = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(output, 'utf8') > maxOutputBytes) throw new Error('response exceeds output limit');
  return output;
}

export async function runQrexecServiceProcess({ input = process.stdin, output = process.stdout, error = process.stderr, env = process.env, handler = handleQrexecEnvelope } = {}) {
  let config;
  try {
    config = loadQrexecServiceConfig(env);
    const envelope = await readSingleEnvelope(input, config);
    const response = await handler(envelope, config.adapterOptions);
    output.write(encodeBoundedResponse(response, config));
    return 0;
  } catch {
    // Keep the transport failure channel deliberately non-diagnostic: request bodies,
    // MACs, lease tokens, filesystem paths, private-key material, and stack traces must
    // never be reflected to qrexec stderr. Authenticated coordinator rejections and
    // indeterminate mutation outcomes are returned by the adapter as attested stdout.
    error.write('DIG_QREXEC_REQUEST_REJECTED\n');
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await runQrexecServiceProcess();
  process.exitCode = code;
}
