function validateFraction(value, label) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a finite number between 0 and 1`);
  }
}

function validateMinimumRuns(value) {
  if (!Number.isInteger(value) || value < 2) {
    throw new Error('minimumRuns must be an integer >= 2');
  }
}

function stableBudgetIdentity(budgets) {
  return JSON.stringify({
    minimumSamplesPerPath: budgets?.minimumSamplesPerPath,
    lockWaitP95Ms: budgets?.lockWaitP95Ms,
    durableCommitP95Ms: budgets?.durableCommitP95Ms
  });
}

function relativeSpread(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('spread values are required');
  for (const value of values) {
    if (!Number.isFinite(value) || value < 0) throw new Error('spread values must be finite non-negative numbers');
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (max === 0) return 0;
  return (max - min) / max;
}

export function evaluateContentionStability(
  evaluations,
  { minimumRuns = 3, maxRelativeP95Spread = 0.25 } = {}
) {
  validateMinimumRuns(minimumRuns);
  validateFraction(maxRelativeP95Spread, 'maxRelativeP95Spread');
  if (!Array.isArray(evaluations) || evaluations.length < minimumRuns) {
    throw new Error(`at least ${minimumRuns} contention qualification runs are required`);
  }

  const budgetIdentity = stableBudgetIdentity(evaluations[0]?.budgets);
  const requiredPaths = ['enqueue', 'claim', 'journalCommit'];
  const requiredMetrics = ['lockWaitP95Ms', 'durableCommitP95Ms'];

  for (const [index, evaluation] of evaluations.entries()) {
    if (!evaluation || typeof evaluation !== 'object') throw new Error(`evaluation ${index} is required`);
    if (evaluation.ready !== true) throw new Error(`evaluation ${index} is not contention-ready`);
    if (evaluation.qualifiedJournalPhase !== 'commit') throw new Error(`evaluation ${index} is not qualified on terminal journal commit`);
    if (stableBudgetIdentity(evaluation.budgets) !== budgetIdentity) {
      throw new Error('contention evaluations must use identical budgets');
    }
    for (const path of requiredPaths) {
      if (!evaluation.summaries?.[path]) throw new Error(`evaluation ${index} is missing ${path} summary`);
      for (const metric of requiredMetrics) {
        const value = evaluation.summaries[path][metric];
        if (!Number.isFinite(value) || value < 0) {
          throw new Error(`evaluation ${index} has invalid ${path}.${metric}`);
        }
      }
    }
  }

  const spreads = {};
  const checks = {};
  for (const path of requiredPaths) {
    spreads[path] = {};
    for (const metric of requiredMetrics) {
      const values = evaluations.map(evaluation => evaluation.summaries[path][metric]);
      const spread = relativeSpread(values);
      spreads[path][metric] = spread;
      checks[`${path}${metric[0].toUpperCase()}${metric.slice(1)}Stable`] = spread <= maxRelativeP95Spread;
    }
  }

  return {
    ready: Object.values(checks).every(Boolean),
    checks,
    spreads,
    runCount: evaluations.length,
    minimumRuns,
    maxRelativeP95Spread,
    budgets: { ...evaluations[0].budgets },
    qualifiedJournalPhase: 'commit'
  };
}
