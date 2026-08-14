import assert from 'node:assert/strict';
import {
  createMission,
  listMissions,
  claimNextMission,
  heartbeatMission,
  completeMission,
  failMission,
  recoverExpiredLeases
} from '../agents/mission-queue.mjs';

const suffix = Date.now();
const low = createMission({ goal: `Review memory subsystem ${suffix}`, priority: 10 });
const high = createMission({ goal: `Debug and improve system service reliability ${suffix}`, priority: 90 });
assert.equal(listMissions()[0].id, high.id);

const claimed = claimNextMission('worker-a', 60_000);
assert.equal(claimed.id, high.id);
assert.equal(claimed.status, 'running');
assert.equal(claimed.attempts, 1);
assert.ok(claimed.leaseToken);
assert.ok(claimed.leaseExpiresAt);
assert.ok(claimed.plan.agents.some(a => a.id === 'system'));
assert.ok(claimed.plan.agents.some(a => a.id === 'qa'));

assert.throws(
  () => heartbeatMission(high.id, 'worker-b', claimed.leaseToken),
  /worker_mismatch/
);
const heartbeated = heartbeatMission(high.id, 'worker-a', claimed.leaseToken, 60_000);
assert.equal(heartbeated.workerId, 'worker-a');

const retried = failMission(high.id, 'temporary_failure', 'worker-a', claimed.leaseToken);
assert.equal(retried.status, 'queued');
const claimedAgain = claimNextMission('worker-b', 60_000);
assert.equal(claimedAgain.id, high.id);
assert.equal(claimedAgain.attempts, 2);

const recoveredCount = recoverExpiredLeases(Date.parse(claimedAgain.leaseExpiresAt) + 1);
assert.ok(recoveredCount >= 1);
const recovered = listMissions().find(m => m.id === high.id);
assert.equal(recovered.status, 'queued');
assert.equal(recovered.lastError, 'worker_lease_expired');

const finalClaim = claimNextMission('worker-c', 60_000);
assert.equal(finalClaim.id, high.id);
const done = completeMission(high.id, { verified: true }, 'worker-c', finalClaim.leaseToken);
assert.equal(done.status, 'completed');
assert.equal(done.result.verified, true);
assert.equal(listMissions().find(m => m.id === low.id).status, 'queued');

console.log('mission-queue.test: ok');
