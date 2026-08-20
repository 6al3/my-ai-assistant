import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOrchestrationCalibrationPlan, createOrchestrationCalibrationHooks } from './qubes-orchestration-calibration-workload.mjs';
import { runQubesResourceCalibration } from './qubes-resource-calibration-harness.mjs';
import { collectQubesResourceCalibration } from './qubes-resource-calibration.mjs';
import { sampleLocalQubeResources } from './qubes-resource-probe-service.mjs';
import { handleSyntheticWorkloadCommand } from './qubes-synthetic-workload-service.mjs';

const GIT_SHA = '0123456789abcdef0123456789abcdef01234567';
const WORKLOAD_ID = 'synthetic-dag-integration-v1';
const DURATIONS = { orchestrator: 20, planner: 30, coder: 80, system: 120, qa: 40 };
const MISSIONS = [
  { id: 'm-orchestrator', dependsOn: [], metadata: { agentId: 'orchestrator' }, requiredCapabilities: ['orchestrator'] },
  { id: 'm-planner', dependsOn: ['m-orchestrator'], metadata: { agentId: 'planner' }, requiredCapabilities: ['planner'] },
  { id: 'm-coder', dependsOn: ['m-planner'], metadata: { agentId: 'coder' }, requiredCapabilities: ['coder'] },
  { id: 'm-system', dependsOn: ['m-planner'], metadata: { agentId: 'system' }, requiredCapabilities: ['system'] },
  { id: 'm-qa', dependsOn: ['m-coder', 'm-system'], metadata: { agentId: 'qa' }, requiredCapabilities: ['qa'] }
];
const TOPOLOGY = {
  id: 'two-worker-calibration',
  workers: [
    { id: 'coord-code-qa', qube: 'dig-worker-a', capabilities: ['orchestrator', 'planner', 'coder', 'qa'] },
    { id: 'system', qube: 'dig-worker-b', capabilities: ['system'] }
  ]
};

function memoryStore() {
  const values = new Map();
  const key = command => `${command.runId}/${command.workloadId}`;
  return {
    async get(command) { return values.get(key(command)) ?? null; },
    async put(command, state) { values.set(key(command), structuredClone(state)); return `memory://${key(command)}`; },
    state(runId, workloadId) { return values.get(`${runId}/${workloadId}`) ?? null; }
  };
}

function syntheticTransport(plan, { failStartWorker = null, failStopWorker = null } = {}) {
  const stores = new Map(plan.workers.map(worker => [worker.workerId, memoryStore()]));
  const calls = [];
  let pid = 1000;
  return {
    stores,
    calls,
    async sendCommand(worker, command) {
      calls.push({ workerId: worker.workerId, action: command.action });
      if (command.action === 'start' && worker.workerId === failStartWorker) throw new Error(`synthetic start failure: ${worker.workerId}`);
      if (command.action === 'stop' && worker.workerId === failStopWorker) throw new Error(`synthetic stop failure: ${worker.workerId}`);
      return handleSyntheticWorkloadCommand(command, {
        store: stores.get(worker.workerId),
        spawnExecutor: () => ++pid,
        now: () => 1_700_000_000_000
      });
    }
  };
}

function resourceSample(worker, round) {
  let statRead = 0;
  const usedMb = worker.id === 'system' ? 700 + round * 10 : 900 + round * 10;
  const totalKb = 2 * 1024 * 1024;
  const availableKb = totalKb - usedMb * 1024;
  return sampleLocalQubeResources({
    readText: async path => {
      if (path === '/proc/meminfo') return `MemTotal:       ${totalKb} kB\nMemAvailable:   ${availableKb} kB\n`;
      if (path === '/proc/stat') {
        statRead += 1;
        return statRead === 1
          ? 'cpu  100 0 100 700 0 0 0 0 0 0\n'
          : 'cpu  130 0 120 750 0 0 0 0 0 0\n';
      }
      throw new Error(`unexpected probe path: ${path}`);
    },
    sleep: async () => {},
    cpuWindowMs: 25,
    cpuCount: () => worker.id === 'system' ? 1 : 2
  });
}

function integrationFixture(options = {}) {
  const plan = buildOrchestrationCalibrationPlan({ missions: MISSIONS, durationsMs: DURATIONS, topology: TOPOLOGY, workloadId: WORKLOAD_ID });
  const transport = syntheticTransport(plan, options);
  const hooks = createOrchestrationCalibrationHooks(plan, { service: 'dig.SyntheticWorkload', sendCommand: transport.sendCommand });
  return { plan, transport, hooks };
}

