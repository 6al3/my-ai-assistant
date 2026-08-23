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

export async function qualifyMissionRuntime({
  cwd = process.cwd(),
  expectedSha = null,
  samples = 15,
  queueSizes = [1000, 5000],
  runner = run,
  benchmark = benchmarkCoordinatorFailurePath
} = {}) {
  const sha = (await runner('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('unable to resolve exact git SHA');
  if (expectedSha && sha !== expectedSha) throw new Error(`git SHA mismatch: expected ${expectedSha}, got ${sha}`);

  const status = (await runner('git', ['status', '--porcelain'], { cwd })).stdout.trim();
  if (status) throw new Error('mission runtime qualification requires a clean worktree');

  const testStartedAt = Date.now();
  await runner('npm', ['run', 'test:mission-runtime'], { cwd, timeoutMs: 15 * 60 * 1000 });
  const testDurationMs = Date.now() - testStartedAt;

  const benchmarkStartedAt = Date.now();
  const benchmarkResults = await benchmark({ queueSizes, samples });
  const benchmarkDurationMs = Date.now() - benchmarkStartedAt;
  const evaluation = evaluateCoordinatorFailurePathBudget(benchmarkResults);

  return {
    schemaVersion: 1,
    gitSha: sha,
    cleanWorktree: true,
    tests: { command: 'npm run test:mission-runtime', passed: true, durationMs: testDurationMs },
    benchmark: { queueSizes, samples, durationMs: benchmarkDurationMs, results: benchmarkResults, evaluation },
    readiness: evaluation.ready ? 'LAB READY' : 'NOT READY'
  };
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
