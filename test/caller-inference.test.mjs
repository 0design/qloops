import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { runAgent } from '../src/agent.mjs';
import { runContentRequest } from '../src/content-runner.mjs';
import { hash } from '../src/contracts.mjs';
const provider={kind:'caller',agent:'codex',model:'current-session',payerScope:'local-cli'};
const spec={summary:'Implement add',criteria:['Positive and negative addition passes the independent checker'],plan:['Edit value.mjs only']};
function setup(t,extra={}) {
  const workspace=mkdtempSync(join(tmpdir(),'qf-caller-'));t.after(()=>rmSync(workspace,{recursive:true,force:true}));
  writeFileSync(join(workspace,'value.mjs'),'export const add=()=>0;\n');
  writeFileSync(join(workspace,'verify.mjs'),"import assert from 'node:assert/strict';import {add} from './value.mjs';assert.equal(add(2,3),5);assert.equal(add(-2,1),-1);\n");
  return {protocolVersion:'qf.agent/v1',requestId:'caller-test',loop:{id:'sdd-pipeline',version:'1.0.0'},intent:'Implement numeric add',workspace,allowedPaths:['value.mjs'],allowedTools:[process.execPath],verifier:{command:process.execPath,args:['verify.mjs']},provider,deadlineMs:3000,maxRepairAttempts:1,...extra};
}
const answer=(result,output)=>({jobId:result.nextAction.job.jobId,hash:result.nextAction.job.hash,output});
const files=content=>({files:[{path:'value.mjs',content}]});

test('caller SDD uses real verifier fail -> bounded repair -> pass; replies are single-use and not approval',async t=>{
  let r=setup(t);const verifierHash=hash(readFileSync(join(r.workspace,'verify.mjs')));
  const first=await runAgent(r,{generate:()=>{throw Error('must not call another model');}});
  assert.equal(first.nextAction.type,'provide_inference');r={...r,resumeRunId:first.runId};
  const poll=await runAgent(r);assert.deepEqual(poll.nextAction.job,first.nextAction.job);
  const drafted=await runAgent({...r,inferenceReply:answer(first,spec)});
  assert.equal(drafted.nextAction.type,'approve_spec');
  assert.equal(readFileSync(join(r.workspace,'value.mjs'),'utf8'),'export const add=()=>0;\n');
  r.approval={hash:drafted.nextAction.hash,decision:'approve'};
  const work=await runAgent(r);assert.equal(work.nextAction.job.outputKind,'files');
  const repair=await runAgent({...r,inferenceReply:answer(work,files('export const add=()=>0;\n'))});
  assert.equal(repair.nextAction.type,'provide_inference');assert.equal(repair.evidence[0].exitCode,1);
  assert.equal(repair.nextAction.job.artifactRevision,1);
  assert.notEqual(repair.nextAction.job.jobId,work.nextAction.job.jobId);
  const stale=await runAgent({...r,inferenceReply:answer(work,files('export const add=(a,b)=>a+b;\n'))});
  assert.equal(stale.error.code,'STALE_INFERENCE');
  const done=await runAgent({...r,inferenceReply:answer(repair,files('export const add=(a,b)=>a+b;\n'))});
  assert.equal(done.status,'success');assert.deepEqual(done.evidence.map(e=>e.exitCode),[1,0]);
  assert.equal(done.provider.kind,'caller');assert.equal(done.provider.model,null);assert.equal(done.provider.requestedModel,'current-session');
  assert.deepEqual(done.usage,{tokensIn:null,tokensOut:null,costUsd:null});
  assert.equal((await runAgent({...r,inferenceReply:answer(repair,files('export const add=()=>99;'))})).error.code,'STALE_INFERENCE');
  assert.equal((await runAgent(r)).status,'success');assert.equal(hash(readFileSync(join(r.workspace,'verify.mjs'))),verifierHash);
});

test('caller job refuses wrong hash, extra claims, changed scope, verifier and file context without consumption',async t=>{
  const r=setup(t),first=await runAgent(r),resume={...r,resumeRunId:first.runId};
  assert.equal((await runAgent({...resume,inferenceReply:{...answer(first,spec),hash:'0'.repeat(64)}})).error.code,'STALE_INFERENCE');
  assert.equal((await runAgent({...resume,inferenceReply:answer(first,{...spec,status:'success'})})).error.code,'INVALID_RESPONSE');
  assert.equal((await runAgent({...resume,allowedPaths:['other.mjs'],inferenceReply:answer(first,spec)})).error.code,'WORKSPACE_CHANGED');
  const original=readFileSync(join(r.workspace,'verify.mjs'));
  writeFileSync(join(r.workspace,'verify.mjs'),'process.exit(0);');
  assert.equal((await runAgent({...resume,inferenceReply:answer(first,spec)})).error.code,'WORKSPACE_CHANGED');
  writeFileSync(join(r.workspace,'verify.mjs'),original);
  writeFileSync(join(r.workspace,'value.mjs'),'export const add=()=>123;');
  assert.equal((await runAgent({...resume,inferenceReply:answer(first,spec)})).error.code,'STALE_INFERENCE');
  writeFileSync(join(r.workspace,'value.mjs'),'export const add=()=>0;\n');
  assert.equal((await runAgent({...resume,inferenceReply:answer(first,spec)})).nextAction.type,'approve_spec');
});

