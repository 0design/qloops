# Content request, approval and receipt contract

Available since qloops@0.2.0-core.9; current contract revision 6. This publishes the existing
Content interface without a runtime/schema change. Use the installed package's
[synthetic request](../../examples/content-request.json); no private source checkout
is required. This document is the field contract; the SDD request schema does not
validate Content. There is no separate Content JSON-schema validator in this release.

## Invocation and results

`qloops content /absolute/path/request.json` reads a UTF-8 JSON file, at most
128000 bytes. Content CLI does **not** accept `-`/stdin. From JavaScript:
`import { runContentRequest } from 'qloops'`, then
`await runContentRequest(request, {env: process.env, signal})` (options optional).
This is the concrete HTTP/model/webhook adapter. `runContent` is a different
callback-based API; do not pass it the HTTP request below.

Runtime stdout is one `qf.content/v1` result envelope: requestId, runId (nullable),
status, summary, artifacts, evidence, error, nextAction, provider, usage. Status/
exit codes: success/0, failed/1, needs_human/2, cancelled/130. File/JSON CLI errors
use stderr and exit64, without a result envelope. Null metrics/provider identity
are unknown, not free usage or proof of an inferred provider. Success with
no_new_sources means nothing was sent; delivery success includes a receipt.

## Request fields

| Field | Required value / behavior |
| --- | --- |
| protocolVersion | Exactly `qf.content-request/v1` |
| requestId | String used for caller correlation, not a run selector |
| workspace | Absolute path to an existing trusted writable directory. Retain it across calls |
| allowedOrigins | Array of exact origins, including scheme/port, covering every source and receiver. No URL credentials; HTTP/HTTPS only; redirects refused |
| deadlineMs | Integer 1–300000; total call deadline. Each invocation/retry has its own deadline |
| sources | 1–20 objects `{id,url}`. id is a nonempty string; URL is a permitted HTTP GET endpoint |
| profile | Private JSON object passed to the model and bound into approval. Suggested keys language, tone, instructions; these are prompt context, not separately enforced editorial rules |
| provider | Explicit descriptor below; no automatic provider/model fallback |
| receiver | Explicit descriptor below; only receipt-aware webhook is supported |
| maxItems | Optional integer 1–50, default10. First eligible sources in supplied order are selected; there is no model-ranked selection |
| approval | Omit for drafting. Then `{hash: "returned SHA256", decision: "approve"}` or `"reject"` for the exact returned draft and receiver |

Do not include secrets or raw authorization tokens. Do not invent `resumeRunId`,
`specification`, `verifier`, `allowedPaths`, `loop`, `source.text` or a scheduling
field: those do not configure this HTTP API. Source text is fetched on every call,
including approval/replay. GET has no source-auth/header adapter; provide permitted
readable endpoints. Responses are bounded to64000 bytes and normalized source text
to20000 characters. Sources are untrusted text, not instructions. This is not an
RSS/article extraction or Telegram/LinkedIn API adapter.

Provider descriptors:

- Codex: `{kind:"codex", model:"explicit-model", executable:"/absolute/codex",
  payerScope:"local-cli"}`. Reviewed version/auth/limits from the package's Codex
  contract apply. The example model was verified locally, not guaranteed available
  for every account. Configure it explicitly; never silently choose another payer.
- Claude: same CLI fields with kind `claude`. Adapter exists; Claude acceptance is
  deferred until after Codex stabilization. Active nesting guards remain enforced.
- OpenRouter: `{kind:"openrouter",model:"explicit-provider/model",
  keyRef:"OPENROUTER_API_KEY",payerScope:"local-byok"}`. The key is in the process
  environment (or JS env option), not JSON. Live proof still requires access/budget.

Receiver: `{kind:"webhook",url:"https://permitted.example/receive",
id:"stable-channel-identity",keyRef:"OPTIONAL_RECEIVER_TOKEN"}`. keyRef is optional,
must match `[A-Z_][A-Z0-9_]*`, and is resolved locally. Keep id stable: it defines
the dedup target. If omitted, normalized receiver URL is used as id. Provider and
receiver adapter versions are internally `1`; do not invent your own version pin.

## Draft → approve/reject → repeat

1. Copy the installed example to your private workspace. Replace both absolute
   path placeholders, confirm the explicit model and start a controlled source/
   receiver server implementing the contract below. Port8787 is an example only;
   the package does not automatically start a server. Keep all test data synthetic.
