// Dev only: a fake of the Rust commands for working on the UI in a plain browser (`npm run dev`).
// Not included in production builds (see main.tsx).
//
// Start states via the URL: ?scenario=no_key | rejected | unreachable | update | announcement | file_storage
//   | history_broken | fresh (empty history, default settings)
//   Updates: update (this version is too old; 0.2.0 is published), update_unpublished (too old, nothing
//   published), update_available (0.2.0 downloads in the background), update_broken (the download fails).
//   "Installing" reloads the page as version 0.2.0.
// Message commands, like gateway/mock/mock_vllm.py: /error 429|401|404|500|context, /drop, /slow
// History lives in localStorage, so a reload behaves like restarting the app (including interrupted answers).

import { mockIPC } from "@tauri-apps/api/mocks";
import { defaultAppSettings } from "../api";
import type {
  AppError,
  DownloadEvent,
  AppSettings,
  AuthStatus,
  ConfigStatus,
  Conversation,
  ConversationSummary,
  Message,
  ModelInfo,
  StreamEvent,
  TurnRequest,
  UpdateInfo,
} from "../api";

const scenario = new URLSearchParams(location.search).get("scenario") ?? "";

// ---- Updates (src-tauri/src/updates.rs) ----

const INSTALLED_KEY = "alpha-mock-installed-version";
const installed = sessionStorage.getItem(INSTALLED_KEY);
const appVersion = installed ?? "0.1.0";
const published = ["update", "update_available", "update_broken"].includes(scenario) ? "0.2.0" : null;
const updateRequired = !installed && (scenario === "update" || scenario === "update_unpublished");
let downloaded = false;

function checkUpdate(): UpdateInfo {
  const base = { currentVersion: appVersion, version: null, notes: null, downloaded: false, reason: null };
  if (!published || published === appVersion) {
    return { ...base, status: "up_to_date", reason: published ? null : "No update has been published" };
  }
  return { ...base, status: "available", version: published, notes: "Faster startup and fixes for long chats.", downloaded };
}

async function downloadUpdate(emit: (ev: DownloadEvent) => void) {
  const total = 14_200_000;
  for (let i = 1; i <= 10; i++) {
    await sleep(120);
    if (scenario === "update_broken" && i === 6) fail("unreachable", "Download request failed: connection reset");
    emit({ type: "progress", downloaded: (total * i) / 10, total });
  }
  downloaded = true;
  emit({ type: "finished" });
}

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
const streams = new Map<string, { cancelled: boolean; conversationId: string }>();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (kind: AppError["kind"], message: string, retry_after?: number): never => {
  throw { kind, message, retry_after } satisfies AppError;
};

