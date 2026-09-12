# Core contract revision 8 (qf.agent/v1)

Content has a separate [HTTP request, approval, repeat and receipt contract](content.md)
and a shipped [synthetic request](../../examples/content-request.json). Core.9 ships
these discoverability additions without changing revision5 runtime semantics.

Core.13 uses `qloops.loop/v1` for YAML manifests. Older manifest namespaces are rejected. Migrate a copy of the manifest and revalidate it with the new package; do not resume old runs or rewrite historical evidence. The agent and content request protocols are unchanged. Consumers pin the package tarball SHA256 and this directory.
No sibling source imports. Contract fixtures are synthetic, not live acceptance.

`qloops agent request.json` (or `-` for bounded stdin) emits exactly one JSON
result on stdout. Logs belong on stderr. Status/exit: success/0, failed/1,
needs_human/2, cancelled/130; malformed request failed/64. No implicit provider.

Request: protocolVersion, requestId, loop {id,version}, intent, workspace (absolute),
allowedPaths (exact relative files), allowedTools (verifier executable paths),
provider {kind: claude|codex|openrouter, model, executable? or keyRef?, payerScope},
deadlineMs (1..300000), maxRepairAttempts (0..5), verifier {command,args},
optional approval {hash,decision:approve|reject}, resumeRunId.
Supported loops: sdd-pipeline@1.0.0 and synthetic-sdd@1.0.0 (test alias). Canonical SDD manifests are site-owned;
this executable synthetic entry point is the integration reference.

ModelProvider: generate(messages, limits, signal) -> content, provider identity,
requestId, usage {tokensIn,tokensOut,costUsd}, error. Missing metrics are null.
Claude inference has NO tools. It proposes structured spec/plan/file contents;
WorkspaceExecutor alone applies approved exact files. No shell interpolation.
Verifier is an explicitly caller-authorized executable+argv independent of model.
Policy binds spec, criteria, scope, provider and verifier to SHA256 approval.
The model cannot change verifier or policy. Local permissions are not an OS sandbox.
Only run trusted verifiers in trusted workspaces. No arbitrary shell command adapter.

State: unique UUID, atomic snapshots, exclusive workspace lock, explicit resume.
An interrupted applying phase requires reconciliation; never replay blindly.
Completed runs return cached evidence only if artifacts still match. Approval is
an authorization assertion from the caller (local same-user trust boundary), not
an authentication service. Caller protects request/state files. No “approve latest”.
Result: protocolVersion, requestId, runId, status, summary, artifacts (revision/hash),
evidence (verifier outcomes), error {code,message}|null, nextAction|null,
provider, usage. Unknown verification never means success. Repair cannot edit tests.

Resource note: optional maxCostUsd requires caller-estimated maxCallCostUsd. Unknown or exceeded reported cost stops subsequent calls. This is a reservation check, not a provider billing guarantee.

Revision 2 adds `codex` with absolute executable, explicit model and `local-cli`.
Codex 0.153.4 requires ChatGPT authentication and never falls back to API billing.
It runs read-only in an isolated cwd, accepts text only, and rejects tool events.
Provider metadata uses `authMethod: chatgpt`, `permissionMode: read-only`,
`acceptedTools: []`, `model: null` (CLI does not emit resolved identity).
Direct usage includes `costKind: subscription-usage`, nullable cost, cached input
and input/output tokens. Agent aggregate usage retains the existing shape.
Existing revision 1 requests remain valid; consumers must accept the new provider
and repin package 0.2.0-core.2 to use it. Other protocols and exit codes unchanged.

Revision 3 adds specification import, durable clarification and explicit revisions:
see [specification](specification.md). Missing checker now requests human
configuration; invalid checker remains failed/64. Unavailable Codex model requests
explicit provider configuration. Existing approved scope cannot be silently changed.
Candidate core.4 also documents the [determined callback contract](determined.md),
including operational failure and cancellation behavior. Repin and run consumer
tests before adopting these changes; Site currently uses revision 2/core.2.

Revision 4 strengthens [quality evidence](quality.md): upstream checksum and DS
subject binding, immutable coverage, native rule applicability and severity, and
cooperative cancellation. Callback reports/recipes need the new checksum fields;
old incomplete evidence yields needs_human. Adopt core.5 with explicit consumer
repin and native adapter tests. Agent/loop protocol names are unchanged.

Core.6 tightens [registry validation](registry.md): ambiguous/malformed dependencies,
section/file identity and per-entry engine drift are refused. Exact release pins
are preserved; stricter rejection is documented without changing agent protocol.

Revision 5 / core.8 adds actionable local recovery to SDD and Content results:
AUTH_REQUIRED → configure_access; MISSING_EXECUTABLE/UNSUPPORTED_CLI →
configure_provider; UNSUPPORTED_NESTING → configure_caller;
PERMISSION_DENIED/SCOPE_DENIED → review_permissions. All these errors return
needs_human/exit2. Content previously returned failed for these recoverable errors;
missing SDD executable previously returned failed. Consumers must handle these
actions, display their message in the same conversation, and explicitly repin.
After local authentication is restored, retry the same SDD request with its runId;
Content retries the same request. Neither grants approval or sends automatically.
Changing provider/scope requires a new request or the documented approved revision.
configure_caller is an instruction, not an implemented broker. Claude nesting
guards remain enforced; four-entry golden-path support is not inferred from this.

Revision6 / core.10 recognizes the observed Codex app-server client startup
permission denial as CLI_ENVIRONMENT_DENIED → needs_human/configure_caller rather
than a generic invalid JSONL failure. Raw stderr is not exposed and no permission
change/retry is made. Content errors retain an existing runId for correlation;
resume still uses the same request/workspace, not an SDD resumeRunId field.
This makes the environment blocker actionable; it does not solve or bypass it.

Explicit current-agent inference for SDD and Content: [caller protocol](caller-inference.md). No automatic provider fallback; Core retains approval, execution and independent verification.
