import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { benchmarkCoordinatorFailurePath, evaluateCoordinatorFailurePathBudget } from './mission-coordinator-failure-path-benchmark.mjs';
import { evaluateMissionRuntimeBenchmarkStability } from './mission-runtime-benchmark-stability.mjs';

const execFileAsync = promisify(execFile);

async function run(command, args, options = {}) {
  const { stdout = '', stderr = '' } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: options.timeoutMs ?? 10 * 60 * 1000,
    cwd: options.cwd
  });
  return { stdout, stderr };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

export function computeMissionRuntimeEvidenceDigest(evidence) {
  const canonical = JSON.stringify(canonicalize(evidence));
  return createHash('sha256').update(canonical).digest('hex');
}

export function verifyMissionRuntimeEvidenceDigest(report) {
  if (!report || typeof report !== 'object') return false;
  if (!/^[0-9a-f]{64}$/.test(report.evidenceDigest ?? '')) return false;
  const { evidenceDigest, ...evidence } = report;
  return computeMissionRuntimeEvidenceDigest(evidence) === evidenceDigest;
}

function defaultRuntimeFingerprint() {
  const cpus = os.cpus();
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model?.trim() || 'unknown',
    logicalCpus: cpus.length,
    totalMemoryMiB: Math.round(os.totalmem() / (1024 * 1024))
  };
}

function validateRuntimeFingerprint(runtime) {
  if (!runtime || typeof runtime !== 'object') throw new Error('runtime fingerprint is required');
  if (typeof runtime.nodeVersion !== 'string' || !runtime.nodeVersion.startsWith('v')) throw new Error('runtime fingerprint requires nodeVersion');
  if (typeof runtime.platform !== 'string' || runtime.platform.length === 0) throw new Error('runtime fingerprint requires platform');
  if (typeof runtime.arch !== 'string' || runtime.arch.length === 0) throw new Error('runtime fingerprint requires arch');
  if (typeof runtime.cpuModel !== 'string' || runtime.cpuModel.trim().length === 0) throw new Error('runtime fingerprint requires cpuModel');
  if (!Number.isInteger(runtime.logicalCpus) || runtime.logicalCpus < 1) throw new Error('runtime fingerprint requires positive logicalCpus');
  if (!Number.isInteger(runtime.totalMemoryMiB) || runtime.totalMemoryMiB < 128) throw new Error('runtime fingerprint requires totalMemoryMiB >= 128');
}

export async function qualifyMissionRuntime({
  cwd = process.cwd(),
  expectedSha = null,
  samples = 15,
  queueSizes = [1000, 5000],
  benchmarkRuns = 3,
  maxRelativeP95Spread = 0.25,
  runner = run,
  benchmark = benchmarkCoordinatorFailurePath,
  runtimeFingerprint = defaultRuntimeFingerprint,
  executionIdFactory = randomUUID,
  now = () => Date.now()
} = {}) {
  if (!Number.isInteger(benchmarkRuns) || benchmarkRuns < 2 || benchmarkRuns > 10) {
    throw new Error('benchmarkRuns must be an integer between 2 and 10');
  }
  const qualificationRunId = executionIdFactory();
  if (typeof qualificationRunId !== 'string' || !/^[0-9a-f-]{36}$/i.test(qualificationRunId)) {
    throw new Error('qualificationRunId must be a UUID-shaped identifier');
  }
  const generatedAtMs = now();
  if (!Number.isFinite(generatedAtMs) || generatedAtMs <= 0) throw new Error('qualification timestamp is invalid');

  const sha = (await runner('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('unable to resolve exact git SHA');
  if (expectedSha && sha !== expectedSha) throw new Error(`git SHA mismatch: expected ${expectedSha}, got ${sha}`);

  const status = (await runner('git', ['status', '--porcelain'], { cwd })).stdout.trim();
  if (status) throw new Error('mission runtime qualification requires a clean worktree');

  const runtime = runtimeFingerprint();
  validateRuntimeFingerprint(runtime);

  const testStartedAt = now();
  await runner('npm', ['run', 'test:mission-runtime'], { cwd, timeoutMs: 15 * 60 * 1000 });
  const testDurationMs = Math.max(0, now() - testStartedAt);

  const benchmarkStartedAt = now();
  const runs = [];
  const evaluations = [];
  for (let runIndex = 0; runIndex < benchmarkRuns; runIndex += 1) {
    const results = await benchmark({ queueSizes, samples });
    runs.push(results);
    evaluations.push(evaluateCoordinatorFailurePathBudget(results));
  }
  const benchmarkDurationMs = Math.max(0, now() - benchmarkStartedAt);
  const stability = evaluateMissionRuntimeBenchmarkStability(runs, { maxRelativeP95Spread });
  const budgetsReady = evaluations.every(evaluation => evaluation.ready);
  const ready = budgetsReady && stability.ready;

  const evidence = {
    schemaVersion: 5,
    qualificationRunId,
    generatedAt: new Date(generatedAtMs).toISOString(),
    gitSha: sha,
    cleanWorktree: true,
    runtime,
    tests: { command: 'npm run test:mission-runtime', passed: true, durationMs: testDurationMs },
    benchmark: {
      queueSizes,
      samples,
      runCount: benchmarkRuns,
      durationMs: benchmarkDurationMs,
      runs,
      evaluations,
      stability,
      budgetsReady,
      ready
    },
    readiness: ready ? 'LAB READY' : 'NOT READY'
  };

  return { ...evidence, evidenceDigest: computeMissionRuntimeEvidenceDigest(evidence) };
}

async function main() {
  const expectedSha = process.env.DIG_GIT_SHA || null;
  const report = await qualifyMissionRuntime({ expectedSha });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.readiness !== 'LAB READY') process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
