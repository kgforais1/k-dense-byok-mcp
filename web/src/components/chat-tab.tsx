"use client";

import { AddContextMenu } from "@/components/add-context-menu";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputProvider,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
  usePromptInputController,
  type PromptInputProviderState,
} from "@/components/ai-elements/prompt-input";
import {
  SpeechInput,
  type SpeechInputMode,
} from "@/components/ai-elements/speech-input";
import { ComputeSelector, type ModalInstance } from "@/components/compute-selector";
import { ConnectModelCard } from "@/components/connect-model-card";
import { ContextChipsBar } from "@/components/context-chips";
import { ContextUsageIndicator } from "@/components/context-usage-indicator";
import { buildDatabaseContext, type Database } from "@/components/database-selector";
import { KadyFileIcon } from "@/components/file-icon";
import {
  DEFAULT_MODEL,
  ModelSelector,
  modelUsesBillableBudget,
  type Model,
} from "@/components/model-selector";
import { SettingsLink } from "@/components/settings-link";
import { buildSkillsContext, type Skill } from "@/components/skills-selector";
import {
  DEFAULT_THINKING_LEVEL,
  ThinkingSelector,
  type ThinkingLevel,
} from "@/components/thinking-selector";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { computeInstanceFromDefault, useAppDefaults } from "@/lib/app-settings";
import { onChatPrefill } from "@/lib/chat-prefill";
import { routeSubmit, type SendIntent } from "@/lib/chat-routing";
import { withChatSnapshots } from "@/lib/chat-snapshot";
import { slashMenuItems, type SlashMenuItem } from "@/lib/command-blocks";
import {
  EMPTY_DELEGATION,
  buildComposerContext,
  type DelegationChoice,
  type ResearchRef
} from "@/lib/composer-context";
import { hasDirectoryEntries, traverseDroppedEntries } from "@/lib/directory-upload";
import {
  INLINE_IMAGE_ACCEPT,
  MAX_PROMPT_IMAGES,
  isInlineImage,
  promptImagesFromParts,
  type PromptImage,
} from "@/lib/image-attachments";
import {
  moveQueuedMessage,
  removeQueuedMessage,
  updateQueuedMessageText,
  type QueueDirection
} from "@/lib/message-queue";
import {
  MODAL_JOB_FINISHED_EVENT,
  type ModalCatalog,
} from "@/lib/modal-jobs";
import type { NotebookEntry } from "@/lib/notebook";
import { apiFetch } from "@/lib/projects";
import { openSettings } from "@/lib/settings-nav";
import { suggestSkillsForFiles } from "@/lib/skill-suggestions";
import {
  useAgent,
  type AgentRunState,
  type ContextUsage
} from "@/lib/use-agent";
import { useModalCatalog } from "@/lib/use-modal-jobs";
import { useModels, type ModelAvailability } from "@/lib/use-models";
import { usePromptTemplates } from "@/lib/use-prompts";
import { useSessionRestore } from "@/lib/use-session-restore";
import { cn, formatUsd } from "@/lib/utils";
import {
  type ChatWorkspaceState,
  type WorkspaceQueuedMessage,
} from "@/lib/workspace-persistence";
import {
  PaperclipIcon,
  XIcon
} from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MutableRefObject
} from "react";
import { toast } from "sonner";
// FORK: keep queue presentation separate to preserve the frontend line cap.
// FORK: retain the public message exports while splitting presentation.
import { MessageQueueDisplay } from "./chat-message-queue";
import { ChatMessageRow } from "./chat-message-row";
export { AssistantMessageBody,ChatMessageRow } from "./chat-message-row";

/** Toast action for "provider disconnected" errors. */
const PROVIDERS_TOAST_ACTION = {
  action: { label: "Open Settings", onClick: () => openSettings({ tab: "providers" }) },
};

const MAX_QUEUE = 5;

type QueuedMessage = WorkspaceQueuedMessage;

/** Models whose runs must NOT carry a thinkingLevel: local models are built
 *  with reasoning:false (Pi clamps to off) and Fusion rewrites the wire body,
 *  so a level is meaningless there. Mirrors isLocal in model-selector.tsx. */
function thinkingUnsupported(model: {
  id: string;
  provider?: string;
  reasoning?: boolean;
}): boolean {
  return (
    model.reasoning === false ||
    model.provider === "Ollama" ||
    model.provider === "OpenAI-Compatible" ||
    model.id.startsWith("ollama/") ||
    model.id.startsWith("openai-compatible/") ||
    model.id.startsWith("fusion/")
  );
}

function BudgetBanner({
  state,
  totalUsd,
  limitUsd,
}: {
  state: "warn" | "exceeded";
  totalUsd: number;
  limitUsd: number | null;
}) {
  const blocked = state === "exceeded";
  return (
    <div
      role="alert"
      className={cn(
        "mb-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
        blocked
          ? "border-destructive/40 bg-destructive/10 text-destructive"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400"
      )}
    >
      <span className="flex-1">
        {blocked ? (
          <>
            <b>Project spend limit reached</b> ({formatUsd(totalUsd)}
            {limitUsd !== null ? ` / ${formatUsd(limitUsd)}` : ""}). New runs
            are blocked.{" "}
            <SettingsLink tab="project" section="budget">
              Raise the limit in project settings
            </SettingsLink>{" "}
            to continue.
          </>
        ) : (
          <>
            <b>Approaching spend limit</b> ({formatUsd(totalUsd)}
            {limitUsd !== null ? ` / ${formatUsd(limitUsd)}` : ""}). You&apos;re
            over 80% of the project&apos;s cap.
          </>
        )}
      </span>
    </div>
  );
}

const FILE_DRAG_TYPE = "application/x-kady-filepath";

/**
 * Must be rendered inside <PromptInputProvider>.
 */
function PromptDropZone({
  children,
  onFileDrop,
  onFilesUpload,
}: {
  children: React.ReactNode;
  onFileDrop?: (path: string) => void;
  onFilesUpload?: (files: FileList | File[], paths?: string[]) => void;
}) {
  const controller = usePromptInputController();
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounter = useRef(0);

  const isAccepted = useCallback((e: React.DragEvent) => {
    return e.dataTransfer.types.includes(FILE_DRAG_TYPE) || e.dataTransfer.types.includes("Files");
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    if (!isAccepted(e)) return;
    e.preventDefault();
    dragCounter.current++;
    setIsDragOver(true);
  }, [isAccepted]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!isAccepted(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, [isAccepted]);

  const handleDragLeave = useCallback(() => {
    dragCounter.current--;
    if (dragCounter.current <= 0) {
      dragCounter.current = 0;
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragOver(false);

      const path = e.dataTransfer.getData(FILE_DRAG_TYPE);
      if (path) {
        if (onFileDrop) {
          onFileDrop(path);
        } else {
          appendToComposer(controller.textInput, path, " ");
        }
        return;
      }

      if (!onFilesUpload) return;

      if (hasDirectoryEntries(e.dataTransfer.items)) {
        const { files, paths } = await traverseDroppedEntries(e.dataTransfer.items);
        if (files.length > 0) onFilesUpload(files, paths);
      } else if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        // Viewable images attach inline so the model sees them directly;
        // data files (TIFF, CSV, h5ad, …) upload into the sandbox as before.
        const dropped = [...e.dataTransfer.files];
        const inline = dropped.filter((f) => isInlineImage(f.type));
        const rest = dropped.filter((f) => !isInlineImage(f.type));
        const capacity = Math.max(
          0,
          MAX_PROMPT_IMAGES - controller.attachments.files.length,
        );
        if (inline.length > 0 && capacity > 0) {
          controller.attachments.add(inline.slice(0, capacity));
        }
        if (rest.length > 0) onFilesUpload(rest);
      }
    },
    [controller, onFileDrop, onFilesUpload],
  );

  const isOsDrag = isDragOver;
  const label = isDragOver ? "Drop to attach" : "Attach file";

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className="relative"
    >
      {isOsDrag && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5">
          <div className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground shadow">
            <PaperclipIcon className="size-3.5" />
            {label}
          </div>
        </div>
      )}
      <div className={cn("transition-all duration-150", isOsDrag && "opacity-40 pointer-events-none")}>
        {children}
      </div>
    </div>
  );
}

