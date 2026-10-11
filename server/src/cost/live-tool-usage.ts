/** Observe completed tool charges before Pi persists them or ends the turn. */
import type { BillingContext } from "./billing.ts";
import { billingCountsTowardBudget, billingForProvider } from "./billing.ts";
import { addToolResultUsage, emptyToolUsageSplit, type ToolUsageSplit } from "./tool-usage.ts";

interface Result {
  toolCallId?: string;
  toolName?: string;
  usage?: unknown;
  details?: unknown;
}

interface Charge {
  split: ToolUsageSplit;
  /** Session stats include this result once their tool-result count reaches it. */
  persistedAt?: number;
}

const failClosed: BillingContext = { provider: "unknown", authType: "none", billingMode: "payg" };

export class LiveToolUsage {
  private turn = 0;
  private charges = new Map<string, Charge>();
  private billing = new Map<string, { value: BillingContext; promise: Promise<BillingContext> }>();

  constructor(private resolveBilling: (ref: string) => Promise<BillingContext>) {}

  billingFor(ref: string): Promise<BillingContext> {
    let entry = this.billing.get(ref);
    if (!entry) {
      const provider = ref.split("/", 1)[0];
      const value = provider === "ollama" || provider === "openai-compatible"
        ? billingForProvider(provider, "local") : failClosed;
      entry = { value, promise: Promise.resolve(value) };
      const target = entry;
      // Until asynchronous credential lookup finishes, count the charge.
      target.promise = Promise.resolve().then(() => this.resolveBilling(ref))
        .catch(() => failClosed).then((resolved) => (target.value = resolved));
      this.billing.set(ref, target);
    }
    return entry.promise;
  }

  observe(result: Result, persistedAt?: number, fallbackId?: string): void {
    const id = result.toolCallId ?? fallbackId;
    if (id === undefined) return;
    const key = `${this.turn}:${id}`;
    const split = emptyToolUsageSplit();
    addToolResultUsage(split, [result]);
    const prior = this.charges.get(key);
    this.charges.set(key, { split, persistedAt: persistedAt ?? prior?.persistedAt });
    for (const ref of split.models.keys()) void this.billingFor(ref);
  }

  endTurn(results: readonly unknown[] | undefined, persistedCount: number): void {
    for (const [index, raw] of (results ?? []).entries()) {
      this.observe(raw as Result, persistedCount, `result-${index}`);
    }
    this.turn++;
  }

  /** Cap-counted tool spend; payg lead runs only need the not-yet-persisted part. */
  accruedUsd(persistedCount: number, onlyUnpersisted: boolean): number {
    let total = 0;
    for (const charge of this.charges.values()) {
      if (onlyUnpersisted && charge.persistedAt !== undefined && persistedCount >= charge.persistedAt) continue;
      for (const [ref, usage] of charge.split.models) {
        if (billingCountsTowardBudget(this.billing.get(ref)?.value ?? failClosed)) total += usage.costUsd;
      }
    }
    return total;
  }

  /** Latest result wins within a turn; repeated event surfaces never add twice. */
  totals(): ToolUsageSplit {
    const total = emptyToolUsageSplit();
    for (const charge of this.charges.values()) {
      for (const field of ["costUsd", "input", "output", "cacheRead", "total"] as const) {
        total.delegated[field] += charge.split.delegated[field];
      }
      for (const [ref, usage] of charge.split.models) {
        const tally = total.models.get(ref);
        if (!tally) total.models.set(ref, { ...usage });
        else for (const field of ["costUsd", "input", "output", "cacheRead", "total"] as const) tally[field] += usage[field];
      }
    }
    return total;
  }
}
