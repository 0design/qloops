import { existsSync, readFileSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { hash, insist, resultEnvelope, CoreError } from "./contracts.mjs";
import { lockWorkspace, atomicJson } from "./workspace.mjs";
import { recoveryAction } from "./recovery.mjs";
import { validateCallerInput, callerInference, assertInferenceReply, invalidateInference, contentMessages } from "./caller-inference.mjs";
/** Reusable editorial pipeline. Caller supplies explicit provider, checker and
 * receiver adapters. Receipt storage is durable; ambiguous sends are never retried.
 * Callbacks are trusted host capabilities, never executable manifest strings. */
export async function runContent(
  {
    workspace,
    requestId,
    sources,
    profile,
    provider,
    receiver,
    approval,
    maxItems = 10,
    inferenceReply,
    cancelInference,
    maxInferenceJobs,
    inferenceTtlMs,
  },
  { generate, check, publish, signal, callerRequestHash } = {},
) {
  let lock, state, file, run;
  const cancelled = () => { if (signal?.aborted) throw new CoreError("CANCELLED", "Content operation cancelled"); };
  try {
    validateCallerInput({provider,inferenceReply,cancelInference,maxInferenceJobs,inferenceTtlMs});
    insist(
      typeof requestId === "string" &&
        Array.isArray(sources) &&
        sources.length > 0 &&
        sources.length <= 100,
      "Content request/sources required",
    );
    insist(
      typeof profile === "object" &&
        profile &&
        typeof provider?.id === "string" &&
        typeof provider?.version === "string",
      "Pinned profile/provider required",
    );
    insist(
      typeof receiver?.id === "string" && typeof receiver?.version === "string",
      "Pinned receiver required",
    );
    insist(
      Number.isInteger(maxItems) && maxItems > 0 && maxItems <= 50,
      "maxItems must be 1..50",
    );
    insist(
      (typeof generate === "function" || provider?.kind === "caller") &&
        typeof check === "function" &&
        typeof publish === "function",
      "Content requires provider, checker and publisher",
    );
    [sources, profile, provider, receiver] = structuredClone([sources, profile, provider, receiver]);
    const seen = new Set();
    const normalized = [];
    for (const source of sources) {
      insist(
        source &&
          typeof source.id === "string" &&
          source.id &&
          typeof source.url === "string" &&
          /^https?:\/\//.test(source.url) &&
          typeof source.text === "string" &&
          source.text.length <= 20000,
        "Invalid normalized source",
      );
      const key = hash({ id: source.id, url: source.url });
      if (!seen.has(key)) {
        seen.add(key);
        normalized.push({ ...source, key });
      }
    }
    lock = lockWorkspace(workspace);
    file = join(lock.dir, "content-state.json");
    if (existsSync(file))
      insist(!lstatSync(file).isSymbolicLink(), "Unsafe content state");
    state = existsSync(file)
      ? JSON.parse(readFileSync(file, "utf8"))
      : { protocolVersion: "qf.content-state/v1", publications: {} };
    const save = () => atomicJson(file, state);
    const delivered = new Set(
      Object.values(state.publications)
        .filter((p) => p.phase === "delivered" && p.receiver.id === receiver.id)
        .flatMap((p) => p.sourceKeys),
    );
    const selected = normalized
      .filter((s) => !delivered.has(s.key))
      .slice(0, maxItems);
    const key = hash({ sources: selected, profile, provider, receiver,
      ...(provider.kind==="caller"?{callerPolicy:{maxInferenceJobs:maxInferenceJobs??12,inferenceTtlMs:inferenceTtlMs??900000,maxItems,callerRequestHash:callerRequestHash??null}}:{}) });
    run = state.publications[key];
    assertInferenceReply(run,inferenceReply??cancelInference);
    if(cancelInference) throw new CoreError("CANCELLED","Pending inference cancelled by its caller");
    cancelled();
    const selectedKeys = new Set(selected.map((s) => s.key));
    const unresolved = Object.entries(state.publications).find(
      ([k, p]) =>
        k !== key &&
        ["sending", "uncertain"].includes(p.phase) &&
        p.receiver.id === receiver.id &&
        p.sourceKeys.some((s) => selectedKeys.has(s)),
    );
    if (unresolved)
      return resultEnvelope(
        { requestId },
        {
          protocolVersion: "qf.content/v1",
          status: "needs_human",
          summary:
            "Overlapping source has an uncertain publication; reconcile first",
          nextAction: {
            type: "reconcile_receipt",
            idempotencyKey: unresolved[1].idempotencyKey,
          },
        },
      );
    const out = (status, summary, extra = {}) =>
      resultEnvelope(
        { requestId },
        {
          protocolVersion: "qf.content/v1",
          runId: run?.runId ?? null,
          status,
          summary,
          ...extra,
        },
      );
    if (selected.length === 0)
      return out("success", "No new sources; no publication attempted", {
        nextAction: { type: "no_new_sources" },
      });
    if (!run) {
      run = {
        runId: randomUUID(),
        phase: "draft",
        sourceKeys: selected.map((s) => s.key),
        receiver,
        ...(provider.kind==="caller"?{callerRequestHash:callerRequestHash??null}:{}),
      };
      state.publications[key] = run;
      save();
    }
    if (run.phase === "sending" || run.phase === "uncertain")
      return out(
        "needs_human",
        "Publication outcome uncertain; reconcile receiver receipt before any retry",
        {
          nextAction: {
            type: "reconcile_receipt",
            idempotencyKey: run.idempotencyKey,
          },
        },
      );
    if (run.phase === "rejected") return out("cancelled", "Draft rejected");
    if (run.phase === "draft") {
      let draft;
      if (provider.kind === "caller") {
        const result=callerInference(run,{messages:contentMessages(selected,profile),phase:"content-draft",outputKind:"content",binding:{key},provider,maxInferenceJobs,inferenceTtlMs,reply:inferenceReply,save});
        draft={text:JSON.parse(result.content).text,usage:result.usage};
        run.provider=result.provider;
      } else draft = await generate({ ...structuredClone({sources: selected, profile}), signal });
      cancelled();
      insist(
        typeof draft?.text === "string" &&
          draft.text.trim() &&
          draft.text.length <= 64000,
        "Invalid editorial draft",
      );
      run.text = draft.text;
      run.usage = draft.usage ?? null;
      run.approvalHash = hash({
        text: run.text,
        sources: selected,
        profile,
        provider,
        receiver,
      });
      run.phase = "check";
      save();
    }
    if (run.phase === "check") {
      const findings = await check({
        text: run.text,
        ...structuredClone({sources: selected, profile}),
        signal,
      });
      cancelled();
      insist(
        findings && ["pass", "fail", "unknown"].includes(findings.outcome),
        "Invalid content checker result",
      );
      run.check = findings;
      run.phase = findings.outcome === "pass" ? "approval" : "check_failed";
      save();
    }
    if (run.phase === "check_failed")
      return out("needs_human", "Editorial checks did not pass", {
        evidence: [run.check],
      });
    if (approval?.hash === run.approvalHash && approval?.decision === "reject") {
      run.phase = "rejected";
      save();
      return out("cancelled", "Draft rejected");
    }
    if (approval?.hash !== run.approvalHash || approval?.decision !== "approve")
      return out("needs_human", "Approve this exact draft and receiver", {
        nextAction: {
          type: "approve_publication",
          hash: run.approvalHash,
          text: run.text,
          receiver,
        },
        evidence: [run.check],
      });
    cancelled();
    run.idempotencyKey = hash({
      runId: run.runId,
      approvalHash: run.approvalHash,
    });
    run.phase = "sending";
    save();
    let receipt;
    try {
      receipt = await publish({
        text: run.text,
        receiver: structuredClone(receiver),
        signal,
        idempotencyKey: run.idempotencyKey,
      });
    } catch {
      run.phase = "uncertain";
      save();
      return out(
        "needs_human",
        "Receiver failed after send began; delivery unconfirmed",
        {
          nextAction: {
            type: "reconcile_receipt",
            idempotencyKey: run.idempotencyKey,
          },
        },
      );
    }
    if (
      !receipt ||
      typeof receipt.id !== "string" ||
      !receipt.id.trim() ||
      receipt.delivered !== true
    ) {
      run.phase = "uncertain";
      save();
      return out(
        "needs_human",
        "Receiver returned no confirmed delivery receipt",
      );
    }
    run.receipt = receipt;
    run.phase = "delivered";
    save();
    return out("success", "Publication confirmed by receiver", {
      artifacts: [{ revision: 1, sha256: hash(run.text) }],
      evidence: [run.check, { outcome: "pass", receipt: run.receipt }],
      usage: run.usage,
    });
  } catch (e) {
    const cancelled = signal?.aborted || e.code === "CANCELLED";
    const nextAction = cancelled ? null : e.code === "INFERENCE_REQUIRED" ? e.nextAction : recoveryAction(e.code);
    if (run && state && file) {
      if (cancelled) invalidateInference(run);
      atomicJson(file,state);
    }
    return resultEnvelope(
      { requestId },
      {
        protocolVersion: "qf.content/v1",
        status: cancelled ? "cancelled" : nextAction ? "needs_human" : "failed",
        runId: run?.runId ?? null,
        nextAction,
        summary: "Content pipeline failed",
        error: {
          code: e instanceof CoreError ? e.code : "CONTENT_FAILED",
          message: e instanceof CoreError ? e.message : "Provider or checker failed",
        },
      },
    );
  } finally {
    lock?.release();
  }
}

// HTTP cancellation needs no source fetch or provider/receiver credentials. The
// immutable request identity binds it to the persisted job before invalidation.
export function cancelContentInference({workspace,requestId,cancelInference},callerRequestHash) {
  const lock=lockWorkspace(workspace);
  try {
    const file=join(lock.dir,"content-state.json");
    insist(existsSync(file)&&!lstatSync(file).isSymbolicLink(),"No pending Content inference","STALE_INFERENCE");
    const state=JSON.parse(readFileSync(file,"utf8"));
    const run=Object.values(state.publications).find(p=>p.pendingInference?.jobId===cancelInference.jobId);
    assertInferenceReply(run,cancelInference);
    insist(run.callerRequestHash===callerRequestHash,"Content cancellation request changed","STALE_INFERENCE");
    invalidateInference(run);atomicJson(file,state);
    return resultEnvelope({requestId},{protocolVersion:"qf.content/v1",runId:run.runId,status:"cancelled",summary:"Pending inference cancelled by its caller"});
  } finally {lock.release();}
}

/** Reconcile by asking the configured receiver; never fabricate a receipt from
 * a local approval. Confirmed delivery advances dedup without another send. */
export async function reconcilePublication(
  { workspace, runId, idempotencyKey },
  { lookup } = {},
) {
  insist(typeof lookup === "function", "Receiver lookup capability required");
  const lock = lockWorkspace(workspace);
  try {
    const file = join(lock.dir, "content-state.json");
    insist(
      existsSync(file) && !lstatSync(file).isSymbolicLink(),
      "Missing or unsafe content state",
    );
    const state = JSON.parse(readFileSync(file, "utf8"));
    const run = Object.values(state.publications).find(
      (r) => r.runId === runId && r.idempotencyKey === idempotencyKey,
    );
    insist(
      run && ["sending", "uncertain"].includes(run.phase),
      "No matching uncertain publication",
    );
    const receipt = await lookup({ receiver: run.receiver, idempotencyKey });
    if (
      !receipt ||
      receipt.delivered !== true ||
      typeof receipt.id !== "string" ||
      !receipt.id.trim()
    )
      return {
        status: "needs_human",
        reason: "Receiver still has no confirmed delivery",
      };
    run.receipt = receipt;
    run.phase = "delivered";
    atomicJson(file, state);
    return { status: "success", receipt, reconciled: true };
  } finally {
    lock.release();
  }
}