/**
 * Thumbnails for images attached to the next message (pasted, dropped, or
 * picked). They ride the run body as inline image blocks the model sees
 * directly — unlike file chips, which reference sandbox paths.
 * Must be rendered inside <PromptInput>.
 */
function ImageAttachmentsRow() {
  const attachments = usePromptInputAttachments();
  const images = attachments.files.filter((f) => isInlineImage(f.mediaType));
  if (images.length === 0) return null;
  return (
    <div className="flex w-full flex-wrap gap-2 px-3 pt-2.5">
      {images.map((f) => (
        <div key={f.id} className="group relative">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={f.url}
            alt={f.filename ?? "attached image"}
            className="h-16 w-16 rounded-lg border object-cover"
          />
          <button
            type="button"
            onClick={() => attachments.remove(f.id)}
            aria-label={`Remove ${f.filename ?? "attached image"}`}
            className="absolute -right-1.5 -top-1.5 rounded-full border bg-background p-0.5 text-muted-foreground shadow-sm transition-colors hover:text-destructive"
          >
            <XIcon className="size-3" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Append text to the composer, inserting `separator` unless the current
 * value is empty or already ends in whitespace. Single home for the logic
 * shared by file drops, voice transcription, and the Ask Kady prefill. */
function appendToComposer(
  textInput: { value: string; setInput: (v: string) => void },
  text: string,
  separator: " " | "\n",
) {
  const current = textInput.value;
  const sep = current && !current.endsWith(" ") && !current.endsWith("\n") ? separator : "";
  textInput.setInput(current + sep + text);
}

// ---------------------------------------------------------------------------
// @ mention helpers
// ---------------------------------------------------------------------------

function mentionIconForFile(name: string) {
  return <KadyFileIcon name={name} className="size-3.5" />;
}

function HighlightMatch({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const qLower = query.toLowerCase();
  const idx = lower.indexOf(qLower);
  if (idx === -1) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <span className="font-semibold text-foreground">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

/** Inline editor for one queued message. Keyed by item id so state resets per item. */
function ChatInput({
  isActiveTab,
  allFiles,
  attachedFiles,
  onAddFile,
  onRemoveFile,
  onClearFiles,
  onSend,
  pendingSteers,
  pendingFollowUps = [],
  composerRestoreRef,
  inlineError,
  isStreaming,
  agentStatus,
  onStop,
  selectedDbs,
  onDbsChange,
  selectedModel,
  onModelChange,
  contextUsage,
  onCompact,
  selectedComputeTarget,
  onComputeTargetChange,
  thinkingLevel,
  onThinkingLevelChange,
  thinkingDisabled,
  modalCatalog,
  modalCatalogLoading,
  modalCatalogError,
  onRefreshModalCatalog,
  onUploadFiles,
  allSkills,
  selectedSkills,
  onSkillsChange,
  queuedMessages,
  onRemoveFromQueue,
  onMoveInQueue,
  onEditQueued,
  queueEditingId,
  queueSendingId,
  onQueueEditingChange,
  queuePaused = false,
  onResumeQueue,
  budgetState = "ok",
  budgetTotalUsd = 0,
  budgetLimitUsd = null,
  modelAvailability = "available",
  projectId,
  currentSessionId,
  researchRefs,
  onResearchChange,
  delegation,
  onDelegationChange,
}: {
  isActiveTab: boolean;
  allFiles: string[];
  attachedFiles: string[];
  onAddFile: (path: string) => void;
  onRemoveFile: (path: string) => void;
  onClearFiles: () => void;
  /** Resolves false when the message was rejected; the composer keeps its contents. */
  onSend: (text: string, intent: SendIntent, images: PromptImage[]) => Promise<boolean>;
  pendingSteers: string[];
  /** Pi follow-ups queued for the live run (⌥↵). */
  pendingFollowUps?: string[];
  composerRestoreRef: MutableRefObject<((text: string) => void) | null>;
  inlineError: string | null;
  isStreaming: boolean;
  agentStatus: string;
  onStop: () => void;
  selectedDbs: Database[];
  onDbsChange: (dbs: Database[]) => void;
  selectedModel: Model;
  onModelChange: (model: Model) => void;
  contextUsage: ContextUsage | null;
  /** "Compact now" for the context gauge; undefined hides the action. */
  onCompact?: () => void;
  selectedComputeTarget: ModalInstance | null;
  onComputeTargetChange: (instance: ModalInstance | null) => void;
  thinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (level: ThinkingLevel) => void;
  thinkingDisabled: boolean;
  modalCatalog: ModalCatalog | null;
  modalCatalogLoading: boolean;
  modalCatalogError: string | null;
  onRefreshModalCatalog: () => void;
  onUploadFiles: (files: FileList | File[], paths?: string[]) => Promise<string[]>;
  allSkills: Skill[];
  selectedSkills: Skill[];
  onSkillsChange: (skills: Skill[]) => void;
  queuedMessages: QueuedMessage[];
  onRemoveFromQueue: (id: string) => void;
  onMoveInQueue: (id: string, direction: QueueDirection) => void;
  onEditQueued: (id: string, text: string) => void;
  queueEditingId: string | null;
  queueSendingId?: string | null;
  onQueueEditingChange: (id: string | null) => void;
  queuePaused?: boolean;
  onResumeQueue?: () => void;
  budgetState?: "ok" | "warn" | "exceeded";
  budgetTotalUsd?: number;
  budgetLimitUsd?: number | null;
  modelAvailability?: ModelAvailability;
  projectId: string;
  currentSessionId: string | null;
  /** Per-message research references (+ → Research); cleared once sent. */
  researchRefs: ResearchRef[];
  onResearchChange: (refs: ResearchRef[]) => void;
  /** Per-message delegation (+ → Delegate); cleared once sent. */
  delegation: DelegationChoice;
  onDelegationChange: (next: DelegationChoice) => void;
}) {
  const modelAvailable = modelAvailability === "available";
  const budgetBlocked =
    budgetState === "exceeded" && modelUsesBillableBudget(selectedModel);
  const controller = usePromptInputController();

  // "Ask Kady" handoff from the LaTeX editor: only the active tab's composer
  // appends the prefill text (it does not submit), so a background tab never
  // steals the event. Gated on the active TAB, not the visible view — tabs
  // stay mounted behind the Workflows view, and page.tsx switches the view
  // back to chat on the same event. The controller is read through a ref
  // because its identity changes on every keystroke.
  const controllerRef = useRef(controller);
  controllerRef.current = controller;
  useEffect(() => {
    if (!isActiveTab) return;
    return onChatPrefill((text) => appendToComposer(controllerRef.current.textInput, text, "\n"));
  }, [isActiveTab]);

  // Steer failures and Stop restore undelivered text into this composer;
  // the parent holds the ref because it owns the steer/stop calls.
  useEffect(() => {
    composerRestoreRef.current = (text: string) =>
      appendToComposer(controllerRef.current.textInput, text, "\n");
    return () => {
      composerRestoreRef.current = null;
    };
  }, [composerRestoreRef]);

  // User-invoked-only skills never activate on their own, so they are not
  // offered as pinned context; the slash menu is their entry point.
  const modelInvocableSkills = useMemo(
    () => allSkills.filter((s) => !s.disableModelInvocation),
    [allSkills],
  );
  const handleFilesUpload = useCallback(async (files: FileList | File[], paths?: string[]) => {
    const uploaded = await onUploadFiles(files, paths);
    for (const p of uploaded) onAddFile(p);
    // Surface skills that match the uploaded data formats (e.g. .h5ad → anndata)
    // by auto-attaching them; they appear as removable chips, so it's a
    // suggestion the user can undo, not a hidden side-effect.
    const suggested = suggestSkillsForFiles(uploaded, modelInvocableSkills);
    if (suggested.length > 0) {
      const existing = new Set(selectedSkills.map((s) => s.id));
      const additions = suggested.filter((s) => !existing.has(s.id));
      if (additions.length > 0) onSkillsChange([...selectedSkills, ...additions]);
    }
  }, [onUploadFiles, onAddFile, modelInvocableSkills, selectedSkills, onSkillsChange]);

  // Attachment problems (wrong type, too many, too big) and image-only
  // submissions surface here, next to the steer error banner.
  const [attachError, setAttachError] = useState<string | null>(null);
  useEffect(() => {
    if (!attachError) return;
    const t = window.setTimeout(() => setAttachError(null), 5000);
    return () => window.clearTimeout(t);
  }, [attachError]);

  // Wrap onSubmit to convert inline image attachments and append attached
  // file paths and database/skills context, then clear chips. Returning
  // false keeps the composer text + attachments for a retry.
  const handleSubmit = useCallback<Parameters<typeof PromptInput>[0]["onSubmit"]>(
    async (msg, event) => {
      const intent: SendIntent = queueIntentRef.current ? "queue" : "auto";
      queueIntentRef.current = false;
      if (budgetBlocked || !modelAvailable) {
        event?.preventDefault();
        if (!modelAvailable) {
          setAttachError(
            modelAvailability === "checking"
              ? "Model provider status is still loading. Try again in a moment."
              : "This model provider is disconnected. Reconnect it in Settings → Providers or choose another model.",
          );
        }
        return false;
      }
      const refs = attachedFiles.length > 0 ? "\n" + attachedFiles.join("\n") : "";
      const dbCtx = buildDatabaseContext(selectedDbs);
      const skillsCtx = buildSkillsContext(selectedSkills);
      const baseText = msg.text ?? "";
      if (!baseText.trim() && attachedFiles.length === 0) {
        if (msg.files.length > 0) {
          setAttachError("Add a short note to send with the image.");
        }
        return false;
      }
      // Referenced chats are snapshotted now, so the message cites what they
      // said when it was sent rather than whatever they say later.
      const snapshots = researchRefs.some((r) => r.kind === "chat")
        ? await withChatSnapshots(researchRefs, projectId)
        : { refs: researchRefs, failed: [] };
      if (snapshots.failed.length > 0) {
        toast.warning(
          `Couldn't snapshot ${snapshots.failed.length === 1 ? `"${snapshots.failed[0]}"` : `${snapshots.failed.length} chats`}`,
          { description: "Kady will search the full chat log instead." },
        );
      }
      const composerCtx = buildComposerContext({ delegation, research: snapshots.refs });
      const images = await promptImagesFromParts(msg.files);
      // Only clear once the message is actually accepted: a full queue or a
      // failed steer used to wipe the composer text and attachment chips.
      const accepted = await onSend(baseText + refs + dbCtx + skillsCtx + composerCtx, intent, images);
      if (!accepted) {
        event?.preventDefault();
        return false;
      }
      onClearFiles();
      // Research references and delegation are instructions for this one
      // message; pinned skills and data sources stay.
      onResearchChange([]);
      onDelegationChange(EMPTY_DELEGATION);
    },
    [budgetBlocked, modelAvailability, modelAvailable, onSend, attachedFiles, onClearFiles, selectedDbs, selectedSkills, delegation, researchRefs, onResearchChange, onDelegationChange, projectId]
  );

  // @ mention state
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAtIdx, setMentionAtIdx] = useState(0);
  const [mentionSelIdx, setMentionSelIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  // `/` at the very start of the composer opens the slash menu: prompt
  // templates plus user-invoked-only skills (`/skill:<name>`).
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashSelIdx, setSlashSelIdx] = useState(0);
  const slashListRef = useRef<HTMLDivElement>(null);
  const { templates: promptTemplates } = usePromptTemplates();
  const slashItems = useMemo<SlashMenuItem[]>(() => {
    if (slashQuery === null) return [];
    return slashMenuItems(
      slashQuery,
      promptTemplates,
      allSkills.filter((s) => s.disableModelInvocation),
    );
  }, [slashQuery, promptTemplates, allSkills]);
  const safeSlashSelIdx = slashItems.length === 0 ? 0 : Math.min(slashSelIdx, slashItems.length - 1);
  useEffect(() => {
    slashListRef.current?.children[safeSlashSelIdx]?.scrollIntoView({ block: "nearest" });
  }, [safeSlashSelIdx]);
  const applySlash = useCallback(
    (item: SlashMenuItem) => {
      const current = controller.textInput.value;
      const rest = current.replace(/^\/[^\s]*/, "");
      controller.textInput.setInput(`${item.command} ${rest.trimStart()}`);
      setSlashQuery(null);
      setSlashSelIdx(0);
    },
    [controller],
  );
  // Alt is read from keydown, not the form submit event, which carries no
  // modifiers by the time the library's Enter handler calls requestSubmit().
  const queueIntentRef = useRef(false);

  const filteredFiles = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    if (!q) return allFiles.slice(0, 8);
    const nameHits = allFiles.filter(f =>
      (f.split("/").pop()?.toLowerCase() ?? "").includes(q)
    );
    const pathOnly = allFiles.filter(f => {
      const name = f.split("/").pop()?.toLowerCase() ?? "";
      return !name.includes(q) && f.toLowerCase().includes(q);
    });
    return [...nameHits, ...pathOnly].slice(0, 8);
  }, [allFiles, mentionQuery]);

  const safeMentionSelIdx =
    filteredFiles.length === 0
      ? 0
      : Math.min(mentionSelIdx, filteredFiles.length - 1);

  useEffect(() => {
    listRef.current
      ?.children[safeMentionSelIdx]
      ?.scrollIntoView({ block: "nearest" });
  }, [safeMentionSelIdx]);

  const closeMention = useCallback(() => setMentionQuery(null), []);

  const applyMention = useCallback((path: string) => {
    const current = controller.textInput.value;
    const before = current.slice(0, mentionAtIdx).trimEnd();
    const after = current.slice(mentionAtIdx + 1 + (mentionQuery?.length ?? 0)).trimStart();
    const cleaned = [before, after].filter(Boolean).join(" ");
    controller.textInput.setInput(cleaned);
    onAddFile(path);
    setMentionQuery(null);
    setMentionSelIdx(0);
  }, [controller, mentionAtIdx, mentionQuery, onAddFile]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    const cursor = e.target.selectionStart ?? val.length;
    const before = val.slice(0, cursor);
    // Slash menu: only while the caret is still inside the leading command token.
    const slash = before.match(/^\/([^\s/]*)$/);
    if (slash) {
      setSlashQuery(slash[1]);
      setSlashSelIdx(0);
    } else {
      setSlashQuery(null);
    }
    const m = before.match(/@([^\s@]*)$/);
    if (m && m.index !== undefined) {
      setMentionQuery(m[1]);
      setMentionAtIdx(m.index);
      setMentionSelIdx(0);
    } else {
      setMentionQuery(null);
    }
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const slashOpen = slashQuery !== null && slashItems.length > 0;
    if (slashOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashSelIdx((i) => Math.min(i + 1, slashItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashSelIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        applySlash(slashItems[safeSlashSelIdx]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashQuery(null);
        return;
      }
    }
    const isOpen = mentionQuery !== null && filteredFiles.length > 0;
    // An Enter consumed by the mention overlay must not record queue intent —
    // the next submit may be a button click that can't overwrite the flag.
    if (!isOpen && e.key === "Enter" && !e.shiftKey) {
      queueIntentRef.current = e.altKey;
    }
    if (!isOpen) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setMentionSelIdx(i => Math.min(i + 1, filteredFiles.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setMentionSelIdx(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      applyMention(filteredFiles[safeMentionSelIdx]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeMention();
    }
  }, [mentionQuery, filteredFiles, safeMentionSelIdx, applyMention, closeMention, slashQuery, slashItems, safeSlashSelIdx, applySlash]);

  const handleTranscription = useCallback((text: string) => {
    appendToComposer(controller.textInput, text, " ");
  }, [controller]);
  const [speechMode, setSpeechMode] = useState<SpeechInputMode>("detecting");
  const handleAudioRecorded = useCallback(async (audioBlob: Blob) => {
    const form = new FormData();
    form.append("audio", audioBlob, "dictation");
    const response = await apiFetch("/speech/transcribe", {
      method: "POST",
      body: form,
    });
    const payload = (await response.json().catch(() => null)) as
      | { text?: string; detail?: string }
      | null;
    if (!response.ok) {
      throw new Error(
        payload?.detail || `Dictation could not be transcribed (${response.status}).`,
      );
    }
    if (!payload?.text?.trim()) {
      throw new Error("The transcription provider returned no text.");
    }
    return payload.text.trim();
  }, []);

  const isMentionOpen = mentionQuery !== null && filteredFiles.length > 0;
  const isSlashOpen = slashQuery !== null && slashItems.length > 0;
  const submitStatus = isStreaming ? "streaming" : agentStatus === "error" ? "error" : "ready";

  return (
    <PromptDropZone onFileDrop={onAddFile} onFilesUpload={handleFilesUpload}>
      <div className="relative">
        {isSlashOpen && (
          <div
            className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border bg-background shadow-lg"
            onMouseDown={(e) => e.preventDefault()}
            data-testid="slash-menu"
          >
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Commands</span>
              {slashQuery && <span className="font-mono text-[11px] text-primary">/{slashQuery}</span>}
              <span className="ml-auto text-[10px] text-muted-foreground">
                {slashItems.length} match{slashItems.length !== 1 ? "es" : ""}
              </span>
              <kbd className="rounded border bg-muted px-1 py-0.5 text-[9px] font-mono text-muted-foreground">↑↓</kbd>
              <kbd className="rounded border bg-muted px-1 py-0.5 text-[9px] font-mono text-muted-foreground">↵</kbd>
            </div>
            <div ref={slashListRef} className="max-h-52 overflow-y-auto py-1">
              {slashItems.map((item, i) => (
                <div
                  key={item.command}
                  onClick={() => applySlash(item)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 px-3 py-2 text-xs transition-colors",
                    i === safeSlashSelIdx ? "bg-muted" : "hover:bg-muted/50",
                  )}
                >
                  <span className="min-w-0 truncate font-mono text-foreground">{item.label}</span>
                  {item.argumentHint && (
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{item.argumentHint}</span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.description}</span>
                  <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[9px] uppercase tracking-wide text-muted-foreground">
                    {item.kind}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {isMentionOpen && !isSlashOpen && (
          <div
            className="absolute bottom-full left-0 right-0 z-20 mb-2 overflow-hidden rounded-xl border bg-background shadow-lg"
            onMouseDown={(e) => e.preventDefault()}
          >
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Files</span>
              {mentionQuery && (
                <span className="font-mono text-[11px] text-primary">@{mentionQuery}</span>
              )}
              <span className="ml-auto text-[10px] text-muted-foreground">
                {filteredFiles.length} match{filteredFiles.length !== 1 ? "es" : ""}
              </span>
              <kbd className="rounded border bg-muted px-1 py-0.5 text-[9px] font-mono text-muted-foreground">↑↓</kbd>
              <kbd className="rounded border bg-muted px-1 py-0.5 text-[9px] font-mono text-muted-foreground">↵</kbd>
            </div>

            <div ref={listRef} className="max-h-52 overflow-y-auto py-1">
              {filteredFiles.map((path, i) => {
                const name = path.split("/").pop() ?? path;
                const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
                return (
                  <div
                    key={path}
                    onClick={() => applyMention(path)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2.5 px-3 py-2 text-xs transition-colors",
                      i === safeMentionSelIdx ? "bg-muted" : "hover:bg-muted/50"
                    )}
                  >
                    <span className="shrink-0">{mentionIconForFile(name)}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-foreground">
                        <HighlightMatch text={name} query={mentionQuery ?? ""} />
                      </span>
                      {dir && (
                        <span className="block truncate text-muted-foreground/70 text-[11px]">
                          <HighlightMatch text={dir} query={mentionQuery ?? ""} />
                        </span>
                      )}
                    </span>
                    {i === safeMentionSelIdx && (
                      <kbd className="ml-auto shrink-0 rounded border bg-muted px-1 py-0.5 text-[9px] font-mono text-muted-foreground">↵</kbd>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {!isMentionOpen && (
          <MessageQueueDisplay
            queue={queuedMessages}
            steering={pendingSteers}
            followUp={pendingFollowUps}
            onRemove={onRemoveFromQueue}
            onMove={onMoveInQueue}
            onEdit={onEditQueued}
            editingId={queueEditingId}
            sendingId={queueSendingId}
            onEditingChange={onQueueEditingChange}
            paused={queuePaused}
            onResume={onResumeQueue}
          />
        )}

        {(inlineError || attachError) && (
          <div
            role="alert"
            className="mb-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {inlineError ?? attachError}
          </div>
        )}

        {budgetState !== "ok" && modelUsesBillableBudget(selectedModel) && (
          <BudgetBanner
            state={budgetState}
            totalUsd={budgetTotalUsd}
            limitUsd={budgetLimitUsd}
          />
        )}

        <PromptInput
          onSubmit={handleSubmit}
          // Inline attachments are for images the model should SEE; other
          // files reach the agent through the sandbox-upload path instead.
          accept={INLINE_IMAGE_ACCEPT}
          multiple
          maxFiles={MAX_PROMPT_IMAGES}
          maxFileSize={20 * 1024 * 1024}
          // The wrapping PromptDropZone owns drop routing (images inline,
          // data files to the sandbox); disable the built-in form handler
          // so drops aren't double-added.
          disableFormDrop
          onError={(err) =>
            setAttachError(
              err.code === "accept"
                ? "Only PNG, JPEG, WebP, or GIF attach to the message — use + to add other files to the sandbox."
                : err.code === "max_files"
                  ? `At most ${MAX_PROMPT_IMAGES} images per message.`
                  : "Image is too large (20MB max).",
            )
          }
          className="@container/composer rounded-xl border shadow-sm"
        >
          <ImageAttachmentsRow />
          <ContextChipsBar
            attachedFiles={attachedFiles}
            onRemoveFile={onRemoveFile}
            selectedDbs={selectedDbs}
            onDbsChange={onDbsChange}
            selectedSkills={selectedSkills}
            onSkillsChange={onSkillsChange}
            researchRefs={researchRefs}
            onResearchChange={onResearchChange}
            delegation={delegation}
            onDelegationChange={onDelegationChange}
          />
          <PromptInputTextarea
            placeholder={
              isStreaming
                ? pendingSteers.length + pendingFollowUps.length > 0
                  ? `Steer the run… (${pendingSteers.length + pendingFollowUps.length} pending · ⌥↵ to run after this turn)`
                  : "Steer the run… (⌥↵ to run after this turn)"
                : queuedMessages.length >= MAX_QUEUE
                  ? `Queue full (${MAX_QUEUE}/${MAX_QUEUE})`
                  : "Ask Kady anything… (@ for files, / for commands, + to add context)"
            }
            onChange={handleChange}
            onKeyDown={handleKeyDown}
          />
          {/* From ~30rem up the toolbar is one row: the model/compute chips
              truncate instead of pushing dictate + send onto a second line.
              Below that (the chat pane can shrink to 280px) wrapping is the
              lesser evil, so the container query hands control back. */}
          <PromptInputFooter className="@min-[30rem]/composer:flex-nowrap">
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              <AddContextMenu
                selectedDbs={selectedDbs}
                onDbsChange={onDbsChange}
                allSkills={modelInvocableSkills}
                selectedSkills={selectedSkills}
                onSkillsChange={onSkillsChange}
                onUploadFiles={handleFilesUpload}
                projectId={projectId}
                currentSessionId={currentSessionId}
                researchRefs={researchRefs}
                onResearchChange={onResearchChange}
                delegation={delegation}
                onDelegationChange={onDelegationChange}
              />
              <ModelSelector
                selected={selectedModel}
                onChange={onModelChange}
              />
              <ThinkingSelector
                selected={thinkingLevel}
                onChange={onThinkingLevelChange}
                disabled={thinkingDisabled}
              />
              <ComputeSelector
                selected={selectedComputeTarget}
                onChange={onComputeTargetChange}
                catalog={modalCatalog}
                loading={modalCatalogLoading}
                error={modalCatalogError}
                onRefresh={onRefreshModalCatalog}
              />
              <ContextUsageIndicator
                usage={contextUsage}
                onCompact={onCompact}
                compactDisabled={isStreaming}
              />
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <InfoTooltip
                content={
                  <>
                    <b>Dictate</b>
                    <br />
                    {speechMode === "detecting"
                      ? "Checking dictation support…"
                      : speechMode === "speech-recognition"
                        ? "Hold to dictate using this browser's speech recognition."
                        : speechMode === "media-recorder"
                          ? "Hold to record. Audio is sent to OpenRouter for transcription."
                          : "This browser cannot record audio for dictation."}
                  </>
                }
              >
                <span>
                  <SpeechInput
                    size="icon-sm"
                    variant="ghost"
                    onTranscriptionChange={handleTranscription}
                    onAudioRecorded={handleAudioRecorded}
                    onModeChange={setSpeechMode}
                    onSpeechError={(message) => toast.error(message)}
                  />
                </span>
              </InfoTooltip>
              <InfoTooltip
                content={
                  !modelAvailable ? (
                    <>
                      <b>
                        {modelAvailability === "checking"
                          ? "Checking model provider"
                          : "Model provider disconnected"}
                      </b>
                      <br />
                      {modelAvailability === "checking"
                        ? "Wait a moment for provider status to load."
                        : "Reconnect it in Settings → Providers or choose another model."}
                    </>
                  ) : budgetBlocked ? (
                    <>
                      <b>Spend limit reached</b>
                      <br />
                      Project has hit its spend limit (
                      {formatUsd(budgetTotalUsd)}
                      {budgetLimitUsd !== null
                        ? ` / ${formatUsd(budgetLimitUsd)}`
                        : ""}
                      ). Raise the limit in Settings → Project → General to continue.
                    </>
                  ) : isStreaming ? (
                    <>
                      <b>Stop</b>
                      <br />
                      Cancel the current turn (⏎ steers it instead). Undelivered
                      steering messages return to the composer, queued prompts
                      pause until you resume them, and files the agent already
                      wrote stay in the sandbox.
                    </>
                  ) : queuedMessages.length >= MAX_QUEUE ? (
                    <>
                      <b>Queue is full</b>
                      <br />
                      Wait for the agent to finish before adding more prompts.
                    </>
                  ) : (
                    <>
                      <b>Send message</b>
                      <br />
                      Press <kbd>↵</kbd> to send, <kbd>⇧</kbd>+<kbd>↵</kbd> for
                      a new line. Prompts sent while the agent is busy steer
                      the live run; ⌥⏎ queues a new run instead.
                    </>
                  )
                }
              >
                <PromptInputSubmit
                  status={submitStatus as "streaming" | "error" | "ready"}
                  onStop={onStop}
                  disabled={(budgetBlocked || !modelAvailable) && !isStreaming}
                />
              </InfoTooltip>
            </div>
          </PromptInputFooter>
        </PromptInput>
      </div>
    </PromptDropZone>
  );
}

// ---------------------------------------------------------------------------
// ChatTab — full chat surface (Conversation + ChatInput + queue) for one tab.
// Each tab owns its own agent session, model selection, attached files,
// queued messages, etc. Sandbox/file tree are shared and passed in.
// ---------------------------------------------------------------------------

export interface ChatTabMeta {
  sessionId: string | null;
  status: "ready" | "submitted" | "streaming" | "error";
  runState: AgentRunState;
  isStreaming: boolean;
  needsInput: boolean;
  userMessageCount: number;
  notebookEntries: NotebookEntry[];
  subagentCompletions: number;
}

export interface ChatTabHandle {
  /**
   * Send a workflow-style prompt into this tab. Used by the Workflows panel
   * which routes its launches to the active chat tab.
   */
  launchWorkflow: (
    prompt: string,
    model: Model,
    inputFiles: string[],
  ) => Promise<void>;
  /**
   * Send a one-off prompt using the tab's currently selected model.
   * Used for ad-hoc actions like "Organize files" from the file-tree panel.
   */
  sendQuick: (prompt: string) => Promise<void>;
  /**
   * Cancel the in-flight turn (if any). Called by the parent when a tab
   * is closed while streaming, so the agent doesn't keep running with
   * nowhere to render its output.
   */
  stop: () => void;
  /**
   * Scroll the transcript to a tool call's chip and flash it (notebook →
   * chat deep link; the notebook entry id IS the tool-call id). Returns
   * false when the chip isn't in this tab's transcript.
   */
  scrollToToolCall: (toolCallId: string) => boolean;
}

export interface ChatTabProps {
  tabId: string;
  projectId: string;
  isActive: boolean;
  /** True when this is the selected tab, even if the Workflows view hides the
   * chat column — the Ask Kady prefill targets the tab, not the view. */
  isActiveTab: boolean;
  /** Stored session to reopen into this tab (History menu / reload recovery). */
  initialSessionId?: string | null;
  /** Browser-persisted controls, queue, and composer state for this tab. */
  initialWorkspaceState?: ChatWorkspaceState;
  // Shared sandbox/state passed in (one instance for the whole project)
  allFiles: string[];
  sandboxReady: boolean;
  uploadFiles: (files: FileList | File[], paths?: string[]) => Promise<string[]>;
  onSandboxRefresh: () => void;
  onTurnComplete: () => void;
  allSkills: Skill[];
  skillsReady: boolean;
  budgetState: "ok" | "warn" | "exceeded";
  budgetTotalUsd: number;
  budgetLimitUsd: number | null;
  onMetaChange: (tabId: string, meta: ChatTabMeta) => void;
  onWorkspaceStateChange?: (tabId: string, state: ChatWorkspaceState) => void;
  /** The stored session couldn't be reopened; forget the binding for this tab. */
  onSessionUnavailable?: (tabId: string) => void;
  /** Open the Lab Notebook panel focused on this entry (chat → notebook). */
  onViewInNotebook?: (entryId: string) => void;
  /** Open the Compute panel, optionally focused on a durable Modal job. */
  onViewCompute?: (jobId?: string) => void;
  /** Open a typed result artifact in the center file preview. */
  onOpenFile?: (path: string) => void;
}

export const ChatTab = forwardRef<ChatTabHandle, ChatTabProps>(function ChatTab(
  {
    tabId,
    projectId,
    isActive,
    isActiveTab,
    initialSessionId,
    initialWorkspaceState,
    allFiles,
    sandboxReady,
    uploadFiles,
    onSandboxRefresh,
    onTurnComplete,
    allSkills,
    skillsReady,
    budgetState,
    budgetTotalUsd,
    budgetLimitUsd,
    onMetaChange,
    onWorkspaceStateChange,
    onSessionUnavailable,
    onViewInNotebook,
    onViewCompute,
    onOpenFile,
  },
  ref,
) {
  const {
    messages,
    contextUsage,
    status,
    reconnecting,
    runState,
    send,
    stop,
    steer,
    followUp,
    compact,
    pendingSteers,
    pendingFollowUps,
    getSessionId,
    loadSession,
    notebookEntries,
    subagentCompletions,
  } = useAgent(projectId);
  const isStreaming = status === "streaming" || status === "submitted";
  // Scopes the deep-link querySelector to THIS tab's transcript.
  const rootRef = useRef<HTMLDivElement>(null);

  // Reopened tab: hydrate the transcript from the stored session before any
  // sends. The session is gone from disk (deleted project data, pruned
  // sessions) when the restore fails — drop the stale binding so the tab
  // behaves like a fresh chat instead of pointing at an id the server will 404
  // on forever.
  const handleSessionUnavailable = useCallback(() => {
    onSessionUnavailable?.(tabId);
    toast.error("That conversation is no longer available — starting a new one.");
  }, [onSessionUnavailable, tabId]);
  const initialSessionReady = useSessionRestore({
    sessionId: initialSessionId ?? null,
    loadSession,
    onUnavailable: handleSessionUnavailable,
  });

  const prevMessageCount = useRef(0);

  // Per-tab settings
  const [selectedModel, setSelectedModel] = useState<Model>(
    () => initialWorkspaceState?.selectedModel ?? DEFAULT_MODEL,
  );
  const { isModelAvailable, modelAvailability, hasAnyModelAccess, models: knownModels } = useModels();
  const selectedModelAvailability = modelAvailability(selectedModel);
  const selectedModelAvailable = selectedModelAvailability === "available";
  const selectedBudgetBlocked =
    budgetState === "exceeded" && modelUsesBillableBudget(selectedModel);
  const [selectedComputeTarget, setSelectedComputeTarget] = useState<ModalInstance | null>(
    () => initialWorkspaceState?.selectedComputeTarget ?? null,
  );
  const selectedComputeOptions = useMemo(
    () =>
      selectedComputeTarget
        ? {
            gpuCount: selectedComputeTarget.gpuCount,
            ...(selectedComputeTarget.fallback
              ? { gpuFallback: [selectedComputeTarget.fallback] }
              : {}),
            cache:
              selectedComputeTarget.cache === "none"
                ? ("none" as const)
                : ("project" as const),
          }
        : undefined,
    [selectedComputeTarget],
  );
  const [thinkingLevel, setThinkingLevel] = useState<ThinkingLevel>(
    () => initialWorkspaceState?.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
  );
  const thinkingDisabled = thinkingUnsupported(selectedModel);
  const {
    catalog: modalCatalog,
    loading: modalCatalogLoading,
    error: modalCatalogError,
    refresh: refreshModalCatalog,
  } = useModalCatalog(projectId);

  // A tab with nothing to copy from (a project's first chat) starts from the
  // saved Settings → Defaults once they load — unless the user already picked
  // something on its chips. The model waits until its provider's list lands.
  const appDefaults = useAppDefaults();
  const chipsTouched = useRef(false);
  const defaultsPending = useRef({
    model: !initialWorkspaceState && !initialSessionId,
    rest: !initialWorkspaceState && !initialSessionId,
  });
  useEffect(() => {
    const pending = defaultsPending.current;
    if (!appDefaults || chipsTouched.current) return;
    if (pending.rest) {
      pending.rest = false;
      if (appDefaults.thinkingLevel) setThinkingLevel(appDefaults.thinkingLevel);
      const compute = computeInstanceFromDefault(appDefaults.compute, modalCatalog?.instances);
      if (compute) setSelectedComputeTarget(compute);
    }
    if (pending.model) {
      if (!appDefaults.model) {
        pending.model = false;
        return;
      }
      const model = knownModels.find((candidate) => candidate.id === appDefaults.model);
      if (model) {
        pending.model = false;
        setSelectedModel(model);
      }
    }
  }, [appDefaults, knownModels, modalCatalog]);
  const markChipsTouched = useCallback(() => {
    chipsTouched.current = true;
  }, []);

  const [attachedFiles, setAttachedFiles] = useState<string[]>(
    () => initialWorkspaceState?.attachedFiles ?? [],
  );
  const [selectedDbs, setSelectedDbs] = useState<Database[]>(
    () => initialWorkspaceState?.selectedDatabases ?? [],
  );
  const [selectedSkills, setSelectedSkills] = useState<Skill[]>(
    () => initialWorkspaceState?.selectedSkills ?? [],
  );
  const [researchRefs, setResearchRefs] = useState<ResearchRef[]>(
    () => initialWorkspaceState?.researchRefs ?? [],
  );
  const [delegation, setDelegation] = useState<DelegationChoice>(
    () => initialWorkspaceState?.delegation ?? EMPTY_DELEGATION,
  );
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>(
    () => initialWorkspaceState?.queuedMessages ?? [],
  );
  const queueIdCounter = useRef(
    initialWorkspaceState?.queuedMessages.reduce(
      (maximum, message) => Math.max(maximum, Number.parseInt(message.id, 10) || 0),
      0,
    ) ?? 0,
  );
  const [composerDraft, setComposerDraft] = useState<PromptInputProviderState>(
    () => initialWorkspaceState?.composer ?? { text: "", attachments: [] },
  );
  // Mirrored every render so async continuations (the steer fallback) read
  // the CURRENT queue length, not the one closed over before the await.
  const messageQueueLengthRef = useRef(0);
  messageQueueLengthRef.current = messageQueue.length;
  const composerRestoreRef = useRef<((text: string) => void) | null>(null);
  // Set by Stop: without it, cancelling a turn immediately started the next
  // queued message, so "Stop" only ever paused for a fraction of a second.
  const [queuePaused, setQueuePaused] = useState(false);
  const queueFlushInFlightRef = useRef(false);
  const [queueSendingId, setQueueSendingId] = useState<string | null>(null);
  const [steerError, setSteerError] = useState<string | null>(null);

  useEffect(() => {
    if (!steerError) return;
    const t = window.setTimeout(() => setSteerError(null), 5000);
    return () => window.clearTimeout(t);
  }, [steerError]);

  const [copiedId, setCopiedId] = useState<string | null>(null);

  const addAttachedFile = useCallback((path: string) => {
    setAttachedFiles(prev => prev.includes(path) ? prev : [...prev, path]);
  }, []);
  const removeAttachedFile = useCallback((path: string) => {
    setAttachedFiles(prev => prev.filter(p => p !== path));
  }, []);
  const clearAttachedFiles = useCallback(() => setAttachedFiles([]), []);

  useEffect(() => {
    if (!sandboxReady) return;
    const available = new Set(allFiles);
    setAttachedFiles((current) => {
      const next = current.filter((path) => available.has(path));
      return next.length === current.length ? current : next;
    });
    setMessageQueue((current) => {
      let changed = false;
      const next = current.map((message) => {
        const files = message.files.filter((path) => available.has(path));
        if (files.length === message.files.length) return message;
        changed = true;
        return { ...message, files };
      });
      return changed ? next : current;
    });
  }, [allFiles, sandboxReady]);

  useEffect(() => {
    if (!skillsReady || allSkills.length === 0) return;
    const available = new Set(allSkills.map((skill) => skill.id));
    setSelectedSkills((current) => {
      const next = current.filter((skill) => available.has(skill.id));
      return next.length === current.length ? current : next;
    });
    setMessageQueue((current) => {
      let changed = false;
      const next = current.map((message) => {
        const skills = message.skills.filter((skill) => available.has(skill.id));
        if (skills.length === message.skills.length) return message;
        changed = true;
        return { ...message, skills };
      });
      return changed ? next : current;
    });
  }, [allSkills, skillsReady]);

  const removeFromQueue = useCallback((id: string) => {
    setMessageQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);
  const moveInQueue = useCallback((id: string, direction: QueueDirection) => {
    setMessageQueue((prev) => moveQueuedMessage(prev, id, direction));
  }, []);
  const editQueuedMessage = useCallback((id: string, text: string) => {
    setMessageQueue((prev) => updateQueuedMessageText(prev, id, text));
  }, []);
  // Which queued message has its inline editor open. Derived against the live
  // queue (ids are never reused) so a removal or send while editing releases
  // the hold without an effect.
  const [editingQueueIdState, setEditingQueueIdState] = useState<string | null>(null);
  const queueEditingId =
    editingQueueIdState !== null && messageQueue.some((item) => item.id === editingQueueIdState)
      ? editingQueueIdState
      : null;

  const copyTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    },
    [],
  );

  const handleCopy = useCallback((id: string, content: string) => {
    navigator.clipboard.writeText(content);
    setCopiedId(id);
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    copyTimerRef.current = window.setTimeout(() => {
      copyTimerRef.current = null;
      setCopiedId(null);
    }, 2000);
  }, []);

  // Auto-refresh sandbox tree when this tab finishes a turn
  useEffect(() => {
    if (
      status === "ready" &&
      messages.length > 0 &&
      messages.length !== prevMessageCount.current
    ) {
      prevMessageCount.current = messages.length;
      onSandboxRefresh();
      onTurnComplete();
    }
  }, [status, messages.length, onSandboxRefresh, onTurnComplete]);

  // Auto-send the next queued message when the agent becomes ready
  useEffect(() => {
    if (queuePaused) return; // Stop halts all work, not just the live turn
    // Hold while an inline edit is open: otherwise the head of the queue can
    // fire mid-edit with the old text and the editor vanishes under the user.
    if (queueEditingId !== null) return;
    if (!initialSessionReady || status !== "ready" || messageQueue.length === 0) return;
    if (queueFlushInFlightRef.current) return;
    const [next] = messageQueue;
    if (!isModelAvailable(next.model)) return;
    if (budgetState === "exceeded" && modelUsesBillableBudget(next.model)) return;
    const id = window.setTimeout(() => {
      queueFlushInFlightRef.current = true;
      setQueueSendingId(next.id);
      let accepted = false;
      void send(
        next.text,
        next.model.id,
        {
          attachments: next.files,
          skills: next.skills.map((s) => s.name),
          databases: next.databases.map((db) => db.name),
        },
        next.model.fusionConfig,
        next.computeTarget ?? undefined,
        next.computeOptions,
        next.thinkingLevel ?? undefined,
        next.images.length > 0 ? next.images : undefined,
        () => {
          accepted = true;
          setMessageQueue((current) => removeQueuedMessage(current, next.id));
          setQueueSendingId(null);
        },
      ).then((acceptedId) => {
        if (!accepted && !acceptedId) {
          setQueuePaused(true);
          toast.error("Queued message was not delivered. The queue has been paused.");
        }
      }).finally(() => {
        queueFlushInFlightRef.current = false;
        setQueueSendingId(null);
      });
    }, 0);
    return () => window.clearTimeout(id);
  }, [
    budgetState,
    initialSessionReady,
    isModelAvailable,
    messageQueue,
    queueEditingId,
    queuePaused,
    send,
    status,
  ]);

  // A fresh submission is an explicit "keep going", so it lifts the pause.
  useEffect(() => {
    if (isStreaming) setQueuePaused(false);
  }, [isStreaming]);

  useEffect(() => {
    onWorkspaceStateChange?.(tabId, {
      selectedModel,
      thinkingLevel,
      selectedComputeTarget,
      attachedFiles,
      selectedDatabases: selectedDbs,
      selectedSkills,
      researchRefs,
      delegation,
      queuedMessages: messageQueue,
      composer: composerDraft,
    });
  }, [
    attachedFiles,
    composerDraft,
    delegation,
    researchRefs,
    messageQueue,
    onWorkspaceStateChange,
    selectedComputeTarget,
    selectedDbs,
    selectedModel,
    selectedSkills,
    tabId,
    thinkingLevel,
  ]);

  // Bubble meta up to parent so the page can drive the cost pill and tab
  // strip badges from the active tab.
  const sessionId = getSessionId();
  useEffect(() => {
    const onModalJobFinished = (event: Event) => {
      const detail = (
        event as CustomEvent<{ projectId?: string; sessionId?: string | null }>
      ).detail;
      if (detail?.projectId && detail.projectId !== projectId) return;
      if (detail?.sessionId && detail.sessionId !== sessionId) return;
      if (!detail?.sessionId && !isActiveTab) return;
      onSandboxRefresh();
      onTurnComplete();
    };
    window.addEventListener(MODAL_JOB_FINISHED_EVENT, onModalJobFinished);
    return () => window.removeEventListener(MODAL_JOB_FINISHED_EVENT, onModalJobFinished);
  }, [isActiveTab, onSandboxRefresh, onTurnComplete, projectId, sessionId]);
  const userMessageCount = useMemo(
    () => messages.filter((m) => m.role === "user").length,
    [messages],
  );
  const needsInput = isStreaming && messages.some((message) =>
    message.activities?.some((activity) =>
      (activity.toolName === "interview" || activity.toolName === "permission") &&
      activity.status === "running",
    ),
  );
  useEffect(() => {
    onMetaChange(tabId, {
      sessionId,
      status,
      runState,
      isStreaming,
      needsInput,
      userMessageCount,
      notebookEntries,
      subagentCompletions,
    });
  }, [
    tabId,
    sessionId,
    status,
    runState,
    isStreaming,
    needsInput,
    userMessageCount,
    notebookEntries,
    subagentCompletions,
    onMetaChange,
  ]);

  /** Returns false when the message could not be queued (caller keeps the draft). */
  const enqueue = useCallback(
    (trimmed: string, images: PromptImage[] = []) => {
      if (messageQueueLengthRef.current >= MAX_QUEUE) {
        toast.error(
          `Queue is full (${MAX_QUEUE}/${MAX_QUEUE}). Wait for the agent to work through it.`,
        );
        return false;
      }
      if (!selectedModelAvailable) {
        toast.error(
          selectedModelAvailability === "checking"
            ? "Model provider status is still loading. Try again in a moment."
            : "This model provider is disconnected. Reconnect it in Settings or choose another model.",
          PROVIDERS_TOAST_ACTION,
        );
        return false;
      }
      messageQueueLengthRef.current++;
      setMessageQueue((prev) => [
        ...prev,
        {
          id: String(++queueIdCounter.current),
          rawText: trimmed.split("\n")[0],
          text: trimmed,
          model: {
            id: selectedModel.id,
            label: selectedModel.label,
            fusionConfig: selectedModel.fusionConfig,
          },
          databases: [...selectedDbs],
          skills: [...selectedSkills],
          files: [...attachedFiles],
          images,
          computeTarget: selectedComputeTarget?.id ?? null,
          computeOptions: selectedComputeOptions,
          thinkingLevel: thinkingDisabled ? null : thinkingLevel,
          timestamp: Date.now(),
        },
      ]);
      return true;
    },
    [selectedModel, selectedModelAvailability, selectedModelAvailable, selectedDbs, selectedSkills, attachedFiles, selectedComputeTarget, selectedComputeOptions, thinkingDisabled, thinkingLevel],
  );

  /**
   * Route a composer submission. Resolves false when nothing was accepted, so
   * the composer keeps the user's text *and* file chips instead of clearing
   * them into the void.
   */
  const handleCompact = useCallback(async () => {
    const result = await compact();
    if (result.ok) {
      const after = result.estimatedTokensAfter;
      toast.success(
        `Context compacted: ${result.tokensBefore.toLocaleString()} tokens` +
          (after !== null ? ` → about ${after.toLocaleString()}` : "") +
          (result.costUsd > 0 ? ` · ${formatUsd(result.costUsd)}` : ""),
      );
      return;
    }
    if (result.reason === "streaming") toast.error("Wait for the current run to finish before compacting.");
    else if (result.reason === "budget") toast.error(result.detail ?? "Project spend limit reached.");
    else if (result.reason === "no_session") toast.info("Nothing to compact yet.");
    else if (result.reason === "too_small")
      toast.info(result.detail ?? "Nothing to compact yet: the conversation still fits in the recent-context window.");
    else toast.error(result.detail ?? "Compaction failed.");
  }, [compact]);

  const handleSend = useCallback(
    async (text: string, intent: SendIntent, images: PromptImage[] = []): Promise<boolean> => {
      if (!initialSessionReady && !getSessionId()) return false;
      if (!selectedModelAvailable) {
        toast.error(
          selectedModelAvailability === "checking"
            ? "Model provider status is still loading. Try again in a moment."
            : "This model provider is disconnected. Reconnect it in Settings or choose another model.",
          PROVIDERS_TOAST_ACTION,
        );
        return false;
      }
      if (selectedBudgetBlocked) return false;
      const trimmed = text.trim();
      if (!trimmed) return false;
      const sendNow = () =>
        send(
          trimmed,
          selectedModel.id,
          {
            attachments: attachedFiles,
            skills: selectedSkills.map((s) => s.name),
            databases: selectedDbs.map((db) => db.name),
          },
          selectedModel.fusionConfig,
          selectedComputeTarget?.id,
          selectedComputeOptions,
          thinkingDisabled ? undefined : thinkingLevel,
          images.length > 0 ? images : undefined,
        );
      const route = routeSubmit(isStreaming, intent, images.length > 0, reconnecting);
      if (route === "localQueue") return enqueue(trimmed, images);
      if (route === "followUp") {
        // Pi delivers it inside the live run once the agent is otherwise done.
        // If the run ends first, keep ordering behind any client-side queue.
        const result = await followUp(trimmed, images.length > 0 ? images : undefined);
        if (result === "ok") return true;
        if (result === "not_streaming") {
          return enqueue(trimmed, images);
        }
        // Transport failure: hold it in the client-side queue rather than lose it.
        return enqueue(trimmed, images);
      }
      if (route === "steer") {
        const result = await steer(trimmed);
        if (result === "ok") return true;
        if (result === "not_streaming") {
          // The run ended while we typed: keep ordering behind any queue.
          return enqueue(trimmed);
        }
        // Reporting failure keeps the text AND the attachment chips; restoring
        // only the text used to drop the file context silently.
        setSteerError("Couldn't deliver the steering message — your text was restored.");
        return false;
      }
      // Not awaited: send() resolves only when the whole turn is done, and the
      // composer stays filled with the sent prompt until this returns — so the
      // next thing typed appends to a message the agent is already answering.
      void sendNow();
      return true;
    },
    [
      selectedBudgetBlocked,
      initialSessionReady,
      getSessionId,
      selectedModelAvailability,
      selectedModelAvailable,
      isStreaming,
      reconnecting,
      steer,
      followUp,
      enqueue,
      send,
      selectedModel,
      selectedComputeTarget,
      selectedComputeOptions,
      selectedDbs,
      selectedSkills,
      attachedFiles,
      thinkingDisabled,
      thinkingLevel,
    ],
  );

  const handleStop = useCallback(async () => {
    // Pause before awaiting: the moment status flips to "ready" the queue
    // effect would otherwise fire the next message.
    setQueuePaused(true);
    const restored = await stop();
    if (restored.length > 0) composerRestoreRef.current?.(restored.join("\n"));
  }, [stop]);

  const resumeQueue = useCallback(() => setQueuePaused(false), []);

  // Imperatively launch a workflow into this tab (called by parent on the
  // active tab when the user hits "Launch" on a workflow template).
  useImperativeHandle(
    ref,
    () => ({
      stop,
      scrollToToolCall: (toolCallId: string) => {
        const el = rootRef.current?.querySelector(
          `[data-tool-call-id="${CSS.escape(toolCallId)}"]`,
        );
        if (!el) return false;
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        el.classList.add("kady-flash");
        setTimeout(() => el.classList.remove("kady-flash"), 1800);
        return true;
      },
      sendQuick: async (prompt: string) => {
        if (!initialSessionReady && !getSessionId()) return;
        if (!selectedModelAvailable) {
          toast.error(
            selectedModelAvailability === "checking"
              ? "Model provider status is still loading. Try again in a moment."
              : "Reconnect this model provider in Settings before sending.",
            PROVIDERS_TOAST_ACTION,
          );
          return;
        }
        if (selectedBudgetBlocked) return;
        await send(
          prompt,
          selectedModel.id,
          undefined,
          selectedModel.fusionConfig,
          selectedComputeTarget?.id,
          selectedComputeOptions,
          thinkingDisabled ? undefined : thinkingLevel,
        );
      },
      launchWorkflow: async (prompt, model, inputFiles) => {
        if (!initialSessionReady && !getSessionId()) return;
        const workflowModelAvailability = modelAvailability(model);
        if (workflowModelAvailability !== "available") {
          toast.error(
            workflowModelAvailability === "checking"
              ? "Model provider status is still loading. Try again in a moment."
              : "Reconnect this model provider in Settings before launching.",
            PROVIDERS_TOAST_ACTION,
          );
          return;
        }
        if (budgetState === "exceeded" && modelUsesBillableBudget(model)) return;
        setSelectedModel(model);
        await send(
          prompt,
          model.id,
          {
            attachments: inputFiles,
            skills: [],
            databases: [],
          },
          model.fusionConfig,
          selectedComputeTarget?.id,
          selectedComputeOptions,
          thinkingUnsupported(model) ? undefined : thinkingLevel,
        );
      },
    }),
    [
      send,
      stop,
      initialSessionReady,
      getSessionId,
      budgetState,
      isModelAvailable,
      modelAvailability,
      selectedBudgetBlocked,
      selectedModelAvailability,
      selectedModelAvailable,
      selectedModel.id,
      selectedModel.fusionConfig,
      selectedComputeTarget?.id,
      selectedComputeOptions,
      thinkingDisabled,
      thinkingLevel,
    ],
  );

  // Background tabs stay mounted (so streaming + queue auto-send continue,
  // and the textarea / scroll position survive a tab switch) but use
  // `display: none` to drop out of the layout. React keeps the component
  // instance alive, so all hooks above this branch keep running.
  return (
    <div
      ref={rootRef}
      className={cn(
        "flex flex-1 flex-col min-h-0 overflow-hidden",
        !isActive && "hidden",
      )}
    >
      <Conversation className="flex-1">
        <ConversationContent className="mx-auto w-full max-w-full px-4">
          {messages.length === 0 ? (
            hasAnyModelAccess === false ? (
              <div className="flex size-full items-center justify-center p-8">
                <ConnectModelCard />
              </div>
            ) : (
              <ConversationEmptyState
                title="What can I help you with?"
                description="I can research topics, write code, and analyze data."
              />
            )
          ) : (
            messages.map((message, i) => (
              <ChatMessageRow
                key={message.id}
                message={message}
                isStreaming={isStreaming && i === messages.length - 1}
                isLast={i === messages.length - 1}
                sessionId={sessionId}
                projectId={projectId}
                onViewInNotebook={onViewInNotebook}
                onViewCompute={onViewCompute}
                onOpenFile={onOpenFile}
                onCopy={handleCopy}
                copied={copiedId === message.id}
              />
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="px-4 pb-6 pt-2">
        {(reconnecting || (!initialSessionReady && !getSessionId())) && (
          <p role="status" className="mb-2 text-xs text-muted-foreground">
            {reconnecting ? "Reconnecting to this run…" : "Restoring this conversation… Retrying if the server is unavailable."}
          </p>
        )}
        <PromptInputProvider
          initialInput={initialWorkspaceState?.composer.text}
          initialAttachments={initialWorkspaceState?.composer.attachments}
          onStateChange={setComposerDraft}
        >
          <ChatInput
            isActiveTab={isActiveTab}
            allFiles={allFiles}
            attachedFiles={attachedFiles}
            onAddFile={addAttachedFile}
            onRemoveFile={removeAttachedFile}
            onClearFiles={clearAttachedFiles}
            onSend={handleSend}
            pendingSteers={pendingSteers}
            pendingFollowUps={pendingFollowUps}
            composerRestoreRef={composerRestoreRef}
            inlineError={steerError}
            isStreaming={isStreaming}
            agentStatus={status}
            onStop={handleStop}
            selectedDbs={selectedDbs}
            onDbsChange={setSelectedDbs}
            selectedModel={selectedModel}
            onModelChange={(model) => {
              markChipsTouched();
              setSelectedModel(model);
            }}
            contextUsage={contextUsage}
            onCompact={handleCompact}
            selectedComputeTarget={selectedComputeTarget}
            onComputeTargetChange={(target) => {
              markChipsTouched();
              setSelectedComputeTarget(target);
            }}
            thinkingLevel={thinkingLevel}
            onThinkingLevelChange={(level) => {
              markChipsTouched();
              setThinkingLevel(level);
            }}
            thinkingDisabled={thinkingDisabled}
            modalCatalog={modalCatalog}
            modalCatalogLoading={modalCatalogLoading}
            modalCatalogError={modalCatalogError}
            onRefreshModalCatalog={refreshModalCatalog}
            onUploadFiles={uploadFiles}
            allSkills={allSkills}
            selectedSkills={selectedSkills}
            onSkillsChange={setSelectedSkills}
            queuedMessages={messageQueue}
            onRemoveFromQueue={removeFromQueue}
            onMoveInQueue={moveInQueue}
            onEditQueued={editQueuedMessage}
            queueEditingId={queueEditingId}
            queueSendingId={queueSendingId}
            onQueueEditingChange={setEditingQueueIdState}
            queuePaused={queuePaused && messageQueue.length > 0}
            onResumeQueue={resumeQueue}
            budgetState={budgetState}
            budgetTotalUsd={budgetTotalUsd}
            budgetLimitUsd={budgetLimitUsd}
            modelAvailability={selectedModelAvailability}
            projectId={projectId}
            currentSessionId={sessionId}
            researchRefs={researchRefs}
            onResearchChange={setResearchRefs}
            delegation={delegation}
            onDelegationChange={setDelegation}
          />
        </PromptInputProvider>
      </div>
    </div>
  );
});
