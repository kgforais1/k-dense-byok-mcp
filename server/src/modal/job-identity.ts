import type { ModalJobOwner } from "./types.ts";

export function sandboxName(projectId: string, jobId: string): string {
  const project = projectId.replace(/[^a-z0-9-]/g, "-").slice(0, 20);
  return `kady-${project}-${jobId.slice(-12)}`.slice(0, 63);
}

export function ledgerSessionId(owner: ModalJobOwner, jobId: string): string {
  const raw = owner.sessionId || owner.subagentRunId || jobId;
  const sanitized = raw.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 100);
  return /^[A-Za-z0-9]/.test(sanitized) ? sanitized : `modal-${jobId}`;
}
