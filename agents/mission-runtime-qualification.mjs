import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { benchmarkCoordinatorFailurePath, evaluateCoordinatorFailurePathBudget } from './mission-coordinator-failure-path-benchmark.mjs';

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
  return {
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch
  };
}

export async function qualifyMissionRuntime({
  cwd = process.cwd(),
  expectedSha = null,
  samples = 15,
  queueSizes = [1000, 5000],
  runner = run,
  benchmark = benchmarkCoordinatorFailurePath,
  runtimeFingerprint = defaultRuntimeFingerprint
} = {}) {
  const sha = (await runner('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('unable to resolve exact git SHA');
  if (expectedSha && sha !== expectedSha) throw new Error(`git SHA mismatch: expected ${expectedSha}, got ${sha}`);

  const status = (await runner('git', ['status', '--porcelain'], { cwd })).stdout.trim();
  if (status) throw new Error('mission runtime qualification requires a clean worktree');

  const runtime = runtimeFingerprint();
  if (!runtime || typeof runtime !== 'object') throw new Error('runtime fingerprint is required');
  if (typeof runtime.nodeVersion !== 'string' || !runtime.nodeVersion.startsWith('v')) throw new Error('runtime fingerprint requires nodeVersion');
  if (typeof runtime.platform !== 'string' || runtime.platform.length === 0) throw new Error('runtime fingerprint requires platform');
  if (typeof runtime.arch !== 'string' || runtime.arch.length === 0) throw new Error('runtime fingerprint requires arch');

  const testStartedAt = Date.now();
  await runner('npm', ['run', 'test:mission-runtime'], { cwd, timeoutMs: 15 * 60 * 1000 });
  const testDurationMs = Date.now() - testStartedAt;

  const benchmarkStartedAt = Date.now();
  const benchmarkResults = await benchmark({ queueSizes, samples });
  const benchmarkDurationMs = Date.now() - benchmarkStartedAt;
  const evaluation = evaluateCoordinatorFailurePathBudget(benchmarkResults);

  const evidence = {
    schemaVersion: 2,
    gitSha: sha,
    cleanWorktree: true,
    runtime,
    tests: { command: 'npm run test:mission-runtime', passed: true, durationMs: testDurationMs },
    benchmark: { queueSizes, samples, durationMs: benchmarkDurationMs, results: benchmarkResults, evaluation },
    readiness: evaluation.ready ? 'LAB READY' : 'NOT READY'
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
