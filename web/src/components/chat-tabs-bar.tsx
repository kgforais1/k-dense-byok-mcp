"use client";

import {
  DownloadIcon,
  FileTextIcon,
  HistoryIcon,
  LoaderCircleIcon,
  MessageSquareTextIcon,
  PencilIcon,
  PlusIcon,
  TerminalIcon,
  Trash2Icon,
  WorkflowIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { apiFetch } from "@/lib/projects";
import { cn } from "@/lib/utils";

export interface ChatTabDescriptor {
  id: string;
  title: string;
  /** Stored session this tab is showing, once it has one. */
  sessionId?: string;
  isStreaming: boolean;
  userMessageCount: number;
}

export interface ChatTabsBarProps {
  projectId: string;
  tabs: ChatTabDescriptor[];
  activeTabId: string;
  view: "chat" | "workflows";
  maxTabs: number;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, title: string) => void;
  onSelectWorkflows: () => void;
  /** Reopen a stored session (from the History menu) into a tab. */
  onOpenSession: (sessionId: string, title: string) => void;
  /** Session id of the active tab, for reproducibility export. */
  activeSessionId?: string | null;
  /** Whether the active tab has any messages worth exporting. */
  canExport?: boolean;
}

interface SessionListItem {
  id: string;
  name: string | null;
  created: string | number;
  modified: string | number;
  messageCount: number;
  firstMessage?: string | null;
  /** Created by an MCP client, so this session has no `interview` tool. */
  headless?: boolean;
}

