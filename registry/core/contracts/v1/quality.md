# Quality adapter contract — revision 4 / qf.quality/v1

Candidate core.5 strengthens the existing result envelope. Consumers must update
callbacks and repin explicitly: missing new pin fields produce needs_human, not
an implicit legacy pass. Canonical Site manifests remain separate.

`qualityCheck(request,{evaluate,recipe})` snapshots request data before callbacks.
Input: kind (`aindf-check` or `unslop`), mode (AINDF: `ds-readiness` or
`ui-compliance`), upstream `{version,sha256}`, artifact `{revision,sha256,...}`,
1–100 unique nonempty `requiredRules`, optional `browserEvidence`, `signal`.
AINDF requires `designSystem` with a pinned `sha256`. Missing/unpinned DS returns
needs_human. Revision must be a nonnegative safe integer.

An evaluate callback receives a detached request plus AbortSignal. Its report
must include matching `upstreamVersion`, **`upstreamSha256`**, `artifactHash`,
`revision`, and AINDF **`designSystemHash`**. Findings (at most 1000) are objects
with rule ID, type `hard|soft`, outcome `pass|fail|unknown`, and a nonempty evidence
object. Exactly one valid finding must cover each required rule. Duplicate,
missing, malformed, untyped or unsupported coverage stays unknown. Callbacks
cannot remove required rules or rewrite the original artifact/upstream identity.

Every required rule needs known evidence; otherwise status is needs_human. With
complete coverage, a hard failure returns failed; a soft failure returns
needs_human; all passes return success. Unslop and UI compliance also require
browserEvidence with matching artifactHash/revision and screenshot SHA256. These
are attestations by a trusted browser-evidence producer, not a screenshot created
or validated visually by this reducer. Keep the actual screenshot, URL and exact
page/stylesheet hashes; stale captures must be regenerated.

Recipe callbacks receive `{rule,version,sha256,signal}` and must return those same
rule/version/sha256 values. Missing/mismatched recipes are unknown, transport
failures unavailable. Recipes never change the checker result or apply changes.
No specific MCP server is invented; actual recipe service integration remains an
upstream dependency. Cancellation before/after callbacks returns cancelled. The
host enforces callback timeouts and resource limits; arbitrary JavaScript cannot
be forcibly terminated by this reducer.

## Native AINDF

Load caller-installed source using `loadAindf({root,packageVersion,sha256})`.
`sha256` is `upstreamDigest(root,['cli','schemas','package.json'])`.
The package version and executable framework version are separate identities;
request upstream.version must match `adapter.frameworkVersion`.

Use `designSystemDigest(dsPath)` to hash existing aindf.json, src and generated
inputs, including absent-input markers. No rules or framework source are copied.
Readiness artifact.sha256 is this DS digest. Composition artifact.sha256 is:

```js
hash({designSystemSha256: designSystem.sha256, sections: designSystem.sections ?? null})
```

The adapter checks the exact DS and upstream content before/after evaluation.
Native validation handles schema/rules; the adapter additionally refuses an empty
DS subject because the reviewed RC can return vacuous passing levels for absent
contracts. Operational native exceptions remain unknown, not success.

Readiness maps native conformance levels. UI coverage is only the upstream
`composition-contract`; unknown UI/DOM/visual rules stay unknown. A rendered page
must be independently bound to the composition before supplying browser evidence.
The current local package is 0.5.0-rc.1 / framework 0.3.0-rc.1. npm aindf still
returns E404 as checked 2026-09-10; this is not released-framework acceptance.

## Native Oleg unslop

Load the explicitly installed Oleg canon with `loadUnslop({root,packageVersion,sha256})`.
Digest covers scripts/references/package.json. The adapter loads rule metadata from
that same pinned upstream; it does not maintain a copied rule list. Requested rule
must resolve to one exact ID and apply to the artifact file extension through a
native file evaluator. Section aliases, project-only rules, unsupported extensions
and unknown rules return unknown. Selected-rule count is not proof of application.
Native red findings are hard; orange/white findings are soft, not passing silence.

The artifact is a single file with actual bytes matching its hash, checked before
and after detection. Browser receipts may bind that CSS file together with the
rendered page and screenshot hashes. This demonstrates selected source-rule
coverage, not complete subjective design quality. The package named unslop from
another npm author is not a substitute for Oleg's canon.

Both native loaders require immutable installation roots: Node caches imported
modules by path. Loading a changed checksum from an already-loaded root is rejected;
install a new version in another directory or start a fresh process. The caller
must trust installed code/dependencies; checksums are not an OS execution sandbox.
