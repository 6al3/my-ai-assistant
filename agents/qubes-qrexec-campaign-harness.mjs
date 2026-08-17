import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function assertResponse(value, name = 'response') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') {
    throw new Error(`${name} must be a coordinator response object`);
  }
  return value;
}

export function createQrexecProcessTransport({ target, service, qrexecBin = 'qrexec-client-vm', env = process.env, now = () => Date.now() } = {}) {
  target = assertString(target, 'target');
  service = assertString(service, 'service');
  qrexecBin = assertString(qrexecBin, 'qrexecBin');

  return async function invoke(envelope, { service: serviceOverride = service } = {}) {
    const selectedService = assertString(serviceOverride, 'service');
    const startedAt = now();
    const child = spawn(qrexecBin, [target, selectedService], {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.end(`${JSON.stringify(envelope)}\n`);

    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const durationMs = Math.max(0, now() - startedAt);

    const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (exit.code !== 0 || lines.length !== 1) {
      const detail = stderr.trim() || `exit=${exit.code} signal=${exit.signal ?? 'none'} responses=${lines.length}`;
      const error = new Error(`qrexec transport failed: ${detail}`);
      error.durationMs = durationMs;
      throw error;
    }

    let response;
    try {
      response = JSON.parse(lines[0]);
    } catch (error) {
      throw new Error(`qrexec transport returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { response: assertResponse(response), durationMs };
  };
}

export async function runQrexecCampaignSteps({ steps, invoke, secret, issuedAt = () => Date.now() } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) throw new TypeError('steps must be a non-empty array');
  if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
  const events = [];

  const send = async (step, service) => {
    const requestId = assertString(step.requestId, 'step.requestId');
    const envelope = signWorkerEnvelope({
      requestId,
      issuedAt: issuedAt(),
      op: assertString(step.op, 'step.op'),
      body: step.body ?? null,
      secret
    });
    return invoke(envelope, { service });
  };

  for (const [index, rawStep] of steps.entries()) {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) throw new TypeError(`step[${index}] must be an object`);
    const step = rawStep;
    const mode = step.mode ?? 'request';
    const requestId = assertString(step.requestId, `step[${index}].requestId`);
    events.push({ type: 'request_pending', requestId });

    if (mode === 'crash_retry') {
      let firstFailed = false;
      try {
        await send(step, assertString(step.faultService, `step[${index}].faultService`));
      } catch {
        firstFailed = true;
      }
      if (!firstFailed) throw new Error(`step[${index}] expected the fault service to terminate without a committed response`);

      const recovered = await send(step, assertString(step.recoveryService, `step[${index}].recoveryService`));
      assertResponse(recovered.response, `step[${index}] recovery response`);
      if (!recovered.response.ok) throw new Error(`step[${index}] recovery failed: ${recovered.response.error ?? 'unknown error'}`);
      events.push({ type: 'recovery', durationMs: recovered.durationMs });
      events.push({ type: 'round_trip', durationMs: recovered.durationMs });
      events.push({ type: 'request_resolved', requestId });
      if (step.mutationKey) events.push({ type: 'mutation_committed', mutationKey: assertString(step.mutationKey, `step[${index}].mutationKey`) });
      continue;
    }

    const outcome = await send(step, step.service);
    const response = assertResponse(outcome.response, `step[${index}] response`);
    events.push({ type: 'round_trip', durationMs: outcome.durationMs });

    if (mode === 'stale_probe') {
      if (response.ok) events.push({ type: 'stale_completion' });
      events.push({ type: 'request_resolved', requestId });
      continue;
    }

    if (mode === 'qa_barrier_probe') {
      if (!response.ok) throw new Error(`step[${index}] QA barrier probe failed: ${response.error ?? 'unknown error'}`);
      events.push({ type: 'qa_started', pendingDependencies: response.result == null ? 0 : 1 });
      events.push({ type: 'request_resolved', requestId });
      continue;
    }

    if (mode !== 'request') throw new Error(`unsupported campaign step mode: ${mode}`);
    const expectError = step.expectError === true;
    if (expectError ? response.ok : !response.ok) {
      throw new Error(`step[${index}] unexpected coordinator response: ${JSON.stringify(response)}`);
    }
    events.push({ type: 'request_resolved', requestId });
    if (!expectError && step.mutationKey) events.push({ type: 'mutation_committed', mutationKey: assertString(step.mutationKey, `step[${index}].mutationKey`) });
  }

  return events;
}

async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

async function main() {
  const target = process.env.DIG_QREXEC_TARGET;
  const service = process.env.DIG_QREXEC_SERVICE;
  const secret = process.env.DIG_TRANSPORT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) throw new Error('DIG_TRANSPORT_SECRET must be at least 32 bytes');
  const parsed = JSON.parse(await readStdin());
  const steps = Array.isArray(parsed) ? parsed : parsed.steps;
  const invoke = createQrexecProcessTransport({ target, service, qrexecBin: process.env.DIG_QREXEC_BIN || 'qrexec-client-vm' });
  const events = await runQrexecCampaignSteps({ steps, invoke, secret });
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    process.stderr.write(`DIG Qubes qrexec campaign harness failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
