import { buildExecutionPlan } from './orchestrator.mjs';
import { MissionCoordinator } from './mission-coordinator.mjs';

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
    const plan = buildExecutionPlan(text.trim());
    const missions = [];
    let previousId = null;
    for (const agent of plan.agents) {
      const mission = await this.coordinator.enqueue({
        task: text.trim(),
        priority,
        requiredCapabilities: [agent.id],
        dependsOn: previousId ? [previousId] : [],
        metadata: { ...metadata, planCreatedAt: plan.createdAt, agentId: agent.id, agentName: agent.name, role: agent.role },
        idempotencyKey: idempotencyKey ? `${idempotencyKey}:${agent.id}` : null
      });
      missions.push(mission);
      previousId = mission.id;
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