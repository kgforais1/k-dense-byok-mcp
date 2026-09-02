# K-Dense BYOK / Kady: Architecture, Projects, Files, API, and MCP Notes

## Executive summary

K-Dense BYOK is best thought of as a local AI research-agent
environment, not simply a GUI that forwards prompts to model APIs. The
GUI sits on top of a local TypeScript/Fastify server and an agent
runtime with project-scoped files, persistent chat sessions, scientific
skills/tools, notebooks, provenance, cost tracking, code execution,
subagents, MCP integration, and model-provider support.

For normal research use, the right organizational unit is a K-Dense
project, not a separate clone of the K-Dense repository. A useful
mental model is:

```
One K-Dense installation
    ├── Project A
    │     ├── project files / sandbox
    │     ├── chat session 1
    │     ├── chat session 2
    │     ├── notebook
    │     └── Kady run state
    └── Project B
          ├── different files / sandbox
          ├── different chats
          └── different notebook/state
```

The existing backend already exposes enough HTTP functionality that a
CLI or an MCP server for external agents appears quite feasible.

---

## 1. How to install and organize K-Dense

The K-Dense repository should normally be cloned once and treated as
the application/runtime itself:

```
~/Software/k-dense-byok-kg/
```

Do not make a new clone of K-Dense for every research topic.
Instead, create separate projects within the application.

Examples:

```
K-Dense
├── MRI Retardation
├── ACR MRI QC
├── CT Dose Optimization
├── DICOM Viewer Research
└── fMRI Framewise Displacement
```

Separate K-Dense clones would mainly be useful for software-development
reasons, such as keeping a stable version and an experimental
development version.

---

## 2. What a K-Dense project represents

A project is a self-contained research workspace. It determines the
filesystem and persistent context in which Kady operates.

It is slightly misleading to think of each project as a completely
separate installed "instance" of Kady. A better model is:

```
K-Dense server / Kady runtime
        │
        ├── active project A → project A filesystem + sessions + state
        └── active project B → project B filesystem + sessions + state
```

When a session is created or Kady performs work, the backend resolves
paths according to the active project.

Within a project, separate chat tabs are separate sessions. Those
sessions share the project's files but maintain separate conversation
histories.

This gives a useful hierarchy:

```
K-Dense installation
    ↓
Project / research study
    ↓
Chat session / workstream
    ↓
Agent runs, files, notebook entries, artifacts
```

For example, an MRI Retardation project could contain separate chats
for:

* literature review
* Maxwell / retarded-potential derivation
* dielectric-property data
* transmit-phase effects
* receive-phase effects
* parallel imaging implications
* manuscript outline
* citation audit

---

## 3. Actual project folder structure

The current TypeScript backend defines projects approximately as
follows:

```
projects/
  index.json                         # global project registry
  <project-id>/
    project.json                     # project metadata
    sandbox/                         # Kady / Pi working directory
      pyproject.toml                 # Python environment configuration
      AGENTS.md                      # user-editable prompt/instructions
      .venv/                         # project Python environment
      user_data/                     # uploaded/input files
      .pi/
        skills/                      # project-specific Pi skills
        sessions/                    # persistent Pi JSONL chat sessions
      .kady/
        runs/                        # run-specific state and costs
        notebook/                    # lab notebook data
        provenance/                  # provenance information
        modal/                       # remote-compute state
```

Important consequence: chat history is stored within the project,
under `.pi/sessions/`, as Pi JSONL session files.

Thus switching projects changes both the working filesystem and the set
of chats/session histories visible to Kady.

---

## 4. Files, documents, and datasets

### Current intended workflow

Kady's working directory is the project's `sandbox/`. Therefore the most
straightforward current workflow is to upload or place relevant material
into the project sandbox, particularly `user_data/`.

Example:

```
projects/mri-retardation/sandbox/
  user_data/
    papers/
      paper-01.pdf
      paper-02.pdf
    data/
      dielectric-properties.csv
    notes/
      prior-notes.md
```

Kady can then work with these files as part of that project's research
context.

### Better long-term workflow for an existing research directory

If a research project already has a canonical directory such as:

```
~/Research/MRI-Retardation/
```

it may be undesirable to duplicate all PDFs, data, DICOM datasets,
scripts, and Git repositories inside K-Dense.

A cleaner future architecture would allow a K-Dense project to point to
an external workspace directory:

```
K-Dense project metadata
    name: MRI Retardation
    workspace: ~/Research/MRI-Retardation
```

while K-Dense-specific state remains separately managed:

```
K-Dense state
  sessions/
  notebook/
  provenance/
  costs/
```

