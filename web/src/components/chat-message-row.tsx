"use client";

import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
  MessageToolbar,
} from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { CitationBadge } from "@/components/citation-badge";
import { CommandBlockChip } from "@/components/command-block-chip";
import { SentContextChips } from "@/components/context-chips";
import { InterviewCard } from "@/components/interview-form";
import { PermissionCard } from "@/components/permission-card";
import { ScientificResultCard } from "@/components/scientific-result-card";
import { SystemCard } from "@/components/system-card";
import {
  ModalJobChip,
  NotebookEntryChip,
  ReasoningBlock,
  ToolActivityList,
} from "@/components/tool-activity";
import { InfoTooltip } from "@/components/ui/info-tooltip";
import { parseCommandBlock } from "@/lib/command-blocks";
import {
  splitComposerContext
} from "@/lib/composer-context";
import {
  type ActivityItem,
  type ChatMessage
} from "@/lib/use-agent";
import { formatUsd } from "@/lib/utils";
import {
  CheckIcon,
  CopyIcon
} from "lucide-react";
import {
  memo,
  type ReactNode
} from "react";
// FORK: keep queue presentation separate to preserve the frontend line cap.
import { workflowScriptsIn } from "@/lib/workflow-script";

export const AssistantMessageBody = memo(function AssistantMessageBody({
  message,
  isStreaming,
  isLast,
  sessionId,
  projectId,
  onViewInNotebook,
  onViewCompute,
  onOpenFile,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  isLast: boolean;
  sessionId: string | null;
  projectId: string;
  onViewInNotebook?: (entryId: string) => void;
  onViewCompute?: (jobId?: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  const activities = message.activities ?? [];
  const hasReasoning = Boolean(message.reasoning?.trim());
  const hasAnything =
    Boolean(message.content) || activities.length > 0 || hasReasoning;
  // Some models occasionally end a turn right after a tool call with no
  // closing text, which used to leave the chat silently "done". Surface that
  // explicitly on the final bubble so the user knows the run ended.
  const endedWithoutReply =
    !isStreaming && isLast && !message.content && (activities.length > 0 || hasReasoning);

  // Prose and activities share one ordered timeline so a preamble stays above
  // the tool it introduced and the post-tool answer stays below it.
  const orderedBlocks: ReactNode[] = [];
  let chunk: ActivityItem[] = [];
  const flushChunk = () => {
    if (!chunk.length) return;
    orderedBlocks.push(
      <ToolActivityList key={`tools-${chunk[0].id}`} activities={chunk} />,
    );
    chunk = [];
  };
  const appendActivity = (a: ActivityItem) => {
    if (a.toolName === "interview") {
      flushChunk();
      orderedBlocks.push(
        <InterviewCard
          key={a.id}
          item={a}
          sessionId={sessionId}
          projectId={projectId}
        />,
      );
    } else if (a.toolName === "permission") {
      flushChunk();
      orderedBlocks.push(
        <PermissionCard key={a.id} item={a} sessionId={sessionId} projectId={projectId} />,
      );
    } else if (a.toolName === "notebook") {
      flushChunk();
      orderedBlocks.push(
        <NotebookEntryChip key={a.id} item={a} onView={onViewInNotebook} />,
      );
    } else if (a.toolName?.startsWith("modal_")) {
      flushChunk();
      orderedBlocks.push(
        <ModalJobChip key={a.id} item={a} onView={onViewCompute} />,
      );
    } else if (a.scientificResult) {
      flushChunk();
      orderedBlocks.push(
        <ScientificResultCard
          key={a.id}
          item={a}
          projectId={projectId}
          onOpenFile={onOpenFile}
        />,
      );
    } else {
      chunk.push(a);
    }
  };
  const activityById = new Map(activities.map((activity) => [activity.id, activity]));
  // pi-subagents ≥0.74 runs the ```js workflow block written in the same reply
  // as `subagent({ workflow: true })`; hand the nearest preceding one to the
  // tool card so it can name the specialists the script launches.
  let replyWorkflowScript: string | undefined;
  const segments = message.segments?.length
    ? message.segments
    : [
        ...activities.map((activity) => ({
          type: "activity" as const,
          activityId: activity.id,
        })),
        ...(message.content
          ? [{ type: "text" as const, content: message.content }]
          : []),
      ];
  for (const [index, segment] of segments.entries()) {
    if (segment.type === "text") {
      flushChunk();
      replyWorkflowScript = workflowScriptsIn(segment.content).at(-1) ?? replyWorkflowScript;
      if (segment.content) {
        orderedBlocks.push(
          <MessageResponse key={`text-${index}`} onOpenFile={onOpenFile}>{segment.content}</MessageResponse>,
        );
      }
      continue;
    }
    const activity = activityById.get(segment.activityId);
    if (!activity) continue;
    const args = activity.args as Record<string, unknown> | undefined;
    appendActivity(
      activity.toolName === "subagent" && args?.workflow === true && replyWorkflowScript
        ? { ...activity, replyWorkflowScript }
        : activity,
    );
  }
  flushChunk();

  return (
    <>
      {hasReasoning && <ReasoningBlock reasoning={message.reasoning ?? ""} />}
      {orderedBlocks}
      {isStreaming && !hasAnything ? (
        <Shimmer className="text-sm" duration={1.5}>
          Thinking...
        </Shimmer>
      ) : endedWithoutReply ? (
        <p className="text-xs italic text-muted-foreground">
          This turn ended without a closing message. Review the tool results
          above before continuing, or ask a follow-up for a summary.
        </p>
      ) : null}
      {message.citations && (
        <div className="flex flex-wrap items-center gap-2">
          <CitationBadge report={message.citations} />
        </div>
      )}
    </>
  );
});

/** Unchanged history rows keep their tool disclosures and skip token renders. */
export const ChatMessageRow = memo(function ChatMessageRow({
  message, isStreaming, isLast, sessionId, projectId,
  onViewInNotebook, onViewCompute, onOpenFile, onCopy, copied,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  isLast: boolean;
  sessionId: string | null;
  projectId: string;
  onViewInNotebook?: (id: string) => void;
  onViewCompute?: (id?: string) => void;
  onOpenFile?: (path: string) => void;
  onCopy: (id: string, content: string) => void;
  copied: boolean;
}) {
  // Extension notices and compaction markers sit between the bubbles.
  if (message.role === "system") return <SystemCard message={message} />;
  return (
    <Message from={message.role} key={message.id}>
      <MessageContent>
        {message.role === "assistant" ? (
          <AssistantMessageBody
            message={message}
            isStreaming={isStreaming}
            isLast={isLast}
            sessionId={sessionId}
            projectId={projectId}
            onViewInNotebook={onViewInNotebook}
            onViewCompute={onViewCompute}
            onOpenFile={onOpenFile}
          />
        ) : (
          <>
            {message.images && message.images.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {message.images.map((img, i) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={i}
                    src={`data:${img.mimeType};base64,${img.data}`}
                    alt={`Attached image ${i + 1}`}
                    className="max-h-56 max-w-64 rounded-lg border object-contain"
                  />
                ))}
              </div>
            )}
            {(() => {
              const { text, context } = splitComposerContext(message.content);
              const block = parseCommandBlock(text);
              return (
                <>
                  {block ? <CommandBlockChip block={block} /> : <MessageResponse>{text}</MessageResponse>}
                  {context && <SentContextChips context={context} />}
                </>
              );
            })()}
          </>
        )}
        {message.role === "assistant" && message.modelVersion && (
          <span className="text-xs text-muted-foreground mt-1">
            {message.modelVersion}
          </span>
        )}
      </MessageContent>
      {message.role === "assistant" && message.content && (
        <MessageToolbar>
          <MessageActions>
            <MessageAction
              tooltip="Copy"
              onClick={() => onCopy(message.id, message.content)}
            >
              {copied ? (
                <CheckIcon className="size-4" />
              ) : (
                <CopyIcon className="size-4" />
              )}
            </MessageAction>
          </MessageActions>
          {((typeof message.runCostUsd === "number" &&
            message.runCostUsd > 0) ||
            (message.runBillingMode === "subscription" &&
              (message.runTokens ?? 0) > 0)) && (
              <InfoTooltip
                content={
                  <>
                    <b>
                      {message.runBillingMode === "subscription"
                        ? "Subscription usage"
                        : message.runBillingMode === "metered_oauth"
                          ? "Metered extra usage"
                          : "Cost of this reply"}
                    </b>
                    <br />
                    {message.runBillingMode === "subscription"
                      ? `${message.runProvider ?? "Provider"} manages billing and quota`
                      : formatUsd(message.runCostUsd ?? 0)}
                    {typeof message.runTokens === "number" &&
                    message.runTokens > 0
                      ? ` · ${message.runTokens.toLocaleString()} tokens`
                      : ""}
                    {message.runBillingMode === "subscription" &&
                    typeof message.runListPriceUsd === "number"
                      ? ` · ${formatUsd(message.runListPriceUsd)} list-price reference (not project spend)`
                      : ""}
                  </>
                }
              >
                <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
                  {message.runBillingMode === "subscription"
                    ? `subscription · ${(message.runTokens ?? 0).toLocaleString()} tok`
                    : formatUsd(message.runCostUsd ?? 0)}
                </span>
              </InfoTooltip>
            )}
        </MessageToolbar>
      )}
    </Message>
  );
});
