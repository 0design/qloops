import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewQueue} from '../demos/annotation-review/run.mjs';
test('annotation review preserves provenance and never resolves unverified feedback',()=>{
 const a={id:'one',kind:'feedback',intent:'fix',comment:'Fix clipping',elementPath:'main > button'};
 const result=reviewQueue({sessionId:'s',annotations:[a,{id:'two',kind:'placement',comment:'Add something'}]});
 assert.deepEqual(result.map(x=>x.nextAction),['inspect-and-propose','ask-for-clarification']);
 assert.ok(result.every(x=>x.status==='pending'&&x.evidence.length===0&&x.sessionId==='s'));
 assert.throws(()=>reviewQueue({sessionId:'s',annotations:[a,a]}),/duplicate/);
});