Conceptually:

```
~/Research/MRI-Retardation/     ← canonical research files
            ↑
            │ Kady works here
            │
K-Dense project
  ├── chats
  ├── notebook
  ├── provenance
  └── agent metadata
```

The current code strongly assumes `projects/<id>/sandbox` is the agent
working directory, so arbitrary external workspaces would require a
modification to the fork. Until then, uploading/copying selected
material into the K-Dense project is the supported/simple approach.
Symlinks might also be worth investigating, but their behavior should be
tested against K-Dense's sandbox/path-security logic before relying on
them.

---

## 5. What K-Dense actually is

K-Dense is more than a GUI powered by API keys.

The repository contains a TypeScript server with components for:

* project management
* persistent sessions/chat histories
* agent execution
* streaming agent responses
* model providers
* credentials
* sandbox/filesystem operations
* scientific skills
* subagents/specialists
* MCP connectivity
* notebooks
* provenance
* cost accounting / spending policies
* local and Modal compute
* code execution and analysis

The model API key supplies the underlying model intelligence, while
K-Dense supplies much of the agent environment and orchestration
layer.

A useful abstraction is:

```
User
 ↓
K-Dense GUI
 ↓
Kady agent runtime
 ├── LLM provider(s)
 ├── files
 ├── code execution
 ├── scientific skills
 ├── subagents
 ├── web/research capabilities
 ├── MCP tools
 └── notebooks/provenance
```

---

## 6. Existing HTTP API

K-Dense already exposes a substantial local Fastify HTTP API.

### Projects

Examples include:

```
GET    /projects
POST   /projects
GET    /projects/:projectId
PATCH  /projects/:projectId
DELETE /projects/:projectId
GET    /projects/:projectId/costs
GET    /projects/:projectId/notebook
GET    /projects/:projectId/notebook/export
POST   /projects/:projectId/sandbox/init
```

### Sessions / chats

The session API includes at least:

```
POST /sessions
GET  /sessions
GET  /sessions/:id/history
POST /sessions/:id/run
```

Each session is a persistent Pi JSONL conversation.

Most importantly, `POST /sessions/:id/run` is already a streaming
agent-run endpoint. It returns Kady's run events through Server-Sent
Events (SSE), followed by run/cost information.

This means the GUI is consuming a real backend agent API rather than
directly containing all agent logic itself.

---

## 7. How API requests select a project

The backend has an explicit request-scoping system based on Node
AsyncLocalStorage.

An HTTP request can select its project using, in priority order:

1. `X-Project-Id` HTTP header
2. `?project=<id>` query parameter
3. `kady-project` cookie
4. default project if none is specified

For example:

```
POST /sessions/abc123/run
X-Project-Id: mri-retardation
```

The server marks `mri-retardation` as the active project for that
asynchronous request. Downstream code can call `currentProjectId()` or
resolve the active project paths without manually passing the project ID
through every function.

This is particularly important for external-agent integration because an
external client can explicitly tell K-Dense which research workspace to
operate within.

---

## 8. CLI possibilities

There does not appear to be a documented end-user CLI analogous to:

```
kady run "Research this question"
```

However, because the HTTP API already exists, a CLI could likely be
implemented as a relatively thin client.

Possible interface:

```
kady project list
kady project create "MRI Retardation"
kady chat list --project mri-retardation
kady chat create --project mri-retardation
kady run \
  --project mri-retardation \
  "Review the literature on finite-speed-of-light effects in MRI"
kady status <run-id>
kady result <run-id>
```

The CLI would mostly perform HTTP requests against the existing local
K-Dense server and display/stream the results.

---

## 9. MCP: current role vs possible future role

K-Dense already contains MCP-related code and depends on the Model
Context Protocol SDK.

The current architecture appears primarily oriented toward Kady acting
as an MCP client, allowing Kady to consume external MCP tools.

Conceptually:

```
Kady
 ↓
MCP client
 ↓
external MCP servers/tools
```

What does not appear to be provided as a documented feature is the
inverse: exposing K-Dense/Kady itself as an MCP server so that another
coding agent can delegate research to it.

That would look like:

```
OpenCode / Claude Code / Codex / another agent
                    ↓
                   MCP
                    ↓
               K-Dense server
                    ↓
                  Kady
          ├── scientific research
          ├── literature search
          ├── data analysis
          ├── specialist agents
          └── project knowledge
```

Because K-Dense already has project, session, run, file, and agent APIs,
such an MCP server should be substantially easier to build than starting
from scratch.

---

