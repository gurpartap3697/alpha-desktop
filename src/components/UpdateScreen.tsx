import { RotateCcw } from "lucide-react";
import { useStore } from "../store";
import { errorTitle } from "../errors";
import { Button, Notice } from "./ui";
import { DownloadPageLink, RestartButton, UpdateProgress } from "./Updates";

/** Shown when the gateway's `minAppVersion` is newer than this build. The update is fetched in the background. */
export function UpdateScreen() {
  const auth = useStore((s) => s.auth);
  const config = useStore((s) => s.config);
  const update = useStore((s) => s.update);
  const check = useStore((s) => s.checkForUpdate);
  const download = useStore((s) => s.downloadUpdate);
  const install = useStore((s) => s.installUpdate);

  // The server wants a version the updater doesn't have (not published, or older than the minimum).
  const noUpdate = update.status === "disabled" || update.status === "up_to_date";
  const manual = noUpdate || (update.status === "idle" && update.error !== null);
  const retry = { idle: check, available: download, ready: install }[update.status as "idle" | "available" | "ready"];

  return (
    <main className="flex h-full px-6">
      <div className="m-auto w-full max-w-[26rem]">
        <h1 className="font-serif text-[1.75rem] leading-tight font-[560]">This version of Alpha is no longer supported</h1>
        <p className="mt-4 text-[15px] leading-6 text-ink-2">
          You have version {auth?.appVersion}. The model server needs version {config?.config.minAppVersion} or later.
          Your chats are kept.
        </p>

        <div className="mt-6" aria-live="polite">
          {(update.status === "idle" || update.status === "checking") && !update.error && (
            <p className="animate-pulse text-[13px] text-ink-2">Looking for the new version…</p>
          )}
          {update.status === "downloading" && <UpdateProgress />}
          {(update.status === "ready" || update.status === "installing") && (
            <>
              <p className="text-[13px] text-ink-2">Alpha {update.info?.version} is downloaded and ready to install.</p>
              <RestartButton className="mt-3" />
            </>
          )}
          {manual && (
            <p className="text-[15px] leading-6 text-ink-2">
              {noUpdate ? "Alpha can't update itself to that version. " : ""}
              Download and install it from <DownloadPageLink />, or ask your administrator. Then open Alpha again.
            </p>
          )}
          {noUpdate && (
            <>
              {update.info?.reason && <p className="mt-2 text-xs text-ink-3">{update.info.reason}.</p>}
              <Button className="mt-4" onClick={() => void check()}>
                <RotateCcw size={14} />
                Check again
              </Button>
            </>
          )}
          {update.error && retry && (
            <Notice
              className="mt-4"
              tone="error"
              title={errorTitle(update.error)}
              details={update.error.message}
              actions={
                <Button onClick={() => void retry()}>
                  <RotateCcw size={14} />
                  Try again
                </Button>
              }
            />
          )}
        </div>
      </div>
    </main>
  );
}
