import { create } from "zustand";
import {
  AppError,
  AuthStatus,
  ChatMessage,
  ConfigStatus,
  ModelInfo,
  StreamEvent,
  Usage,
  authClear,
  authSetKey,
  authStatus,
  chatCancel,
  chatStream,
  getAppConfig,
  listModels,
  toAppError,
} from "./api";

export type Phase = "loading" | "update_required" | "signed_out" | "ready";

export interface Turn {
  id: string;
  user: string;
  modelId: string;
  reasoning: string;
  content: string;
  /** `stopped`: ended early (by the user or a dropped connection) but the partial answer is kept. */
  status: "streaming" | "complete" | "stopped" | "error";
  finishReason?: string | null;
  error?: AppError;
  usage?: Usage;
  /** Older messages left out to fit the context window. */
  dropped?: number;
  startedAt: number;
  reasoningEndedAt?: number;
  endedAt?: number;
}

export interface ChatSettings {
  systemPrompt: string;
  /** `null` = the model's default. */
  temperature: number | null;
  maxTokens: number | null;
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
  modelId: string;
  reasoningByModel: Record<string, boolean>;
  settings: ChatSettings;

  turns: Turn[];
  requestId: string | null;
  dismissed: Record<string, true>;

  boot(): Promise<void>;
  submitKey(key: string): Promise<void>;
  signOut(): Promise<void>;
  loadModels(): Promise<void>;
  selectModel(id: string): void;
  setReasoning(modelId: string, on: boolean): void;
  updateSettings(patch: Partial<ChatSettings>): void;
  send(text: string): boolean;
  stop(): void;
  retryLast(modelId?: string): void;
  newChat(): void;
  dismiss(id: string): void;
}

export const reasoningOn = (s: Pick<Store, "reasoningByModel">, m: ModelInfo | undefined) =>
  !!m?.reasoning.supported && (s.reasoningByModel[m.id] ?? m.reasoning.defaultOn);

const isKeyError = (e: AppError) => e.kind === "unauthorized" || e.kind === "no_key";

