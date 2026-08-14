import assert from 'node:assert/strict';
import {
  createMission,
  listMissions,
  claimNextMission,
  completeMission,
  failMission
} from '../agents/mission-queue.mjs';

const low = createMission({ goal: 'Review memory subsystem', priority: 10 });
const high = createMission({ goal: 'Debug and improve system service reliability', priority: 90 });
assert.equal(listMissions()[0].id, high.id);

const claimed = claimNextMission('worker-a');
assert.equal(claimed.id, high.id);
assert.equal(claimed.status, 'running');
assert.equal(claimed.attempts, 1);
assert.ok(claimed.plan.agents.some(a => a.id === 'system'));
assert.ok(claimed.plan.agents.some(a => a.id === 'qa'));

const retried = failMission(high.id, 'temporary_failure');
assert.equal(retried.status, 'queued');
const claimedAgain = claimNextMission('worker-b');
assert.equal(claimedAgain.id, high.id);
assert.equal(claimedAgain.attempts, 2);

const done = completeMission(high.id, { verified: true });
assert.equal(done.status, 'completed');
assert.equal(done.result.verified, true);
assert.equal(listMissions().find(m => m.id === low.id).status, 'queued');

console.log('mission-queue.test: ok');
