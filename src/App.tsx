import { useEffect, useRef } from "react";
import { useStore } from "./store";
import { errorTitle } from "./errors";
import { KeyScreen } from "./components/KeyScreen";
import { UpdateScreen } from "./components/UpdateScreen";
import { TopBar } from "./components/TopBar";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { Button, Notice } from "./components/ui";

export default function App() {
  const phase = useStore((s) => s.phase);
  const bootError = useStore((s) => s.bootError);
  const boot = useStore((s) => s.boot);
  const started = useRef(false);

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
      return null;
    case "update_required":
      return <UpdateScreen />;
    case "signed_out":
      return <KeyScreen />;
    case "ready":
      return (
        <div className="flex h-full flex-col">
          <TopBar />
          <Transcript />
          <Composer />
        </div>
      );
  }
}
