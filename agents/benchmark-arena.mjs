import { randomUUID } from 'node:crypto';

const WEIGHTS = Object.freeze({
  correctness: 0.45,
  robustness: 0.20,
  qa: 0.15,
  regressionRisk: 0.10,
  latency: 0.05,
  resourceUse: 0.05
});

function unit(name, value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be between 0 and 1`);
  }
  return value;
}

function nonNegative(name, value) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

export function scheduleCompetition(queue, {
  task,
  competitors,
  reviewerCapability = 'qa',
  priority = 50,
  metadata = {}
}) {
  if (!task?.trim()) throw new Error('task is required');
  const unique = [...new Set(competitors ?? [])];
  if (unique.length < 2) throw new Error('at least two competitors are required');

  const contestId = randomUUID();
  const attempts = unique.map((capability, index) => queue.enqueue({
    task: `[contest:${contestId}] independent attempt ${index + 1}: ${task.trim()}`,
    priority,
    requiredCapabilities: [capability],
    metadata: { ...metadata, contestId, phase: 'attempt', competitor: capability }
  }));

  const review = queue.enqueue({
    task: `[contest:${contestId}] compare attempts and select strongest: ${task.trim()}`,
    priority: priority + 1,
    requiredCapabilities: [reviewerCapability],
    dependsOn: attempts.map(m => m.id),
    metadata: {
      ...metadata,
      contestId,
      phase: 'review',
      attemptMissionIds: attempts.map(m => m.id),
      metrics: Object.keys(WEIGHTS)
    }
  });

  return { contestId, attempts, review };
}

export class BenchmarkArena {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.contests = new Map();
  }

  create({ task, competitors, metadata = {} }) {
    if (!task?.trim()) throw new Error('task is required');
    const unique = [...new Set(competitors ?? [])];
    if (unique.length < 2) throw new Error('at least two competitors are required');
    const contest = {
      id: randomUUID(), task: task.trim(), metadata,
      status: 'collecting', createdAt: this.now(), finalizedAt: null,
      competitors: unique.map(id => ({ id, submission: null })),
      ranking: [], winner: null, decision: null
    };
    this.contests.set(contest.id, contest);
    return structuredClone(contest);
  }

  submit(contestId, competitorId, {
    output = null,
    correctness,
    robustness,
    qa,
    regressionRisk,
    latencyMs,
    resourceUnits,
    failures = [],
    lessons = []
  }) {
    const contest = this.#contest(contestId);
    if (contest.status !== 'collecting') throw new Error('contest is finalized');
    const competitor = contest.competitors.find(c => c.id === competitorId);
    if (!competitor) throw new Error('competitor not found');
    if (competitor.submission) throw new Error('competitor already submitted');
    competitor.submission = {
      output,
      correctness: unit('correctness', correctness),
      robustness: unit('robustness', robustness),
      qa: unit('qa', qa),
      regressionRisk: unit('regressionRisk', regressionRisk),
      latencyMs: nonNegative('latencyMs', latencyMs),
      resourceUnits: nonNegative('resourceUnits', resourceUnits),
      failures: [...failures], lessons: [...lessons], submittedAt: this.now()
    };
    return structuredClone(competitor);
  }

  finalize(contestId) {
    const contest = this.#contest(contestId);
    if (contest.status !== 'collecting') return structuredClone(contest);
    const submitted = contest.competitors.filter(c => c.submission);
    if (submitted.length < 2) throw new Error('at least two submissions are required');

    const minLatency = Math.min(...submitted.map(c => c.submission.latencyMs));
    const minResource = Math.min(...submitted.map(c => c.submission.resourceUnits));
    const efficiency = (value, min) => value === 0 ? 1 : min === 0 ? 0 : Math.min(1, min / value);

    contest.ranking = submitted.map(c => {
      const s = c.submission;
      const latency = efficiency(s.latencyMs, minLatency);
      const resourceUse = efficiency(s.resourceUnits, minResource);
      const score =
        s.correctness * WEIGHTS.correctness +
        s.robustness * WEIGHTS.robustness +
        s.qa * WEIGHTS.qa +
        (1 - s.regressionRisk) * WEIGHTS.regressionRisk +
        latency * WEIGHTS.latency +
        resourceUse * WEIGHTS.resourceUse;
      return {
        competitorId: c.id,
        score: Number(score.toFixed(6)),
        metrics: { correctness: s.correctness, robustness: s.robustness, qa: s.qa, regressionRisk: s.regressionRisk, latencyMs: s.latencyMs, resourceUnits: s.resourceUnits, latencyEfficiency: latency, resourceEfficiency: resourceUse },
        failures: s.failures,
        lessons: s.lessons,
        output: s.output
      };
    }).sort((a, b) => b.score - a.score || a.competitorId.localeCompare(b.competitorId));

    contest.winner = contest.ranking[0].competitorId;
    const winner = contest.ranking[0];
    const runnerUp = contest.ranking[1];
    contest.decision = {
      retained: winner.competitorId,
      whyWon: `highest weighted score ${winner.score} vs ${runnerUp.score}; weights=${JSON.stringify(WEIGHTS)}`,
      failures: contest.ranking.flatMap(r => r.failures.map(failure => ({ competitorId: r.competitorId, failure }))),
      lessons: contest.ranking.flatMap(r => r.lessons.map(lesson => ({ competitorId: r.competitorId, lesson })))
    };
    contest.status = 'finalized';
    contest.finalizedAt = this.now();
    return structuredClone(contest);
  }

  get(contestId) {
    const contest = this.contests.get(contestId);
    return contest ? structuredClone(contest) : null;
  }

  #contest(id) {
    const contest = this.contests.get(id);
    if (!contest) throw new Error('contest not found');
    return contest;
  }
}

export { WEIGHTS as benchmarkWeights };
