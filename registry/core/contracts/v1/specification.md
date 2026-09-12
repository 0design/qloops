# Specification workflow extension (candidate revision 3)

SDD accepts an optional `specification: {summary, criteria, plan}` input. This
imports the provided specification without model generation. A previous external
approval does not authorize new local paths or a different verifier: Core returns
`approve_spec` with its own policy-bound hash before applying any file.

When the intent is ambiguous the model can return questions. Core persists them
and returns `needs_human` with:

```json
{"type":"clarify_spec","runId":"...","hash":"...","questions":[{"id":"format","question":"Which output format?"}]}
```

Resume the same request with its `resumeRunId` and:

```json
{"clarification":{"hash":"RETURNED_QUESTION_HASH","answers":[{"id":"format","answer":"Plain text"}]}}
```

All current questions require exactly one nonempty answer. A wrong hash, duplicate
or missing answer never triggers inference. Replaying the same answer submission
is idempotent. The next generation receives prior questions and answers. After
five answered rounds the caller must review the requirements rather than continue
unbounded inference. The ordinary deadline/cost guards also apply to each call.

## Explicit revision before execution

`approve_spec` includes `specRevision`. To change the spec or scope within the
same run, send the new request fields and an explicit operation:

```json
{
  "resumeRunId":"EXISTING_RUN_ID",
  "specChange":{
    "expectedHash":"CURRENT_APPROVAL_HASH",
    "expectedRevision":1,
    "reason":"Include the additional documented behavior",
    "specification":{
      "summary":"Updated behavior",
      "criteria":["The new independent check passes"],
      "plan":["Change only the authorized file"]
    }
  }
}
```

The snippet shows only added fields: retain protocol, intent, provider, workspace,
paths/tools, verifier and limits in the full request. Omit `specChange.specification`
to regenerate from the revised intent instead. Core accepts a revision only before
execution, checks the previous hash/revision and unchanged original file snapshot,
then issues a new approval hash. Explicitly changed paths/verifier are revalidated.
An implicit scope change remains rejected. History records each spec revision,
its full request identity, origin and approval hash separately from file revisions.
Repeated identical change submissions do not add revisions. Approval of an older
revision never authorizes the new one. Send fresh approval only after reviewing
its spec and scope. Do not combine clarification and specChange in one request.

After execution starts, changed specifications require a new run. Failed or stale
revision attempts cannot replace a completed run's cached success.

## Policy stops

Missing verifier returns `needs_human / MISSING_CHECKER` with
`nextAction.type=configure_verifier`; no model or workspace action is performed.
A malformed or unauthorized verifier remains `INVALID_REQUEST`. Deadline or cost/
clarification limit returns `needs_human` with `review_limits`. CLI exit for these
human outcomes is 2; malformed requests keep exit 64.

Existing request fields and provider contracts remain supported. New fields must
be understood by a consumer before adoption; previous tarballs do not implement
this extension. The core.3 installed-package live proof is recorded in
`docs/delivery/specification-live.json` in the source repository. Consumer repin
and cross-track acceptance remain separate gates.
