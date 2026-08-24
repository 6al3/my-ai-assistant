function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('timing samples are required');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function validateSamples(samples, label) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error(`${label} samples are required`);
  for (const sample of samples) {
    if (!Number.isFinite(sample) || sample < 0) throw new Error(`${label} samples must be finite non-negative numbers`);
  }
}

function validateBudget(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} budget must be a finite non-negative number`);
}

export function summarizeContentionTimings(results) {
  if (!Array.isArray(results) || results.length === 0) throw new Error('contention results are required');
  const lockWait = results.map(item => item?.lockWaitMs);
  const durableCommit = results.map(item => item?.durableCommitMs);
  validateSamples(lockWait, 'lockWaitMs');
  validateSamples(durableCommit, 'durableCommitMs');
  return {
    count: results.length,
    lockWaitP50Ms: percentile(lockWait, 0.50),
    lockWaitP95Ms: percentile(lockWait, 0.95),
    durableCommitP50Ms: percentile(durableCommit, 0.50),
    durableCommitP95Ms: percentile(durableCommit, 0.95)
  };
}

export function evaluateContentionQualification({ enqueue, claim, journal }, budgets) {
  if (!budgets || typeof budgets !== 'object') throw new Error('contention budgets are required');
  for (const key of ['lockWaitP95Ms', 'durableCommitP95Ms']) validateBudget(budgets[key], key);

  const summaries = {
    enqueue: summarizeContentionTimings(enqueue),
    claim: summarizeContentionTimings(claim),
    journal: summarizeContentionTimings(journal)
  };
  const checks = {};
  for (const [name, summary] of Object.entries(summaries)) {
    checks[`${name}LockWaitWithinBudget`] = summary.lockWaitP95Ms <= budgets.lockWaitP95Ms;
    checks[`${name}DurableCommitWithinBudget`] = summary.durableCommitP95Ms <= budgets.durableCommitP95Ms;
  }
  return {
    ready: Object.values(checks).every(Boolean),
    checks,
    summaries,
    budgets: { ...budgets }
  };
}
