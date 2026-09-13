/** Client tab id without `Math.random` (see CodeQL `js/insecure-randomness`). */

let fallbackCounter = 0;

export function makeTabId(): string {
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }
  if (c && typeof c.getRandomValues === "function") {
    const bytes = c.getRandomValues(new Uint8Array(6));
    const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 8);
    return `tab-${Date.now()}-${rand}`;
  }
  fallbackCounter += 1;
  return `tab-${Date.now()}-${fallbackCounter.toString(36)}`;
}
