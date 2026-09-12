/**
 * `{{steps.X.output.y}}` · `{{item.y}}` · `{{index}}` — the runner's copy of
 * `lib/processes/template.ts`. Same regexes, same lookup order, same rule that an
 * UNRESOLVED placeholder is left in place rather than blanked: a literal `{{…}}`
 * arriving at a webhook is a visible failure, an empty string is a silent one.
 *
 * The step reference is lazy up to the nearest `.output` so that a step NAME with
 * a space in it ("Fetch feed") resolves. That was a real inherited bug: the
 * original pattern could not match a space, so name-based references never worked
 * and the literal placeholder travelled into the outgoing request body.
 */

const TEMPLATE_RE = /\{\{\s*steps\.(.+?)\.output(?:\.([^}\s]+))?\s*\}\}/g;
const ITEM_RE = /\{\{\s*(item|index)(?:\.([^}\s]+))?\s*\}\}/g;

/**
 * `{{env.NAME}}` — a value from the environment.
 *
 * A manifest is a file that lives in git. A bot token, an API key, a chat id:
 * none of them may appear in its text, or "share your loop" turns into "share
 * your secret". Referencing the environment is the only way to write
 * `https://api.telegram.org/bot<TOKEN>/sendMessage` without putting the token in.
 *
 * UPPER_SNAKE only, so `{{env.x}}` never quietly starts meaning something else.
 * An unset variable leaves the placeholder in place — same convention as above:
 * literal braces in a URL are visible, whereas an empty string would produce a
 * request to somewhere nobody can account for afterwards.
 */
const ENV_RE = /\{\{\s*env\.([A-Z][A-Z0-9_]*)\s*\}\}/g;

/**
 * `{{run.costUsd}}` · `{{run.id}}` · `{{run.loopId}}` — facts about THIS run,
 * as they stand at the moment the step executes.
 *
 * `costUsd` is what the run has spent SO FAR — every step before this one. On
 * the final `api-request` that is the whole cost of the run, because an outgoing
 * request is free. This is what lets a published post carry a true "generated
 * for $0.0006" line instead of a number somebody typed in once and forgot.
 *
 * It is a running total, not a forecast: a step in the middle sees only what
 * came before it, which is the only number that is actually known there.
 */
const RUN_RE = /\{\{\s*run\.(id|loopId|costUsd)\s*\}\}/g;


function getByPath(value, path) {
  if (!path) return value;
  let cur = value;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[seg];
  }
  return cur;
}

function resolveStepRef(ref, ctx) {
  if (Object.prototype.hasOwnProperty.call(ctx.priorOutputs, ref)) {
    return { id: ref, output: ctx.priorOutputs[ref] };
  }
  if (ctx.priorStepNames) {
    const lower = ref.toLowerCase();
    for (const [id, name] of Object.entries(ctx.priorStepNames)) {
      if (String(name).toLowerCase() === lower) return { id, output: ctx.priorOutputs[id] };
    }
  }
  return null;
}

function stringify(v) {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function lookupItemVar(name, path, ctx) {
  if (name === "index") return ctx.index;
  if (!("item" in ctx)) return undefined;
  return getByPath(ctx.item, path);
}

/** Resolve every placeholder in `text` to a STRING. */
export function resolveTemplate(text, ctx) {
  const withSteps = String(text).replace(TEMPLATE_RE, (match, ref, path) => {
    const resolved = resolveStepRef(ref, ctx);
    if (!resolved) return match;
    const v = getByPath(resolved.output, path);
    return v === undefined ? match : stringify(v);
  });
  const withItems = withSteps.replace(ITEM_RE, (match, name, path) => {
    const v = lookupItemVar(name, path, ctx);
    return v === undefined ? match : stringify(v);
  });
  const withEnv = withItems.replace(ENV_RE, (match, name) => process.env[name] ?? match);
  return withEnv.replace(RUN_RE, (match, field) => {
    const v = ctx.run?.[field];
    if (v === undefined || v === null) return match;
    return field === "costUsd" ? Number(v).toFixed(4) : String(v);
  });
}

/** The `{{env.X}}` names that are NOT set. Empty means every reference resolved. */
export function missingEnvRefs(text) {
  const out = new Set();
  for (const m of String(text).matchAll(ENV_RE)) {
    if (process.env[m[1]] === undefined) out.add(m[1]);
  }
  return [...out];
}

/**
 * Resolve to a VALUE, not a string — fan-out needs the real array, not its JSON
 * text. Works only when the string is EXACTLY one placeholder; "List: {{…}}"
 * returns undefined rather than guessing what the mixed text was meant to be.
 */
export function resolveTemplateValue(text, ctx) {
  const one = String(text).trim();
  const step = one.match(/^\{\{\s*steps\.(.+?)\.output(?:\.([^}\s]+))?\s*\}\}$/);
  if (step) {
    const resolved = resolveStepRef(step[1], ctx);
    if (!resolved) return undefined;
    return getByPath(resolved.output, step[2]);
  }
  const item = one.match(/^\{\{\s*(item|index)(?:\.([^}\s]+))?\s*\}\}$/);
  if (item) return lookupItemVar(item[1], item[2], ctx);
  return undefined;
}

/** Walk any JSON value, resolving templates in every string node. */
export function resolveTemplateDeep(value, ctx) {
  if (typeof value === "string") return resolveTemplate(value, ctx);
  if (Array.isArray(value)) return value.map((v) => resolveTemplateDeep(v, ctx));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveTemplateDeep(v, ctx);
    return out;
  }
  return value;
}
