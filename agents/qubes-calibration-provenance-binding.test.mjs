import assert from 'node:assert/strict';
import test from 'node:test';
import { bindCalibrationCampaignProvenance, validateCalibrationCampaignProvenance } from './qubes-calibration-provenance-binding.mjs';

const binding = { topologyId: 'two-worker-fused', calibrationEvidenceDigest: 'b'.repeat(64) };
const start = runId => ({ type: 'campaign_start', runId, transport: 'qrexec', sourceQube: 'worker', targetQube: 'coordinator', service: 'dig.Coordinator', gitSha: 'a'.repeat(40), startedAt: '2026-08-21T18:00:00.000Z' });
const campaign = runId => [JSON.stringify(start(runId)), JSON.stringify({ type: 'campaign_end', runId, finishedAt: '2026-08-21T18:00:01.000Z' })].join('\n');

test('campaign binding injects selected topology and calibration digest into raw campaign_start', () => {
  const bound = bindCalibrationCampaignProvenance(campaign('run-1'), binding);
  const event = JSON.parse(bound.split('\n')[0]);
  assert.equal(event.topologyId, binding.topologyId);
  assert.equal(event.calibrationEvidenceDigest, binding.calibrationEvidenceDigest);
  assert.deepEqual(validateCalibrationCampaignProvenance([bound], binding), { ...binding, campaignCount: 1, runIds: ['run-1'] });
});

test('binding is order-independent across runs but rejects missing legacy provenance', () => {
  const first = bindCalibrationCampaignProvenance(campaign('run-1'), binding);
  const second = bindCalibrationCampaignProvenance(campaign('run-2'), binding);
  assert.deepEqual(validateCalibrationCampaignProvenance([second, first], binding).runIds, ['run-2', 'run-1']);
  assert.throws(() => validateCalibrationCampaignProvenance([campaign('legacy')], binding), /topologyId/);
});

test('wrong topology, wrong digest, mixed evidence, and malformed digest fail closed', () => {
  const good = bindCalibrationCampaignProvenance(campaign('good'), binding);
  const wrongTopology = bindCalibrationCampaignProvenance(campaign('wrong-topology'), { ...binding, topologyId: 'four-worker-isolated' });
  const wrongDigest = bindCalibrationCampaignProvenance(campaign('wrong-digest'), { ...binding, calibrationEvidenceDigest: 'c'.repeat(64) });
  assert.throws(() => validateCalibrationCampaignProvenance([good, wrongTopology], binding), /topologyId does not match/);
  assert.throws(() => validateCalibrationCampaignProvenance([good, wrongDigest], binding), /digest does not match/);
  assert.throws(() => bindCalibrationCampaignProvenance(campaign('bad-digest'), { ...binding, calibrationEvidenceDigest: 'not-a-digest' }), /SHA-256/);
});

test('pre-existing conflicting provenance cannot be overwritten silently', () => {
  const conflicting = [JSON.stringify({ ...start('conflict'), topologyId: 'other', calibrationEvidenceDigest: binding.calibrationEvidenceDigest }), JSON.stringify({ type: 'campaign_end', runId: 'conflict', finishedAt: '2026-08-21T18:00:01.000Z' })].join('\n');
  assert.throws(() => bindCalibrationCampaignProvenance(conflicting, binding), /conflicts with calibrated selection/);
});
