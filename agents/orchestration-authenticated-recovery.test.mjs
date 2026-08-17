import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';

const entrypoint = fileURLToPath(new URL('./orchestration-process-coordinator.mjs', import.meta.url));
const secret = 'dig-lab-transport-secret-0123456789abcdef';

class SignedCoordinatorProcess {
  constructor({ storePath, journalPath, crashAfterRequestId = null }) { this.storePath=storePath; this.journalPath=journalPath; this.crashAfterRequestId=crashAfterRequestId; this.child=null; this.lines=null; this.pending=[]; }
  async start() {
    this.child=spawn(process.execPath,[entrypoint],{env:{...process.env,DIG_ORCHESTRATION_STORE:this.storePath,DIG_REQUEST_JOURNAL:this.journalPath,DIG_TRANSPORT_SECRET:secret,...(this.crashAfterRequestId?{DIG_CRASH_AFTER_REQUEST_ID:this.crashAfterRequestId}:{})},stdio:['pipe','pipe','pipe']});
    this.lines=readline.createInterface({input:this.child.stdout}); this.lines.on('line',line=>{const waiter=this.pending.shift();if(!waiter)return;try{waiter.resolve(JSON.parse(line));}catch(error){waiter.reject(error);}});
    await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,30);this.child.once('exit',code=>{clearTimeout(timer);reject(new Error(`coordinator exited during startup: ${code}`));});}); return this;
  }
  envelope(requestId,op,body=null,overrides={}){return signWorkerEnvelope({requestId,op,body,secret,...overrides});}
  async requestEnvelope(envelope){const response=new Promise((resolve,reject)=>this.pending.push({resolve,reject}));this.child.stdin.write(`${JSON.stringify(envelope)}\n`);const message=await response;if(!message.ok)throw new Error(message.error);return message.result;}
  request(requestId,op,body=null){return this.requestEnvelope(this.envelope(requestId,op,body));}
  sendEnvelope(envelope){this.child.stdin.write(`${JSON.stringify(envelope)}\n`);}
  async stop(signal='SIGTERM'){if(!this.child||this.child.exitCode!==null)return;this.child.kill(signal);await once(this.child,'exit');this.lines?.close();}
}

const byAgent=missions=>new Map(missions.map(mission=>[mission.metadata.agentId,mission]));

test('authenticated retry after coordinator crash returns committed completion without duplicate mutation and enforces lease fencing', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'dig-auth-recovery-')); t.after(()=>rm(root,{recursive:true,force:true})); const storePath=path.join(root,'missions.json'); const journalPath=path.join(root,'requests.json'); const crashRequestId='complete-coder-once';
  const first=await new SignedCoordinatorProcess({storePath,journalPath,crashAfterRequestId}).start(); t.after(()=>first.stop().catch(()=>{}));
  const submitted=await first.request('submit-1','submit',{text:'plan project debug code and system reliability',options:{idempotencyKey:'auth-recovery-job'}}); const missions=byAgent(submitted.missions); const orchestrator=missions.get('orchestrator'); const planner=missions.get('planner'); const coder=missions.get('coder'); assert.ok(orchestrator&&planner&&coder);
  const orchestratorClaim=await first.request('claim-orchestrator','claim',{worker:{id:'orchestrator@1',capabilities:['orchestrator']}}); assert.equal(orchestratorClaim.id,orchestrator.id); assert.ok(orchestratorClaim.leaseToken);
  await first.request('complete-orchestrator','complete',{id:orchestrator.id,workerId:'orchestrator@1',leaseToken:orchestratorClaim.leaseToken,result:{ok:true}});
  const plannerClaim=await first.request('claim-planner','claim',{worker:{id:'planner@1',capabilities:['planner']}}); assert.equal(plannerClaim.id,planner.id);
  await first.request('complete-planner','complete',{id:planner.id,workerId:'planner@1',leaseToken:plannerClaim.leaseToken,result:{ok:true}});
  const coderClaim=await first.request('claim-coder','claim',{worker:{id:'coder@1',capabilities:['coder']}}); assert.equal(coderClaim.id,coder.id); assert.ok(coderClaim.leaseToken);
  await assert.rejects(()=>first.request('complete-coder-stale','complete',{id:coder.id,workerId:'coder@1',leaseToken:'00000000000000000000000000000000',result:{synthetic:7}}),/stale or missing/);
  await assert.rejects(()=>first.request('complete-coder-missing-token','complete',{id:coder.id,workerId:'coder@1',result:{synthetic:7}}),/leaseToken is required/);
  const completionBody={id:coder.id,workerId:'coder@1',leaseToken:coderClaim.leaseToken,result:{synthetic:7}}; const originalEnvelope=first.envelope(crashRequestId,'complete',completionBody); first.sendEnvelope(originalEnvelope); const [exitCode]=await once(first.child,'exit'); assert.equal(exitCode,86);
  const restarted=await new SignedCoordinatorProcess({storePath,journalPath}).start(); t.after(()=>restarted.stop().catch(()=>{})); const beforeRetry=await restarted.request('get-before-retry','get',{id:coder.id}); assert.equal(beforeRetry.status,'completed'); assert.equal(beforeRetry.attempts,1); assert.deepEqual(beforeRetry.result,{synthetic:7});
  const retryResult=await restarted.requestEnvelope(restarted.envelope(crashRequestId,'complete',completionBody)); assert.equal(retryResult.id,coder.id); assert.equal(retryResult.attempts,1); assert.deepEqual(retryResult.result,{synthetic:7});
  const cachedRetry=await restarted.requestEnvelope(restarted.envelope(crashRequestId,'complete',completionBody)); assert.deepEqual(cachedRetry,retryResult);
  await assert.rejects(()=>restarted.requestEnvelope(restarted.envelope(crashRequestId,'complete',{...completionBody,result:{synthetic:8}})),/different command/);
  const tampered=restarted.envelope('tampered-1','get',{id:coder.id}); tampered.body.id='changed-after-signing'; await assert.rejects(()=>restarted.requestEnvelope(tampered),/authentication failed/);
  const finalMission=await restarted.request('get-final','get',{id:coder.id}); assert.equal(finalMission.attempts,1); assert.deepEqual(finalMission.result,{synthetic:7});
});
