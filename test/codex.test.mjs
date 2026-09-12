import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { codex, parseCodexResponse } from "../src/providers/codex.mjs";
import { subprocess, scopedEnvironment } from "../src/subprocess.mjs";
const options = {
  executable: resolve("test/fixtures/codex.mjs"),
  model: "fixture",
  messages: [{ role: "user", content: "test" }],
  timeoutMs: 3000,
  runId: "codex-test",
};
test("Codex isolates cwd, config, credentials environment and permissions", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "must-not-leak";
  try {
    const r = await codex({ ...options, model: "inspect" });
    const invocation = JSON.parse(r.content);
    assert.equal(invocation.env.OPENAI_API_KEY, undefined);
    assert.equal(invocation.env.CODEX_API_KEY, undefined);
    assert.equal(invocation.env.QLOOPS_DEPTH, "1");
    assert.notEqual(invocation.cwd, process.cwd());
    assert.equal(existsSync(invocation.cwd), false);
    assert.ok(invocation.args.includes("--ignore-user-config"));
    assert.ok(invocation.args.includes("read-only"));
    assert.ok(invocation.args.includes('forced_login_method="chatgpt"'));
    assert.ok(invocation.args.includes('approval_policy="never"'));
    assert.ok(invocation.args.includes("hooks"));
    assert.equal(r.usage.costUsd, null);
    assert.equal(r.provider.model, null);
    assert.equal(r.provider.authMethod, "chatgpt");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});
for (const [model, code] of [
  ["invalid", "INVALID_RESPONSE"],
  ["auth", "AUTH_REQUIRED"],
  ["denied", "PERMISSION_DENIED"],
  ["environment-denied", "CLI_ENVIRONMENT_DENIED"],
  ["timeout", "TIMEOUT"],
])
  test(`Codex ${model} fails without fallback`, async () =>
    assert.rejects(
      codex({ ...options, model, timeoutMs: model === "timeout" ? 250 : 3000 }),
      (e) => e.code === code && !e.message.includes("secret-do-not-expose"),
    ));
