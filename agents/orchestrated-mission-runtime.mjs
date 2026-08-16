import { buildExecutionPlan } from './orchestrator.mjs';
import { MissionCoordinator } from './mission-coordinator.mjs';

const COORDINATION_AGENTS = new Set(['orchestrator', 'planner']);
const REVIEW_AGENT = 'qa';

export class OrchestratedMissionRuntime {
  static async open({ store, queueOptions = {} } = {}) {
    return new OrchestratedMissionRuntime({ coordinator: await MissionCoordinator.open({ store, queueOptions }) });
  }

  constructor({ coordinator } = {}) {
    if (!coordinator) throw new Error('coordinator is required');
    this.coordinator = coordinator;
  }

  async submit(text, { idempotencyKey = null, priority = 0, metadata = {} } = {}) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('task text is required');
    const task = text.trim();
    const plan = buildExecutionPlan(task);
    const missions = [];
    const missionByAgent = new Map();
    let coordinationTail = null;

    const enqueueAgent = async (agent, dependsOn) => {
      const mission = await this.coordinator.enqueue({
        task,
        priority,
        requiredCapabilities: [agent.id],
        dependsOn,
        metadata: {
          ...metadata,
          planCreatedAt: plan.createdAt,
          agentId: agent.id,
          agentName: agent.name,
          role: agent.role,
          executionPhase: COORDINATION_AGENTS.has(agent.id) ? 'coordination' : agent.id === REVIEW_AGENT ? 'review' : 'parallel-work'
        },
        idempotencyKey: idempotencyKey ? `${idempotencyKey}:${agent.id}` : null
      });
      missions.push(mission);
      missionByAgent.set(agent.id, mission);
      return mission;
    };

    for (const agent of plan.agents.filter(agent => COORDINATION_AGENTS.has(agent.id))) {
      const mission = await enqueueAgent(agent, coordinationTail ? [coordinationTail.id] : []);
      coordinationTail = mission;
    }

    const specialists = plan.agents.filter(agent => !COORDINATION_AGENTS.has(agent.id) && agent.id !== REVIEW_AGENT);
    for (const agent of specialists) {
      await enqueueAgent(agent, coordinationTail ? [coordinationTail.id] : []);
    }

    const reviewer = plan.agents.find(agent => agent.id === REVIEW_AGENT);
    if (reviewer) {
      const reviewDependencies = specialists
        .map(agent => missionByAgent.get(agent.id)?.id)
        .filter(Boolean);
      if (reviewDependencies.length === 0 && coordinationTail) reviewDependencies.push(coordinationTail.id);
      await enqueueAgent(reviewer, reviewDependencies);
    }

    return { plan, missions };
  }

  async claim(worker) { return this.coordinator.claim(worker); }
  async heartbeat(id, workerId) { return this.coordinator.heartbeat(id, workerId); }
  async complete(id, workerId, result = null) { return this.coordinator.complete(id, workerId, result); }
  async fail(id, workerId, error) { return this.coordinator.fail(id, workerId, error); }
  get(id) { return this.coordinator.get(id); }
  list(options = {}) { return this.coordinator.list(options); }
  stats() { return this.coordinator.stats(); }
}
