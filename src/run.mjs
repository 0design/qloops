/**
 * The driver — `driveRun` without a database.
 *
 * Step for step it follows `lib/processes/orchestrator.ts`, and the order of the
 * checks is the part that matters most:
 *
 *   0. a kind the engine does not execute → the step fails BY NAME
 *   1. BUDGET, before the paid step — a ceiling verified afterwards is not a
 *      ceiling, it is a report of an overrun
 *   2. sensitivity — see the refusal below; this build does not implement it
 *   3. execute, record output + tokens + cost
 *
 * A run that stops at a human gate is not finished and not failed: it is
 * `waiting_human`, held on disk, and `qloops approve` continues it from exactly
 * there. The loop re-reads its own step list on every iteration, which is why a
 * run parked yesterday resumes today with nothing kept in memory.
 *
 * HUMAN-GATE IS OPTIONAL. Nothing here assumes a run must meet a person; a loop
 * that ends in `api-request` is a complete loop.
 */
import { flattenLoopSteps, isExpandingFanOut, SEQ_STRIDE } from "./flatten.mjs";
import { runFetch, runLlmCall, runApiRequest, runApprovalGate, stepLabel } from "./steps.mjs";
import { num, str } from "./config.mjs";
import { resolveTemplateValue } from "./template.mjs";
import { usdForTokens } from "./cost.mjs";
import { RunStore, newRunId } from "./state.mjs";

/** Default ceiling per run, USD. Not infinity: a run without one spends whatever
 *  it manages to before somebody notices. Raise it explicitly in `settings`. */
export const DEFAULT_RUN_BUDGET_USD = 1;
export const DEFAULT_MAX_TOKENS = 1200;

const ENGINE_KINDS = new Set(["fetch", "llm-call", "api-request", "approval-gate"]);

/** The three knobs, resolved once per run, with where each value came from. */
export function resolveKnobs(settings = {}) {
  const model = settings.model ?? process.env.OPENROUTER_MODEL ?? null;
  const budgetUsd =
    "budgetUsd" in settings ? settings.budgetUsd : DEFAULT_RUN_BUDGET_USD;
  return {
    model,
    budgetUsd,
    sensitivity: settings.sensitivity ?? null,
    limits: settings.limits ?? null,
    exit: settings.exit ?? { kind: "always_done" },
    provenance: {
      model: settings.model ? "loop settings" : process.env.OPENROUTER_MODEL ? "OPENROUTER_MODEL" : "not configured",
      budget: "budgetUsd" in settings ? "loop settings" : "default",
    },
  };
}

/** Per-step model override (knob 2 is strongest at the step). */
function stepModel(step, knobs) {
  return str(step.config, "model") ?? knobs.model;
}
function stepMaxTokens(step) {
  return num(step.config, "maxTokens") ?? DEFAULT_MAX_TOKENS;
}

function summarise(status, rows, dryRun = false) {
  const ok = rows.filter((r) => r.status === "success").length;
  if (status === "success" && dryRun) {
    const planned = rows.filter((r) => r.status === "planned").length;
    return `Planned ${planned}/${rows.length} steps — dry run, nothing was executed.`;
  }
  if (status === "success") return `Completed ${ok}/${rows.length} steps.`;
  const failed = rows.find((r) => r.status === "failed");
  if (failed) return `Step "${failed.name}": ${failed.errorText ?? "failed with no explanation"}`;
  const waiting = rows.find((r) => r.status === "waiting_human");
  return waiting ? `Waiting on a human at step "${waiting.name}".` : `Completed ${ok}/${rows.length}.`;
}

/** Build the initial run record from a manifest. */
export function createRun(manifest, { trigger = "manual" } = {}) {
  const flat = flattenLoopSteps(manifest.steps);
  return {
    runId: newRunId(),
    loopId: manifest.id,
    loopName: manifest.name,
    manifestFile: manifest.file ?? null,
    trigger,
    status: "running",
    summary: "",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    steps: flat.map(({ step, seq, depth, laneOf }) => ({
      seq,
      stepId: step.id,
      kind: step.kind,
      name: stepLabel(step),
      depth,
      laneOf,
      /* The step config is a SNAPSHOT. A run parked at a gate for a week must
         replay with the prompt it was created with, or its history starts lying. */
      config: step.config,
      then: step.then ?? null,
      status: "pending",
      decision: null,
      gateReason: null,
      output: null,
      errorText: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      item: undefined,
      itemIndex: null,
      startedAt: null,
      finishedAt: null,
    })),
  };
}

