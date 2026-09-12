/**
 * Manifest → the shape the engine already runs.
 *
 * This file is the whole reason the package exists. `SPEC-loop-manifest.md`
 * (stage 2) described a YAML format; nothing could read it, so a stranger could
 * write a perfectly valid manifest and had no way to run it. What comes out of
 * here is exactly `{ settings, steps }` as stored in `qf_loop_template` — the
 * same tree `flattenLoopSteps` and `driveRun` take. There is no second format
 * and no translation layer: this reads THE format, or it refuses.
 *
 * ONE NORMALISATION MATTERS. `LoopStep.config` is `Record<string, string>` in the
 * database, because the loop builder stores everything as text. YAML gives real
 * numbers and booleans. They are stringified HERE, once, so that
 * `timeoutSec: 30` and `timeoutSec: "30"` are the same manifest — and so the
 * runner and the engine coerce from identical input.
 *
 * Validation refuses rather than guesses. Every message names the path
 * (`steps[2].config.url`) because a manifest is written by a person who is not
 * looking at this code.
 */
import { readFileSync } from "node:fs";
import { parseYaml, YamlError } from "./yaml.mjs";

/** The format tag every manifest must carry, verbatim. */
export const MANIFEST_TAG = "qloops.loop/v1";

/** Step kinds the engine executes. */
export const ENGINE_KINDS = ["fetch", "llm-call", "api-request", "approval-gate", "fan-out"];

/** Trigger kinds — entry points, not steps. `schedule` is one of these, not a runner. */
export const TRIGGER_KINDS = ["schedule", "manual", "webhook", "signal", "intent-input", "loop-input", "event"];

/** Reserved in the format, deliberately NOT implemented (owner decision 2026-08-01). */
export const RESERVED_KINDS = {
  "agent-call": "a call to an agent WITH its own context — reserved in the format, not implemented in v1",
};

export class ManifestError extends Error {
  constructor(message, path) {
    super(path ? `${path}: ${message}` : message);
    this.name = "ManifestError";
    this.path = path ?? null;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Every config value becomes a string — that is what the engine reads.
 * `null` drops the key entirely: an absent field and a null one both mean
 * "not filled in", and `str()` already treats them identically.
 */
function normaliseConfig(raw, path) {
  if (raw == null) return {};
  if (!isPlainObject(raw)) throw new ManifestError("must be a mapping of field → value", path);
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v == null) continue;
    if (Array.isArray(v) || isPlainObject(v)) {
      throw new ManifestError(
        `"${k}" is a ${Array.isArray(v) ? "list" : "mapping"}, but step config holds only scalars. ` +
          `Nested structure travels as a JSON STRING — write it on one line in quotes (e.g. body: '{"a":1}').`,
        path,
      );
    }
    out[k] = typeof v === "string" ? v : String(v);
  }
  return out;
}

