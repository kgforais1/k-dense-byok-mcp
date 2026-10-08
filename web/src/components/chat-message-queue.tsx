"use client";

import { buildDatabaseContext } from "@/components/database-selector";
import { buildSkillsContext } from "@/components/skills-selector";
import {
  splitComposerContext
} from "@/lib/composer-context";
import {
  splitQueuedText,
  type QueueDirection
} from "@/lib/message-queue";
import {
  type WorkspaceQueuedMessage
} from "@/lib/workspace-persistence";
import {
  BookOpenIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  DatabaseIcon,
  ImageIcon,
  ListOrderedIcon,
  PaperclipIcon,
  PencilIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UsersIcon,
  XIcon,
  ZapIcon
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState
} from "react";

const MAX_QUEUE = 5;
type QueuedMessage = WorkspaceQueuedMessage;

function QueuedMessageEditor({
  initialText,
  allowEmpty = false,
  onSave,
  onCancel,
}: {
  initialText: string;
  /** The message keeps content outside the editor (attached files, + picks). */
  allowEmpty?: boolean;
  onSave: (text: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialText);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const trimmed = draft.trim();
  const canSave = trimmed.length > 0 || allowEmpty;
  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        ref={ref}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Keep composer shortcuts (Enter to send, ⌥⏎ to queue) out of here.
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (canSave) onSave(trimmed);
          }
        }}
        rows={Math.min(8, Math.max(2, draft.split("\n").length))}
        className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
        aria-label="Edit queued message"
      />
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => onSave(trimmed)}
          disabled={!canSave}
          className="rounded bg-primary px-2 py-0.5 text-[10px] font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-0.5 text-[10px] font-semibold text-muted-foreground transition-colors hover:bg-muted"
        >
          Cancel
        </button>
        <span className="ml-auto text-[10px] text-muted-foreground">⌘⏎ save · Esc cancel</span>
      </div>
    </div>
  );
}

