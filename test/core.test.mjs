import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runAgent } from "../src/agent.mjs";
import { subprocess } from "../src/subprocess.mjs";
import { claude, claudeArgs } from "../src/providers/claude.mjs";
import { openRouter } from "../src/providers/openrouter.mjs";
import { hash, validateRequest } from "../src/contracts.mjs";
import { lockWorkspace } from "../src/workspace.mjs";
const setup = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "qloops-core-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "value.txt"), "old");
  return {
    protocolVersion: "qf.agent/v1",
    requestId: "fixture",
    loop: { id: "synthetic-sdd", version: "1.0.0" },
    intent: "Write new to value.txt",
    workspace: dir,
    allowedPaths: ["value.txt"],
    allowedTools: [process.execPath],
    provider: {
      kind: "claude",
      model: "sonnet",
      executable: "/usr/local/bin/claude",
      payerScope: "local-cli",
    },
    deadlineMs: 10000,
    maxRepairAttempts: 0,
    verifier: {
      command: process.execPath,
      args: [
        "-e",
        "if(require('fs').readFileSync('value.txt','utf8')!=='new')process.exit(1)",
      ],
    },
  };
};
const generate = async () => ({
  content: JSON.stringify({
    summary: "Write new",
    criteria: ["value.txt contains new"],
    plan: ["Write file"],
    files: [{ path: "value.txt", content: "new" }],
  }),
  provider: { kind: "fixture" },
  usage: null,
});
const approve = async (r, options = {}) => {
  const first = await runAgent(r, { generate, ...options });
  assert.equal(first.status, "needs_human");
  return {
    ...r,
    resumeRunId: first.runId,
    approval: { hash: first.nextAction.hash, decision: "approve" },
  };
};
test("SDD spec approval -> real file change -> independent subprocess verifier -> cached resume", async (t) => {
  const r = setup(t);
  const next = await approve(r);
  let calls = 0;
  const result = await runAgent(next, {
    generate: async () => {
      calls++;
      return generate();
    },
  });
  assert.equal(result.status, "success");
  assert.equal(result.evidence[0].outcome, "pass");
  assert.equal(readFileSync(join(r.workspace, "value.txt"), "utf8"), "new");
  assert.equal((await runAgent(next, { generate })).status, "success");
  assert.equal(calls, 1);
  writeFileSync(join(r.workspace, "value.txt"), "changed");
  assert.equal(
    (await runAgent(next, { generate })).error.code,
    "WORKSPACE_CHANGED",
  );
});
test("wrong approval and changed policy cannot execute", async (t) => {
  const r = setup(t),
    next = await approve(r);
  const wrong = await runAgent(
    { ...next, approval: { hash: "0".repeat(64), decision: "approve" } },
    { generate },
  );
  assert.equal(wrong.status, "needs_human");
  assert.equal(readFileSync(join(r.workspace, "value.txt"), "utf8"), "old");
  assert.equal(
    (await runAgent({ ...next, allowedPaths: ["other.txt"] }, { generate }))
      .error.code,
    "WORKSPACE_CHANGED",
  );
});
test("rejection persists across resume", async (t) => {
  const r = setup(t),
    next = await approve(r);
  assert.equal(
    (
      await runAgent(
        { ...next, approval: { ...next.approval, decision: "reject" } },
        { generate },
      )
    ).status,
    "cancelled",
  );
  assert.equal((await runAgent(next, { generate })).status, "cancelled");
});
test("failed verifier never becomes success; repair is bounded", async (t) => {
  const r = setup(t);
  r.maxRepairAttempts = 1;
  r.verifier.args = ["-e", "process.exit(1)"];
  const next = await approve(r);
  const result = await runAgent(next, { generate });
  assert.equal(result.status, "needs_human");
  assert.equal(result.evidence.length, 2);
  assert.ok(result.evidence.every((e) => e.outcome === "fail"));
  assert.equal((await runAgent(next, { generate })).evidence.length, 2);
});
test("scope escape and symlink are refused", async (t) => {
  const r = setup(t),
    next = await approve(r);
  const bad = () =>
    Promise.resolve({
      content: JSON.stringify({ files: [{ path: "../escape", content: "x" }] }),
    });
  assert.equal(
    (await runAgent(next, { generate: bad })).error.code,
    "SCOPE_DENIED",
  );
  rmSync(join(r.workspace, "value.txt"));
  symlinkSync("/etc/hosts", join(r.workspace, "value.txt"));
  assert.equal((await runAgent(r, { generate })).error.code, "SCOPE_DENIED");
});
test("exclusive workspace lock and recursion guard", async (t) => {
  const r = setup(t),
    lock = lockWorkspace(r.workspace);
  assert.equal(
    (await runAgent(r, { generate })).error.code,
    "WORKSPACE_LOCKED",
  );
  lock.release();
  const old = process.env.QLOOPS_DEPTH;
  process.env.QLOOPS_DEPTH = "1";
  try {
    assert.equal(
      (await runAgent(r, { generate })).error.code,
      "UNSUPPORTED_NESTING",
    );
  } finally {
    if (old === undefined) delete process.env.QLOOPS_DEPTH;
    else process.env.QLOOPS_DEPTH = old;
  }
});
test("subprocess bounded output, missing executable, timeout and cancellation", async () => {
  await assert.rejects(
    subprocess("/does/not/exist", [], { cwd: process.cwd() }),
    { code: "MISSING_EXECUTABLE" },
  );
  await assert.rejects(
    subprocess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      timeoutMs: 30,
    }),
    { code: "TIMEOUT" },
  );
  await assert.rejects(
    subprocess(process.execPath, ["-e", "console.log('x'.repeat(10000))"], {
      maxBytes: 20,
    }),
    { code: "OUTPUT_LIMIT" },
  );
  await assert.rejects(
    subprocess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      signal: AbortSignal.timeout(20),
    }),
    { code: "CANCELLED" },
  );
});
test("Claude caller verifies exact argv, context stdin, scoped env and stdout errors", async () => {
  let calls = 0;
  const launch = async (cmd, args, opts) => {
    calls++;
    assert.equal(cmd, "/fixture/claude");
    assert.equal(opts.cwd, "/fixture");
    assert.equal(opts.env.QLOOPS_DEPTH, "1");
    assert.equal(opts.env.OPENROUTER_API_KEY, undefined);
    if (calls === 1) return { code: 0, stdout: "2.1.156 (Claude Code)" };
    assert.deepEqual(args, claudeArgs("sonnet"));
    assert.deepEqual(JSON.parse(opts.input), {
      messages: [{ role: "user", content: "hello; $(bad)" }],
    });
    return {
      code: 0,
      stdout: JSON.stringify({
        subtype: "success",
        result: "ok",
        modelUsage: { actual: {} },
        usage: {},
      }),
    };
  };
  const r = await claude(
    {
      executable: "/fixture/claude",
      model: "sonnet",
      messages: [{ role: "user", content: "hello; $(bad)" }],
      cwd: "/fixture",
      runId: "test",
    },
    { launch },
  );
  assert.equal(r.usage.costUsd, null);
  assert.equal(r.provider.model, "actual");
});
test("Claude stdout failure and malformed response never pass", async () => {
  for (const body of [
    "bad",
    JSON.stringify({
      subtype: "error",
      is_error: true,
      result: "permission denied",
    }),
    JSON.stringify({
      subtype: "success",
      result: "ok",
      permission_denials: [{}],
    }),
  ]) {
    let n = 0;
    await assert.rejects(
      claude(
        {
          executable: "/fixture",
          model: "sonnet",
          messages: [],
          cwd: "/fixture",
          runId: "x",
        },
        {
          launch: async () =>
            ++n === 1
              ? { code: 0, stdout: "2.1.156 (Claude Code)" }
              : { code: 0, stdout: body },
        },
      ),
    );
  }
});
test("OpenRouter actual model, unknown usage, malformed and missing auth", async () => {
  const r = {
    messages: [{ role: "user", content: "test" }],
    model: "requested",
    payerScope: "local-byok",
    maxTokens: 10,
  };
  const fetcher = async (url, init) => {
    assert.equal(JSON.parse(init.body).model, "requested");
    return new Response(
      JSON.stringify({
        id: "response-id",
        model: "actual",
        choices: [{ message: { content: "OK" } }],
      }),
    );
  };
  const result = await openRouter(r, {
    env: { OPENROUTER_API_KEY: "fixture-secret" },
    fetcher,
  });
  assert.deepEqual(result.usage, {
    tokensIn: null,
    tokensOut: null,
    costUsd: null,
  });
  assert.equal(result.provider.model, "actual");
  await assert.rejects(openRouter(r, { env: {}, fetcher }), {
    code: "AUTH_REQUIRED",
  });
  await assert.rejects(
    openRouter(r, {
      env: { OPENROUTER_API_KEY: "x" },
      fetcher: async () => new Response("oops"),
    }),
    { code: "INVALID_RESPONSE" },
  );
});
test("CLI malformed caller has one envelope and exit 64", async () => {
  const p = await subprocess(
    process.execPath,
    [resolve("bin/qloops.mjs"), "agent", "-"],
    { input: "{bad" },
  );
  assert.equal(p.code, 64);
  assert.equal(JSON.parse(p.stdout).error.code, "INVALID_REQUEST");
  assert.equal(p.stderr, "");
});
test("contract rejects unpinned loop and unsafe request", (t) => {
  const r = setup(t);
  for (const patch of [
    { loop: { id: "synthetic-sdd", version: "latest" } },
    { allowedPaths: ["../x"] },
    { allowedTools: [] },
    { deadlineMs: 0 },
    { maxRepairAttempts: 6 },
  ])
    assert.throws(() => validateRequest({ ...r, ...patch }));
  assert.equal(hash({ b: 1, a: 2 }), hash({ a: 2, b: 1 }));
});
test("contract fixtures are executable and unknown fields are refused", () => {
  const fixtures = JSON.parse(
    readFileSync(new URL("../contracts/v1/fixtures.json", import.meta.url)),
  );
  validateRequest(fixtures.positive);
  for (const patch of fixtures.negativePatches)
    assert.throws(() => validateRequest({ ...fixtures.positive, ...patch }));
  assert.throws(() =>
    validateRequest({ ...fixtures.positive, skipPermissions: true }),
  );
});
test("verifier aliases cannot become writable and money caps stop unreserved inference", async (t) => {
  const r = setup(t);
  assert.throws(
    () =>
      validateRequest({
        ...r,
        allowedPaths: ["verify.mjs"],
        verifier: { command: process.execPath, args: ["./verify.mjs"] },
      }),
    { code: "SCOPE_DENIED" },
  );
  const capped = { ...r, maxCostUsd: 1, maxCallCostUsd: 1 };
  const first = await runAgent(capped, { generate });
  assert.equal(first.error.code, "BUDGET_EXHAUSTED");
});
test("aborted subprocess terminates descendant process group", async (t) => {
  const r = setup(t),
    pidFile = join(r.workspace, "descendant.pid");
  const script = `const {spawn}=require('child_process');const fs=require('fs');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(p.pid));setInterval(()=>{},1000);`;
  await assert.rejects(
    subprocess(process.execPath, ["-e", script], { timeoutMs: 150 }),
    { code: "TIMEOUT" },
  );
  const pid = Number(readFileSync(pidFile, "utf8"));
  // Signal delivery/reaping is asynchronous even after the direct child closes.
  const until = Date.now() + 1500;
  let alive = true;
  while (alive && Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    alive,
    false,
    "Descendant must exit within the termination bound",
  );
});