test("legacy CLI and API-key auth rejected before inference", async () => {
  let calls = 0;
  await assert.rejects(
    codex(options, {
      launch: async () => {
        calls++;
        return { code: 0, stdout: "0.1.2504161551", stderr: "" };
      },
    }),
    { code: "UNSUPPORTED_CLI" },
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    codex(options, {
      launch: async () => {
        calls++;
        return {
          code: 0,
          stdout:
            calls === 1 ? "codex-cli 0.153.4" : "Logged in using an API key",
          stderr: "",
        };
      },
    }),
    { code: "AUTH_REQUIRED" },
  );
  assert.equal(calls, 2);
});
test("Codex cancellation and missing binary are typed", async () => {
  await assert.rejects(codex({ ...options, executable: "/does/not/exist" }), {
    code: "MISSING_EXECUTABLE",
  });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 200);
  try {
    await assert.rejects(
      codex({ ...options, model: "timeout", signal: ac.signal }),
      { code: "CANCELLED" },
    );
  } finally {
    clearTimeout(timer);
  }
});
test("incomplete, reordered, extra and rate limited event streams fail closed", () => {
  const thread = { type: "thread.started", thread_id: "x" },
    start = { type: "turn.started" },
    message = {
      type: "item.completed",
      item: { type: "agent_message", text: "ok" },
    },
    done = { type: "turn.completed" };
  for (const events of [
    [thread, start, message],
    [start, thread, message, done],
    [thread, start, message, done, done],
    [thread, start, done],
    [null],
  ])
    assert.throws(
      () =>
        parseCodexResponse(
          { code: 0, stdout: events.map(JSON.stringify).join("\n") },
          "x",
        ),
      { code: "INVALID_RESPONSE" },
    );
  assert.throws(
    () =>
      parseCodexResponse(
        {
          code: 1,
          stdout: JSON.stringify({ type: "error", message: "usage limit" }),
        },
        "x",
      ),
    { code: "RATE_LIMITED" },
  );
});
test("Codex caller executes approved scope and resumes through installed-style CLI boundary", async (t) => {
  const workspace = mkdtempSync(join(tmpdir(), "qloops-codex-caller-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  writeFileSync(join(workspace, "value.mjs"), "export const add=()=>0;");
  writeFileSync(
    join(workspace, "verify.mjs"),
    "import {add} from './value.mjs';if(add(2,3)!==5||add(-2,1)!==-1)process.exit(1);",
  );
  const r = {
    ...JSON.parse(readFileSync("contracts/v1/fixtures.json")).positive,
    workspace,
    allowedPaths: ["value.mjs"],
    allowedTools: [process.execPath],
    verifier: { command: process.execPath, args: ["verify.mjs"] },
    provider: {
      kind: "codex",
      executable: options.executable,
      model: "fixture",
      payerScope: "local-cli",
    },
    deadlineMs: 5000,
  };
  const caller = async (request) => {
    const p = await subprocess(
      process.execPath,
      [resolve("bin/qloops.mjs"), "agent", "-"],
      {
        input: JSON.stringify(request),
        env: scopedEnvironment(),
        timeoutMs: 7000,
      },
    );
    return { code: p.code, result: JSON.parse(p.stdout) };
  };
  const first = await caller(r);
  assert.equal(first.code, 2);
  assert.equal(first.result.nextAction.type, "approve_spec");
  assert.match(readFileSync(join(workspace, "value.mjs"), "utf8"), /=>0/);
  const approved = {
    ...r,
    resumeRunId: first.result.runId,
    approval: { hash: first.result.nextAction.hash, decision: "approve" },
  };
  const result = await caller(approved);
  assert.equal(result.code, 0);
  assert.equal(result.result.provider.kind, "codex");
  assert.equal((await caller(approved)).result.status, "success");
});

test("Codex rejects invalid limits and oversized messages before launching", async () => {
  let calls = 0;
  const launch = async () => {
    calls++;
    throw Error("must not launch");
  };
  for (const patch of [
    { timeoutMs: Infinity },
    { timeoutMs: 0 },
    { messages: [] },
    { messages: [{ role: "user", content: "x".repeat(128001) }] },
  ])
    await assert.rejects(codex({ ...options, ...patch }, { launch }), {
      code: "INVALID_REQUEST",
    });
  assert.equal(calls, 0);
});

test("unsupported account model has a redacted typed error", () => {
  for (const message of [
    "The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account. secret-do-not-expose",
    "The model does not exist",
    "Unknown model requested",
  ]) {
    assert.throws(() => parseCodexResponse({code:1,stdout:JSON.stringify({type:'error',error:{message}})},'requested'),
      e => e.code === 'MODEL_UNAVAILABLE' && !e.message.includes('secret-do-not-expose'));
  }
  assert.throws(() => parseCodexResponse({code:1,stdout:[
    {type:'item.completed',item:{type:'agent_message',text:'Unknown model'}},
    {type:'error',message:'Internal server error'},
  ].map(JSON.stringify).join('\n')},'requested'),{code:'CLI_FAILED'});
});

test("only the exact pre-turn disabled code-mode diagnostic is accepted", () => {
  const warning = {type:'item.completed',item:{type:'error',message:'Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.'}};
  const thread={type:'thread.started',thread_id:'test'},start={type:'turn.started'},message={type:'item.completed',item:{type:'agent_message',text:'ok'}},done={type:'turn.completed'};
  const parse=events=>parseCodexResponse({code:0,stdout:events.map(JSON.stringify).join('\n')},'test');
  assert.deepEqual(parse([thread,warning,start,message,done]).provider.diagnostics,['CODE_MODE_DISABLED']);
  for(const events of [
    [thread,warning,warning,start,message,done],
    [thread,start,warning,message,done],
    [thread,{...warning,item:{...warning.item,message:'Permission denied'}},start,message,done],
  ]) assert.throws(()=>parse(events));
});
