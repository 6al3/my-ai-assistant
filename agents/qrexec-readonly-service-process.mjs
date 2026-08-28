import process from 'node:process';
import { Buffer } from 'node:buffer';
import { handleReadonlyProbeEnvelope, loadReadonlyProbeConfig } from './qrexec-readonly-probe.mjs';

const DEFAULT_MAX_INPUT_BYTES = 16 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 32 * 1024;

function positiveInt(value, name, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export async function readProbeEnvelope(stream, { maxInputBytes = DEFAULT_MAX_INPUT_BYTES } = {}) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxInputBytes) throw new Error('probe exceeds input limit');
    chunks.push(bytes);
  }
  if (total === 0) throw new Error('probe body is empty');
  let envelope;
  try {
    envelope = JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new Error('probe is not valid JSON');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('probe must be one JSON object');
  return envelope;
}

export function encodeProbeResponse(response, { maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES } = {}) {
  const output = `${JSON.stringify(response)}\n`;
  if (Buffer.byteLength(output, 'utf8') > maxOutputBytes) throw new Error('probe response exceeds output limit');
  return output;
}

export async function runReadonlyQrexecService({ input = process.stdin, output = process.stdout, error = process.stderr, env = process.env, handler = handleReadonlyProbeEnvelope } = {}) {
  try {
    const maxInputBytes = positiveInt(env.DIG_QREXEC_PROBE_MAX_INPUT_BYTES, 'DIG_QREXEC_PROBE_MAX_INPUT_BYTES', DEFAULT_MAX_INPUT_BYTES);
    const maxOutputBytes = positiveInt(env.DIG_QREXEC_PROBE_MAX_OUTPUT_BYTES, 'DIG_QREXEC_PROBE_MAX_OUTPUT_BYTES', DEFAULT_MAX_OUTPUT_BYTES);
    const config = loadReadonlyProbeConfig(env);
    const envelope = await readProbeEnvelope(input, { maxInputBytes });
    const response = await handler(envelope, config);
    output.write(encodeProbeResponse(response, { maxOutputBytes }));
    return 0;
  } catch {
    error.write('DIG_QREXEC_PROBE_REJECTED\n');
    return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runReadonlyQrexecService();
}
