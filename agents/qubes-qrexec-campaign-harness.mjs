import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';

function assertString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} must be a non-empty string`);
  return value.trim();
}

function assertRunId(value, name = 'runId') {
  const runId = assertString(value, name);
  if (runId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error(`${name} must be 1-128 characters using letters, digits, dot, underscore, or hyphen`);
  return runId;
}

function assertResponse(value, name = 'response') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') throw new Error(`${name} must be a coordinator response object`);
  return value;
}

function countRunTokens(value) {
  if (typeof value === 'string') return value.split('{{RUN_ID}}').length - 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countRunTokens(item), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce((sum, item) => sum + countRunTokens(item), 0);
  return 0;
}

function replaceRunTokens(value, runId) {
  if (typeof value === 'string') return value.replaceAll('{{RUN_ID}}', runId);
  if (Array.isArray(value)) return value.map(item => replaceRunTokens(item, runId));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRunTokens(item, runId)]));
  return value;
}

export function materializeQrexecCampaignSteps({ steps, runId, requireRunToken = false } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) throw new TypeError('steps must be a non-empty array');
  const normalizedRunId = assertRunId(runId);
  const tokenCount = countRunTokens(steps);
  if (requireRunToken && tokenCount === 0) throw new Error('campaign must contain at least one {{RUN_ID}} token');
  return replaceRunTokens(steps, normalizedRunId);
}

function resolveRef(value, captures, name = 'value') {
  if (Array.isArray(value)) return value.map((item, index) => resolveRef(item, captures, `${name}[${index}]`));
  if (!value || typeof value !== 'object') return value;
  if (Object.keys(value).length === 1 && typeof value.$ref === 'string') {
    const [captureName, ...path] = value.$ref.split('.');
    let current = captures.get(captureName);
    if (current === undefined) throw new Error(`${name} references unknown capture: ${captureName}`);
    for (const segment of path) {
      if (current == null || typeof current !== 'object' || !(segment in current)) throw new Error(`${name} references missing path: ${value.$ref}`);
      current = current[segment];
    }
    return structuredClone(current);
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveRef(item, captures, `${name}.${key}`)]));
}

export function createQrexecProcessTransport({ target, service, qrexecBin = 'qrexec-client-vm', env = process.env, now = () => Date.now() } = {}) {
  target = assertString(target, 'target');
  service = assertString(service, 'service');
  qrexecBin = assertString(qrexecBin, 'qrexecBin');
  return async function invoke(envelope, { service: serviceOverride = service } = {}) {
    const selectedService = assertString(serviceOverride, 'service');
    const startedAt = now();
    const child = spawn(qrexecBin, [target, selectedService], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdin.on('error', () => {});
    child.stdin.end(`${JSON.stringify(envelope)}\n`);
    const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
    const durationMs = Math.max(0, now() - startedAt);
    const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (exit.code !== 0 || lines.length !== 1) {
      const detail = stderr.trim() || `exit=${exit.code} signal=${exit.signal ?? 'none'} responses=${lines.length}`;
      const error = new Error(`qrexec transport failed: ${detail}`); error.durationMs = durationMs; throw error;
    }
    let response;
    try { response = JSON.parse(lines[0]); } catch (error) { throw new Error(`qrexec transport returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
    return { response: assertResponse(response), durationMs };
  };
}

