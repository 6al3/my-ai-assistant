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