/**
 * Drive a run to its next stopping point: success, failure, or a human gate.
 *
 * @param {object} run    the run record (mutated and persisted as it advances)
 * @param {object} opts   { store, apiKey, dryRun, onStep }
 */
export async function driveRun(run, opts = {}) {
  const { store, apiKey = null, dryRun = false, onStep = () => {} } = opts;
  const knobs = opts.knobs ?? resolveKnobs(opts.settings ?? {});

  /* SENSITIVITY IS NOT IMPLEMENTED HERE — and it is refused, not ignored.
     The profile exists to stop irreversible or outbound steps and hand them to a
     person. Running the loop anyway "because the local runner is simpler" would
     perform exactly the actions the knob was set to prevent, silently. */
  if (knobs.sensitivity) {
    throw new Error(
      "This manifest sets settings.sensitivity, which the local runner does not implement. " +
        "It is refused rather than ignored: the profile exists to hold back irreversible steps, " +
        "and ignoring it would carry them out. Run this loop in the product, or remove the profile.",
    );
  }

  const persist = () => {
    if (store) store.save(run);
  };

  for (;;) {
    const next = run.steps.find((s) => s.status === "pending");

    if (!next) {
      const anyFailed = run.steps.some((s) => s.status === "failed");
      const anyWaiting = run.steps.some((s) => s.status === "waiting_human");
      run.status = anyFailed ? "failed" : anyWaiting ? "waiting_human" : "success";
      run.summary = summarise(run.status, run.steps, dryRun);
      run.finishedAt = new Date().toISOString();
      persist();
      return run;
    }

    /* Input of a step = outputs of prior SUCCESSFUL steps, in execution order. */
    const priorOutputs = {};
    const priorStepNames = {};
    for (const s of run.steps) {
      if (s.seq >= next.seq) break;
      priorStepNames[s.stepId] = s.name ?? s.kind;
      if (s.status === "success" && s.output != null) priorOutputs[s.stepId] = s.output;
    }

    const step = { id: next.stepId, kind: next.kind, config: next.config, then: next.then ?? undefined };

    /* ── 0. fan-out — rows, not output ─────────────────────────────────── */
    if (next.kind === "fan-out") {
      expandFanOut(run, next, step, priorOutputs, priorStepNames, dryRun);
      persist();
      onStep(next);
      continue;
    }
    if (!ENGINE_KINDS.has(next.kind)) {
      next.status = "failed";
      next.errorText = `Step kind "${next.kind}" is not executed by the runner.`;
      next.startedAt = next.finishedAt = new Date().toISOString();
      persist();
      onStep(next);
      continue;
    }

    /* ── 1. BUDGET (knob 3), BEFORE the paid step ───────────────────────── */
    const spent = run.steps.reduce((acc, s) => acc + Number(s.costUsd ?? 0), 0);
    const paidKind = next.kind === "llm-call" || next.kind === "approval-gate";
    if (paidKind && knobs.budgetUsd !== null && spent >= knobs.budgetUsd) {
      next.status = "failed";
      next.gateReason = "budget";
      next.errorText = `Run budget exhausted: spent $${spent.toFixed(4)} of the $${knobs.budgetUsd.toFixed(4)} ceiling (the loop's "budgetUsd" knob).`;
      next.startedAt = next.finishedAt = new Date().toISOString();
      run.status = "failed";
      run.summary = `Stopped by budget: $${spent.toFixed(4)} ≥ $${knobs.budgetUsd.toFixed(4)}.`;
      run.finishedAt = new Date().toISOString();
      persist();
      onStep(next);
      return run;
    }

    /* ── 2. EXECUTE ─────────────────────────────────────────────────────── */
    const ctx = {
      runId: run.runId,
      templateId: run.loopId,
      stepId: next.stepId,
      priorOutputs,
      priorStepNames,
      item: next.item,
      itemIndex: next.itemIndex,
      apiKey,
      /* What the run has spent BEFORE this step — the number {{run.costUsd}}
         resolves to. On the last api-request it is the run's whole cost. */
      spentUsd: spent,
      /* Only present when there is somewhere to write. Without a store there is
         no `.qf/` and no fallback — the request goes out or it does not. */
      fileSink: store ? (body) => store.writeSink(run.runId, body) : null,
    };

    next.status = "running";
    next.startedAt = new Date().toISOString();
    persist();

    /* A dry run performs no side effects at all — no fetch, no model call, no
       outgoing request. It proves the manifest resolves and the order is what
       the author expected, and it says "planned", never "success". */
    if (dryRun) {
      next.status = "planned";
      next.finishedAt = new Date().toISOString();
      next.output = plannedOutput(step, ctx, knobs);
      persist();
      onStep(next);
      continue;
    }

    try {
      const result = await dispatch(step, ctx, knobs);
      const costUsd = result.costUsd ?? usdForTokens(result.tokensIn ?? 0, result.tokensOut ?? 0);
      next.status = result.waitingHuman ? "waiting_human" : "success";
      next.gateReason = result.waitingHuman ? "gate" : null;
      next.output = result.output;
      next.tokensIn = result.tokensIn ?? 0;
      next.tokensOut = result.tokensOut ?? 0;
      next.costUsd = Number(costUsd.toFixed(4));
      next.finishedAt = result.waitingHuman ? null : new Date().toISOString();

      run.tokensIn += next.tokensIn;
      run.tokensOut += next.tokensOut;
      run.costUsd = Number((run.costUsd + next.costUsd).toFixed(4));
      persist();
      onStep(next);

      if (result.waitingHuman) {
        run.status = "waiting_human";
        run.summary = `Waiting on a human at step "${next.name ?? next.kind}".`;
        persist();
        return run;
      }
    } catch (e) {
      next.status = "failed";
      next.errorText = e instanceof Error ? e.message : String(e);
      next.finishedAt = new Date().toISOString();
      run.status = "failed";
      run.summary = next.errorText;
      run.finishedAt = new Date().toISOString();
      persist();
      onStep(next);
      return run;
    }
  }
}

