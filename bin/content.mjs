import { readFileSync, statSync } from "node:fs";
import { runContentRequest } from "../src/content-runner.mjs";
import { EXIT_CODES } from "../src/contracts.mjs";
export async function contentCli(file) {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    if (!file || statSync(file).size > 128000)
      throw Error("Request file required (max 128000 bytes)");
    const result = await runContentRequest(
      JSON.parse(readFileSync(file, "utf8")),
      { signal: abort.signal },
    );
    console.log(JSON.stringify(result));
    process.exitCode = EXIT_CODES[result.status];
  } catch (e) {
    console.error(e.message);
    process.exitCode = 64;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