export function MessageQueueDisplay({
  queue,
  steering,
  followUp = [],
  onRemove,
  onMove,
  onEdit,
  editingId,
  sendingId,
  onEditingChange,
  paused = false,
  onResume,
}: {
  queue: QueuedMessage[];
  steering: string[];
  /** Pi follow-ups: delivered inside the live run once the agent is otherwise done. */
  followUp?: string[];
  onRemove: (id: string) => void;
  onMove: (id: string, direction: QueueDirection) => void;
  onEdit: (id: string, text: string) => void;
  /** Item currently open in the inline editor; auto-send holds while set. */
  editingId: string | null;
  /** Item awaiting server admission; its controls stay locked. */
  sendingId?: string | null;
  onEditingChange: (id: string | null) => void;
  /** True after Stop, while queued messages are held back. */
  paused?: boolean;
  onResume?: () => void;
}) {
  if (queue.length === 0 && steering.length === 0 && followUp.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 z-10 mb-2">
      <div className="overflow-hidden rounded-xl border bg-background shadow-lg">
        {steering.length > 0 && (
          <>
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <ZapIcon className="size-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Steering — delivers mid-run
              </span>
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {steering.length}
              </span>
            </div>
            <div className="max-h-32 overflow-y-auto border-b py-1">
              {steering.map((text, i) => (
                <div key={`${i}-${text}`} className="flex items-center gap-2.5 px-3 py-2 text-xs">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] tabular-nums text-muted-foreground">
                    ⏳
                  </span>
                  <div className="min-w-0 flex-1 truncate text-foreground">{text}</div>
                </div>
              ))}
            </div>
          </>
        )}
        {followUp.length > 0 && (
          <>
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <ListOrderedIcon className="size-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                After this turn — Kady continues
              </span>
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {followUp.length}
              </span>
            </div>
            <div className="max-h-32 overflow-y-auto border-b py-1" data-testid="follow-up-queue">
              {followUp.map((text, i) => (
                <div key={`${i}-${text}`} className="flex items-center gap-2.5 px-3 py-2 text-xs">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1 truncate text-foreground">{text}</div>
                </div>
              ))}
            </div>
          </>
        )}
        {queue.length > 0 && (
          <>
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <ListOrderedIcon className="size-3.5 text-muted-foreground" />
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {editingId ? "Held while editing" : paused ? "Paused — stopped" : "Run after"}
              </span>
              {paused && onResume && (
                <button
                  type="button"
                  onClick={onResume}
                  className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-primary transition-colors hover:bg-primary/10"
                >
                  Resume
                </button>
              )}
              <span className="ml-auto text-[10px] tabular-nums text-muted-foreground">
                {queue.length}/{MAX_QUEUE}
              </span>
            </div>
            <div className="max-h-52 overflow-y-auto py-1">
              {queue.map((item, i) => {
                const editing = editingId === item.id;
                const sending = sendingId === item.id;
                const { editable, suffix } = splitQueuedText(
                  item.text,
                  (item.files.length > 0 ? "\n" + item.files.join("\n") : "") +
                    buildDatabaseContext(item.databases) +
                    buildSkillsContext(item.skills),
                );
                const context = splitComposerContext(item.text).context;
                const delegated = context
                  ? context.delegation.specialists.length + (context.delegation.auto ? 1 : 0)
                  : 0;
                return (
                <div
                  key={item.id}
                  className="group flex items-start gap-2.5 px-3 py-2 text-xs transition-colors hover:bg-muted/50"
                >
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    {editing ? (
                      <QueuedMessageEditor
                        key={item.id}
                        initialText={editable}
                        allowEmpty={suffix.length > 0}
                        onSave={(text) => {
                          onEdit(item.id, text + suffix);
                          onEditingChange(null);
                        }}
                        onCancel={() => onEditingChange(null)}
                      />
                    ) : (
                      <div className="truncate text-foreground">
                        {item.rawText || item.text.split("\n")[0]}
                      </div>
                    )}
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {item.model.label}
                      </span>
                      {item.files.length > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          <PaperclipIcon className="size-2.5" />
                          {item.files.length}
                        </span>
                      )}
                      {item.images.length > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          <ImageIcon className="size-2.5" />
                          {item.images.length}
                        </span>
                      )}
                      {item.databases.length > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          <DatabaseIcon className="size-2.5" />
                          {item.databases.length}
                        </span>
                      )}
                      {item.skills.length > 0 && (
                        <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                          <SparklesIcon className="size-2.5" />
                          {item.skills.length}
                        </span>
                      )}
                      {context && context.research.length > 0 && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          title={`${context.research.length} research reference${context.research.length === 1 ? "" : "s"}`}
                        >
                          <BookOpenIcon className="size-2.5" />
                          {context.research.length}
                        </span>
                      )}
                      {delegated > 0 && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          title={context!.delegation.auto ? "Delegate: Kady picks" : `Delegate: ${context!.delegation.specialists.join(", ")}`}
                        >
                          <UsersIcon className="size-2.5" />
                          {context!.delegation.auto ? "auto" : delegated}
                        </span>
                      )}
                      {context?.delegation.verify && (
                        <span
                          className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                          title="Verification gate"
                        >
                          <ShieldCheckIcon className="size-2.5" />
                          verify
                        </span>
                      )}
                    </div>
                  </div>
                  {!editing && !sending && (
                    <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                      <button
                        type="button"
                        onClick={() => onMove(item.id, "up")}
                        disabled={i === 0}
                        className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                        aria-label={`Move queued message ${i + 1} up`}
                      >
                        <ChevronUpIcon className="size-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onMove(item.id, "down")}
                        disabled={i === queue.length - 1}
                        className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                        aria-label={`Move queued message ${i + 1} down`}
                      >
                        <ChevronDownIcon className="size-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onEditingChange(item.id)}
                        className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground"
                        aria-label={`Edit queued message ${i + 1}`}
                      >
                        <PencilIcon className="size-3" />
                      </button>
                      <button
                        type="button"
                        onClick={() => onRemove(item.id)}
                        className="rounded p-1 text-muted-foreground/60 transition-colors hover:bg-destructive/10 hover:text-destructive"
                        aria-label={`Remove queued message ${i + 1}`}
                      >
                        <XIcon className="size-3" />
                      </button>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Full prompt input with @ mention overlay + drag-drop zone.
 * Must be rendered inside <PromptInputProvider>.
 */
