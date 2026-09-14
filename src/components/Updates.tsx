import { useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useStore } from "../store";
import { Button, type Variant } from "./ui";

/** Where the publish script puts the current installers (gateway/scripts/publish_release.py). */
export const downloadPageUrl = (gatewayUrl: string) => `${gatewayUrl.replace(/\/+$/, "")}/app/download/`;

export function DownloadPageLink() {
  const gatewayUrl = useStore((s) => s.auth?.gatewayUrl);
  if (!gatewayUrl) return <>the download page</>;
  const url = downloadPageUrl(gatewayUrl);
  return (
    <a
      href={url}
      className="text-river underline underline-offset-2"
      onClick={(e) => {
        e.preventDefault();
        void openUrl(url);
      }}
    >
      {url}
    </a>
  );
}

const megabytes = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`;

export function UpdateProgress() {
  const progress = useStore((s) => s.update.progress);
  const version = useStore((s) => s.update.info?.version);
  const { downloaded = 0, total = null } = progress ?? {};
  const percent = total ? Math.min(100, Math.round((downloaded / total) * 100)) : null;
  return (
    <div>
      <div className="flex justify-between text-[13px] text-ink-2">
        <span>Downloading Alpha {version}…</span>
        <span className="tabular-nums">{total ? `${megabytes(downloaded)} of ${megabytes(total)}` : megabytes(downloaded)}</span>
      </div>
      <div
        role="progressbar"
        aria-label="Download progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent ?? undefined}
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-river-soft"
      >
        <div
          className={percent === null ? "h-full w-1/3 animate-pulse rounded-full bg-river" : "h-full rounded-full bg-river transition-[width]"}
          style={percent === null ? undefined : { width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** Installs the downloaded update. Asks first if an answer is still being written, since restarting stops it. */
export function RestartButton({ variant = "primary", className }: { variant?: Variant; className?: string }) {
  const installing = useStore((s) => s.update.status === "installing");
  const answering = useStore((s) => Object.keys(s.streams).length > 0);
  const install = useStore((s) => s.installUpdate);
  const [confirming, setConfirming] = useState(false);
  const label = installing ? "Restarting…" : "Restart to update";

  if (!answering) {
    return (
      <Button variant={variant} className={className} disabled={installing} onClick={() => void install()}>
        {label}
      </Button>
    );
  }
  return (
    <AlertDialog.Root open={confirming} onOpenChange={setConfirming}>
      <AlertDialog.Trigger asChild>
        <Button variant={variant} className={className} disabled={installing}>
          {label}
        </Button>
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 text-ink shadow-[0_20px_60px_-20px_rgb(0_0_0/0.45)] focus:outline-none">
          <AlertDialog.Title className="text-[15px] font-semibold">Stop the answer and restart?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[13px] leading-5 text-ink-2">
            An answer is still being written. Restarting stops it and keeps the text written so far, which you can
            regenerate after the update.
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button>Cancel</Button>
            </AlertDialog.Cancel>
            <Button
              variant="primary"
              onClick={() => {
                setConfirming(false);
                void install();
              }}
            >
              Stop and restart
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
