import test from 'node:test';
import assert from 'node:assert/strict';
import {determined} from '../src/determined.mjs';
import {hash} from '../src/contracts.mjs';
const criteria=['first','second'].map(id=>({id,verifier:{type:'test',command:id}}));
const pass=artifact=>({outcome:'pass',artifactHash:artifact.sha256,revision:artifact.revision});

test('in-place mutation cannot combine passing evidence across revisions',async()=>{
  const artifact={revision:1,sha256:hash('first')};
  const r=await determined({criteria},{execute:async()=>{},getArtifact:async()=>artifact,
    verify:async({criterion,artifact:snapshot})=>{
      if(criterion.id==='second'){artifact.revision=2;artifact.sha256=hash('second');}
      return pass(snapshot);
    }});
  assert.equal(r.status,'needs_human');
  assert.equal(r.history[0].artifact.revision,1);
  assert.ok(r.history[0].outcomes.every(x=>x.outcome==='unknown'));
});

test('repair cannot rewrite prior history or plan-bound verifiers',async()=>{
  let revision=0;
  const r=await determined({criteria,maxRepairAttempts:1},{
    execute:async({previous,criteria:copy})=>{
      revision++;
      copy[0].verifier.command='weakened';
      if(previous){previous.outcomes[0].outcome='pass';previous.artifact.sha256=hash('forged');}
    },
    getArtifact:async()=>({revision,sha256:hash(String(revision))}),
    verify:async({criterion,artifact})=>{
      assert.equal(criterion.verifier.command,criterion.id);
      return {...pass(artifact),outcome:revision===1?'fail':'pass'};
    },
  });
  assert.equal(r.status,'success');
  assert.equal(r.history[0].outcomes[0].outcome,'fail');
  assert.equal(r.history[0].artifact.sha256,hash('1'));
});

test('last verifier cancellation and thrown executor cancellation remain cancelled',async()=>{
  for(const stage of ['execute','verify']){
    const ac=new AbortController();let executions=0;
    const r=await determined({criteria:[criteria[0]],maxRepairAttempts:2,signal:ac.signal},{
      execute:async()=>{executions++;if(stage==='execute'){ac.abort();throw Error('secret');}},
      getArtifact:async()=>({revision:1,sha256:hash('x')}),
      verify:async({artifact})=>{ac.abort();return pass(artifact);},
    });
    assert.equal(r.status,'cancelled');assert.equal(executions,1);
    assert.ok(!JSON.stringify(r).includes('secret'));
  }
});

test('missing callbacks, operational errors and non-advancing revisions never retry to success',async()=>{
  assert.equal((await determined({criteria})).status,'needs_human');
  let calls=0;
  const r=await determined({criteria,maxRepairAttempts:5},{execute:async()=>{calls++;throw Error('secret');},getArtifact:async()=>null,verify:async()=>null});
  assert.equal(r.status,'needs_human');assert.equal(calls,1);assert.ok(!JSON.stringify(r).includes('secret'));
  calls=0;
  const changed=await determined({criteria,maxRepairAttempts:2},{execute:async()=>{calls++;},getArtifact:async()=>({revision:1,sha256:hash(String(calls))}),verify:async({artifact})=>({...pass(artifact),outcome:'fail'})});
  assert.equal(changed.status,'needs_human');assert.equal(calls,2);
  assert.match(changed.reason,/revision/);
});
