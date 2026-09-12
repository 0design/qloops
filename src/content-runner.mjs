import { runContent, cancelContentInference } from "./content.mjs";
import { openRouter } from "./providers/openrouter.mjs";
import { codex } from "./providers/codex.mjs";
import { claude } from "./providers/claude.mjs";
import { fetchWithRetry } from "./http.mjs";
import { insist, resultEnvelope, hash, CoreError } from "./contracts.mjs";
import { recoveryAction } from "./recovery.mjs";
import { validateCallerInput, contentMessages } from "./caller-inference.mjs";
async function boundedText(response) {
  const reader = response.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > 64000) {
      await reader.cancel();
      throw Error("Response too large");
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts).toString("utf8");
}
function allowedUrl(raw, origins) {
  const url = new URL(raw);
  insist(
    ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      origins.includes(url.origin),
    "URL origin not authorized",
    "SCOPE_DENIED",
  );
  return url.href;
}
/** Concrete source/model/check/webhook adapters. Receiver must implement the
 * documented receipt contract; Telegram is not inferred from a file sink. */
export async function runContentRequest(r, { env = process.env, signal } = {}) {
  let combined;
  try {
    insist(
      r?.protocolVersion === "qf.content-request/v1",
      "Invalid content protocol",
    );
    insist(
      Array.isArray(r.allowedOrigins) &&
        r.allowedOrigins.every((x) => typeof x === "string"),
      "Explicit allowedOrigins required",
    );
    insist(
      Number.isInteger(r.deadlineMs) &&
        r.deadlineMs > 0 &&
        r.deadlineMs <= 300000,
      "Invalid deadline",
    );
    combined = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(r.deadlineMs)])
      : AbortSignal.timeout(r.deadlineMs);
    insist(
      r.provider && ["claude", "codex", "openrouter", "caller"].includes(r.provider.kind),
      "Explicit content provider required",
    );
    validateCallerInput(r);
    const {approval,inferenceReply,cancelInference,requestId,...callerIdentity}=r;
    const callerRequestHash = r.provider.kind==="caller" ? hash(callerIdentity) : undefined;
    if(cancelInference) return cancelContentInference(r,callerRequestHash);
    insist(
      r.receiver?.kind === "webhook",
      "Only explicit receipt-aware webhook supported",
    );
    const target = allowedUrl(r.receiver.url, r.allowedOrigins);
    let key;
    if (r.receiver.keyRef) {
      insist(
        /^[A-Z_][A-Z0-9_]*$/.test(r.receiver.keyRef),
        "Invalid receiver keyRef",
      );
      key = env[r.receiver.keyRef];
      insist(key, "Receiver key missing", "AUTH_REQUIRED");
    }
    const sources = [];
    insist(
      Array.isArray(r.sources) &&
        r.sources.length > 0 &&
        r.sources.length <= 20,
      "1..20 sources required",
    );
    for (const s of r.sources) {
      const url = allowedUrl(s.url, r.allowedOrigins);
      const response = await fetchWithRetry(
        url,
        { signal: combined, redirect: "error" },
        { timeoutMs: 10000, retries: 2 },
      );
      insist(response.ok, `Source HTTP ${response.status}`);
      sources.push({ id: s.id, url, text: await boundedText(response) });
    }
    const result = await runContent(
      {
        ...r,
        sources,
        provider: { ...r.provider, id: r.provider.kind, version: "1" },
        receiver: { ...r.receiver, id: r.receiver.id ?? target, version: "1" },
      },
      {
        signal: combined,
        callerRequestHash,
        generate: async ({ sources, profile }) => {
          const messages = contentMessages(sources,profile);
          const opts = {
            ...r.provider,
            messages,
            maxTokens: 2000,
            signal: combined,
            timeoutMs: r.deadlineMs,
            cwd: r.workspace,
            runId: "content",
          };
          const result =
            r.provider.kind === "claude"
              ? await claude(opts)
              : r.provider.kind === "codex"
                ? await codex(opts)
                : await openRouter(opts, { env });
          return { text: result.content, usage: result.usage };
        },
        check: async ({ text, sources }) => ({
          outcome: sources.every((s) => text.includes(s.url)) ? "pass" : "fail",
          rule: "source-attribution/v1",
          textHash: hash(text),
          coverage: sources.map((s) => ({
            id: s.id,
            attributed: text.includes(s.url),
          })),
        }),
        publish: async ({ text, idempotencyKey }) => {
          const response = await fetch(target, {
            method: "POST",
            signal: combined,
            redirect: "error",
            headers: {
              "Content-Type": "application/json",
              "Idempotency-Key": idempotencyKey,
              ...(key ? { Authorization: `Bearer ${key}` } : {}),
            },
            body: JSON.stringify({ text }),
          });
          insist(response.ok, `Receiver HTTP ${response.status}`);
          return JSON.parse(await boundedText(response));
        },
      },
    );
    if (combined.aborted && !signal?.aborted && result.status === "cancelled")
      return {...result,status:"needs_human",summary:"Content deadline exceeded",error:{code:"TIMEOUT",message:"Content deadline exceeded"},nextAction:{type:"review_limits"}};
    return result;
  } catch (e) {
    const code=signal?.aborted ? "CANCELLED" : combined?.aborted ? "TIMEOUT" : e instanceof CoreError ? e.code : "CONTENT_FAILED";
    const nextAction = code === "TIMEOUT" ? {type:"review_limits"} : recoveryAction(code);
    return resultEnvelope(r, {
      protocolVersion: "qf.content/v1",
      status: code === "CANCELLED" ? "cancelled" : nextAction ? "needs_human" : "failed",
      nextAction,
      summary: "Content request failed",
      error: {
        code,
        message: e instanceof CoreError ? e.message : "Source/provider/receiver unavailable",
      },
    });
  }
}
