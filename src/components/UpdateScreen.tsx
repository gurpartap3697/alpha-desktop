import { useStore } from "../store";

// Phase 4 wires this to the updater. Until then the user installs the new version by hand.
export function UpdateScreen() {
  const auth = useStore((s) => s.auth);
  const config = useStore((s) => s.config);
  return (
    <main className="flex h-full px-6">
      <div className="m-auto w-full max-w-[26rem]">
        <h1 className="font-serif text-[1.75rem] leading-tight font-[560]">This version of Alpha is no longer supported</h1>
        <p className="mt-4 text-[15px] leading-6 text-ink-2">
          You have version {auth?.appVersion}. The model server needs version {config?.config.minAppVersion} or later.
          Install the latest version from your IT portal or ask your administrator, then open Alpha again.
        </p>
      </div>
    </main>
  );
}
