import {
  lstatSync,
  existsSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  openSync,
  closeSync,
  unlinkSync,
} from "node:fs";
import { resolve, dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { hash, CoreError, insist } from "./contracts.mjs";
export function scopedPath(workspace, path) {
  const root = realpathSync(workspace),
    target = resolve(root, path);
  insist(
    target.startsWith(root + "/") &&
      !relative(root, target)
        .split("/")
        .some((p) => p.startsWith(".")),
    "Path outside allowed scope",
    "SCOPE_DENIED",
  );
  let part = root;
  for (const p of relative(root, target).split("/")) {
    part = join(part, p);
    if (
      existsSync(part) ||
      (() => {
        try {
          return lstatSync(part).isSymbolicLink();
        } catch {
          return false;
        }
      })()
    )
      insist(
        !lstatSync(part).isSymbolicLink(),
        "Symlinks are not allowed",
        "SCOPE_DENIED",
      );
  }
  return target;
}
export function snapshot(workspace, paths) {
  return Object.fromEntries(
    paths.map((p) => {
      const file = scopedPath(workspace, p);
      if (existsSync(file))
        insist(
          lstatSync(file).isFile() && lstatSync(file).size <= 128000,
          "Scoped input must be a file <=128000 bytes",
          "SCOPE_DENIED",
        );
      return [p, existsSync(file) ? hash(readFileSync(file, "utf8")) : null];
    }),
  );
}
export function contextFiles(workspace, paths) {
  snapshot(workspace, paths);
  const files = paths.map((path) => ({
    path,
    content: existsSync(scopedPath(workspace, path))
      ? readFileSync(scopedPath(workspace, path), "utf8")
      : null,
  }));
  insist(
    JSON.stringify(files).length < 60000,
    "Workspace context exceeds limit",
  );
  return files;
}
export function applyFiles(workspace, allowedPaths, files, before) {
  insist(
    Array.isArray(files) &&
      files.length > 0 &&
      files.length <= allowedPaths.length,
    "Invalid file proposal",
    "INVALID_RESPONSE",
  );
  insist(
    new Set(files.map((f) => f.path)).size === files.length,
    "Duplicate file proposal",
    "INVALID_RESPONSE",
  );
  for (const f of files) {
    insist(
      allowedPaths.includes(f.path) &&
        typeof f.content === "string" &&
        Buffer.byteLength(f.content) <= 128000,
      "Proposal escapes scope or size limit",
      "SCOPE_DENIED",
    );
    scopedPath(workspace, f.path);
  }
  insist(
    hash(snapshot(workspace, allowedPaths)) === hash(before),
    "Workspace changed since snapshot; reconcile first",
    "WORKSPACE_CHANGED",
  );
  for (const f of files) {
    const file = scopedPath(workspace, f.path);
    mkdirSync(dirname(file), { recursive: true });
    scopedPath(workspace, f.path);
    const tmp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, f.content, { flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  }
  return snapshot(workspace, allowedPaths);
}
export function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(tmp, file);
}
export function lockWorkspace(workspace) {
  const dir = join(realpathSync(workspace), ".qf");
  if (existsSync(dir))
    insist(
      !lstatSync(dir).isSymbolicLink() && lstatSync(dir).isDirectory(),
      "Unsafe state directory",
      "SCOPE_DENIED",
    );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, "agent.lock");
  let fd;
  try {
    fd = openSync(lock, "wx", 0o600);
  } catch {
    throw new CoreError(
      "WORKSPACE_LOCKED",
      "Workspace already locked; inspect interrupted run before removing stale lock",
    );
  }
  writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  return {
    dir,
    release() {
      closeSync(fd);
      unlinkSync(lock);
    },
  };
}
