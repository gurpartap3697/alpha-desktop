// Phase 0 spike UI: proves key validation, model listing and Rust → Channel streaming
// against the gateway on each OS. Replaced by the real chat UI in Phase 1.
import { useEffect, useRef, useState } from "react";
import {
  AppError,
  AuthStatus,
  ChatMessage,
  StreamEvent,
  Usage,
  authClear,
  authSetKey,
  authStatus,
  chatCancel,
  chatStream,
  isAppError,
  listModels,
} from "./api";
import "./App.css";

interface Turn {
  user: string;
  reasoning: string;
  content: string;
  usage?: Usage;
  finishReason?: string | null;
  error?: AppError;
  model: string;
  startedAt: number;
  firstTokenAt?: number;
  endedAt?: number;
}

const toError = (e: unknown): AppError =>
  isAppError(e) ? e : { kind: "protocol", message: String(e) };

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [authError, setAuthError] = useState<AppError | null>(null);
  const [busy, setBusy] = useState(false);

  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState("");
  const [extraBody, setExtraBody] = useState("");
  const [temperature, setTemperature] = useState("0.7");
  const [maxTokens, setMaxTokens] = useState("1024");
  const [prompt, setPrompt] = useState("");

  const [turns, setTurns] = useState<Turn[]>([]);
  const [requestId, setRequestId] = useState<string | null>(null);

  // Deltas are buffered and flushed once per animation frame instead of re-rendering per token.
  const pending = useRef({ reasoning: "", content: "" });
  const frame = useRef<number | null>(null);

  useEffect(() => {
    authStatus().then(setStatus).catch((e) => setAuthError(toError(e)));
  }, []);

  const updateLast = (fn: (t: Turn) => Turn) =>
    setTurns((ts) => (ts.length ? [...ts.slice(0, -1), fn(ts[ts.length - 1])] : ts));

  const flush = () => {
    frame.current = null;
    const { reasoning, content } = pending.current;
    if (!reasoning && !content) return;
    pending.current = { reasoning: "", content: "" };
    updateLast((t) => ({
      ...t,
      reasoning: t.reasoning + reasoning,
      content: t.content + content,
      firstTokenAt: t.firstTokenAt ?? performance.now(),
    }));
  };

  const scheduleFlush = () => {
    if (frame.current === null) frame.current = requestAnimationFrame(flush);
  };

  async function refreshModels() {
    try {
      const ids = await listModels();
      setModels(ids);
      setModel((m) => (ids.includes(m) ? m : (ids[0] ?? "")));
    } catch (e) {
      setAuthError(toError(e));
    }
  }

  async function submitKey(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setAuthError(null);
    try {
      await authSetKey(keyInput);
      setKeyInput("");
      setStatus(await authStatus());
      await refreshModels();
    } catch (err) {
      setAuthError(toError(err));
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await authClear();
    setModels([]);
    setTurns([]);
    setStatus(await authStatus());
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || !model || requestId) return;

    let extra: Record<string, unknown> | undefined;
    if (extraBody.trim()) {
      try {
        extra = JSON.parse(extraBody);
      } catch {
        alert("Request body overrides must be valid JSON");
        return;
      }
    }

    // History: completed turns only; reasoning is never sent back.
    const history: ChatMessage[] = turns.flatMap((t) =>
      t.error ? [] : [
        { role: "user" as const, content: t.user },
        { role: "assistant" as const, content: t.content },
      ],
    );
    const user = prompt;
    const id = crypto.randomUUID();
    setPrompt("");
    setRequestId(id);
    pending.current = { reasoning: "", content: "" };
    setTurns((ts) => [...ts, { user, reasoning: "", content: "", model, startedAt: performance.now() }]);

    const onEvent = (ev: StreamEvent) => {
      switch (ev.type) {
        case "content_delta":
          pending.current.content += ev.text;
          scheduleFlush();
          break;
        case "reasoning_delta":
          pending.current.reasoning += ev.text;
          scheduleFlush();
          break;
        case "usage":
          updateLast((t) => ({ ...t, usage: ev.usage }));
          break;
        case "done":
          flush();
          updateLast((t) => ({ ...t, finishReason: ev.finish_reason, endedAt: performance.now() }));
          break;
        case "error": {
          flush();
          const { type: _type, ...err } = ev;
          updateLast((t) => ({ ...t, error: err, endedAt: performance.now() }));
          if (err.kind === "unauthorized") setStatus((s) => (s ? { ...s, hasKey: false } : s));
          break;
        }
      }
    };

    try {
      await chatStream(
        id,
        {
          model,
          messages: [...history, { role: "user", content: user }],
          temperature: temperature ? Number(temperature) : undefined,
          maxTokens: maxTokens ? Number(maxTokens) : undefined,
          extraBody: extra,
        },
        onEvent,
      );
    } catch (err) {
      updateLast((t) => ({ ...t, error: toError(err), endedAt: performance.now() }));
    } finally {
      setRequestId(null);
    }
  }

  if (!status) {
    return <main className="app">{authError ? <ErrorBox error={authError} /> : "Loading…"}</main>;
  }

  return (
    <main className="app">
      <header className="bar">
        <strong>Alph</strong>
        <span className="muted">v{status.appVersion} · {status.gatewayUrl}</span>
        {status.hasKey && <button onClick={signOut}>Clear key</button>}
      </header>

      {!status.hasKey ? (
        <form className="card" onSubmit={submitKey}>
          <label htmlFor="key">Gateway API key</label>
          <input
            id="key"
            type="password"
            autoComplete="off"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="sk-…"
          />
          <button type="submit" disabled={busy || !keyInput.trim()}>
            {busy ? "Checking…" : "Connect"}
          </button>
          {authError && <ErrorBox error={authError} />}
        </form>
      ) : (
        <>
          <section className="controls">
            <label>
              Model
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {models.length === 0 && <option value="">(none)</option>}
                {models.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
            <button onClick={refreshModels}>↻</button>
            <label>
              Temp
              <input className="num" value={temperature} onChange={(e) => setTemperature(e.target.value)} />
            </label>
            <label>
              Max tokens
              <input className="num" value={maxTokens} onChange={(e) => setMaxTokens(e.target.value)} />
            </label>
            <button onClick={() => setTurns([])} disabled={!!requestId}>Clear chat</button>
          </section>
          <details className="overrides">
            <summary>Request body overrides (JSON) — e.g. reasoning on/off</summary>
            <textarea
              rows={3}
              value={extraBody}
              onChange={(e) => setExtraBody(e.target.value)}
              placeholder='{"chat_template_kwargs": {"enable_thinking": false}}'
            />
          </details>
          {authError && <ErrorBox error={authError} />}

          <section className="transcript">
            {turns.map((t, i) => <TurnView key={i} turn={t} />)}
          </section>

          <form className="composer" onSubmit={send}>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                }
              }}
              placeholder="Message (Enter to send, Shift+Enter for newline)"
            />
            {requestId ? (
              <button type="button" onClick={() => chatCancel(requestId)}>Stop</button>
            ) : (
              <button type="submit" disabled={!prompt.trim() || !model}>Send</button>
            )}
          </form>
        </>
      )}
    </main>
  );
}