function sessionTitle(s: SessionListItem): string {
  const raw = (s.name ?? s.firstMessage ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "Untitled chat";
  return raw.length > 60 ? raw.slice(0, 60) + "…" : raw;
}

function relativeTime(value: string | number): string {
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return "";
  const mins = Math.round((Date.now() - then) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 7 ? `${days}d ago` : new Date(then).toLocaleDateString();
}

/** Clock menu listing the project's stored sessions; picking one reopens it
 *  (or focuses the tab that already has it). */
function HistoryMenu({
  projectId,
  onOpenSession,
  openSessionIds,
}: {
  projectId: string;
  onOpenSession: (sessionId: string, title: string) => void;
  /**
   * Sessions currently open in a tab. Deleting one leaves that tab pointing at
   * a transcript the server can no longer find, and every later send fails.
   */
  openSessionIds: ReadonlySet<string>;
}) {
  const [open, setOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  // Clicking the trash icon must not also reopen the chat. Radix fires the
  // item's onSelect for a click anywhere inside it, so the button records its
  // intent here and onSelect defers to it.
  const deletingRef = useRef<string | null>(null);

  async function deleteSession(session: SessionListItem, title: string) {
    const confirmed = window.confirm(
      `Delete "${title}"? Its transcript will be permanently removed. This cannot be undone.`,
    );
    if (!confirmed) {
      // Today `onSelect` still fires for the mouse path and clears this, but
      // only because `window.confirm` blocks synchronously. Swap in an async
      // dialog and the marker outlives the click, and the next attempt to
      // reopen the row silently does nothing. Clear it here too.
      deletingRef.current = null;
      return;
    }
    try {
      const res = await apiFetch(
        `/sessions/${encodeURIComponent(session.id)}`,
        { method: "DELETE" },
        projectId,
      );
      if (res.status === 409) {
        toast.error("That chat is still running. Wait for it to finish.");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        toast.error(body?.detail ?? "Could not delete that chat");
        return;
      }
      setSessions((current) =>
        current ? current.filter((entry) => entry.id !== session.id) : current,
      );
    } catch (exc) {
      toast.error(exc instanceof Error ? exc.message : "Could not delete that chat");
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    apiFetch("/sessions", {}, projectId)
      .then((r) => (r.ok ? r.json() : []))
      .then((list: SessionListItem[]) => {
        if (cancelled) return;
        const sorted = [...list]
          .filter((s) => s.messageCount > 0)
          .sort(
            (a, b) =>
              new Date(b.modified).getTime() - new Date(a.modified).getTime(),
          );
        setSessions(sorted);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, projectId]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <InfoTooltip
        content={
          <>
            <b>Chat history</b>
            <br />
            Reopen a previous chat from this project — the full transcript is
            restored and you can continue the conversation.
          </>
        }
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Chat history"
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <HistoryIcon className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
      </InfoTooltip>
      <DropdownMenuContent align="start" className="w-72 max-h-80 overflow-y-auto">
        <DropdownMenuLabel>Previous chats</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {sessions === null ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No previous chats in this project yet.
          </div>
        ) : (
          sessions.map((s) => {
            const title = sessionTitle(s);
            return (
              <DropdownMenuItem
                key={s.id}
                className="group"
                onSelect={(event) => {
                  if (deletingRef.current === s.id) {
                    deletingRef.current = null;
                    event.preventDefault();
                    return;
                  }
                  onOpenSession(s.id, title);
                }}
              >
                <MessageSquareTextIcon className="size-4 shrink-0" />
                <div className="flex min-w-0 flex-col">
                  <span className="truncate">{title}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {relativeTime(s.modified)} · {s.messageCount} message
                    {s.messageCount === 1 ? "" : "s"}
                  </span>
                </div>
                {s.headless ? (
                  <InfoTooltip
                    content={
                      <>
                        <b>Started by an MCP client</b>
                        <br />
                        You can reopen and continue it here, but this chat
                        cannot ask you a clarifying question — the interview
                        tool stays off for the life of the session.
                      </>
                    }
                  >
                    <Badge variant="secondary" className="ml-auto shrink-0 text-[10px]">
                      MCP
                    </Badge>
                  </InfoTooltip>
                ) : null}
                <button
                  type="button"
                  disabled={openSessionIds.has(s.id)}
                  title={
                    openSessionIds.has(s.id)
                      ? "This chat is open in a tab. Close it first."
                      : undefined
                  }
                  aria-label={`Delete ${title}`}
                  className={cn(
                    "shrink-0 rounded p-1 text-muted-foreground opacity-0 transition",
                    "hover:bg-destructive/10 hover:text-destructive",
                    "focus-visible:opacity-100 group-hover:opacity-100",
                    "disabled:cursor-not-allowed disabled:hover:bg-transparent",
                    "disabled:hover:text-muted-foreground",
                    s.headless ? "" : "ml-auto",
                  )}
                  onKeyDown={(event) => {
                    // Radix handles Enter/Space on the menu *item*, so without
                    // this the keyboard path reopens the chat instead of
                    // deleting it. Stop the key before the item ever sees it.
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    event.stopPropagation();
                    // Deliberately not setting `deletingRef`: the item never
                    // sees this key, so `onSelect` never runs to clear it, and
                    // a stale ref would swallow the next click on the row.
                    void deleteSession(s, title);
                  }}
                  onClick={(event) => {
                    // Set here rather than on pointerdown so the same handler
                    // covers mouse and touch; it still runs before the item's
                    // onSelect sees the bubbled click.
                    deletingRef.current = s.id;
                    event.stopPropagation();
                    void deleteSession(s, title);
                  }}
                >
                  <Trash2Icon className="size-3.5" />
                </button>
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Fetch an export and trigger a browser download (X-Project-Id via apiFetch). */
async function downloadExport(
  projectId: string,
  sessionId: string,
  format: "sh" | "md",
) {
  try {
    const res = await apiFetch(
      `/sessions/${encodeURIComponent(sessionId)}/export?format=${format}`,
      {},
      projectId,
    );
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `session-${sessionId}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch {
    // best-effort download; nothing actionable to surface
  }
}

function ExportMenu({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  return (
    <DropdownMenu>
      <InfoTooltip
        content={
          <>
            <b>Export session</b>
            <br />
            Download a reproducible record of this chat — a runnable shell
            script of every command the agent ran, or a full lab notebook.
          </>
        }
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Export session"
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <DownloadIcon className="size-3.5" />
            Export
          </button>
        </DropdownMenuTrigger>
      </InfoTooltip>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Reproducibility export</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => downloadExport(projectId, sessionId, "sh")}>
          <TerminalIcon className="size-4" />
          <div className="flex flex-col">
            <span>Shell script (.sh)</span>
            <span className="text-[11px] text-muted-foreground">
              Every command, in order
            </span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => downloadExport(projectId, sessionId, "md")}>
          <FileTextIcon className="size-4" />
          <div className="flex flex-col">
            <span>Lab notebook (.md)</span>
            <span className="text-[11px] text-muted-foreground">
              Prompts, commands & outputs
            </span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ChatTabsBar({
  projectId,
  tabs,
  activeTabId,
  view,
  maxTabs,
  onSelect,
  onClose,
  onNew,
  onRename,
  onSelectWorkflows,
  onOpenSession,
  activeSessionId,
  canExport = false,
}: ChatTabsBarProps) {
  const atLimit = tabs.length >= maxTabs;
  const openSessionIds = new Set(
    tabs.map((tab) => tab.sessionId).filter((id): id is string => Boolean(id)),
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editingId]);

  const startRename = (tab: ChatTabDescriptor) => {
    setEditingId(tab.id);
    setDraftTitle(tab.title);
  };

  const commitRename = () => {
    if (!editingId) return;
    const next = draftTitle.trim();
    if (next) onRename(editingId, next);
    setEditingId(null);
    setDraftTitle("");
  };

  return (
    <div className="flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
      {/* Tabs + plus live in a scrollable region. Without this isolation the
          Workflows pill (after `ml-auto`) gets pushed to the far right of
          the scroll container — off-screen — once the tab strip overflows. */}
      <div className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto">
        {tabs.map((tab) => {
          const isActive = view === "chat" && tab.id === activeTabId;
          const canClose = tabs.length > 1;
          const isEditing = editingId === tab.id;
          return (
            <div
              key={tab.id}
              className={cn(
                "group flex items-center gap-1.5 rounded-md pl-2.5 pr-1 py-1 text-xs font-medium transition-colors max-w-[180px]",
                isActive
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
              )}
            >
              <button
                onClick={() => onSelect(tab.id)}
                onDoubleClick={() => startRename(tab)}
                className="flex min-w-0 items-center gap-1.5"
                type="button"
                title={`${tab.title} — double-click to rename`}
              >
                <MessageSquareTextIcon className="size-3.5 shrink-0" />
                {tab.isStreaming && (
                  <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-primary" />
                )}
                {isEditing ? (
                  <input
                    ref={inputRef}
                    value={draftTitle}
                    onChange={(e) => setDraftTitle(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") {
                        setEditingId(null);
                        setDraftTitle("");
                      }
                      e.stopPropagation();
                    }}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                    className="w-24 bg-transparent text-xs font-medium outline-none border-b border-primary/40 focus:border-primary"
                    maxLength={40}
                  />
                ) : (
                  <span className="truncate">{tab.title}</span>
                )}
                {tab.userMessageCount > 0 && !isEditing && (
                  <span className="ml-0.5 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary tabular-nums">
                    {tab.userMessageCount}
                  </span>
                )}
              </button>
              {!isEditing && (
                <>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      startRename(tab);
                    }}
                    type="button"
                    aria-label={`Rename ${tab.title}`}
                    className={cn(
                      "rounded p-0.5 text-muted-foreground/40 transition-all hover:bg-muted-foreground/10 hover:text-foreground",
                      isActive
                        ? "opacity-60 hover:opacity-100"
                        : "opacity-0 group-hover:opacity-60",
                    )}
                    title="Rename tab"
                  >
                    <PencilIcon className="size-3" />
                  </button>
                  {canClose && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onClose(tab.id);
                      }}
                      type="button"
                      aria-label={`Close ${tab.title}`}
                      className={cn(
                        "rounded p-0.5 text-muted-foreground/40 transition-all hover:bg-destructive/10 hover:text-destructive",
                        isActive
                          ? "opacity-60 hover:opacity-100"
                          : "opacity-0 group-hover:opacity-60",
                      )}
                      title={
                        tab.isStreaming
                          ? "Close tab (this will cancel the running turn)"
                          : "Close tab"
                      }
                    >
                      <XIcon className="size-3" />
                    </button>
                  )}
                </>
              )}
            </div>
          );
        })}

        <InfoTooltip
          content={
            atLimit ? (
              <>
                <b>Tab limit reached</b>
                <br />
                You can have up to {maxTabs} chat tabs running at once. Close
                one to open a new one.
              </>
            ) : (
              <>
                <b>New chat tab</b>
                <br />
                Open another chat in the same project. All tabs share the
                same sandbox files but have independent message history.
              </>
            )
          }
        >
          <button
            onClick={onNew}
            type="button"
            disabled={atLimit}
            aria-label="New chat tab"
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </InfoTooltip>
        <HistoryMenu
          projectId={projectId}
          onOpenSession={onOpenSession}
          openSessionIds={openSessionIds}
        />
      </div>

      <div className="shrink-0 flex items-center gap-1 pl-2 border-l">
        {view === "chat" && canExport && activeSessionId && (
          <ExportMenu projectId={projectId} sessionId={activeSessionId} />
        )}
        <InfoTooltip
          content={
            <>
              <b>Workflows</b>
              <br />
              Pre-built scientific pipelines (e.g. RNA-seq, literature
              review). Pick a template, attach inputs, and launch — they
              run in the active chat tab.
            </>
          }
        >
          <button
            onClick={onSelectWorkflows}
            type="button"
            className={cn(
              "flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
              view === "workflows"
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
          >
            <WorkflowIcon className="size-3.5" />
            Workflows
          </button>
        </InfoTooltip>
      </div>
    </div>
  );
}
