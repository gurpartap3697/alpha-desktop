import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { ArrowUp, Lightbulb, LightbulbOff, Square } from "lucide-react";
import { activeModel, chatBusy, reasoningOn, useStore } from "../store";
import { errorTitle } from "../errors";
import { ariaShortcut, withShortcut } from "../shortcuts";
import { Notice, cx } from "./ui";

export function Composer() {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const model = useStore(activeModel);
  const thinking = useStore((s) => reasoningOn(s, model));
  const busy = useStore(chatBusy);
  const streaming = useStore((s) => s.chat.id !== null && s.chat.id in s.streams);
  const chatKey = useStore((s) => s.chat.key);
  const loading = useStore((s) => s.chat.status !== "ready");
  const sendError = useStore((s) => s.sendError);
  const send = useStore((s) => s.send);
  const stop = useStore((s) => s.stop);
  const setReasoning = useStore((s) => s.setReasoning);

  // Grow with the text, up to a limit.
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  // Back to the input after opening a chat or switching model.
  useEffect(() => {
    input.current?.focus();
  }, [chatKey, model?.id]);

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const sent = text;
    setText("");
    // Nothing was saved: put the text back unless something new has been typed.
    if (!(await send(sent))) setText((t) => t || sent);
  }

  const canSend = !!model && text.trim() !== "" && !busy && !loading;

  return (
    <div className="shrink-0 px-6 pt-1 pb-4">
      {sendError && (
        <Notice
          className="mx-auto mb-2 max-w-[44rem]"
          tone="error"
          title={errorTitle(sendError, model?.displayName)}
          details={sendError.message}
        />
      )}
      <form
        onSubmit={submit}
        className="mx-auto max-w-[44rem] rounded-[12px] border border-line bg-surface transition-colors focus-within:border-river"
      >
        <label htmlFor="composer" className="sr-only">
          Message
        </label>
        <textarea
          id="composer"
          ref={input}
          aria-keyshortcuts={ariaShortcut("focusComposer")}
          rows={1}
          value={text}
          autoFocus
          disabled={!model}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (canSend) void submit();
            }
          }}
          placeholder={model ? `Message ${model.displayName}` : "Waiting for models"}
          className="block max-h-[260px] w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] leading-6 placeholder:text-ink-3 focus:outline-none"
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          {model?.reasoning.supported && (
            <button
              type="button"
              role="switch"
              aria-checked={thinking}
              onClick={() => setReasoning(!thinking)}
              title={thinking ? "The model thinks before answering. Slower, better for hard problems." : "The model answers right away."}
              className={cx(
                "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
                thinking ? "border-river bg-river-soft text-river" : "border-line text-ink-3 hover:text-ink-2",
              )}
            >
              {thinking ? <Lightbulb size={13} /> : <LightbulbOff size={13} />}
              {thinking ? "Thinking on" : "Thinking off"}
            </button>
          )}
          <span className="flex-1 truncate pl-2 text-xs text-ink-3">
            {text && !busy ? "Enter to send, Shift+Enter for a new line" : ""}
          </span>
          {streaming ? (
            <button
              type="button"
              onClick={stop}
              aria-label="Stop"
              title={withShortcut("Stop", "stop")}
              aria-keyshortcuts={ariaShortcut("stop")}
              className="inline-flex size-8 items-center justify-center rounded-full bg-ink text-ground hover:opacity-85"
            >
              <Square size={12} fill="currentColor" />
            </button>
          ) : (
            <button
              type="submit"
              aria-label="Send"
              title="Send"
              disabled={!canSend}
              className="inline-flex size-8 items-center justify-center rounded-full bg-river text-ground transition-opacity hover:brightness-110 disabled:opacity-35"
            >
              <ArrowUp size={17} strokeWidth={2.25} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
