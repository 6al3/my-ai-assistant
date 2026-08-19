import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { runProcessCoordinator } from './orchestration-process-coordinator.mjs';
import { attestCoordinatorResponse, loadResponseAttestationConfig } from './qrexec-response-attestation.mjs';

export function loadQrexecCoordinatorConfig(env = process.env) {
  const storePath = env.DIG_ORCHESTRATION_STORE?.trim();
  const requestJournalPath = env.DIG_REQUEST_JOURNAL?.trim();
  const transportSecret = env.DIG_TRANSPORT_SECRET;

  if (!storePath) throw new Error('DIG_ORCHESTRATION_STORE is required');
  if (!requestJournalPath) throw new Error('DIG_REQUEST_JOURNAL is required');
  if (!transportSecret || Buffer.byteLength(transportSecret, 'utf8') < 32) {
    throw new Error('DIG_TRANSPORT_SECRET must be at least 32 bytes');
  }

  const crashAfterCommitRaw = env.DIG_CRASH_AFTER_COMMIT?.trim();
  if (crashAfterCommitRaw && !['0', '1'].includes(crashAfterCommitRaw)) throw new Error('DIG_CRASH_AFTER_COMMIT must be 0 or 1');

  return {
    storePath,
    requestJournalPath,
    transportSecret,
    crashAfterRequestId: env.DIG_CRASH_AFTER_REQUEST_ID?.trim() || null,
    crashAfterAnyAuthenticatedCommit: crashAfterCommitRaw === '1',
    preserveRunningLeasesOnRestore: true,
    responseAttestation: loadResponseAttestationConfig(env)
  };
}

async function readSingleQrexecEnvelope(input) {
  let raw = '';
  input.setEncoding?.('utf8');
  for await (const chunk of input) raw += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  const lines = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) throw new Error('qrexec coordinator service requires exactly one request envelope per process');
  let envelope;
  try { envelope = JSON.parse(lines[0]); } catch (error) { throw new Error(`qrexec request must be valid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new Error('qrexec request must be an envelope object');
  if (typeof envelope.requestId !== 'string' || envelope.requestId.trim() === '') throw new Error('qrexec requestId is required');
  return { line: `${lines[0]}\n`, requestId: envelope.requestId.trim() };
}

export function createAttestedResponseOutput({ output, responseAttestation, requestId = null } = {}) {
  if (!output || typeof output.write !== 'function') throw new TypeError('output.write is required');
  if (!responseAttestation) return output;
  if (typeof requestId !== 'string' || requestId.trim() === '') throw new Error('requestId is required for attested qrexec responses');
  const boundRequestId = requestId.trim();
  let pending = '';
  return {
    write(chunk) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      let newlineIndex;
      while ((newlineIndex = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newlineIndex);
        pending = pending.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        const response = JSON.parse(line);
        output.write(`${JSON.stringify(attestCoordinatorResponse(response, responseAttestation, { requestId: boundRequestId }))}\n`);
      }
      return true;
    }
  };
}

export async function runQrexecCoordinatorService({ env = process.env, input = process.stdin, output = process.stdout } = {}) {
  const config = loadQrexecCoordinatorConfig(env);
  const { responseAttestation, ...coordinatorConfig } = config;
  const request = await readSingleQrexecEnvelope(input);
  const coordinatorOutput = createAttestedResponseOutput({ output, responseAttestation, requestId: request.requestId });
  return runProcessCoordinator({ ...coordinatorConfig, input: Readable.from([request.line]), output: coordinatorOutput });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runQrexecCoordinatorService().catch(error => {
    process.stderr.write(`DIG qrexec coordinator service failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
