import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as Dropdown from "@radix-ui/react-dropdown-menu";
import { Download, Ellipsis, PanelLeftClose, Pencil, Search, SquarePen, Trash2, X } from "lucide-react";
import type { ConversationSummary } from "../api";
import { useStore } from "../store";
import { errorTitle } from "../errors";
import { Button, IconButton, Notice, cx } from "./ui";

export function Sidebar({ onHide }: { onHide: () => void }) {
  const newChat = useStore((s) => s.newChat);
  const draftOpen = useStore((s) => s.chat.id === null && s.chat.messages.length === 0);
  const conversations = useStore((s) => s.conversations);
  const results = useStore((s) => s.results);
  const search = useStore((s) => s.search);
  const historyError = useStore((s) => s.historyError);
  const loadConversations = useStore((s) => s.loadConversations);

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-line bg-surface" aria-label="Chats">
      <div className="flex h-12 shrink-0 items-center gap-1 px-2">
        <IconButton label="Hide sidebar" onClick={onHide}>
          <PanelLeftClose size={16} />
        </IconButton>
        <div className="flex-1" />
        <Button variant="quiet" onClick={newChat} disabled={draftOpen} className="px-2.5">
          <SquarePen size={15} />
          New chat
        </Button>
      </div>

      <SearchBox />

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-4">
        {historyError && (
          <Notice
            className="mx-1 mb-3 text-[13px]"
            tone="error"
            title={errorTitle(historyError)}
            details={historyError.message}
            actions={<Button onClick={() => void loadConversations()}>Try again</Button>}
          />
        )}
        {results ? (
          results.length ? (
            <ul>{results.map((c) => <ChatRow key={c.id} chat={c} query={search.trim()} />)}</ul>
          ) : (
            <p className="px-2.5 py-2 text-[13px] text-ink-3">No chats contain “{search.trim()}”.</p>
          )
        ) : conversations.length ? (
          <GroupedList conversations={conversations} />
        ) : (
          !historyError && <p className="px-2.5 py-2 text-[13px] leading-5 text-ink-3">Chats you start are saved here, on this device.</p>
        )}
      </nav>
    </aside>
  );
}

