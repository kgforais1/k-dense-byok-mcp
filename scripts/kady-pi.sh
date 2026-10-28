#!/bin/sh
# kady-pi: Kady-owned POSIX launcher for pi-subagents' profile model probes.
#
# pi-subagents resolves the `pi` CLI through its PI_SUBAGENT_PI_BINARY seam.
# Kady points that seam at this file (never at Pi's bundled CLI). The script
# execs the exact backend Node binary and the installed unbundled Pi CLI,
# both supplied as environment variables at backend startup — no PATH lookup
# is involved, so a hostile or stale PATH cannot redirect the probe.
#
# Arguments are the probe invocation verbatim (forwarded as "$@", preserving
# quoting and spacing); stdin is inherited as ignored, stdout/stderr stream
# back to the caller. `exec` replaces this process, so signals and the exit
# status belong to the real CLI: there is no intermediary to forward through.
# Missing variables or files fail loudly here instead of falling through to
# Pi's bundled CLI.
: "${KADY_NODE_BIN:?KADY_NODE_BIN is not set; refusing to launch the Pi CLI}"
: "${KADY_PI_CLI:?KADY_PI_CLI is not set; refusing to launch the Pi CLI}"
exec "$KADY_NODE_BIN" "$KADY_PI_CLI" "$@"
