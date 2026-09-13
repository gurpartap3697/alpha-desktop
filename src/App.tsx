import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { chatBusy, useStore } from "./store";
import { errorTitle } from "./errors";
import { applyTheme } from "./theme";
import { useShortcuts } from "./shortcuts";
import { KeyScreen } from "./components/KeyScreen";
import { UpdateScreen } from "./components/UpdateScreen";
import { TopBar } from "./components/TopBar";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { Sidebar } from "./components/Sidebar";
import { SettingsDialog } from "./components/SettingsDialog";
import { Button, Delayed, IconButton, Notice, cx } from "./components/ui";

const SIDEBAR_KEY = "alph.sidebarOpen";
const PRUNE_EVERY_MS = 60 * 60 * 1000;

function useSidebar() {
  const [open, setOpen] = useState(() => {
    try {
      const saved = localStorage.getItem(SIDEBAR_KEY);
      if (saved !== null) return saved === "1";
    } catch {
      // Storage unavailable: fall through to the default.
    }
    return window.innerWidth >= 760;
  });
  const set = (value: boolean) => {
    setOpen(value);
    try {
      localStorage.setItem(SIDEBAR_KEY, value ? "1" : "0");
    } catch {
      // Not remembered; fine.
    }
  };
  return [open, set] as const;
}

export default function App() {
  const phase = useStore((s) => s.phase);
  const bootError = useStore((s) => s.bootError);
  const boot = useStore((s) => s.boot);
  const started = useRef(false);
  const [sidebarOpen, setSidebarOpen] = useSidebar();
  const theme = useStore((s) => (s.settingsLoaded ? s.settings.theme : null));
  const retentionDays = useStore((s) => s.settings.retentionDays);

  useEffect(() => {
    if (theme) applyTheme(theme);
  }, [theme]);

  // Startup auto-delete happens in the Rust core; this covers an app left open for days.
  useEffect(() => {
    if (phase !== "ready" || retentionDays === null) return;
    const t = setInterval(() => void useStore.getState().pruneHistory(), PRUNE_EVERY_MS);
    return () => clearInterval(t);
  }, [phase, retentionDays]);

  useShortcuts(
    {
      newChat: () => {
        const s = useStore.getState();
        if (s.chat.id !== null || s.chat.messages.length) s.newChat();
        focusById("composer");
      },
      focusComposer: () => focusById("composer"),
      searchChats: () => {
        setSidebarOpen(true);
        // The sidebar may only now be rendering.
        requestAnimationFrame(() => focusById("chat-search", true));
      },
      settings: () => useStore.getState().setSettingsOpen(true),
      stop: () => {
        const s = useStore.getState();
        if (chatBusy(s)) s.stop();
      },
    },
    phase === "ready",
  );

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void boot();
  }, [boot]);

  // Coming back to the window (e.g. after connecting to VPN) retries a failed model list.
  useEffect(() => {
    const onFocus = () => {
      const s = useStore.getState();
      if (s.phase === "ready" && s.modelsStatus === "error") void s.loadModels();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  if (bootError) {
    return (
      <main className="flex h-full px-6">
        <Notice
          className="m-auto w-full max-w-md"
          tone="error"
          title={`Alph couldn't start. ${errorTitle(bootError)}`}
          details={bootError.message}
          actions={<Button onClick={() => void boot()}>Try again</Button>}
        />
      </main>
    );
  }

  switch (phase) {
    case "loading":
      return (
        <Delayed ms={400}>
          <main className="flex h-full" aria-busy="true" aria-label="Starting Alph">
            <p className="m-auto animate-pulse font-serif text-[2rem] font-[560] tracking-[-0.02em] text-ink-3">Alph</p>
          </main>
        </Delayed>
      );
    case "update_required":
      return <UpdateScreen />;
    case "signed_out":
      return <KeyScreen />;
    case "ready":
      return (
        <div className="flex h-full">
          {sidebarOpen && <Sidebar onHide={() => setSidebarOpen(false)} />}
          <div className="flex min-w-0 flex-1 flex-col">
            <TopBar sidebarOpen={sidebarOpen} onShowSidebar={() => setSidebarOpen(true)} />
            <Transcript />
            <Composer />
          </div>
          <SettingsDialog />
          <ToastView />
        </div>
      );
  }
}

function focusById(id: string, select = false) {
  const el = document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | null;
  el?.focus();
  if (select) el?.select();
}

function ToastView() {
  const toast = useStore((s) => s.toast);
  if (!toast) return null;
  const close = () => useStore.setState({ toast: null });
  return (
    <div
      role={toast.tone === "error" ? "alert" : "status"}
      className={cx(
        "fixed bottom-24 left-1/2 z-50 flex max-w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-2 rounded-[10px] border py-2 pr-1.5 pl-3.5 text-[13px] shadow-[0_8px_30px_-12px_rgb(0_0_0/0.35)]",
        toast.tone === "error" ? "border-brick/40 bg-brick-soft" : "border-line bg-surface",
      )}
    >
      <div className="min-w-0 py-0.5 leading-5">
        <div className="break-words">{toast.text}</div>
        {toast.details && <div className="mt-0.5 font-mono text-xs break-words text-ink-2">{toast.details}</div>}
      </div>
      <IconButton label="Dismiss" onClick={close} className="size-7 shrink-0">
        <X size={14} />
      </IconButton>
    </div>
  );
}