function SearchBox() {
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  return (
    <div className="px-2 pb-2">
      <div className="flex h-8 items-center gap-2 rounded-[7px] border border-line bg-ground px-2.5 focus-within:border-river">
        <Search size={14} className="shrink-0 text-ink-3" aria-hidden />
        <label htmlFor="chat-search" className="sr-only">
          Search chats
        </label>
        <input
          id="chat-search"
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setSearch("")}
          placeholder="Search chats"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-[13px] placeholder:text-ink-3 focus:outline-none"
        />
        {search && (
          <button type="button" aria-label="Clear search" onClick={() => setSearch("")} className="text-ink-3 hover:text-ink">
            <X size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

const DAY = 86_400_000;

function groupLabel(ts: number, now: Date): string {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (ts >= today) return "Today";
  if (ts >= today - DAY) return "Yesterday";
  if (ts >= today - 7 * DAY) return "Previous 7 days";
  if (ts >= today - 30 * DAY) return "Previous 30 days";
  return new Date(ts).toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function GroupedList({ conversations }: { conversations: ConversationSummary[] }) {
  const now = new Date();
  const groups: { label: string; items: ConversationSummary[] }[] = [];
  for (const c of conversations) {
    const label = groupLabel(c.updatedAt, now);
    if (groups[groups.length - 1]?.label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(c);
  }
  return (
    <>
      {groups.map((g) => (
        <Fragment key={g.label}>
          <h3 className="px-2.5 pt-3 pb-1 text-[11px] font-medium tracking-wide text-ink-3 uppercase first:pt-1">{g.label}</h3>
          <ul>{g.items.map((c) => <ChatRow key={c.id} chat={c} />)}</ul>
        </Fragment>
      ))}
    </>
  );
}

function Highlight({ text, query }: { text: string; query?: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi"));
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-[2px] bg-sediment px-px text-ink">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

const menuPanel =
  "z-50 min-w-44 rounded-[10px] border border-line bg-surface p-1 text-[13px] text-ink shadow-[0_8px_30px_-12px_rgb(0_0_0/0.35)] outline-none";
const menuItem =
  "flex cursor-default items-center gap-2 rounded-[6px] px-2 py-1.5 outline-none data-highlighted:bg-river-soft";

function ChatRow({ chat, query }: { chat: ConversationSummary; query?: string }) {
  const active = useStore((s) => s.chat.id === chat.id);
  const answering = useStore((s) => chat.id in s.streams);
  const openChat = useStore((s) => s.openChat);
  const exportChat = useStore((s) => s.exportChat);
  const [renaming, setRenaming] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // A snippet that just repeats the title adds nothing.
  const snippet = chat.snippet && chat.snippet !== chat.title ? chat.snippet : undefined;

  return (
    <li className="group relative">
      {renaming ? (
        <RenameInput chat={chat} onDone={() => setRenaming(false)} />
      ) : (
        <button
          type="button"
          onClick={() => void openChat(chat.id)}
          onDoubleClick={() => setRenaming(true)}
          aria-current={active ? "page" : undefined}
          className={cx(
            "flex w-full flex-col rounded-[7px] py-1.5 pr-8 pl-2.5 text-left text-[13px] leading-5",
            active ? "bg-river-soft text-ink" : "text-ink-2 hover:bg-river-soft/60 hover:text-ink",
          )}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">
              <Highlight text={chat.title} query={query} />
            </span>
            {answering && (
              <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-river" role="img" aria-label="Answering" />
            )}
          </span>
          {snippet && (
            <span className="mt-0.5 line-clamp-2 text-xs leading-4 text-ink-3">
              <Highlight text={snippet} query={query} />
            </span>
          )}
        </button>
      )}

      {!renaming && (
        <Dropdown.Root modal={false}>
          <Dropdown.Trigger asChild>
            <IconButton
              label={`Options for ${chat.title}`}
              className={cx(
                "absolute top-0.5 right-0.5 size-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
                active && "opacity-100",
              )}
            >
              <Ellipsis size={15} />
            </IconButton>
          </Dropdown.Trigger>
          <Dropdown.Portal>
            <Dropdown.Content align="start" sideOffset={2} className={menuPanel}>
              <Dropdown.Item className={menuItem} onSelect={() => setRenaming(true)}>
                <Pencil size={14} className="text-ink-3" />
                Rename
              </Dropdown.Item>
              <Dropdown.Item className={menuItem} onSelect={() => void exportChat(chat.id)}>
                <Download size={14} className="text-ink-3" />
                Export as Markdown
              </Dropdown.Item>
              <Dropdown.Separator className="my-1 h-px bg-line" />
              <Dropdown.Item className={cx(menuItem, "text-brick")} onSelect={() => setConfirming(true)}>
                <Trash2 size={14} />
                Delete
              </Dropdown.Item>
            </Dropdown.Content>
          </Dropdown.Portal>
        </Dropdown.Root>
      )}

      <ConfirmDelete chat={chat} open={confirming} onOpenChange={setConfirming} />
    </li>
  );
}

function RenameInput({ chat, onDone }: { chat: ConversationSummary; onDone: () => void }) {
  const renameChat = useStore((s) => s.renameChat);
  const [title, setTitle] = useState(chat.title);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const commit = async () => {
    if (finished.current) return;
    finished.current = true;
    if (title.trim() && title.trim() !== chat.title) await renameChat(chat.id, title);
    onDone();
  };

  return (
    <input
      ref={input}
      aria-label="Chat title"
      value={title}
      maxLength={200}
      onChange={(e) => setTitle(e.target.value)}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === "Enter") void commit();
        if (e.key === "Escape") {
          finished.current = true;
          onDone();
        }
      }}
      className="h-8 w-full rounded-[7px] border border-river bg-ground px-2.5 text-[13px] focus:outline-none"
    />
  );
}

function ConfirmDelete({
  chat,
  open,
  onOpenChange,
}: {
  chat: ConversationSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const deleteChat = useStore((s) => s.deleteChat);
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/30" />
        <AlertDialog.Content className="fixed top-1/2 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-line bg-surface p-5 text-ink shadow-[0_20px_60px_-20px_rgb(0_0_0/0.45)] focus:outline-none">
          <AlertDialog.Title className="text-[15px] font-semibold">Delete this chat?</AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-[13px] leading-5 text-ink-2">
            <Quoted>{chat.title}</Quoted> and all its messages will be removed from this device. This can't be undone.
          </AlertDialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button>Cancel</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button className="border-0 bg-brick text-ground hover:bg-brick hover:brightness-110" onClick={() => void deleteChat(chat.id)}>
                Delete
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

const Quoted = ({ children }: { children: ReactNode }) => <span className="font-medium text-ink">“{children}”</span>;
