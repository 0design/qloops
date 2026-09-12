import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runContent, reconcilePublication } from "../src/content.mjs";
const setup = (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "qloops-content-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  return {
    workspace,
    requestId: "content",
    sources: [
      { id: "one", url: "https://example.com/one", text: "One source" },
    ],
    profile: { tone: "concise" },
    provider: { id: "fixture", version: "1" },
    receiver: { id: "test-only", version: "1" },
  };
};
const adapters = {
  generate: async () => ({ text: "One sourced draft" }),
  check: async () => ({ outcome: "pass", rule: "synthetic-attribution@1" }),
  publish: async () => ({ id: "local-receiver-1", delivered: true }),
};
test("content exact approval, receipt and subsequent source dedup", async (t) => {
  const r = setup(t);
  let sends = 0;
  const a = {
    ...adapters,
    publish: async (x) => {
      sends++;
      assert.match(x.idempotencyKey, /^[a-f0-9]{64}$/);
      return adapters.publish();
    },
  };
  const first = await runContent(r, a);
  assert.equal(first.status, "needs_human");
  assert.equal(sends, 0);
  const result = await runContent(
    { ...r, approval: { hash: first.nextAction.hash, decision: "approve" } },
    a,
  );
  assert.equal(result.status, "success");
  assert.equal((await runContent(r, a)).nextAction.type, "no_new_sources");
  assert.equal(sends, 1);
});
test("changed draft/profile invalidates approval, rejection prevents send", async (t) => {
  const r = setup(t),
    first = await runContent(r, adapters);
  assert.equal(
    (
      await runContent(
        {
          ...r,
          profile: { tone: "other" },
          approval: { hash: first.nextAction.hash, decision: "approve" },
        },
        adapters,
      )
    ).status,
    "needs_human",
  );
  assert.equal(
    (
      await runContent(
        { ...r, approval: { hash: first.nextAction.hash, decision: "reject" } },
        adapters,
      )
    ).status,
    "cancelled",
  );
});
test("ambiguous publication never retried and missing receipt not delivery", async (t) => {
  const r = setup(t);
  let sends = 0;
  const a = {
    ...adapters,
    publish: async () => {
      sends++;
      throw new Error("lost response");
    },
  };
  const first = await runContent(r, a),
    approved = {
      ...r,
      approval: { hash: first.nextAction.hash, decision: "approve" },
    };
  assert.equal((await runContent(approved, a)).status, "needs_human");
  assert.equal((await runContent(approved, a)).status, "needs_human");
  assert.equal(sends, 1);
});
test("unknown checker and provider failure do not publish", async (t) => {
  const r = setup(t);
  assert.equal(
    (
      await runContent(r, {
        ...adapters,
        generate: async () => {
          throw new Error("missing key");
        },
      })
    ).status,
    "failed",
  );
  assert.equal(
    (
      await runContent(r, {
        ...adapters,
        check: async () => ({ outcome: "unknown" }),
      })
    ).status,
    "needs_human",
  );
});
test("changed sources cannot replay an uncertain overlapping publication", async (t) => {
  const r = setup(t),
    a = {
      ...adapters,
      publish: async () => {
        throw Error("uncertain");
      },
    };
  const first = await runContent(r, a);
  await runContent(
    { ...r, approval: { hash: first.nextAction.hash, decision: "approve" } },
    a,
  );
  const result = await runContent(
    {
      ...r,
      sources: [
        ...r.sources,
        { id: "two", url: "https://example.com/two", text: "new" },
      ],
    },
    a,
  );
  assert.equal(result.nextAction.type, "reconcile_receipt");
});

test("receiver reconciliation advances dedup without resending", async (t) => {
  const r = setup(t),
    a = {
      ...adapters,
      publish: async () => {
        throw Error("lost response");
      },
    };
  const first = await runContent(r, a);
  const uncertain = await runContent(
    { ...r, approval: { hash: first.nextAction.hash, decision: "approve" } },
    a,
  );
  const result = await reconcilePublication(
    {
      workspace: r.workspace,
      runId: uncertain.runId,
      idempotencyKey: uncertain.nextAction.idempotencyKey,
    },
    { lookup: async () => ({ id: "confirmed-by-lookup", delivered: true }) },
  );
  assert.equal(result.status, "success");
  assert.equal((await runContent(r, a)).nextAction.type, "no_new_sources");
});

test('stale rejection cannot cancel a new draft',async t=>{
  const r=setup(t),first=await runContent(r,adapters);
  const changed={...r,profile:{tone:'changed'},approval:{hash:first.nextAction.hash,decision:'reject'}};
  const result=await runContent(changed,adapters);
  assert.equal(result.status,'needs_human');assert.equal(result.nextAction.type,'approve_publication');
  assert.notEqual(result.nextAction.hash,first.nextAction.hash);
});
test('cancellation after checker prevents send and callback mutation cannot rewrite receiver',async t=>{
  const r=setup(t),first=await runContent(r,adapters);let sends=0;
  const ac=new AbortController();ac.abort();
  const stopped=await runContent({...r,approval:{hash:first.nextAction.hash,decision:'approve'}},{...adapters,signal:ac.signal,publish:async()=>{sends++;}});
  assert.equal(stopped.status,'cancelled');assert.equal(sends,0);
  const other={...r,profile:{tone:'another'}};const next=new AbortController();
  const result=await runContent(other,{...adapters,signal:next.signal,
    check:async input=>{input.profile.tone='tampered';next.abort();return {outcome:'pass'};},publish:async()=>{sends++;}});
  assert.equal(result.status,'cancelled');assert.equal(other.profile.tone,'another');assert.equal(sends,0);
});
