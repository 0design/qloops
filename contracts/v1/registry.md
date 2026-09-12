# Pinned registry consumption

`qloops install <base> <catalog-sha256> <id> <version> <destination>` downloads,
checks and installs an exact loop plus a sidecar origin/dependency lock. The base
is an absolute export directory or static HTTPS directory containing catalog.json
and loops/components/demos subdirectories. HTTP is allowed only on localhost for
controlled development. The Site /api/registry route is a different API layout;
it is not automatically treated as a static export base.

The catalog must pin the installed qloops version exactly and qloops.loop/v1. A newer
local engine must not rewrite a downloaded catalog or silently accept the old pin.
Use the retained engine artifact for an existing release; only the registry owner
can publish a new accepted pin. Catalog and every resolved asset need SHA256
verification; the root manifest is parsed and checked before destination writes.

Candidate core.6 additionally rejects malformed sections/dependencies, mismatched
entry engine metadata, files outside their declared section/ID, and ambiguous
same-ID dependencies spanning loops/components. Dependencies are exact IDs/versions;
missing targets, cycles or checksum mismatch fail before installation. Each section
has at most 1000 entries, each dependency list at most 100 entries. Loop default
path is loops/<id>.yaml; component/demo default is <section>/<id>.json.

Existing destination or lock is never overwritten. Download failure does not become
success. Installation writes a manifest and then its lock as separate exclusive
files; this is not an atomic two-file transaction. If interrupted between those
writes, inspect/remove only the new incomplete installation before retrying. The
lock is provenance, not permission to run external actions or a ban on intentional
local editing. Review environment, target URLs and manifest actions before running.

## Reproduce from the Core source checkout

```sh
node scripts/test-registry-package.mjs /absolute/path/to/QFactory.io
```

This installs the exact Site-pinned retained engine into a fresh temporary caller,
serves unmodified export bytes over localhost, downloads webhook-relay, validates
and executes against a controlled local source/receiver. It separately checks
current-engine pin refusal and a clearly synthetic candidate catalog containing
identical manifest bytes with new engine metadata. That synthetic catalog is not a
canonical release, repin, production registry or Site mutation. Evidence lives in
`docs/delivery/registry-package.json`.

As checked 2026-09-10, https://qfactory.io/api/registry returns HTTP404 and the
local export declares publication gates. Static registry provisioning, release
approval and consumer repin remain external to this local proof. No public
registry was created or published by Core.
