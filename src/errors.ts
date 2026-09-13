import type { AppError } from "./api";

/** What each error means to the person using the app. The server's own message goes in details. */
export function errorTitle(e: AppError, modelName = "This model"): string {
  switch (e.kind) {
    case "unreachable":
      return "Can't reach the model server. Are you on VPN?";
    case "unauthorized":
      return "The server rejected your key. It may have been revoked or mistyped.";
    case "no_key":
      return "No API key is set.";
    case "rate_limited":
      return "Too many requests.";
    case "model_unavailable":
      return `${modelName} isn't available right now.`;
    case "context_length":
      return `This conversation is too long for ${modelName}, even after leaving out older messages. Start a new chat or shorten your message.`;
    case "stream_dropped":
      return "The connection dropped before the answer finished.";
    case "bad_request":
      return "The model server rejected the request.";
    case "server":
      return "The model server returned an error.";
    case "protocol":
      return "The model server sent a response the app couldn't read.";
    case "storage":
      return "Couldn't access the system keychain.";
  }
}
