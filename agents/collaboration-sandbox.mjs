import registry from './registry.json' with { type: 'json' };
import { MissionQueue } from './mission-queue.mjs';
import { listPaymentSandboxCases } from './payment-sandbox.mjs';

const STAGES = Object.freeze([
  { id: 'plan', capability: 'planner', task: 'Plan the synthetic payment drill and identify expected decision points.' },
  { id: 'orchestrate', capability: 'orchestrator', task: 'Coordinate the synthetic drill and assign follow-up work from the plan.', dependsOn: ['plan'] },
  { id: 'implementation', capability: 'coder', task: 'Review mock payment integration behavior for the synthetic case.', dependsOn: ['orchestrate'] },
  { id: 'runtime', capability: 'system', task: 'Review local sandbox runtime and isolation signals only.', dependsOn: ['orchestrate'] },
  { id: 'fixtures', capability: 'files', task: 'Review synthetic fixtures and result artifacts; do not access real payment data.', dependsOn: ['orchestrate'] },
  { id: 'concepts', capability: 'web', task: 'Explain the provided payment concepts from sandbox context only; no external payment-system contact.', dependsOn: ['orchestrate'] },
  { id: 'memory', capability: 'memory', task: 'Extract non-sensitive lessons and synthetic identifiers for later drills.', dependsOn: ['implementation', 'runtime', 'fixtures', 'concepts'] },
  { id: 'media', capability: 'media', task: 'Prepare a safe user-facing explanation of the synthetic result.', dependsOn: ['implementation', 'runtime'] },
  { id: 'audit', capability: 'audit', task: 'Audit the drill for sandbox-only behavior, isolation, and data-handling violations.', dependsOn: ['implementation', 'runtime', 'fixtures', 'concepts'] },
  { id: 'qa', capability: 'qa', task: 'Perform final QA using prior findings and verify the expected synthetic outcome.', dependsOn: ['memory', 'media', 'audit'] }
]);

function knownAgent(id) {
  return registry.agents.some(agent => agent.id === id);
}

export function createCollaborativePaymentDrill({ caseId = 'visa-approved', amountCents = 1000, currency = 'USD' } = {}) {
  const testCase = listPaymentSandboxCases().find(c => c.id === caseId);
  if (!testCase) throw new Error(`unknown sandbox case: ${caseId}`);
  if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('amountCents must be a positive integer');
  if (!/^[A-Z]{3}$/.test(currency)) throw new Error('currency must be a 3-letter uppercase code');

  const queue = new MissionQueue({ maxAttempts: 2, leaseMs: 10_000 });
  const drillId = `collab-payment:${caseId}`;
  const byStage = new Map();

  for (const stage of STAGES) {
    if (!knownAgent(stage.capability)) throw new Error(`missing registered agent: ${stage.capability}`);
    const dependsOn = (stage.dependsOn ?? []).map(id => byStage.get(id).id);
    const mission = queue.enqueue({
      task: `[COLLAB SANDBOX ONLY] ${stage.task}`,
      priority: stage.capability === 'audit' || stage.capability === 'qa' ? 90 : 60,
      requiredCapabilities: [stage.capability],
      dependsOn,
      metadata: {
        drillId,
        stageId: stage.id,
        mode: 'collaborative-synthetic-payment-sandbox',
        networkAllowed: false,
        realCardsAllowed: false,
        syntheticToken: testCase.token,
        expectedOutcome: testCase.outcome,
        amountCents,
        currency
      }
    });
    byStage.set(stage.id, mission);
  }

  return {
    drillId,
    case: structuredClone(testCase),
    queue,
    missions: [...byStage.values()].map(structuredClone)
  };
}

export function claimCollaborativeMission(queue, agentId) {
  if (!knownAgent(agentId)) throw new Error(`unknown agent: ${agentId}`);
  return queue.claim({ id: `collab-${agentId}`, capabilities: [agentId] });
}

export function collaborationStages() {
  return structuredClone(STAGES);
}
