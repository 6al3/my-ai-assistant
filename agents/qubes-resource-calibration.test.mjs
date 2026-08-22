import assert from 'node:assert/strict';
import test from 'node:test';
import { applyQubesResourceCalibration, collectQubesResourceCalibration } from './qubes-resource-calibration.mjs';

const SHA = 'a'.repeat(40);
const topology = {
  id: 'two-worker-balanced',
  workers: [
    { id: 'coord-code-qa', capabilities: ['orchestrator', 'planner', 'coder', 'qa'] },
    { id: 'system', capabilities: ['system'] }
  ]
};

function events() {
  const rows = [{ type: 'calibration_start', runId: 'cal-1', gitSha: SHA, topologyId: topology.id }];
  for (const [ramMb, cpuPercent] of [[1200, 42], [1300, 55], [1250, 48]]) rows.push({ type: 'worker_resource_sample', runId: 'cal-1', workerId: 'coord-code-qa', capabilities: topology.workers[0].capabilities, ramMb, cpuPercent, vcpus: 2 });
  for (const [ramMb, cpuPercent] of [[700, 30], [760, 36], [740, 33]]) rows.push({ type: 'worker_resource_sample', runId: 'cal-1', workerId: 'system', capabilities: ['system'], ramMb, cpuPercent, vcpus: 1 });
  rows.push({ type: 'calibration_end', runId: 'cal-1' });
  return rows;
}

test('collects p95 Qubes resource profiles bound to SHA and topology', () => {
  const report = collectQubesResourceCalibration(events(), { expectedGitSha: SHA, expectedTopologyId: topology.id, minSamplesPerWorker: 3 });
  assert.equal(report.workers[0].id, 'coord-code-qa');
  assert.equal(report.workers[0].resources.ramMb, 1300);
  assert.equal(report.workers[0].resources.cpuP95Percent, 55);
  assert.equal(report.workers[1].resources.ramMb, 760);
  assert.match(report.digest, /^[a-f0-9]{64}$/);
  const calibrated = applyQubesResourceCalibration(topology, report);
  assert.equal(calibrated.workers[0].resources.ramMb, 1300);
  assert.equal(calibrated.workers[1].resources.vcpus, 1);
});

test('fails closed on mixed provenance, insufficient samples, and profile drift', () => {
  assert.throws(() => collectQubesResourceCalibration(events(), { expectedGitSha: 'b'.repeat(40), expectedTopologyId: topology.id }), /git SHA mismatch/);
  assert.throws(() => collectQubesResourceCalibration(events(), { expectedGitSha: SHA, expectedTopologyId: 'other' }), /topology mismatch/);
  assert.throws(() => collectQubesResourceCalibration(events(), { expectedGitSha: SHA, expectedTopologyId: topology.id, minSamplesPerWorker: 4 }), /insufficient resource samples/);
  const drift = events();
  drift[2] = { ...drift[2], vcpus: 3 };
  assert.throws(() => collectQubesResourceCalibration(drift, { expectedGitSha: SHA, expectedTopologyId: topology.id }), /profile changed/);
});

test('rejects malformed framing and topology application mismatches', () => {
  const raw = events();
  assert.throws(() => collectQubesResourceCalibration(raw.slice(1), { expectedGitSha: SHA, expectedTopologyId: topology.id }), /before calibration_start/);
  assert.throws(() => collectQubesResourceCalibration(raw.slice(0, -1), { expectedGitSha: SHA, expectedTopologyId: topology.id }), /did not end/);
  const report = collectQubesResourceCalibration(raw, { expectedGitSha: SHA, expectedTopologyId: topology.id });
  assert.throws(() => applyQubesResourceCalibration({ ...topology, id: 'wrong' }, report), /topology\/calibration mismatch/);
  assert.throws(() => applyQubesResourceCalibration({ id: topology.id, workers: [topology.workers[0]] }, report), /unexpected workers/);
});
