#!/usr/bin/env node
if (process.argv[2] === "content") {
  const { contentCli } = await import("./content.mjs");
  await contentCli(process.argv[3]);
} else if (process.argv[2] === "agent") {
  const { agentCli } = await import("./agent.mjs");
  await agentCli(process.argv[3]);
} else if (process.argv[2] === "install") {
  try {
    const { installPinned } = await import("../src/registry-release.mjs");
    const [base, catalogSha256, id, version, destination] =
      process.argv.slice(3);
    if (!destination)
      throw new Error(
        "Usage: qloops install <registry-directory-or-URL> <catalog-sha256> <id> <version> <destination>",
      );
    console.log(
      JSON.stringify(
        await installPinned({ base, catalogSha256, id, version, destination }),
      ),
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
} else await import("./qloop.mjs");
