import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAgent } from "../src/agent.mjs";
import { subprocess } from "../src/subprocess.mjs";
const spec = {
  summary: "Addition",
  criteria: ["add(2,3) equals 5"],
  plan: ["Implement value.mjs"],
};
function setup(t) {
  const workspace = mkdtempSync(join(tmpdir(), "qloops-spec-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, "value.mjs"), "export const add=()=>0;");
  writeFileSync(
    join(workspace, "verify.mjs"),
    "import {add} from './value.mjs';if(add(2,3)!==5)process.exit(1);",
  );
  return {
    ...JSON.parse(readFileSync("contracts/v1/fixtures.json")).positive,
    workspace,
    provider: {
      kind: "codex",
      model: "fixture",
      executable: resolve("test/fixtures/codex.mjs"),
      payerScope: "local-cli",
    },
    allowedPaths: ["value.mjs"],
    allowedTools: [process.execPath],
    verifier: { command: process.execPath, args: ["verify.mjs"] },
  };
}
const output = (content) => ({
  content: JSON.stringify(content),
  provider: { kind: "fixture" },
  usage: null,
});
const generate = async () => output(spec);
test("imported spec skips inference and real caller requires explicit scope approval", async (t) => {
  const r = { ...setup(t), specification: spec };
  const call = async (request) => {
    const p = await subprocess(
      process.execPath,
      [resolve("bin/qloops.mjs"), "agent", "-"],
      { input: JSON.stringify(request), timeoutMs: 5000 },
    );
    return { code: p.code, result: JSON.parse(p.stdout) };
  };
  const first = await call(r);
  assert.equal(first.code, 2);
  assert.equal(first.result.provider, null);
  assert.equal(first.result.nextAction.specRevision, 1);
  const done = await call({
    ...r,
    resumeRunId: first.result.runId,
    approval: { decision: "approve", hash: first.result.nextAction.hash },
  });
  assert.equal(done.code, 0);
  assert.equal(done.result.status, "success");
});
test("clarification is durable, complete, question-bound, and idempotent", async (t) => {
  const r = setup(t);
  let calls = 0;
  const model = async () => {
    calls++;
    return output(
      calls === 1
        ? { questions: [{ id: "format", question: "Which output format?" }] }
        : spec,
    );
  };
  const first = await runAgent(r, { generate: model });
  assert.equal(first.nextAction.type, "clarify_spec");
  const resumed = { ...r, resumeRunId: first.runId };
  assert.equal(
    (await runAgent(resumed, { generate: model })).nextAction.hash,
    first.nextAction.hash,
  );
  assert.equal(calls, 1);
  const wrong = {
    ...resumed,
    clarification: {
      hash: first.nextAction.hash,
      answers: [{ id: "wrong", answer: "text" }],
    },
  };
  assert.equal(
    (await runAgent(wrong, { generate: model })).error.code,
    "INVALID_REQUEST",
  );
  assert.equal(calls, 1);
  const answered = {
    ...resumed,
    clarification: {
      hash: first.nextAction.hash,
      answers: [{ id: "format", answer: "text" }],
    },
  };
  const ready = await runAgent(answered, { generate: model });
  assert.equal(ready.nextAction.type, "approve_spec");
  assert.equal(calls, 2);
  assert.equal(
    (await runAgent(answered, { generate: model })).nextAction.hash,
    ready.nextAction.hash,
  );
  assert.equal(calls, 2);
  assert.equal(
    (
      await runAgent(
        {
          ...answered,
          clarification: { ...answered.clarification, hash: "0".repeat(64) },
        },
        { generate: model },
      )
    ).error.code,
    "WORKSPACE_CHANGED",
  );
});
test("explicit scope/spec revision invalidates approval and replay does not increment twice", async (t) => {
  const r = setup(t);
  const first = await runAgent(r, { generate });
  const changed = {
    ...r,
    resumeRunId: first.runId,
    allowedPaths: ["value.mjs", "extra.txt"],
    specChange: {
      expectedHash: first.nextAction.hash,
      expectedRevision: 1,
      reason: "Include documentation",
      specification: { ...spec, plan: [...spec.plan, "Write extra.txt"] },
    },
  };
  const second = await runAgent(
    {
      ...changed,
      approval: { decision: "approve", hash: first.nextAction.hash },
    },
    { generate },
  );
  assert.equal(second.nextAction.specRevision, 2);
  assert.notEqual(second.nextAction.hash, first.nextAction.hash);
  const again = await runAgent(changed, { generate });
  assert.equal(again.nextAction.specRevision, 2);
  assert.equal(again.nextAction.hash, second.nextAction.hash);
  const stale = await runAgent(
    {
      ...changed,
      specChange: { ...changed.specChange, reason: "Different stale request" },
    },
    { generate },
  );
  assert.equal(stale.error.code, "WORKSPACE_CHANGED");
  const state = JSON.parse(
    readFileSync(join(r.workspace, ".qf", `agent-${first.runId}.json`)),
  );
  assert.equal(state.specHistory.length, 2);
  assert.equal(state.specHistory[0].identity.allowedPaths.length, 1);
  assert.equal(state.specHistory[1].identity.allowedPaths.length, 2);
});
test("stale mutation cannot destroy a completed cached result", async (t) => {
  const r = { ...setup(t), specification: spec };
  const first = await runAgent(r);
  const approved = {
    ...r,
    resumeRunId: first.runId,
    approval: { decision: "approve", hash: first.nextAction.hash },
  };
  assert.equal((await runAgent(approved)).status, "success");
  const invalid = await runAgent({
    ...approved,
    specChange: {
      expectedHash: first.nextAction.hash,
      expectedRevision: 1,
      reason: "Too late",
      specification: spec,
    },
  });
  assert.equal(invalid.error.code, "WORKSPACE_CHANGED");
  assert.equal((await runAgent(approved)).status, "success");
});
test("missing verifier requests configuration without inference or writes", async (t) => {
  const r = setup(t);
  delete r.verifier;
  let called = false;
  const out = await runAgent(r, {
    generate: async () => {
      called = true;
      return output(spec);
    },
  });
  assert.equal(out.status, "needs_human");
  assert.equal(out.error.code, "MISSING_CHECKER");
  assert.equal(out.nextAction.type, "configure_verifier");
  assert.equal(called, false);
});

test("unavailable model requests explicit provider configuration without writing artifacts", async (t) => {
  const r = setup(t);
  let calls = 0;
  const {CoreError} = await import('../src/contracts.mjs');
  const result = await runAgent(r,{generate:async()=>{calls++;throw new CoreError('MODEL_UNAVAILABLE','Model unavailable');}});
  assert.equal(result.status,'needs_human');
  assert.equal(result.nextAction.type,'configure_provider');
  assert.equal(result.nextAction.requestedModel,r.provider.model);
  assert.equal(calls,1);
  assert.equal(readFileSync(join(r.workspace,'value.mjs'),'utf8'),'export const add=()=>0;');
});
