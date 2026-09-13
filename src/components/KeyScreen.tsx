import { useState, type FormEvent } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useStore } from "../store";
import { errorTitle } from "../errors";
import { Button, IconButton, Notice } from "./ui";

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function KeyScreen() {
  const auth = useStore((s) => s.auth);
  const keyError = useStore((s) => s.keyError);
  const keyRejected = useStore((s) => s.keyRejected);
  const submitKey = useStore((s) => s.submitKey);
  const [key, setKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!key.trim() || busy) return;
    setBusy(true);
    await submitKey(key);
    setBusy(false);
    // Clear the field only once the key is accepted (the screen goes away on success).
  }

  // A rejected key typed here reads differently from a saved key that stopped working.
  const error = keyError && {
    title: keyError.kind === "unauthorized" && !keyRejected
      ? "The server didn't accept that key. Check it and try again."
      : errorTitle(keyError),
    details: keyError.message,
  };

  return (
    <main className="flex h-full overflow-y-auto px-6">
      <div className="m-auto w-full max-w-[26rem] py-12">
        <h1 className="font-serif text-[2.75rem] leading-none font-[560] tracking-[-0.02em]">Alpha</h1>
        <p className="mt-3 text-[15px] text-ink-2">
          Chat with your organization's models on {auth ? hostOf(auth.gatewayUrl) : "the model server"}.
        </p>

        <form onSubmit={submit} className="mt-9">
          <label htmlFor="api-key" className="block text-[13px] font-medium">
            API key
          </label>
          <p id="api-key-help" className="mt-1 text-[13px] leading-5 text-ink-2">
            Paste the key your administrator sent you. It's saved in your system keychain, not in the app.
          </p>
          <div className="mt-3 flex gap-2">
            <div className="relative flex-1">
              <input
                id="api-key"
                type={visible ? "text" : "password"}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                autoFocus
                aria-describedby="api-key-help"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="sk-…"
                className="h-9 w-full rounded-[7px] border border-line bg-surface pr-9 pl-3 font-mono text-[13px] placeholder:text-ink-3 focus:border-river focus:outline-none"
              />
              <IconButton
                label={visible ? "Hide key" : "Show key"}
                onClick={() => setVisible((v) => !v)}
                className="absolute top-0.5 right-0.5"
              >
                {visible ? <EyeOff size={15} /> : <Eye size={15} />}
              </IconButton>
            </div>
            <Button type="submit" variant="primary" className="h-9 px-4" disabled={!key.trim() || busy}>
              {busy ? "Checking…" : "Connect"}
            </Button>
          </div>
        </form>

        <div className="mt-5 space-y-3">
          {keyRejected && (
            <Notice
              tone="error"
              title="The server rejected your saved key. It may have been revoked. Paste a new key to continue."
              details={keyError?.message}
            />
          )}
          {error && !keyRejected && <Notice tone="error" title={error.title} details={error.details} />}
          {auth?.storageError && !keyError && (
            <Notice
              tone="warn"
              title="Couldn't read a saved key from the system keychain, so you'll need to enter it again."
              details={auth.storageError}
            />
          )}
        </div>

        {auth && (
          <p className="mt-12 text-xs leading-5 text-ink-3">
            Alpha {auth.appVersion}
            <br />
            {auth.gatewayUrl}
          </p>
        )}
      </div>
    </main>
  );
}
