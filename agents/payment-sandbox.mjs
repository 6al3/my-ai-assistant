import registry from './registry.json' with { type: 'json' };
import { MissionQueue } from './mission-queue.mjs';

const SAFE_CASES = Object.freeze([
  { id: 'visa-approved', token: 'TEST_VISA_APPROVED', outcome: 'approved' },
  { id: 'visa-declined', token: 'TEST_VISA_DECLINED', outcome: 'declined' },
  { id: 'visa-3ds', token: 'TEST_VISA_3DS_REQUIRED', outcome: '3ds_required' },
  { id: 'visa-funds', token: 'TEST_VISA_INSUFFICIENT_FUNDS', outcome: 'insufficient_funds' }
]);

const OBJECTIVES = Object.freeze({
  orchestrator: 'Coordinate the synthetic payment scenario and collect specialist findings.',
  planner: 'Plan the synthetic transaction flow and decision points.',
  coder: 'Inspect mock integration logic and identify implementation defects.',
  system: 'Check the local sandbox runtime, isolation, and reliability signals.',
  files: 'Track synthetic fixtures and test-result artifacts only.',
  web: 'Explain payment concepts from provided sandbox context; do not contact real payment systems.',
  memory: 'Retain only non-sensitive experiment facts and synthetic identifiers.',
  media: 'Prepare a safe user-facing explanation of the synthetic result.',
  audit: 'Verify that every synthetic action is logged and no real payment data is used.',
  qa: 'Validate expected outcome, policy gates, and regression behavior.'
});

export function listPaymentSandboxCases() {
  return structuredClone(SAFE_CASES);
}

export function createPaymentSandboxExperiment({ caseId = 'visa-approved', amountCents = 1000, currency = 'USD' } = {}) {
  const testCase = SAFE_CASES.find(c => c.id === caseId);
  if (!testCase) throw new Error(`unknown sandbox case: ${caseId}`);
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('amountCents must be a positive integer');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be a 3-letter uppercase code');

  const queue = new MissionQueue({ maxAttempts: 2, leaseMs: 10_000 });
  const experimentId = `payment-sandbox:${testCase.id}`;
  const missions = [];

  for (const agent of registry.agents) {
    const mission = queue.enqueue({
      task: `[SANDBOX ONLY] ${OBJECTIVES[agent.id] ?? 'Review the synthetic payment scenario.'}`,
      priority: agent.id === 'audit' || agent.id === 'qa' ? 90 : 60,
      requiredCapabilities: [agent.id],
      metadata: {
        experimentId,
        mode: 'synthetic-payment-sandbox',
        networkAllowed: false,
        realCardsAllowed: false,
        syntheticToken: testCase.token,
        expectedOutcome: testCase.outcome,
        amountCents,
        currency
      }
    });
    missions.push(mission);
  }

  return { experimentId, case: structuredClone(testCase), queue, missions };
}

export function claimExperimentMission(queue, agentId) {
  if (!registry.agents.some(a => a.id === agentId)) throw new Error(`unknown agent: ${agentId}`);
  return queue.claim({ id: `experiment-${agentId}`, capabilities: [agentId] });
}