async function dispatch(step, ctx, knobs) {
  switch (step.kind) {
    case "fetch":
      return runFetch(step, ctx);
    case "llm-call":
      return runLlmCall(step, ctx, stepModel(step, knobs), stepMaxTokens(step));
    case "api-request":
      return runApiRequest(step, ctx);
    case "approval-gate":
      return runApprovalGate(step, ctx, stepModel(step, knobs), stepMaxTokens(step));
    default:
      throw new Error(`Step kind "${step.kind}" is not executed by the runner.`);
  }
}

/** What `--dry-run` records instead of a real result. */
function plannedOutput(step, ctx, knobs) {
  const label = stepLabel(step);
  if (step.kind === "llm-call") {
    return { planned: true, step: label, model: stepModel(step, knobs), maxTokens: stepMaxTokens(step) };
  }
  if (step.kind === "fetch" || step.kind === "api-request") {
    const raw = str(step.config, "url") ?? "";
    return { planned: true, step: label, url: raw, method: str(step.config, "method") ?? (step.kind === "fetch" ? "GET" : "POST") };
  }
  if (step.kind === "approval-gate") {
    return { planned: true, step: label, reviewer: str(step.config, "reviewer") ?? "human" };
  }
  return { planned: true, step: label };
}

/**
 * Expand a fan-out lane over the items of a prior step's array.
 *
 * The expanded rows' `seq` lands BETWEEN the fan-out node and the next top-level
 * step — that is what SEQ_STRIDE leaves room for. So the item cap is not
 * arbitrary: items × lane length has to fit in the gap.
 *
 * TRUNCATION IS NEVER SILENT. How many arrived, how many were taken and why is
 * all in the node's own output. A 500-entry feed against a cap of 50 has to say
 * so, not report success and move on.
 */
