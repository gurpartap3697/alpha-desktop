import type { Conversation } from "./api";
import { errorTitle } from "./errors";

/** The conversation as a Markdown document: title, settings, then each message under a heading. */
export function toMarkdown(c: Conversation, modelName: (id: string | null) => string, now = new Date()): string {
  const out: string[] = [`# ${c.title.replace(/\s+/g, " ")}`, ""];
  const date = (ms: number) =>
    new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  out.push(`Started ${date(c.createdAt)}, exported from Alph ${date(now.getTime())}.`, "");

  if (c.systemPrompt?.trim()) {
    out.push("**System prompt**", "", quote(c.systemPrompt.trim()), "");
  }

  for (const m of c.messages) {
    out.push("---", "");
    if (m.role === "user") {
      out.push("### You", "", m.content.trim(), "");
      continue;
    }
    out.push(`### ${modelName(m.modelId)}`, "");
    if (m.reasoning?.trim()) {
      // <details> folds the thinking away where Markdown allows HTML, and reads fine where it doesn't.
      out.push("<details>", "<summary>Thinking</summary>", "", m.reasoning.trim(), "", "</details>", "");
    }
    if (m.content.trim()) out.push(m.content.trim(), "");
    if (m.status === "stopped") out.push("*The answer was stopped before it finished.*", "");
    if (m.status === "error" && m.error) out.push(`*No answer: ${errorTitle(m.error, modelName(m.modelId))}*`, "");
    if (m.status === "streaming") out.push("*Still being written when exported.*", "");
  }
  return out.join("\n").trimEnd() + "\n";
}

const quote = (text: string) =>
  text
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");

/** Suggested file name; the Rust side makes it safe for every OS. */
export const exportFileName = (title: string) => title.trim() || "Chat";
