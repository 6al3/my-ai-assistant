function indexByQueueSize(results) {
  if (!Array.isArray(results) || results.length === 0) throw new Error('benchmark results are required');
  const map = new Map();
  for (const row of results) {
    if (!Number.isInteger(row?.queueSize) || row.queueSize < 1) throw new Error('benchmark queueSize is invalid');
    if (map.has(row.queueSize)) throw new Error(`duplicate benchmark queueSize: ${row.queueSize}`);
    map.set(row.queueSize, row);
  }
  return map;
}

function relativeSpread(values) {
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('benchmark p95 measurement is invalid');
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === 0) return 0;
  return (max - min) / max;
}

export function evaluateMissionRuntimeBenchmarkStability(runs, { maxRelativeP95Spread = 0.25 } = {}) {
  if (!Array.isArray(runs) || runs.length < 2) throw new Error('at least two benchmark runs are required');
  if (!Number.isFinite(maxRelativeP95Spread) || maxRelativeP95Spread < 0 || maxRelativeP95Spread > 1) throw new Error('maxRelativeP95Spread must be between 0 and 1');

  const indexed = runs.map(indexByQueueSize);
  const queueSizes = [...indexed[0].keys()].sort((a, b) => a - b);
  for (const map of indexed.slice(1)) {
    const sizes = [...map.keys()].sort((a, b) => a - b);
    if (sizes.length !== queueSizes.length || sizes.some((size, index) => size !== queueSizes[index])) throw new Error('benchmark runs use different queue sizes');
  }

  const measurements = queueSizes.map(queueSize => {
    const enqueue = indexed.map(map => map.get(queueSize)?.failedEnqueue?.p95Ms);
    const claim = indexed.map(map => map.get(queueSize)?.failedClaim?.p95Ms);
    const enqueueSpread = relativeSpread(enqueue);
    const claimSpread = relativeSpread(claim);
    return {
      queueSize,
      failedEnqueueP95Ms: enqueue,
      failedClaimP95Ms: claim,
      failedEnqueueRelativeSpread: enqueueSpread,
      failedClaimRelativeSpread: claimSpread,
      stable: enqueueSpread <= maxRelativeP95Spread && claimSpread <= maxRelativeP95Spread
    };
  });

  return {
    ready: measurements.every(row => row.stable),
    maxRelativeP95Spread,
    runCount: runs.length,
    measurements,
    failedChecks: measurements.filter(row => !row.stable).map(row => `unstable-p95-${row.queueSize}`)
  };
}
