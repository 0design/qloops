#!/usr/bin/env node
/** Run each loop against controlled source and receiver scenarios.
 * Start test/fixture-server.mjs first. Each row reports expected and actual results.
 * Environment overrides change the fixture, not the loop manifest.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "..");
const QL = join(PKG, "bin", "qloop.mjs");
const F = `http://127.0.0.1:${process.env.FIXTURE_PORT ?? 19900}`;
const KEY = process.env.OPENROUTER_API_KEY ?? "";

/** Expectations are defined before execution. */
const SCENARIOS = [
  { id: "happy",       label: "healthy",              env: { QLOOP_SOURCE_URL: `${F}/feed/ok`,        QLOOP_WEBHOOK_URL: `${F}/sink` }, expect: "success" },
  { id: "src-500",     label: "source returns 500",       env: { QLOOP_SOURCE_URL: `${F}/status/500`,     QLOOP_WEBHOOK_URL: `${F}/sink` }, expect: "failed" },
  { id: "src-empty",   label: "empty feed",      env: { QLOOP_SOURCE_URL: `${F}/feed/empty`,     QLOOP_WEBHOOK_URL: `${F}/sink` }, expect: "failed" },
  { id: "src-garbage", label: "HTML instead of RSS",         env: { QLOOP_SOURCE_URL: `${F}/feed/malformed`, QLOOP_WEBHOOK_URL: `${F}/sink` }, expect: "failed" },
  { id: "sink-500",    label: "receiver rejects",        env: { QLOOP_SOURCE_URL: `${F}/feed/ok`,        QLOOP_WEBHOOK_URL: `${F}/sink/reject` }, expect: "failed" },
  { id: "no-key",      label: "missing model key",       env: { QLOOP_SOURCE_URL: `${F}/feed/ok`,        QLOOP_WEBHOOK_URL: `${F}/sink` }, noKey: true, expect: "depends" },
  { id: "dry",         label: "--dry-run",                env: { QLOOP_SOURCE_URL: `${F}/feed/ok`,        QLOOP_WEBHOOK_URL: `${F}/sink` }, dry: true, expect: "success" },
];

/** Source formats that differ from the default scenario. */
const SOURCE_OVERRIDE = {
  "price-watch":   { happy: `${F}/json/ok`, "src-empty": `${F}/json/notjson`, "src-garbage": `${F}/json/notjson`, "sink-500": `${F}/json/ok`, "no-key": `${F}/json/ok`, dry: `${F}/json/ok` },
  "strict-gate":   { happy: `${F}/json/ok`, "src-empty": `${F}/json/notjson`, "src-garbage": `${F}/json/notjson`, "sink-500": `${F}/json/ok`, "no-key": `${F}/json/ok`, dry: `${F}/json/ok` },
  "webhook-relay": { happy: `${F}/json/ok`, "src-empty": `${F}/json/notjson`, "src-garbage": `${F}/json/notjson`, "sink-500": `${F}/json/ok`, "no-key": `${F}/json/ok`, dry: `${F}/json/ok` },
  "content-factory": { happy: `${F}/material`, "src-empty": `${F}/json/notjson`, "src-garbage": `${F}/json/notjson`, "sink-500": `${F}/material`, "no-key": `${F}/material`, dry: `${F}/material` },
  "release-watch": { happy: `${F}/feed/ok`, "sink-500": `${F}/feed/ok`, "no-key": `${F}/feed/ok`, dry: `${F}/feed/ok` },
  "brand-mentions": { happy: `${F}/feed/ok`, "sink-500": `${F}/feed/ok`, "no-key": `${F}/feed/ok`, dry: `${F}/feed/ok` },
  "content-feed":  { happy: `${F}/feed/ok`, "sink-500": `${F}/feed/ok`, "no-key": `${F}/feed/ok`, dry: `${F}/feed/ok` },
  "feed-fanout":   { happy: `${F}/feed/ok`, "sink-500": `${F}/feed/ok`, "no-key": `${F}/feed/ok`, dry: `${F}/feed/ok` },
  "wide-fanout":   { happy: `${F}/feed/huge`, "sink-500": `${F}/feed/huge`, "no-key": `${F}/feed/huge`, dry: `${F}/feed/huge` },
};

