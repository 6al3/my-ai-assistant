import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { signWorkerEnvelope } from './worker-transport-envelope.mjs';
import { handleQrexecEnvelope } from './qrexec-coordinator-adapter.mjs';
import { verifyCoordinatorResponseAttestation } from './qrexec-response-attestation.mjs';

const SECRET='0123456789abcdef0123456789abcdef', SHA='b'.repeat(40), SERVICE='dig.Coordinator', KEY='lab-key';
function keys(){const {privateKey,publicKey}=generateKeyPairSync('ed25519');return {attestationConfig:{privateKey,keyId:KEY,gitSha:SHA,service:SERVICE},publicKeyPem:publicKey.export({format:'pem',type:'spki'}).toString()};}

test('same authenticated request is durably idempotent across service processes', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dig-qrexec-')); try {
  const storePath=join(dir,'missions.json'), journalPath=join(dir,'requests.json'), k=keys();
  const c=await MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true}}); await c.enqueue({task:'synthetic defensive job',requiredCapabilities:['coder']});
  const env=signWorkerEnvelope({requestId:'req-claim-1',issuedAt:1800000000000,op:'claim',body:{workerId:'worker-a',capabilities:['coder'],sessionId:'s1'},secret:SECRET});
  const opts={secret:SECRET,missionStorePath:storePath,journalPath,queueOptions:{requireLeaseToken:true},attestationConfig:k.attestationConfig,now:()=>1800000000000};
  const first=await handleQrexecEnvelope(env,opts); const second=await handleQrexecEnvelope(env,opts);
  const a=verifyCoordinatorResponseAttestation(first,{publicKeyPem:k.publicKeyPem,expectedKeyId:KEY,expectedGitSha:SHA,expectedService:SERVICE,expectedRequestId:'req-claim-1'});
  const b=verifyCoordinatorResponseAttestation(second,{publicKeyPem:k.publicKeyPem,expectedKeyId:KEY,expectedGitSha:SHA,expectedService:SERVICE,expectedRequestId:'req-claim-1'});
  assert.deepEqual(b,a); assert.equal(a.value.status,'running');
 } finally {await rm(dir,{recursive:true,force:true});}
});

test('fenced mutations require the authenticated lease token', async()=>{
 const dir=await mkdtemp(join(tmpdir(),'dig-qrexec-')); try {
  const storePath=join(dir,'missions.json'), journalPath=join(dir,'requests.json'), k=keys();
  const c=await MissionCoordinator.open({store:new MissionQueueStore(storePath),queueOptions:{requireLeaseToken:true}}); await c.enqueue({task:'synthetic defensive job',requiredCapabilities:['coder']}); const claimed=await c.claim({workerId:'worker-a',capabilities:['coder'],sessionId:'s1'});
  const bad=signWorkerEnvelope({requestId:'req-heartbeat-bad',issuedAt:1800000000000,op:'heartbeat',body:{missionId:claimed.id,workerId:'worker-a',leaseToken:'stale-token'},secret:SECRET});
  await assert.rejects(()=>handleQrexecEnvelope(bad,{secret:SECRET,missionStorePath:storePath,journalPath,queueOptions:{requireLeaseToken:true},attestationConfig:k.attestationConfig,now:()=>1800000000000}),/lease|token|stale|owner/i);
 } finally {await rm(dir,{recursive:true,force:true});}
});
