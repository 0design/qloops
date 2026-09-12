#!/usr/bin/env node
/**
 * qloop — run one loop from one file. Installed as `qloop`.
 *
 *   qloop validate <manifest>          read it, check it, say what it would do
 *   qloop run <manifest>               one pass, for real
 *   qloop run <manifest> --dry-run     one pass with no side effects at all
 *   qloop status [<manifest>]          what the last runs did
 *   qloop approve <manifest> [runId]   continue a run parked at a human gate
 *
 * `qloop run` performs ONE PASS. It is not a scheduler and does not pretend to be
 * one: repetition is launchd or cron, on the user's machine, where they can see
 * it. README §Scheduling has the two commands.
 *
 * EXIT CODES. 0 only when the run succeeded. A run that failed exits 1 and
 * writes the reason to `.qf/last-run.json`, because "it broke" and "there was
 * nothing today" must not look the same to whatever is watching. A run parked at
 * a gate exits 2 — not a failure, not a success, and worth telling apart.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, validateManifest, ManifestError } from "../src/manifest.mjs";
import { createRun, driveRun, resumeRun, resolveKnobs } from "../src/run.mjs";
import { RunStore } from "../src/state.mjs";
import { flattenLoopSteps } from "../src/flatten.mjs";
import { checkForUpdate, updateNotice } from "../src/update-check.mjs";
import { buildCatalog, fetchRemoteCatalog, fetchRemoteManifest, REMOTE_CATALOG_BASE, resolveCatalogRoots } from "../src/catalog.mjs";
import { parseYaml } from "../src/yaml.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_WAITING = 2;
const EXIT_USAGE = 64;

const c = {
  dim: (s) => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s) => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s),
};

const USAGE = `qloop ${PKG.version} — run a QFactory loop from a YAML manifest.

  qloop catalog                     loops, components, and demos in this build
  qloop catalog --section <name>    one section: loops | components | demos
  qloop init <id> [dir]             copy one loop here, ready to edit
  qloop validate <manifest>         check the manifest and print the plan
  qloop run <manifest> [--dry-run]  execute one pass
  qloop status [<manifest>]         show recent runs
  qloop approve <manifest> [runId]  continue a run held at a human gate
                                    (--reject to refuse it)
  qloop doctor                      check this machine before blaming the loop

Installed as qloop. There is no qf alias — that name belongs to @q-factory/bridge.

Options
  --dry-run     resolve and order every step, perform no side effects
  --json        machine-readable output
  --section     catalog section to print (loops, components, demos)
  --quiet       only errors

Environment
  OPENROUTER_API_KEY   required for llm-call and for an Agent-Gate
  OPENROUTER_MODEL     default model when the manifest does not set one
  QLOOP_WEBHOOK_URL    where catalogue loops send their result
  TELEGRAM_BOT_TOKEN   used by loops that publish to Telegram
  TELEGRAM_CHAT_ID     the chat those loops publish to
  QF_NO_UPDATE_CHECK=1 turn off the version check
`;

/**
 * Whichever of the relative and absolute path is shorter — a wall of `../` is
 * not more readable than the full path it is trying to save.
 *
 * The `./` prefix is not decoration. Under launchd the working directory is `/`,
 * so the relative form of an absolute path is the same string with its leading
 * slash shaved off — `Users/oleg/…`, which reads like a path and is not one.
 * Caught in the first scheduled run's log.
 */
function shortPath(p) {
  const abs = resolve(p);
  const cwd = process.cwd();
  /* From the filesystem root every path is "below" the cwd, so the relative form
     is the absolute one minus its leading slash — no shorter, and it reads like a
     path that is not there. Under launchd the cwd IS the root. */
  if (cwd === "/") return abs;
  const rel = relative(cwd, abs);
  if (!rel || rel.length >= abs.length) return abs;
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function fail(message, code = EXIT_FAILED) {
  /* Set exitCode and throw to stop control flow while Node flushes streams. */
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
  throw new ExitSignal();
}
/** Control-flow signal: the exit code has already been set. */
class ExitSignal extends Error {}

const VALUED_FLAGS = new Set(["section"]);

function parseArgs(argv) {
  const flags = new Set();
  const opts = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const body = a.slice(2);
    const eq = body.indexOf("=");
    if (eq !== -1) {
      opts[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    if (VALUED_FLAGS.has(body)) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        opts[body] = next;
        i += 1;
      } else {
        opts[body] = "";
      }
      continue;
    }
    flags.add(body);
  }
  return { command: positional[0], args: positional.slice(1), flags, opts };
}

