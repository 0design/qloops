# qloops

Local, dependency-free loop runtime for Node.js >=20.3. The local delivery
candidate is `0.2.0-core.13`; it is not an npm release or production acceptance.

## Install a reviewed local package

```sh
npm install /absolute/path/qloops-0.2.0-core.13.tgz
npx qloops validate ./loop.yaml
npx qloops run ./loop.yaml
```

Both `qloops` and legacy `qloop` are installed. No `qf` alias. The package includes
runtime, schema, providers and synthetic contract fixtures. Canonical loops live
in an independent registry, not a neighboring private source checkout.

```sh
npx qloops install /absolute/registry-export CATALOG_SHA256 loop-id 1.0.0 ./loop.yaml
```

The catalog must pin this engine version. Installer verifies catalog bytes,
manifest identity, checksums and exact dependencies, and writes `loop.yaml.lock.json`.
It never overwrites files. HTTPS registries are supported; HTTP is localhost-only.
No implicit mutable remote catalog is used. Legacy remote discovery requires both
`QLOOP_CATALOG_URL` and `QLOOP_CATALOG_SHA256`. `QFACTORY_REGISTRY` is an explicitly
trusted local development overlay, not a verified release install.

## Agent -> Core -> CLI -> result

```sh
npx qloops agent request.json
# or pipe bounded JSON on stdin
npx qloops agent - < request.json
```

See `contracts/v1/fixtures.json` for a complete request and
`contracts/v1/request.schema.json` for the structural schema. `validateRequest`
adds path and authorization checks. Substitute real absolute workspace, Node and
CLI paths. `sdd-pipeline@1.0.0` runs the built-in SDD capability;
`synthetic-sdd@1.0.0` is its test alias. Canonical registry acceptance still
requires the site to wire and pin its own manifest.

The first call returns `needs_human` with a spec and approval hash. Review the
specification, verifier, exact file scope and context. Resume the same request
with `resumeRunId` and `approval: {"hash":"RETURNED_HASH","decision":"approve"}`.
Use `reject` to cancel. Changed scope/intent/provider/verifier invalidates approval.
Approval is an assertion by the local trusted caller; Core is not an identity
service. There is no implicit approval or “resume last chat”.

Claude 2.1.156 is the initially reviewed CLI. Existing authentication is used;
no credential copying, nesting guard removal or permissions bypass. Claude inference
has no tools, hooks are disabled, MCP is explicitly empty, and no session is
persisted. It proposes text. Core applies only exact approved files, then runs a
caller-authorized executable/argument array as verifier. Tests/verifier files are
not writable. This is not an OS sandbox: use trusted workspaces and verifiers.

One JSON result is emitted on stdout. `success=0`, `failed=1`, `needs_human=2`,
`cancelled=130`, invalid request `64`. State lives in `.qf/agent-<UUID>.json`.
An exclusive workspace lock blocks overlapping runs. Interrupted writes require
reconciliation. Completed resume checks artifact hashes before returning cached
success. A failed verifier triggers only the configured bounded repairs.

Provider identity and usage are recorded; unknown values are null. Orchestration
is deterministic, model output is not. Deadline/output/token/repair bounds are
explicit. Optional `maxCostUsd` requires a caller-supplied conservative
`maxCallCostUsd`: it gates subsequent calls and stops on unknown/exceeded usage.
It is not a billing guarantee; provider estimates can differ from invoices.
Site-funded reservation/settlement remains the site's responsibility.

## Use your existing Codex login

Codex CLI **0.153.4** is supported via a new standalone `codex exec` session.
Set this provider in an agent or content request (choose your real absolute CLI path):

```json
{
  "kind": "codex",
  "executable": "/Applications/ChatGPT.app/Contents/Resources/codex",
  "model": "gpt-5.6-luna",
  "payerScope": "local-cli"
}
```

The path above was verified on this Mac. A standalone installation of the exact
reviewed CLI works too; qloops does not install or replace it. Run that executable's
`login status` first. ChatGPT authentication is required; saved API-key auth is
rejected, API-key environment variables are not forwarded, and API/provider/model
fallback is disabled. A legacy CLI is rejected with `UNSUPPORTED_CLI`.

Codex uses an isolated temporary working directory, read-only sandbox, no approval
escalation, ignored user config, disabled hooks/plugins/apps/shell/browser tools,
and bounded stdin/JSONL/output/deadline. Only text results are accepted. The CLI
may still advertise built-in utility/apply-patch tools; attempted tool events fail
closed and the read-only sandbox prevents file changes. Core applies approved
file contents and runs the independent verifier. Existing policy/nesting guards
remain active; the parent's conversation is not inherited or resumed.

This uses your Codex/ChatGPT allowance, **not unlimited or zero-cost inference**.
Cost is `null`, with `costKind: subscription-usage`; token usage is recorded when
available. The CLI does not report resolved model identity, so `requestedModel`
is explicit while `model` remains `null`. Dollar-capped runs stop after unknown
cost; use deadlines and repair limits for subscription workflows.

