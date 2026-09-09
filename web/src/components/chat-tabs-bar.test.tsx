/**
 * The history menu is the only place a stored chat can be deleted, and delete
 * is irreversible. These cover the two ways it can go wrong: removing a chat
 * the user meant to open, and hiding that an MCP-created chat cannot ask a
 * clarifying question.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TooltipProvider } from "@/components/ui/tooltip";
import { ChatTabsBar } from "./chat-tabs-bar";

const apiFetch = vi.fn();
vi.mock("@/lib/projects", () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (msg: string) => toastError(msg) } }));

const SESSIONS = [
  {
    id: "from-browser",
    name: "Browser chat",
    created: "2026-09-08T00:00:00.000Z",
    modified: "2026-09-08T00:00:00.000Z",
    messageCount: 3,
    firstMessage: "Browser chat",
    headless: false,
  },
  {
    id: "from-mcp",
    name: "MCP chat",
    created: "2026-09-07T00:00:00.000Z",
    modified: "2026-09-07T00:00:00.000Z",
    messageCount: 2,
    firstMessage: "MCP chat",
    headless: true,
  },
];

const onOpenSession = vi.fn();

function renderBar() {
  return render(
    <TooltipProvider>
      <ChatTabsBar
        projectId="p1"
        tabs={[{ id: "t1", title: "Tab", isStreaming: false, userMessageCount: 1 }]}
        activeTabId="t1"
        view="chat"
        maxTabs={5}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onNew={vi.fn()}
        onRename={vi.fn()}
        onSelectWorkflows={vi.fn()}
        onOpenSession={onOpenSession}
      />
    </TooltipProvider>,
  );
}

async function openHistory() {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText("Chat history"));
  await screen.findByText("Browser chat");
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiFetch.mockResolvedValue({ ok: true, status: 200, json: async () => SESSIONS });
});

describe("history menu", () => {
  it("marks an MCP-created chat and leaves an ordinary one unmarked", async () => {
    renderBar();
    await openHistory();

    expect(screen.getByText("MCP")).toBeInTheDocument();
    // One badge, on the headless row only.
    expect(screen.getAllByText("MCP")).toHaveLength(1);
  });

  it("deletes a chat without also reopening it", async () => {
    // The trash icon sits inside the row that opens the chat. If the click
    // falls through, the user deletes a chat and lands in it at the same time.
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderBar();
    const user = await openHistory();

    apiFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ deleted: true }) });
    await user.click(screen.getByLabelText("Delete Browser chat"));

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        "/sessions/from-browser",
        { method: "DELETE" },
        "p1",
      );
    });
    expect(onOpenSession).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Browser chat")).not.toBeInTheDocument());
  });

  it("does not delete when the user cancels the confirmation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderBar();
    const user = await openHistory();

    await user.click(screen.getByLabelText("Delete Browser chat"));

    expect(apiFetch).toHaveBeenCalledTimes(1); // the list fetch only
    expect(screen.getByText("Browser chat")).toBeInTheDocument();
  });

  it("keeps the chat and explains why when a run is still in flight", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderBar();
    const user = await openHistory();

    apiFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ reason: "run_already_active" }),
    });
    await user.click(screen.getByLabelText("Delete Browser chat"));

    await waitFor(() => expect(toastError).toHaveBeenCalledWith(expect.stringContaining("still running")));
    expect(screen.getByText("Browser chat")).toBeInTheDocument();
  });
});