/* ── validate ───────────────────────────────────────────────────────────── */

function describePlan(manifest) {
  const flat = flattenLoopSteps(manifest.steps);
  const knobs = resolveKnobs(manifest.settings);
  const lines = [];
  lines.push(`${c.bold(manifest.name)} ${c.dim(`(${manifest.id} v${manifest.version})`)}`);
  if (manifest.description) lines.push(`  ${manifest.description.trim().replace(/\n/g, "\n  ")}`);
  lines.push("");
  const triggers = manifest.triggers.length
    ? manifest.triggers.map((t) => (t.kind === "schedule" ? `schedule "${t.cron}" UTC` : t.kind)).join(" · ")
    : "none declared — this loop only runs when you run it";
  lines.push(`  triggers   ${triggers}`);
  lines.push(`  model      ${knobs.model} ${c.dim(`(${knobs.provenance.model})`)}`);
  lines.push(
    `  budget     ${knobs.budgetUsd === null ? "no ceiling (explicitly lifted)" : `$${Number(knobs.budgetUsd).toFixed(4)} per run`} ${c.dim(`(${knobs.provenance.budget})`)}`,
  );
  if (knobs.limits) lines.push(`  limits     ${JSON.stringify(knobs.limits)} ${c.dim("(enforced by the product, not by this runner)")}`);
  if (knobs.sensitivity) lines.push(`  ${c.bold("sensitivity")} set — this runner REFUSES such a manifest; see the note below`);
  lines.push("");
  lines.push(`  ${flat.length} step(s):`);
  for (const { step, depth } of flat) {
    const pad = "    " + "  ".repeat(depth);
    const name = step.config?.name ?? step.id;
    lines.push(`${pad}${step.kind.padEnd(14)} ${name}`);
  }
  const hasHumanGate = flat.some((f) => f.step.kind === "approval-gate" && (f.step.config?.reviewer ?? "human") === "human");
  lines.push("");
  lines.push(
    hasHumanGate
      ? `  ${c.dim("this loop stops for a human — `qloop approve` continues it")}`
      : `  ${c.dim("no human gate — this loop runs to the end on its own")}`,
  );
  return lines.join("\n");
}

async function cmdValidate(args, flags) {
  const file = args[0];
  if (!file) fail("qloop validate <manifest>", EXIT_USAGE);
  const manifest = loadManifest(file);
  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return EXIT_OK;
  }
  process.stdout.write(`✓ ${shortPath(file)} is a valid qloops.loop/v1 manifest\n\n`);
  process.stdout.write(`${describePlan(manifest)}\n`);
  if (manifest.settings.sensitivity) {
    process.stdout.write(
      "\n  NOTE: settings.sensitivity is part of the format but not implemented by this runner.\n" +
        "  `qloop run` will refuse this manifest rather than ignore the profile.\n",
    );
  }
  return EXIT_OK;
}

/* ── run ────────────────────────────────────────────────────────────────── */

function printStep(s, quiet) {
  if (quiet) return;
  const mark = { success: "✓", planned: "·", failed: "✗", waiting_human: "⏸" }[s.status] ?? " ";
  const cost = s.costUsd ? ` $${Number(s.costUsd).toFixed(4)}` : "";
  const lane = s.itemIndex != null ? c.dim(` [item ${s.itemIndex}]`) : "";
  process.stdout.write(`  ${mark} ${s.kind.padEnd(14)} ${s.name}${lane}${c.dim(cost)}\n`);
  if (s.status === "failed" && s.errorText) process.stdout.write(`      ${s.errorText}\n`);
  /* A digest that went to a file instead of Telegram is not a delivered digest.
     The run did its work, so this is not a failure — but it must never be quiet,
     or tomorrow nobody remembers why the channel is empty. */
  if (s.output?.sink === "file") {
    process.stdout.write(
      `      ⚠ NOT SENT — ${s.output.missingEnv.join(", ")} not set in the environment.\n` +
        `        Written to ${s.output.file} instead.\n`,
    );
  }
}

