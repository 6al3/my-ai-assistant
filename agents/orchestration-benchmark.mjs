function validateDuration(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} duration must be a non-negative finite number`);
  return value;
}

export function benchmarkOrchestrationGraph(missions, durationsMs = {}) {
  if (!Array.isArray(missions) || missions.length === 0) throw new Error('missions are required');

  const byId = new Map();
  for (const mission of missions) {
    if (!mission?.id) throw new Error('every mission requires an id');
    if (byId.has(mission.id)) throw new Error(`duplicate mission id: ${mission.id}`);
    byId.set(mission.id, mission);
  }

  const durationById = new Map();
  for (const mission of missions) {
    const agentId = mission.metadata?.agentId;
    const configured = durationsMs[mission.id] ?? durationsMs[agentId];
    if (configured === undefined) throw new Error(`missing duration for mission ${mission.id}${agentId ? ` (${agentId})` : ''}`);
    durationById.set(mission.id, validateDuration(configured, agentId ?? mission.id));
  }

  const state = new Map();
  const timing = new Map();
  const visit = id => {
    if (!byId.has(id)) throw new Error(`missing dependency mission: ${id}`);
    if (state.get(id) === 'visiting') throw new Error(`dependency cycle detected at mission: ${id}`);
    if (state.get(id) === 'done') return timing.get(id);
    state.set(id, 'visiting');
    const mission = byId.get(id);
    const dependencies = Array.isArray(mission.dependsOn) ? mission.dependsOn : [];
    let startMs = 0;
    for (const dependencyId of dependencies) {
      const dependencyTiming = visit(dependencyId);
      startMs = Math.max(startMs, dependencyTiming.finishMs);
    }
    const durationMs = durationById.get(id);
    const record = { startMs, finishMs: startMs + durationMs, durationMs };
    timing.set(id, record);
    state.set(id, 'done');
    return record;
  };

  for (const mission of missions) visit(mission.id);

  const intervals = missions
    .map(mission => ({ id: mission.id, ...timing.get(mission.id) }))
    .filter(interval => interval.durationMs > 0);
  const events = [];
  for (const interval of intervals) {
    events.push([interval.startMs, 1]);
    events.push([interval.finishMs, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let peakConcurrency = 0;
  for (const [, delta] of events) {
    active += delta;
    peakConcurrency = Math.max(peakConcurrency, active);
  }

  const totalWorkMs = [...durationById.values()].reduce((sum, value) => sum + value, 0);
  const fanoutLatencyMs = Math.max(...[...timing.values()].map(item => item.finishMs));
  const serialLatencyMs = totalWorkMs;
  const speedup = fanoutLatencyMs === 0 ? 1 : serialLatencyMs / fanoutLatencyMs;

  return {
    missionCount: missions.length,
    serialLatencyMs,
    fanoutLatencyMs,
    latencySavedMs: serialLatencyMs - fanoutLatencyMs,
    speedup,
    peakConcurrency,
    totalWorkMs,
    timing: Object.fromEntries(missions.map(mission => [mission.id, timing.get(mission.id)]))
  };
}

export function evaluateOrchestrationReadiness(metrics, { minSpeedup = 1.15, maxPeakConcurrency = 4 } = {}) {
  if (!metrics || !Number.isFinite(metrics.speedup) || !Number.isInteger(metrics.peakConcurrency)) {
    throw new Error('valid benchmark metrics are required');
  }
  const checks = {
    latencyGain: metrics.speedup >= minSpeedup,
    concurrencyBudget: metrics.peakConcurrency <= maxPeakConcurrency,
    noExtraWork: metrics.totalWorkMs === metrics.serialLatencyMs
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    minSpeedup,
    maxPeakConcurrency
  };
}

function normalizeFleet(workers) {
  if (!Array.isArray(workers) || workers.length === 0) throw new Error('worker fleet is required');
  const seen = new Set();
  return workers.map((worker, index) => {
    const id = typeof worker?.id === 'string' ? worker.id.trim() : '';
    if (!id) throw new Error(`worker ${index} requires an id`);
    if (seen.has(id)) throw new Error(`duplicate worker id: ${id}`);
    seen.add(id);
    const capabilities = Array.isArray(worker.capabilities)
      ? [...new Set(worker.capabilities.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()))]
      : [];
    if (capabilities.length === 0) throw new Error(`worker ${id} requires at least one capability`);
    return { id, capabilities: new Set(capabilities), availableAtMs: 0, busyMs: 0, missionCount: 0 };
  });
}

function requiredCapabilitiesForMission(mission) {
  const declared = Array.isArray(mission.requiredCapabilities)
    ? mission.requiredCapabilities.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim())
    : [];
  const capabilities = [...new Set(declared)];
  if (capabilities.length > 0) return capabilities;
  const agentId = typeof mission.metadata?.agentId === 'string' ? mission.metadata.agentId.trim() : '';
  if (agentId) return [agentId];
  throw new Error(`mission ${mission.id} requires at least one capability`);
}

function workerCanRun(worker, capabilities) {
  return capabilities.every(capability => worker.capabilities.has(capability));
}

function peakConcurrencyForTiming(records) {
  const events = [];
  for (const record of records) {
    if (record.durationMs <= 0) continue;
    events.push([record.startMs, 1]);
    events.push([record.finishMs, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let peak = 0;
  for (const [, delta] of events) {
    active += delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

export function benchmarkOrchestrationFleet(missions, durationsMs = {}, workers = []) {
  const baseline = benchmarkOrchestrationGraph(missions, durationsMs);
  const fleet = normalizeFleet(workers);
  const missionIndex = new Map(missions.map((mission, index) => [mission.id, index]));
  const scheduled = new Map();
  const capabilityByMission = new Map();

  for (const mission of missions) {
    const capabilities = requiredCapabilitiesForMission(mission);
    capabilityByMission.set(mission.id, capabilities);
    if (!fleet.some(worker => workerCanRun(worker, capabilities))) {
      throw new Error(`no worker satisfies mission ${mission.id} capabilities: ${capabilities.join(',')}`);
    }
  }

  while (scheduled.size < missions.length) {
    const candidates = [];
    for (const mission of missions) {
      if (scheduled.has(mission.id)) continue;
      const dependencies = Array.isArray(mission.dependsOn) ? mission.dependsOn : [];
      if (!dependencies.every(id => scheduled.has(id))) continue;
      const readyAtMs = dependencies.reduce((max, id) => Math.max(max, scheduled.get(id).finishMs), 0);
      const capabilities = capabilityByMission.get(mission.id);
      const compatible = fleet
        .filter(worker => workerCanRun(worker, capabilities))
        .map(worker => ({ worker, startMs: Math.max(readyAtMs, worker.availableAtMs) }))
        .sort((a, b) => a.startMs - b.startMs || a.worker.availableAtMs - b.worker.availableAtMs || a.worker.id.localeCompare(b.worker.id));
      const assignment = compatible[0];
      candidates.push({
        mission,
        worker: assignment.worker,
        readyAtMs,
        startMs: assignment.startMs,
        index: missionIndex.get(mission.id)
      });
    }

    if (candidates.length === 0) throw new Error('unable to schedule worker fleet; dependency graph made no progress');
    candidates.sort((a, b) => a.startMs - b.startMs || a.readyAtMs - b.readyAtMs || a.index - b.index || a.worker.id.localeCompare(b.worker.id));
    const selected = candidates[0];
    const durationMs = baseline.timing[selected.mission.id].durationMs;
    const finishMs = selected.startMs + durationMs;
    const record = {
      workerId: selected.worker.id,
      requiredCapabilities: capabilityByMission.get(selected.mission.id),
      readyAtMs: selected.readyAtMs,
      startMs: selected.startMs,
      finishMs,
      durationMs,
      queueDelayMs: selected.startMs - selected.readyAtMs
    };
    scheduled.set(selected.mission.id, record);
    selected.worker.availableAtMs = finishMs;
    selected.worker.busyMs += durationMs;
    selected.worker.missionCount += 1;
  }

  const timingRecords = [...scheduled.values()];
  const constrainedLatencyMs = Math.max(...timingRecords.map(item => item.finishMs));
  const totalQueueDelayMs = timingRecords.reduce((sum, item) => sum + item.queueDelayMs, 0);
  const maxQueueDelayMs = Math.max(...timingRecords.map(item => item.queueDelayMs));
  const latencyPenaltyMs = constrainedLatencyMs - baseline.fanoutLatencyMs;
  const latencyPenaltyRatio = baseline.fanoutLatencyMs === 0 ? 0 : latencyPenaltyMs / baseline.fanoutLatencyMs;
  const constrainedSpeedup = constrainedLatencyMs === 0 ? 1 : baseline.serialLatencyMs / constrainedLatencyMs;
  const workerUtilization = Object.fromEntries(fleet.map(worker => [worker.id, {
    busyMs: worker.busyMs,
    missionCount: worker.missionCount,
    utilization: constrainedLatencyMs === 0 ? 0 : worker.busyMs / constrainedLatencyMs
  }]));

  return {
    missionCount: baseline.missionCount,
    fleetSize: fleet.length,
    serialLatencyMs: baseline.serialLatencyMs,
    unconstrainedLatencyMs: baseline.fanoutLatencyMs,
    constrainedLatencyMs,
    latencyPenaltyMs,
    latencyPenaltyRatio,
    constrainedSpeedup,
    totalWorkMs: baseline.totalWorkMs,
    totalQueueDelayMs,
    maxQueueDelayMs,
    peakConcurrentWorkers: peakConcurrencyForTiming(timingRecords),
    workerUtilization,
    timing: Object.fromEntries(missions.map(mission => [mission.id, scheduled.get(mission.id)]))
  };
}

export function evaluateFleetReadiness(metrics, {
  minSpeedup = 1.1,
  maxLatencyPenaltyRatio = 0.5,
  maxQueueDelayMs = Infinity,
  maxFleetSize = 8
} = {}) {
  if (!metrics || !Number.isFinite(metrics.constrainedSpeedup) || !Number.isFinite(metrics.latencyPenaltyRatio) || !Number.isFinite(metrics.maxQueueDelayMs) || !Number.isInteger(metrics.fleetSize)) {
    throw new Error('valid fleet benchmark metrics are required');
  }
  if (!Number.isFinite(minSpeedup) || minSpeedup < 0) throw new Error('minSpeedup must be a non-negative finite number');
  if (!Number.isFinite(maxLatencyPenaltyRatio) || maxLatencyPenaltyRatio < 0) throw new Error('maxLatencyPenaltyRatio must be a non-negative finite number');
  if (!(maxQueueDelayMs === Infinity || (Number.isFinite(maxQueueDelayMs) && maxQueueDelayMs >= 0))) throw new Error('maxQueueDelayMs must be non-negative');
  if (!Number.isInteger(maxFleetSize) || maxFleetSize < 1) throw new Error('maxFleetSize must be a positive integer');

  const checks = {
    latencyGain: metrics.constrainedSpeedup >= minSpeedup,
    contentionBudget: metrics.latencyPenaltyRatio <= maxLatencyPenaltyRatio,
    queueDelayBudget: metrics.maxQueueDelayMs <= maxQueueDelayMs,
    fleetBudget: metrics.fleetSize <= maxFleetSize,
    noExtraWork: metrics.totalWorkMs === metrics.serialLatencyMs
  };
  return {
    pass: Object.values(checks).every(Boolean),
    checks,
    minSpeedup,
    maxLatencyPenaltyRatio,
    maxQueueDelayMs,
    maxFleetSize
  };
}