const answer_text = (model: string, prompt: string) => `Here's a short tour of what **${model}** can render, in reply to: *${prompt.slice(0, 60)}*.

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

// ---- History (a small stand-in for src-tauri/src/db.rs) ----

const HISTORY_KEY = "alpha-mock-history";
type Stored = Omit<Conversation, "messages"> & { messages: Message[] };
let history: Record<string, Stored> = {};

function loadHistory() {
  if (scenario === "fresh") localStorage.removeItem(HISTORY_KEY);
  const saved = localStorage.getItem(HISTORY_KEY);
  try {
    history = JSON.parse(saved ?? "{}");
  } catch {
    history = {};
  }
  // Seeded on first run only, so deleting everything sticks.
  if (saved === null && scenario !== "fresh") seedHistory();
  // Like startup recovery: answers still streaming when the page closed were interrupted.
  for (const c of Object.values(history))
    for (const m of c.messages)
      if (m.status === "streaming")
        Object.assign(m, {
          status: m.content ? "stopped" : "error",
          error: { kind: "interrupted", message: "Alpha was closed before the answer finished" },
          endedAt: Date.now(),
        });
  saveHistory();
}

const saveHistory = () => localStorage.setItem(HISTORY_KEY, JSON.stringify(history));

function seedHistory() {
  const day = 86_400_000;
  const make = (title: string, ago: number, q: string, a: string, modelId = "qwen") => {
    const id = crypto.randomUUID();
    const t = Date.now() - ago;
    const msg = (seq: number, role: Message["role"], content: string): Message => ({
      id: crypto.randomUUID(), conversationId: id, seq, role, content, reasoning: null,
      modelId: role === "assistant" ? modelId : null, status: "complete", error: null, finishReason: "stop",
      promptTokens: null, completionTokens: null, dropped: null, reasoningMs: null, createdAt: t, endedAt: t,
    });
    history[id] = {
      id, title, titleStatus: "generated", modelId, systemPrompt: null,
      params: { temperature: null, maxTokens: null, reasoning: null }, createdAt: t, updatedAt: t,
      messages: [msg(0, "user", q), msg(1, "assistant", a)],
    };
  };
  make("Docker container reaching host", 2 * 3600_000, "How does a container reach a service on my Mac?",
    "Use `host.docker.internal` instead of `localhost`; inside a container, localhost is the container itself.");
  make("Rust lifetimes in structs", day + 3600_000, "When does a struct need a lifetime parameter?",
    "When it holds a reference: `struct Parser<'a> { input: &'a str }`.", "gemma");
  make("Quarterly report summary", 4 * day, "Summarize the attached quarterly numbers.",
    "Revenue grew 12% quarter over quarter, driven by the new region.");
  make("SQL window functions", 45 * day, "Explain ROW_NUMBER vs RANK.",
    "`ROW_NUMBER` always increments; `RANK` gives ties the same number and skips the next ones.");
}

const summaryOf = (c: Stored, snippet?: string): ConversationSummary => ({
  id: c.id, title: c.title, modelId: c.modelId, createdAt: c.createdAt, updatedAt: c.updatedAt,
  ...(snippet ? { snippet } : {}),
});

const getStored = (id: string) => history[id] ?? fail("not_found", "This chat no longer exists");

function list(query: string | null): ConversationSummary[] {
  const all = Object.values(history).sort((a, b) => b.updatedAt - a.updatedAt);
  const q = query?.trim().toLowerCase();
  if (!q) return all.map((c) => summaryOf(c));
  return all.flatMap((c) => {
    const hit = c.messages.find((m) => m.content.toLowerCase().includes(q));
    if (!c.title.toLowerCase().includes(q) && !hit) return [];
    if (!hit) return [summaryOf(c)];
    const i = hit.content.toLowerCase().indexOf(q);
    const start = Math.max(0, i - 40);
    const end = Math.min(hit.content.length, i + q.length + 90);
    const text = hit.content.slice(start, end).replace(/\s+/g, " ");
    return [summaryOf(c, `${start > 0 ? "…" : ""}${text}${end < hit.content.length ? "…" : ""}`)];
  });
}

const provisional = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= 50 ? line : `${line.slice(0, 50).replace(/\s+\S*$/, "")}…`;
};

function prepare(req: TurnRequest): { conversation: Stored; changed: Message[]; history: { role: string; content: string }[] } {
  const now = Date.now();
  let c: Stored;
  if (req.conversationId === null) {
    if (req.action.type !== "send") fail("bad_request", "Only a new message can start a chat");
    const id = crypto.randomUUID();
    c = history[id] = {
      id, title: provisional((req.action as { content: string }).content), titleStatus: "pending", modelId: req.model,
      systemPrompt: req.systemPrompt, params: req.params, createdAt: now, updatedAt: now, messages: [],
    };
  } else {
    c = getStored(req.conversationId);
    Object.assign(c, { modelId: req.model, systemPrompt: req.systemPrompt, params: req.params, updatedAt: now });
  }
  const msg = (seq: number, role: Message["role"], content: string, status: Message["status"]): Message => ({
    id: crypto.randomUUID(), conversationId: c.id, seq, role, content, reasoning: null,
    modelId: role === "assistant" ? req.model : null, status, error: null, finishReason: null, promptTokens: null,
    completionTokens: null, dropped: null, reasoningMs: null, createdAt: now, endedAt: null,
  });
  const changed: Message[] = [];
  let seq: number;
  const action = req.action;
  if (action.type === "send") {
    seq = c.messages.length ? c.messages[c.messages.length - 1].seq + 1 : 0;
    const user = msg(seq, "user", action.content, "complete");
    c.messages.push(user);
    changed.push(user);
    seq += 1;
  } else if (action.type === "regenerate") {
    const last = c.messages[c.messages.length - 1];
    if (last?.role !== "assistant") fail("bad_request", "There's no answer to regenerate");
    c.messages.pop();
    seq = last.seq;
  } else {
    const user = c.messages.find((m) => m.id === action.messageId && m.role === "user")
      ?? fail("not_found", "This message no longer exists");
    user.content = action.content;
    c.messages = c.messages.filter((m) => m.seq <= user.seq);
    if (user.seq === c.messages[0].seq && c.titleStatus !== "user") {
      Object.assign(c, { title: provisional(action.content), titleStatus: "pending" });
    }
    changed.push({ ...user });
    seq = user.seq + 1;
  }
  const answer = msg(seq, "assistant", "", "streaming");
  c.messages.push(answer);
  changed.push({ ...answer });
  saveHistory();

  const earlier = c.messages.filter((m) => m.seq < seq);
  const sent: { role: string; content: string }[] = req.systemPrompt ? [{ role: "system", content: req.systemPrompt }] : [];
  earlier.forEach((m, i) => {
    const next = earlier[i + 1];
    if (m.role !== "user") return;
    if (!next) sent.push(m);
    else if (next.role === "assistant" && next.content && (next.status === "complete" || next.status === "stopped"))
      sent.push(m, next);
  });
  return { conversation: c, changed, history: sent };
}

// ---- Settings and history as a whole (src-tauri/src/settings.rs, history.rs) ----

const SETTINGS_KEY = "alpha-mock-settings";
const DAY = 86_400_000;

function loadSettings(): AppSettings {
  try {
    return { ...defaultAppSettings(), ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") };
  } catch {
    return defaultAppSettings();
  }
}

function updateSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...loadSettings(), ...patch };
  const t = next.params.temperature;
  if (!["system", "light", "dark"].includes(next.theme)) fail("bad_request", "Invalid setting: unknown theme");
  if (t !== null && !(t >= 0 && t <= 2)) fail("bad_request", "Temperature must be between 0 and 2");
  if (next.params.maxTokens !== null && !(next.params.maxTokens > 0)) fail("bad_request", "Maximum answer length must be a positive number of tokens");
  if (next.retentionDays !== null && !(Number.isInteger(next.retentionDays) && next.retentionDays >= 1 && next.retentionDays <= 3650))
    fail("bad_request", "Chats can be kept for 1 to 3650 days");
  next.defaultModel = next.defaultModel?.trim() || null;
  next.systemPrompt = next.systemPrompt?.trim() ? next.systemPrompt : null;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
  return next;
}

const inactive = (days: number) => Object.values(history).filter((c) => c.updatedAt < Date.now() - days * DAY);

function prune(keep: string[]): string[] {
  const days = loadSettings().retentionDays;
  if (days === null) return [];
  const answering = [...streams.values()].map((s) => s.conversationId);
  const ids = inactive(days).map((c) => c.id).filter((id) => !keep.includes(id) && !answering.includes(id));
  for (const id of ids) delete history[id];
  saveHistory();
  return ids;
}

// ---- Streaming ----

async function chat(requestId: string, req: TurnRequest, emit: (ev: StreamEvent) => void) {
  const { conversation, changed, history: messages } = prepare(req);
  const answer = c_answer(conversation, changed[changed.length - 1].id);
  const state = { cancelled: false, conversationId: conversation.id };
  streams.set(requestId, state);
  emit({ type: "started", conversation: summaryOf(conversation), messages: changed });

  const last = messages[messages.length - 1]?.content.trim() ?? "";
  const model = models.find((m) => m.id === req.model);
  const delay = last.startsWith("/slow") ? 180 : 22;
  let saved = Date.now();
  const tick = async (ms = delay) => {
    await sleep(ms);
    if (Date.now() - saved > 750) {
      saved = Date.now();
      saveHistory();
    }
    if (state.cancelled) throw "cancelled";
  };
  const finish = (patch: Partial<Message>) => {
    Object.assign(answer, { endedAt: Date.now(), ...patch });
    saveHistory();
  };
  try {
    await tick(400);
    if (rejected || last === "/error 401") fail("unauthorized", "Authentication Error, Invalid proxy server token passed.");
    if (last === "/error 429") fail("rate_limited", "Rate limit exceeded", 7);
    if (last === "/error 404") fail("model_unavailable", `The model \`${req.model}\` does not exist.`);
    if (last === "/error 500") fail("server", "Internal Server Error");
    if (last === "/error context")
      fail("context_length", "This model's maximum context length is 8192 tokens. However, you requested 9000 tokens.");
    if (last === "/unreachable") fail("unreachable", "error sending request: tcp connect error: Connection refused");

    if (messages.length > 5) {
      answer.dropped = 2;
      emit({ type: "trimmed", dropped: 2 });
    }
    if (model?.reasoning.supported && req.params.reasoning !== false) {
      const thought = "The user wants a demonstration. I should show a numbered list, a code block, a table and some math, then point to the docs.";
      for (const piece of thought.match(/\S+\s*/g)!) {
        answer.reasoning = (answer.reasoning ?? "") + piece;
        emit({ type: "reasoning_delta", text: piece });
        await tick();
      }
    }
    const pieces = answer_text(model?.displayName ?? req.model, last).match(/\S+\s*|\s+/g)!;
    for (const [i, piece] of pieces.entries()) {
      if (last === "/drop" && i === Math.floor(pieces.length / 2)) {
        fail("stream_dropped", "Connection closed before the response finished");
      }
      if (!answer.content && answer.reasoning) answer.reasoningMs = Date.now() - answer.createdAt;
      answer.content += piece;
      emit({ type: "content_delta", text: piece });
      await tick();
    }
    emit({ type: "usage", usage: { prompt_tokens: 120, completion_tokens: 260, total_tokens: 380 } });
    finish({ status: "complete", finishReason: "stop", promptTokens: 120, completionTokens: 260 });
    emit({ type: "done", finish_reason: "stop" });
  } catch (e) {
    if (e === "cancelled") {
      finish({ status: "stopped", finishReason: "cancelled" });
      emit({ type: "done", finish_reason: "cancelled" });
    } else {
      const error = e as AppError;
      finish({ status: error.kind === "stream_dropped" && answer.content ? "stopped" : "error", error });
      emit({ type: "error", ...error });
    }
  } finally {
    streams.delete(requestId);
  }
}