test('caller cancellation invalidates the pending job and enforces the total job budget',async t=>{
  const r=setup(t,{maxInferenceJobs:2}),first=await runAgent(r),resume={...r,resumeRunId:first.runId};
  const {jobId,hash:h}=first.nextAction.job;
  assert.equal((await runAgent({...resume,cancelInference:{jobId,hash:h}})).status,'cancelled');
  assert.equal((await runAgent({...resume,inferenceReply:answer(first,spec)})).error.code,'STALE_INFERENCE');
  const second=await runAgent(resume);assert.notEqual(second.nextAction.job.jobId,jobId);
  const a=await runAgent({...resume,inferenceReply:answer(second,spec)});
  assert.equal(a.nextAction.type,'approve_spec');
  assert.equal((await runAgent({...resume,approval:{hash:a.nextAction.hash,decision:'approve'}})).error.code,'BUDGET_EXHAUSTED');
});

test('caller expiry, unknown-cost cap, and signal cancellation never produce generation or success',async t=>{
  const r=setup(t,{inferenceTtlMs:1}),first=await runAgent(r);
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await runAgent({...r,resumeRunId:first.runId,inferenceReply:answer(first,spec)})).error.code,'INFERENCE_EXPIRED');
  assert.equal((await runAgent({...setup(t),maxCostUsd:1,maxCallCostUsd:1})).error.code,'BUDGET_EXHAUSTED');
  const cancel=setup(t),job=await runAgent(cancel),ac=new AbortController();ac.abort();
  assert.equal((await runAgent({...cancel,resumeRunId:job.runId},{signal:ac.signal})).status,'cancelled');
  assert.equal((await runAgent({...cancel,resumeRunId:job.runId,inferenceReply:answer(job,spec)})).error.code,'STALE_INFERENCE');
});

test('caller repair cap is independent of the generation job cap',async t=>{
  const r=setup(t,{specification:spec,maxRepairAttempts:0}),a=await runAgent(r);
  const resume={...r,resumeRunId:a.runId,approval:{hash:a.nextAction.hash,decision:'approve'}};
  const job=await runAgent(resume);
  const stopped=await runAgent({...resume,inferenceReply:answer(job,files('export const add=()=>0;'))});
  assert.equal(stopped.nextAction.type,'review_failure');assert.equal(stopped.evidence[0].exitCode,1);
  assert.equal((await runAgent(resume)).nextAction.type,'review_failure');
});

test('caller Content requires exact approval and keeps receipt/dedup separate from inference',async t=>{
  const workspace=setup(t).workspace;let sends=0,reads=0;let source='Synthetic source one';
  const server=createServer(async(req,res)=>{
    if(req.method==='GET'){reads++;return res.end(source);}
    let body='';for await(const x of req)body+=x;
    assert.equal(JSON.parse(body).text,`Synthetic digest ${origin}/source`);assert.match(req.headers['idempotency-key'],/^[a-f0-9]{64}$/);
    sends++;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'receipt1',delivered:true}));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const r={protocolVersion:'qf.content-request/v1',requestId:'caller-content',workspace,provider,deadlineMs:3000,allowedOrigins:[origin],sources:[{id:'one',url:origin+'/source'}],profile:{tone:'synthetic'},receiver:{kind:'webhook',id:'test',url:origin+'/receipt'}};
  const first=await runContentRequest(r);assert.equal(first.nextAction.job.outputKind,'content');
  const output={text:`Synthetic digest ${origin}/source`};
  source='Changed source';assert.equal((await runContentRequest({...r,inferenceReply:answer(first,output)})).error.code,'STALE_INFERENCE');
  source='Synthetic source one';
  const draft=await runContentRequest({...r,inferenceReply:answer(first,output)});assert.equal(draft.nextAction.type,'approve_publication');assert.equal(sends,0);
  assert.equal((await runContentRequest({...r,inferenceReply:answer(first,output)})).error.code,'STALE_INFERENCE');
  const done=await runContentRequest({...r,approval:{hash:draft.nextAction.hash,decision:'approve'}});assert.equal(done.status,'success');assert.equal(sends,1);
  assert.equal((await runContentRequest(r)).nextAction.type,'no_new_sources');assert.equal(sends,1);
  const next={...r,sources:[{id:'two',url:origin+'/source2'}]};const job=await runContentRequest(next);
  const before=reads;const {jobId,hash:h}=job.nextAction.job;
  const cancel=await runContentRequest({...next,cancelInference:{jobId,hash:h}});assert.equal(cancel.status,'cancelled');assert.equal(reads,before);
  assert.equal((await runContentRequest({...next,inferenceReply:answer(job,output)})).error.code,'STALE_INFERENCE');
});
