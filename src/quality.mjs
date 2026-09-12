import { insist } from "./contracts.mjs";
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const evidenceObject = value => value && typeof value === "object" &&
  !Array.isArray(value) && Object.keys(value).length > 0;

/** A pinned, complete report is required; adapters cannot alter requested coverage.
 * Host callbacks own their deadlines and must honor the supplied AbortSignal. */
export async function qualityCheck(request, { evaluate, recipe } = {}) {
  const {signal} = request;
  const {kind,mode} = request;
  insist(["aindf-check", "unslop"].includes(kind), "Unknown quality adapter");
  insist(kind === "unslop" || ["ds-readiness", "ui-compliance"].includes(mode), "Unknown DS mode");
  insist(request.upstream && typeof request.upstream.version === "string" &&
    request.upstream.version.trim() && digest(request.upstream.sha256), "Pinned upstream required");
  insist(request.artifact && digest(request.artifact.sha256) &&
    Number.isSafeInteger(request.artifact.revision) && request.artifact.revision >= 0,
    "Versioned artifact required");
  insist(Array.isArray(request.requiredRules) && request.requiredRules.length > 0 &&
    request.requiredRules.length <= 100 && request.requiredRules.every(r => typeof r === "string" && r.trim()) &&
    new Set(request.requiredRules).size === request.requiredRules.length,
    "Explicit unique rule coverage required");
  const input = structuredClone({kind,mode,upstream:request.upstream,artifact:request.artifact,
    designSystem:request.designSystem,requiredRules:request.requiredRules,browserEvidence:request.browserEvidence});
  const {upstream,artifact,designSystem,requiredRules,browserEvidence} = input;
  const base = {protocolVersion:"qf.quality/v1",kind,mode,upstream,artifact,
    hard:[],soft:[],coverage:requiredRules.map(rule=>({rule,outcome:"unknown"})),recipes:[]};
  const stop = reason => ({...base,status:signal?.aborted ? "cancelled" : "needs_human",
    ...(signal?.aborted ? {} : {reason})});
  if (signal?.aborted) return stop();
  if (kind === "aindf-check" && !designSystem) return stop("Missing design system");
  if (kind === "aindf-check" && !digest(designSystem.sha256)) return stop("Unpinned design system");
  if (typeof evaluate !== "function") return stop("Upstream adapter unavailable");
  let report;
  try {report=structuredClone(await evaluate({...structuredClone(input),signal}));}
  catch {return stop("Upstream evaluation unavailable");}
  if (signal?.aborted) return stop();
  if (report?.upstreamVersion !== upstream.version || report?.upstreamSha256 !== upstream.sha256 ||
    report?.artifactHash !== artifact.sha256 || report?.revision !== artifact.revision ||
    (kind === "aindf-check" && report?.designSystemHash !== designSystem.sha256))
    return stop("Stale artifact, design system or upstream pin mismatch");
  if (!Array.isArray(report.findings) || report.findings.length > 1000 ||
      report.findings.some(f => !f || typeof f !== "object" || Array.isArray(f)))
    return stop("Malformed upstream findings");
  for (const coverage of base.coverage) {
    if (signal?.aborted) return stop();
    const {rule}=coverage;
    const matches=report.findings.filter(f=>f.rule===rule),finding=matches.length===1 ? matches[0] : null;
    const valid = finding && ["hard","soft"].includes(finding.type) &&
      ["pass","fail"].includes(finding.outcome) && evidenceObject(finding.evidence);
    coverage.outcome=valid ? finding.outcome : "unknown";
    if (finding) (finding.type === "soft" ? base.soft : base.hard).push({...finding,outcome:coverage.outcome});
    if (valid && finding.outcome === "fail" && typeof recipe === "function") {
      try {
        const r=structuredClone(await recipe({rule,version:upstream.version,sha256:upstream.sha256,signal}));
        if (signal?.aborted) return stop();
        base.recipes.push(r?.rule===rule && r?.version===upstream.version && r?.sha256===upstream.sha256 ? r : {rule,status:"unknown"});
      } catch {
        if (signal?.aborted) return stop();
        base.recipes.push({rule,status:"unavailable"});
      }
    }
  }
  const browserRequired=kind === "unslop" || mode === "ui-compliance";
  const browserValid=browserEvidence?.artifactHash===artifact.sha256 &&
    browserEvidence?.revision===artifact.revision && digest(browserEvidence?.sha256);
  const unknown=base.coverage.some(f=>f.outcome==="unknown") || (browserRequired && !browserValid);
  return {...base,status:unknown ? "needs_human" : base.hard.some(f=>f.outcome==="fail") ? "failed" :
    base.soft.some(f=>f.outcome==="fail") ? "needs_human" : "success",browserEvidence:browserValid ? browserEvidence : null};
}
