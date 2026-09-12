import test from 'node:test';
import assert from 'node:assert/strict';
import { runLlmCall, runApprovalGate } from '../src/steps.mjs';
import { resolveKnobs } from '../src/run.mjs';

test('YAML model steps refuse an unconfigured model before any network request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('unexpected network'); });
  const ctx = { apiKey: 'fixture-only', priorOutputs: {}, priorStepNames: {} };
  await assert.rejects(runLlmCall({kind:'llm-call',config:{instructions:'Summarize the supplied text.'}},ctx,null,100), /model is not configured/);
  await assert.rejects(runApprovalGate({kind:'approval-gate',config:{reviewer:'agent',rubric:'Contains a source.'}},ctx,null,100), /model is not configured/);
  assert.equal(calls,0);
  const human=await runApprovalGate({kind:'approval-gate',config:{reviewer:'human'}},ctx,null,100);
  assert.equal(human.waitingHuman,true);
  assert.equal(resolveKnobs({model:'explicit/model'}).model,'explicit/model');
});
