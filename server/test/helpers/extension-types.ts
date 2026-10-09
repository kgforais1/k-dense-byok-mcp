/** Captured extension callbacks accept fixture inputs and opaque results. */
export type FixtureExtensionHandler = (event: unknown, context?: unknown) => unknown;

/** The lifecycle fields the installed child factory exposes to these tests. */
export interface FixtureChildSession {
  sessionId: string;
  sessionFile?: string;
  dispose(): Promise<void>;
}
