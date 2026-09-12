import { readFileSync, statSync } from "node:fs";
import { runAgent } from "../src/agent.mjs";
import { EXIT_CODES, resultEnvelope } from "../src/contracts.mjs";
export async function agentCli(file) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    let input;
    if (file === "-") {
      const chunks = [];
      let size = 0;
      for await (const chunk of process.stdin) {
        size += chunk.length;
        if (size > 128000) throw new Error("Request exceeds 128000 bytes");
        chunks.push(chunk);
      }
      input = Buffer.concat(chunks).toString("utf8");
    } else {
      if (!file || statSync(file).size > 128000)
        throw new Error("Request file required, max 128000 bytes");
      input = readFileSync(file, "utf8");
    }
    const result = await runAgent(JSON.parse(input), {
      signal: controller.signal,
    });
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exitCode =
      result.error?.code === "INVALID_REQUEST" ? 64 : EXIT_CODES[result.status];
  } catch {
    process.stdout.write(
      JSON.stringify(
        resultEnvelope(null, {
          summary: "Invalid request JSON or file",
          error: {
            code: "INVALID_REQUEST",
            message: "Invalid request JSON or file",
          },
        }),
      ) + "\n",
    );
    process.exitCode = 64;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
