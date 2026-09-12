#!/usr/bin/env node
import { readFileSync } from "node:fs";
if (process.argv.includes("--version")) {
  console.log("codex-cli 0.153.4");
  process.exit(0);
}
if (process.argv.includes("status")) {
  console.error("Logged in using ChatGPT");
  process.exit(0);
}
const input = readFileSync(0, "utf8");
const model = process.argv[process.argv.indexOf("--model") + 1];
const emit = (e) => console.log(JSON.stringify(e));
if (model === "timeout") {
  setInterval(() => {}, 1000);
} else if (model === "invalid") console.log("not JSONL");
else if (model === "environment-denied") {
  console.error("Error: failed to initialize in-process app-server client: Operation not permitted (os error 1)\nsecret-do-not-expose");
  process.exitCode = 1;
}
else if (model === "auth") {
  emit({
    type: "error",
    message: "401 authentication token secret-do-not-expose",
  });
  process.exitCode = 1;
} else {
  emit({ type: "thread.started", thread_id: "fixture-thread" });
  emit({ type: "turn.started" });
  if (model === "denied")
    emit({
      type: "item.completed",
      item: { type: "command_execution", command: "forbidden" },
    });
  const { messages } = JSON.parse(input);
  const instruction = messages[0].content;
  const result =
    model === "inspect"
      ? {
          args: process.argv.slice(2),
          cwd: process.cwd(),
          env: process.env,
          input,
        }
      : instruction.includes("summary:string")
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
  const text = instruction.startsWith("Write a concise")
    ? JSON.parse(messages[1].content)
        .sources.map((s) => s.text + " " + s.url)
        .join("\n")
    : JSON.stringify(result);
  emit({ type: "item.completed", item: { type: "agent_message", text } });
  emit({
    type: "turn.completed",
    usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 2 },
  });
}
