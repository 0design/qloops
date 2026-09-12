# Codex subscription provider

Core candidate `0.2.0-core.2` adds Codex to both `qloops agent` (SDD) and
`qloops content`. It uses a **new local Codex CLI session** with the existing
ChatGPT login. It does not re-enter the parent agent's conversation.

## Run it

1. Use an absolute path to Codex CLI **0.153.4**. Verify `--version` and
   `login status` using that exact executable. ChatGPT login is required.
   On the tested Mac this is `/Applications/ChatGPT.app/Contents/Resources/codex`.
   `/usr/local/bin/codex` is a legacy 2025 CLI and is intentionally rejected.
2. Copy `contracts/v1/codex-request.json`. Set your absolute workspace,
   executable, explicit model, allowed files and trusted verifier command.
3. Run `qloops agent request.json`. Review the returned specification and scope.
4. Add the returned `resumeRunId` and
   `approval: {"hash":"RETURNED_HASH","decision":"approve"}` to the same request.
   Run it again. Core applies only the scoped file contents and runs the verifier.
5. Repeat the approved request to resume. A completed run returns cached success
   only if artifact hashes still match. Changed scope/verifier requires new approval.

The direct text adapter is also exported:

```js
import { codex } from 'qloops';
const result = await codex({
  executable: '/absolute/path/to/codex',
  model: 'gpt-5.6-luna',
  messages: [{ role: 'user', content: 'Summarize this supplied text: ...' }],
  timeoutMs: 60000,
});
console.log(result.content);
```

For Content-factory use the same provider descriptor in a
`qf.content-request/v1` request. Draft approval and receiver receipts remain
required; selecting Codex does not authorize publication.

Candidate `0.2.0-core.3` adds imported specifications, clarification questions,
and explicit specification revisions. See [the workflow contract](../contracts/v1/specification.md).
The model in the example is an explicit selection, not an automatic fallback.
The previously tested `gpt-5.4-mini` was rejected by this ChatGPT account on
2026-09-10. An unavailable model returns `MODEL_UNAVAILABLE`; the agent requests
`configure_provider`. Choose a supported model explicitly for a new run.

## Execution boundary

Fresh parent-agent testing on 2026-09-10 found that a Codex workspace-write shell
can deny the nested CLI's in-process app-server initialization before inference.
Version and ChatGPT login can pass while execution still fails. core.10 returns
CLI_ENVIRONMENT_DENIED / needs_human / configure_caller for the observed startup
denial and preserves run correlation. This environment is not accepted for the
complete parent→qloops→Codex path. Do not remove sandbox/nesting guards, copy
credentials, silently switch payer/provider or claim the earlier standalone
proof establishes this nested environment. A supported caller arrangement remains
an integration dependency; no broker is provisioned by the error action.

The adapter checks the exact CLI version and ChatGPT authentication before
inference. It supplies bounded messages through stdin and parses bounded JSONL;
there is no shell interpolation or automatic API/model/provider fallback.
`CODEX_HOME` is preserved when set; credentials are never read or copied by
qloops. API keys and the caller's session identifiers are not passed through.

Each call uses an ephemeral session in a disposable working directory outside
the target workspace. User config and project instructions are not loaded;
hooks, plugins, apps, shell, browser and delegation features are disabled.
Approval escalation is disabled and the Codex sandbox is read-only. Existing
execpolicy rules and managed constraints are not deliberately bypassed.

Codex still exposes some model-dependent utility/apply-patch tools. This is not
a claim that its tool catalog is empty: file modifications are denied by the
read-only sandbox and any tool event makes the provider result fail. Only
returned text can reach Core's approved file executor. Run this local integration
only with a trusted CLI installation and workspace/verifier.

Missing executable, unsupported version, expired/API auth, permission/tool events,
unavailable models, malformed/incomplete output, quota failure, timeout and cancellation are typed
failures. Cancellation terminates the process group. `QLOOPS_DEPTH` and existing
Claude nesting guards are retained. No retries of failed inference are hidden
inside qloops; the pinned CLI can perform bounded internal transport retries.

## Usage and positioning

ChatGPT authentication uses subscription access; API-key authentication uses
separate API billing. This adapter requires the former. Existing allowance and
limits still apply; qloops does not promise free or unlimited inference.
[Official authentication documentation](https://learn.chatgpt.com/docs/auth).

Token usage comes from Codex's completion event. Dollar cost and actual resolved
model identity are unknown (`null`), not zero or guessed from the requested model.
`requestedModel` records the selection. Dollar-capped orchestration blocks later
calls after unknown cost; subscription users can use deadlines/repair bounds.

A built-in scheduled task is sufficient for many recurring prompts. QFactory's
additional value is a reusable workflow with versioned scope, explicit approval,
independent tests, bounded repair and resumable evidence. Scheduling can trigger
that workflow; a second paid inference account is not a prerequisite.

## Reproduce the checks from the source repository

```sh
npm test
npm run test:package
node scripts/test-package.mjs --live-codex --model gpt-5.6-luna
node scripts/live-sdd.mjs --provider codex --model gpt-5.6-luna --approve-synthetic
node scripts/live-specification.mjs gpt-5.6-luna
```

Live checks consume existing Codex allowance and use synthetic workspaces only.
The package is a local candidate; site integration requires a new artifact pin.
[Official headless/JSONL reference](https://learn.chatgpt.com/docs/non-interactive-mode).
