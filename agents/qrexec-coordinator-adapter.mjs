import { DurableRequestJournal, digestWorkerCommand } from './durable-request-journal.mjs';
import { MissionCoordinator } from './mission-coordinator.mjs';
import { MissionQueueStore } from './mission-queue-store.mjs';
import { WorkerEnvelopeVerifier } from './worker-transport-envelope.mjs';
import { attestCoordinatorResponse } from './qrexec-response-attestation.mjs';

const OPS = new Set(['claim', 'heartbeat', 'complete', 'fail']);
function text(v,n){if(typeof v!=='string'||!v.trim())throw new Error(`${n} is required`);return v.trim();}
function validate(op, body={}) {
  if (!OPS.has(op)) throw new Error('unsupported coordinator operation');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('request body must be an object');
  if (op === 'claim') return { workerId:text(body.workerId,'workerId'), capabilities:Array.isArray(body.capabilities)?body.capabilities:[], sessionId:body.sessionId??null };
  const common={ missionId:text(body.missionId,'missionId'), workerId:text(body.workerId,'workerId'), leaseToken:text(body.leaseToken,'leaseToken') };
  if(op==='complete') return {...common,result:body.result??null};
  if(op==='fail') return {...common,error:text(body.error,'error')};
  return common;
}

export async function handleQrexecEnvelope(envelope,{secret,missionStorePath,journalPath,queueOptions={},attestationConfig,now=Date.now}={}){
  const verified=new WorkerEnvelopeVerifier({secret,now}).verify(envelope);
  const body=validate(verified.op,verified.body);
  const digest=digestWorkerCommand({op:verified.op,body});
  const journal=await DurableRequestJournal.open(journalPath);
  const entry=await journal.begin({requestId:verified.requestId,digest});
  if(entry.status==='committed') return attestCoordinatorResponse(entry.response,attestationConfig,{requestId:verified.requestId});

  const coordinator=await MissionCoordinator.open({store:new MissionQueueStore(missionStorePath),queueOptions});
  let value;
  if(verified.op==='claim') value=await coordinator.claim(body);
  else if(verified.op==='heartbeat') value=await coordinator.heartbeat(body.missionId,body.workerId,body.leaseToken);
  else if(verified.op==='complete') value=await coordinator.complete(body.missionId,body.workerId,body.result,body.leaseToken);
  else value=await coordinator.fail(body.missionId,body.workerId,body.error,body.leaseToken);
  const response={ok:true,op:verified.op,value};
  const committed=await journal.commit(verified.requestId,response);
  return attestCoordinatorResponse(committed.response,attestationConfig,{requestId:verified.requestId});
}
