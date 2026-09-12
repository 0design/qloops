import { spawn } from "node:child_process";
import { CoreError, insist } from "./contracts.mjs";
export function scopedEnvironment(extra = {}) {
  const env = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "CLAUDECODE",
    "CLAUDE_CODE_ENTRYPOINT",
    "QLOOPS_DEPTH",
    "QLOOPS_RUN_ID",
  ])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra };
}
export function subprocess(
  command,
  args,
  {
    cwd,
    env = scopedEnvironment(),
    input = "",
    signal,
    timeoutMs = 90000,
    maxBytes = 512000,
  } = {},
) {
  insist(
    typeof command === "string" &&
      Array.isArray(args) &&
      args.every((x) => typeof x === "string"),
    "Invalid executable/argv",
  );
  insist(Buffer.byteLength(input) <= 128000, "Input exceeds 128000 bytes");
  insist(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000,
    "Invalid subprocess timeout",
  );
  if (signal?.aborted)
    return Promise.reject(new CoreError("CANCELLED", "Subprocess cancelled"));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = [],
      err = [],
      bytes = 0,
      failure,
      killTimer;
    const kill = (sig) => {
      try {
        if (process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {}
    };
    const stop = (code, message) => {
      if (failure) return;
      failure = new CoreError(code, message);
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 300);
    };
    const abort = () => stop("CANCELLED", "Subprocess cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => stop("TIMEOUT", "Subprocess deadline exceeded"),
      timeoutMs,
    );
    const capture = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes)
        stop("OUTPUT_LIMIT", "Subprocess output exceeds limit");
      else target.push(chunk);
    };
    child.stdout.on("data", capture(out));
    child.stderr.on("data", capture(err));
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      failure = new CoreError(
        e.code === "ENOENT" ? "MISSING_EXECUTABLE" : "PROCESS_ERROR",
        "Unable to start configured executable",
      );
    });
    child.on("close", (code, sig) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", abort);
      // Kill any descendants that inherited no pipes but outlived the direct child.
      kill("SIGKILL");
      if (failure) reject(failure);
      else
        resolve({
          code,
          signal: sig,
          stdout: Buffer.concat(out).toString("utf8"),
          stderr: Buffer.concat(err).toString("utf8"),
        });
    });
    child.stdin.end(input);
  });
}