## 10. Potential MCP tools

A useful K-Dense MCP server could expose tools such as:

```
kdense_list_projects
kdense_create_project
kdense_list_chats
kdense_create_chat
kdense_research
kdense_continue_chat
kdense_get_result
kdense_get_project_files
kdense_run_workflow
kdense_delegate_specialist
```

A call might conceptually look like:

```
kdense_research(
    project="mri-retardation",
    prompt="Review evidence for receive-phase retardation effects..."
)
```

The MCP adapter would translate that into calls against K-Dense's
existing HTTP/session APIs and stream or return Kady's result.

---

## 11. Why MCP may be preferable to only a CLI

A CLI would be useful for humans, shell scripts, and automation. MCP is
particularly attractive for the user's coding-agent workflow because
modern coding agents increasingly understand MCP tools directly.

The two interfaces are complementary:

```
                    ┌── CLI ── humans / shell scripts
K-Dense HTTP API ───┤
                    └── MCP ── AI agents
```

An MCP layer could let an external coding agent delegate specialized
scientific work to Kady while remaining responsible for software
engineering tasks itself.

Example:

```
Coding agent
  │
  ├── edits Python / application code directly
  │
  └── asks Kady through MCP:
        "Search the literature and determine the accepted
         MRI QC tolerance and supporting references."
```

Kady then performs the research inside the appropriate K-Dense project
and returns the result to the coding agent.

---

## 12. Recommended architecture

For a practical research environment, the cleanest target architecture
is:

```
                         ┌───────────────────────┐
                         │ Canonical project dir │
                         │ PDFs / data / code    │
                         └───────────┬───────────┘
                                     │
                              project workspace
                                     │
                         ┌───────────▼───────────┐
                         │       K-Dense         │
                         │                       │
                         │ Project → Kady        │
                         │ chats / notebook      │
                         │ research / analysis   │
                         └───────────┬───────────┘
                                     │
                       existing local HTTP API
                          ┌──────────┴──────────┐
                          │                     │
                    ┌─────▼─────┐         ┌─────▼─────┐
                    │    CLI    │         │ MCP server│
                    └───────────┘         └─────┬─────┘
                                               │
                                  ┌────────────┼────────────┐
                                  │            │            │
                              OpenCode    Claude Code     Codex
```

The main modification needed for the ideal file workflow would be
support for a project whose Kady workspace points at an existing
external directory rather than always living under
`projects/<id>/sandbox`.

The main modification needed for external-agent use would be a thin MCP
server translating MCP tool calls into the already-existing K-Dense
project/session/run API.

---

## 13. Practical recommendations

1. Keep one main clone of K-Dense. Do not clone it once per
   research project.
2. Create one K-Dense project per coherent study, paper, analysis, or
   major research topic.
3. Use multiple chat sessions within a project for distinct
   workstreams. They share the project's files while retaining
   separate histories.
4. For now, upload or copy relevant files into the project's
   sandbox/user-data area.
5. Keep important original research/code directories canonical
   outside K-Dense when appropriate, rather than making K-Dense the
   only copy.
6. Consider adding external-workspace support to the fork so a
   project can point Kady at an existing research directory.
7. Consider adding an MCP server layer over the existing HTTP API
   for OpenCode/Claude Code/Codex-style agent delegation.
8. A lightweight CLI over the same API would also be useful, but
   MCP is likely the more powerful integration for agent-to-agent
   workflows.

---

## 14. Key source files inspected

These conclusions were based on inspection of the fork
`kgrizz-git/k-dense-byok-kg`, particularly:

```
server/src/projects.ts
server/src/scope.ts
server/src/index.ts
server/src/api/projects.ts
server/src/api/sessions.ts
server/src/api/mcp.ts
server/src/agent/mcp.ts
server/package.json
README.md
docs/basic-usage.md
```

The most important implementation details found were:

* `projects.ts`: defines each project as self-contained under
  `projects/<id>/` and resolves its sandbox, session, skill, notebook,
  provenance, and run paths.
* `scope.ts`: stores the active project in request-scoped
  AsyncLocalStorage.
* `index.ts`: resolves project selection from `X-Project-Id`,
  `?project=`, or the `kady-project` cookie.
* `sessions.ts`: provides persistent Pi JSONL sessions and an SSE
  streaming agent-run endpoint.
* `projects.ts` API routes: expose project CRUD, notebook export,
  costs, and sandbox initialization.

---

*Prepared from our architecture review of the K-Dense BYOK fork. The
repository may continue to evolve, so exact endpoints and directory
details should be rechecked before implementing an integration.*
