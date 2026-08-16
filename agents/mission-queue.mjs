import { randomUUID } from 'node:crypto';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

export class MissionQueue {
  constructor({ maxAttempts = 3, leaseMs = 30_000, now = () => Date.now(), snapshot = null } = {}) {
    this.maxAttempts = maxAttempts;
    this.leaseMs = leaseMs;
    this.now = now;
    this.missions = new Map();
    this.idempotency = new Map();
    if (snapshot) this.restore(snapshot);
  }

  enqueue({ task, priority = 0, requiredCapabilities = [], dependsOn = [], metadata = {}, idempotencyKey = null }) {
    if (!task?.trim()) throw new Error('task is required');
    if (idempotencyKey && this.idempotency.has(idempotencyKey)) return this.get(this.idempotency.get(idempotencyKey));
    const dependencies = [...new Set(dependsOn)];
    for (const id of dependencies) if (!this.missions.has(id)) throw new Error(`dependency not found: ${id}`);
    const mission = { id: randomUUID(), task: task.trim(), priority, requiredCapabilities: [...new Set(requiredCapabilities)], dependsOn: dependencies, metadata, idempotencyKey, status: 'queued', attempts: 0, workerId: null, leaseUntil: null, createdAt: this.now(), updatedAt: this.now(), result: null, error: null };
    this.missions.set(mission.id, mission);
    if (idempotencyKey) this.idempotency.set(idempotencyKey, mission.id);
    return structuredClone(mission);
  }

  snapshot() { return { version: 1, missions: [...this.missions.values()].map(m => structuredClone(m)) }; }

  restore(snapshot) {
    if (snapshot?.version !== 1 || !Array.isArray(snapshot.missions)) throw new Error('unsupported mission queue snapshot');
    this.missions.clear(); this.idempotency.clear();
    for (const raw of snapshot.missions) {
      const mission = structuredClone(raw);
      if (!mission.id || !mission.task || !['queued','running','completed','failed','cancelled'].includes(mission.status)) throw new Error('invalid mission queue snapshot');
      if (mission.status === 'running') { mission.status = mission.attempts >= this.maxAttempts ? 'failed' : 'queued'; mission.workerId = null; mission.leaseUntil = null; mission.error = 'recovered after process restart'; mission.updatedAt = this.now(); }
      this.missions.set(mission.id, mission);
      if (mission.idempotencyKey) {
        if (this.idempotency.has(mission.idempotencyKey)) throw new Error('duplicate idempotency key in snapshot');
        this.idempotency.set(mission.idempotencyKey, mission.id);
      }
    }
    this.#propagateDependencyFailures();
  }

  claim(worker) {
    if (!worker?.id) throw new Error('worker id is required');
    this.requeueExpired(); this.#propagateDependencyFailures();
    const capabilities = new Set(worker.capabilities ?? []);
    const mission = [...this.missions.values()].filter(m => m.status === 'queued').filter(m => m.requiredCapabilities.every(c => capabilities.has(c))).filter(m => this.#dependenciesCompleted(m)).sort((a,b) => b.priority-a.priority || a.createdAt-b.createdAt)[0];
    if (!mission) return null;
    mission.status='running'; mission.workerId=worker.id; mission.attempts+=1; mission.leaseUntil=this.now()+this.leaseMs; mission.updatedAt=this.now();
    return structuredClone(mission);
  }
  heartbeat(id, workerId) { const m=this.#ownedRunning(id,workerId); m.leaseUntil=this.now()+this.leaseMs; m.updatedAt=this.now(); return structuredClone(m); }
  complete(id, workerId, result=null) { const m=this.#ownedRunning(id,workerId); m.status='completed'; m.result=result; m.leaseUntil=null; m.updatedAt=this.now(); return structuredClone(m); }
  fail(id, workerId, error) { const m=this.#ownedRunning(id,workerId); m.error=String(error??'unknown failure'); m.workerId=null; m.leaseUntil=null; m.updatedAt=this.now(); m.status=m.attempts>=this.maxAttempts?'failed':'queued'; if(m.status==='failed')this.#propagateDependencyFailures(); return structuredClone(m); }
  cancel(id, reason='cancelled') { const m=this.missions.get(id); if(!m)throw new Error('mission not found'); if(TERMINAL.has(m.status))throw new Error(`mission is ${m.status}`); m.status='cancelled';m.error=String(reason);m.workerId=null;m.leaseUntil=null;m.updatedAt=this.now();this.#propagateDependencyFailures();return structuredClone(m); }
  requeueExpired() { const now=this.now();let terminalized=false;for(const m of this.missions.values()){if(m.status!=='running'||m.leaseUntil>now)continue;m.workerId=null;m.leaseUntil=null;m.updatedAt=now;m.error='worker lease expired';m.status=m.attempts>=this.maxAttempts?'failed':'queued';terminalized ||= m.status==='failed';}if(terminalized)this.#propagateDependencyFailures(); }
  get(id){const m=this.missions.get(id);return m?structuredClone(m):null;}
  list({status}={}){return [...this.missions.values()].filter(m=>!status||m.status===status).map(m=>structuredClone(m));}
  stats(){this.#propagateDependencyFailures();const s={total:this.missions.size,queued:0,running:0,completed:0,failed:0,cancelled:0,blocked:0};for(const m of this.missions.values()){s[m.status]+=1;if(m.status==='queued'&&!this.#dependenciesCompleted(m))s.blocked+=1;}return s;}
  #dependenciesCompleted(m){return m.dependsOn.every(id=>this.missions.get(id)?.status==='completed');}
  #propagateDependencyFailures(){let changed=true;while(changed){changed=false;for(const m of this.missions.values()){if(m.status!=='queued')continue;const blocker=m.dependsOn.map(id=>this.missions.get(id)).find(d=>d&&(d.status==='failed'||d.status==='cancelled'));if(!blocker)continue;m.status='cancelled';m.error=`dependency ${blocker.id} ${blocker.status}`;m.workerId=null;m.leaseUntil=null;m.updatedAt=this.now();changed=true;}}}
  #ownedRunning(id,workerId){const m=this.missions.get(id);if(!m)throw new Error('mission not found');if(TERMINAL.has(m.status))throw new Error(`mission is ${m.status}`);if(m.status!=='running'||m.workerId!==workerId)throw new Error('mission is not owned by worker');return m;}
}