function expandFanOut(run, row, step, priorOutputs, priorStepNames, dryRun) {
  const label = row.name ?? "fan-out";
  const overExpr = str(step.config, "over") ?? "";
  const lane = step.then ?? [];
  const now = new Date().toISOString();
  const fail = (msg) => {
    row.status = "failed";
    row.errorText = msg;
    row.startedAt = row.finishedAt = now;
  };

  if (lane.length === 0) {
    fail(`"${label}": the fan-out lane is empty — there is nothing to repeat per item.`);
    return;
  }
  if (!overExpr) {
    /* Pre-0034 behaviour, kept: the inlined lane runs ONCE and the node says so
       rather than pretending it expanded. */
    row.status = dryRun ? "planned" : "success";
    row.startedAt = row.finishedAt = now;
    row.output = {
      fannedOut: false,
      reason:
        'This fan-out has no "over" source, so its lane runs ONCE. Point it at a prior step\'s array to expand per item.',
    };
    return;
  }

  const value = resolveTemplateValue(overExpr, { priorOutputs, priorStepNames });
  if (!Array.isArray(value)) {
    if (dryRun) {
      /* Nothing has run, so no array can exist yet. Say that plainly instead of
         reporting a configuration error that is not one. */
      row.status = "planned";
      row.startedAt = row.finishedAt = now;
      row.output = { planned: true, step: label, over: overExpr, note: "lane size is unknown until the source step has run" };
      return;
    }
    fail(
      `"${label}": "over" (${overExpr}) did not resolve to an array` +
        `${value === undefined ? " — no such step or path" : ` (got ${typeof value})`}.`,
    );
    return;
  }

  const roomFor = Math.floor((SEQ_STRIDE - 1) / lane.length);
  const configured = num(step.config, "maxItems");
  const cap = Math.max(0, Math.min(configured && configured > 0 ? configured : 50, roomFor));
  const taken = value.slice(0, cap);

  const rows = taken.flatMap((item, i) =>
    lane.map((laneStep, j) => ({
      seq: row.seq + 1 + i * lane.length + j,
      stepId: laneStep.id,
      kind: laneStep.kind,
      name: stepLabel(laneStep),
      depth: row.depth + 1,
      laneOf: step.id,
      config: laneStep.config,
      then: laneStep.then ?? null,
      status: "pending",
      decision: null,
      gateReason: null,
      output: null,
      errorText: null,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      item,
      itemIndex: i,
      startedAt: null,
      finishedAt: null,
    })),
  );

  run.steps.push(...rows);
  run.steps.sort((a, b) => a.seq - b.seq);

  row.status = "success";
  row.startedAt = row.finishedAt = now;
  row.output = {
    source: overExpr,
    fannedOut: true,
    laneSteps: lane.length,
    itemsFound: value.length,
    itemsTaken: taken.length,
    stepsCreated: rows.length,
    ...(taken.length < value.length
      ? { truncated: `${value.length - taken.length} item(s) skipped by the cap of ${cap}` }
      : {}),
  };
}

/** Continue a run that is parked at a human gate. */
export async function resumeRun(run, { decision, ...opts }) {
  const gate = run.steps.find((s) => s.status === "waiting_human");
  if (!gate) throw new Error(`Run ${run.runId} is not waiting on anyone (status: ${run.status}).`);
  gate.decision = decision;
  if (decision === "reject") {
    gate.status = "failed";
    gate.errorText = "Rejected at the gate by a human.";
    gate.finishedAt = new Date().toISOString();
    run.status = "failed";
    run.summary = `Step "${gate.name}": rejected at the gate.`;
    run.finishedAt = new Date().toISOString();
    opts.store?.save(run);
    return run;
  }
  gate.status = "success";
  gate.finishedAt = new Date().toISOString();
  run.status = "running";
  run.finishedAt = null;
  return driveRun(run, opts);
}

export { RunStore };
