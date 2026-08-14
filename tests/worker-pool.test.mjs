import assert from 'node:assert/strict';
import { registerWorker, heartbeatWorker, getWorker, resetWorkersForTest } from '../workers/worker-registry.mjs';
import { selectWorker, reserveWorker, releaseWorker } from '../workers/scheduler.mjs';

resetWorkersForTest();
registerWorker({ id: 'hp-1', capabilities: ['inference', 'coding'], maxConcurrent: 2, activeJobs: 0 });
registerWorker({ id: 'hp-2', capabilities: ['inference', 'media'], maxConcurrent: 4, activeJobs: 2 });
registerWorker({ id: 'qubes', capabilities: ['control', 'system'], maxConcurrent: 1, activeJobs: 0 });

assert.equal(selectWorker(['coding'])?.id, 'hp-1');
assert.equal(selectWorker(['media'])?.id, 'hp-2');
assert.equal(selectWorker(['control'])?.id, 'qubes');
assert.equal(selectWorker(['nonexistent']), null);

const reserved = reserveWorker(['coding']);
assert.equal(reserved?.id, 'hp-1');
assert.equal(getWorker('hp-1')?.activeJobs, 1);
releaseWorker('hp-1');
assert.equal(getWorker('hp-1')?.activeJobs, 0);

const hb = heartbeatWorker('hp-2', { activeJobs: 1, capabilities: ['inference', 'media', 'benchmark'] });
assert.equal(hb?.activeJobs, 1);
assert.ok(hb?.capabilities.includes('benchmark'));

console.log('worker-pool tests passed');
