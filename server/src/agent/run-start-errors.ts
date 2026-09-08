import { RunAlreadyActiveError } from "./run-broker.ts";

export interface RunStartFailure {
  statusCode: 409 | 500;
  body: { detail: string; reason?: "run_already_active" };
}

/** Map only the broker's typed race to the concurrency response. */
export function runStartFailure(error: unknown): RunStartFailure {
  if (error instanceof RunAlreadyActiveError) {
    return {
      statusCode: 409,
      body: { detail: error.message, reason: "run_already_active" },
    };
  }
  return {
    statusCode: 500,
    body: { detail: error instanceof Error ? error.message : String(error) },
  };
}
