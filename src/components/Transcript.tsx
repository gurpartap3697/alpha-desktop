import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ChevronRight, Pencil, RotateCcw } from "lucide-react";
import type { Message } from "../api";
import { activeModel, chatBusy, toTurns, useStore } from "../store";
import { errorTitle } from "../errors";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { Banners } from "./Banners";
import { Button, IconButton, Notice } from "./ui";

export function Transcript() {
  const messages = useStore((s) => s.chat.messages);
  const status = useStore((s) => s.chat.status);
  const loadError = useStore((s) => s.chat.loadError);
  const chatKey = useStore((s) => s.chat.key);
  const chatId = useStore((s) => s.chat.id);
  const openChat = useStore((s) => s.openChat);
  const streaming = useStore((s) => s.chat.id !== null && s.chat.id in s.streams);
  const turns = useMemo(() => toTurns(messages), [messages]);
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const count = turns.length;

  // Follow the answer as it streams unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [turns, pinned]);

  // A new message, or another chat, always brings the view back to the bottom.
  useLayoutEffect(() => setPinned(true), [count, chatKey]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto px-6">
        <div className="mx-auto max-w-[44rem] pt-5 pb-10">
          <Banners />
          {status === "error" && loadError ? (
            <Notice
              className="mt-4"
              tone="error"
              title={errorTitle(loadError)}
              details={loadError.message}
              actions={loadError.kind !== "not_found" && chatId && <Button onClick={() => void openChat(chatId)}>Try again</Button>}
            />
          ) : status === "loading" ? null : count === 0 ? (
            <EmptyState />
          ) : (
            turns.map((t, i) => (
              <TurnView key={t.user.id} user={t.user} answer={t.answer} isLast={i === count - 1} laterCount={messages.length - 1 - messages.indexOf(t.user) - (t.answer ? 1 : 0)} />
            ))
          )}
        </div>
      </div>
      {!pinned && streaming && (
        <Button
          variant="outline"
          onClick={() => setPinned(true)}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-surface shadow-sm"
        >
          <ArrowDown size={14} />
          Jump to latest
        </Button>
      )}
    </div>
  );
}

function EmptyState() {
  const model = useStore(activeModel);
  if (!model) return null;
  return (
    <div className="pt-[18vh]">
      <h2 className="font-serif text-[1.9rem] leading-tight font-[520] tracking-[-0.01em]">{model.displayName}</h2>
      <p className="mt-2 max-w-[34rem] text-[15px] leading-6 text-ink-2">
        {model.description ?? "Ask a question, paste some text to work on, or describe a problem."}
      </p>
      <p className="mt-5 text-[13px] text-ink-3">Chats are saved on this device only.</p>
    </div>
  );
}

const modelNameOf = (id: string | null | undefined) => (s: { models: { id: string; displayName: string }[] }) =>
  s.models.find((m) => m.id === id)?.displayName ?? id ?? "the model";

