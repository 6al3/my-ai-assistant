import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import os from 'node:os';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_DIAGNOSTIC_TAIL_BYTES = 4096;

export const QA_SHARDS = Object.freeze([
  { name: 'syntax-check', command: ['npm', ['run', 'check']] },
  { name: 'queue-core', command: ['node', ['--test', 'box/project-files.test.mjs', 'api/missions-core.test.mjs', 'agents/mission-queue.test.mjs', 'agents/mission-queue-store.test.mjs', 'agents/mission-coordinator.test.mjs']] },
  { name: 'worker-reliability', command: ['node', ['--test', 'agents/worker-runtime.test.mjs', 'agents/worker-transport-envelope.test.mjs', 'agents/durable-request-journal.test.mjs', 'agents/worker-lease-fencing.test.mjs', 'agents/orchestrated-mission-runtime.test.mjs']] },
  { name: 'distributed-faults', command: ['node', ['--test', 'agents/orchestration-benchmark.test.mjs', 'agents/orchestration-resource-profile.test.mjs', 'agents/qubes-resource-calibration.test.mjs', 'agents/qubes-calibrated-topology-selection.test.mjs', 'agents/qubes-calibration-selection-command.test.mjs', 'agents/qubes-resource-probe-service.test.mjs', 'agents/qubes-resource-calibration-harness.test.mjs', 'agents/qubes-orchestration-calibration-workload.test.mjs', 'agents/qubes-synthetic-workload-service.test.mjs', 'agents/qubes-resource-calibration-integration.test.mjs', 'agents/qubes-duration-bound-calibration.test.mjs', 'agents/qubes-duration-bound-calibration-cli.test.mjs', 'agents/qubes-calibration-cli-authority.test.mjs', 'agents/orchestration-process-fault.test.mjs', 'agents/orchestration-authenticated-recovery.test.mjs', 'agents/qrexec-response-attestation.test.mjs', 'agents/qubes-qrexec-coordinator-service.test.mjs', 'agents/qrexec-fault-readonly-preflight.test.mjs', 'agents/qubes-qrexec-readiness-gate.test.mjs', 'agents/qubes-qrexec-campaign-collector.test.mjs', 'agents/qubes-qrexec-campaign-harness.test.mjs', 'agents/qubes-qrexec-qa-join-evidence.test.mjs', 'agents/qubes-real-worker-evidence-gate.test.mjs', 'agents/qubes-multi-run-qualification.test.mjs', 'agents/qubes-attested-multi-run-qualification.test.mjs', 'agents/qubes-idempotency-independence.test.mjs', 'agents/qubes-qrexec-qualification-preflight.test.mjs', 'agents/qubes-calibration-provenance-binding.test.mjs', 'agents/qubes-qrexec-qualification-runner.test.mjs']] },
  { name: 'synthetic-sandboxes', command: ['node', ['--test', 'agents/node-qa-parity.test.mjs', 'agents/benchmark-arena.test.mjs', 'agents/payment-sandbox.test.mjs', 'agents/collaboration-sandbox.test.mjs', 'ios/DIGAssistant/mission-control-plane-contract.test.mjs']] }
]);

function runProcess(file, args, { timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise(resolve => {
    const startedAt = Date.now();
    const child = spawn(file, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ exitCode: null, signal: null, timedOut, durationMs: Date.now() - startedAt, stdout, stderr: `${stderr}${error.stack ?? error.message}` });
    });
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({ exitCode, signal, timedOut, durationMs: Date.now() - startedAt, stdout, stderr });
    });
  });
}

async function gitEvidence() {
  const sha = await runProcess('git', ['rev-parse', 'HEAD'], { timeoutMs: 5000 });
  if (sha.exitCode !== 0) throw new Error('unable to resolve git HEAD');
  const status = await runProcess('git', ['status', '--porcelain'], { timeoutMs: 5000 });
  if (status.exitCode !== 0) throw new Error('unable to inspect git status');
  return { sha: sha.stdout.trim(), clean: status.stdout.trim() === '' };
}

function sha256(text) { return createHash('sha256').update(text).digest('hex'); }

function redactDiagnostic(text) {
  return text
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/\b(authorization|api[_-]?key|token|secret|password)\s*[:=]\s*([^\s]+)/gi, '$1=[REDACTED]');
}

function outputEvidence(text, { includeTail = false, tailBytes = DEFAULT_DIAGNOSTIC_TAIL_BYTES } = {}) {
  const value = String(text ?? '');
  const bytes = Buffer.byteLength(value);
  const evidence = { bytes, sha256: sha256(value) };
  if (!includeTail || bytes === 0) return evidence;
  const buffer = Buffer.from(value);
  const tail = buffer.subarray(Math.max(0, buffer.length - tailBytes)).toString('utf8');
  return { ...evidence, diagnosticTail: redactDiagnostic(tail), diagnosticTailTruncated: buffer.length > tailBytes };
}

function digestReport(report) { return sha256(JSON.stringify(report)); }

export async function runLocalQaEvidence({ shards = QA_SHARDS, timeoutMs = DEFAULT_TIMEOUT_MS, run = runProcess, git = gitEvidence } = {}) {
  const startedAt = new Date().toISOString();
  const repository = await git();
  const expectedSha = process.env.DIG_GIT_SHA?.trim() || repository.sha;
  if (expectedSha !== repository.sha) throw new Error(`DIG_GIT_SHA mismatch: expected ${expectedSha}, got ${repository.sha}`);
  if (!repository.clean) throw new Error('local QA evidence requires a clean git worktree');
  const results = [];
  for (const shard of shards) {
    const [file, args] = shard.command;
    const outcome = await run(file, args, { timeoutMs });
    const passed = outcome.exitCode === 0 && !outcome.timedOut;
    results.push({ name: shard.name, exitCode: outcome.exitCode, signal: outcome.signal, timedOut: outcome.timedOut, durationMs: outcome.durationMs, passed, stdout: outputEvidence(outcome.stdout, { includeTail: !passed }), stderr: outputEvidence(outcome.stderr, { includeTail: !passed }) });
  }
  const report = { schemaVersion: 2, kind: 'dig-local-qa-evidence', gitSha: repository.sha, startedAt, finishedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, arch: process.arch, hostname: os.hostname() }, source: 'local-runner', outputPolicy: { fullOutputStored: false, failedDiagnosticTailBytes: DEFAULT_DIAGNOSTIC_TAIL_BYTES, redactionApplied: true }, allPassed: results.every(result => result.passed), results };
  return { ...report, digestSha256: digestReport(report) };
}

async function main() {
  const outputPath = process.env.DIG_QA_REPORT_PATH?.trim() || null;
  const report = await runLocalQaEvidence();
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) await writeFile(outputPath, json, { encoding: 'utf8', mode: 0o600 });
  process.stdout.write(json);
  if (!report.allPassed) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => { console.error(error?.stack ?? error); process.exitCode = 1; });
}
