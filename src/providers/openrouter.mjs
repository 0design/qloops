import { fetchWithRetry } from "../http.mjs";
import { CoreError, insist } from "../contracts.mjs";
const metric = (n) =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : null;
export async function openRouter(
  {
    messages,
    model,
    keyRef = "OPENROUTER_API_KEY",
    payerScope,
    maxTokens,
    temperature = 0.3,
    timeoutMs = 90000,
    retries = 2,
    delaysMs,
    signal,
  },
  { env = process.env, fetcher = fetchWithRetry } = {},
) {
  insist(
    Number.isInteger(retries) && retries >= 0 && retries <= 10,
    "retries must be 0..10",
  );
  insist(
    Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2147483647,
    "Invalid timeout",
  );
  if (delaysMs !== undefined)
    insist(
      Array.isArray(delaysMs) &&
        delaysMs.length > 0 &&
        delaysMs.every((x) => Number.isInteger(x) && x >= 0 && x <= 2147483647),
      "Invalid backoff delays",
    );
  insist(
    ["local-byok", "site-funded"].includes(payerScope),
    "Explicit payerScope required",
  );
  insist(typeof model === "string" && model.trim(), "model required");
  insist(
    Array.isArray(messages) &&
      messages.length > 0 &&
      messages.every(
        (m) =>
          ["system", "user", "assistant"].includes(m.role) &&
          typeof m.content === "string",
      ),
    "Invalid messages",
  );
  insist(JSON.stringify(messages).length <= 128000, "Messages too large");
  insist(
    Number.isInteger(maxTokens) && maxTokens > 0 && maxTokens <= 32000,
    "maxTokens must be 1..32000",
  );
  insist(
    Number.isFinite(temperature) && temperature >= 0 && temperature <= 2,
    "Invalid temperature",
  );
  insist(/^[A-Z_][A-Z0-9_]*$/.test(keyRef), "Invalid keyRef");
  const key = env[keyRef];
  if (!key)
    throw new CoreError("AUTH_REQUIRED", `Missing secret reference ${keyRef}`);
  let res;
  try {
    res = await fetcher(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: maxTokens,
        }),
      },
      { timeoutMs, retries, delaysMs },
    );
  } catch (e) {
    if (signal?.aborted)
      throw new CoreError("CANCELLED", "OpenRouter cancelled");
    throw new CoreError(
      e.name === "TimeoutError" ? "TIMEOUT" : "NETWORK",
      "OpenRouter unreachable",
    );
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    const code = [401, 403].includes(res.status)
      ? "AUTH_REQUIRED"
      : res.status === 429
        ? "RATE_LIMITED"
        : "PROVIDER_ERROR";
    throw new CoreError(
      code,
      `OpenRouter ${res.status} — ${code === "AUTH_REQUIRED" ? "invalid or revoked key" : "request failed"}`,
    );
  }
  let json;
  try {
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      let size = 0;
      const parts = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 512000) {
          await reader.cancel();
          throw new Error("limit");
        }
        parts.push(Buffer.from(value));
      }
      json = JSON.parse(Buffer.concat(parts).toString("utf8"));
    } else json = await res.json();
  } catch {
    throw new CoreError(
      signal?.aborted ? "CANCELLED" : "INVALID_RESPONSE",
      "OpenRouter response body invalid, timed out or too large",
    );
  }
  const content = json?.choices?.[0]?.message?.content;
  if (json.error || typeof content !== "string" || !content.trim())
    throw new CoreError(
      "INVALID_RESPONSE",
      "OpenRouter returned an empty completion or invalid response",
    );
  if (json.choices[0].finish_reason === "length")
    throw new CoreError("OUTPUT_LIMIT", "OpenRouter completion truncated");
  return {
    content: content.trim(),
    requestId: typeof json.id === "string" ? json.id : null,
    provider: {
      kind: "openrouter",
      version: "1",
      requestedModel: model,
      model: json.model ?? null,
      payerScope,
    },
    usage: {
      tokensIn: metric(json.usage?.prompt_tokens),
      tokensOut: metric(json.usage?.completion_tokens),
      costUsd: metric(json.usage?.cost),
    },
  };
}
