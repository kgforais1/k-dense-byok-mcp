const RECEIPT_LIMIT = 2_000;

interface FollowUpReceipt {
  projectId: string;
  sessionId: string;
}

const receipts = new Map<string, FollowUpReceipt>();

function receiptKey(projectId: string, sessionId: string, requestId: string): string {
  return `${projectId}\0${sessionId}\0${requestId}`;
}

export function hasFollowUpReceipt(
  projectId: string,
  sessionId: string,
  requestId: string,
): boolean {
  return receipts.has(receiptKey(projectId, sessionId, requestId));
}

export function rememberFollowUpReceipt(
  projectId: string,
  sessionId: string,
  requestId: string,
): void {
  const key = receiptKey(projectId, sessionId, requestId);
  receipts.set(key, { projectId, sessionId });
  while (receipts.size > RECEIPT_LIMIT) {
    const oldest = receipts.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    receipts.delete(oldest);
  }
}

/** Queue clearing discards admitted messages, so their receipts cannot prove delivery. */
export function clearFollowUpReceipts(projectId: string, sessionId: string): void {
  for (const [key, receipt] of receipts) {
    if (receipt.projectId === projectId && receipt.sessionId === sessionId) {
      receipts.delete(key);
    }
  }
}
