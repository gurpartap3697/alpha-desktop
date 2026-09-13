// Dev only: a fake of the Rust commands for working on the UI in a plain browser (`npm run dev`).
// Not included in production builds (see main.tsx).
//
// Start states via the URL: ?scenario=no_key | rejected | unreachable | update | announcement | file_storage
// Message commands, like gateway/mock/mock_vllm.py: /error 429|401|404|500|context, /drop, /slow

import { mockIPC } from "@tauri-apps/api/mocks";
import type { AppError, AuthStatus, ChatPayload, ConfigStatus, ModelInfo, StreamEvent } from "../api";

const scenario = new URLSearchParams(location.search).get("scenario") ?? "";

const models: ModelInfo[] = [
  { id: "gemma", displayName: "Gemma", description: "General purpose", contextWindow: 8192, maxOutputTokens: 2048,
    temperature: 0.7, reasoning: { supported: false, defaultOn: false }, vision: false, configured: true },
  { id: "meta-llama/Llama-3.1-8B-Instruct", displayName: "meta-llama/Llama-3.1-8B-Instruct", description: null,
    contextWindow: 8192, maxOutputTokens: 2048, temperature: 0.7, reasoning: { supported: false, defaultOn: false },
    vision: false, configured: false },
  { id: "nemotron", displayName: "Nemotron", description: "Reasoning", contextWindow: 32768, maxOutputTokens: 8192,
    temperature: 0.7, reasoning: { supported: true, defaultOn: true }, vision: false, configured: true },
  { id: "qwen", displayName: "Qwen", description: "General purpose, strong at code", contextWindow: 32768,
    maxOutputTokens: 8192, temperature: 0.7, reasoning: { supported: true, defaultOn: true }, vision: false,
    configured: true },
];

let hasKey = scenario !== "no_key";
let listFailures = scenario === "unreachable" ? 1 : 0;
let rejected = scenario === "rejected";
const streams = new Map<string, { cancelled: boolean }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (kind: AppError["kind"], message: string, retry_after?: number): never => {
  throw { kind, message, retry_after } satisfies AppError;
};

const answer = (model: string, prompt: string) => `Here's a short tour of what **${model}** can render, in reply to: *${prompt.slice(0, 60)}*.

## Steps

1. Read the input and split it into lines.
2. Count each word with a dictionary:

   \`\`\`python
   from collections import Counter

   def top_words(text: str, n: int = 3) -> list[tuple[str, int]]:
       """Return the n most common words."""
       return Counter(text.lower().split()).most_common(n)
   \`\`\`

3. Print the result.

| Approach | Time | Memory |
|---|---|---|
| \`Counter\` | O(n) | O(k) |
| Sorting | O(n log n) | O(n) |

The expected count of a word with probability \\(p\\) in \\(n\\) words is:

\\[
\\mathbb{E}[X] = \\sum_{i=1}^{n} p = np
\\]

> Raw HTML such as <script>alert(1)</script> is shown as text, never run.

See [the Python docs](https://docs.python.org/3/library/collections.html) for more.`;

async function chat(requestId: string, payload: ChatPayload, emit: (ev: StreamEvent) => void) {
  const state = { cancelled: false };
  streams.set(requestId, state);
  const last = payload.messages[payload.messages.length - 1]?.content.trim() ?? "";
  const model = models.find((m) => m.id === payload.model);
  const delay = last.startsWith("/slow") ? 180 : 22;
  const tick = async (ms = delay) => {
    await sleep(ms);
    if (state.cancelled) throw "cancelled";
  };
  try {
    await tick(400);
    if (rejected || last === "/error 401") fail("unauthorized", "Authentication Error, Invalid proxy server token passed.");
    if (last === "/error 429") fail("rate_limited", "Rate limit exceeded", 7);
    if (last === "/error 404") fail("model_unavailable", `The model \`${payload.model}\` does not exist.`);
    if (last === "/error 500") fail("server", "Internal Server Error");
    if (last === "/error context")
      fail("context_length", "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.");
    if (last === "/unreachable") fail("unreachable", "error sending request: tcp connect error: Connection refused");

    if (payload.messages.length > 5) emit({ type: "trimmed", dropped: 2 });
    if (model?.reasoning.supported && payload.reasoning !== false) {
      const thought = "The user wants a demonstration. I should show a numbered list, a code block, a table and some math, then point to the docs.";
      for (const piece of thought.match(/\S+\s*/g)!) {
        emit({ type: "reasoning_delta", text: piece });
        await tick();
      }
    }
    const pieces = answer(model?.displayName ?? payload.model, last).match(/\S+\s*|\s+/g)!;
    for (const [i, piece] of pieces.entries()) {
      if (last === "/drop" && i === Math.floor(pieces.length / 2)) {
        fail("stream_dropped", "Connection closed before the response finished");
      }
      emit({ type: "content_delta", text: piece });
      await tick();
    }
    emit({ type: "usage", usage: { prompt_tokens: 120, completion_tokens: 260, total_tokens: 380 } });
    emit({ type: "done", finish_reason: "stop" });
  } catch (e) {
    emit(e === "cancelled" ? { type: "done", finish_reason: "cancelled" } : { type: "error", ...(e as AppError) });
  } finally {
    streams.delete(requestId);
  }
}

export function install() {
  mockIPC(async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "auth_status":
        return {
          hasKey,
          storage: hasKey ? (scenario === "file_storage" ? "file" : "keychain") : null,
          storageError: null,
          gatewayUrl: "https://llm.example.org",
          appVersion: "0.1.0",
        } satisfies AuthStatus;
      case "auth_set_key":
        await sleep(600);
        if (String(a.key).trim() === "bad") fail("unauthorized", "Authentication Error, Invalid proxy server token passed.");
        hasKey = true;
        rejected = false;
        return { hasKey, storage: "keychain", storageError: null, gatewayUrl: "https://llm.example.org", appVersion: "0.1.0" };
      case "auth_clear":
        hasKey = false;
        return null;
      case "get_app_config":
        await sleep(150);
        return {
          config: {
            minAppVersion: scenario === "update" ? "0.2.0" : "0.1.0",
            announcement: scenario === "announcement" ? "The Nemotron server restarts at 18:00 for maintenance." : null,
            defaults: { contextWindow: 8192, maxOutputTokens: 2048, temperature: 0.7 },
          },
          source: "remote",
          fetchError: null,
          updateRequired: scenario === "update",
        } satisfies ConfigStatus;
      case "list_models":
        await sleep(300);
        if (rejected) fail("unauthorized", "Authentication Error, Invalid proxy server token passed.");
        if (listFailures-- > 0) fail("unreachable", "error sending request for url (https://llm.example.org/v1/models): tcp connect error: Connection timed out");
        return models;
      case "chat_stream": {
        const channel = a.onEvent as { onmessage: (ev: StreamEvent) => void };
        await chat(String(a.requestId), a.payload as ChatPayload, (ev) => channel.onmessage(ev));
        return null;
      }
      case "chat_cancel": {
        const s = streams.get(String(a.requestId));
        if (s) s.cancelled = true;
        return null;
      }
      case "plugin:opener|open_url":
        window.open(String(a.url), "_blank", "noopener");
        return null;
      default:
        throw new Error(`mock backend: unknown command ${cmd}`);
    }
  });
}
