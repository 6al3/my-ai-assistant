import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { DurableRequestJournal } from './durable-request-journal.mjs';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';
import { handleQrexecEnvelope } from './qrexec-coordinator-adapter.mjs';
import { verifyCoordinatorResponseAttestation } from './qrexec-response-attestation.mjs';

const SECRET='0123456789abcdef0123456789abcdef', SHA='b'.repeat(40), SERVICE='dig.Coordinator', KEY='lab-key';
function keys(){const {privateKey,publicKey}=generateKeyPairSync('ed25519');return {attestationConfig:{privateKey,keyId:KEY,gitSha:SHA,service:SERVICE},publicKeyPem:publicKey.export({format:'pem',type:'spki'}).toString()};}
function verify(response,k,requestId){return verifyCoordinatorResponseAttestation(response,{publicKeyPem:k.publicKeyPem,expectedKeyId:KEY,expectedGitSha:SHA,expectedService:SERVICE,expectedRequestId:requestId});}

test('same authenticated request is durably idempotent across service processes', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dig-qrexec-')); try {
  const storePath=join(dir,'missions.json'), journalPath=join(dir,'requests.json'), k=keys();
  const c=await MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true}}); await c.enqueue({task:'synthetic defensive job',requiredCapabilities:['coder']});
  const env=signWorkerEnvelope({requestId:'req-claim-1',issuedAt:1800000000000,op:'claim',body:{workerId:'worker-a',capabilities:['coder'],sessionId:'s1'},secret:SECRET});
  const opts={secret:SECRET,missionStorePath:storePath,journalPath,queueOptions:{requireLeaseToken:true},attestationConfig:k.attestationConfig,now:()=>1800000000000};
  const first=await handleQrexecEnvelope(env,opts); const second=await handleQrexecEnvelope(env,opts);
  const a=verify(first,k,'req-claim-1'); const b=verify(second,k,'req-claim-1');
  assert.deepEqual(b,a); assert.equal(a.value.status,'running');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('concurrent duplicate request executes one mutation and reuses committed outcome', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dig-qrexec-')); try {
  const storePath=join(dir,'missions.json'), journalPath=join(dir,'requests.json'), k=keys();
  const c=await MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true}}); await c.enqueue({task:'one',requiredCapabilities:['coder']}); await c.enqueue({task:'two',requiredCapabilities:['coder']});
  const env=signWorkerEnvelope({requestId:'req-claim-concurrent',issuedAt:1800000000000,op:'claim',body:{workerId:'worker-a',capabilities:['coder'],sessionId:'s1'},secret:SECRET});
  const opts={secret:SECRET,missionStorePath:storePath,journalPath,queueOptions:{requireLeaseToken:true},attestationConfig:k.attestationConfig,now:()=>1800000000000};
  const [first,second]=await Promise.all([handleQrexecEnvelope(env,opts),handleQrexecEnvelope(env,opts)]);
  assert.deepEqual(verify(first,k,'req-claim-concurrent'),verify(second,k,'req-claim-concurrent'));
  const reopened=await MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true,preserveRunningLeasesOnRestore:true}});
  assert.equal(reopened.list({status:'running'}).length,1);
  assert.equal(reopened.list({status:'queued'}).length,1);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('coordinator rejection is durably committed as an attested response', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dig-qrexec-')); try {
  const storePath=join(dir,'missions.json'), journalPath=join(dir,'requests.json'), k=keys();
  const c=await MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true}}); await c.enqueue({task:'synthetic defensive job',requiredCapabilities:['coder']}); const claimed=await c.claim({workerId:'worker-a',capabilities:['coder'],sessionId:'s1'});
  const bad=signWorkerEnvelope({requestId:'req-heartbeat-bad',issuedAt:1800000000000,op:'heartbeat',body:{missionId:claimed.id,workerId:'worker-a',leaseToken:'stale-token'},secret:SECRET});
  const opts={secret:SECRET,missionStorePath:storePath,journalPath,queueOptions:{requireLeaseToken:true},attestationConfig:k.attestationConfig,now:()=>1800000000000};
  const first=verify(await handleQrexecEnvelope(bad,opts),k,'req-heartbeat-bad');
  const second=verify(await handleQrexecEnvelope(bad,opts),k,'req-heartbeat-bad');
  assert.equal(first.ok,false); assert.equal(first.error.code,'COORDINATOR_REJECTED'); assert.match(first.error.message,/lease|token|stale|owner/i); assert.deepEqual(second,first);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('crash after durable claim mutation remains indeterminate and retry does not claim twice', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dig-qrexec-')); try {
  const storePath=join(dir,'missions.json'), journalPath=join(dir,'requests.json'), k=keys();
  const c=await MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true}}); await c.enqueue({task:'one',requiredCapabilities:['coder']}); await c.enqueue({task:'two',requiredCapabilities:['coder']});
  const env=signWorkerEnvelope({requestId:'req-crash-window',issuedAt:1800000000000,op:'claim',body:{workerId:'worker-a',capabilities:['coder'],sessionId:'s1'},secret:SECRET});
  const opts={secret:SECRET,missionStorePath:storePath,journalPath,queueOptions:{requireLeaseToken:true},attestationConfig:k.attestationConfig,now:()=>1800000000000};
  await assert.rejects(()=>handleQrexecEnvelope(env,{...opts,afterMutation:()=>{throw new Error('synthetic crash after mutation');}}),/synthetic crash/);
  const afterCrash=await MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true,preserveRunningLeasesOnRestore:true}});
  assert.equal(afterCrash.list({status:'running'}).length,1); assert.equal(afterCrash.list({status:'queued'}).length,1);
  const journal=await DurableRequestJournal.open(journalPath); assert.equal(journal.get('req-crash-window').status,'pending');
  await assert.rejects(()=>handleQrexecEnvelope(env,opts),/indeterminate|reconciliation required/i);
  const afterRetry=await MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true,preserveRunningLeasesOnRestore:true}});
  assert.equal(afterRetry.list({status:'running'}).length,1); assert.equal(afterRetry.list({status:'queued'}).length,1);
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('pending complete is reconciled read-only from exact durable terminal postcondition', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dig-qrexec-')); try {
  const storePath=join(dir,'missions.json'), journalPath=join(dir,'requests.json'), k=keys();
  const c=await MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true}});
  await c.enqueue({task:'synthetic defensive job',requiredCapabilities:['coder']});
  const claimed=await c.claim({workerId:'worker-a',capabilities:['coder'],sessionId:'s1'});
  const result={status:'ok',details:{count:2,label:'synthetic'}};
  const env=signWorkerEnvelope({requestId:'req-complete-crash',issuedAt:1800000000000,op:'complete',body:{missionId:claimed.id,workerId:'worker-a',leaseToken:claimed.leaseToken,result},secret:SECRET});
  const opts={secret:SECRET,missionStorePath:storePath,journalPath,queueOptions:{requireLeaseToken:true},attestationConfig:k.attestationConfig,now:()=>1800000000000};
  await assert.rejects(()=>handleQrexecEnvelope(env,{...opts,afterMutation:()=>{throw new Error('synthetic crash after complete');}}),/synthetic crash after complete/);
  const pending=await DurableRequestJournal.open(journalPath); assert.equal(pending.get('req-complete-crash').status,'pending');
  const beforeRetry=await MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true}});
  const completedBefore=beforeRetry.get(claimed.id); assert.equal(completedBefore.status,'completed'); assert.deepEqual(completedBefore.result,result);
  const reconciled=verify(await handleQrexecEnvelope(env,opts),k,'req-complete-crash');
  assert.equal(reconciled.ok,true); assert.equal(reconciled.op,'complete'); assert.equal(reconciled.value.status,'completed'); assert.deepEqual(reconciled.value.result,result);
  const after=await DurableRequestJournal.open(journalPath); assert.equal(after.get('req-complete-crash').status,'committed');
  const reopened=await MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true}});
  assert.equal(reopened.list({status:'completed'}).length,1); assert.equal(reopened.stats().total,1);
 } finally {await rm(dir,{recursive:true,force:true});}
});
