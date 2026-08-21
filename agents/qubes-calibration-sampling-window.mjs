function positiveInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value <= 0 || value > max) {
    throw new Error(`${label} must be an integer between 1 and ${max}`);
  }
  return value;
}

function nonNegativeInteger(value, label, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${label} must be an integer between 0 and ${max}`);
  }
  return value;
}

export function deriveDurationBoundSampling({
  workloadDurationMs,
  sampleCount = 5,
  requestedIntervalMs = null,
  reserveMs = 1,
  maxIntervalMs = 60000
} = {}) {
  const duration = positiveInteger(workloadDurationMs, 'workloadDurationMs', 24 * 60 * 60 * 1000);
  const samples = positiveInteger(sampleCount, 'sampleCount', 100);
  const reserve = nonNegativeInteger(reserveMs, 'reserveMs', duration);
  const usableWindowMs = duration - reserve;
  if (usableWindowMs < 0) throw new Error('reserveMs exceeds workloadDurationMs');

  if (samples === 1) {
    if (requestedIntervalMs !== null && requestedIntervalMs !== undefined) {
      nonNegativeInteger(requestedIntervalMs, 'requestedIntervalMs', maxIntervalMs);
    }
    return {
      sampleCount: samples,
      intervalMs: 0,
      lastSampleOffsetMs: 0,
      workloadDurationMs: duration,
      reserveMs: reserve,
      derived: requestedIntervalMs === null || requestedIntervalMs === undefined
    };
  }

  const maxSafeIntervalMs = Math.floor(usableWindowMs / (samples - 1));
  if (maxSafeIntervalMs <= 0) {
    throw new Error(`workload duration ${duration}ms is too short for ${samples} samples with ${reserve}ms reserve`);
  }

  let intervalMs;
  let derived;
  if (requestedIntervalMs === null || requestedIntervalMs === undefined) {
    intervalMs = maxSafeIntervalMs;
    derived = true;
  } else {
    intervalMs = nonNegativeInteger(requestedIntervalMs, 'requestedIntervalMs', maxIntervalMs);
    derived = false;
    const lastSampleOffsetMs = (samples - 1) * intervalMs;
    if (lastSampleOffsetMs > usableWindowMs) {
      throw new Error(`sampling window exceeds active workload: last sample at ${lastSampleOffsetMs}ms, usable workload window ${usableWindowMs}ms`);
    }
  }

  return {
    sampleCount: samples,
    intervalMs,
    lastSampleOffsetMs: (samples - 1) * intervalMs,
    workloadDurationMs: duration,
    reserveMs: reserve,
    derived
  };
}

export function validateSampleOffsets(offsetsMs, policy) {
  if (!Array.isArray(offsetsMs) || offsetsMs.length !== policy.sampleCount) {
    throw new Error(`expected ${policy.sampleCount} sample offsets`);
  }
  let previous = -1;
  for (const offset of offsetsMs) {
    const normalized = nonNegativeInteger(offset, 'sample offsetMs', policy.workloadDurationMs);
    if (normalized < previous) throw new Error('sample offsets must be monotonic');
    if (normalized > policy.workloadDurationMs - policy.reserveMs) {
      throw new Error(`sample offset ${normalized}ms is outside active workload window`);
    }
    previous = normalized;
  }
  return true;
}
