function percentile(values, fraction) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('timing samples are required');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function validateSamples(samples, label, minimumSamples) {
  if (!Array.isArray(samples) || samples.length === 0) throw new Error(`${label} samples are required`);
  if (samples.length < minimumSamples) throw new Error(`${label} requires at least ${minimumSamples} samples`);
  for (const sample of samples) {
    if (!Number.isFinite(sample) || sample < 0) throw new Error(`${label} samples must be finite non-negative numbers`);
  }
}

function validateBudget(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} budget must be a finite non-negative number`);
}

function validateMinimumSamples(value) {
  if (!Number.isInteger(value) || value < 2) throw new Error('minimumSamplesPerPath must be an integer >= 2');
}

export function summarizeContentionTimings(results, { minimumSamples = 1 } = {}) {
  if (!Number.isInteger(minimumSamples) || minimumSamples < 1) throw new Error('minimumSamples must be an integer >= 1');
  if (!Array.isArray(results) || results.length === 0) throw new Error('contention results are required');
  const lockWait = results.map(item => item?.lockWaitMs);
  const ownerPublication = results.map(item => item?.ownerPublicationMs);
  const durableCommit = results.map(item => item?.durableCommitMs);
  validateSamples(lockWait, 'lockWaitMs', minimumSamples);
  validateSamples(ownerPublication, 'ownerPublicationMs', minimumSamples);
  validateSamples(durableCommit, 'durableCommitMs', minimumSamples);
  return {
    count: results.length,
    lockWaitP50Ms: percentile(lockWait, 0.50),
    lockWaitP95Ms: percentile(lockWait, 0.95),
    ownerPublicationP50Ms: percentile(ownerPublication, 0.50),
    ownerPublicationP95Ms: percentile(ownerPublication, 0.95),
    durableCommitP50Ms: percentile(durableCommit, 0.50),
    durableCommitP95Ms: percentile(durableCommit, 0.95)
  };
}

export function evaluateContentionQualification({ enqueue, claim, journalCommit, journal }, budgets) {
  if (journal !== undefined) {
    throw new Error('legacy journal contention evidence is ambiguous; provide terminal journalCommit evidence');
  }
  if (!budgets || typeof budgets !== 'object') throw new Error('contention budgets are required');
  for (const key of ['lockWaitP95Ms', 'durableCommitP95Ms']) validateBudget(budgets[key], key);
  validateMinimumSamples(budgets.minimumSamplesPerPath);

  const summaryOptions = { minimumSamples: budgets.minimumSamplesPerPath };
  const summaries = {
    enqueue: summarizeContentionTimings(enqueue, summaryOptions),
    claim: summarizeContentionTimings(claim, summaryOptions),
    journalCommit: summarizeContentionTimings(journalCommit, summaryOptions)
  };
  const checks = {};
  for (const [name, summary] of Object.entries(summaries)) {
    checks[`${name}SampleCoverage`] = summary.count >= budgets.minimumSamplesPerPath;
    checks[`${name}LockWaitWithinBudget`] = summary.lockWaitP95Ms <= budgets.lockWaitP95Ms;
    checks[`${name}DurableCommitWithinBudget`] = summary.durableCommitP95Ms <= budgets.durableCommitP95Ms;
  }
  return {
    ready: Object.values(checks).every(Boolean),
    checks,
    summaries,
    budgets: { ...budgets },
    qualifiedJournalPhase: 'commit'
  };
}
