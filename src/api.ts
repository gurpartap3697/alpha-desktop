import { Channel, invoke } from "@tauri-apps/api/core";

// Mirrors src-tauri/src/error.rs
export type ErrorKind =
  | "unreachable"
  | "unauthorized"
  | "rate_limited"
  | "model_unavailable"
  | "context_length"
  | "bad_request"
  | "server"
  | "stream_dropped"
  | "protocol"
  | "no_key"
  | "storage"
  | "database"
  | "not_found"
  | "interrupted";

export interface AppError {
  kind: ErrorKind;
  message: string;
  retry_after?: number | null;
}

// src-tauri/src/auth.rs
export interface AuthStatus {
  hasKey: boolean;
  storage: "keychain" | "file" | null;
  storageError: string | null;
  gatewayUrl: string;
  appVersion: string;
}

// src-tauri/src/config.rs
export interface AppConfig {
  minAppVersion: string | null;
  announcement: string | null;
  defaults: { contextWindow: number; maxOutputTokens: number; temperature: number };
}

export interface ConfigStatus {
  config: AppConfig;
  source: "remote" | "cache" | "builtin";
  fetchError: string | null;
  updateRequired: boolean;
}

// src-tauri/src/models.rs
export interface ModelInfo {
  id: string;
  displayName: string;
  description: string | null;
  contextWindow: number;
  maxOutputTokens: number;
  temperature: number;
  reasoning: { supported: boolean; defaultOn: boolean };
  vision: boolean;
  configured: boolean;
}

export interface Usage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

// src-tauri/src/db.rs
export interface Params {
  /** `null` = the model's default. */
  temperature: number | null;
  maxTokens: number | null;
  reasoning: boolean | null;
}

export interface ConversationSummary {
  id: string;
  title: string;
  modelId: string;
  createdAt: number;
  updatedAt: number;
  /** Search results only: text around the first matching message. */
  snippet?: string;
}

export interface Conversation {
  id: string;
  title: string;
  titleStatus: "pending" | "generated" | "fallback" | "user";
  modelId: string;
  systemPrompt: string | null;
  params: Params;
  createdAt: number;
  updatedAt: number;
  messages: Message[];
}

export type MessageStatus = "streaming" | "complete" | "stopped" | "error";

export interface Message {
  id: string;
  conversationId: string;
  seq: number;
  role: "user" | "assistant";
  content: string;
  reasoning: string | null;
  modelId: string | null;
  /** `stopped`: ended early (by the user or a dropped connection) but the partial answer is kept. */
  status: MessageStatus;
  error: AppError | null;
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  /** Older messages left out to fit the context window. */
  dropped: number | null;
  reasoningMs: number | null;
  createdAt: number;
  endedAt: number | null;
}

export type TurnAction =
  | { type: "send"; content: string }
  | { type: "regenerate" }
  | { type: "edit"; messageId: string; content: string };

export interface TurnRequest {
  /** `null` starts a new conversation. */
  conversationId: string | null;
  action: TurnAction;
  model: string;
  systemPrompt: string | null;
  params: Params;
}

// src-tauri/src/chat.rs
export type StreamEvent =
  | { type: "started"; conversation: ConversationSummary; messages: Message[] }
  | { type: "trimmed"; dropped: number }
  | { type: "content_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finish_reason: string | null }
  | ({ type: "error" } & AppError);

export const authStatus = () => invoke<AuthStatus>("auth_status");
export const authSetKey = (key: string) => invoke<AuthStatus>("auth_set_key", { key });
export const authClear = () => invoke<void>("auth_clear");
export const getAppConfig = () => invoke<ConfigStatus>("get_app_config");
export const listModels = () => invoke<ModelInfo[]>("list_models");

/** Resolves when the answer has finished; rejects only if nothing was saved. */
export function chatSend(
  requestId: string,
  request: TurnRequest,
  onEvent: (ev: StreamEvent) => void,
): Promise<void> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("chat_send", { requestId, request, onEvent: channel });
}

export const chatCancel = (requestId: string) => invoke<void>("chat_cancel", { requestId });

// src-tauri/src/history.rs
export const conversationsList = (query?: string) =>
  invoke<ConversationSummary[]>("conversations_list", { query: query || null });
export const conversationGet = (id: string) => invoke<Conversation>("conversation_get", { id });
export const conversationUpdate = (id: string, model: string, systemPrompt: string | null, params: Params) =>
  invoke<void>("conversation_update", { id, model, systemPrompt, params });
export const conversationRename = (id: string, title: string) =>
  invoke<ConversationSummary>("conversation_rename", { id, title });
export const conversationDelete = (id: string) => invoke<void>("conversation_delete", { id });
export const conversationGenerateTitle = (id: string) =>
  invoke<ConversationSummary>("conversation_generate_title", { id });
/** Shows a save dialog. Resolves to the saved path, or `null` if the user cancelled. */
export const saveMarkdown = (suggestedName: string, content: string) =>
  invoke<string | null>("save_markdown", { suggestedName, content });

export interface HistoryInfo {
  path: string;
  conversations: number;
  /** With `inactiveDays`: chats with no activity for that long. */
  inactive: number | null;
}

export const historyInfo = (inactiveDays?: number | null) =>
  invoke<HistoryInfo>("history_info", { inactiveDays: inactiveDays ?? null });
/** Applies the auto-delete setting, sparing `keep`. Resolves to the deleted ids. */
export const historyPrune = (keep: string[]) => invoke<string[]>("history_prune", { keep });
export const historyDeleteAll = () => invoke<number>("history_delete_all");
export const historyReveal = () => invoke<void>("history_reveal");

// src-tauri/src/settings.rs
export type Theme = "system" | "light" | "dark";

export interface AppSettings {
  theme: Theme;
  /** `null`: new chats continue with the most recently used model. */
  defaultModel: string | null;
  systemPrompt: string | null;
  params: Params;
  /** `null`: chats are kept until deleted. */
  retentionDays: number | null;
}

export const defaultAppSettings = (): AppSettings => ({
  theme: "system",
  defaultModel: null,
  systemPrompt: null,
  params: { temperature: null, maxTokens: null, reasoning: null },
  retentionDays: null,
});

export const settingsGet = () => invoke<AppSettings>("settings_get");
export const settingsUpdate = (patch: Partial<AppSettings>) => invoke<AppSettings>("settings_update", { patch });

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export const toAppError = (e: unknown): AppError =>
  isAppError(e) ? e : { kind: "protocol", message: e instanceof Error ? e.message : String(e) };
