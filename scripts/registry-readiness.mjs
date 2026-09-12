import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Readiness is an acceptance gate, not an executor or a claim that metadata proves behavior.
export function componentReadiness(template, components) {
  const indexed=new Map(components.map(c=>[`${c.id}@${c.version}`,c]));
  const visited=new Set(),visiting=new Set(),blockers=[];
  function visit(dep) {
    const key=`${dep.id}@${dep.version}`;
    if(visiting.has(key)) throw Error(`Component dependency cycle: ${key}`);
    if(visited.has(key))return;
    const c=indexed.get(key);
    if(!c)throw Error(`Missing component: ${key}`);
    visiting.add(key);
    for(const child of [...(c.dependencies??[]),...(c.builtinDependencies??[])])visit(child);
    visiting.delete(key);visited.add(key);
    const accepted=c.acceptance?.status==='accepted' && c.acceptance.evidence?.some(e=>typeof e==='object' && /^[a-f0-9]{64}$/.test(e.sha256??'') && e.componentVersion===c.version);
    if(c.implementation?.status!=='implemented' || !accepted)blockers.push({id:c.id,version:c.version,implementation:c.implementation?.status??'unknown',acceptance:c.acceptance?.status??'pending'});
  }
  for(const dep of [...(template.dependencies??[]),...(template.builtinDependencies??[])])visit(dep);
  if(template.inference==='cli' && ![...visited].some(key=>key.startsWith('llm-call-cli@')))throw Error('CLI template must depend on llm-call/cli');
  return {templateId:template.id,status:blockers.length?'blocked':'components-ready',blockers,components:[...visited]};
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const catalog=JSON.parse(readFileSync(new URL('../registry/catalog.json',import.meta.url)));
  const template=catalog.composition.templates.find(t=>t.id===process.argv[2]);
  if(!template)throw Error('Specify an existing Registry template ID');
  const result=componentReadiness(template,[...catalog.components,...(catalog.composition.builtins??[])]);
  console.log(JSON.stringify(result,null,2));
  process.exitCode=result.status==='blocked'?2:0;
}
