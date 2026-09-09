# Using Kady from another AI tool (Kady as an MCP server)

Kady can act as an **MCP server**, so another AI tool — Claude Code, OpenCode,
Codex, or anything else that speaks MCP — can run research inside a Kady
project and read the results back. The other tool drives; Kady does the work,
in the same project sandbox you see in the browser.

> This is the opposite direction from [Connecting external tools](./mcp-servers.md).
> That page is about Kady calling *out* to other MCP servers to gain tools.
> This page is about another client calling *in* to Kady.

Both directions can be on at once. They are separate endpoints and do not
interfere.

## Turn it on

The inbound server is off by default. Start Kady with:

```bash
KADY_MCP_ENABLED=1 npm start
```

The endpoint is then:

```
http://127.0.0.1:8000/mcp-server
```

It speaks **Streamable HTTP**. Change the port with `KADY_PORT` if you run Kady
somewhere other than 8000.

### It only listens on loopback, on purpose

There is no authentication on this endpoint yet. Anything that can reach it can
read and write your projects. So when `KADY_MCP_ENABLED=1` is set, Kady refuses
to start unless `KADY_HOST` is a literal loopback address — `127.0.0.1` (the
default) or `::1`. Setting `KADY_HOST=0.0.0.0` with MCP enabled is a startup
error, not a warning.

`localhost` is rejected too. Its resolution depends on host configuration,
while the literal addresses are unambiguously local everywhere.

Do not put this endpoint behind a tunnel or a reverse proxy to reach it from
another machine. There is nothing to stop whoever finds it.

## Point a client at it

Most clients take an HTTP MCP server as a URL plus optional headers. In the
JSON form many of them share:

```json
{
  "mcpServers": {
    "kady": {
      "type": "http",
      "url": "http://127.0.0.1:8000/mcp-server",
      "headers": { "X-Project-Id": "my-study" }
    }
  }
}
```

With Claude Code you can do the same from the command line:

```bash
claude mcp add --transport http kady http://127.0.0.1:8000/mcp-server \
  --header "X-Project-Id: my-study"
```

Consult your client's own documentation for where its config file lives and
what it calls the transport field; the URL and the header are the parts that
matter.

### Choosing the project

Kady scopes every request by the `X-Project-Id` header, exactly as the browser
UI does. Two things follow:

- Omit the header and you get the default project.
- Scope belongs to the *request*, not the connection. One client connection can
  address several projects, and the `list_projects` tool tells you which ids
  exist.

If your client cannot send a custom header, run one Kady project per client
config, or use the default project.

## The tools

Five tools, meant to be used in this order.

| Tool | What it does |
|---|---|
| `list_projects` | Lists the local Kady projects and their ids. Start here if you do not know your `X-Project-Id`. |
| `create_research_session` | Creates one research session and returns its `sessionId`. Call it **once per research thread**. |
| `start_research_run` | Sends a prompt to that session and returns a `runId` immediately. The run keeps going server-side. |
| `poll_run` | Returns the run's status and any new frames. Call it until the status is no longer `running`. |
| `get_session_history` | Returns the whole stored transcript for a session. |

A minimal loop is: `create_research_session` → `start_research_run` → `poll_run`
until it stops saying `running`.

### Reading `poll_run`

`poll_run` returns a `status`:

- `running` — poll again.
- `done` — the run finished.
- `aborted` — someone stopped it.
- `blocked` — the project's spend limit stopped it. Raise the limit in project
  settings and retry; the terminal frame is `{"type": "error", "kind": "budget"}`.
- `error` — anything else failed, including a provider refusal. That frame has
  no `kind`, and its `message` carries the guidance.
- `unknown` — no run with that id in this project.

Pass the `lastSeq` you got back as `after` on the next call to receive only new
frames.

Every status except `unknown` also carries **`producedOutput`**. A `done` run
with `producedOutput: false` finished without saying anything and without
producing a file — treat it as a failed attempt and retry, rather than
reporting an empty answer as a result. `status` stays authoritative: on
`error`, `blocked` or `aborted`, `producedOutput: true` only means partial
output arrived before the run stopped.

### Sessions created this way have no `interview` tool

The `interview` tool asks *you* a clarifying question and blocks the run until
you answer it in the browser. No MCP client can see that form, so a run would
hang forever. Sessions created by `create_research_session` therefore have
`interview` disabled, and stay that way even if you later reopen them in a chat
tab. `create_research_session` reports this as `interviewDisabled: true`.

That is the only behavioural difference. Everything else — the sandbox, the
files, the sub-agents, the notebook — is the same agent the browser drives.

### Sessions are visible in the browser

An MCP-created session shows up in the project's session list in the UI's clock
menu, and can be reopened there like any other chat. They are not hidden, and
they are not cleaned up automatically: delete them the same way you delete any
session when you no longer want them.

Each project keeps at most 10 *live* sessions in memory. Older ones are closed
and reopened from disk on demand, so this is a memory ceiling and not a limit on
how many sessions you may create. It is still a reason to call
`create_research_session` once per research thread rather than once per run.

## When something is wrong

**The client cannot connect at all.** Check that Kady was started with
`KADY_MCP_ENABLED=1`. Without it the endpoint is not mounted and you get a 404.

**Kady refuses to start.** If the error mentions a loopback `KADY_HOST`, you
have `KADY_MCP_ENABLED=1` together with a non-loopback host. Pick one.

**`Unknown MCP session`.** Your client is reusing an `mcp-session-id` from a
previous Kady process. Reconnect.

**Tools are listed but every call fails on scope.** The `X-Project-Id` you are
sending does not exist. Call `list_projects` to see the real ids.

**A run never leaves `running`.** Check the browser: if the session is waiting
on a provider that is not connected, `poll_run` reports `error` with the
provider's own message. See [Model selection](./model-selection.md) for
connecting one.

## Limits

- No authentication, which is why it is loopback-only.
- No way to abort a run through MCP yet; use the browser.
- Five tools, not Kady's whole feature surface. Sub-agents, notebooks, and Modal
  compute are all available *to the agent* during a run, but there is no MCP
  tool that drives them directly.