function validateStep(raw, path, seenIds) {
  if (!isPlainObject(raw)) throw new ManifestError("a step must be a mapping", path);

  const id = raw.id;
  if (typeof id !== "string" || id.trim() === "") {
    throw new ManifestError('"id" is required and must be a non-empty string', path);
  }
  if (seenIds.has(id)) {
    throw new ManifestError(
      `duplicate step id "${id}" — step outputs are addressed by id, so two steps sharing one would overwrite each other`,
      path,
    );
  }
  seenIds.add(id);

  const kind = raw.kind;
  if (typeof kind !== "string" || kind.trim() === "") {
    throw new ManifestError('"kind" is required', `${path}.kind`);
  }
  if (RESERVED_KINDS[kind]) {
    throw new ManifestError(
      `"${kind}" is reserved in the format but not implemented — ${RESERVED_KINDS[kind]}`,
      `${path}.kind`,
    );
  }
  if (TRIGGER_KINDS.includes(kind)) {
    throw new ManifestError(
      `"${kind}" is a TRIGGER, not a step. Move it under the top-level "triggers:" list — ` +
        `a trigger inside "steps:" would be a step that does nothing and always succeeds`,
      `${path}.kind`,
    );
  }
  if (!ENGINE_KINDS.includes(kind)) {
    throw new ManifestError(
      `unknown step kind "${kind}". Known kinds: ${ENGINE_KINDS.join(", ")}`,
      `${path}.kind`,
    );
  }

  const config = normaliseConfig(raw.config, `${path}.config`);
  const step = { id, kind, config };

  if (raw.then != null) {
    if (!Array.isArray(raw.then)) throw new ManifestError('"then" must be a list of steps', `${path}.then`);
    step.then = raw.then.map((s, i) => validateStep(s, `${path}.then[${i}]`, seenIds));
  }

  /* Per-kind requirements. Checked at validate time so `qloops validate` is worth
     running: a missing url should not be discovered halfway through a paid run. */
  if (kind === "fetch" && !config.url) {
    throw new ManifestError('a fetch step needs "config.url"', `${path}.config`);
  }
  if (kind === "api-request" && !config.url) {
    throw new ManifestError('an api-request step needs "config.url"', `${path}.config`);
  }
  if (kind === "llm-call" && !config.instructions) {
    throw new ManifestError('an llm-call step needs "config.instructions"', `${path}.config`);
  }
  if (kind === "approval-gate") {
    const reviewer = config.reviewer ?? "human";
    if (!["human", "agent"].includes(reviewer)) {
      throw new ManifestError(`"reviewer" must be "human" or "agent", got "${reviewer}"`, `${path}.config`);
    }
    if (reviewer === "agent" && !config.rubric) {
      throw new ManifestError(
        'an Agent-Gate with no "rubric" has nothing to check against — set the criterion, or switch reviewer to human',
        `${path}.config`,
      );
    }
    if (config.mode === "check") {
      throw new ManifestError(
        'mode: check (a real, non-LLM checker) is RESERVED and not implemented — today an Agent-Gate is an LLM judge. ' +
          "Remove the field rather than let the manifest claim a check that will not happen",
        `${path}.config`,
      );
    }
  }
  if (kind === "fan-out") {
    if (!step.then?.length) {
      throw new ManifestError('a fan-out needs a "then" lane — there is nothing to repeat per item', path);
    }
    if (config.over && !/\{\{.*\}\}/.test(config.over)) {
      throw new ManifestError(
        `"over" must be a single template pointing at a prior step's array, e.g. {{steps.${[...seenIds][0]}.output.entries}}`,
        `${path}.config`,
      );
    }
  }
  return step;
}

function validateSettings(raw) {
  if (raw == null) return {};
  if (!isPlainObject(raw)) throw new ManifestError("must be a mapping", "settings");
  const out = {};

  if (raw.model != null) {
    if (typeof raw.model !== "string") throw new ManifestError("must be a string", "settings.model");
    out.model = raw.model;
  }
  if ("budgetUsd" in raw) {
    // null is meaningful: it lifts the ceiling explicitly, which is not the same
    // as leaving the knob alone (that takes the documented default).
    if (raw.budgetUsd !== null && (typeof raw.budgetUsd !== "number" || !Number.isFinite(raw.budgetUsd) || raw.budgetUsd < 0)) {
      throw new ManifestError("must be a non-negative number, or null to lift the ceiling", "settings.budgetUsd");
    }
    out.budgetUsd = raw.budgetUsd;
  }
  if (raw.limits != null) {
    if (!isPlainObject(raw.limits)) throw new ManifestError("must be a mapping of window → caps", "settings.limits");
    for (const [win, caps] of Object.entries(raw.limits)) {
      if (!["daily", "weekly", "monthly"].includes(win)) {
        throw new ManifestError(`unknown window "${win}" — use daily, weekly or monthly`, "settings.limits");
      }
      if (!isPlainObject(caps)) throw new ManifestError("must be a mapping", `settings.limits.${win}`);
    }
    out.limits = raw.limits;
  }
  if (raw.sensitivity != null) out.sensitivity = raw.sensitivity;
  if (raw.exit != null) out.exit = raw.exit;
  return out;
}

