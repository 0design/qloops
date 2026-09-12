# determined: execute → verify → repair

`determined` is the reusable execution reducer exported by `qloops`. Import it
from the installed package. It does not create a service, invoke a model, launch
shell commands or grant workspace permissions on its own. A trusted host supplies
`execute`, `verify`, and `getArtifact`. The shipped
`examples/determined-caller.mjs` is a runnable consumer using real files and Node
verifier subprocesses; its executor is explicitly scripted, not model inference.

Input: `criteria` (1–100 unique nonempty IDs, each with a verifier descriptor and
nonempty `type`), `maxRepairAttempts` (0–5), optional `AbortSignal`.
The criteria and verifier descriptors are copied at entry and hashed as `planHash`.
Each execute callback gets detached `criteria`, `attempt` and `previous` evidence.
Changing those values cannot weaken the plan or rewrite recorded history.

- `execute({attempt,criteria,previous,signal})`: apply only caller-authorized
  changes. Attempt zero is initial execution; later attempts repair failed criteria.
- `getArtifact({signal})`: read the actual current artifact and return at least
  `{revision,sha256}`. Revision is a nonnegative safe integer. Changed bytes must
  advance revision. The reducer detaches its snapshot even if the host reuses an
  object. Host must hash the real artifact, not a model's claimed result.
- `verify({criterion,artifact,signal})`: independently return
  `{outcome: 'pass'|'fail'|'unknown',artifactHash,revision}`. Keep trusted verifiers
  outside writable scope and validate their pinned contents in the host. A human
  criterion is always unknown here; it cannot be auto-approved by this reducer.

Every criterion must pass against the same snapshot. Missing/stale evidence,
changes during verification, invalid artifact revisions, unavailable callbacks
or human criteria return `needs_human`. Failed criteria permit at most the
specified repair count; exhausted attempts return `needs_human`. Callback failures
stop immediately with a bounded reason and no automatic replay of uncertain side
effects. Arbitrary callback exception messages are not exposed. Cancellation is
checked before/after awaited callbacks, including the final verifier. A callback
that throws during cancellation still returns `cancelled`.

Host callbacks must honor cancellation and enforce execution deadlines, workspace
locks and resource limits. The reducer cannot terminate an arbitrary JavaScript
promise or roll back external effects. Use the bounded subprocess helper for
trusted executable calls, as shown in the consumer example. Persistence and crash
reconciliation belong to the host; the reducer returns `history` for storage.

Results contain `status`, `planHash`, `history` (attempt, artifact snapshot and
per-criterion outcomes), and a reason when human attention is needed. Invalid
plan input throws `INVALID_REQUEST` before execution. Candidate core.4 strengthens
snapshot/cancellation handling and changes operational callback failures from
unhandled rejection to `needs_human`; consumers should handle that outcome.

## A2D successor and historical compatibility

The archived donor identifies package `a2done`, binary/MCP ID `a2d`, and `.a2d`
state. These identifiers remain historical; qloops does not replace their binary,
MCP tools, hooks or saved state automatically. Do not point old clients at a
nonexistent `qloops a2d` command, rename state files, or delete donor history.

For a new integration, convert plan-time criteria/verifiers to the descriptors
above, supply an authorized executor plus independent evidence callbacks, and
persist the resulting versioned history. Reapprove scope and regenerate evidence;
old completion claims are not transferable approval. Use `determined` for the new
loop identity. `unslop` is a separate curated design-canon loop; historical
`unslop-design` references do not alias the A2D mechanism. Canonical registry
aliases/manifests and updates to public donor instructions belong to their owners.

The source mapping is retained in `docs/delivery/upstreams.md` in the repository.
No donor code, hosted product, canon, credentials or configuration is copied.
