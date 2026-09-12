/**
 * Update channel — the same shape as A2D's, so the two tools do not behave
 * differently for no reason.
 *
 * THE RULES, all of them:
 *   • CLI ONLY. Nothing here runs during `qloops run`'s work; a loop must never
 *     become slower or less reliable because a version check was in the way.
 *   • A plain GET of a STATIC JSON file. No identifiers of any kind — no machine
 *     id, no version query string, no telemetry. The request says nothing about
 *     who is asking.
 *   • Cached 24 hours. Timeout 2 seconds.
 *   • EVERY error is silent. Offline, DNS gone, 500, garbage body — the command
 *     carries on as if the check had never happened.
 *   • QF_NO_UPDATE_CHECK=1 switches it off entirely.
 *
 * THE ENDPOINT IS NOT SET, ON PURPOSE. There is no public home for this package
 * yet, so there is no URL to point at, and inventing one would mean shipping a
 * command that quietly calls a host nobody chose. It reads `QF_UPDATE_URL`; with
 * nothing there, the check is a no-op. Where that file will live is the owner's
 * call — see tasks-for-oleg/2026-08-02-qf.md.
 *
 * The notice below has room for a "what's new" line carried in the JSON. It has
 * NO text about accounts, sign-in or licences: none of that has been decided,
 * and a CLI is a bad place to learn about it from a message somebody guessed at.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 2000;

function cacheFile() {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "qloop", "update.json");
}

function readCache() {
  try {
    const c = JSON.parse(readFileSync(cacheFile(), "utf8"));
    return typeof c?.checkedAt === "number" ? c : null;
  } catch {
    return null;
  }
}

function writeCache(value) {
  try {
    const f = cacheFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, JSON.stringify(value), "utf8");
  } catch {
    /* A cache we cannot write is a cache we do without. */
  }
}

/** Compare dotted versions. Returns true when `remote` is ahead of `local`. */
export function isNewer(remote, local) {
  const parse = (v) => String(v).split(/[.-]/).map((n) => (Number.isFinite(Number(n)) ? Number(n) : 0));
  const a = parse(remote);
  const b = parse(local);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * @returns {Promise<{version:string, notes?:string}|null>} the newer release, or
 *          null — which is what "no endpoint", "cached and up to date", "offline"
 *          and "anything went wrong" all look like from the outside.
 */
export async function checkForUpdate(localVersion) {
  if (process.env.QF_NO_UPDATE_CHECK === "1") return null;
  const url = process.env.QF_UPDATE_URL;
  if (!url) return null;

  const cached = readCache();
  if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
    return cached.version && isNewer(cached.version, localVersion)
      ? { version: cached.version, notes: cached.notes }
      : null;
  }

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = await res.json();
    const version = typeof body?.version === "string" ? body.version : null;
    const notes = typeof body?.notes === "string" ? body.notes : undefined;
    writeCache({ checkedAt: Date.now(), version, notes });
    return version && isNewer(version, localVersion) ? { version, notes } : null;
  } catch {
    /* Silent by design — see the header. Cache the attempt so a machine with no
       network does not retry on every single command. */
    writeCache({ checkedAt: Date.now(), version: null });
    return null;
  }
}

/** The one line the CLI prints, or "" when there is nothing to say. */
export function updateNotice(update) {
  if (!update) return "";
  return `\n  qloop ${update.version} is available.${update.notes ? ` ${update.notes}` : ""}\n`;
}
