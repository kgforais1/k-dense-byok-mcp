import { describe, expect, it, vi } from "vitest";
import { LiveToolUsage } from "../src/cost/live-tool-usage.ts";
import type { BillingContext } from "../src/cost/billing.ts";

const payg: BillingContext = { provider: "openrouter", authType: "api_key", billingMode: "payg" };
const subscription: BillingContext = { provider: "openai", authType: "oauth", billingMode: "subscription" };
const result = (id: string, cost: number, ref = "openrouter/image") => ({
  toolCallId: id, toolName: "generate_image",
  usage: { input: 10, output: 20, cost: { total: cost } }, details: { model: ref },
});

describe("live completed tool usage", () => {
  it.each(["ollama/image", "openai-compatible/image"])("keeps %s local without consulting a resolver that would charge it", async (ref) => {
    const resolve = vi.fn(async () => payg);
    const live = new LiveToolUsage(resolve);
    live.observe(result("local", 0.04, ref));
    expect(await live.billingFor(ref)).toMatchObject({ provider: ref.split("/", 1)[0], billingMode: "local" });
    expect(live.accruedUsd(0, false)).toBe(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("updates the same charge across completion, message and turn events, including nested usage", async () => {
    const resolve = vi.fn(async () => payg);
    const live = new LiveToolUsage(resolve);
    live.observe(result("a", 0.03));
    live.observe(result("a", 0.05), 1);
    expect(live.accruedUsd(0, true)).toBeCloseTo(0.05);
    expect(live.accruedUsd(1, true)).toBe(0);
    live.endTurn([result("a", 0.05)], 1);
    // Providers can reuse a call id in a later turn.
    live.observe(result("a", 0.02));
    expect(live.accruedUsd(1, false)).toBeCloseTo(0.07);
    expect(live.accruedUsd(1, true)).toBeCloseTo(0.02);
    expect(live.totals().models.get("openrouter/image")).toMatchObject({ costUsd: 0.07, total: 60 });
    await live.billingFor("openrouter/image");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("counts unknown billing conservatively, then excludes subscription and local calls", async () => {
    const live = new LiveToolUsage(async () => subscription);
    live.observe(result("a", 0.03, "openai/image"));
    live.observe(result("b", 0.04, "ollama/image"));
    expect(live.accruedUsd(0, false)).toBeCloseTo(0.03);
    await live.billingFor("openai/image");
    expect(live.accruedUsd(0, false)).toBe(0);
    expect(live.totals().models.size).toBe(2);
  });

  it("keeps failed billing lookup cap-counted and never adds already metered children", async () => {
    const live = new LiveToolUsage(async () => { throw new Error("credential lookup failed"); });
    live.observe(result("a", 0.03));
    live.observe({ ...result("child", 0.5), toolName: "subagent" });
    await live.billingFor("openrouter/image");
    expect(live.accruedUsd(0, false)).toBeCloseTo(0.03);
    expect(live.totals().delegated.costUsd).toBeCloseTo(0.5);
  });

  it("splits mixed codemode models by their own billing", async () => {
    const live = new LiveToolUsage(async (ref) => ref.startsWith("openrouter/") ? payg : subscription);
    live.observe({ toolCallId: "script", toolName: "codemode", usage: { input: 30, cost: { total: 0.06 } },
      details: { calls: [
        { name: "models.generateImages", args: "openrouter/image", cost: 0.04 },
        { name: "models.classify", args: "openai/classifier", cost: 0.02 },
      ] },
    });
    await Promise.all([live.billingFor("openrouter/image"), live.billingFor("openai/classifier")]);
    expect(live.accruedUsd(0, false)).toBeCloseTo(0.04);
    expect(live.totals().models.get("openai/classifier")?.input).toBe(10);
  });
});
