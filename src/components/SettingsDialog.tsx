import { useEffect, useId, useState, type ReactNode } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dialog from "@radix-ui/react-dialog";
import { FolderOpen, Keyboard, MessageSquare, History, Palette, UserRound, X } from "lucide-react";
import { historyInfo, historyReveal, toAppError, type HistoryInfo, type Theme } from "../api";
import { useStore } from "../store";
import { errorTitle } from "../errors";
import { isMac, SHORTCUTS } from "../shortcuts";
import { MaxTokensField, SystemPromptField, TemperatureField } from "./ParamFields";
import { Button, IconButton, Kbd, Notice, Skeleton, cx } from "./ui";

type Section = "appearance" | "chats" | "history" | "account" | "shortcuts";

const SECTIONS: { id: Section; label: string; icon: ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette size={15} /> },
  { id: "chats", label: "New chats", icon: <MessageSquare size={15} /> },
  { id: "history", label: "History", icon: <History size={15} /> },
  { id: "account", label: "Account", icon: <UserRound size={15} /> },
  { id: "shortcuts", label: "Keyboard", icon: <Keyboard size={15} /> },
];

export function SettingsDialog() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const settingsError = useStore((s) => s.settingsError);
  const [section, setSection] = useState<Section>("appearance");
  const tabsId = useId();

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            // Start on the section list rather than the close button.
            e.preventDefault();
            document.getElementById(`${tabsId}-${section}`)?.focus();
          }}
          className="fixed top-1/2 left-1/2 z-40 flex h-[min(40rem,calc(100vh-2rem))] w-[min(48rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-line bg-surface text-ink shadow-[0_20px_60px_-20px_rgb(0_0_0/0.45)] focus:outline-none"
        >
          <div className="flex h-12 shrink-0 items-center border-b border-line pr-2 pl-5">
            <Dialog.Title className="flex-1 text-[15px] font-semibold">Settings</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label="Close settings">
                <X size={16} />
              </IconButton>
            </Dialog.Close>
          </div>

          <div className="flex min-h-0 flex-1">
            <div role="tablist" aria-orientation="vertical" className="w-44 shrink-0 space-y-0.5 border-r border-line p-2">
              {SECTIONS.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  id={`${tabsId}-${s.id}`}
                  aria-selected={section === s.id}
                  aria-controls={`${tabsId}-panel`}
                  onClick={() => setSection(s.id)}
                  onKeyDown={(e) => {
                    const i = SECTIONS.findIndex((x) => x.id === section);
                    const next = e.key === "ArrowDown" ? i + 1 : e.key === "ArrowUp" ? i - 1 : null;
                    if (next === null) return;
                    e.preventDefault();
                    const target = SECTIONS[(next + SECTIONS.length) % SECTIONS.length];
                    setSection(target.id);
                    document.getElementById(`${tabsId}-${target.id}`)?.focus();
                  }}
                  tabIndex={section === s.id ? 0 : -1}
                  className={cx(
                    "flex h-8 w-full items-center gap-2 rounded-[7px] px-2.5 text-left text-[13px]",
                    section === s.id ? "bg-river-soft text-ink" : "text-ink-2 hover:bg-river-soft/60 hover:text-ink",
                  )}
                >
                  <span className="text-ink-3">{s.icon}</span>
                  {s.label}
                </button>
              ))}
            </div>

            <div
              role="tabpanel"
              id={`${tabsId}-panel`}
              aria-labelledby={`${tabsId}-${section}`}
              className="min-w-0 flex-1 overflow-y-auto px-6 py-5 text-[13px]"
            >
              {settingsError && section !== "shortcuts" && section !== "account" && (
                <Notice
                  className="mb-5"
                  tone="error"
                  title={`${errorTitle(settingsError)} Changes here may not be saved.`}
                  details={settingsError.message}
                />
              )}
              {section === "appearance" && <AppearanceSection />}
              {section === "chats" && <NewChatsSection />}
              {section === "history" && <HistorySection />}
              {section === "account" && <AccountSection />}
              {section === "shortcuts" && <ShortcutsSection />}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Heading({ children, help }: { children: ReactNode; help?: ReactNode }) {
  return (
    <div className="mb-4">
      <h2 className="text-[15px] font-semibold">{children}</h2>
      {help && <p className="mt-1 leading-5 text-ink-2">{help}</p>}
    </div>
  );
}

const select =
  "mt-2 block h-8 w-full max-w-72 rounded-[7px] border border-line bg-ground px-2 text-[13px] focus:border-river focus:outline-none";

