# Frontend Guidance (`web/`)

Scoped to the Next.js 16 / React 19 frontend. Read the root
[`../AGENTS.md`](../AGENTS.md) first for cross-agent policy, fork/hook
constraints, and the source-of-truth order; this file owns only frontend
deltas.

## What lives here

- Next.js 16 app (port 3000) with React 19, App Router, and a custom
  Settings dialog that hosts the **Capability hub** (Model providers,
  Skills, Specialists, Connectors) plus API keys / Fusion / Appearance.
- The chat composer and tabs (`chat-tab.tsx`, `chat-tabs-bar.tsx`),
  per-run thinking-level selector, inline interview form, file preview
  panel with the extensible viewer registry, and the Lab Notebook view.
- The synthesised OpenRouter model catalogue
  (`src/data/models.json`) and pricing helpers consumed by both the picker
  and the backend cost ledger.

## Layout

```
web/
├── src/
│   ├── app/                   # Next.js App Router routes
│   ├── components/            # UI components (chat, settings, file preview, viewers)
│   ├── components/viewers/    # lazy-loaded viewers for the registry
│   ├── lib/                   # client libs (sandbox hook, fusion presets, image attachments)
│   ├── lib/viewers/           # viewer registry (registry.ts + registry.test.ts)
│   ├── data/                  # models.json (synthesised OpenRouter catalogue)
│   ├── types/                 # shared types
│   └── pdfjs.d.ts             # ambient types for PDF.js
├── public/                    # static assets
├── next.config.ts             # injects NEXT_PUBLIC_APP_VERSION from server/package.json
├── package.json               # no `version` field (single source of truth is server/)
├── tsconfig.json
└── vitest.config.ts
```

## Commands

Run from `web/`:

```bash
npm install
npm run dev                 # Next.js dev server (port 3000)
npm run build               # production build
npm test                    # vitest
```

## Conventions

- App Router only; do not reintroduce `pages/`. New routes go under
  `src/app/` and follow existing layout/loading/error patterns.
- Components live under `src/components/`. New viewer components go under
  `src/components/viewers/` and must be **view-only** — they decode and
  display, but never write back to the sandbox.
- The viewer registry maps a `FileCategory` (`src/lib/use-sandbox.ts`) to a
  lazy-loaded viewer. `FileViewer` in `file-preview-panel.tsx` checks the
  registry first and falls back to its built-in chain for the original
  categories (image/pdf/markdown/csv/notebook/fasta/biotable/latex/text).
  3D structures use a client-side WebGL viewer (3Dmol.js); spectra use
  chart.js.
- Image attachments in the composer are validated client-side by
  `src/lib/image-attachments.ts` (downscale >3MB before send); non-image
  uploads keep the sandbox-upload path; image sends mid-run queue instead
  of going through steering.
- Fusion pricing has a parity requirement: the
  `JUDGE_CALLS_PER_TURN` multiplier and the judge accessor exist in both
  `server/src/agent/models.ts` and `web/src/lib/fusion-presets.ts`, and
  `server/test/fusion-pricing.test.ts` enforces parity over the shipped
  presets. Picker quote and ledgered price must agree.
- The **Capability hub** lives inside Settings (not a separate Customize
  surface): Model providers, Skills, Specialists, Connectors. Enable/disable
  is non-destructive — skills move between `sandbox/.pi/skills/` and
  `sandbox/.pi/skills-disabled/`, project specialists between
  `sandbox/.pi/agents/` and `sandbox/.pi/agents-disabled/`, and MCP entries
  between `sandbox/.pi/mcp.json` and `sandbox/.pi/mcp-disabled.json`. Live
  sessions keep their set; toggles apply to new chat tabs/subagent runs.
- `web/package.json` deliberately has no `version` field. The build reads
  `server/package.json` at build time (`next.config.ts` injects
  `NEXT_PUBLIC_APP_VERSION`). Do not add a `version` field here.

## Tests

- Vitest, in `src/**`. Existing component tests use the
  `*.test.tsx` suffix (e.g. `chat-message-order.test.tsx`,
  `interview-form.test.tsx`, `lab-notebook-entry-card.test.tsx`).
- Typecheck: `npx tsc --noEmit` currently passes clean for the frontend.
- For a new viewer, add a `*.test.tsx` next to the registry entry that
  exercises the category match and lazy-load, mirroring `registry.test.ts`.

## Sandbox contract

The frontend never sees host filesystem paths — sandbox-relative paths
canonicalized to forward slashes are the API boundary
(`apiRelative`/`toApiPath` in `server/src/sandbox-fs.ts`,
`stripSandboxRoot` in `server/src/agent/events.ts`). Any new client
helper that reads or writes sandbox files must go through
`src/lib/use-sandbox.ts` and the existing endpoint set; do not invent a
new path style.
