import { pathToFileURL } from 'node:url';
import { runDurationBoundCalibrationCli } from './qubes-duration-bound-calibration-cli.mjs';
import { evaluateCalibratedQubesTopologies } from './qubes-calibrated-topology-selection.mjs';

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function positive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

export async function runQubesCalibrationSelectionCommand({
  gitSha,
  missions,
  durationsMs,
  candidates,
  calibrationConfigs,
  readiness = {},
  forbiddenCapabilityPairs = [],
  maxTopologies = 32,
  resourceBudget
}, {
  runCalibration = runDurationBoundCalibrationCli,
  evaluate = evaluateCalibratedQubesTopologies
} = {}) {
  const expectedGitSha = nonEmpty(gitSha, 'gitSha');
  if (!Array.isArray(missions) || missions.length === 0) throw new Error('missions are required');
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('candidate topologies are required');
  if (!Array.isArray(calibrationConfigs) || calibrationConfigs.length !== candidates.length) {
    throw new Error('one calibration config per candidate topology is required');
  }

  const candidateIds = new Set(candidates.map(candidate => nonEmpty(candidate?.id, 'candidate topology id')));
  if (candidateIds.size !== candidates.length) throw new Error('candidate topology ids must be unique');

  // Validate the full candidate/config bijection before starting any expensive Qubes workload.
  // This avoids partially calibrating the fleet and only discovering duplicate/missing configs later.
  const configIds = calibrationConfigs.map(config => nonEmpty(config?.topologyId, 'calibration topologyId'));
  const configIdSet = new Set(configIds);
  if (configIdSet.size !== configIds.length) throw new Error('calibration topology ids must be unique');
  for (const topologyId of configIdSet) {
    if (!candidateIds.has(topologyId)) throw new Error(`unexpected calibration topology ${topologyId}`);
  }
  for (const topologyId of candidateIds) {
    if (!configIdSet.has(topologyId)) throw new Error(`missing calibration topology ${topologyId}`);
  }
  for (const config of calibrationConfigs) {
    if (config.gitSha !== expectedGitSha) throw new Error(`calibration ${config.topologyId} git SHA mismatch`);
  }

  const calibrations = [];
  // Keep calibration sequential: concurrent synthetic workloads would contaminate RAM/CPU/latency evidence.
  for (const config of calibrationConfigs) {
    const topologyId = config.topologyId;
    const result = await runCalibration(config);
    if (!result?.report || result.report.topologyId !== topologyId || result.report.gitSha !== expectedGitSha) {
      throw new Error(`calibration ${topologyId} returned mismatched report provenance`);
    }
    calibrations.push(result.report);
  }

  const evaluation = evaluate(missions, durationsMs, candidates, calibrations, {
    expectedGitSha,
    readiness,
    forbiddenCapabilityPairs,
    maxTopologies: positive(maxTopologies, 'maxTopologies'),
    resourceBudget
  });
  if (!evaluation?.winner) throw new Error('no calibrated Qubes topology satisfied readiness and resource gates');

  return {
    schemaVersion: 1,
    gitSha: expectedGitSha,
    calibrationTopologyIds: calibrations.map(report => report.topologyId).sort(),
    winner: evaluation.winner,
    evaluation
  };
}

async function main() {
  const raw = process.env.DIG_QUBES_SELECTION_CONFIG;
  if (!raw) throw new Error('DIG_QUBES_SELECTION_CONFIG is required');
  const config = JSON.parse(raw);
  const result = await runQubesCalibrationSelectionCommand(config);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`DIG Qubes calibrated topology selection failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
