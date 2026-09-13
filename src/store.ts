import { create } from "zustand";
import {
  AppError,
  AuthStatus,
  ConfigStatus,
  ConversationSummary,
  Message,
  ModelInfo,
  Params,
  StreamEvent,
  TurnAction,
  authClear,
  authSetKey,
  authStatus,
  chatCancel,
  chatSend,
  conversationDelete,
  conversationGenerateTitle,
  conversationGet,
  conversationRename,
  conversationUpdate,
  conversationsList,
  getAppConfig,
  listModels,
  saveMarkdown,
  toAppError,
} from "./api";
import { exportFileName, toMarkdown } from "./export";

export type Phase = "loading" | "update_required" | "signed_out" | "ready";

export interface ChatSettings {
  modelId: string;
  systemPrompt: string;
  params: Params;
}

/** The chat on screen. */
export interface OpenChat {
  /** Changes whenever another chat is opened; tells late responses which chat they belong to. */
  key: string;
  /** `null` until the first message saves it. */
  id: string | null;
  title: string;
  settings: ChatSettings;
  messages: Message[];
  status: "ready" | "loading" | "error";
  loadError: AppError | null;
}

export interface Turn {
  user: Message;
  answer?: Message;
}

export interface Toast {
  id: number;
  tone: "info" | "error";
  text: string;
  details?: string;
}

interface Store {
  phase: Phase;
  bootError: AppError | null;
  auth: AuthStatus | null;
  config: ConfigStatus | null;
  /** Error shown on the key screen. */
  keyError: AppError | null;
  /** The key screen is showing because the gateway rejected the saved key. */
  keyRejected: boolean;

  models: ModelInfo[];
  modelsStatus: "idle" | "loading" | "ok" | "error";
  modelsError: AppError | null;

  conversations: ConversationSummary[];
  historyError: AppError | null;
  search: string;
  /** `null` when not searching. */
  results: ConversationSummary[] | null;

  chat: OpenChat;
  /** Answers streaming right now, by conversation id. */
  streams: Record<string, { requestId: string; answerId: string }>;
  /** Key of the open chat while its request is on the way but not yet saved. */
  sending: string | null;
  /** Failure to start a turn in the open chat (nothing was saved). */
  sendError: AppError | null;
  /** Latest state of every answer streamed this session, so switching chats doesn't lose live text. */
  live: Record<string, Message>;

  toast: Toast | null;
  dismissed: Record<string, true>;

  boot(): Promise<void>;
  submitKey(key: string): Promise<void>;
  signOut(): Promise<void>;
  loadModels(): Promise<void>;

  loadConversations(): Promise<void>;
  setSearch(query: string): void;
  newChat(): void;
  openChat(id: string): Promise<void>;
  renameChat(id: string, title: string): Promise<boolean>;
  deleteChat(id: string): Promise<boolean>;
  exportChat(id: string): Promise<void>;

  selectModel(id: string): void;
  setReasoning(on: boolean): void;
  updateSettings(patch: Partial<Omit<ChatSettings, "params">> & { params?: Partial<Params> }): void;

  send(text: string): Promise<boolean>;
  regenerate(modelId?: string): void;
  editAndResend(messageId: string, text: string): Promise<boolean>;
  stop(): void;

  showToast(toast: Omit<Toast, "id">): void;
  dismiss(id: string): void;
}

const defaultParams = (): Params => ({ temperature: null, maxTokens: null, reasoning: null });

const draftChat = (settings: ChatSettings): OpenChat => ({
  key: crypto.randomUUID(),
  id: null,
  title: "",
  settings,
  messages: [],
  status: "ready",
  loadError: null,
});

/** The model new messages in the open chat go to: its own, or the first available if that's gone. */
export const activeModel = (s: Pick<Store, "models" | "chat">): ModelInfo | undefined =>
  s.models.find((m) => m.id === s.chat.settings.modelId) ?? s.models[0];

export const reasoningOn = (s: Pick<Store, "chat">, m: ModelInfo | undefined) =>
  !!m?.reasoning.supported && (s.chat.settings.params.reasoning ?? m.reasoning.defaultOn);