2. Run `qloops content request.json`. A valid draft returns needs_human with
   `nextAction:{type:"approve_publication",hash,text,receiver}`. No send yet.
   Show **that exact text and destination** to the user, including source URLs.
3. After explicit approval, add `approval:{hash:<returned hash>,decision:"approve"}`
   to the same request and invoke it again. For rejection use decision `reject`.
   Do not treat an old approval, general task authorization or a changed draft as
   approval of the new text. The model cannot approve its own real publication.
4. Confirm success **and** receiver receipt in evidence. Repeat the same request
   without approval to check no_new_sources and no duplicate delivery. If more
   eligible sources remain beyond maxItems, the repeat creates another draft that
   needs its own approval, rather than reporting no_new_sources.

Persisted state lives in `<workspace>/.qf/content-state.json` behind a workspace
lock. Resume means invoking the same Content request/workspace, **not** SDD's
resumeRunId and not “last chat”. requestId changes do not reset state. Sources are
deduplicated by `{id,url}` per receiver id after confirmed delivery; changed text
at an already delivered id/url is not a new item. Assign a genuinely new source
identity to a new item, never to bypass uncertain-send protection.

Draft identity includes selected fetched sources, profile, provider and receiver.
Changes before approval can create a new draft; stale approve/reject hashes cannot
approve/cancel it. Rejected unchanged drafts remain cancelled. There is no CLI
edit-draft/reset API; changes require meaningful new inputs and fresh approval.
Do not delete state to force another send. Attribution checks only verify supplied
URLs occur in text; they do not prove factual accuracy or editorial quality.

## Receiver contract

On approval Core sends exactly one HTTP POST to receiver.url, with:

```http
Content-Type: application/json
Idempotency-Key: <stable key for this run and approval>
Authorization: Bearer <locally resolved token, only if keyRef configured>
```

Body: `{"text":"the exact approved text"}`. A successful receiver returns HTTP2xx
and bounded JSON `{"id":"nonempty-receipt-id","delivered":true}`. The receipt must
represent confirmed delivery, not just queue admission. The receiver should persist
idempotency keys and offer a real lookup capability for reconciliation. No lookup
URL shape is assumed by Core. Tests below use only a localhost receiver.

Timeout/network/HTTP/receipt failure after send begins is uncertain, not permission
to resend. Expect needs_human/reconcile_receipt with idempotencyKey. A malformed
receipt may initially return needs_human without nextAction; invoking the same
request again returns reconcile_receipt without another send. Keep the original
runId; overlapping uncertain inputs can return a null runId with the blocking key.

JS reconciliation is explicit; there is no reconciliation CLI command:

```js
import { reconcilePublication } from 'qloops';
const result = await reconcilePublication(
  { workspace, runId, idempotencyKey },
  { lookup: async ({ receiver, idempotencyKey }) => {
      // Query your receiver's actual persistent receipt store.
      // Return its confirmed {id, delivered:true}; otherwise return null.
      return await receiverClient.lookup(receiver.id, idempotencyKey);
  } }
);
```

This is a host integration sketch: receiverClient is your authorized implementation,
not an exported package helper. Unknown receipt stays needs_human. The current API
only reconciles confirmed delivery; it does not automatically authorize retries
after a negative/missing lookup. Never fabricate a receipt or reset uncertain state.

## Missing prerequisites

configure_access means restore the configured local provider/receiver access;
configure_provider means configure a reviewed executable/model;
configure_caller means use a supported caller arrangement without stripping guards;
CLI_ENVIRONMENT_DENIED specifically means the Codex local app-server client could
not initialize under the parent execution environment. It is not an invalid model
answer or permission to disable sandboxing. Existing Content runId is retained
when the failure occurs after draft state creation.
review_permissions means resolve denied scope with the user; review_limits means
inspect a deadline/cap. These are instructions, not automatic permission changes.
An attribution check failure can return needs_human with evidence and no action:
show the findings for editorial correction. No generic retry means “publish”.

The installed-example package proof covers draft/approval/exact text/receipt/replay,
changed-input stale approval/rejection, missing receiver key and uncertain send.
It uses a subprocess model fixture and real localhost HTTP, explicitly not owner
Content acceptance. Real sources/profile/channel plus owner acceptance remain open.
