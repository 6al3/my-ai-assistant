import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const entrypoint = fileURLToPath(new URL('./orchestration-process-coordinator.mjs', import.meta.url));

class CoordinatorProcess {
  constructor(storePath) {
    this.storePath = storePath;
    this.child = null;
    this.lines = null;
    this.pending = [];
  }

  async start() {
    this.child = spawn(process.execPath, [entrypoint], {
      env: { ...process.env, DIG_ORCHESTRATION_STORE: this.storePath },
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on('line', line => {
      const waiter = this.pending.shift();
      if (!waiter) return;
      try { waiter.resolve(JSON.parse(line)); } catch (error) { waiter.reject(error); }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 30);
      this.child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`coordinator exited during startup: ${code}`));
      });
    });
    return this;
  }

  async request(command) {
    if (!this.child || this.child.exitCode !== null) throw new Error('coordinator is not running');
    const response = new Promise((resolve, reject) => this.pending.push({ resolve, reject }));
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
    const envelope = await response;
    if (!envelope.ok) throw new Error(envelope.error);
    return envelope.result;
  }

  sendWithoutWaiting(command) {
    if (!this.child || this.child.exitCode !== null) throw new Error('coordinator is not running');
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }

  async stop(signal = 'SIGTERM') {
    if (!this.child || this.child.exitCode !== null) return;
    this.child.kill(signal);
    await once(this.child, 'exit');
    this.lines?.close();
  }
}

const byAgent = missions => new Map(missions.map(mission => [mission.metadata.agentId, mission]));

async function completePhase(runtime, mission, workerId, capability) {
  const claim = await runtime.request({ op: 'claim', worker: { id: workerId, capabilities: [capability] } });
  assert.equal(claim.id, mission.id);
  return runtime.request({ op: 'complete', id: mission.id, workerId, result: { ok: true } });
}

test('process restart during specialist fan-out preserves committed result, reclaims interrupted work, rejects stale completion, and releases QA exactly once', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dig-orchestration-process-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storePath = path.join(root, 'missions.json');

  const first = await new CoordinatorProcess(storePath).start();
  t.after(() => first.stop().catch(() => {}));

  const submitted = await first.request({
    op: 'submit',
    text: 'plan project debug code and system reliability',
    options: { idempotencyKey: 'process-fault-job' }
  });
  const missions = byAgent(submitted.missions);
  const orchestrator = missions.get('orchestrator');
  const planner = missions.get('planner');
  const coder = missions.get('coder');
  const system = missions.get('system');
  const qa = missions.get('qa');
  assert.ok(orchestrator && planner && coder && system && qa);

  await completePhase(first, orchestrator, 'orchestrator@boot-1', 'orchestrator');
  await completePhase(first, planner, 'planner@boot-1', 'planner');

  const coderClaim = await first.request({ op: 'claim', worker: { id: 'coder@boot-1', capabilities: ['coder'] } });
  const systemClaim = await first.request({ op: 'claim', worker: { id: 'system@boot-1', capabilities: ['system'] } });
  assert.equal(coderClaim.id, coder.id);
  assert.equal(systemClaim.id, system.id);
  assert.equal(await first.request({ op: 'claim', worker: { id: 'qa@boot-1', capabilities: ['qa'] } }), null);

  first.sendWithoutWaiting({ op: 'completeAndExit', id: coder.id, workerId: 'coder@boot-1', result: { committedBeforeCrash: true } });
  await once(first.child, 'exit');

  const restarted = await new CoordinatorProcess(storePath).start();
  t.after(() => restarted.stop().catch(() => {}));

  const coderAfterRestart = await restarted.request({ op: 'get', id: coder.id });
  const systemAfterRestart = await restarted.request({ op: 'get', id: system.id });
  assert.equal(coderAfterRestart.status, 'completed', 'committed specialist result must survive response/process loss');
  assert.deepEqual(coderAfterRestart.result, { committedBeforeCrash: true });
  assert.equal(coderAfterRestart.attempts, 1, 'committed work must not execute twice');
  assert.equal(systemAfterRestart.status, 'queued', 'interrupted specialist must be recoverable');
  assert.equal(systemAfterRestart.attempts, 1);

  const retrySubmission = await restarted.request({
    op: 'submit',
    text: 'plan project debug code and system reliability retry',
    options: { idempotencyKey: 'process-fault-job' }
  });
  assert.deepEqual(retrySubmission.missions.map(x => x.id), submitted.missions.map(x => x.id));
  assert.equal((await restarted.request({ op: 'stats' })).total, submitted.missions.length);

  const reclaimed = await restarted.request({ op: 'claim', worker: { id: 'system@boot-2', capabilities: ['system'] } });
  assert.equal(reclaimed.id, system.id);
  assert.equal(reclaimed.attempts, 2);

  await assert.rejects(
    () => restarted.request({ op: 'complete', id: system.id, workerId: 'system@boot-1', result: { stale: true } }),
    /not owned/
  );
  await restarted.request({ op: 'complete', id: system.id, workerId: 'system@boot-2', result: { recovered: true } });

  const qaClaim = await restarted.request({ op: 'claim', worker: { id: 'qa@boot-2', capabilities: ['qa'] } });
  assert.equal(qaClaim.id, qa.id);
  assert.equal(qaClaim.attempts, 1);
  await restarted.request({ op: 'complete', id: qa.id, workerId: 'qa@boot-2', result: { reviewed: true } });

  const stats = await restarted.request({ op: 'stats' });
  assert.deepEqual(stats, { total: 5, queued: 0, running: 0, completed: 5, failed: 0, cancelled: 0, blocked: 0 });
  assert.equal((await restarted.request({ op: 'get', id: coder.id })).attempts, 1);
  assert.equal((await restarted.request({ op: 'get', id: system.id })).attempts, 2);
  assert.equal((await restarted.request({ op: 'get', id: qa.id })).attempts, 1);
});
