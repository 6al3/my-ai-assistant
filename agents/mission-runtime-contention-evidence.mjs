import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { runMissionRuntimeContentionCampaign } from './mission-runtime-contention-campaign.mjs';
import { evaluateContentionStability } from './mission-runtime-contention-stability.mjs';

const execFileAsync = promisify(execFile);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}

export function computeContentionEvidenceDigest(evidence) {
  return createHash('sha256').update(JSON.stringify(canonicalize(evidence))).digest('hex');
}

export function verifyContentionEvidenceDigest(report) {
  if (!report || typeof report !== 'object' || !/^[0-9a-f]{64}$/.test(report.evidenceDigest ?? '')) return false;
  const { evidenceDigest, ...evidence } = report;
  return computeContentionEvidenceDigest(evidence) === evidenceDigest;
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
  if (typeof runtime.platform !== 'string' || !runtime.platform) throw new Error('runtime fingerprint requires platform');
  if (typeof runtime.arch !== 'string' || !runtime.arch) throw new Error('runtime fingerprint requires arch');
  if (typeof runtime.cpuModel !== 'string' || !runtime.cpuModel.trim()) throw new Error('runtime fingerprint requires cpuModel');
  if (!Number.isInteger(runtime.logicalCpus) || runtime.logicalCpus < 1) throw new Error('runtime fingerprint requires logicalCpus');
  if (!Number.isInteger(runtime.totalMemoryMiB) || runtime.totalMemoryMiB < 128) throw new Error('runtime fingerprint requires totalMemoryMiB >= 128');
}

async function defaultGitRead(commandArgs, cwd) {
  const { stdout } = await execFileAsync('git', commandArgs, { cwd, encoding: 'utf8', timeout: 30_000 });
  return stdout.trim();
}

export async function qualifyMissionRuntimeContention({
  cwd = process.cwd(), expectedSha = null, runCount = 3, maxRelativeP95Spread = 0.25,
  campaignOptions = {}, campaign = runMissionRuntimeContentionCampaign,
  gitRead = defaultGitRead, runtimeFingerprint = defaultRuntimeFingerprint,
  now = () => Date.now(), runIdFactory = randomUUID
} = {}) {
  if (!Number.isInteger(runCount) || runCount < 3 || runCount > 10) throw new Error('runCount must be an integer between 3 and 10');
  if (!Number.isFinite(maxRelativeP95Spread) || maxRelativeP95Spread < 0 || maxRelativeP95Spread > 1) throw new Error('maxRelativeP95Spread must be between 0 and 1');

  const sha = await gitRead(['rev-parse', 'HEAD'], cwd);
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('unable to resolve exact git SHA');
  if (expectedSha && sha !== expectedSha) throw new Error(`git SHA mismatch: expected ${expectedSha}, got ${sha}`);
  if (await gitRead(['status', '--porcelain'], cwd)) throw new Error('contention qualification requires a clean worktree');

  const runtime = runtimeFingerprint();
  validateRuntimeFingerprint(runtime);
  const startedAt = now();
  const runs = [];
  for (let index = 0; index < runCount; index += 1) {
    const campaignRunId = runIdFactory();
    if (typeof campaignRunId !== 'string' || campaignRunId.length < 8) throw new Error('campaign run ID is invalid');
    runs.push(await campaign({ ...campaignOptions, runId: campaignRunId }));
  }
  if (new Set(runs.map(run => run.runId)).size !== runs.length) throw new Error('contention qualification requires unique campaign run IDs');

  const evaluations = runs.map(run => run.evaluation);
  const stability = evaluateContentionStability(evaluations, { minimumRuns: runCount, maxRelativeP95Spread });
  const correctnessReady = runs.every(run => {
    const minimumSamples = run.evaluation?.budgets?.minimumSamplesPerPath;
    return run.correctness?.lostMissions === 0
      && run.correctness?.lostRequests === 0
      && run.correctness?.uncommittedResponses === 0
      && run.correctness?.doubleClaims === 0
      && run.evidence?.qualifiedJournalPhase === 'commit'
      && run.evidence?.qualifiedWorkerPhase === 'terminalRenewal'
      && run.evidence?.terminalRenewalSource === 'worker-runtime'
      && Number.isInteger(run.evidence?.terminalRenewalCount)
      && Number.isInteger(minimumSamples)
      && run.evidence.terminalRenewalCount >= minimumSamples;
  });
  const ready = correctnessReady && stability.ready;
  const generatedAtMs = now();
  const qualificationRunId = runIdFactory();
  if (typeof qualificationRunId !== 'string' || qualificationRunId.length < 8) throw new Error('qualification run ID is invalid');
  const evidence = {
    schemaVersion: 3,
    qualificationRunId,
    generatedAt: new Date(generatedAtMs).toISOString(),
    gitSha: sha,
    cleanWorktree: true,
    runtime,
    durationMs: Math.max(0, generatedAtMs - startedAt),
    runCount,
    runs,
    stability,
    correctnessReady,
    readiness: ready ? 'LAB READY' : 'NOT READY'
  };
  return { ...evidence, evidenceDigest: computeContentionEvidenceDigest(evidence) };
}

async function main() {
  const expectedSha = process.env.DIG_GIT_SHA || null;
  const report = await qualifyMissionRuntimeContention({ expectedSha });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.readiness !== 'LAB READY') process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