async function cmdRun(args, flags) {
  const file = args[0];
  if (!file) fail("qloop run <manifest> [--dry-run]", EXIT_USAGE);
  const dryRun = flags.has("dry-run");
  const quiet = flags.has("quiet");
  const manifest = loadManifest(file);

  if (!manifest.enabled) {
    process.stdout.write(`${manifest.id} is disabled (enabled: false) — nothing to do.\n`);
    return EXIT_OK;
  }

  const store = new RunStore(file);
  const run = createRun(manifest, { trigger: dryRun ? "dry-run" : "manual" });
  const knobs = resolveKnobs(manifest.settings);

  if (!quiet) {
    process.stdout.write(`${c.bold(manifest.name)} ${c.dim(`· run ${run.runId}`)}${dryRun ? c.dim(" · DRY RUN, no side effects") : ""}\n`);
  }

  let result;
  try {
    result = await driveRun(run, {
      store,
      knobs,
      dryRun,
      apiKey: process.env.OPENROUTER_API_KEY ?? null,
      onStep: (s) => printStep(s, quiet),
    });
  } catch (e) {
    /* A refusal before any step ran (a sensitivity profile, for instance). Still
       recorded: a run that never started is also something a monitor must see. */
    run.status = "failed";
    run.summary = e instanceof Error ? e.message : String(e);
    run.finishedAt = new Date().toISOString();
    store.save(run);
    store.saveLastRun(run);
    fail(`✗ ${run.summary}`);
  }

  if (!dryRun) store.saveLastRun(result);

  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (!quiet) {
    process.stdout.write(`\n  ${result.status.toUpperCase()}: ${result.summary}\n`);
    if (result.costUsd) process.stdout.write(`  cost $${Number(result.costUsd).toFixed(4)} · ${result.tokensIn}+${result.tokensOut} tokens\n`);
    if (!dryRun) process.stdout.write(c.dim(`  state ${shortPath(join(store.dir, "runs", `${result.runId}.json`))}\n`));
    if (result.status === "waiting_human") {
      process.stdout.write(`\n  Continue with:  qloop approve ${file} ${result.runId}\n`);
    }
  }

  return result.status === "success" ? EXIT_OK : result.status === "waiting_human" ? EXIT_WAITING : EXIT_FAILED;
}

/* ── status ─────────────────────────────────────────────────────────────── */

