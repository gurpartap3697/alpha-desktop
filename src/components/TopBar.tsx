import * as Dropdown from "@radix-ui/react-dropdown-menu";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronDown, PanelLeftOpen, Settings, SlidersHorizontal, SquarePen } from "lucide-react";
import { activeModel, useStore } from "../store";
import { withShortcut } from "../shortcuts";
import { MaxTokensField, SystemPromptField, TemperatureField } from "./ParamFields";
import { Button, IconButton } from "./ui";

const panel =
  "z-50 rounded-[10px] border border-line bg-surface p-1 text-ink shadow-[0_8px_30px_-12px_rgb(0_0_0/0.35)] outline-none";

export function TopBar({ sidebarOpen, onShowSidebar }: { sidebarOpen: boolean; onShowSidebar: () => void }) {
  const newChat = useStore((s) => s.newChat);
  const draftOpen = useStore((s) => s.chat.id === null && s.chat.messages.length === 0);
  const title = useStore((s) => s.chat.title);
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-3">
      {!sidebarOpen && (
        <>
          <IconButton label="Show sidebar" onClick={onShowSidebar}>
            <PanelLeftOpen size={16} />
          </IconButton>
          <IconButton label="New chat" title={withShortcut("New chat", "newChat")} onClick={newChat} disabled={draftOpen}>
            <SquarePen size={16} />
          </IconButton>
        </>
      )}
      <ModelPicker />
      {!sidebarOpen && title && <span className="min-w-0 truncate pl-1 text-[13px] text-ink-3">{title}</span>}
      <div className="flex-1" />
      <ChatSettings />
      <SettingsButton />
    </header>
  );
}

function ModelPicker() {
  const models = useStore((s) => s.models);
  const current = useStore(activeModel);
  const modelId = current?.id ?? "";
  const status = useStore((s) => s.modelsStatus);
  const selectModel = useStore((s) => s.selectModel);
  const loading = useStore((s) => s.chat.status !== "ready");

  const label = current?.displayName ?? (status === "loading" ? "Loading models…" : "No models available");
  return (
    <Dropdown.Root>
      <Dropdown.Trigger asChild disabled={models.length === 0 || loading}>
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
  const settings = useStore((s) => s.chat.settings);
  const { temperature, maxTokens } = settings.params;
  const update = useStore((s) => s.updateSettings);
  const model = useStore(activeModel);
  const loading = useStore((s) => s.chat.status !== "ready");
  const customized = settings.systemPrompt.trim() !== "" || temperature !== null || maxTokens !== null;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <IconButton label="Chat settings" disabled={loading} className={customized ? "text-river" : undefined}>
          <SlidersHorizontal size={16} />
        </IconButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="end" sideOffset={4} className={`${panel} w-[22rem] p-4`}>
          <div className="space-y-5 text-[13px]">
            <SystemPromptField
              value={settings.systemPrompt}
              onChange={(systemPrompt) => update({ systemPrompt })}
              help="Instructions the model follows for the whole chat."
            />
            <TemperatureField
              value={temperature}
              fallback={model?.temperature ?? 0.7}
              onChange={(t) => update({ params: { temperature: t } })}
            />
            <MaxTokensField
              value={maxTokens}
              placeholder={model ? String(model.maxOutputTokens) : ""}
              limit={model ? Math.max(1, model.contextWindow - 256) : undefined}
              onChange={(n) => update({ params: { maxTokens: n } })}
            />
            <div className="flex items-center justify-between border-t border-line pt-3">
              <span className="text-xs text-ink-3">Saved with this chat.</span>
              <Button
                variant="quiet"
                disabled={temperature === null && maxTokens === null}
                onClick={() => update({ params: { temperature: null, maxTokens: null } })}
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

function SettingsButton() {
  const open = useStore((s) => s.setSettingsOpen);
  return (
    <IconButton label="Settings" title={withShortcut("Settings", "settings")} onClick={() => open(true)}>
      <Settings size={16} />
    </IconButton>
  );
}
