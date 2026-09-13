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
  | "no_key";

export interface AppError {
  kind: ErrorKind;
  message: string;
  retry_after?: number | null;
}

export interface AuthStatus {
  hasKey: boolean;
  gatewayUrl: string;
  appVersion: string;
}

export interface Usage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

// Mirrors StreamEvent in src-tauri/src/chat.rs
export type StreamEvent =
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
  extraBody?: Record<string, unknown>;
}

export const authStatus = () => invoke<AuthStatus>("auth_status");
export const authSetKey = (key: string) => invoke<void>("auth_set_key", { key });
export const authClear = () => invoke<void>("auth_clear");
export const listModels = () => invoke<string[]>("list_models");

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
