/** Kady's consumed subset of the pi-subagents RPC result. */
export interface FleetRun {
  id?: string;
  control?: { runId: string; index: number; childId: string };
  children?: FleetRun[];
}
export interface SubagentRpcResult {
  text?: string;
  message?: string;
  fleet?: unknown;
  asyncSnapshot?: { runs?: FleetRun[] };
}
