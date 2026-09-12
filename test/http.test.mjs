import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchWithRetry } from "../src/http.mjs";
import { chatOnce, fetchWithRetry as legacyFetch } from "../src/steps.mjs";
import { createRun, driveRun, RunStore } from "../src/run.mjs";

const instant = { retries: 2, delaysMs: [0], timeoutMs: 1000 };

async function withServer(handler, work) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await work(`http://127.0.0.1:${server.address().port}`);
  } finally {
    const closed = new Promise((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
    server.closeAllConnections();
    await closed;
  }
}

test("legacy transport export remains the same function", () => {
  assert.equal(legacyFetch, fetchWithRetry);
});

test("invalid retry policy fails before any network call", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; });
  for (const overrides of [
    { retries: -1 }, { retries: 1.5 }, { retries: Infinity }, { retries: 11 },
    { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: 2 ** 32 },
    { delaysMs: [] }, { delaysMs: [-1] }, { delaysMs: [Infinity] },
  ]) {
    await assert.rejects(fetchWithRetry("https://unused.test", {}, { ...instant, ...overrides }), RangeError);
  }
  assert.equal(calls, 0);
});

for (const status of [400, 401, 403, 404]) {
  test(`real HTTP ${status} is fail-fast`, async () => {
    let calls = 0;
    await withServer((req, res) => { calls++; res.writeHead(status).end("rejected"); }, async url => {
      const res = await fetchWithRetry(url, {}, instant);
      assert.equal(res.status, status);
      assert.equal(await res.text(), "rejected");
      assert.equal(calls, 1);
    });
  });
}

for (const status of [429, 500, 503]) {
  test(`real HTTP ${status} recovers without exceeding the retry limit`, async () => {
    let calls = 0;
    await withServer((req, res) => {
      calls++;
      res.writeHead(calls < 3 ? status : 200).end(calls < 3 ? "retry" : "recovered");
    }, async url => {
      const res = await fetchWithRetry(url, {}, instant);
      assert.equal(await res.text(), "recovered");
      assert.equal(calls, 3);
    });
  });
}

test("exhaustion returns the final HTTP failure, not synthetic success", async () => {
  let calls = 0;
  await withServer((req, res) => { calls++; res.writeHead(503).end("still unavailable"); }, async url => {
    const res = await fetchWithRetry(url, {}, instant);
    assert.equal(res.status, 503);
    assert.equal(await res.text(), "still unavailable");
    assert.equal(calls, 3);
  });
});

test("real timeout recovers on the next request", async () => {
  let calls = 0;
  await withServer((req, res) => {
    if (++calls > 1) res.end("recovered");
  }, async url => {
    const res = await fetchWithRetry(url, {}, { ...instant, timeoutMs: 100 });
    assert.equal(await res.text(), "recovered");
    assert.equal(calls, 2);
  });
});

test("persistent real timeout exhausts bounded attempts", async () => {
  let calls = 0;
  await withServer(() => { calls++; }, async url => {
    await assert.rejects(fetchWithRetry(url, {}, { ...instant, timeoutMs: 100 }), { name: "TimeoutError" });
    assert.equal(calls, 3);
  });
});

test("discarded response body is canceled before the next attempt", async t => {
  let calls = 0;
  let canceled = false;
  t.mock.method(globalThis, "fetch", async () => {
    if (++calls === 1) {
      return new Response(new ReadableStream({ cancel() { canceled = true; } }), { status: 503 });
    }
    assert.equal(canceled, true);
    return new Response("ok");
  });
  const res = await fetchWithRetry("https://unused.test", {}, instant);
  assert.equal(await res.text(), "ok");
});

test("pre-aborted caller never sends a request", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; });
  const controller = new AbortController();
  const reason = new Error("owner stopped run");
  controller.abort(reason);
  await assert.rejects(fetchWithRetry("https://unused.test", { signal: controller.signal }, instant), e => e === reason);
  assert.equal(calls, 0);
});

test("caller cancellation during real HTTP is not retried", async () => {
  const controller = new AbortController();
  let calls = 0;
  await withServer(() => { calls++; controller.abort(); }, async url => {
    await assert.rejects(fetchWithRetry(url, { signal: controller.signal }, instant), { name: "AbortError" });
    assert.equal(calls, 1);
  });
});

test("caller cancellation interrupts backoff", async t => {
  const controller = new AbortController();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    return new Response("busy", { status: 429 });
  });
  await assert.rejects(fetchWithRetry("https://unused.test", { signal: controller.signal }, {
    ...instant, delaysMs: [10_000],
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("model caller preserves payload and uses shared transport recovery", async t => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init.headers.Authorization, "Bearer fake-test-key");
    assert.equal(JSON.parse(init.body).model, "test/model");
    if (++calls === 1) return new Response("busy", { status: 503 });
    return Response.json({ choices: [{ message: { content: "recovered" } }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
  });
  const result = await chatOnce({ apiKey: "fake-test-key", model: "test/model", system: "s", user: "u", maxTokens: 16, ...instant });
  assert.equal(result.content, "recovered");
  assert.equal(result.usage.tokensIn, 4);
  assert.equal(calls, 2);
});

async function assertDriverFailure(status) {
  const dir = await mkdtemp(join(tmpdir(), "qloops-http-"));
  try {
    const store = new RunStore(dir);
    let calls = 0;
    await withServer((req, res) => { calls++; res.writeHead(status).end("rejected"); }, async url => {
      const run = createRun({ id: "http-failure", name: "HTTP failure", steps: [
        { id: "source", kind: "fetch", config: { url } },
        { id: "downstream", kind: "fetch", config: { url } },
      ] });
      await driveRun(run, { store });
      const saved = store.load(run.runId);
      assert.equal(saved.status, "failed");
      assert.equal(saved.steps[0].status, "failed");
      assert.ok(saved.steps[0].errorText.includes(`HTTP ${status}`));
      assert.equal(saved.steps[1].status, "pending");
      assert.equal(calls, status === 401 ? 1 : 3);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const status of [401, 503]) {
  test(`driver persists failed state after HTTP ${status} and does not execute downstream`,
    () => assertDriverFailure(status));
}

test("driver persists success only after real HTTP recovery and downstream completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "qloops-recovery-"));
  try {
    const store = new RunStore(dir);
    let calls = 0;
    await withServer((req, res) => {
      calls++;
      res.writeHead(calls === 1 ? 503 : 200).end(calls === 1 ? "busy" : "recovered");
    }, async url => {
      const run = createRun({ id: "http-recovery", name: "HTTP recovery", steps: [
        { id: "source", kind: "fetch", config: { url } },
        { id: "downstream", kind: "fetch", config: { url } },
      ] });
      await driveRun(run, { store });
      const saved = store.load(run.runId);
      assert.equal(saved.status, "success");
      assert.ok(saved.steps.every(step => step.status === "success"));
      assert.equal(saved.steps[0].output.body, "recovered");
      assert.equal(calls, 3);
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
