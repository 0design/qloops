import { hash, insist } from "./contracts.mjs";

const validArtifact = (artifact) =>
  artifact && /^[a-f0-9]{64}$/.test(artifact.sha256) &&
  Number.isSafeInteger(artifact.revision) && artifact.revision >= 0;

/** A2D plan-time verifier mechanics: AND completion on one immutable artifact.
 * Host callbacks own authorized execution/persistence; this reducer never
 * evaluates code. Original provenance: docs/delivery/upstreams.md. */
export async function determined(
  { criteria, maxRepairAttempts = 0, signal },
  { execute, verify, getArtifact } = {},
) {
  insist(
    Array.isArray(criteria) && criteria.length > 0 && criteria.length <= 100 &&
    criteria.every((c) => c && typeof c.id === "string" && c.id.trim() &&
      c.verifier && typeof c.verifier.type === "string" && c.verifier.type.trim()),
    "Every criterion needs a plan-time verifier",
  );
  insist(new Set(criteria.map((c) => c.id)).size === criteria.length,
    "Duplicate criterion IDs");
  insist(Number.isInteger(maxRepairAttempts) && maxRepairAttempts >= 0 &&
    maxRepairAttempts <= 5, "Invalid repair limit");
  const plan = structuredClone(criteria), planHash = hash(plan), history = [];
  const stop = (reason) => ({status: signal?.aborted ? "cancelled" : "needs_human",
    planHash, history, ...(signal?.aborted ? {} : {reason})});
  if (signal?.aborted) return stop();
  if (typeof execute !== "function" || typeof getArtifact !== "function" ||
      (plan.some(c => c.verifier.type !== "human") && typeof verify !== "function"))
    return stop("Executor, artifact reader or verifier unavailable");

  let stage;
  try {
    for (let attempt = 0; attempt <= maxRepairAttempts; attempt++) {
      if (signal?.aborted) return stop();
      stage = "Execution failed; reconcile side effects before retry";
      await execute({attempt, criteria: structuredClone(plan),
        previous: structuredClone(history.at(-1) ?? null), signal});
      if (signal?.aborted) return stop();
      stage = "Artifact unavailable or invalid";
      // Readers may reuse/mutate their object: retain a detached snapshot.
      const artifact = structuredClone(await getArtifact({signal}));
      if (signal?.aborted) return stop();
      if (!validArtifact(artifact)) return stop(stage);
      const previous = history.at(-1)?.artifact;
      if (previous && (artifact.revision < previous.revision ||
          (artifact.sha256 !== previous.sha256 && artifact.revision <= previous.revision)))
        return stop("Artifact revision did not advance with changed content");
      const artifactIdentity = hash(artifact), outcomes = [];
      for (const criterion of plan) {
        if (signal?.aborted) return stop();
        stage = "Verifier unavailable; evidence remains unknown";
        const evidence = criterion.verifier.type === "human" ? {outcome: "unknown"} :
          await verify({criterion: structuredClone(criterion),
            artifact: structuredClone(artifact), signal});
        if (signal?.aborted) return stop();
        stage = "Artifact unavailable or invalid";
        const current = await getArtifact({signal});
        if (signal?.aborted) return stop();
        const fresh = evidence?.artifactHash === artifact.sha256 &&
          evidence?.revision === artifact.revision && validArtifact(current) &&
          hash(current) === artifactIdentity;
        outcomes.push({criterionId: criterion.id,
          outcome: fresh && ["pass", "fail"].includes(evidence?.outcome) ? evidence.outcome : "unknown",
          artifactHash: artifact.sha256, revision: artifact.revision,
          verifier: structuredClone(criterion.verifier)});
      }
      history.push({attempt, artifact, outcomes});
      // Check again after every criterion has run; never mix earlier and later revisions.
      stage = "Artifact unavailable or invalid";
      const finalArtifact = await getArtifact({signal});
      if (signal?.aborted) return stop();
      if (!validArtifact(finalArtifact) || hash(finalArtifact) !== artifactIdentity) {
        for (const outcome of outcomes) outcome.outcome = "unknown";
        return stop("Artifact changed during verification");
      }
      if (outcomes.every(e => e.outcome === "pass"))
        return {status: "success", planHash, history};
      if (outcomes.some(e => e.outcome === "unknown"))
        return stop("Missing, stale or human verification");
    }
  } catch {
    // Do not expose arbitrary executor/verifier errors (which may contain secrets)
    // or automatically repeat a partially completed action.
    return stop(stage);
  }
  return stop("Repair limit reached");
}
