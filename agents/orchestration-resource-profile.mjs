import { evaluateFleetTopologies } from './orchestration-benchmark.mjs';

function positiveFinite(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive finite number`);
  return value;
}

function finiteNonNegative(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative finite number`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function normalizeBudget({ maxRamMb, maxVcpus, maxQubes, maxProbeLatencyP95Ms = null } = {}) {
  return {
    maxRamMb: positiveFinite(maxRamMb, 'maxRamMb'),
    maxVcpus: positiveFinite(maxVcpus, 'maxVcpus'),
    maxQubes: positiveInteger(maxQubes, 'maxQubes'),
    maxProbeLatencyP95Ms: maxProbeLatencyP95Ms == null ? null : positiveFinite(maxProbeLatencyP95Ms, 'maxProbeLatencyP95Ms')
  };
}

function topologyResourceProfile(topology, { requireProbeLatency = false } = {}) {
  const workers = Array.isArray(topology?.workers) ? topology.workers : [];
  let totalRamMb = 0;
  let totalVcpus = 0;
  let maxProbeLatencyP95Ms = 0;
  const workerResources = {};
  for (const worker of workers) {
    const ramMb = positiveFinite(worker?.resources?.ramMb, `worker ${worker?.id ?? '<unknown>'} ramMb`);
    const vcpus = positiveFinite(worker?.resources?.vcpus, `worker ${worker?.id ?? '<unknown>'} vcpus`);
    const probeLatencyP95Ms = worker?.resources?.probeLatencyP95Ms;
    if (requireProbeLatency && probeLatencyP95Ms == null) throw new Error(`worker ${worker?.id ?? '<unknown>'} probeLatencyP95Ms is required`);
    const normalizedProbeLatency = probeLatencyP95Ms == null ? null : finiteNonNegative(probeLatencyP95Ms, `worker ${worker?.id ?? '<unknown>'} probeLatencyP95Ms`);
    totalRamMb += ramMb;
    totalVcpus += vcpus;
    if (normalizedProbeLatency != null) maxProbeLatencyP95Ms = Math.max(maxProbeLatencyP95Ms, normalizedProbeLatency);
    workerResources[worker.id] = { ramMb, vcpus, ...(normalizedProbeLatency == null ? {} : { probeLatencyP95Ms: normalizedProbeLatency }) };
  }
  return { qubes: workers.length, totalRamMb, totalVcpus, maxProbeLatencyP95Ms: requireProbeLatency ? maxProbeLatencyP95Ms : null, workerResources };
}

export function evaluateResourceAwareFleetTopologies(missions, durationsMs = {}, topologies = [], {
  readiness = {},
  forbiddenCapabilityPairs = [],
  maxTopologies = 32,
  resourceBudget
} = {}) {
  const budget = normalizeBudget(resourceBudget);
  const base = evaluateFleetTopologies(missions, durationsMs, topologies, {
    readiness,
    forbiddenCapabilityPairs,
    maxTopologies
  });
  const byId = new Map(topologies.map(topology => [topology.id, topology]));
  const requireProbeLatency = budget.maxProbeLatencyP95Ms != null;

  const results = base.results.map(result => {
    const profile = topologyResourceProfile(byId.get(result.id), { requireProbeLatency });
    const resourceChecks = {
      ramBudget: profile.totalRamMb <= budget.maxRamMb,
      vcpuBudget: profile.totalVcpus <= budget.maxVcpus,
      qubeBudget: profile.qubes <= budget.maxQubes,
      probeLatencyBudget: !requireProbeLatency || profile.maxProbeLatencyP95Ms <= budget.maxProbeLatencyP95Ms
    };
    const resourcePass = Object.values(resourceChecks).every(Boolean);
    return {
      ...result,
      baseEligible: result.eligible,
      eligible: result.eligible && resourcePass,
      resources: profile,
      resourceGate: { pass: resourcePass, checks: resourceChecks, budget }
    };
  });

  const ranked = results
    .filter(result => result.eligible)
    .sort((a, b) =>
      a.resources.qubes - b.resources.qubes ||
      a.resources.totalRamMb - b.resources.totalRamMb ||
      a.resources.totalVcpus - b.resources.totalVcpus ||
      ((a.resources.maxProbeLatencyP95Ms ?? 0) - (b.resources.maxProbeLatencyP95Ms ?? 0)) ||
      a.metrics.constrainedLatencyMs - b.metrics.constrainedLatencyMs ||
      a.metrics.maxQueueDelayMs - b.metrics.maxQueueDelayMs ||
      a.id.localeCompare(b.id)
    );

  return {
    evaluated: results.length,
    eligible: ranked.length,
    resourceBudget: budget,
    winner: ranked[0] ?? null,
    ranking: ranked.map(result => result.id),
    results
  };
}