The value beyond scheduling is the reusable workflow: versioned scope, explicit
approval, independent verification, bounded repair and resumable evidence.
A scheduler can launch qloops; for a simple recurring prompt, a built-in scheduled
task may already be enough. See [Codex integration details](docs/codex.md).

## Reusable providers

```js
import { openRouter } from 'qloops';
const result = await openRouter({
  messages: [{ role: 'user', content: 'Summarize this synthetic input.' }],
  model: 'YOUR_EXPLICIT_MODEL', keyRef: 'OPENROUTER_API_KEY',
  payerScope: 'local-byok', maxTokens: 256, timeoutMs: 30000, retries: 2,
});
```

Set the named key in the environment; never put values in manifests. Results
include content, actual model, request ID and nullable usage/cost. Errors are
typed, provider/model fallback is never implicit. `site-funded` labels payer scope
but does not implement the site's $10 quota. The site must reserve before calling.
`chatOnce` remains a compatible wrapper over this adapter; `llm-call` is supported.
Legacy token/cost estimates are not equivalent to provider-billed usage.

HTTP transport retries network/timeout/429/5xx failures with bounded backoff;
ordinary 4xx fail fast. Caller cancellation stops request/backoff without retry.
Response body parsing errors are not retried. Internal policy allows 0–10 retries,
positive timeouts and nonnegative delays; invalid policy fails before requests.
Outgoing legacy API retries can duplicate writes: use receipt-aware content APIs
for publication. Retry is never exactly-once delivery.

## Content and quality capabilities

For Content, start with the shipped [exact request/approval/receiver contract](contracts/v1/content.md)
and [synthetic request example](examples/content-request.json). They describe local
configuration, exact-text approval, repeat/dedup and uncertain-delivery recovery
without requiring a source checkout. The SDD request schema is not a Content schema.

Parent-agent limitation: the tested Codex workspace-write shell currently denies
its nested CLI's local app-server initialization. `CLI_ENVIRONMENT_DENIED` asks for
a supported caller arrangement, without bypassing the sandbox. Standalone Core
proofs do not imply this parent environment works; see [Codex execution boundaries](docs/codex.md#execution-boundary).

`qloops content request.json` uses `qf.content-request/v1`: explicit sources,
allowedOrigins, profile, provider, receipt-aware webhook receiver and deadline.
`runContent` exports the same orchestration with caller-injected capabilities.
Source identity dedup, source-attribution checks, exact draft/receiver approval,
durable receipt and ambiguous-send reconciliation are implemented. Receiver JSON
must be `{ "id": "unique-receipt", "delivered": true }`. A file sink is not a
Telegram receipt. Only synthetic/local receivers were exercised here.

`determined` exports A2D-style plan-bound execute/verify/repair. `qualityCheck`
exports aindf-check (ds-readiness/UI composition) and unslop with hard/soft split,
versioned findings, explicit coverage and optional recipe transport. `loadAindf`
and `loadUnslop` load checksum-pinned upstream installations; no canon is copied.
Missing DS, stale evidence, unknown rules and missing browser evidence cannot pass.
See delivery documentation for upstream/version and acceptance limitations.

## Legacy YAML commands

`qloop validate`, `run [--dry-run]`, `status`, `approve [--reject]`, `catalog`,
`init` and `doctor` remain available for `qloops.loop/v1`. Step kinds and fields are in
[SPEC-MANIFEST.md](./SPEC-MANIFEST.md). Legacy JSON is not the new agent envelope.
`run` performs one pass; scheduling belongs to the caller/launchd. State is local
in `.qf/`; no server/database is required. Legacy YAML agent-call and check mode
remain reserved; the new APIs must not be presented as implemented YAML kinds.

## Verify

```sh
npm test
npm run test:package
```

Tests cover real localhost HTTP, subprocess fixtures, installed callers, negative
paths, approval and resume. Fixtures are not live inference evidence. The
2026-09-07 real Claude attempt failed with expired OAuth; reauthenticate using the
CLI's own login flow before rerunning live acceptance. No live OpenRouter call was
made without a configured key. Local release evidence is in `docs/delivery/`.

MIT. No remote push, npm publish or production deployment is implied.

### determined consumer

The installed package exports the A2D-based execute/verify/repair reducer. See
[its callback contract and migration notes](contracts/v1/determined.md). Run the
synthetic file-and-test example with `node examples/determined-caller.mjs` from
the source checkout, or copy that shipped example into your installed caller.
It demonstrates real failing/passing subprocess checks with a scripted executor.

Explicit current-agent inference for SDD and Content: [caller protocol](contracts/v1/caller-inference.md). No automatic provider fallback; Core retains approval, execution and independent verification.
