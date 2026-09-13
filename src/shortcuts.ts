import { useEffect, useRef } from "react";

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export type ShortcutId = "newChat" | "focusComposer" | "searchChats" | "settings" | "stop";

/** Keys as shown to the user, per platform. */
export const SHORTCUTS: { id: ShortcutId; label: string; keys: string[] }[] = [
  { id: "newChat", label: "New chat", keys: mod("N") },
  { id: "focusComposer", label: "Go to the message box", keys: mod("L") },
  { id: "searchChats", label: "Search chats", keys: mod("K") },
  { id: "settings", label: "Settings", keys: mod(",") },
  { id: "stop", label: "Stop the answer", keys: ["Esc"] },
];

function mod(key: string) {
  return isMac ? ["⌘", key] : ["Ctrl", key];
}

/** "New chat (⌘N)" for tooltips. */
export function withShortcut(label: string, id: ShortcutId) {
  const keys = SHORTCUTS.find((s) => s.id === id)!.keys;
  return `${label} (${isMac ? keys.join("") : keys.join("+")})`;
}

/** For `aria-keyshortcuts`. */
export function ariaShortcut(id: ShortcutId) {
  return SHORTCUTS.find((s) => s.id === id)!.keys
    .map((k) => ({ "⌘": "Meta", Ctrl: "Control", Esc: "Escape" })[k] ?? k)
    .join("+");
}

const MOD_KEYS: Partial<Record<string, ShortcutId>> = { n: "newChat", l: "focusComposer", k: "searchChats", ",": "settings" };

/** Some overlay (dialog, popover, menu) is open and owns the keyboard. */
const overlayOpen = () => !!document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]');

const isTextField = (el: EventTarget | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el.tagName === "INPUT" || el.tagName === "TEXTAREA");

/**
 * App-wide shortcuts. Listens in the capture phase so it sees the key before overlays react to it,
 * which is how Escape can leave an open menu to close itself instead of also stopping the answer.
 */
export function useShortcuts(handlers: Record<ShortcutId, () => void>, enabled: boolean) {
  const latest = useRef(handlers);
  latest.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const modifier = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (modifier && !e.altKey && !e.shiftKey) {
        const id = MOD_KEYS[e.key.toLowerCase()];
        if (!id) return;
        e.preventDefault();
        if (!overlayOpen()) latest.current[id]();
        return;
      }
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        // Escape in other fields means cancel (an edit, a rename, a search).
        const target = e.target as HTMLElement | null;
        if (overlayOpen() || (isTextField(target) && target?.id !== "composer")) return;
        latest.current.stop();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [enabled]);
}