/** The stored answer (a deleted chat keeps streaming into a detached copy). */
const c_answer = (c: Stored, id: string) => c.messages.find((m) => m.id === id)!;

async function generateTitle(id: string): Promise<ConversationSummary> {
  const c = getStored(id);
  const answer = c.messages.find((m) => m.role === "assistant" && m.content && m.status !== "error");
  if (c.titleStatus !== "pending" || !answer) return summaryOf(c);
  await sleep(700);
  const question = c.messages.find((m) => m.role === "user" && m.seq < answer.seq)?.content ?? "";
  const words = question.replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter((w) => w.length > 3).slice(0, 4);
  if (c.titleStatus === "pending") {
    if (words.length) Object.assign(c, { title: words.map((w) => w[0].toUpperCase() + w.slice(1)).join(" "), titleStatus: "generated" });
    else c.titleStatus = "fallback";
    saveHistory();
  }
  return summaryOf(c);
}

export function install() {
  if (scenario === "fresh") localStorage.removeItem(SETTINGS_KEY);
  loadHistory();
  prune([]);
  mockIPC(async (cmd, args) => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case "auth_status":
        return {
          hasKey,
          storage: hasKey ? (scenario === "file_storage" ? "file" : "keychain") : null,
          storageError: null,
          gatewayUrl: "https://llm.example.org",
          appVersion,
        } satisfies AuthStatus;
      case "auth_set_key":
        await sleep(600);
        if (String(a.key).trim() === "bad") fail("unauthorized", "Authentication Error, Invalid proxy server token passed.");
        hasKey = true;
        rejected = false;
        return { hasKey, storage: "keychain", storageError: null, gatewayUrl: "https://llm.example.org", appVersion };
      case "auth_clear":
        hasKey = false;
        return null;
      case "get_app_config":
        await sleep(150);
        return {
          config: {
            minAppVersion: updateRequired ? "0.2.0" : "0.1.0",
            announcement: scenario === "announcement" ? "The Nemotron server restarts at 18:00 for maintenance." : null,
            defaults: { contextWindow: 8192, maxOutputTokens: 2048, temperature: 0.7 },
          },
          source: "remote",
          fetchError: null,
          updateRequired,
        } satisfies ConfigStatus;
      case "list_models":
        await sleep(300);
        if (rejected) fail("unauthorized", "Authentication Error, Invalid proxy server token passed.");
        if (listFailures-- > 0) fail("unreachable", "error sending request for url (https://llm.example.org/v1/models): tcp connect error: Connection timed out");
        return models;
      case "chat_send": {
        if (scenario === "history_broken") fail("database", "unable to open database file: disk I/O error");
        const channel = a.onEvent as { onmessage: (ev: StreamEvent) => void };
        const req = a.request as TurnRequest;
        if (req.conversationId && [...streams.values()].some((s) => s.conversationId === req.conversationId))
          fail("bad_request", "This chat is still answering");
        await chat(String(a.requestId), req, (ev) => channel.onmessage(ev));
        return null;
      }
      case "chat_cancel": {
        const s = streams.get(String(a.requestId));
        if (s) s.cancelled = true;
        return null;
      }
      case "conversations_list":
        await sleep(40);
        if (scenario === "history_broken") fail("database", "unable to open database file: disk I/O error");
        return list(a.query as string | null);
      case "conversation_get":
        await sleep(60);
        return structuredClone(getStored(String(a.id)));
      case "conversation_update":
        Object.assign(getStored(String(a.id)), { modelId: a.model, systemPrompt: a.systemPrompt, params: a.params });
        saveHistory();
        return null;
      case "conversation_rename": {
        const c = getStored(String(a.id));
        const title = String(a.title).replace(/\s+/g, " ").trim();
        if (!title) fail("bad_request", "A chat needs a title");
        Object.assign(c, { title, titleStatus: "user" });
        saveHistory();
        return summaryOf(c);
      }
      case "conversation_delete":
        for (const s of streams.values()) if (s.conversationId === a.id) s.cancelled = true;
        delete history[String(a.id)];
        saveHistory();
        return null;
      case "conversation_generate_title":
        return generateTitle(String(a.id));
      case "save_markdown": {
        await sleep(200);
        const path = `/Users/you/Downloads/${String(a.suggestedName)}.md`;
        console.info(`[mock] save_markdown → ${path}\n\n${String(a.content)}`);
        (window as unknown as { __lastExport?: string }).__lastExport = String(a.content);
        return path;
      }
      case "settings_get":
        await sleep(30);
        if (scenario === "history_broken") fail("database", "unable to open database file: disk I/O error");
        return loadSettings();
      case "settings_update":
        await sleep(30);
        if (scenario === "history_broken") fail("database", "unable to open database file: disk I/O error");
        return updateSettings(a.patch as Partial<AppSettings>);
      case "history_info":
        await sleep(60);
        if (scenario === "history_broken") fail("database", "unable to open database file: disk I/O error");
        return {
          path: "/Users/you/Library/Application Support/com.alpha.desktop/history.sqlite3",
          conversations: Object.keys(history).length,
          inactive: a.inactiveDays == null ? null : inactive(Number(a.inactiveDays)).length,
        };
      case "history_prune":
        return prune(a.keep as string[]);
      case "history_delete_all":
        await sleep(300);
        for (const s of streams.values()) s.cancelled = true;
        {
          const n = Object.keys(history).length;
          history = {};
          saveHistory();
          return n;
        }
      case "history_reveal":
        console.info("[mock] history_reveal");
        return null;
      case "update_check":
        await sleep(250);
        return checkUpdate();
      case "update_download": {
        if (!published) fail("not_found", "No update to download. Check for updates first");
        const channel = a.onEvent as { onmessage: (ev: DownloadEvent) => void };
        await downloadUpdate((ev) => channel.onmessage(ev));
        return null;
      }
      case "update_install":
        if (!downloaded) fail("not_found", "The update hasn't been downloaded yet");
        for (const s of streams.values()) s.cancelled = true;
        await sleep(300);
        sessionStorage.setItem(INSTALLED_KEY, published!);
        location.reload();
        return null;
      case "plugin:opener|open_url":
        window.open(String(a.url), "_blank", "noopener");
        return null;
      default:
        throw new Error(`mock backend: unknown command ${cmd}`);
    }
  });
}
