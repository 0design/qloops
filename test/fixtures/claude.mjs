#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("2.1.156 (Claude Code)");
  process.exit(0);
}
const input = readFileSync(0, "utf8");
const mode = existsSync("fixture-mode.txt")
  ? readFileSync("fixture-mode.txt", "utf8").trim()
  : "success";
writeFileSync(
  "fixture-invocation.json",
  JSON.stringify({
    args: process.argv.slice(2),
    input,
    cwd: process.cwd(),
    depth: process.env.QLOOPS_DEPTH,
    runId: process.env.QLOOPS_RUN_ID,
    secretLeaked: !!process.env.QLOOPS_TEST_SECRET,
  }),
);
if (mode === "timeout") {
  setInterval(() => {}, 1000);
} else if (mode === "invalid") console.log("not JSON");
else if (mode === "auth")
  console.log(
    JSON.stringify({
      subtype: "success",
      is_error: true,
      result: "OAuth authentication failed",
    }),
  );
else if (mode === "denied")
  console.log(
    JSON.stringify({
      subtype: "success",
      result: "ok",
      permission_denials: [{ tool: "Bash" }],
    }),
  );
else {
  const payload = JSON.parse(input);
  const instruction = payload.messages[0].content;
  const content = instruction.includes("summary:string")
    ? {
        summary: "Implement addition",
        criteria: ["Addition verifier passes"],
        plan: ["Edit value.mjs"],
      }
    : {
        files: [
          { path: "value.mjs", content: "export const add=(a,b)=>a+b;\n" },
        ],
      };
  console.log(
    JSON.stringify({
      subtype: "success",
      result: instruction.startsWith("Write a concise")
        ? JSON.parse(payload.messages[1].content)
            .sources.map((s) => s.text + " " + s.url)
            .join("\n")
        : JSON.stringify(content),
      modelUsage: { "fixture-model": {} },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
}