// ---- Appearance ----

const THEMES: { id: Theme; label: string; swatch: [string, string] }[] = [
  { id: "system", label: "Match system", swatch: ["#eef2f1", "#0f1a1c"] },
  { id: "light", label: "Light", swatch: ["#eef2f1", "#eef2f1"] },
  { id: "dark", label: "Dark", swatch: ["#0f1a1c", "#0f1a1c"] },
];

function AppearanceSection() {
  const theme = useStore((s) => s.settings.theme);
  const update = useStore((s) => s.updateAppSettings);
  return (
    <>
      <Heading>Appearance</Heading>
      <div role="radiogroup" aria-label="Theme" className="flex flex-wrap gap-3">
        {THEMES.map((t) => (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={theme === t.id}
            onClick={() => update({ theme: t.id })}
            className={cx(
              "w-32 rounded-[10px] border p-2 text-left",
              theme === t.id ? "border-river ring-1 ring-river" : "border-line hover:border-ink-3",
            )}
          >
            <span
              aria-hidden
              className="block h-14 rounded-[6px] border border-line"
              style={{ background: `linear-gradient(135deg, ${t.swatch[0]} 50%, ${t.swatch[1]} 50%)` }}
            />
            <span className="mt-2 block px-0.5">{t.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}

// ---- New chats ----

function NewChatsSection() {
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const modelsStatus = useStore((s) => s.modelsStatus);
  const update = useStore((s) => s.updateAppSettings);
  const modelId = useId();
  const thinkingId = useId();
  const { params } = settings;
  const setParams = (p: Partial<typeof params>) => update({ params: { ...params, ...p } });
  const missing = settings.defaultModel && modelsStatus === "ok" && !models.some((m) => m.id === settings.defaultModel);
  const model = models.find((m) => m.id === settings.defaultModel);

  return (
    <>
      <Heading help="Chats you start from now on begin with these. A chat's own settings can still be changed from the chat.">
        New chats
      </Heading>
      <div className="max-w-[30rem] space-y-6">
        <div>
          <label htmlFor={modelId} className="font-medium">
            Model
          </label>
          <select
            id={modelId}
            value={settings.defaultModel ?? ""}
            onChange={(e) => update({ defaultModel: e.target.value || null })}
            className={select}
          >
            <option value="">The one used most recently</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.displayName}
              </option>
            ))}
            {settings.defaultModel && !model && (
              <option value={settings.defaultModel}>{settings.defaultModel}</option>
            )}
          </select>
          {missing && (
            <p className="mt-1.5 text-xs text-amber">This model isn't available right now, so new chats use another one.</p>
          )}
        </div>

        <div>
          <label htmlFor={thinkingId} className="font-medium">
            Thinking
          </label>
          <p className="mt-0.5 text-ink-2">For models that can think before answering. Slower, better for hard problems.</p>
          <select
            id={thinkingId}
            value={params.reasoning === null ? "" : params.reasoning ? "on" : "off"}
            onChange={(e) => setParams({ reasoning: e.target.value === "" ? null : e.target.value === "on" })}
            className={select}
          >
            <option value="">Each model's default</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </div>

        <TemperatureField
          value={params.temperature}
          fallback={model?.temperature ?? 0.7}
          onChange={(temperature) => setParams({ temperature })}
        />
        <MaxTokensField
          value={params.maxTokens}
          placeholder="Model default"
          onChange={(maxTokens) => setParams({ maxTokens })}
        />
        <div className="-mt-3">
          <Button
            variant="quiet"
            className="-ml-3"
            disabled={params.temperature === null && params.maxTokens === null}
            onClick={() => setParams({ temperature: null, maxTokens: null })}
          >
            Use model defaults
          </Button>
        </div>

        <SystemPromptField
          value={settings.systemPrompt ?? ""}
          onChange={(systemPrompt) => update({ systemPrompt: systemPrompt || null })}
          help="Instructions every new chat starts with."
          rows={5}
        />
      </div>
    </>
  );
}

// ---- History ----

const RETENTION_PRESETS = [1, 7, 30, 90, 365];

const days = (n: number) => (n === 1 ? "1 day" : n === 365 ? "1 year" : `${n} days`);
const chats = (n: number) => (n === 1 ? "1 chat" : `${n} chats`);

const revealLabel = isMac ? "Show in Finder" : /Win/.test(navigator.userAgent) ? "Show in Explorer" : "Show in folder";

function HistorySection() {
  const retention = useStore((s) => s.settings.retentionDays);
  const conversationCount = useStore((s) => s.conversations.length);
  const setRetention = useStore((s) => s.setRetention);
  const showToast = useStore((s) => s.showToast);
  const [info, setInfo] = useState<HistoryInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [custom, setCustom] = useState(retention !== null && !RETENTION_PRESETS.includes(retention));
  const [customDays, setCustomDays] = useState(retention ? String(retention) : "");
  /** A change that would delete chats now, waiting for confirmation. */
  const [pending, setPending] = useState<{ days: number; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const retentionId = useId();

  useEffect(() => {
    historyInfo().then(
      (i) => {
        setInfo(i);
        setInfoError(null);
      },
      (e) => setInfoError(toAppError(e).message),
    );
  }, [conversationCount]);

  const apply = async (value: number | null) => {
    setBusy(true);
    const deleted = await setRetention(value);
    setBusy(false);
    setPending(null);
    if (deleted) showToast({ tone: "info", text: `Deleted ${chats(deleted)} with no activity in the last ${days(value!)}.` });
  };

  const choose = async (value: number | null) => {
    setPending(null);
    if (value === retention) return;
    if (value === null) return apply(null);
    setBusy(true);
    try {
      const { inactive } = await historyInfo(value);
      setBusy(false);
      if (inactive) setPending({ days: value, count: inactive });
      else await apply(value);
    } catch (e) {
      setBusy(false);
      showToast({ tone: "error", text: "Couldn't check chat history.", details: toAppError(e).message });
    }
  };

  const customValue = Math.floor(Number(customDays));
  const customValid = customValue >= 1 && customValue <= 3650;

  return (
    <>
      <Heading help="Chats are saved only on this device.">History</Heading>

      <div className="max-w-[30rem] space-y-7">
        <div>
          <div className="font-medium">Where chats are stored</div>
          {info ? (
            <>
              <p className="mt-1 font-mono text-xs leading-5 break-all text-ink-2">{info.path}</p>
              <div className="mt-2 flex items-center gap-3">
                <Button
                  onClick={() =>
                    historyReveal().catch((e) =>
                      showToast({ tone: "error", text: "Couldn't open the folder.", details: toAppError(e).message }),
                    )
                  }
                >
                  <FolderOpen size={14} />
                  {revealLabel}
                </Button>
                <span className="text-ink-3">{chats(info.conversations)}</span>
              </div>
            </>
          ) : infoError ? (
            <p className="mt-1 text-brick">{infoError}</p>
          ) : (
            <Skeleton className="mt-2 h-4 w-72" />
          )}
        </div>

        <div>
          <label htmlFor={retentionId} className="font-medium">
            Delete chats automatically
          </label>
          <p className="mt-0.5 text-ink-2">Chats with no new messages for this long are deleted.</p>
          <select
            id={retentionId}
            disabled={busy}
            value={
              pending
                ? RETENTION_PRESETS.includes(pending.days) ? pending.days : "pending"
                : custom ? "custom" : (retention ?? "never")
            }
            onChange={(e) => {
              const v = e.target.value;
              if (v === "custom") {
                setCustom(true);
                setPending(null);
                return;
              }
              setCustom(false);
              void choose(v === "never" ? null : Number(v));
            }}
            className={select}
          >
            <option value="never">Never</option>
            {RETENTION_PRESETS.map((d) => (
              <option key={d} value={d}>
                After {days(d)}
              </option>
            ))}
            <option value="custom">Custom…</option>
            {pending && !RETENTION_PRESETS.includes(pending.days) && <option value="pending">After {days(pending.days)}</option>}
          </select>

          {custom && !pending && (
            <form
              className="mt-2 flex items-center gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (customValid) void choose(customValue);
              }}
            >
              <label className="sr-only" htmlFor={`${retentionId}-days`}>
                Days
              </label>
              <input
                id={`${retentionId}-days`}
                type="number"
                min={1}
                max={3650}
                value={customDays}
                onChange={(e) => setCustomDays(e.target.value)}
                autoFocus
                className="h-8 w-24 rounded-[7px] border border-line bg-ground px-2.5 tabular-nums focus:border-river focus:outline-none"
              />
              <span className="text-ink-2">days</span>
              <Button type="submit" disabled={!customValid || busy || customValue === retention}>
                Apply
              </Button>
            </form>
          )}

          {retention !== null && !pending && !busy && (
            <p className="mt-2 text-xs leading-5 text-ink-3">
              Chats with no new messages for {days(retention)} are deleted when Alph starts, and every hour while it's open.
            </p>
          )}

          {pending && (
            <Notice
              className="mt-3"
              tone="warn"
              title={`${chats(pending.count)} ${pending.count === 1 ? "has" : "have"} had no activity in the last ${days(pending.days)} and will be deleted now. This can't be undone.`}
              actions={
                <>
                  <Button variant="danger" disabled={busy} onClick={() => void apply(pending.days)}
                  >
                    Delete {chats(pending.count)}
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setPending(null);
                      setCustom(retention !== null && !RETENTION_PRESETS.includes(retention));
                    }}
                  >
                    Cancel
                  </Button>
                </>
              }
            />
          )}
        </div>

        <div className="border-t border-line pt-5">
          <div className="font-medium">Delete all chats</div>
          <p className="mt-0.5 text-ink-2">Removes every chat and message from this device. Settings and your key are kept.</p>
          <DeleteAll count={info?.conversations ?? conversationCount} />
        </div>
      </div>
    </>
  );
}

