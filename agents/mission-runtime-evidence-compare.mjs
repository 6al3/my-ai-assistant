import fs from 'node:fs';
import { verifyMissionRuntimeEvidenceDigest } from './mission-runtime-qualification.mjs';

function assertObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
}

function runtimeKey(runtime) {
  assertObject(runtime, 'runtime fingerprint is required');
  const fields = ['nodeVersion', 'platform', 'arch', 'cpuModel', 'logicalCpus', 'totalMemoryMiB'];
  for (const field of fields) {
    if (runtime[field] === undefined || runtime[field] === null || runtime[field] === '') {
      throw new Error(`runtime fingerprint missing ${field}`);
    }
  }
  return JSON.stringify(fields.map(field => [field, runtime[field]]));
}

function extractP95(report, queueSize, operation) {
  const runs = report?.benchmark?.runs;
  if (!Array.isArray(runs) || runs.length < 1) throw new Error('benchmark runs are required');
  const field = operation === 'enqueue' ? 'failedEnqueue' : operation === 'claim' ? 'failedClaim' : null;
  if (!field) throw new Error(`unsupported benchmark operation: ${operation}`);
  const values = [];
  for (const run of runs) {
    const row = Array.isArray(run) ? run.find(item => item.queueSize === queueSize) : null;
    const value = row?.[field]?.p95Ms;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`missing p95 for queueSize=${queueSize} operation=${operation}`);
    }
    values.push(value);
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function relativeSpread(values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === 0) return 0;
  return (max - min) / max;
}

function validateExecutionIdentity(report, index, nowMs, maxReportAgeMs, maxFutureSkewMs) {
  if (report.schemaVersion !== 5) throw new Error(`report ${index} schemaVersion must be 5`);
  if (typeof report.qualificationRunId !== 'string' || !/^[0-9a-f-]{36}$/i.test(report.qualificationRunId)) {
    throw new Error(`report ${index} qualificationRunId is invalid`);
  }
  const generatedAtMs = Date.parse(report.generatedAt ?? '');
  if (!Number.isFinite(generatedAtMs)) throw new Error(`report ${index} generatedAt is invalid`);
  if (generatedAtMs > nowMs + maxFutureSkewMs) throw new Error(`report ${index} is future-dated`);
  if (nowMs - generatedAtMs > maxReportAgeMs) throw new Error(`report ${index} is too old`);
  return generatedAtMs;
}

export function compareMissionRuntimeEvidence(reports, {
  expectedSha = null,
  requireSameRuntime = true,
  maxCrossReportRelativeP95Spread = 0.25,
  requireLabReady = true,
  maxReportAgeMs = 24 * 60 * 60 * 1000,
  maxFutureSkewMs = 5 * 60 * 1000,
  now = () => Date.now()
} = {}) {
  if (!Array.isArray(reports) || reports.length < 2) throw new Error('at least two mission runtime evidence reports are required');
  if (!Number.isFinite(maxCrossReportRelativeP95Spread) || maxCrossReportRelativeP95Spread < 0 || maxCrossReportRelativeP95Spread > 1) throw new Error('maxCrossReportRelativeP95Spread must be between 0 and 1');
  if (!Number.isFinite(maxReportAgeMs) || maxReportAgeMs <= 0) throw new Error('maxReportAgeMs must be positive');
  if (!Number.isFinite(maxFutureSkewMs) || maxFutureSkewMs < 0) throw new Error('maxFutureSkewMs must be non-negative');
  const nowMs = now();
  if (!Number.isFinite(nowMs) || nowMs <= 0) throw new Error('comparison clock is invalid');

  const generatedAt = [];
  reports.forEach((report, index) => {
    assertObject(report, `report ${index} must be an object`);
    if (!verifyMissionRuntimeEvidenceDigest(report)) throw new Error(`report ${index} evidence digest is invalid`);
    generatedAt.push(validateExecutionIdentity(report, index, nowMs, maxReportAgeMs, maxFutureSkewMs));
    if (!/^[0-9a-f]{40}$/.test(report.gitSha ?? '')) throw new Error(`report ${index} gitSha is invalid`);
    if (expectedSha && report.gitSha !== expectedSha) throw new Error(`report ${index} git SHA mismatch`);
    if (report.cleanWorktree !== true) throw new Error(`report ${index} was not produced from a clean worktree`);
    if (requireLabReady && report.readiness !== 'LAB READY') throw new Error(`report ${index} is not LAB READY`);
  });

  const runIds = reports.map(report => report.qualificationRunId);
  if (new Set(runIds).size !== reports.length) throw new Error('mission runtime evidence reports must come from unique qualification runs');
  const digests = reports.map(report => report.evidenceDigest);
  if (new Set(digests).size !== reports.length) throw new Error('duplicate mission runtime evidence report detected');
  const gitShas = new Set(reports.map(report => report.gitSha));
  if (gitShas.size !== 1) throw new Error('mission runtime evidence reports must use the same git SHA');
  const runtimeKeys = reports.map(report => runtimeKey(report.runtime));
  if (requireSameRuntime && new Set(runtimeKeys).size !== 1) throw new Error('mission runtime evidence reports must use the same runtime fingerprint');

  const queueSizes = reports[0]?.benchmark?.queueSizes;
  if (!Array.isArray(queueSizes) || queueSizes.length === 0 || queueSizes.some(size => !Number.isInteger(size) || size < 1)) throw new Error('benchmark queueSizes are required');
  for (const report of reports.slice(1)) {
    if (JSON.stringify(report?.benchmark?.queueSizes) !== JSON.stringify(queueSizes)) throw new Error('mission runtime evidence reports must use identical queueSizes');
  }

  const operations = ['enqueue', 'claim'];
  const comparisons = [];
  let ready = true;
  for (const queueSize of queueSizes) {
    for (const operation of operations) {
      const averages = reports.map(report => extractP95(report, queueSize, operation));
      const spread = relativeSpread(averages);
      const withinBudget = spread <= maxCrossReportRelativeP95Spread;
      comparisons.push({ queueSize, operation, reportMeanP95Ms: averages, relativeSpread: spread, withinBudget });
      if (!withinBudget) ready = false;
    }
  }

  return { schemaVersion: 2, gitSha: reports[0].gitSha, reportCount: reports.length, qualificationRunIds: runIds, generatedAt, runtimeComparable: new Set(runtimeKeys).size === 1, maxCrossReportRelativeP95Spread, maxReportAgeMs, comparisons, ready, readiness: ready ? 'LAB READY' : 'NOT READY' };
}

function main() {
  const paths = process.argv.slice(2);
  if (paths.length < 2) throw new Error('usage: node agents/mission-runtime-evidence-compare.mjs <report1.json> <report2.json> [...]');
  const reports = paths.map(path => JSON.parse(fs.readFileSync(path, 'utf8')));
  const result = compareMissionRuntimeEvidence(reports, { expectedSha: process.env.DIG_GIT_SHA || null });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ready) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) { process.stderr.write(`${error?.stack || error}\n`); process.exitCode = 1; }
}