const loops = readdirSync(join(PKG, "registry", "loops")).filter((f) => f.endsWith(".yaml")).sort();

async function reset() { await fetch(`${F}/_reset`, { method: "POST" }).catch(() => {}); }
async function receivedCount() {
  /* Count accepted requests only; a rejected attempt is not successful delivery. */
  try {
    const all = await (await fetch(`${F}/_received`)).json();
    return all.filter((r) => r.path === "/sink").length;
  } catch { return -1; }
}

function runOne(loopFile, sc) {
  const id = loopFile.replace(/\.yaml$/, "");
  const env = { ...process.env, ...sc.env, QF_NO_UPDATE_CHECK: "1" };
  if (SOURCE_OVERRIDE[id]?.[sc.id]) env.QLOOP_SOURCE_URL = SOURCE_OVERRIDE[id][sc.id];
  /* Remove Telegram credentials so fixture runs cannot send to a real channel. */
  env.TELEGRAM_BOT_TOKEN = ""; env.TELEGRAM_CHAT_ID = "";
  env.OPENROUTER_API_KEY = sc.noKey ? "" : KEY;
  if (!env.OPENROUTER_API_KEY) delete env.OPENROUTER_API_KEY;

  const args = ["run", join(PKG, "registry", "loops", loopFile), "--json", "--quiet"];
  if (sc.dry) args.push("--dry-run");
  const r = spawnSync("node", [QL, ...args], { env, encoding: "utf8", timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });

  let run = null;
  try { run = JSON.parse(r.stdout.trim()); } catch {}
  return {
    exit: r.status,
    status: run?.status ?? "(no json)",
    summary: (run?.summary ?? r.stderr.trim().split("\n")[0] ?? "").slice(0, 150),
    cost: run?.costUsd ?? 0,
    steps: run?.steps?.length ?? 0,
    done: run?.steps?.filter((s) => s.status === "success" || s.status === "planned").length ?? 0,
  };
}

/* Execute scenarios. */

console.log(`# Loop run matrix\n`);
console.log(`> Fixture: \`test/fixture-server.mjs\` at ${F}. Manifests are unchanged;`);
console.log(`> the scenario changes only environment variables, so failures`);
console.log(`> are handled by the original loop.\n`);
console.log(`Loops: **${loops.length}** · scenarios: **${SCENARIOS.length}** · runs: **${loops.length * SCENARIOS.length}**\n`);

const rows = [];
for (const f of loops) {
  const id = f.replace(/\.yaml$/, "");
  console.log(`\n## ${id}\n`);
  console.log(`| scenario | expected | exit | status | steps | $ | run summary |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (const sc of SCENARIOS) {
    await reset();
    const before = await receivedCount();
    const out = runOne(f, sc);
    const after = await receivedCount();
    const delivered = after - before;
    rows.push({ loop: id, sc: sc.id, ...out, delivered });
    console.log(
      `| ${sc.label} | ${sc.expect} | \`${out.exit}\` | **${out.status}** | ${out.done}/${out.steps} | ${out.cost ? "$" + Number(out.cost).toFixed(4) : "—"} | ${out.summary.replace(/\|/g, "\\|")} |`,
    );
  }
}

/* Summarize results. */
console.log(`\n---\n\n## Summary\n`);
const byStatus = {};
for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
console.log(`Runs: **${rows.length}**\n`);
console.log(`| status | count |`);
console.log(`|---|---|`);
for (const [k, v] of Object.entries(byStatus).sort((a, b) => b[1] - a[1])) console.log(`| ${k} | ${v} |`);

const spend = rows.reduce((a, r) => a + Number(r.cost || 0), 0);
console.log(`\nTotal reported cost: **$${spend.toFixed(4)}**\n`);

/* Failed runs must not deliver downstream actions. */
const leaked = rows.filter((r) => r.status !== "success" && r.delivered > 0);
console.log(`\n### Did an incomplete run deliver anything\n`);
console.log(leaked.length
  ? leaked.map((r) => `- ⚠️ **${r.loop} / ${r.sc}** — status \`${r.status}\`, receiver accepted ${r.delivered}`).join("\n")
  : `None. ${rows.filter((r) => r.status !== "success").length} unsuccessful runs; zero accepted requests.`);
