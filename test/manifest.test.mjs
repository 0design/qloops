/**
 * `qloops validate` is only worth running if it catches the things that would
 * otherwise be discovered halfway through a paid run. These tests are that
 * claim, checked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateManifest, loadManifest, assertCron, ManifestError } from "../src/manifest.mjs";
import { parseYaml } from "../src/yaml.mjs";

const MANIFESTS = join(dirname(fileURLToPath(import.meta.url)), "manifests");

const base = (extra = "") =>
  parseYaml(`manifest: qloops.loop/v1
id: t
steps:
  - id: a
    kind: api-request
    config:
      url: "https://example.test/x"
${extra}`);

test("the four shipped parity manifests all validate", () => {
  for (const f of ["parity-no-human", "parity-human-gate", "parity-budget-zero", "parity-fan-out"]) {
    const m = loadManifest(join(MANIFESTS, `${f}.yaml`));
    assert.equal(m.id, f);
    assert.ok(m.steps.length > 0);
  }
});

test("config values are all normalised to strings — that is what the engine reads", () => {
  const m = validateManifest(
    parseYaml(`manifest: qloops.loop/v1
id: t
steps:
  - id: a
    kind: fetch
    config:
      url: "https://example.test/x"
      timeoutSec: 30
      enabled: true
      dropped: null`),
  );
  assert.deepEqual(m.steps[0].config, { url: "https://example.test/x", timeoutSec: "30", enabled: "true" });
});

test("a missing format tag is refused — otherwise this is just some YAML", () => {
  assert.throws(() => validateManifest(parseYaml(`id: t\nsteps:\n  - id: a\n    kind: fetch`)), ManifestError);
});

test("a version this build does not read is named, not guessed at", () => {
  assert.throws(
    () => validateManifest(parseYaml(`manifest: qloops.loop/v2\nid: t\nsteps: [{id: a, kind: fetch}]`)),
    (e) => e instanceof ManifestError && /v2/.test(e.message),
  );
});

test("a trigger inside steps: is a real mistake and says so", () => {
  assert.throws(
    () =>
      validateManifest(
        parseYaml(`manifest: qloops.loop/v1\nid: t\nsteps:\n  - id: s\n    kind: schedule\n    config:\n      cron: "0 7 * * *"`),
      ),
    (e) => e instanceof ManifestError && /TRIGGER/.test(e.message),
  );
});

test("agent-call is reserved in the format and refused in this build", () => {
  assert.throws(
    () => validateManifest(parseYaml(`manifest: qloops.loop/v1\nid: t\nsteps:\n  - id: a\n    kind: agent-call`)),
    (e) => e instanceof ManifestError && /reserved/.test(e.message),
  );
});

test("an Agent-Gate claiming mode: check is refused — the checker does not exist yet", () => {
  assert.throws(
    () =>
      validateManifest(
        parseYaml(`manifest: qloops.loop/v1
id: t
steps:
  - id: g
    kind: approval-gate
    config:
      reviewer: agent
      rubric: "must cite a source"
      mode: check`),
      ),
    (e) => e instanceof ManifestError && /RESERVED/.test(e.message),
  );
});

test("an Agent-Gate with no rubric has nothing to check against", () => {
  assert.throws(
    () =>
      validateManifest(
        parseYaml(`manifest: qloops.loop/v1\nid: t\nsteps:\n  - id: g\n    kind: approval-gate\n    config:\n      reviewer: agent`),
      ),
    (e) => e instanceof ManifestError && /rubric/.test(e.message),
  );
});

test("duplicate step ids are refused — outputs are addressed by id", () => {
  assert.throws(
    () =>
      validateManifest(
        parseYaml(`manifest: qloops.loop/v1
id: t
steps:
  - id: a
    kind: fetch
    config: {url: "https://example.test/x"}
  - id: a
    kind: fetch
    config: {url: "https://example.test/y"}`),
      ),
    (e) => e instanceof ManifestError && /duplicate step id/.test(e.message),
  );
});

test("required per-kind fields are caught at validate time, not at run time", () => {
  assert.throws(() => validateManifest(parseYaml(`manifest: qloops.loop/v1\nid: t\nsteps:\n  - id: a\n    kind: fetch`)), /config.url|"url"/);
  assert.throws(() => validateManifest(parseYaml(`manifest: qloops.loop/v1\nid: t\nsteps:\n  - id: a\n    kind: llm-call`)), /instructions/);
});

test("a fan-out with no lane has nothing to repeat", () => {
  assert.throws(
    () =>
      validateManifest(
        parseYaml(`manifest: qloops.loop/v1\nid: t\nsteps:\n  - id: f\n    kind: fan-out\n    config:\n      over: "{{steps.a.output.entries}}"`),
      ),
    (e) => e instanceof ManifestError && /lane/.test(e.message),
  );
});

test("nested structure in step config is refused with the fix in the message", () => {
  assert.throws(
    () =>
      validateManifest(
        parseYaml(`manifest: qloops.loop/v1
id: t
steps:
  - id: a
    kind: api-request
    config:
      url: "https://example.test/x"
      body:
        a: 1`),
      ),
    (e) => e instanceof ManifestError && /JSON STRING/.test(e.message),
  );
});

test("cron is checked, five fields and in range", () => {
  assert.doesNotThrow(() => assertCron("30 6 * * *"));
  assert.doesNotThrow(() => assertCron("*/15 0-6 1,15 * 1-5"));
  assert.throws(() => assertCron("30 6 * *"), /5-field/);
  assert.throws(() => assertCron("30 99 * * *"), /outside/);
  assert.throws(() => assertCron("30 6 * * mon"), /not a value/);
});

test("budgetUsd: null is allowed and means the ceiling was lifted ON PURPOSE", () => {
  const m = validateManifest(base("settings:\n  budgetUsd: null"));
  assert.equal(m.settings.budgetUsd, null);
  assert.ok("budgetUsd" in m.settings);
});

test("an absent budget is NOT the same as a lifted one", () => {
  const m = validateManifest(base());
  assert.equal("budgetUsd" in m.settings, false);
});

// A renamed protocol must not silently accept legacy manifests.
test("rejects the retired loop namespace", () => {
  const legacy = "qf.loop/v1";
  assert.throws(() => validateManifest(parseYaml(`manifest: ${legacy}\nid: legacy\nsteps: [{id: gate, kind: approval-gate, config: {reviewer: human}}]`)), /unknown manifest family/);
});