export const useStore = create<Store>()((set, get) => {
  // Deltas are buffered and flushed once per animation frame instead of re-rendering per token.
  let pending: { turnId: string; reasoning: string; content: string } | null = null;
  let frame: number | null = null;

  const patchTurn = (id: string, fn: (t: Turn) => Partial<Turn>) =>
    set((s) => ({ turns: s.turns.map((t) => (t.id === id ? { ...t, ...fn(t) } : t)) }));

  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    if (!pending) return;
    const { turnId, reasoning, content } = pending;
    pending = null;
    patchTurn(turnId, (t) => ({
      reasoning: t.reasoning + reasoning,
      content: t.content + content,
      reasoningEndedAt: t.reasoningEndedAt ?? ((t.reasoning || reasoning) && content ? Date.now() : undefined),
    }));
  };

  const buffer = (turnId: string, field: "reasoning" | "content", text: string) => {
    if (pending && pending.turnId !== turnId) flush();
    pending ??= { turnId, reasoning: "", content: "" };
    pending[field] += text;
    frame ??= requestAnimationFrame(flush);
  };

  const keyRejected = (error: AppError) => {
    get().stop();
    const rejected = error.kind === "unauthorized";
    set({ phase: "signed_out", keyRejected: rejected, keyError: rejected ? error : null });
  };

  const onEvent = (turnId: string, ev: StreamEvent) => {
    switch (ev.type) {
      case "trimmed":
        patchTurn(turnId, () => ({ dropped: ev.dropped }));
        break;
      case "reasoning_delta":
      case "content_delta":
        buffer(turnId, ev.type === "reasoning_delta" ? "reasoning" : "content", ev.text);
        break;
      case "usage":
        patchTurn(turnId, () => ({ usage: ev.usage }));
        break;
      case "done":
        flush();
        patchTurn(turnId, () => ({
          status: ev.finish_reason === "cancelled" ? "stopped" : "complete",
          finishReason: ev.finish_reason,
          endedAt: Date.now(),
        }));
        break;
      case "error": {
        flush();
        const { type: _type, ...error } = ev;
        patchTurn(turnId, (t) => ({
          status: error.kind === "stream_dropped" && t.content ? "stopped" : "error",
          error,
          endedAt: Date.now(),
        }));
        if (isKeyError(error)) keyRejected(error);
        break;
      }
    }
  };

  const run = async (turnId: string) => {
    const s = get();
    const index = s.turns.findIndex((t) => t.id === turnId);
    if (index < 0) return;
    const turn = s.turns[index];
    const model = s.models.find((m) => m.id === turn.modelId);

    // Reasoning is never sent back, and failed turns are left out.
    const history: ChatMessage[] = s.turns.slice(0, index).flatMap((t) =>
      t.content.trim() && (t.status === "complete" || t.status === "stopped")
        ? [{ role: "user" as const, content: t.user }, { role: "assistant" as const, content: t.content }]
        : [],
    );
    const system = s.settings.systemPrompt.trim();
    const messages: ChatMessage[] = [
      ...(system ? [{ role: "system" as const, content: system }] : []),
      ...history,
      { role: "user", content: turn.user },
    ];

    const requestId = crypto.randomUUID();
    set({ requestId });
    try {
      await chatStream(
        requestId,
        {
          model: turn.modelId,
          messages,
          temperature: s.settings.temperature ?? model?.temperature,
          maxTokens: s.settings.maxTokens ?? undefined,
          reasoning: model?.reasoning.supported ? reasoningOn(s, model) : undefined,
        },
        (ev) => onEvent(turnId, ev),
      );
    } catch (e) {
      onEvent(turnId, { type: "error", ...toAppError(e) });
    } finally {
      flush();
      if (get().requestId === requestId) set({ requestId: null });
      // The last event is always done/error; guard against the channel closing without one.
      patchTurn(turnId, (t) =>
        t.status === "streaming"
          ? { status: t.content ? "stopped" : "error", endedAt: Date.now(),
              error: { kind: "stream_dropped", message: "The response ended unexpectedly" } }
          : {},
      );
    }
  };

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
    modelId: "",
    reasoningByModel: {},
    settings: { systemPrompt: "", temperature: null, maxTokens: null },
    turns: [],
    requestId: null,
    dismissed: {},

    async boot() {
      try {
        const [auth, config] = await Promise.all([authStatus(), getAppConfig()]);
        set({ auth, config, bootError: null });
        if (config.updateRequired) return set({ phase: "update_required" });
        if (!auth.hasKey) return set({ phase: "signed_out" });
        set({ phase: "ready" });
        await get().loadModels();
      } catch (e) {
        set({ bootError: toAppError(e) });
      }
    },

    async submitKey(key) {
      set({ keyError: null, keyRejected: false });
      try {
        const auth = await authSetKey(key);
        set({ auth, phase: "ready", keyRejected: false });
        await get().loadModels();
      } catch (e) {
        set({ keyError: toAppError(e) });
      }
    },

    async signOut() {
      get().newChat();
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
        set((s) => ({
          models,
          modelsStatus: "ok",
          modelsError: null,
          modelId: models.some((m) => m.id === s.modelId) ? s.modelId : (models[0]?.id ?? ""),
        }));
      } catch (e) {
        const error = toAppError(e);
        set({ modelsStatus: "error", modelsError: error });
        if (isKeyError(error)) keyRejected(error);
      }
    },

    selectModel: (modelId) => set({ modelId }),

    setReasoning: (modelId, on) => set((s) => ({ reasoningByModel: { ...s.reasoningByModel, [modelId]: on } })),

    updateSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

    send(text) {
      const s = get();
      if (s.requestId || !text.trim() || !s.modelId) return false;
      const turn: Turn = {
        id: crypto.randomUUID(),
        user: text,
        modelId: s.modelId,
        reasoning: "",
        content: "",
        status: "streaming",
        startedAt: Date.now(),
      };
      set({ turns: [...s.turns, turn] });
      void run(turn.id);
      return true;
    },

    stop() {
      const { requestId } = get();
      if (requestId) void chatCancel(requestId);
    },

    retryLast(modelId) {
      const s = get();
      const last = s.turns[s.turns.length - 1];
      if (!last || s.requestId) return;
      const target = modelId || s.modelId || last.modelId;
      if (modelId) set({ modelId });
      patchTurn(last.id, () => ({
        modelId: target,
        reasoning: "",
        content: "",
        status: "streaming",
        finishReason: undefined,
        error: undefined,
        usage: undefined,
        dropped: undefined,
        startedAt: Date.now(),
        reasoningEndedAt: undefined,
        endedAt: undefined,
      }));
      void run(last.id);
    },

    newChat() {
      get().stop();
      flush();
      set({ turns: [], requestId: null });
    },

    dismiss: (id) => set((s) => ({ dismissed: { ...s.dismissed, [id]: true } })),
  };
});