function validateTriggers(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ManifestError("must be a list", "triggers");
  return raw.map((t, i) => {
    const path = `triggers[${i}]`;
    if (!isPlainObject(t)) throw new ManifestError("a trigger must be a mapping", path);
    if (typeof t.kind !== "string") throw new ManifestError('"kind" is required', path);
    if (!TRIGGER_KINDS.includes(t.kind)) {
      throw new ManifestError(`unknown trigger kind "${t.kind}". Known: ${TRIGGER_KINDS.join(", ")}`, path);
    }
    if (t.kind === "schedule" && (typeof t.cron !== "string" || t.cron.trim() === "")) {
      throw new ManifestError('a schedule trigger needs "cron" (5-field, UTC)', path);
    }
    if (t.kind === "schedule") assertCron(t.cron, path);
    return { ...t };
  });
}

/** Five fields, each a number / * / list / range / step. Refuses rather than assumes. */
export function assertCron(expr, path = "cron") {
  const fields = String(expr).trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ManifestError(
      `cron "${expr}" has ${fields.length} field(s); a 5-field expression is required (minute hour day month weekday, UTC)`,
      path,
    );
  }
  const bounds = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];
  fields.forEach((f, i) => {
    const [lo, hi] = bounds[i];
    for (const part of f.split(",")) {
      const m = part.match(/^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/);
      if (!m) throw new ManifestError(`cron field ${i + 1} ("${part}") is not a value, range, list or step`, path);
      if (m[1] !== "*") {
        for (const n of m[1].split("-").map(Number)) {
          if (n < lo || n > hi) {
            throw new ManifestError(`cron field ${i + 1}: ${n} is outside ${lo}–${hi}`, path);
          }
        }
      }
    }
  });
}

/**
 * Validate a parsed document.
 * @returns {{id:string,name:string,version:string,description:string,owner:string,
 *            enabled:boolean,triggers:object[],settings:object,steps:object[]}}
 */
export function validateManifest(doc) {
  if (!isPlainObject(doc)) throw new ManifestError("the manifest must be a YAML mapping at the top level");

  const tag = doc.manifest;
  if (tag == null) {
    throw new ManifestError(
      `missing "manifest: ${MANIFEST_TAG}" on the first line. Without it there is no way to tell this file ` +
        "from any other YAML, and no way to version the format later",
      "manifest",
    );
  }
  if (tag !== MANIFEST_TAG) {
    const [family, ver] = String(tag).split("/");
    throw new ManifestError(
      family === "qloops.loop"
        ? `this runner reads ${MANIFEST_TAG}; the manifest declares ${tag}. Version "${ver}" is either older or newer than this build`
        : `unknown manifest family "${tag}" — expected ${MANIFEST_TAG}`,
      "manifest",
    );
  }

  if (typeof doc.id !== "string" || doc.id.trim() === "") {
    throw new ManifestError('"id" is required — it names the loop in state and in logs', "id");
  }
  if (!Array.isArray(doc.steps) || doc.steps.length === 0) {
    throw new ManifestError('"steps" is required and must hold at least one step', "steps");
  }

  const seenIds = new Set();
  const steps = doc.steps.map((s, i) => validateStep(s, `steps[${i}]`, seenIds));

  return {
    id: doc.id,
    name: typeof doc.name === "string" ? doc.name : doc.id,
    version: doc.version == null ? "0" : String(doc.version),
    description: typeof doc.description === "string" ? doc.description : "",
    owner: typeof doc.owner === "string" ? doc.owner : "",
    enabled: doc.enabled !== false,
    triggers: validateTriggers(doc.triggers),
    settings: validateSettings(doc.settings),
    steps,
  };
}

/** Read a manifest file and validate it. Throws ManifestError / YamlError. */
export function loadManifest(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    throw new ManifestError(`cannot read ${file} — ${e.code === "ENOENT" ? "no such file" : e.message}`);
  }
  let doc;
  try {
    doc = parseYaml(text);
  } catch (e) {
    if (e instanceof YamlError) throw new ManifestError(`${file} is not readable YAML — ${e.message}`);
    throw e;
  }
  const manifest = validateManifest(doc);
  manifest.file = file;
  return manifest;
}
