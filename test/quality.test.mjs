import test from "node:test";
import assert from "node:assert/strict";
import { hash } from "../src/contracts.mjs";
import { qualityCheck } from "../src/quality.mjs";
import { determined } from "../src/determined.mjs";
const artifact = { revision: 1, sha256: hash("artifact") },
  upstream = { version: "fixture-1", sha256: hash("canon") };
const request = {
  kind: "aindf-check",
  mode: "ds-readiness",
  upstream,
  artifact,
  designSystem: { id: "synthetic", sha256: hash("ds") },
  requiredRules: ["rule-1"],
  browserEvidence: {
    artifactHash: artifact.sha256,
    revision: 1,
    sha256: hash("browser-fixture"),
  },
};
const report = (outcome) => ({
  evaluate: async () => ({
    upstreamVersion: upstream.version,
    upstreamSha256: upstream.sha256,
    designSystemHash: hash("ds"),
    artifactHash: artifact.sha256,
    revision: 1,
    findings: [
      { rule: "rule-1", type: "hard", outcome, evidence: { fixture: true } },
    ],
  }),
});
for (const mode of ["ds-readiness", "ui-compliance"])
  test(`aindf ${mode}: good/bad/unknown/missing DS`, async () => {
    assert.equal(
      (await qualityCheck({ ...request, mode }, report("pass"))).status,
      "success",
    );
    assert.equal(
      (await qualityCheck({ ...request, mode }, report("fail"))).status,
      "failed",
    );
    assert.equal(
      (await qualityCheck({ ...request, mode }, report("unknown"))).status,
      "needs_human",
    );
    assert.equal(
      (
        await qualityCheck(
          { ...request, mode, designSystem: null },
          report("pass"),
        )
      ).status,
      "needs_human",
    );
  });
test("unslop hard/soft/browser coverage, stale canon and unavailable recipes", async () => {
  const r = { ...request, kind: "unslop" };
  assert.equal((await qualityCheck(r, report("fail"))).status, "failed");
  assert.equal(
    (await qualityCheck({ ...r, browserEvidence: null }, report("pass")))
      .status,
    "needs_human",
  );
  assert.equal(
    (
      await qualityCheck(
        { ...r, upstream: { ...upstream, version: "wrong" } },
        report("pass"),
      )
    ).status,
    "needs_human",
  );
  const result = await qualityCheck(r, {
    ...report("fail"),
    recipe: async () => {
      throw Error("offline");
    },
  });
  assert.equal(result.recipes[0].status, "unavailable");
});
test("determined repairs real criterion, rejects stale evidence, human not done", async () => {
  let value = 0;
  const callbacks = {
    execute: async () => {
      value++;
    },
    getArtifact: async () => ({ revision: value, sha256: hash(String(value)) }),
    verify: async ({ artifact }) => ({
      outcome: value === 2 ? "pass" : "fail",
      artifactHash: artifact.sha256,
      revision: artifact.revision,
    }),
  };
  const r = {
    criteria: [{ id: "two", verifier: { type: "synthetic" } }],
    maxRepairAttempts: 1,
  };
  assert.equal((await determined(r, callbacks)).status, "success");
  assert.equal(
    (
      await determined(r, {
        ...callbacks,
        verify: async () => ({
          outcome: "pass",
          artifactHash: hash("old"),
          revision: 0,
        }),
      })
    ).status,
    "needs_human",
  );
  assert.equal(
    (
      await determined(
        { ...r, criteria: [{ id: "human", verifier: { type: "human" } }] },
        callbacks,
      )
    ).status,
    "needs_human",
  );
});

test('quality callback cannot remove coverage or mutate pinned identity',async()=>{
  const original=structuredClone(request);
  const r=await qualityCheck(request,{evaluate:async input=>{
    input.requiredRules.length=0;input.artifact.sha256=hash('forged');input.upstream.sha256=hash('forged');
    return {upstreamVersion:input.upstream.version,upstreamSha256:input.upstream.sha256,
      artifactHash:input.artifact.sha256,revision:1,designSystemHash:hash('ds'),findings:[]};
  }});
  assert.equal(r.status,'needs_human');assert.equal(r.coverage.length,1);
  assert.deepEqual(request,original);
});

test('quality malformed, duplicate, untyped or empty-evidence reports never pass',async()=>{
  const normal=await report('pass').evaluate();
  for(const findings of [null,{},[null],[...normal.findings,...normal.findings],
    [{...normal.findings[0],type:'mystery'}],[{...normal.findings[0],evidence:true}],
    [{...normal.findings[0],evidence:{}}]]){
    assert.equal((await qualityCheck(request,{evaluate:async()=>({...normal,findings})})).status,'needs_human');
  }
  for(const field of ['upstreamSha256','designSystemHash']){
    assert.equal((await qualityCheck(request,{evaluate:async()=>({...normal,[field]:hash('wrong')})})).status,'needs_human');
  }
});

test('quality cancellation stops recipe calls and stale canon recipes remain unknown',async()=>{
  const ac=new AbortController();let recipes=0;
  const r=await qualityCheck({...request,signal:ac.signal},{evaluate:async()=>{ac.abort();return report('fail').evaluate();},recipe:async()=>{recipes++;}});
  assert.equal(r.status,'cancelled');assert.equal(recipes,0);
  const stale=await qualityCheck(request,{...report('fail'),recipe:async({rule,version})=>({rule,version,sha256:hash('different canon'),text:'recipe'})});
  assert.equal(stale.status,'failed');assert.equal(stale.recipes[0].status,'unknown');
});