/** The open chat is sending or streaming. */
export const chatBusy = (s: Pick<Store, "chat" | "streams" | "sending">) =>
  s.sending === s.chat.key || (s.chat.id !== null && s.chat.id in s.streams);

export function toTurns(messages: Message[]): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role !== "user") continue;
    const next = messages[i + 1];
    turns.push({ user: messages[i], answer: next?.role === "assistant" ? next : undefined });
  }
  return turns;
}

const byRecent = (a: ConversationSummary, b: ConversationSummary) => b.updatedAt - a.updatedAt;

const upsert = (list: ConversationSummary[], c: ConversationSummary) =>
  [c, ...list.filter((x) => x.id !== c.id)].sort(byRecent);

const replaceTitle = (list: ConversationSummary[] | null, c: ConversationSummary) =>
  list && list.map((x) => (x.id === c.id ? { ...x, title: c.title } : x));

const isKeyError = (e: AppError) => e.kind === "unauthorized" || e.kind === "no_key";

export const useStore = create<Store>()((set, get) => {
  // Deltas are buffered and flushed once per animation frame instead of re-rendering per token.
  const pending = new Map<string, { reasoning: string; content: string }>();
  let frame: number | null = null;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let saveSettings: (() => void) | null = null;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  /** Update an answer that is (or was) streaming this session, both in `live` and on screen. */
  const patchLive = (id: string, fn: (m: Message) => Partial<Message>) =>
    set((s) => {
      const current = s.live[id];
      if (!current) return {};
      const next = { ...current, ...fn(current) };
      const onScreen = s.chat.messages.some((m) => m.id === id);
      return {
        live: { ...s.live, [id]: next },
        chat: onScreen ? { ...s.chat, messages: s.chat.messages.map((m) => (m.id === id ? next : m)) } : s.chat,
      };
    });

  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    for (const [id, { reasoning, content }] of pending) {
      patchLive(id, (m) => ({
        reasoning: (m.reasoning ?? "") + reasoning || null,
        content: m.content + content,
        reasoningMs: m.reasoningMs ?? ((m.reasoning || reasoning) && content ? Date.now() - m.createdAt : null),
      }));
    }
    pending.clear();
  };

  const buffer = (id: string, field: "reasoning" | "content", text: string) => {
    const p = pending.get(id) ?? { reasoning: "", content: "" };
    p[field] += text;
    pending.set(id, p);
    frame ??= requestAnimationFrame(flush);
  };

  const flushSettings = () => {
    clearTimeout(saveTimer);
    saveSettings?.();
    saveSettings = null;
  };

  const keyRejected = (error: AppError) => {
    for (const { requestId } of Object.values(get().streams)) void chatCancel(requestId);
    const rejected = error.kind === "unauthorized";
    set({ phase: "signed_out", keyRejected: rejected, keyError: rejected ? error : null });
  };

  const onStarted = (chatKey: string, requestId: string, ev: Extract<StreamEvent, { type: "started" }>) => {
    const answer = ev.messages[ev.messages.length - 1];
    const firstSeq = Math.min(...ev.messages.map((m) => m.seq));
    set((s) => {
      const isOpen = s.chat.key === chatKey;
      return {
        streams: { ...s.streams, [ev.conversation.id]: { requestId, answerId: answer.id } },
        live: { ...s.live, [answer.id]: answer },
        conversations: upsert(s.conversations, ev.conversation),
        sending: s.sending === chatKey ? null : s.sending,
        sendError: isOpen ? null : s.sendError,
        chat: isOpen
          ? {
              ...s.chat,
              id: ev.conversation.id,
              title: ev.conversation.title,
              // An edit or regenerate replaces everything from its first changed message on.
              messages: [...s.chat.messages.filter((m) => m.seq < firstSeq), ...ev.messages],
            }
          : s.chat,
      };
    });
  };

  const onEvent = (answerId: string, ev: Exclude<StreamEvent, { type: "started" }>) => {
    switch (ev.type) {
      case "trimmed":
        patchLive(answerId, () => ({ dropped: ev.dropped }));
        break;
      case "reasoning_delta":
      case "content_delta":
        buffer(answerId, ev.type === "reasoning_delta" ? "reasoning" : "content", ev.text);
        break;
      case "usage":
        patchLive(answerId, () => ({
          promptTokens: ev.usage.prompt_tokens ?? null,
          completionTokens: ev.usage.completion_tokens ?? null,
        }));
        break;
      case "done":
        flush();
        patchLive(answerId, (m) => ({
          status: ev.finish_reason === "cancelled" ? "stopped" : "complete",
          finishReason: ev.finish_reason,
          reasoningMs: m.reasoningMs ?? (m.reasoning ? Date.now() - m.createdAt : null),
          endedAt: Date.now(),
        }));
        break;
      case "error": {
        flush();
        const { type: _type, ...error } = ev;
        patchLive(answerId, (m) => ({
          status: error.kind === "stream_dropped" && m.content ? "stopped" : "error",
          error,
          endedAt: Date.now(),
        }));
        if (isKeyError(error)) keyRejected(error);
        break;
      }
    }
  };

  const titling = new Set<string>();
  const generateTitle = async (conversationId: string) => {
    if (titling.has(conversationId)) return;
    titling.add(conversationId);
    try {
      const c = await conversationGenerateTitle(conversationId);
      set((s) => ({
        conversations: s.conversations.map((x) => (x.id === c.id ? { ...x, title: c.title } : x)),
        results: replaceTitle(s.results, c),
        chat: s.chat.id === c.id ? { ...s.chat, title: c.title } : s.chat,
      }));
    } catch {
      // The provisional title stays.
    } finally {
      titling.delete(conversationId);
    }
  };

  /** Save the user's action and stream the answer. Resolves `true` once saved, `false` if it couldn't start. */
  const startTurn = (action: TurnAction, modelOverride?: string): Promise<boolean> => {
    const s = get();
    const model = modelOverride ?? activeModel(s)?.id;
    if (!model || chatBusy(s)) return Promise.resolve(false);
    flushSettings();

    const { chat } = s;
    const requestId = crypto.randomUUID();
    set({ sending: chat.key, sendError: null });

    return new Promise((resolve) => {
      let answerId: string | null = null;
      let conversationId: string | null = null;

      chatSend(
        requestId,
        {
          conversationId: chat.id,
          action,
          model,
          systemPrompt: chat.settings.systemPrompt.trim() ? chat.settings.systemPrompt : null,
          params: chat.settings.params,
        },
        (ev) => {
          if (ev.type === "started") {
            answerId = ev.messages[ev.messages.length - 1].id;
            conversationId = ev.conversation.id;
            onStarted(chat.key, requestId, ev);
            resolve(true);
          } else if (answerId) {
            onEvent(answerId, ev);
          }
        },
      )
        .catch((e) => {
          const error = toAppError(e);
          if (answerId) onEvent(answerId, { type: "error", ...error });
          else set((st) => ({ sending: st.sending === chat.key ? null : st.sending, sendError: error }));
        })
        .finally(() => {
          flush();
          if (!answerId || !conversationId) {
            set((st) => ({ sending: st.sending === chat.key ? null : st.sending }));
            resolve(false);
            return;
          }
          const id = answerId;
          const cid = conversationId;
          // The last event is always done/error; guard against the channel closing without one.
          patchLive(id, (m) =>
            m.status === "streaming"
              ? {
                  status: m.content ? "stopped" : "error",
                  endedAt: Date.now(),
                  error: { kind: "interrupted", message: "The answer ended unexpectedly" },
                }
              : {},
          );
          set((st) => {
            if (st.streams[cid]?.requestId !== requestId) return {};
            const { [cid]: _done, ...streams } = st.streams;
            return { streams };
          });
          const answer = get().live[id];
          if (answer?.content && (answer.status === "complete" || answer.status === "stopped")) void generateTitle(cid);
        });
    });
  };

  const settingsFor = (c: { modelId: string; systemPrompt: string | null; params: Params }): ChatSettings => ({
    modelId: c.modelId,
    systemPrompt: c.systemPrompt ?? "",
    params: { ...defaultParams(), ...c.params },
  });

  return {
    phase: "loading",
    bootError: null,
    auth: null,
    config: null,
    keyError: null,
    keyRejected: false,
    models: [],
    modelsStatus: "idle",
    modelsError: null,
    conversations: [],
    historyError: null,
    search: "",
    results: null,
    chat: draftChat({ modelId: "", systemPrompt: "", params: defaultParams() }),
    streams: {},
    sending: null,
    sendError: null,
    live: {},
    toast: null,
    dismissed: {},

    async boot() {
      try {
        const [auth, config] = await Promise.all([authStatus(), getAppConfig()]);
        set({ auth, config, bootError: null });
        if (config.updateRequired) return set({ phase: "update_required" });
        if (!auth.hasKey) return set({ phase: "signed_out" });
        set({ phase: "ready" });
        await Promise.all([get().loadModels(), get().loadConversations()]);
      } catch (e) {
        set({ bootError: toAppError(e) });
      }
    },

    async submitKey(key) {
      set({ keyError: null, keyRejected: false });
      try {
        const auth = await authSetKey(key);
        set({ auth, phase: "ready", keyRejected: false });
        await Promise.all([get().loadModels(), get().conversations.length ? null : get().loadConversations()]);
      } catch (e) {
        set({ keyError: toAppError(e) });
      }
    },

    async signOut() {
      for (const { requestId } of Object.values(get().streams)) void chatCancel(requestId);
      let keyError: AppError | null = null;
      try {
        await authClear();
      } catch (e) {
        keyError = toAppError(e);
      }
      set((s) => ({
        phase: "signed_out",
        keyRejected: false,
        keyError,
        models: [],
        modelsStatus: "idle",
        auth: s.auth && { ...s.auth, hasKey: false, storage: null },
      }));
    },

    async loadModels() {
      set({ modelsStatus: "loading" });
      try {
        const models = await listModels();
        set({ models, modelsStatus: "ok", modelsError: null });
      } catch (e) {
        const error = toAppError(e);
        set({ modelsStatus: "error", modelsError: error });
        if (isKeyError(error)) keyRejected(error);
      }
    },

    async loadConversations() {
      try {
        const conversations = await conversationsList();
        set((s) => ({
          conversations,
          historyError: null,
          // A fresh start continues with the model used most recently.
          chat:
            s.chat.id === null && !s.chat.settings.modelId && conversations[0]
              ? { ...s.chat, settings: { ...s.chat.settings, modelId: conversations[0].modelId } }
              : s.chat,
        }));
      } catch (e) {
        set({ historyError: toAppError(e) });
      }
    },

    setSearch(query) {
      set({ search: query });
      clearTimeout(searchTimer);
      if (!query.trim()) return set({ results: null });
      searchTimer = setTimeout(async () => {
        try {
          const results = await conversationsList(query);
          if (get().search === query) set({ results });
        } catch (e) {
          if (get().search === query) set({ results: [], historyError: toAppError(e) });
        }
      }, 150);
    },

    newChat() {
      flushSettings();
      const s = get();
      const model = activeModel(s);
      set({
        sendError: null,
        chat: draftChat({
          modelId: model?.id ?? s.chat.settings.modelId,
          systemPrompt: "",
          // Thinking on/off carries over; it's a preference more than a per-chat setting.
          params: { ...defaultParams(), reasoning: s.chat.settings.params.reasoning },
        }),
      });
    },

    async openChat(id) {
      if (get().chat.id === id && get().chat.status !== "error") return;
      flushSettings();
      const summary = get().conversations.find((c) => c.id === id) ?? get().results?.find((c) => c.id === id);
      const key = crypto.randomUUID();
      set((s) => ({
        sendError: null,
        chat: {
          key,
          id,
          title: summary?.title ?? "",
          settings: s.chat.settings,
          messages: [],
          status: "loading",
          loadError: null,
        },
      }));
      try {
        const c = await conversationGet(id);
        set((s) => {
          if (s.chat.key !== key) return {};
          const live = { ...s.live };
          const messages = c.messages.map((m) => {
            const l = live[m.id];
            if (!l) return m;
            // The database has caught up with a finished answer; the live copy is no longer needed.
            if (l.status !== "streaming" && m.status === l.status) {
              delete live[m.id];
              return m;
            }
            return l;
          });
          return {
            live,
            chat: { key, id, title: c.title, settings: settingsFor(c), messages, status: "ready", loadError: null },
          };
        });
      } catch (e) {
        const error = toAppError(e);
        set((s) => (s.chat.key === key ? { chat: { ...s.chat, status: "error", loadError: error } } : {}));
        if (error.kind === "not_found") void get().loadConversations();
      }
    },

    async renameChat(id, title) {
      try {
        const c = await conversationRename(id, title);
        set((s) => ({
          conversations: s.conversations.map((x) => (x.id === id ? { ...x, title: c.title } : x)),
          results: replaceTitle(s.results, c),
          chat: s.chat.id === id ? { ...s.chat, title: c.title } : s.chat,
        }));
        return true;
      } catch (e) {
        const error = toAppError(e);
        get().showToast({ tone: "error", text: "Couldn't rename the chat.", details: error.message });
        return false;
      }
    },

    async deleteChat(id) {
      try {
        await conversationDelete(id);
      } catch (e) {
        get().showToast({ tone: "error", text: "Couldn't delete the chat.", details: toAppError(e).message });
        return false;
      }
      if (get().chat.id === id) get().newChat();
      set((s) => ({
        conversations: s.conversations.filter((c) => c.id !== id),
        results: s.results && s.results.filter((c) => c.id !== id),
        live: Object.fromEntries(Object.entries(s.live).filter(([, m]) => m.conversationId !== id)),
      }));
      return true;
    },

    async exportChat(id) {
      try {
        const c = await conversationGet(id);
        const s = get();
        const messages = c.messages.map((m) => s.live[m.id] ?? m);
        const name = (modelId: string | null) =>
          s.models.find((m) => m.id === modelId)?.displayName ?? modelId ?? "Assistant";
        const path = await saveMarkdown(exportFileName(c.title), toMarkdown({ ...c, messages }, name));
        if (path) get().showToast({ tone: "info", text: `Exported to ${path}` });
      } catch (e) {
        get().showToast({ tone: "error", text: "Couldn't export the chat.", details: toAppError(e).message });
      }
    },

    selectModel: (modelId) => get().updateSettings({ modelId }),

    setReasoning: (on) => get().updateSettings({ params: { reasoning: on } }),

    updateSettings(patch) {
      const { chat } = get();
      // While a chat loads, the settings on screen still belong to the previous one.
      if (chat.status !== "ready") return;
      const settings: ChatSettings = {
        ...chat.settings,
        ...patch,
        params: { ...chat.settings.params, ...patch.params },
      };
      set({ chat: { ...chat, settings } });
      if (!chat.id) return;
      const id = chat.id;
      saveSettings = () => {
        conversationUpdate(id, settings.modelId, settings.systemPrompt.trim() ? settings.systemPrompt : null, settings.params)
          .catch((e) => console.error("saving chat settings failed", e));
      };
      clearTimeout(saveTimer);
      saveTimer = setTimeout(flushSettings, 400);
    },

    send: (text) => (text.trim() ? startTurn({ type: "send", content: text }) : Promise.resolve(false)),

    regenerate(modelId) {
      if (modelId) get().selectModel(modelId);
      void startTurn({ type: "regenerate" }, modelId);
    },

    editAndResend: (messageId, text) =>
      text.trim() ? startTurn({ type: "edit", messageId, content: text }) : Promise.resolve(false),

    stop() {
      const { chat, streams } = get();
      const stream = chat.id ? streams[chat.id] : undefined;
      if (stream) void chatCancel(stream.requestId);
    },

    showToast(toast) {
      clearTimeout(toastTimer);
      const id = Date.now();
      set({ toast: { ...toast, id } });
      toastTimer = setTimeout(() => {
        if (get().toast?.id === id) set({ toast: null });
      }, toast.tone === "error" ? 8000 : 5000);
    },

    dismiss: (id) => set((s) => ({ dismissed: { ...s.dismissed, [id]: true } })),
  };
});