const TurnView = memo(function TurnView({
  user,
  answer,
  isLast,
  laterCount,
}: {
  user: Message;
  answer?: Message;
  isLast: boolean;
  /** Messages after this turn, removed if the user message is edited. */
  laterCount: number;
}) {
  const modelName = useStore(modelNameOf(answer?.modelId));
  const idle = useStore((s) => !chatBusy(s));
  const regenerate = useStore((s) => s.regenerate);
  const [editing, setEditing] = useState(false);
  const streaming = answer?.status === "streaming";

  return (
    <section className="mt-9 first:mt-4">
      {editing ? (
        <EditMessage message={user} laterCount={laterCount} onDone={() => setEditing(false)} />
      ) : (
        <div className="group/user flex items-start gap-2">
          <div className="min-w-0 flex-1 border-l-2 border-river pl-3.5 text-[15px] leading-6 break-words whitespace-pre-wrap">
            {user.content}
          </div>
          <IconButton
            label="Edit message"
            onClick={() => setEditing(true)}
            disabled={!idle}
            className="-mt-0.5 size-7 shrink-0 opacity-0 group-hover/user:opacity-100 focus-visible:opacity-100 disabled:invisible"
          >
            <Pencil size={14} />
          </IconButton>
        </div>
      )}

      {answer && (
        <div className="mt-5">
          {!!answer.dropped && (
            <p className="mb-3 text-xs text-ink-3">
              {answer.dropped === 1 ? "1 older message wasn't" : `${answer.dropped} older messages weren't`} sent, to fit{" "}
              {modelName}'s context window.
            </p>
          )}
          {answer.reasoning && <ReasoningPanel answer={answer} />}
          {answer.content ? (
            <Markdown text={answer.content} streaming={streaming} />
          ) : (
            streaming && !answer.reasoning && <p className="thinking-label text-[14px]">Waiting for {modelName}</p>
          )}

          {answer.error && <TurnError answer={answer} modelName={modelName} isLast={isLast} />}
          {answer.finishReason === "cancelled" && <p className="mt-3 text-xs text-ink-3">Stopped</p>}
          {answer.finishReason === "length" && (
            <p className="mt-3 text-xs text-ink-3">
              The answer hit the maximum length. You can raise it in chat settings.
            </p>
          )}

          {/* Failed answers get their actions from the error notice instead. */}
          {!streaming && !answer.error && (
            <div className="mt-2 -ml-2 flex items-center gap-0.5">
              {answer.content && <CopyButton text={answer.content} label="Copy answer" />}
              {isLast && idle && (
                <IconButton label="Regenerate" onClick={() => regenerate()}>
                  <RotateCcw size={15} />
                </IconButton>
              )}
              <span
                className="ml-1.5 text-xs text-ink-3"
                title={answer.promptTokens !== null || answer.completionTokens !== null
                  ? `${answer.promptTokens ?? "?"} tokens in, ${answer.completionTokens ?? "?"} out`
                  : undefined}
              >
                {modelName}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
});

function EditMessage({ message, laterCount, onDone }: { message: Message; laterCount: number; onDone: () => void }) {
  const [text, setText] = useState(message.content);
  const [saving, setSaving] = useState(false);
  const editAndResend = useStore((s) => s.editAndResend);
  const input = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 400)}px`;
  }, [text]);

  useEffect(() => {
    const el = input.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const submit = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    const ok = await editAndResend(message.id, text);
    setSaving(false);
    if (ok) onDone();
  };

  return (
    <div className="rounded-[10px] border border-river bg-surface">
      <label htmlFor={`edit-${message.id}`} className="sr-only">
        Edit message
      </label>
      <textarea
        id={`edit-${message.id}`}
        ref={input}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onDone();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        className="block w-full resize-none bg-transparent px-3.5 pt-2.5 text-[15px] leading-6 focus:outline-none"
      />
      <div className="flex flex-wrap items-center gap-2 px-2 pb-2">
        <span className="flex-1 pl-1.5 text-xs text-ink-3">
          {laterCount > 0
            ? `Sending replaces the answer and removes ${laterCount === 1 ? "the message" : `the ${laterCount} messages`} after it.`
            : "Sending replaces the answer."}
        </span>
        <Button variant="quiet" onClick={onDone}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={!text.trim() || saving}>
          Send
        </Button>
      </div>
    </div>
  );
}

function ReasoningPanel({ answer }: { answer: Message }) {
  const thinking = answer.status === "streaming" && !answer.content;
  // `null` until the user toggles it: open while thinking, then fold away when the answer starts.
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? thinking;
  const body = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (thinking && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [answer.reasoning, thinking]);

  const ms = answer.reasoningMs ?? (answer.endedAt ? answer.endedAt - answer.createdAt : null);
  const secs = ms !== null ? Math.max(1, Math.round(ms / 1000)) : null;

  return (
    <div className="mb-4">
      <button
        type="button"
        aria-expanded={isOpen}
        onClick={() => setOpen(!isOpen)}
        className="-ml-1 flex items-center gap-1 rounded px-1 py-0.5 text-[13px] text-ink-2 hover:text-ink"
      >
        <ChevronRight size={14} className={`transition-transform ${isOpen ? "rotate-90" : ""}`} />
        <span className={thinking ? "thinking-label" : undefined}>
          {thinking ? "Thinking" : secs ? `Thought for ${secs}s` : "Thoughts"}
        </span>
      </button>
      {isOpen && (
        <div
          ref={body}
          className="mt-2 max-h-72 overflow-y-auto rounded-lg bg-sediment px-4 py-3 text-[13px] leading-[1.55] break-words whitespace-pre-wrap text-ink-2"
        >
          {answer.reasoning?.trim()}
        </div>
      )}
    </div>
  );
}

function TurnError({ answer, modelName, isLast }: { answer: Message; modelName: string; isLast: boolean }) {
  const error = answer.error!;
  const models = useStore((s) => s.models);
  const idle = useStore((s) => !chatBusy(s));
  const retryLast = useStore((s) => s.regenerate);
  const newChat = useStore((s) => s.newChat);
  const actionable = isLast && idle;

  const retry = (label = "Retry") => (
    <Button onClick={() => retryLast()}>
      <RotateCcw size={14} />
      {label}
    </Button>
  );

  switch (error.kind) {
    case "unauthorized":
    case "no_key":
      // The key screen takes over; after a new key is entered this turn can be retried.
      return <Notice className="mt-3" tone="error" title={errorTitle(error)} actions={actionable && retry()} />;
    case "rate_limited":
      return <RateLimited answer={answer} actionable={actionable} onRetry={() => retryLast()} />;
    case "model_unavailable": {
      const others = models.filter((m) => m.id !== answer.modelId).slice(0, 3);
      return (
        <Notice
          className="mt-3"
          tone="error"
          title={
            others.length
              ? `${errorTitle(error, modelName)} Try another model.`
              : errorTitle(error, modelName)
          }
          details={error.message}
          actions={
            actionable && (
              <>
                {others.map((m) => (
                  <Button key={m.id} onClick={() => retryLast(m.id)}>
                    Ask {m.displayName}
                  </Button>
                ))}
                {retry(others.length ? `Retry ${modelName}` : "Retry")}
              </>
            )
          }
        />
      );
    }
    case "context_length":
      return (
        <Notice
          className="mt-3"
          tone="error"
          title={errorTitle(error, modelName)}
          details={error.message}
          actions={actionable && <Button onClick={newChat}>New chat</Button>}
        />
      );
    case "stream_dropped":
    case "interrupted":
      return (
        <Notice
          className="mt-3"
          tone={answer.content ? "warn" : "error"}
          title={answer.content ? `${errorTitle(error)} What arrived is kept above.` : errorTitle(error)}
          details={error.kind === "interrupted" ? undefined : error.message}
          actions={actionable && retry("Regenerate")}
        />
      );
    default:
      return (
        <Notice
          className="mt-3"
          tone="error"
          title={errorTitle(error, modelName)}
          details={error.message}
          actions={actionable && retry()}
        />
      );
  }
}

function RateLimited({ answer, actionable, onRetry }: { answer: Message; actionable: boolean; onRetry: () => void }) {
  const until = (answer.endedAt ?? Date.now()) + (answer.error?.retry_after ?? 0) * 1000;
  const [now, setNow] = useState(Date.now);
  const left = Math.ceil((until - now) / 1000);

  useEffect(() => {
    if (left <= 0) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [left > 0]);

  return (
    <Notice
      className="mt-3"
      tone="warn"
      title={left > 0 ? `Too many requests. You can retry in ${left}s.` : "Too many requests. You can retry now."}
      details={answer.error?.message}
      actions={
        actionable && (
          <Button onClick={onRetry} disabled={left > 0}>
            <RotateCcw size={14} />
            Retry
          </Button>
        )
      }
    />
  );
}
