import { validateSpecInputs } from "./specification.mjs";
import { validateCallerInput } from "./caller-inference.mjs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
export const PROTOCOL = "qf.agent/v1";
export const EXIT_CODES = Object.freeze({
  success: 0,
  failed: 1,
  needs_human: 2,
  cancelled: 130,
});
export const hash = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : canonical(value),
    )
    .digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export class CoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
export function insist(ok, message, code = "INVALID_REQUEST") {
  if (!ok) throw new CoreError(code, message);
}
export function validateRequest(r) {
  insist(
    r && typeof r === "object" && !Array.isArray(r),
    "Request must be an object",
  );
  const keys = [
    "protocolVersion",
    "requestId",
    "loop",
    "intent",
    "workspace",
    "allowedPaths",
    "allowedTools",
    "provider",
    "deadlineMs",
    "maxRepairAttempts",
    "verifier",
    "approval",
    "resumeRunId",
    "maxCostUsd",
    "maxCallCostUsd",
    "specification",
    "clarification",
    "specChange",
    "inferenceReply",
    "cancelInference",
    "maxInferenceJobs",
    "inferenceTtlMs",
  ];
  insist(
    Object.keys(r).every((k) => keys.includes(k)),
    "Unknown request field",
  );
  insist(
    r && r.protocolVersion === PROTOCOL,
    `protocolVersion must be ${PROTOCOL}`,
  );
  insist(
    typeof r.requestId === "string" && /^[\w-]{1,100}$/.test(r.requestId),
    "Invalid requestId",
  );
  insist(
    ["synthetic-sdd", "sdd-pipeline"].includes(r.loop?.id) &&
      r.loop?.version === "1.0.0",
    "Unsupported or unpinned loop",
  );
  insist(
    typeof r.intent === "string" && r.intent.trim() && r.intent.length <= 32000,
    "intent is required, max 32000 characters",
  );
  insist(
    typeof r.workspace === "string" && isAbsolute(r.workspace),
    "workspace must be absolute",
  );
  insist(
    Array.isArray(r.allowedPaths) &&
      r.allowedPaths.length > 0 &&
      r.allowedPaths.length <= 100,
    "allowedPaths required",
  );
  for (const p of r.allowedPaths)
    insist(
      typeof p === "string" &&
        p.length < 512 &&
        !isAbsolute(p) &&
        !p
          .split(/[\\/]/)
          .some((s) => !s || s === "." || s === ".." || s.startsWith(".")) &&
        !/\\/.test(p),
      "Only explicit relative non-hidden files are allowed",
    );
  insist(
    new Set(r.allowedPaths).size === r.allowedPaths.length,
    "Duplicate allowedPaths",
  );
  insist(
    Array.isArray(r.allowedTools) &&
      r.allowedTools.every((p) => typeof p === "string" && isAbsolute(p)),
    "allowedTools must be absolute executable paths",
  );
  insist(
    r.verifier !== undefined && r.verifier !== null,
    "Configure an independent verifier before execution",
    "MISSING_CHECKER",
  );
  insist(
    r.verifier &&
      r.allowedTools.includes(r.verifier.command) &&
      Array.isArray(r.verifier.args) &&
      r.verifier.args.every((x) => typeof x === "string"),
    "Explicit authorized verifier required",
  );
  insist(
    JSON.stringify(r.verifier).length < 32000,
    "Verifier arguments too large",
  );
  for (const p of r.allowedPaths)
    insist(
      !/(^|\/)(?:test|tests|__tests__)(\/|$)|(?:\.test|\.spec)\.[^/]+$/.test(
        p,
      ) &&
        !r.verifier.args.some(
          (a) =>
            !a.startsWith("-") &&
            resolve(r.workspace, a) === resolve(r.workspace, p),
        ),
      "Tests and verifier files cannot be writable",
      "SCOPE_DENIED",
    );
  if (r.maxCostUsd !== undefined) {
    insist(
      Number.isFinite(r.maxCostUsd) &&
        r.maxCostUsd > 0 &&
        Number.isFinite(r.maxCallCostUsd) &&
        r.maxCallCostUsd > 0 &&
        r.maxCallCostUsd <= r.maxCostUsd,
      "A money cap needs an explicit conservative maxCallCostUsd",
    );
  }
  insist(
    r.provider && ["claude", "codex", "openrouter", "caller"].includes(r.provider.kind),
    "Explicit provider required",
  );
  insist(
    typeof r.provider.model === "string" &&
      r.provider.model.length > 0 &&
      r.provider.model.length < 200,
    "Explicit model required",
  );
  insist(
    r.provider.payerScope === "local-byok" ||
      r.provider.payerScope === "local-cli",
    "Agent requests require local payer scope",
  );
  if (["claude", "codex"].includes(r.provider.kind))
    insist(
      isAbsolute(r.provider.executable ?? "") &&
        r.provider.payerScope === "local-cli",
      "CLI provider requires absolute executable and local-cli scope",
    );
  else if (r.provider.kind === "openrouter")
    insist(
      /^[A-Z_][A-Z0-9_]*$/.test(r.provider.keyRef ?? "") &&
        r.provider.payerScope === "local-byok",
      "OpenRouter requires keyRef and local-byok scope",
    );
  insist(
    Number.isInteger(r.deadlineMs) &&
      r.deadlineMs > 0 &&
      r.deadlineMs <= 300000,
    "deadlineMs must be 1..300000",
  );
  insist(
    Number.isInteger(r.maxRepairAttempts) &&
      r.maxRepairAttempts >= 0 &&
      r.maxRepairAttempts <= 5,
    "maxRepairAttempts must be 0..5",
  );
  if (r.resumeRunId !== undefined)
    insist(/^[a-f0-9-]{36}$/.test(r.resumeRunId), "Invalid resumeRunId");
  if (r.approval !== undefined)
    insist(
      /^[a-f0-9]{64}$/.test(r.approval?.hash) &&
        ["approve", "reject"].includes(r.approval?.decision),
      "Invalid approval",
    );
  validateSpecInputs(r);
  validateCallerInput(r);
  return r;
}
export function resultEnvelope(request, fields = {}) {
  return {
    protocolVersion: PROTOCOL,
    requestId: request?.requestId ?? null,
    runId: null,
    status: "failed",
    summary: "",
    artifacts: [],
    evidence: [],
    error: null,
    nextAction: null,
    provider: null,
    usage: null,
    ...fields,
  };
}
