// Runnable independent consumer: node examples/determined-caller.mjs
// Synthetic, explicitly scripted executor; no model inference or external sends.
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {determined,hash} from 'qloops';
import {subprocess} from 'qloops/src/subprocess.mjs';

const workspace=mkdtempSync(join(tmpdir(),'qloops-determined-'));
const target=join(workspace,'value.mjs');
const verifier=join(workspace,'verify.mjs');
writeFileSync(verifier,`import assert from 'node:assert/strict';import {add} from './value.mjs';
if(process.argv[2]==='positive')assert.equal(add(2,3),5);else assert.equal(add(-3,1),-2);`);
const verifierHash=hash(readFileSync(verifier));
const criteria=['positive','negative'].map(id=>({id,verifier:{type:'command',
  command:process.execPath,args:[verifier,id],sha256:verifierHash}}));
let revision=0,records=[];
const getArtifact=async()=>({revision,sha256:hash(readFileSync(target))});
const verify=async({criterion,artifact,signal})=>{
  assert.equal(hash(readFileSync(verifier)),criterion.verifier.sha256);
  const result=await subprocess(criterion.verifier.command,criterion.verifier.args,
    {cwd:workspace,timeoutMs:3000,signal});
  records.push({criterionId:criterion.id,revision:artifact.revision,
    exitCode:result.code,stdoutHash:hash(result.stdout),stderrHash:hash(result.stderr)});
  return {outcome:result.code===0?'pass':'fail',artifactHash:artifact.sha256,revision:artifact.revision};
};
const execute=async({attempt,previous})=>{
  if(attempt>0) assert.ok(previous.outcomes.some(x=>x.outcome==='fail'));
  revision++;
  writeFileSync(target,attempt===0?'export const add=()=>0;':'export const add=(a,b)=>a+b;');
};
try {
  const repaired=await determined({criteria,maxRepairAttempts:1},{execute,verify,getArtifact});
  assert.equal(repaired.status,'success');
  assert.deepEqual(repaired.history.map(h=>h.outcomes.map(x=>x.outcome)),[['fail','fail'],['pass','pass']]);
  const repairChecks=records;records=[];
  const limited=await determined({criteria,maxRepairAttempts:0},{execute,verify,getArtifact});
  assert.equal(limited.status,'needs_human');assert.equal(limited.history.length,1);
  const stale=await determined({criteria},{execute,verify:async({artifact})=>({
    outcome:'pass',artifactHash:artifact.sha256,revision:artifact.revision-1}),getArtifact});
  assert.equal(stale.status,'needs_human');
  const human=await determined({criteria:[{id:'editorial-review',verifier:{type:'human'}}]},
    {execute,getArtifact});
  assert.equal(human.status,'needs_human');
  assert.equal(hash(readFileSync(verifier)),verifierHash);
  console.log(JSON.stringify({evidenceKind:'real filesystem changes and independent Node verifier subprocesses; scripted executor, no model inference',
    repaired,repairChecks,limited,stale,human,verifierUnchanged:true}));
} finally {rmSync(workspace,{recursive:true,force:true});}
