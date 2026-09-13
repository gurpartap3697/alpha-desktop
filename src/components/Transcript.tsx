import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowDown, ChevronRight, RotateCcw } from "lucide-react";
import { useStore, type Turn } from "../store";
import { errorTitle } from "../errors";
import { Markdown } from "./Markdown";
import { CopyButton } from "./CopyButton";
import { Banners } from "./Banners";
import { Button, IconButton, Notice } from "./ui";

export function Transcript() {
  const turns = useStore((s) => s.turns);
  const streaming = useStore((s) => s.requestId !== null);
  const scroller = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const count = turns.length;

  // Follow the answer as it streams unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned) el.scrollTop = el.scrollHeight;
  }, [turns, pinned]);

  // A new message always brings the view back to the bottom.
  useLayoutEffect(() => setPinned(true), [count]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 48);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="h-full overflow-y-auto px-6">
        <div className="mx-auto max-w-[44rem] pt-5 pb-10">
          <Banners />
          {count === 0 ? (
            <EmptyState />
          ) : (
            turns.map((t, i) => <TurnView key={t.id} turn={t} isLast={i === count - 1} />)
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
  const model = useStore((s) => s.models.find((m) => m.id === s.modelId));
  if (!model) return null;
  return (
    <div className="pt-[18vh]">
      <h2 className="font-serif text-[1.9rem] leading-tight font-[520] tracking-[-0.01em]">{model.displayName}</h2>
      <p className="mt-2 max-w-[34rem] text-[15px] leading-6 text-ink-2">
        {model.description ?? "Ask a question, paste some text to work on, or describe a problem."}
      </p>
      <p className="mt-5 text-[13px] text-ink-3">Chats aren't saved yet. Closing the app or starting a new chat clears this one.</p>
    </div>
  );
}

const TurnView = memo(function TurnView({ turn, isLast }: { turn: Turn; isLast: boolean }) {
  const modelName = useStore((s) => s.models.find((m) => m.id === turn.modelId)?.displayName ?? turn.modelId);
  const canRegenerate = useStore((s) => isLast && s.requestId === null);
  const retryLast = useStore((s) => s.retryLast);
  const streaming = turn.status === "streaming";

  return (
    <section className="mt-9 first:mt-4">
      <div className="border-l-2 border-river pl-3.5 text-[15px] leading-6 break-words whitespace-pre-wrap">{turn.user}</div>

      <div className="mt-5">
        {!!turn.dropped && (
          <p className="mb-3 text-xs text-ink-3">
            {turn.dropped === 1 ? "1 older message wasn't" : `${turn.dropped} older messages weren't`} sent, to fit{" "}
            {modelName}'s context window.
          </p>
        )}
        {turn.reasoning && <ReasoningPanel turn={turn} />}
        {turn.content ? (
          <Markdown text={turn.content} streaming={streaming} />
        ) : (
          streaming && !turn.reasoning && <p className="thinking-label text-[14px]">Waiting for {modelName}</p>
        )}

        {turn.error && <TurnError turn={turn} modelName={modelName} isLast={isLast} />}
        {turn.finishReason === "cancelled" && <p className="mt-3 text-xs text-ink-3">Stopped</p>}
        {turn.finishReason === "length" && (
          <p className="mt-3 text-xs text-ink-3">
            The answer hit the maximum length. You can raise it in chat settings.
          </p>
        )}

        {/* Failed turns get their actions from the error notice instead. */}
        {!streaming && !turn.error && (
          <div className="mt-2 -ml-2 flex items-center gap-0.5">
            {turn.content && <CopyButton text={turn.content} label="Copy answer" />}
            {canRegenerate && (
              <IconButton label="Regenerate" onClick={() => retryLast()}>
                <RotateCcw size={15} />
              </IconButton>
            )}
            <span
              className="ml-1.5 text-xs text-ink-3"
              title={turn.usage ? `${turn.usage.prompt_tokens ?? "?"} tokens in, ${turn.usage.completion_tokens ?? "?"} out` : undefined}
            >
              {modelName}
            </span>
          </div>
        )}
      </div>
    </section>
  );
});

function ReasoningPanel({ turn }: { turn: Turn }) {
  const thinking = turn.status === "streaming" && !turn.content;
  // `null` until the user toggles it: open while thinking, then fold away when the answer starts.
  const [open, setOpen] = useState<boolean | null>(null);
  const isOpen = open ?? thinking;
  const body = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (thinking && body.current) body.current.scrollTop = body.current.scrollHeight;
  }, [turn.reasoning, thinking]);

  const end = turn.reasoningEndedAt ?? turn.endedAt;
  const secs = end ? Math.max(1, Math.round((end - turn.startedAt) / 1000)) : null;

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
          {turn.reasoning.trim()}
        </div>
      )}
    </div>
  );
}

function TurnError({ turn, modelName, isLast }: { turn: Turn; modelName: string; isLast: boolean }) {
  const error = turn.error!;
  const models = useStore((s) => s.models);
  const idle = useStore((s) => s.requestId === null);
  const retryLast = useStore((s) => s.retryLast);
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
      return <RateLimited turn={turn} actionable={actionable} onRetry={() => retryLast()} />;
    case "model_unavailable": {
      const others = models.filter((m) => m.id !== turn.modelId).slice(0, 3);
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
      return (
        <Notice
          className="mt-3"
          tone={turn.content ? "warn" : "error"}
          title={turn.content ? `${errorTitle(error)} What arrived is kept above.` : errorTitle(error)}
          details={error.message}
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

function RateLimited({ turn, actionable, onRetry }: { turn: Turn; actionable: boolean; onRetry: () => void }) {
  const until = (turn.endedAt ?? Date.now()) + (turn.error?.retry_after ?? 0) * 1000;
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
      details={turn.error?.message}
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
