import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { DurableRequestJournal } from './durable-request-journal.mjs';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';
import { verifyCoordinatorResponseAttestation } from './qrexec-response-attestation.mjs';

const SECRET='0123456789abcdef0123456789abcdef', SHA='d'.repeat(40), SERVICE='dig.Coordinator', KEY_ID='qrexec-crash-lab-key';
const ENTRY=new URL('./qrexec-service-process.mjs',import.meta.url), CRASH_ENTRY=new URL('./qrexec-service-process-crash-child.mjs',import.meta.url);
function keys(){const {privateKey,publicKey}=generateKeyPairSync('ed25519');return {privateKeyPem:privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKeyPem:publicKey.export({format:'pem',type:'spki'}).toString()};}
function serviceEnv({dir,privateKeyPem,crashPoint}){return {DIG_QREXEC_TRANSPORT_SECRET:SECRET,DIG_QREXEC_MISSION_STORE_PATH:join(dir,'missions.json'),DIG_QREXEC_REQUEST_JOURNAL_PATH:join(dir,'requests.json'),DIG_QREXEC_ATTESTATION_PRIVATE_KEY_B64:Buffer.from(privateKeyPem).toString('base64'),DIG_QREXEC_ATTESTATION_KEY_ID:KEY_ID,DIG_QREXEC_GIT_SHA:SHA,DIG_QREXEC_SERVICE:SERVICE,...(crashPoint?{DIG_TEST_QREXEC_CRASH_POINT:crashPoint}:{})};}
function spawnEntry(entry,{env,envelope}){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[entry.pathname],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});const out=[],err=[];child.stdout.on('data',x=>out.push(x));child.stderr.on('data',x=>err.push(x));child.on('error',reject);child.on('close',(code,signal)=>resolve({code,signal,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString()}));child.stdin.end(JSON.stringify(envelope));});}
function verify(stdout,pem,requestId){const lines=stdout.trimEnd().split('\n');assert.equal(lines.length,1);return verifyCoordinatorResponseAttestation(JSON.parse(lines[0]),{publicKeyPem:pem,expectedKeyId:KEY_ID,expectedGitSha:SHA,expectedService:SERVICE,expectedRequestId:requestId});}
function assertIndeterminate(r,op){assert.equal(r.ok,false);assert.equal(r.op,op);assert.equal(r.error.code,'REQUEST_OUTCOME_INDETERMINATE');assert.equal(r.error.retryable,false);assert.equal(r.error.reconciliationRequired,true);}
async function openCoordinator(storePath,extra={}){return MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true,preserveRunningLeasesOnRestore:true,...extra}});}
async function seed(c,count=1){const ms=[];for(let i=0;i<count;i++)ms.push(await c.enqueue({task:`synthetic defensive qrexec crash job ${i+1}`,requiredCapabilities:['coder']}));return ms;}
function envelope(requestId,op,body){return signWorkerEnvelope({requestId,issuedAt:Date.now(),op,body,secret:SECRET});}

async function setupRunning(dir,k){const env=serviceEnv({dir,privateKeyPem:k.privateKeyPem});const c=await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);await seed(c,1);const claimed=await c.claim({workerId:'worker-a',capabilities:['coder'],sessionId:'s1'});return {env,claimed};}

for(const op of ['heartbeat','fail']){
 test(`process death after durable ${op} mutation yields attested indeterminate retry without duplicate mutation`,async()=>{
  const dir=await mkdtemp(join(tmpdir(),`dig-qrexec-${op}-crash-`));try{
   const k=keys(),{env,claimed}=await setupRunning(dir,k);const requestId=`process-crash-after-${op}`;
   const body={missionId:claimed.id,workerId:'worker-a',leaseToken:claimed.leaseToken,...(op==='fail'?{error:'synthetic defensive failure'}:{})};const req=envelope(requestId,op,body);
   const crashed=await spawnEntry(CRASH_ENTRY,{env:serviceEnv({dir,privateKeyPem:k.privateKeyPem,crashPoint:'after-mutation'}),envelope:req});assert.equal(crashed.code,86);assert.equal(crashed.stdout,'');
   const journal=await DurableRequestJournal.open(env.DIG_QREXEC_REQUEST_JOURNAL_PATH);assert.equal(journal.get(requestId).status,'pending');
   const before=await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);const snapshot=before.get(claimed.id);if(op==='heartbeat')assert.equal(snapshot.status,'running');else assert.equal(snapshot.status,'failed');
   const retry=await spawnEntry(ENTRY,{env,envelope:req});assert.equal(retry.code,0,retry.stderr);assertIndeterminate(verify(retry.stdout,k.publicKeyPem,requestId),op);
   const after=await openCoordinator(env.DIG_QREXEC_MISSION_STORE_PATH);assert.deepEqual(after.get(claimed.id),snapshot);assert.equal((await DurableRequestJournal.open(env.DIG_QREXEC_REQUEST_JOURNAL_PATH)).get(requestId).status,'pending');
  }finally{await rm(dir,{recursive:true,force:true});}
 });
}

test('process death after durable complete is reconciled read-only through spawned service boundary',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dig-qrexec-complete-crash-'));try{const k=keys(),{env,claimed}=await setupRunning(dir,k);const result={status:'ok',source:'synthetic-qrexec-process-crash'},requestId='process-crash-complete';const req=envelope(requestId,'complete',{missionId:claimed.id,workerId:'worker-a',leaseToken:claimed.leaseToken,result});const crashed=await spawnEntry(CRASH_ENTRY,{env:serviceEnv({dir,privateKeyPem:k.privateKeyPem,crashPoint:'after-mutation'}),envelope:req});assert.equal(crashed.code,86);const retry=await spawnEntry(ENTRY,{env,envelope:req});assert.equal(retry.code,0,retry.stderr);const r=verify(retry.stdout,k.publicKeyPem,requestId);assert.equal(r.ok,true);assert.equal(r.op,'complete');assert.deepEqual(r.value.result,result);assert.equal((await DurableRequestJournal.open(env.DIG_QREXEC_REQUEST_JOURNAL_PATH)).get(requestId).status,'committed');}finally{await rm(dir,{recursive:true,force:true});}
});
