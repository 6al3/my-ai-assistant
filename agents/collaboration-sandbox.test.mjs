import assert from 'node:assert/strict';
import test from 'node:test';
import { collaborationStages, createCollaborativePaymentDrill, claimCollaborativeMission } from './collaboration-sandbox.mjs';

test('collaboration drill is synthetic and isolated', () => {
  const drill = createCollaborativePaymentDrill({ caseId: 'visa-timeout', amountCents: 2500 });
  assert.equal(drill.missions.length, 10);
  assert.ok(drill.missions.every(m => m.metadata.networkAllowed === false));
  assert.ok(drill.missions.every(m => m.metadata.realCardsAllowed === false));
  assert.ok(drill.missions.every(m => m.metadata.syntheticToken.startsWith('TEST_')));
});

test('collaboration stages create dependency-driven interaction', () => {
  const { queue } = createCollaborativePaymentDrill({ caseId: 'visa-3ds' });
  assert.equal(queue.stats().blocked, 9);

  const planner = claimCollaborativeMission(queue, 'planner');
  assert.ok(planner);
  queue.complete(planner.id, 'collab-planner', { finding: 'synthetic plan complete' });

  const orchestrator = claimCollaborativeMission(queue, 'orchestrator');
  assert.ok(orchestrator);
  queue.complete(orchestrator.id, 'collab-orchestrator', { finding: 'coordination complete' });

  for (const id of ['coder', 'system', 'files', 'web']) {
    const mission = claimCollaborativeMission(queue, id);
    assert.ok(mission, `${id} should receive its stage`);
    queue.complete(mission.id, `collab-${id}`, { finding: `${id} synthetic finding` });
  }

  const memory = claimCollaborativeMission(queue, 'memory');
  const media = claimCollaborativeMission(queue, 'media');
  const audit = claimCollaborativeMission(queue, 'audit');
  assert.ok(memory && media && audit);

  queue.complete(memory.id, 'collab-memory');
  queue.complete(media.id, 'collab-media');
  queue.complete(audit.id, 'collab-audit');

  const qa = claimCollaborativeMission(queue, 'qa');
  assert.ok(qa);
  queue.complete(qa.id, 'collab-qa', { verdict: 'sandbox-only pass' });
  assert.equal(queue.stats().completed, 10);
});

test('stage definitions cover all registered collaboration roles once', () => {
  const stages = collaborationStages();
  assert.equal(stages.length, 10);
  assert.equal(new Set(stages.map(s => s.capability)).size, 10);
});

test('invalid collaborative drill input is rejected', () => {
  assert.throws(() => createCollaborativePaymentDrill({ caseId: 'missing' }), /unknown sandbox case/);
  assert.throws(() => createCollaborativePaymentDrill({ amountCents: 0 }), /positive integer/);
  assert.throws(() => createCollaborativePaymentDrill({ currency: 'usd' }), /3-letter uppercase/);
});
