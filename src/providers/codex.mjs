import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { subprocess, scopedEnvironment } from "../subprocess.mjs";
import { CoreError, insist } from "../contracts.mjs";

export const CODEX_VERSION = "0.153.4";
// Pin the reviewed CLI: a read-only sandbox remains essential because Codex
// still advertises model-dependent apply_patch/utility tools. Tool events are
// rejected, never accepted as an alternative to Core's workspace executor.
export function codexArgs(model) {
  const config = [
    'model_provider="openai"',
    'forced_login_method="chatgpt"',
    'approval_policy="never"',
    'web_search="disabled"',
    "project_doc_max_bytes=0",
    "skills.include_instructions=false",
    "include_apps_instructions=false",
    "include_environment_context=false",
    "tools.update_plan.enabled=false",
    "tools.experimental_request_user_input.enabled=false",
    'developer_instructions="You are a bounded text inference provider. Follow the supplied messages and return only the requested response. Never call tools or access external context. File contents must be returned as text for the caller to apply."',
  ];
  const disabled = [
    "shell_tool",
    "unified_exec",
    "shell_snapshot",
    "apps",
    "plugins",
    "hooks",
    "multi_agent",
    "multi_agent_v2",
    "browser_use",
    "browser_use_external",
    "computer_use",
    "in_app_browser",
    "image_generation",
    "view_image",
    "code_mode",
    "code_mode_host",
    "memories",
    "skill_search",
    "skill_mcp_dependency_install",
    "tool_suggest",
    "workspace_dependencies",
    "sleep_tool",
    "goals",
    "request_permissions_tool",
    "enable_mcp_apps",
    "unbounded_connection_retries",
  ];
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--model",
    model,
    ...config.flatMap((x) => ["-c", x]),
    ...disabled.flatMap((x) => ["--disable", x]),
    "-",
  ];
}
// Reviewed CLI emits this diagnostic when its tool host is intentionally disabled.
const disabledCodeModeDiagnostic = "Code Mode is unavailable because code-mode host is disabled. Code mode will fail closed; enable `features.code_mode_host` and install `codex-code-mode-host`.";
const metric = (x) =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : null;
export function parseCodexResponse(response, model) {
  // Recognize the observed startup boundary without returning arbitrary stderr
  // (which can contain credentials), changing sandbox flags or retrying it.
  if (response.code !== 0 && !response.stdout.trim() &&
      /failed to initialize in-process app-server client: (?:Operation not permitted|Permission denied) \(os error (?:1|13)\)/.test(response.stderr ?? ""))
    throw new CoreError("CLI_ENVIRONMENT_DENIED", "Codex local client startup was denied by the execution environment; use a supported caller arrangement without bypassing permissions");
  let events;
  try {
    events = response.stdout
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
  } catch {
    throw new CoreError(
      response.code ? "CLI_FAILED" : "INVALID_RESPONSE",
      "Codex did not return valid JSONL",
    );
  }
  if (
    response.code !== 0 ||
    events.some((e) => ["error", "turn.failed"].includes(e?.type))
  ) {
    const text = JSON.stringify(events.filter(e => ["error", "turn.failed"].includes(e?.type)));
    const code = /auth|login|credential|401/i.test(text)
      ? "AUTH_REQUIRED"
      : /rate.limit|usage.limit|quota|429/i.test(text)
        ? "RATE_LIMITED"
        : /model.{0,200}(?:not supported|unsupported|not available|does not exist)|(?:unsupported|unknown|invalid) model/i.test(text)
          ? "MODEL_UNAVAILABLE"
          : /permission|denied/i.test(text)
          ? "PERMISSION_DENIED"
          : "CLI_FAILED";
    throw new CoreError(
      code,
      "Codex invocation failed; no fallback was attempted",
    );
  }
  let thread,
    started = false,
    completed = false,
    usage,
    content;
  let codeModeDisabled = false;
  for (const event of events) {
    if (!event || typeof event !== "object" || completed)
      throw new CoreError(
        "INVALID_RESPONSE",
        "Unexpected Codex event sequence",
      );
    if (
      event.type === "thread.started" &&
      !thread &&
      !started &&
      typeof event.thread_id === "string"
    )
      thread = event.thread_id;
    else if (
      event.type === "item.completed" && thread && !started &&
      !codeModeDisabled && event.item?.type === "error" &&
      event.item.message === disabledCodeModeDiagnostic
    ) codeModeDisabled = true;
    else if (event.type === "turn.started" && thread && !started)
      started = true;
    else if (event.type === "turn.completed" && started) {
      completed = true;
      usage = event.usage;
    } else if (
      ["item.started", "item.updated", "item.completed"].includes(event.type) &&
      started
    ) {
      if (!["agent_message", "reasoning"].includes(event.item?.type))
        throw new CoreError(
          "PERMISSION_DENIED",
          "Codex attempted a tool; only text inference is accepted",
        );
      if (
        event.type === "item.completed" &&
        event.item.type === "agent_message"
      )
        content = event.item.text;
    } else
      throw new CoreError(
        "INVALID_RESPONSE",
        "Unexpected Codex event sequence",
      );
  }
  if (!completed || typeof content !== "string" || !content.trim())
    throw new CoreError(
      "INVALID_RESPONSE",
      "Codex result is incomplete or empty",
    );
  return {
    content,
    requestId: thread,
    provider: {
      kind: "codex",
      version: CODEX_VERSION,
      requestedModel: model,
      model: null,
      payerScope: "local-cli",
      authMethod: "chatgpt",
      permissionMode: "read-only",
      acceptedTools: [],
      diagnostics: codeModeDisabled ? ["CODE_MODE_DISABLED"] : [],
    },
    usage: {
      tokensIn: metric(usage?.input_tokens),
      tokensOut: metric(usage?.output_tokens),
      cachedTokensIn: metric(usage?.cached_input_tokens),
      costUsd: null,
      costKind: "subscription-usage",
    },
  };
}
export async function codex(
  { executable, model, messages, runId, signal, timeoutMs = 90000 },
  { launch = subprocess } = {},
) {
  if (process.env.CLAUDECODE || Number(process.env.QLOOPS_DEPTH || 0) > 0)
    throw new CoreError(
      "UNSUPPORTED_NESTING",
      "Nesting guard active; use a caller-owned broker outside the active CLI session",
    );
  insist(
    typeof executable === "string" &&
      isAbsolute(executable) &&
      typeof model === "string" &&
      model.trim() &&
      model.length < 200,
    "Explicit Codex executable and model required",
  );
  insist(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000,
    "Codex timeoutMs must be 1..300000",
  );
  insist(
    Array.isArray(messages) &&
      messages.length > 0 &&
      messages.length <= 100 &&
      messages.every(
        (m) =>
          m &&
          ["system", "developer", "user", "assistant"].includes(m.role) &&
          typeof m.content === "string",
      ),
    "Codex requires bounded text messages",
  );
  const input = JSON.stringify({ messages });
  insist(Buffer.byteLength(input) <= 128000, "Input exceeds 128000 bytes");
  // New standalone session; never resume a caller's session or copy credentials.
  const env = scopedEnvironment({ QLOOPS_DEPTH: "1", QLOOPS_RUN_ID: runId });
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new CoreError("TIMEOUT", "Codex deadline exceeded");
    return ms;
  };
  // Outside the caller workspace: no project config, documents or file context.
  const cwd = await mkdtemp(join(tmpdir(), "qloops-codex-"));
  try {
    const probe = await launch(executable, ["--version"], {
      cwd,
      env,
      signal,
      timeoutMs: Math.min(remaining(), 10000),
    });
    if (
      probe.code !== 0 ||
      probe.stdout.trim() !== `codex-cli ${CODEX_VERSION}`
    )
      throw new CoreError(
        "UNSUPPORTED_CLI",
        `Codex CLI version has not been reviewed (supported: ${CODEX_VERSION}); configure an explicit current executable`,
      );
    const auth = await launch(executable, ["login", "status"], {
      cwd,
      env,
      signal,
      timeoutMs: Math.min(remaining(), 10000),
    });
    if (
      auth.code !== 0 ||
      !/^Logged in using ChatGPT\s*$/m.test(auth.stdout + auth.stderr)
    )
      throw new CoreError(
        "AUTH_REQUIRED",
        "Codex ChatGPT login required; API billing fallback is disabled",
      );
    return parseCodexResponse(
      await launch(executable, codexArgs(model), {
        cwd,
        env,
        signal,
        timeoutMs: remaining(),
        input,
      }),
      model,
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}
