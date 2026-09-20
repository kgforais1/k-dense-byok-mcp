/**
 * Waiting helpers for backend tests that depend on real elapsed time.
 *
 * Windows CI runners intermittently run about three times slow, and every
 * wait written as a fixed budget is exposed to that. Two failure shapes came
 * out of PR #41's run, and they want different fixes:
 *
 * - A test times out, because the work is genuinely slower than the budget.
 * - A test asserts on state that has not settled yet, and reads `running`
 *   where it expected `complete`. Raising a timeout does nothing for this
 *   one; the test has to poll for the state it needs.
 *
 * `waitFor` answers both. Its budget is deliberately generous, because a
 * wait ceiling is a hang detector and not a performance target: a satisfied
 * condition returns on the first poll, so the ceiling costs nothing. Only a
 * test that was going to fail anyway pays it.
 */
import { vi } from "vitest";

/**
 * The ceiling for any wait whose condition is expected to arrive: a poll
 * here, or the deadline argument to a blocking call such as
 * `DurableModalJobManager.wait`. Roughly three times the slowest such wait
 * observed locally, which is the factor by which a loaded Windows runner
 * slows down.
 *
 * It sits well under `testTimeout` in `vitest.config.ts` so a wait that
 * never settles fails on its own terms — `waitFor` reports the assertion
 * that never held, and a blocking call returns state the test can name in
 * its failure. Being cut off by the surrounding test timeout instead reports
 * neither.
 */
export const WAIT_BUDGET_MS = 10_000;

/** Tight enough that a fast local condition is not held up by the poll. */
export const WAIT_INTERVAL_MS = 10;

/**
 * Poll `assertion` until it stops throwing. Prefer this to any sleep before
 * an assertion about state that some other task produces.
 */
export function waitFor<T>(assertion: () => T | Promise<T>): Promise<T> {
  return vi.waitFor(assertion, { timeout: WAIT_BUDGET_MS, interval: WAIT_INTERVAL_MS });
}

/**
 * A fixed delay, for what cannot be polled for. Two cases qualify:
 *
 * - Asserting that something did *not* happen. There is no state to poll
 *   for, so the test gives the work a chance and then checks it did not take
 *   it. Slowness is safe in this direction, because a loaded runner gives
 *   the unwanted work more time to appear, not less.
 * - Letting an in-flight step that exposes no observable reach a point the
 *   test depends on. Here the delay is a hedge rather than a guarantee, so
 *   prefer a generous value; if an observable exists, use `waitFor` on it.
 *
 * Do not reach for this before a positive assertion about state something
 * else produces — that is exactly what `waitFor` is for.
 */
export function quietFor(ms = 250): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
