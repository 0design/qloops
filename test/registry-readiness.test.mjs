import test from 'node:test';
import assert from 'node:assert/strict';
import {componentReadiness} from '../scripts/registry-readiness.mjs';
const template={id:'sdd-pipeline',inference:'cli',dependencies:[{id:'llm-call-cli',version:'1.0.0'}]};
const component={id:'llm-call-cli',version:'1.0.0',implementation:{status:'partial'},acceptance:{status:'pending'}};
test('partial caller runtime cannot stand in for an accepted Registry component',()=>{
 assert.equal(componentReadiness(template,[component]).status,'blocked');
 assert.throws(()=>componentReadiness(template,[]),/Missing component/);
 assert.throws(()=>componentReadiness({...template,dependencies:[{id:'llm-call-openrouter',version:'1.0.0'}]},[{...component,id:'llm-call-openrouter'}]),/CLI template/);
});
test('component acceptance requires version-bound evidence and cannot hide a dependency cycle',()=>{
 const accepted={...component,implementation:{status:'implemented'},acceptance:{status:'accepted',evidence:[]}};
 assert.equal(componentReadiness(template,[accepted]).status,'blocked');
 accepted.acceptance.evidence=[{sha256:'a'.repeat(64),componentVersion:'1.0.0'}];
 assert.equal(componentReadiness(template,[accepted]).status,'components-ready');
 assert.throws(()=>componentReadiness(template,[{...accepted,dependencies:template.dependencies}]),/cycle/);
});
