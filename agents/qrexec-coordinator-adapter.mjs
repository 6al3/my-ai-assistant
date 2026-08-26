import { createHash } from 'node:crypto';
import { DurableRequestJournal, digestWorkerCommand } from './durable-request-journal.mjs';
import { withFileMutationLock } from './file-mutation-lock.mjs';
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

function requestLockPath(journalPath, requestId) {
  const key=createHash('sha256').update(requestId).digest('hex').slice(0,32);
  return `${journalPath}.request-${key}.lock`;
}

function rejectedResponse(op,error){
  return {ok:false,op,error:{code:'COORDINATOR_REJECTED',message:error instanceof Error?error.message:String(error)}};
}

export async function handleQrexecEnvelope(envelope,{secret,missionStorePath,journalPath,queueOptions={},attestationConfig,now=Date.now,requestLockOptions={},afterMutation=null}={}){
  const verified=new WorkerEnvelopeVerifier({secret,now}).verify(envelope);
  const body=validate(verified.op,verified.body);
  const digest=digestWorkerCommand({op:verified.op,body});
  if(typeof afterMutation!=='function'&&afterMutation!==null) throw new TypeError('afterMutation must be a function');

  // Serialize the full request lifecycle, not just journal writes. This prevents two
  // process-per-call qrexec invocations from executing the same request concurrently.
  // If a process dies after the mission mutation but before journal commit, the pending
  // journal record remains and the retry fails closed rather than re-applying the mutation.
  return withFileMutationLock(requestLockPath(journalPath,verified.requestId),async()=>{
    const journal=await DurableRequestJournal.open(journalPath);
    const existing=journal.get(verified.requestId);
    if(existing){
      if(existing.digest!==digest) throw new Error('requestId reused with different command');
      if(existing.status==='committed') return attestCoordinatorResponse(existing.response,attestationConfig,{requestId:verified.requestId});
      throw new Error('request outcome is indeterminate; reconciliation required');
    }

    await journal.begin({requestId:verified.requestId,digest});
    const coordinator=await MissionCoordinator.open({store:new MissionQueueStore(missionStorePath),queueOptions});
    let value;
    try {
      if(verified.op==='claim') value=await coordinator.claim(body);
      else if(verified.op==='heartbeat') value=await coordinator.heartbeat(body.missionId,body.workerId,body.leaseToken);
      else if(verified.op==='complete') value=await coordinator.complete(body.missionId,body.workerId,body.result,body.leaseToken);
      else value=await coordinator.fail(body.missionId,body.workerId,body.error,body.leaseToken);
    } catch(error) {
      const committed=await journal.commit(verified.requestId,rejectedResponse(verified.op,error));
      return attestCoordinatorResponse(committed.response,attestationConfig,{requestId:verified.requestId});
    }

    // Fault-injection seam for proving the mutation -> journal crash window. Production
    // callers leave this null. Throwing here intentionally leaves a pending request while
    // the mission mutation is already durable, so a retry must not execute it again.
    if(afterMutation) await afterMutation({requestId:verified.requestId,op:verified.op,body:structuredClone(body),value:structuredClone(value)});

    const response={ok:true,op:verified.op,value};
    const committed=await journal.commit(verified.requestId,response);
    return attestCoordinatorResponse(committed.response,attestationConfig,{requestId:verified.requestId});
  },requestLockOptions);
}
