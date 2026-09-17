// FORK: idempotent follow-up admission receipts.
//
// A lost HTTP response leaves the client unsure whether its follow-up was
// admitted, so it retries with the same `requestId`. The pre-existing
// completed-receipt check (`has` before the first `await`, `remember` after
// the last one) still lets two concurrent retries both pass the check and
// enqueue duplicate billable work: the check-then-act spans the awaits for
// billing and `session.followUp`.
//
// The fix is a synchronous (hence atomic on Node's single thread)
// reservation taken BEFORE the first await:
//
// - `tryReserveFollowUpReceipt` returns `reserved` (this call is the leader
//   and performs the admission), `duplicate` (already admitted: reply without
//   enqueueing), or `pending` (a leader is mid-admission: await its outcome
//   and mirror it instead of enqueueing a second copy).
// - `settleFollowUpReceipt` is first-wins and idempotent: the leader records
//   exactly one outcome. `admitted: true` promotes the reservation to a
//   completed receipt (a later retry is a duplicate); `admitted: false`
//   releases the reservation so a later retry can re-attempt admission.
// - A receipt means the message reached the queue while the run was still
//   live (the leader confirms only after its post-`followUp` streaming
//   check), never merely that the request arrived.

const RECEIPT_LIMIT = 2_000;

interface FollowUpReceipt {
  projectId: string;
  sessionId: string;
}

const receipts = new Map<string, FollowUpReceipt>();

/** Outcome of one admission attempt, shared with concurrent waiters. */
export interface FollowUpAdmission {
  admitted: boolean;
  statusCode: number;
  body?: unknown;
}

interface PendingAdmission {
  projectId: string;
  sessionId: string;
  promise: Promise<FollowUpAdmission>;
  resolve: (admission: FollowUpAdmission) => void;
}

const pending = new Map<string, PendingAdmission>();

function receiptKey(projectId: string, sessionId: string, requestId: string): string {
  return `${projectId}\0${sessionId}\0${requestId}`;
}

export type FollowUpReservation =
  | { kind: "reserved" }
  | { kind: "duplicate" }
  | { kind: "pending"; wait: Promise<FollowUpAdmission> };

/**
 * Atomically claim the idempotency key. Must be called synchronously after
 * validation and before the first await so concurrent retries cannot both
 * become leaders.
 */
export function tryReserveFollowUpReceipt(
  projectId: string,
  sessionId: string,
  requestId: string,
): FollowUpReservation {
  const key = receiptKey(projectId, sessionId, requestId);
  if (receipts.has(key)) return { kind: "duplicate" };
  const existing = pending.get(key);
  if (existing) return { kind: "pending", wait: existing.promise };
  let resolve!: (admission: FollowUpAdmission) => void;
  const promise = new Promise<FollowUpAdmission>((r) => {
    resolve = r;
  });
  pending.set(key, { projectId, sessionId, promise, resolve });
  return { kind: "reserved" };
}

/**
 * Record the leader's outcome. First call wins; late calls (a second settle
 * on the same path, or a leader finishing after its key was invalidated) are
 * ignored so a discarded message can never gain a receipt afterwards.
 */
export function settleFollowUpReceipt(
  projectId: string,
  sessionId: string,
  requestId: string,
  admission: FollowUpAdmission,
): void {
  const key = receiptKey(projectId, sessionId, requestId);
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  if (admission.admitted) {
    receipts.set(key, { projectId, sessionId });
    while (receipts.size > RECEIPT_LIMIT) {
      const oldest = receipts.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      receipts.delete(oldest);
    }
  }
  entry.resolve(admission);
}

/**
 * Queue clearing discards admitted messages, so their receipts cannot prove
 * delivery. In-flight reservations for the session are settled as rejected
 * too: their leaders' post-admission streaming checks will fail the same way
 * (or have already run), and failing fast beats stranding a waiter on a
 * disposed session. A leader that still finishes afterwards settles against
 * a missing entry, which is a no-op and cannot resurrect a stale receipt.
 */
export function clearFollowUpReceipts(projectId: string, sessionId: string): void {
  for (const [key, receipt] of receipts) {
    if (receipt.projectId === projectId && receipt.sessionId === sessionId) {
      receipts.delete(key);
    }
  }
  const rejection: FollowUpAdmission = {
    admitted: false,
    statusCode: 409,
    body: {
      detail: "The session queue was cleared before the message was delivered",
      reason: "not_streaming",
    },
  };
  for (const [key, entry] of pending) {
    if (entry.projectId === projectId && entry.sessionId === sessionId) {
      pending.delete(key);
      entry.resolve(rejection);
    }
  }
}