function TurnView({ turn: t }: { turn: Turn }) {
  const ttft = t.firstTokenAt ? ((t.firstTokenAt - t.startedAt) / 1000).toFixed(2) : null;
  const secs = t.endedAt && t.firstTokenAt ? (t.endedAt - t.firstTokenAt) / 1000 : null;
  const tps = secs && t.usage?.completion_tokens ? (t.usage.completion_tokens / secs).toFixed(1) : null;
  return (
    <article className="turn">
      <div className="user">{t.user}</div>
      {t.reasoning && (
        <details className="reasoning" open={!t.content}>
          <summary>Thinking ({t.reasoning.length} chars)</summary>
          <pre>{t.reasoning}</pre>
        </details>
      )}
      <pre className="assistant">{t.content}{!t.endedAt && "▍"}</pre>
      {t.error && <ErrorBox error={t.error} />}
      <div className="meta muted">
        {t.model}
        {ttft && ` · first token ${ttft}s`}
        {tps && ` · ${tps} tok/s`}
        {t.usage && ` · ${t.usage.prompt_tokens ?? "?"} in / ${t.usage.completion_tokens ?? "?"} out`}
        {t.finishReason !== undefined && ` · finish: ${t.finishReason ?? "—"}`}
      </div>
    </article>
  );
}

function ErrorBox({ error }: { error: AppError }) {
  return (
    <div className="error">
      <strong>{error.kind}</strong>
      {error.retry_after ? ` (retry in ${error.retry_after}s)` : ""}: {error.message}
    </div>
  );
}
