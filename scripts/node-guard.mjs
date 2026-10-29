/**
 * Node runtime guard — evaluated INSIDE the actual service process.
 *
 * Wired via `node --import`:
 *
 *   node --import ../scripts/node-guard.mjs ./node_modules/tsx/dist/cli.mjs watch src/index.ts
 *
 * Node loads this module before the CLI entry, so the policy is checked in
 * the exact Node binary that goes on to load tsx, Next.js and undici —
 * whatever `node` resolved through PATH, whatever npm or the launcher used.
 * There is no intermediary process: signals, stdio, environment and exit
 * codes are the service's own, and a PID-targeted signal reaches the service
 * because there is nothing else to hit.
 *
 * On failure it prints the actionable policy error and exits 1 before the
 * CLI module loads. On success it changes nothing and returns silently.
 *
 * Zero dependencies beyond node-policy.mjs (which itself has none). Runtimes
 * too old to support `--import` fail to start at all (fail-closed); the
 * launcher's own version check remains the clear, human-facing message.
 */
import { checkNodeVersion, formatNodeVersionError } from "../node-policy.mjs";

let verdict = null;
try {
  verdict = checkNodeVersion(process.version);
} catch {
  verdict = null;
}
if (!verdict || !verdict.ok) {
  let message = null;
  try {
    message = formatNodeVersionError(process.version);
  } catch {
    message = null;
  }
  console.error(message || `Unsupported Node.js version (${process.version}).`);
  process.exit(1);
}
