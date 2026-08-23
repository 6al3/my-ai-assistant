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
  const values = [];
  for (const run of runs) {
    const row = Array.isArray(run) ? run.find(item => item.queueSize === queueSize) : null;
    const value = row?.[operation]?.p95Ms;
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

export function compareMissionRuntimeEvidence(reports, {
  expectedSha = null,
  requireSameRuntime = true,
  maxCrossReportRelativeP95Spread = 0.25,
  requireLabReady = true
} = {}) {
  if (!Array.isArray(reports) || reports.length < 2) {
    throw new Error('at least two mission runtime evidence reports are required');
  }
  if (!Number.isFinite(maxCrossReportRelativeP95Spread) || maxCrossReportRelativeP95Spread < 0 || maxCrossReportRelativeP95Spread > 1) {
    throw new Error('maxCrossReportRelativeP95Spread must be between 0 and 1');
  }

  reports.forEach((report, index) => {
    assertObject(report, `report ${index} must be an object`);
    if (!verifyMissionRuntimeEvidenceDigest(report)) throw new Error(`report ${index} evidence digest is invalid`);
    if (!/^[0-9a-f]{40}$/.test(report.gitSha ?? '')) throw new Error(`report ${index} gitSha is invalid`);
    if (expectedSha && report.gitSha !== expectedSha) throw new Error(`report ${index} git SHA mismatch`);
    if (report.cleanWorktree !== true) throw new Error(`report ${index} was not produced from a clean worktree`);
    if (requireLabReady && report.readiness !== 'LAB READY') throw new Error(`report ${index} is not LAB READY`);
  });

  const gitShas = new Set(reports.map(report => report.gitSha));
  if (gitShas.size !== 1) throw new Error('mission runtime evidence reports must use the same git SHA');

  const runtimeKeys = reports.map(report => runtimeKey(report.runtime));
  if (requireSameRuntime && new Set(runtimeKeys).size !== 1) {
    throw new Error('mission runtime evidence reports must use the same runtime fingerprint');
  }

  const queueSizes = reports[0]?.benchmark?.queueSizes;
  if (!Array.isArray(queueSizes) || queueSizes.length === 0 || queueSizes.some(size => !Number.isInteger(size) || size < 1)) {
    throw new Error('benchmark queueSizes are required');
  }
  for (const report of reports.slice(1)) {
    if (JSON.stringify(report?.benchmark?.queueSizes) !== JSON.stringify(queueSizes)) {
      throw new Error('mission runtime evidence reports must use identical queueSizes');
    }
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

  return {
    schemaVersion: 1,
    gitSha: reports[0].gitSha,
    reportCount: reports.length,
    runtimeComparable: new Set(runtimeKeys).size === 1,
    maxCrossReportRelativeP95Spread,
    comparisons,
    ready,
    readiness: ready ? 'LAB READY' : 'NOT READY'
  };
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
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
