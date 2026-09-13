import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, CircleUser, SlidersHorizontal, SquarePen } from "lucide-react";
import { useStore } from "../store";
import { Button, IconButton } from "./ui";

const panel =
  "z-50 rounded-[10px] border border-line bg-surface p-1 text-ink shadow-[0_8px_30px_-12px_rgb(0_0_0/0.35)] outline-none";

export function TopBar() {
  const newChat = useStore((s) => s.newChat);
  const hasTurns = useStore((s) => s.turns.length > 0);
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3">
      <ModelPicker />
      <div className="flex-1" />
      <Button variant="quiet" onClick={newChat} disabled={!hasTurns}>
        <SquarePen size={15} />
        New chat
      </Button>
      <ChatSettings />
      <AccountMenu />
    </header>
  );
}

function ModelPicker() {
  const models = useStore((s) => s.models);
  const modelId = useStore((s) => s.modelId);
  const status = useStore((s) => s.modelsStatus);
  const selectModel = useStore((s) => s.selectModel);
  const current = models.find((m) => m.id === modelId);

  const label = current?.displayName ?? (status === "loading" ? "Loading models…" : "No models available");
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild disabled={models.length === 0}>
        <Button variant="quiet" className="px-2.5 text-[14px] font-semibold text-ink" aria-label={`Model: ${label}`}>
          {label}
          <ChevronDown size={15} className="text-ink-3" />
        </Button>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="start" sideOffset={4} className={`${panel} max-h-[70vh] w-80 overflow-y-auto`}>
          <Dropdown.RadioGroup value={modelId} onValueChange={selectModel}>
            {models.map((m) => (
              <Dropdown.RadioItem
                key={m.id}
                value={m.id}
                className="flex cursor-default items-start gap-2 rounded-[7px] px-2.5 py-2 outline-none data-highlighted:bg-river-soft"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <span className="font-medium">{m.displayName}</span>
                    {m.reasoning.supported && <span className="text-xs text-river">Can think</span>}
                  </div>
                  {m.description && <div className="mt-0.5 text-[13px] text-ink-2">{m.description}</div>}
                  {m.displayName !== m.id && !m.configured && <div className="mt-0.5 truncate font-mono text-xs text-ink-3">{m.id}</div>}
                </div>
                <Dropdown.ItemIndicator className="mt-0.5 text-river">
                  <Check size={15} />
                </Dropdown.ItemIndicator>
              </Dropdown.RadioItem>
            ))}
          </Dropdown.RadioGroup>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}

function ChatSettings() {
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const model = useStore((s) => s.models.find((m) => m.id === s.modelId));
  const temperature = settings.temperature ?? model?.temperature ?? 0.7;
  const maxTokensLimit = model ? Math.max(1, model.contextWindow - 256) : undefined;
  const customized = settings.systemPrompt.trim() !== "" || settings.temperature !== null || settings.maxTokens !== null;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton label="Chat settings" className={customized ? "text-river" : undefined}>
          <SlidersHorizontal size={16} />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} className={`${panel} w-[22rem] p-4`}>
          <div className="space-y-5 text-[13px]">
            <div>
              <label htmlFor="system-prompt" className="font-medium">
                System prompt
              </label>
              <p className="mt-0.5 text-ink-2">Instructions the model follows for the whole chat.</p>
              <textarea
                id="system-prompt"
                rows={4}
                value={settings.systemPrompt}
                onChange={(e) => update({ systemPrompt: e.target.value })}
                placeholder="For example: Answer briefly and cite sources."
                className="mt-2 w-full resize-y rounded-[7px] border border-line bg-ground px-2.5 py-2 leading-5 placeholder:text-ink-3 focus:border-river focus:outline-none"
              />
            </div>

            <div>
              <div className="flex items-baseline justify-between">
                <label htmlFor="temperature" className="font-medium">
                  Temperature
                </label>
                <span className="tabular-nums text-ink-2">{temperature.toFixed(2)}</span>
              </div>
              <input
                id="temperature"
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={temperature}
                onChange={(e) => update({ temperature: Number(e.target.value) })}
                className="mt-2 w-full accent-(--river)"
              />
              <div className="flex justify-between text-xs text-ink-3">
                <span>Focused</span>
                <span>Varied</span>
              </div>
            </div>

            <div>
              <label htmlFor="max-tokens" className="font-medium">
                Maximum answer length
              </label>
              <p className="mt-0.5 text-ink-2">In tokens. A token is about three quarters of a word.</p>
              <input
                id="max-tokens"
                type="number"
                min={1}
                max={maxTokensLimit}
                value={settings.maxTokens ?? ""}
                placeholder={model ? String(model.maxOutputTokens) : ""}
                onChange={(e) => {
                  const n = Math.floor(Number(e.target.value));
                  update({ maxTokens: e.target.value === "" || !(n > 0) ? null : Math.min(n, maxTokensLimit ?? n) });
                }}
                className="mt-2 h-8 w-32 rounded-[7px] border border-line bg-ground px-2.5 tabular-nums placeholder:text-ink-3 focus:border-river focus:outline-none"
              />
            </div>

            <div className="flex items-center justify-between border-t border-line pt-3">
              <span className="text-xs text-ink-3">Applies to the next message you send.</span>
              <Button
                variant="quiet"
                disabled={settings.temperature === null && settings.maxTokens === null}
                onClick={() => update({ temperature: null, maxTokens: null })}
              >
                Use model defaults
              </Button>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function AccountMenu() {
  const auth = useStore((s) => s.auth);
  const config = useStore((s) => s.config);
  const signOut = useStore((s) => s.signOut);
  if (!auth) return null;

  const storage = auth.storage === "file"
    ? "Key saved in a private file, because no system keychain was found"
    : "Key saved in the system keychain";
  const source = config && {
    remote: "Model details are up to date",
    cache: "Model details are from a saved copy, because the server's copy couldn't be loaded",
    builtin: "Model details are unavailable, so defaults are used",
  }[config.source];

  const info = "px-2.5 py-1 text-xs leading-[1.1rem]";
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild>
        <IconButton label="Account">
          <CircleUser size={17} />
        </IconButton>
      </Dropdown.Trigger>
      <Dropdown.Portal>
        <Dropdown.Content align="end" sideOffset={4} className={`${panel} w-72 py-2`}>
          <div className={info}>{auth.gatewayUrl}</div>
          <div className={`${info} text-ink-2`}>{storage}</div>
          {source && <div className={`${info} text-ink-2`} title={config?.fetchError ?? undefined}>{source}</div>}
          <div className={`${info} text-ink-3`}>Alph {auth.appVersion}</div>
          <Dropdown.Separator className="my-1.5 h-px bg-line" />
          <Dropdown.Item
            onSelect={() => void signOut()}
            className="mx-1 cursor-default rounded-[6px] px-2 py-1.5 text-[13px] outline-none data-highlighted:bg-river-soft"
          >
            Sign out and remove key
          </Dropdown.Item>
        </Dropdown.Content>
      </Dropdown.Portal>
    </Dropdown.Root>
  );
}
