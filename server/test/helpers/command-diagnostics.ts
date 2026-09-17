interface CommandResult {
  status: number | null;
  stdout?: string | null;
  stderr?: string | null;
  error?: { message?: string } | null;
}

export function commandDiagnostics(result: CommandResult): string {
  return [
    `exit status: ${result.status ?? "null"}`,
    `spawn error: ${result.error?.message || "(none)"}`,
    `stdout:\n${result.stdout || "(empty)"}`,
    `stderr:\n${result.stderr || "(empty)"}`,
  ].join("\n");
}
