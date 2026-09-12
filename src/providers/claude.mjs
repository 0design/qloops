import { subprocess, scopedEnvironment } from "../subprocess.mjs";
import { CoreError, insist } from "../contracts.mjs";
const metric = (x) =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
export function claudeArgs(model) {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--tools",
    "",
    "--permission-mode",
    "default",
    "--setting-sources",
    "",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--no-session-persistence",
    "--no-chrome",
    "--system-prompt",
    "You are a bounded text inference provider. Follow only the supplied messages. Return the requested JSON. No tools, external context or side effects.",
  ];
}
export async function claude(
  { executable, model, messages, cwd, runId, signal, timeoutMs = 90000 },
  { launch = subprocess } = {},
) {
  if (process.env.CLAUDECODE || Number(process.env.QLOOPS_DEPTH || 0) > 0)
    throw new CoreError(
      "UNSUPPORTED_NESTING",
      "Nesting guard active; use a caller-owned broker outside the active CLI session",
    );
  insist(
    typeof model === "string" && model.trim(),
    "Explicit Claude model required",
  );
  const env = scopedEnvironment({ QLOOPS_DEPTH: "1", QLOOPS_RUN_ID: runId });
  const probe = await launch(executable, ["--version"], {
    cwd,
    env,
    signal,
    timeoutMs: Math.min(timeoutMs, 10000),
  });
  const version = probe.stdout
    .trim()
    .match(/^(2\.1\.156) \(Claude Code\)$/)?.[1];
  if (probe.code !== 0 || !version)
    throw new CoreError(
      "UNSUPPORTED_CLI",
      "Claude CLI version has not been reviewed (supported: 2.1.156)",
    );
  const response = await launch(executable, claudeArgs(model), {
    cwd,
    env,
    signal,
    timeoutMs,
    input: JSON.stringify({ messages }),
  });
  let json;
  try {
    json = JSON.parse(response.stdout);
  } catch {
    throw new CoreError(
      response.code ? "CLI_FAILED" : "INVALID_RESPONSE",
      "Claude did not return a valid JSON result",
    );
  }
  if (response.code !== 0 || json.is_error || json.subtype !== "success") {
    const text = JSON.stringify(json);
    const code = /auth|login|credential/i.test(text)
      ? "AUTH_REQUIRED"
      : /permission|denied/i.test(text)
        ? "PERMISSION_DENIED"
        : "CLI_FAILED";
    throw new CoreError(
      code,
      "Claude invocation failed; no fallback was attempted",
    );
  }
  if (json.permission_denials?.length)
    throw new CoreError(
      "PERMISSION_DENIED",
      "Claude requested an unavailable tool",
    );
  if (typeof json.result !== "string" || !json.result.trim())
    throw new CoreError("INVALID_RESPONSE", "Claude result is empty");
  return {
    content: json.result,
    requestId: json.session_id ?? null,
    provider: {
      kind: "claude",
      version,
      requestedModel: model,
      model: Object.keys(json.modelUsage ?? {})[0] ?? null,
      payerScope: "local-cli",
      permissionMode: "default",
      tools: [],
    },
    usage: {
      tokensIn: metric(json.usage?.input_tokens),
      tokensOut: metric(json.usage?.output_tokens),
      costUsd: metric(json.total_cost_usd),
      costKind: "cli-estimate",
    },
  };
}