export async function runQrexecCampaignSteps({ steps, invoke, secret, issuedAt = () => Date.now(), sleepFn = sleep } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) throw new TypeError('steps must be a non-empty array');
  if (typeof invoke !== 'function') throw new TypeError('invoke must be a function');
  if (typeof sleepFn !== 'function') throw new TypeError('sleepFn must be a function');
  const events = [];
  const captures = new Map();
  const send = async (step, service) => {
    const body = resolveRef(step.body ?? null, captures, 'step.body');
    return invoke(signWorkerEnvelope({ requestId: assertString(step.requestId, 'step.requestId'), issuedAt: issuedAt(), op: assertString(step.op, 'step.op'), body, secret }), { service });
  };
  for (const [index, rawStep] of steps.entries()) {
    if (!rawStep || typeof rawStep !== 'object' || Array.isArray(rawStep)) throw new TypeError(`step[${index}] must be an object`);
    const step = rawStep; const mode = step.mode ?? 'request';
    if (mode === 'wait') {
      const durationMs = Number(step.durationMs);
      if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 120_000) throw new Error(`step[${index}].durationMs must be between 0 and 120000`);
      await sleepFn(durationMs);
      events.push({ type: 'wait', durationMs });
      continue;
    }
    const requestId = assertString(step.requestId, `step[${index}].requestId`);
    events.push({ type: 'request_pending', requestId });
    if (mode === 'crash_retry') {
      let firstFailed = false;
      try { await send(step, assertString(step.faultService, `step[${index}].faultService`)); } catch { firstFailed = true; }
      if (!firstFailed) throw new Error(`step[${index}] expected the fault service to terminate without a committed response`);
      const recovered = await send(step, assertString(step.recoveryService, `step[${index}].recoveryService`));
      assertResponse(recovered.response, `step[${index}] recovery response`);
      if (!recovered.response.ok) throw new Error(`step[${index}] recovery failed: ${recovered.response.error ?? 'unknown error'}`);
      if (step.saveAs) captures.set(assertString(step.saveAs, `step[${index}].saveAs`), structuredClone(recovered.response));
      events.push({ type: 'recovery', durationMs: recovered.durationMs }, { type: 'round_trip', durationMs: recovered.durationMs }, { type: 'request_resolved', requestId });
      if (step.mutationKey) events.push({ type: 'mutation_committed', mutationKey: assertString(step.mutationKey, `step[${index}].mutationKey`) });
      continue;
    }
    const outcome = await send(step, step.service); const response = assertResponse(outcome.response, `step[${index}] response`);
    if (step.saveAs) captures.set(assertString(step.saveAs, `step[${index}].saveAs`), structuredClone(response));
    events.push({ type: 'round_trip', durationMs: outcome.durationMs });
    if (mode === 'stale_probe') {
      events.push({ type: 'stale_completion_probe', rejected: !response.ok });
      if (response.ok) events.push({ type: 'stale_completion' });
      events.push({ type: 'request_resolved', requestId });
      continue;
    }
    if (mode === 'qa_barrier_probe') {
      if (!response.ok) throw new Error(`step[${index}] QA barrier probe failed: ${response.error ?? 'unknown error'}`);
      events.push({ type: 'qa_barrier_probe', blocked: response.result == null });
      events.push({ type: 'request_resolved', requestId });
      continue;
    }
    if (mode === 'qa_post_join_probe') {
      if (!response.ok) throw new Error(`step[${index}] QA post-join probe failed: ${response.error ?? 'unknown error'}`);
      if (response.result == null) throw new Error(`step[${index}] expected QA mission after dependency join`);
      if (step.saveAs) captures.set(assertString(step.saveAs, `step[${index}].saveAs`), structuredClone(response));
      events.push({ type: 'qa_started', pendingDependencies: 0 }, { type: 'qa_post_join_start' }, { type: 'request_resolved', requestId });
      continue;
    }
    if (mode !== 'request') throw new Error(`unsupported campaign step mode: ${mode}`);
    const expectError = step.expectError === true;
    if (expectError ? response.ok : !response.ok) throw new Error(`step[${index}] unexpected coordinator response: ${JSON.stringify(response)}`);
    events.push({ type: 'request_resolved', requestId });
    if (!expectError && step.mutationKey) events.push({ type: 'mutation_committed', mutationKey: assertString(step.mutationKey, `step[${index}].mutationKey`) });
    if (!expectError && step.fencingCurrentCompletion === true) events.push({ type: 'current_lease_completion' });
  }
  return events;
}

async function readStdin() { let input = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) input += chunk; return input; }

async function main() {
  const target = assertString(process.env.DIG_QREXEC_TARGET, 'DIG_QREXEC_TARGET');
  const sourceQube = assertString(process.env.DIG_QREXEC_SOURCE, 'DIG_QREXEC_SOURCE');
  const service = assertString(process.env.DIG_QREXEC_SERVICE, 'DIG_QREXEC_SERVICE');
  const gitSha = assertString(process.env.DIG_GIT_SHA, 'DIG_GIT_SHA');
  if (!/^[0-9a-f]{40}$/i.test(gitSha)) throw new Error('DIG_GIT_SHA must be a 40-character hex SHA');
  if (sourceQube === target) throw new Error('DIG_QREXEC_SOURCE and DIG_QREXEC_TARGET must differ');
  const secret = process.env.DIG_TRANSPORT_SECRET;
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) throw new Error('DIG_TRANSPORT_SECRET must be at least 32 bytes');
  const parsed = JSON.parse(await readStdin());
  const rawSteps = Array.isArray(parsed) ? parsed : parsed.steps;
  const runId = assertRunId(process.env.DIG_CAMPAIGN_RUN_ID || randomUUID(), 'DIG_CAMPAIGN_RUN_ID');
  const steps = materializeQrexecCampaignSteps({ steps: rawSteps, runId });
  const startedAt = new Date().toISOString();
  const invoke = createQrexecProcessTransport({ target, service, qrexecBin: process.env.DIG_QREXEC_BIN || 'qrexec-client-vm' });
  const events = await runQrexecCampaignSteps({ steps, invoke, secret });
  process.stdout.write(`${JSON.stringify({ type: 'campaign_start', runId, transport: 'qrexec', sourceQube, targetQube: target, service, gitSha, startedAt })}\n`);
  for (const event of events) process.stdout.write(`${JSON.stringify(event)}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'campaign_end', runId, finishedAt: new Date().toISOString() })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => { process.stderr.write(`DIG Qubes qrexec campaign harness failed: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
}