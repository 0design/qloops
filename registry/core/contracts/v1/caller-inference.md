# Explicit caller inference — candidate revision 7

Implementation candidate; existing Codex/Claude/OpenRouter descriptors retain their
meaning. No automatic switch to caller mode. A changed provider requires a new run
and new approval. Caller mode never launches a model CLI or external broker.

Select `provider:{kind:"caller",agent:"codex",model:"current-session",payerScope:"local-cli"}`
in an SDD or Content request. `agent` is a declared caller identity (`codex` or
`claude`), not an attestation. Use `current-session` when the actual model is unknown; returned actual model remains null. Claude acceptance remains deferred. Do not supply
executable/keyRef for this mode. The active parent generates the response using
its existing session. Model usage/cost are unknown/null; answer-supplied usage or
verification claims are not accepted. Money-capped requests are unsupported in
this mode: use the explicit job count, deadline and repair bounds instead.

| Field | Contract |
| --- | --- |
| maxInferenceJobs | Optional integer1–100, default12; persisted per SDD run / Content draft |
| inferenceTtlMs | Optional integer1–3600000, default900000; validity window for each job, separate from each tool call's deadlineMs |
| cancelInference | Optional `{jobId,hash}`; submit separately from reply, clarification or revision. Content cancellation does not refetch sources or resolve receiver credentials. |
| inferenceReply | Optional `{jobId,hash,output}` only; remove it after a successful submission |
| nextAction | `{type:"provide_inference",job:{protocolVersion:"qf.inference/v1",jobId,runId,phase,inputHash,specRevision,artifactRevision,expiresAt,maxOutputBytes,outputKind,messages,hash}}` |

Job/hash/context/revision/expiry are Core-owned and persisted. Repeated polling
without a reply returns the same job; it does not spend another job. Submit exactly
that jobId/hash with the generated JSON object in output. Do not manually recompute
the hash. Job output kinds: `specification` accepts `{summary,criteria,plan}` or
`{questions:[{id,question}]}`; `files` accepts `{files:[{path,content}]}`;
`content` accepts `{text}`. No extra top-level output fields, approval, provider,
usage, verifier or success claims. Output JSON is bounded to64000 bytes.

The parent treats job.messages as a bounded inference task. It does not apply the
proposed files itself or replace a verifier. Core alone applies approved files,
runs the separately authorized hash-bound checker, records actual outcomes and
issues another job for bounded repair. A model answer never counts as verification.

SDD: retain full request and resumeRunId from Core. Content: repeat the same full
request/workspace; no resumeRunId field. For both, submit the reply exactly once;
a replay, wrong job/hash, changed context or stale revision is refused before
effects. Omit consumed inferenceReply on subsequent approval/resume/repeat calls.
Content source bytes are fetched again, so changing source content while awaiting
a reply invalidates it. Approval of the exact final text/receiver is still separate.

Expired jobs require review/start of a fresh request; expiry is not approval to
reissue or bill. Cancellation invalidates a pending job; a later explicit resume
can obtain a new job within the same remaining count bound. Exhausted job/repair
limits stay human stops. Unknown usage is never zero, and no paid account is added.

This is a same-user local trust boundary. Protect state/request/verifier files;
caller mode does not attest a model's identity or defend against a malicious host
that can directly rewrite all local files. No parent hidden memory is copied into
Core: only the bounded job and submitted response are persisted.
