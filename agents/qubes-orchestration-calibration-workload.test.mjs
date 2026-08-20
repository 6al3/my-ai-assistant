import assert from 'node:assert/strict';
import test from 'node:test';
import { buildOrchestrationCalibrationPlan, createOrchestrationCalibrationHooks, sendWorkloadCommandViaQrexec } from './qubes-orchestration-calibration-workload.mjs';

const missions = [
  { id: 'o', requiredCapabilities: ['orchestrator'], dependsOn: [] },
  { id: 'p', requiredCapabilities: ['planner'], dependsOn: ['o'] },
  { id: 'c', requiredCapabilities: ['coder'], dependsOn: ['p'] },
  { id: 's', requiredCapabilities: ['system'], dependsOn: ['p'] },
  { id: 'q', requiredCapabilities: ['qa'], dependsOn: ['c', 's'] }
];
const durationsMs = { o: 20, p: 30, c: 80, s: 40, q: 40 };
const topology = {
  id: 'two-worker-balanced',
  workers: [
    { id: 'coord-code-qa', qube: 'dig-worker-a', capabilities: ['orchestrator', 'planner', 'coder', 'qa'] },
    { id: 'system', qube: 'dig-worker-b', capabilities: ['system'] }
  ]
};

test('builds workload schedules from the same constrained orchestration benchmark', () => {
  const plan = buildOrchestrationCalibrationPlan({ missions, durationsMs, topology });
  assert.equal(plan.topologyId, topology.id);
  assert.equal(plan.durationMs, 170);
  assert.equal(plan.metrics.peakConcurrentWorkers, 2);
  assert.deepEqual(plan.workers.find(worker => worker.workerId === 'system').schedule, [{ missionId: 's', startMs: 50, durationMs: 40 }]);
  assert.deepEqual(plan.workers.find(worker => worker.workerId === 'coord-code-qa').schedule.map(item => item.missionId), ['o', 'p', 'c', 'q']);
});

test('starts and stops the exact per-worker benchmark plan through bounded qrexec hooks', async () => {
  const plan = buildOrchestrationCalibrationPlan({ missions, durationsMs, topology, workloadId: 'dag-v1' });
  const calls = [];
  const hooks = createOrchestrationCalibrationHooks(plan, {
    service: 'dig.SyntheticWorkload',
    sendCommand: async (worker, command, options) => { calls.push({ worker: worker.workerId, command, options }); return { ok: true }; }
  });
  const context = { runId: 'run-1', workloadId: 'dag-v1', topology };
  await hooks.startWorkload(context);
  await hooks.stopWorkload(context);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.filter(call => call.command.action === 'start').map(call => call.worker).sort(), ['coord-code-qa', 'system']);
  assert.equal(calls.find(call => call.worker === 'system' && call.command.action === 'start').command.schedule[0].startMs, 50);
  assert.ok(calls.every(call => call.options.service === 'dig.SyntheticWorkload'));
});

test('qrexec workload transport is bounded and rejects malformed responses', async () => {
  const calls = [];
  const response = await sendWorkloadCommandViaQrexec({ workerId: 'w', qube: 'dig-worker-a' }, { action: 'stop' }, {
    service: 'dig.SyntheticWorkload',
    timeoutMs: 1200,
    execFileFn: async (command, args, options) => { calls.push({ command, args, options }); return { stdout: '{"ok":true}\n' }; }
  });
  assert.equal(response.ok, true);
  assert.deepEqual(calls[0].args, ['dig-worker-a', 'dig.SyntheticWorkload']);
  assert.match(calls[0].options.input, /"action":"stop"/);
  await assert.rejects(() => sendWorkloadCommandViaQrexec({ workerId: 'w', qube: 'dig-worker-a' }, { action: 'stop' }, {
    service: 'dig.SyntheticWorkload', execFileFn: async () => ({ stdout: 'not-json' })
  }), /invalid JSON/);
});

test('fails closed on workload/topology mismatch and missing worker capability coverage', async () => {
  assert.throws(() => buildOrchestrationCalibrationPlan({ missions, durationsMs, topology: { id: 'bad', workers: [{ id: 'only', capabilities: ['qa'] }] } }), /no worker satisfies mission/);
  const plan = buildOrchestrationCalibrationPlan({ missions, durationsMs, topology, workloadId: 'dag-v1' });
  const hooks = createOrchestrationCalibrationHooks(plan, { service: 'dig.SyntheticWorkload', sendCommand: async () => ({ ok: true }) });
  await assert.rejects(() => hooks.startWorkload({ runId: 'r', workloadId: 'other', topology }), /binding mismatch/);
});
