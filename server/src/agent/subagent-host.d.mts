// FORK: precise types for the upstream child runtime bridge.
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { AgentSession, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

export function setHostMeter(handler: (action: string, input: Record<string, unknown>) => unknown): void;
export interface ChildOwner {
  projectId: string;
  sandbox?: string;
  sessionId: string;
  childSessionId?: string;
  sessionFile?: string;
  kind: string;
  runId?: string;
}
export function meteredStream(base: StreamFn, owner: ChildOwner, usingOAuth: (model: Model<Api>) => boolean): StreamFn;
export function attachChildSession(session: AgentSession, launch: {
  cwd: string;
  runtime: { orchestratorSessionId?: string; parentSessionId?: string; runId?: string };
}, runtime: ModelRuntime): void;
export function watchdogStream(ctx: ExtensionContext, base: StreamFn): StreamFn;
