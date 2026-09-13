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
  | "storage";

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

// src-tauri/src/chat.rs
export type StreamEvent =
  | { type: "trimmed"; dropped: number }
  | { type: "content_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finish_reason: string | null }
  | ({ type: "error" } & AppError);

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatPayload {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Omit to use the model's default. Ignored for models without a reasoning toggle. */
  reasoning?: boolean;
}

export const authStatus = () => invoke<AuthStatus>("auth_status");
export const authSetKey = (key: string) => invoke<AuthStatus>("auth_set_key", { key });
export const authClear = () => invoke<void>("auth_clear");
export const getAppConfig = () => invoke<ConfigStatus>("get_app_config");
export const listModels = () => invoke<ModelInfo[]>("list_models");

export function chatStream(
  requestId: string,
  payload: ChatPayload,
  onEvent: (ev: StreamEvent) => void,
): Promise<void> {
  const channel = new Channel<StreamEvent>();
  channel.onmessage = onEvent;
  return invoke<void>("chat_stream", { requestId, payload, onEvent: channel });
}

export const chatCancel = (requestId: string) => invoke<void>("chat_cancel", { requestId });

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "kind" in e && "message" in e;
}

export const toAppError = (e: unknown): AppError =>
  isAppError(e) ? e : { kind: "protocol", message: e instanceof Error ? e.message : String(e) };
