#!/usr/bin/env bash
# Thin wrapper: make sure Node exists, then hand off to the cross-platform
# launcher (start.mjs). Windows users run start.cmd instead.
set -e
cd "$(dirname "$0")"

if ! command -v node &>/dev/null; then
    if command -v brew &>/dev/null; then
        echo "Node.js not found — installing node@24 via Homebrew..."
        if ! brew install node@24; then
            echo "Homebrew could not install node@24. Install Node.js on a supported line" >&2
            echo "(22.23.4+, 24.22.1+ or 26.12.1+ — see https://nodejs.org/) manually, then run ./start.sh again." >&2
            exit 1
        fi
        # A keg-only install is not linked into PATH, so bare `brew install`
        # alone would not select it. Resolve the keg explicitly and put it
        # first for this process (and everything it spawns: npm, the backend,
        # the frontend) so the launcher and all services run on the Homebrew
        # Node just installed. Existing PATH entries are preserved after it.
        KEG_PREFIX="$(brew --prefix node@24 2>/dev/null || true)"
        if [ -z "$KEG_PREFIX" ] || [ ! -x "$KEG_PREFIX/bin/node" ]; then
            echo "Homebrew installed node@24, but its 'node' binary was not found where expected." >&2
            echo "Install Node.js on a supported line (22.23.4+, 24.22.1+ or 26.12.1+) manually, then run ./start.sh again." >&2
            exit 1
        fi
        export PATH="$KEG_PREFIX/bin:$PATH"
    else
        echo "Node.js not found and Homebrew is not available. Install Node.js on a supported line" >&2
        echo "(22.23.4+, 24.22.1+ or 26.12.1+ — see https://nodejs.org/, or via your version manager, e.g. 'nvm install 24'), then run ./start.sh again." >&2
        exit 1
    fi
fi

exec node start.mjs "$@"