function DeleteAll({ count }: { count: number }) {
  const deleteAllHistory = useStore((s) => s.deleteAllHistory);
  const showToast = useStore((s) => s.showToast);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <AlertDialog.Root open={open} onOpenChange={(o) => !busy && setOpen(o)}>
      <AlertDialog.Trigger asChild>
        <Button variant="danger-outline" className="mt-3" disabled={count === 0}>
          Delete all chats…
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 text-ink shadow-[0_20px_60px_-20px_rgb(0_0_0/0.45)] focus:outline-none">
          <AlertDialog.Title className="text-[15px] font-semibold">Delete all {chats(count)}?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[13px] leading-5 text-ink-2">
            Every chat and message will be removed from this device, including answers still being written. This can't be
            undone.
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button disabled={busy}>Cancel</Button>
            </AlertDialog.Cancel>
            <Button
              variant="danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const ok = await deleteAllHistory();
                setBusy(false);
                setOpen(false);
                if (ok) showToast({ tone: "info", text: "All chats were deleted." });
              }}
            >
              {busy ? "Deleting…" : "Delete all"}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

// ---- Account ----

function AccountSection() {
  const auth = useStore((s) => s.auth);
  const config = useStore((s) => s.config);
  const signOut = useStore((s) => s.signOut);
  const setOpen = useStore((s) => s.setSettingsOpen);
  if (!auth) return null;

  const storage =
    auth.storage === "file"
      ? "In a private file in Alph's data folder, because no system keychain was found"
      : "In the system keychain";
  const source = config && {
    remote: "Up to date",
    cache: "From a saved copy, because the server's copy couldn't be loaded",
    builtin: "Unavailable, so defaults are used",
  }[config.source];

  const row = (label: string, value: ReactNode, title?: string) => (
    <div className="grid grid-cols-[9rem_1fr] gap-3 py-2">
      <dt className="text-ink-2">{label}</dt>
      <dd className="min-w-0 break-words" title={title}>
        {value}
      </dd>
    </div>
  );

  return (
    <>
      <Heading>Account</Heading>
      <dl className="max-w-[32rem] divide-y divide-line border-y border-line">
        {row("Model server", <span className="font-mono text-xs">{auth.gatewayUrl}</span>)}
        {row("API key", storage)}
        {source && row("Model details", source, config?.fetchError ?? undefined)}
        {row("App version", `Alph ${auth.appVersion}`)}
      </dl>
      <div className="mt-5">
        <p className="leading-5 text-ink-2">Signing out removes the key from this device. Your chats stay.</p>
        <Button
          className="mt-3"
          onClick={() => {
            setOpen(false);
            void signOut();
          }}
        >
          Sign out and remove key
        </Button>
      </div>
    </>
  );
}

// ---- Keyboard ----

function ShortcutsSection() {
  return (
    <>
      <Heading>Keyboard shortcuts</Heading>
      <dl className="max-w-[26rem] divide-y divide-line border-y border-line">
        {[
          ...SHORTCUTS,
          { id: "send", label: "Send the message", keys: ["Enter"] },
          { id: "newline", label: "New line in a message", keys: ["Shift", "Enter"] },
        ].map((s) => (
          <div key={s.id} className="flex items-center justify-between py-2">
            <dt>{s.label}</dt>
            <dd>
              <Kbd keys={s.keys} />
            </dd>
          </div>
        ))}
      </dl>
    </>
  );
}
