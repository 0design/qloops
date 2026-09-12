import { hash, insist } from "./contracts.mjs";
const text = (s, max = 8000) =>
  typeof s === "string" && !!s.trim() && s.length <= max;
export function specification(value, code = "INVALID_REQUEST") {
  insist(
    value && typeof value === "object" && !Array.isArray(value),
    "Specification must be an object",
    code,
  );
  insist(
    text(value.summary) &&
      ["criteria", "plan"].every(
        (k) =>
          Array.isArray(value[k]) &&
          value[k].length > 0 &&
          value[k].length <= 50 &&
          value[k].every((s) => text(s, 2000)),
      ),
    "Specification requires bounded summary, criteria and plan",
    code,
  );
  return {
    summary: value.summary,
    criteria: [...value.criteria],
    plan: [...value.plan],
  };
}
export function validateSpecInputs(r) {
  insist(
    !(r.specChange && r.clarification),
    "Submit a spec change or clarification, not both",
  );
  if (r.specification !== undefined) specification(r.specification);
  if (r.specChange !== undefined) {
    const c = r.specChange;
    insist(
      r.resumeRunId &&
        c &&
        /^[a-f0-9]{64}$/.test(c.expectedHash) &&
        Number.isInteger(c.expectedRevision) &&
        c.expectedRevision > 0 &&
        text(c.reason, 4000),
      "Spec change requires resume, previous hash/revision and reason",
    );
    if (c.specification !== undefined) specification(c.specification);
  }
  if (r.clarification !== undefined) {
    const c = r.clarification;
    insist(
      r.resumeRunId &&
        c &&
        /^[a-f0-9]{64}$/.test(c.hash) &&
        Array.isArray(c.answers) &&
        c.answers.length > 0 &&
        c.answers.length <= 10 &&
        c.answers.every((a) => a && text(a.id, 80) && text(a.answer, 4000)),
      "Clarification requires question hash and bounded answers",
    );
  }
}
export function questions(value) {
  insist(
    Array.isArray(value) &&
      value.length > 0 &&
      value.length <= 10 &&
      value.every(
        (q) =>
          q && /^[a-zA-Z0-9_-]{1,80}$/.test(q.id) && text(q.question, 2000),
      ) &&
      new Set(value.map((q) => q.id)).size === value.length,
    "Model returned invalid clarification questions",
    "INVALID_RESPONSE",
  );
  return value.map(({ id, question }) => ({ id, question }));
}
export function recordSpec(state, spec, identity, origin) {
  const previousRevision = state.specRevision ?? (state.spec ? 1 : 0);
  state.spec = specification(spec, "INVALID_RESPONSE");
  state.specRevision = previousRevision + 1;
  state.approvalHash = hash({
    spec: state.spec,
    identity,
    before: state.before,
    specRevision: state.specRevision,
  });
  state.specHistory ??= [];
  state.specHistory.push({
    revision: state.specRevision,
    hash: state.approvalHash,
    spec: state.spec,
    identity,
    origin,
  });
  state.phase = "approval";
}