test('calibration integration binds benchmark plan, synthetic workload, resource probe, cleanup, and collector', async () => {
  const { plan, transport, hooks } = integrationFixture();
  assert.equal(plan.durationMs, 210);
  assert.equal(plan.metrics.constrainedLatencyMs, 210);
  assert.equal(plan.metrics.peakConcurrentWorkers, 2);

  const events = await runQubesResourceCalibration({
    gitSha: GIT_SHA,
    topology: TOPOLOGY,
    runId: 'integration-happy',
    workloadId: WORKLOAD_ID,
    sampleCount: 5,
    intervalMs: 0,
    startWorkload: hooks.startWorkload,
    stopWorkload: hooks.stopWorkload,
    sampleWorker: resourceSample
  });

  const report = collectQubesResourceCalibration(events, {
    expectedGitSha: GIT_SHA,
    expectedTopologyId: TOPOLOGY.id,
    expectedWorkloadId: WORKLOAD_ID,
    requireWorkloadEvidence: true,
    minSamplesPerWorker: 5
  });

  assert.equal(report.workloadBound, true);
  assert.equal(report.workers.length, 2);
  assert.deepEqual(report.workers.map(worker => worker.id), ['coord-code-qa', 'system']);
  assert.deepEqual(report.workers.map(worker => worker.sampleCount), [5, 5]);
  assert.equal(report.workers.find(worker => worker.id === 'coord-code-qa').resources.vcpus, 2);
  assert.equal(report.workers.find(worker => worker.id === 'system').resources.vcpus, 1);
  assert.equal(transport.stores.get('coord-code-qa').state('integration-happy', WORKLOAD_ID).status, 'stopped');
  assert.equal(transport.stores.get('system').state('integration-happy', WORKLOAD_ID).status, 'stopped');

  const sampleOrder = events.filter(event => event.type === 'worker_resource_sample').map(event => event.workerId);
  assert.deepEqual(sampleOrder, Array.from({ length: 5 }, () => ['coord-code-qa', 'system']).flat());
});

test('partial distributed start rolls back every worker before calibration sampling begins', async () => {
  const { transport, hooks } = integrationFixture({ failStartWorker: 'system' });
  await assert.rejects(
    runQubesResourceCalibration({
      gitSha: GIT_SHA,
      topology: TOPOLOGY,
      runId: 'integration-start-failure',
      workloadId: WORKLOAD_ID,
      sampleCount: 3,
      intervalMs: 0,
      startWorkload: hooks.startWorkload,
      stopWorkload: hooks.stopWorkload,
      sampleWorker: async () => { throw new Error('sampling must not begin after failed start'); }
    }),
    /failed to start synthetic workload/
  );
  assert.deepEqual(transport.calls.map(call => `${call.action}:${call.workerId}`), [
    'start:coord-code-qa', 'start:system', 'stop:coord-code-qa', 'stop:system'
  ]);
  assert.equal(transport.stores.get('coord-code-qa').state('integration-start-failure', WORKLOAD_ID).status, 'stopped');
  assert.equal(transport.stores.get('system').state('integration-start-failure', WORKLOAD_ID), null);
});

test('probe failure still stops all successfully started workloads', async () => {
  const { transport, hooks } = integrationFixture();
  await assert.rejects(
    runQubesResourceCalibration({
      gitSha: GIT_SHA,
      topology: TOPOLOGY,
      runId: 'integration-probe-failure',
      workloadId: WORKLOAD_ID,
      sampleCount: 3,
      intervalMs: 0,
      startWorkload: hooks.startWorkload,
      stopWorkload: hooks.stopWorkload,
      sampleWorker: async worker => {
        if (worker.id === 'system') throw new Error('synthetic probe failure');
        return resourceSample(worker, 0);
      }
    }),
    /synthetic probe failure/
  );
  assert.equal(transport.stores.get('coord-code-qa').state('integration-probe-failure', WORKLOAD_ID).status, 'stopped');
  assert.equal(transport.stores.get('system').state('integration-probe-failure', WORKLOAD_ID).status, 'stopped');
  assert.equal(transport.calls.filter(call => call.action === 'stop').length, 2);
});

test('stop failure is fail-closed and all workers still receive a cleanup attempt', async () => {
  const { transport, hooks } = integrationFixture({ failStopWorker: 'system' });
  await assert.rejects(
    runQubesResourceCalibration({
      gitSha: GIT_SHA,
      topology: TOPOLOGY,
      runId: 'integration-stop-failure',
      workloadId: WORKLOAD_ID,
      sampleCount: 3,
      intervalMs: 0,
      startWorkload: hooks.startWorkload,
      stopWorkload: hooks.stopWorkload,
      sampleWorker: resourceSample
    }),
    /failed to stop synthetic workload on all workers/
  );
  assert.equal(transport.calls.filter(call => call.action === 'stop').length, 2);
  assert.equal(transport.stores.get('coord-code-qa').state('integration-stop-failure', WORKLOAD_ID).status, 'stopped');
  assert.equal(transport.stores.get('system').state('integration-stop-failure', WORKLOAD_ID).status, 'running');
});

test('collector rejects otherwise valid integration evidence when provenance binding is wrong', async () => {
  const { hooks } = integrationFixture();
  const events = await runQubesResourceCalibration({
    gitSha: GIT_SHA,
    topology: TOPOLOGY,
    runId: 'integration-collector-reject',
    workloadId: WORKLOAD_ID,
    sampleCount: 3,
    intervalMs: 0,
    startWorkload: hooks.startWorkload,
    stopWorkload: hooks.stopWorkload,
    sampleWorker: resourceSample
  });
  assert.throws(() => collectQubesResourceCalibration(events, {
    expectedGitSha: 'ffffffffffffffffffffffffffffffffffffffff',
    expectedTopologyId: TOPOLOGY.id,
    expectedWorkloadId: WORKLOAD_ID,
    requireWorkloadEvidence: true,
    minSamplesPerWorker: 3
  }), /git SHA mismatch/);
});
