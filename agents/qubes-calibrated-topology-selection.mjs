import { applyQubesResourceCalibration } from './qubes-resource-calibration.mjs';
import { evaluateResourceAwareFleetTopologies } from './orchestration-resource-profile.mjs';

function nonEmpty(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

export function evaluateCalibratedQubesTopologies(missions, durationsMs = {}, candidates = [], calibrations = [], {
  expectedGitSha,
  readiness = {},
  forbiddenCapabilityPairs = [],
  maxTopologies = 32,
  resourceBudget
} = {}) {
  const gitSha = nonEmpty(expectedGitSha, 'expectedGitSha');
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('candidate topologies are required');
  if (!Array.isArray(calibrations) || calibrations.length === 0) throw new Error('Qubes calibrations are required');

  const byTopology = new Map();
  for (const calibration of calibrations) {
    const topologyId = nonEmpty(calibration?.topologyId, 'calibration topologyId');
    if (calibration?.gitSha !== gitSha) throw new Error(`calibration ${topologyId} git SHA mismatch`);
    if (byTopology.has(topologyId)) throw new Error(`duplicate calibration for topology ${topologyId}`);
    byTopology.set(topologyId, calibration);
  }

  const calibrated = candidates.map(topology => {
    const calibration = byTopology.get(topology?.id);
    if (!calibration) throw new Error(`missing calibration for topology ${topology?.id ?? '<unknown>'}`);
    return applyQubesResourceCalibration(topology, calibration);
  });
  if (calibrated.length !== byTopology.size) throw new Error('calibrations contain unexpected topologies');

  const evaluation = evaluateResourceAwareFleetTopologies(missions, durationsMs, calibrated, {
    readiness,
    forbiddenCapabilityPairs,
    maxTopologies,
    resourceBudget
  });

  return {
    schemaVersion: 1,
    gitSha,
    calibratedTopologyIds: calibrated.map(topology => topology.id).sort(),
    ...evaluation
  };
}
