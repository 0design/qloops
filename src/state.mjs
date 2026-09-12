/**
 * Run state — plain files under `.qf/`, next to the manifest. No database.
 *
 *   .qf/runs/<runId>.json   one file per run: every step, its output, its cost
 *   .qf/last-run.json       the newest run's outcome — what a monitor reads
 *   .qf/out/                the file sink, used when no real receiver is configured
 *
 * WHY FILES AND NOT SQLITE. The state a single-pass local run needs is "which
 * steps ran, what they returned, what it cost". A file you can `cat` when the
 * 07:00 digest did not arrive beats a database you need a client for. The
 * product's run history lives in MySQL and stays there; this is not a smaller
 * copy of it, it is a different thing with a different job.
 *
 * WRITES ARE ATOMIC (tmp + rename). A run interrupted mid-write must not leave a
 * half-written JSON that the next `qloops status` then refuses to parse — that turns
 * one failed run into a permanently broken directory.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export const STATE_DIR_NAME = ".qf";

/** The `.qf/` directory for a manifest — beside the file, not in the cwd. */
export function stateDirFor(manifestFile) {
  return join(dirname(resolve(manifestFile)), STATE_DIR_NAME);
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function newRunId() {
  return randomUUID();
}

export class RunStore {
  constructor(manifestFile) {
    this.dir = stateDirFor(manifestFile);
    this.runsDir = join(this.dir, "runs");
    this.outDir = join(this.dir, "out");
  }

  runFile(runId) {
    if (typeof runId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(runId)) throw new Error("Invalid runId");
    return join(this.runsDir, `${runId}.json`);
  }

  save(run) {
    writeJsonAtomic(this.runFile(run.runId), run);
  }

  load(runId) {
    return readJson(this.runFile(runId));
  }

  /**
   * The outcome pointer. This is the failure notification: a monitor that only
   * ever sees "nothing arrived today" cannot tell a broken loop from a quiet
   * one, so the reason is written down even when — especially when — it failed.
   */
  saveLastRun(run) {
    const failed = run.steps.find((s) => s.status === "failed");
    const waiting = run.steps.find((s) => s.status === "waiting_human");
    writeJsonAtomic(join(this.dir, "last-run.json"), {
      runId: run.runId,
      loopId: run.loopId,
      status: run.status,
      summary: run.summary,
      reason: failed?.errorText ?? (waiting ? `waiting on a human at step "${waiting.name}"` : null),
      failedStep: failed ? { id: failed.stepId, name: failed.name, kind: failed.kind } : null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      costUsd: Number(run.costUsd ?? 0),
      exitCode: run.status === "success" ? 0 : run.status === "waiting_human" ? 2 : run.status === "cancelled" ? 130 : 1,
    });
  }

  lastRun() {
    return readJson(join(this.dir, "last-run.json"));
  }

  /** Newest first. Used by `qloops status`. */
  listRuns(limit = 20) {
    if (!existsSync(this.runsDir)) return [];
    return readdirSync(this.runsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson(join(this.runsDir, f)))
      .filter(Boolean)
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
      .slice(0, limit);
  }

  /** Write one file-sink delivery and return its path. */
  writeSink(runId, body) {
    this.runFile(runId); // validate caller-provided identity before constructing an output path
    mkdirSync(this.outDir, { recursive: true });
    const file = join(this.outDir, `${runId}.txt`);
    writeFileSync(file, body, "utf8");
    return file;
  }
}
