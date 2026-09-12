import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadUnslop,upstreamDigest,designSystemDigest} from '../src/upstream-adapters.mjs';
import {hash} from '../src/contracts.mjs';
// Deliberately minimal authored adapter fixture, not copied upstream canon.
function setup(t,source='export const detect=()=>({scanned:1,rulesRun:1,findings:[]});'){
  const root=mkdtempSync(join(tmpdir(),'qloops-upstream-fixture-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  mkdirSync(join(root,'scripts'));mkdirSync(join(root,'scripts/rules'));mkdirSync(join(root,'references'));
  writeFileSync(join(root,'package.json'),JSON.stringify({name:'unslop',version:'fixture',type:'module'}));
  writeFileSync(join(root,'scripts/detect.mjs'),source);
  writeFileSync(join(root,'references/rule.md'),'fixture rule');
  writeFileSync(join(root,'scripts/rules/index.mjs'),"export const selectRules=()=>[{id:'fixture',severity:'red',fileTypes:['.css'],test:()=>null}];");
  const path=join(root,'subject.css');writeFileSync(path,'a{}');
  const sha256=upstreamDigest(root,['scripts','references','package.json']);
  return {root,sha256,packageVersion:'fixture',request:{artifact:{path,sha256:hash('a{}'),revision:1},requiredRules:['fixture'],upstream:{version:'fixture',sha256}}};
}
test('native adapter refuses different content under same version and changed loaded roots',async t=>{
  const f=setup(t),adapter=await loadUnslop(f);
  const normal=await adapter.evaluate(f.request);
  assert.equal(normal.upstreamSha256,f.sha256);
  await assert.rejects(adapter.evaluate({...f.request,upstream:{...f.request.upstream,sha256:hash('different')}}));
  writeFileSync(join(f.root,'references/rule.md'),'changed');
  await assert.rejects(adapter.evaluate(f.request));
  const next=upstreamDigest(f.root,['scripts','references','package.json']);
  await assert.rejects(loadUnslop({...f,sha256:next}),/immutable install root/);
});
test('native adapter detects subject changed while detector runs',async t=>{
  const f=setup(t,"import {writeFileSync} from 'node:fs';export const detect=p=>{writeFileSync(p,'changed');return {scanned:1,rulesRun:1,findings:[]}};");
  const adapter=await loadUnslop(f);
  await assert.rejects(adapter.evaluate(f.request),/Artifact hash mismatch/);
});
test('DS digest binds absent and added contract inputs',t=>{
  const f=setup(t);const before=designSystemDigest(f.root);
  mkdirSync(join(f.root,'src'));writeFileSync(join(f.root,'src/tokens.json'),'{}');
  assert.notEqual(designSystemDigest(f.root),before);
});

test('inapplicable file types stay unknown and orange findings are soft failures',async t=>{
  const f=setup(t,"export const detect=()=>({scanned:1,rulesRun:1,findings:[{rule:'fixture',severity:'orange'}]});");
  writeFileSync(join(f.root,'scripts/rules/index.mjs'),"export const selectRules=()=>[{id:'fixture',severity:'orange',fileTypes:['.css'],test:()=>null}];");
  f.sha256=upstreamDigest(f.root,['scripts','references','package.json']);f.request.upstream.sha256=f.sha256;
  const adapter=await loadUnslop(f);
  const soft=await adapter.evaluate(f.request);
  assert.equal(soft.findings[0].type,'soft');assert.equal(soft.findings[0].outcome,'fail');
  const path=join(f.root,'subject.html');writeFileSync(path,'a{}');
  const skipped=await adapter.evaluate({...f.request,artifact:{...f.request.artifact,path}});
  assert.equal(skipped.findings[0].outcome,'unknown');
});