async function cmdStatus(args, flags) {
  const file = args[0] ?? findManifestNearby();
  if (!file) fail("qloop status <manifest> — or run it from a directory holding one", EXIT_USAGE);
  const store = new RunStore(file);
  const last = store.lastRun();
  const runs = store.listRuns(10);

  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify({ last, runs }, null, 2)}\n`);
    return last?.status === "success" || last == null ? EXIT_OK : EXIT_FAILED;
  }

  if (!runs.length) {
    process.stdout.write(`no runs recorded in ${shortPath(store.dir)}\n`);
    return EXIT_OK;
  }
  process.stdout.write(`${c.bold("last runs")} ${c.dim(shortPath(store.dir))}\n\n`);
  for (const r of runs) {
    const mark = { success: "✓", failed: "✗", waiting_human: "⏸", running: "…" }[r.status] ?? " ";
    const when = String(r.startedAt).replace("T", " ").slice(0, 19);
    process.stdout.write(`  ${mark} ${when}  ${r.status.padEnd(14)} ${r.summary ?? ""}\n`);
    if (r.status === "waiting_human") process.stdout.write(c.dim(`      qloop approve ${file} ${r.runId}\n`));
  }
  if (last?.status === "failed") {
    process.stdout.write(`\n  ${c.bold("last run FAILED")}: ${last.reason ?? last.summary}\n`);
  }
  return last?.status === "failed" ? EXIT_FAILED : EXIT_OK;
}

function findManifestNearby() {
  try {
    const y = readdirSync(process.cwd()).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
    return y.length === 1 ? y[0] : null;
  } catch {
    return null;
  }
}

/* ── approve ────────────────────────────────────────────────────────────── */

async function cmdApprove(args, flags) {
  const file = args[0];
  if (!file) fail("qloop approve <manifest> [runId] [--reject]", EXIT_USAGE);
  const store = new RunStore(file);
  const runId = args[1] ?? store.listRuns(50).find((r) => r.status === "waiting_human")?.runId;
  if (!runId) fail("no run is waiting on a human here.");
  const run = store.load(runId);
  if (!run) fail(`run ${runId} not found under ${store.runsDir}`);

  const manifest = loadManifest(file);
  const decision = flags.has("reject") ? "reject" : "approve";
  const result = await resumeRun(run, {
    decision,
    store,
    knobs: resolveKnobs(manifest.settings),
    apiKey: process.env.OPENROUTER_API_KEY ?? null,
    onStep: (s) => printStep(s, flags.has("quiet")),
  });
  store.saveLastRun(result);
  process.stdout.write(`\n  ${result.status.toUpperCase()}: ${result.summary}\n`);
  return result.status === "success" ? EXIT_OK : result.status === "waiting_human" ? EXIT_WAITING : EXIT_FAILED;
}

/* ── catalog · init ─────────────────────────────────────────────────────── */

const CATALOG_ROOTS = resolveCatalogRoots({ here: HERE });
const LOOPS_DIR = CATALOG_ROOTS.loopsDir;
const REGISTRY_DIR = CATALOG_ROOTS.registryDir;
const EXAMPLES_DIR = join(HERE, "..", "examples");

const CATALOG_SECTIONS = new Set(["loops", "components", "demos"]);

function printLoops(loops) {
  process.stdout.write(`${c.bold(`${loops.length} loops ship with qloop ${PKG.version}`)}\n\n`);
  for (const l of loops) {
    const cost = l.measured ? `$${l.measured.costUsd.toFixed(4)}/run` : "not measured yet";
    const shape = l.fansOut ? `${l.steps} steps, a lane per item (max ${l.maxItems})` : `${l.steps} steps`;
    process.stdout.write(`  ${c.bold(l.id)} ${c.dim(`· ${shape} · ${cost}`)}\n`);
    process.stdout.write(`    ${l.description}\n`);
    const needs = l.needsEnv.length ? l.needsEnv.join(", ") : "nothing";
    process.stdout.write(c.dim(`    needs: ${needs}${l.humanGate ? " · stops for you" : " · runs on its own"}\n\n`));
  }
}

function printComponents(components) {
  process.stdout.write(`${c.bold(`${components.length} components`)}\n\n`);
  for (const comp of components) {
    const used = comp.usedBy?.length ? `used by ${comp.usedBy.length} loop(s)` : "used by none yet";
    process.stdout.write(`  ${c.bold(comp.id)} ${c.dim(`· ${comp.kind} · ${used}`)}\n`);
    process.stdout.write(`    ${comp.description}\n\n`);
  }
}

function printDemos(demos) {
  process.stdout.write(`${c.bold(`${demos.length} demos`)}\n\n`);
  for (const d of demos) {
    const live = d.live ? "live" : "not live";
    const proof = d.proof ? `proof ${d.proof}` : "no proof";
    process.stdout.write(`  ${c.bold(d.id)} ${c.dim(`· ${d.name} · ${proof} · ${live}`)}\n`);
    process.stdout.write(`    ${d.description}\n\n`);
  }
}

async function cmdCatalog(args, flags, opts = {}) {
  const local = buildCatalog(LOOPS_DIR, { examplesDir: EXAMPLES_DIR, registryDir: REGISTRY_DIR });
  let cat = local;
  /* `--remote` shows what has been published since this build shipped. Off by
     default: a listing command must not need the network to answer. */
  if (flags.has("remote")) {
    const r = await fetchRemoteCatalog();
    if (!r) fail(`could not reach the published catalogue at ${REMOTE_CATALOG_BASE}`);
    const extra = r.loops.filter((l) => !local.loops.some((k) => k.id === l.id));
    cat = { ...r, loops: r.loops };
    if (!flags.has("json")) {
      process.stdout.write(c.dim(`published catalogue · ${extra.length} loop(s) newer than this build\n\n`));
    }
  }
  const section = opts.section;
  if (section != null && section !== "") {
    if (!CATALOG_SECTIONS.has(section)) {
      fail(`unknown catalog section "${section}". Use loops, components, or demos.`, EXIT_USAGE);
    }
  } else if (section === "") {
    fail("qloop catalog --section loops|components|demos", EXIT_USAGE);
  }
  if (flags.has("json")) {
    const payload = section ? { catalogVersion: cat.catalogVersion, [section]: cat[section] ?? [] } : cat;
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return EXIT_OK;
  }
  const show = (name) => !section || section === name;
  if (show("loops")) printLoops(cat.loops ?? []);
  if (show("components")) printComponents(cat.components ?? []);
  if (show("demos")) printDemos(cat.demos ?? []);
  if (show("loops")) process.stdout.write(c.dim(`  qloop init <id>   copies one here\n`));
  return EXIT_OK;
}

async function cmdInit(args, flags) {
  const id = args[0];
  const cat = buildCatalog(LOOPS_DIR, { examplesDir: EXAMPLES_DIR, registryDir: REGISTRY_DIR });
  if (!id) {
    fail(`qloop init <id>\n\nAvailable: ${cat.loops.map((l) => l.id).join(", ")}`, EXIT_USAGE);
  }

  let entry = cat.loops.find((l) => l.id === id);
  let remote = null;

  /* ── NOT IN THIS BUILD? LOOK IT UP IN THE PUBLISHED CATALOGUE ─────────────
     The package ships a snapshot of the catalogue as of its release; the
     published one keeps growing. Without this, "qloop init <something-new>"
     would tell a person the loop does not exist when it plainly does on the
     site they just read it on. */
  if (!entry && !flags.has("offline")) {
    const rcat = await fetchRemoteCatalog();
    const rentry = rcat?.loops.find((l) => l.id === id);
    if (rentry) {
      const got = await fetchRemoteManifest(rentry).catch((e) => {
        fail(`"${id}" is in the published catalogue, but it could not be downloaded — ${e.message}`);
      });
      /* VALIDATE BEFORE IT TOUCHES DISK. A manifest is not executable, but it
         directs network calls and model spending; bytes from a host do not get
         written here on the strength of having arrived. */
      try {
        validateManifest(parseYaml(got.text));
      } catch (e) {
        fail(`"${id}" downloaded from ${got.url}, but it is not a valid manifest — ${e.message}\n` +
             `Nothing was written.`);
      }
      entry = rentry;
      remote = got;
    }
  }

  if (!entry) {
    const hint = flags.has("offline") ? " (--offline: the published catalogue was not consulted)" : "";
    fail(`no loop "${id}"${hint}.\n\nIn this build: ${cat.loops.map((l) => l.id).join(", ")}`, EXIT_USAGE);
  }

  const dest = resolve(args[1] ?? process.cwd(), `${id}.yaml`);
  /* Never overwrite. The file being copied over is, by definition, the one the
     person already edited — the manifest IS their work, not scaffolding. */
  if (existsSync(dest)) fail(`${shortPath(dest)} already exists — not overwriting it.`);
  if (remote) writeFileSync(dest, remote.text, "utf8");
  else copyFileSync(join(LOOPS_DIR, basename(entry.file)), dest);

  process.stdout.write(`${c.bold(entry.name)}\n  → ${shortPath(dest)}\n`);
  if (remote) {
    /* Where a file came from is not a detail when the file will spend money. */
    process.stdout.write(c.dim(`  downloaded from ${remote.url}\n  read it before you run it — a loop makes requests and calls models on your key.\n`));
  }
  process.stdout.write("\n");
  if (entry.needsEnv.length) {
    const missing = entry.needsEnv.filter((v) => !process.env[v]);
    process.stdout.write(`  needs: ${entry.needsEnv.join(", ")}\n`);
    if (missing.length) {
      process.stdout.write(`  ${c.bold("not set here:")} ${missing.join(", ")}\n`);
      /* Two different consequences, and conflating them would be a lie: without a
         model key the step FAILS; without a receiver the result is still produced
         and lands in .qf/out/. */
      if (missing.includes("OPENROUTER_API_KEY")) {
        process.stdout.write(c.dim(`  Without OPENROUTER_API_KEY the model step fails — it will not invent text.\n`));
      }
      const sinks = missing.filter((v) => v !== "OPENROUTER_API_KEY");
      if (sinks.length) {
        process.stdout.write(c.dim(`  Without ${sinks.join(", ")} the loop still runs; the result goes to .qf/out/ and says so.\n`));
      }
    }
  }
  process.stdout.write(`\n  Next:  qloop run ${shortPath(dest)} --dry-run\n`);
  return EXIT_OK;
}

/* ── doctor ─────────────────────────────────────────────────────────────── */

async function cmdDoctor(args, flags) {
  /* Three levels, not two. An unset optional variable is NOT a fault — calling
     it one trains the reader to ignore the whole report, which is how a doctor
     command becomes decoration. Only `fail` counts towards the exit code. */
  const checks = [];
  const add = (level, label, detail) => checks.push({ level, label, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 20 ? "ok" : "fail", `Node ${process.versions.node}`, major >= 20 ? "" : "qloop needs Node 20 or newer");
  add("ok", `qloop ${PKG.version}`, shortPath(join(HERE, "qloop.mjs")));

  /* Names only, never values. A doctor command that prints a token into a
     terminal — and then into a screenshot in a bug report — is a leak. */
  const ENV_NOTES = {
    OPENROUTER_API_KEY: "no model calls will run without it — the step fails rather than inventing text",
    QLOOP_WEBHOOK_URL: "catalogue loops will write to .qf/out/ instead of sending",
    TELEGRAM_BOT_TOKEN: "Telegram loops will write to .qf/out/ instead of sending",
    TELEGRAM_CHAT_ID: "Telegram loops will write to .qf/out/ instead of sending",
  };
  for (const [v, why] of Object.entries(ENV_NOTES)) {
    add(process.env[v] ? "ok" : "warn", v, process.env[v] ? "set" : `not set — ${why}`);
  }

  const envFile = join(homedir(), ".qf", "env");
  if (existsSync(envFile)) {
    const mode = (statSync(envFile).mode & 0o777).toString(8);
    add(mode === "600" ? "ok" : "fail", `~/.qf/env (${mode})`, mode === "600" ? "" : "holds secrets — chmod 600 it");
  } else {
    add("warn", "~/.qf/env", "absent — only needed by a scheduled job");
  }

  try {
    const probe = join(process.cwd(), `.qloop-write-probe-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    add("ok", "write access here", process.cwd());
  } catch {
    add("fail", "write access here", `cannot write in ${process.cwd()} — .qf/ state has nowhere to go`);
  }

  if (!flags.has("offline")) {
    const t0 = Date.now();
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(4000) });
      add(res.ok ? "ok" : "warn", "openrouter.ai reachable", `HTTP ${res.status} in ${Date.now() - t0} ms`);
    } catch (e) {
      add("warn", "openrouter.ai", `unreachable: ${e instanceof Error ? e.message : e} — only matters for llm-call steps`);
    }
  }

  if (flags.has("json")) {
    process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`);
  } else {
    process.stdout.write(`${c.bold("qloop doctor")}\n\n`);
    for (const ch of checks) {
      const mark = { ok: "✓", warn: "·", fail: "✗" }[ch.level];
      process.stdout.write(`  ${mark} ${ch.label}${ch.detail ? c.dim(`  ${ch.detail}`) : ""}\n`);
    }
    const bad = checks.filter((ch) => ch.level === "fail");
    const warn = checks.filter((ch) => ch.level === "warn");
    process.stdout.write(
      bad.length
        ? `\n  ${bad.length} thing(s) in the way.\n`
        : `\n  Nothing in the way.${warn.length ? c.dim(` ${warn.length} optional thing(s) not set — see the dots.`) : ""}\n`,
    );
  }
  return checks.some((ch) => ch.level === "fail") ? EXIT_FAILED : EXIT_OK;
}

/* ── entry ──────────────────────────────────────────────────────────────── */

const { command, args, flags, opts } = parseArgs(process.argv.slice(2));

const commands = {
  catalog: cmdCatalog,
  init: cmdInit,
  validate: cmdValidate,
  run: cmdRun,
  status: cmdStatus,
  approve: cmdApprove,
  doctor: cmdDoctor,
};

/** Keep dispatch inside main so help/version return before command lookup. */
async function main() {
  if (flags.has("version")) {
    process.stdout.write(`${PKG.version}\n`);
    return EXIT_OK;
  }
  /* Explicit help succeeds; a missing command is a usage error. */
  if (!command || flags.has("help") || command === "help") {
    process.stdout.write(USAGE);
    return flags.has("help") || command === "help" ? EXIT_OK : EXIT_USAGE;
  }

  const handler = commands[command];
  if (!handler) fail(`unknown command "${command}".\n\n${USAGE}`, EXIT_USAGE);

  const code = await handler(args, flags, opts);
  /* The version check runs AFTER the work, never before it, and never during a
     --quiet or --json run whose output something else is parsing. */
  if (!flags.has("quiet") && !flags.has("json")) {
    const notice = updateNotice(await checkForUpdate(PKG.version));
    if (notice) process.stdout.write(c.dim(notice));
  }
  return code;
}

/** Set exitCode and let Node flush pipe output; process.exit() can truncate JSON. */
try {
  process.exitCode = await main();
} catch (e) {
  if (e instanceof ExitSignal) {
    /* fail() has already reported the error and set the exit code. */
  } else if (e instanceof ManifestError) {
    process.stderr.write(`✗ ${e.message}\n`);
    process.exitCode = EXIT_FAILED;
  } else {
    process.stderr.write(`✗ ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = EXIT_FAILED;
  }
}
