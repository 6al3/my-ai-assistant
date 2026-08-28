import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQrexecTransportQualification, verifyQrexecTransportQualification } from './qrexec-transport-qualification.mjs';

const SHA='a'.repeat(40);
const RUNTIME={node:'v22.18.0',platform:'linux',arch:'x64'};
const GOOD={
  beforeMutation:{attestationVerified:true,duplicateMutations:0,durableEffectCount:0,journalStatus:'missing',outcome:'RETRY_EXECUTES_ONCE'},
  afterClaimMutation:{attestationVerified:true,duplicateMutations:0,durableEffectCount:1,journalStatus:'pending',outcome:'REQUEST_OUTCOME_INDETERMINATE'},
  afterHeartbeatMutation:{attestationVerified:true,duplicateMutations:0,durableEffectCount:1,journalStatus:'pending',outcome:'REQUEST_OUTCOME_INDETERMINATE'},
  afterFailMutation:{attestationVerified:true,duplicateMutations:0,durableEffectCount:1,journalStatus:'pending',outcome:'REQUEST_OUTCOME_INDETERMINATE'},
  afterCompleteMutation:{attestationVerified:true,duplicateMutations:0,durableEffectCount:1,journalStatus:'committed',outcome:'RECONCILED_COMPLETE'},
  afterJournalCommit:{attestationVerified:true,duplicateMutations:0,durableEffectCount:1,journalStatus:'committed',outcome:'REPLAY_COMMITTED'}
};

function build(scenarios=GOOD){return buildQrexecTransportQualification({gitSha:SHA,runtime:RUNTIME,scenarios,generatedAt:'2026-08-26T17:00:00.000Z',qualificationRunId:'run-transport-1'});}

test('qualification report is LAB READY only when every crash boundary passes',()=>{
 const report=build();
 assert.equal(report.readiness,'LAB READY');
 assert.equal(report.metrics.duplicateMutations,0);
 assert.equal(report.metrics.responseAttestationsVerified,true);
 assert.equal(report.evidenceDigest.length,64);
 assert.equal(verifyQrexecTransportQualification(report,{expectedGitSha:SHA}),report);
});

test('duplicate mutation makes qualification NOT READY even with valid attestation',()=>{
 const scenarios=structuredClone(GOOD);
 scenarios.afterClaimMutation.duplicateMutations=1;
 const report=build(scenarios);
 assert.equal(report.readiness,'NOT READY');
 assert.equal(report.checks.afterClaimMutation,false);
 assert.equal(report.metrics.duplicateMutations,1);
});

test('wrong crash outcome or missing attestation makes qualification NOT READY',()=>{
 const wrong=structuredClone(GOOD);
 wrong.afterHeartbeatMutation.outcome='REPLAY_COMMITTED';
 assert.equal(build(wrong).readiness,'NOT READY');
 const unsigned=structuredClone(GOOD);
 unsigned.afterFailMutation.attestationVerified=false;
 assert.equal(build(unsigned).readiness,'NOT READY');
});

test('qualification rejects missing and unexpected scenarios fail closed',()=>{
 const missing=structuredClone(GOOD); delete missing.afterFailMutation;
 assert.throws(()=>build(missing),/missing required scenario/);
 const extra={...structuredClone(GOOD),unknown:{attestationVerified:true,duplicateMutations:0,durableEffectCount:0,journalStatus:'missing',outcome:'none'}};
 assert.throws(()=>build(extra),/unexpected scenarios/);
});

test('qualification digest detects tampering and exact SHA mismatch',()=>{
 const report=build();
 const tampered=structuredClone(report);
 tampered.scenarios.afterCompleteMutation.durableEffectCount=2;
 assert.throws(()=>verifyQrexecTransportQualification(tampered),/digest mismatch/);
 assert.throws(()=>verifyQrexecTransportQualification(report,{expectedGitSha:'b'.repeat(40)}),/gitSha mismatch/);
});

test('qualification rejects false readiness even when digest is recomputed by rebuilding evidence',()=>{
 const bad=structuredClone(GOOD);
 bad.afterJournalCommit.journalStatus='pending';
 const report=build(bad);
 assert.equal(report.readiness,'NOT READY');
 assert.equal(report.checks.afterJournalCommit,false);
 assert.doesNotThrow(()=>verifyQrexecTransportQualification(report,{expectedGitSha:SHA}));
});
