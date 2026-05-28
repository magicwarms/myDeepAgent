# my-deep-agent

A local, terminal-based **Deep Agent** built on [`deepagents`](https://www.npmjs.com/package/deepagents) + LangChain. It speaks to an OpenAI-compatible chat model (Sumopod by default), persists per-user memory to local markdown files, and ships with a research subagent backed by Tavily.

The UI is an [Ink](https://github.com/vadimdemedes/ink) TUI with three live panels: **Status**, **Tool Trace**, and **App Log**.

---

## Quick start

```bash
# 1. Install deps
yarn install

# 2. Configure environment
cp .env.example .env  # or create manually — see Environment below

# 3. Run the TUI
yarn start            # or: yarn run dev
```

> Use `kimi-k2.6` (or any model with OpenAI **function-calling** support). Models without function-calling (e.g. `gemma-*`) will appear unresponsive because tool calls cannot be emitted.

---

## Project layout

```
my-deep-agent/
├── tui.jsx                    # Ink/React TUI front-end
├── server.js                  # Agent factory: model + memory + subagents
├── package.json
├── .env                       # API keys & model overrides (gitignore)
├── memories/                  # Per-user persistent memory (auto-created)
│   └── <username>/
│       ├── AGENTS.md          # Index, always loaded
│       ├── user_profile.md    # Identity (role, expertise, project, language)
│       ├── preferences.md     # Workflow, tone, style, tooling prefs
│       ├── facts.md           # Concrete facts shared by user
│       └── decisions.md       # Technical decisions & conventions
└── tools/
    └── subagents/
        └── webSearch.js       # research-agent subagent (Tavily-backed)
```

---

## Environment

Create a `.env` at project root:

```bash
# Required: OpenAI-compatible chat provider
SUMOPOD_API_KEY=sk-...
SUMOPOD_BASE_URL=https://ai.sumopod.com/v1
SUMOPOD_MODEL=kimi-k2.6           # any function-calling-capable model

# Optional: research subagent
TAVILY_API_KEY=tvly-...

# Optional: override memory namespace (defaults to OS username)
AGENT_USER_ID=alice
```

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SUMOPOD_API_KEY` | yes | — | Auth for the chat model |
| `SUMOPOD_BASE_URL` | no | `https://ai.sumopod.com/v1` | OpenAI-compatible endpoint |
| `SUMOPOD_MODEL` | no | `kimi-k2.6` | Model id — **must support function calling** |
| `TAVILY_API_KEY` | only for research subagent | — | Web search API |
| `AGENT_USER_ID` | no | `os.userInfo().username` | Memory namespace dir |

---

## NPM scripts

| Command | Effect |
|---|---|
| `yarn start` | Run the TUI (`tsx tui.jsx`) |
| `yarn run dev` | Same as `start`. **Do not use `tsx watch`** — its parent process binds stdin and treats every keystroke as a reload trigger, restarting the TUI on every key. |
| `yarn run start:headless` | Run `server.js` directly — one-shot agent invocation, prints result to stdout. Useful for smoke-testing the agent stack. |

---

## TUI keybindings

| Key | Action |
|---|---|
| `Enter` | Send the current message |
| `PgUp` / `Ctrl+U` | Scroll conversation up by half a page |
| `PgDn` / `Ctrl+D` | Scroll conversation down by half a page |
| `Shift+↑` / `Shift+↓` | Scroll one line |
| `Home` | Jump to top |
| `End` | Jump to bottom (most recent) |
| `Ctrl+K` | Cancel the running agent turn |
| `Ctrl+L` | Clear conversation, tool trace, error, and scroll position |
| `Ctrl+C` or `Esc` | Quit |

The right column shows three live panels:

- **Status** — running/idle, model, elapsed, message/tool counts, init/run errors
- **Tool Trace** — every `read_file` / `edit_file` / `write_file` / `internet_search` etc. call with `[OK]` / `[ERR]` / `[RUN]` status and truncated input/output
- **App Log** — `console.*`, `stderr` writes, and agent-loop telemetry (`stream_start`, `tool_call #N`, `assistant_message #N`, `stream_end`, plus any error messages from the langchain stack)

---

## Memory system

Memory is **per-user** and **on-disk**. Files live in `./memories/<AGENT_USER_ID-or-username>/`. The agent loads all five files at the start of every conversation through `deepagents`' built-in `MemoryMiddleware`.

### Routing rules

The system prompt instructs the agent to call `edit_file` on the matching file whenever the user reveals durable info:

| File | What goes in it |
|---|---|
| `user_profile.md` | Identity — name, role, expertise, project, language |
| `preferences.md` | Workflow, tone, style, tooling preferences |
| `facts.md` | Concrete facts — environment, constraints, setup |
| `decisions.md` | Technical decisions, conventions, choices |

### Entry format

```
- <fact or rule>
  **Why:** <reason or "user-stated">
  **When:** <ISO date or session timestamp>
```

Entries are **appended**, never silently overwritten. If a new fact contradicts an old one, the agent adds a new entry noting the change and leaves the old line.

### Storage model

```
backend: CompositeBackend(
  default = StateBackend(),                                  // ephemeral scratch
  routes  = {
    "/memories/":  FilesystemBackend(rootDir = MEMORY_ROOT),  // disk-backed memory
    "/workspace/": FilesystemBackend(rootDir = projectRoot),  // project file access
  }
)
```

- `/memories/*` → `./memories/<user>/*` on disk (markdown, hand-editable, committable per-user if you want)
- `/workspace/*` → project root (read/write project files)
- everything else → `StateBackend` (LangGraph state, ephemeral)

### Bootstrap

On first `createAgent()` call, `ensureMemoryDir()` creates the per-user directory and templated `.md` files if they don't already exist. Subsequent runs are no-ops.

### Inspecting memory

```bash
cat memories/$USER/user_profile.md
cat memories/$USER/preferences.md
# etc.
```

Edits made by hand are picked up on the next conversation.

---

## Subagents

Defined in `tools/subagents/` and registered in `server.js` via the `subagents` array passed to `createDeepAgent`.

### Current subagents

| Name | Purpose | Tools | Required env |
|---|---|---|---|
| `research-agent` | Web research, multi-query synthesis | `internet_search` (Tavily) | `TAVILY_API_KEY` |

The main agent decides to delegate via the built-in `task()` tool when a request is research-heavy. The system prompt nudges this:

> *"For question and research tasks, delegate to your subagents using the `task()` tool. This keeps your context clean and improves results."*

### Adding a new subagent

1. Create `tools/subagents/<name>.js` exporting an object shaped like:

   ```js
   export default {
     name: "my-subagent",
     description: "What this subagent does (used by the main agent to decide when to delegate)",
     systemPrompt: "...",
     tools: [/* tool() instances */],
     responseFormat: zodSchema,   // optional structured output
   };
   ```

2. Import and add it in `server.js`:

   ```js
   import myAgent from "./tools/subagents/myAgent.js";
   // ...
   subagents: [webResearchSubagent, myAgent],
   ```

---

## Adding a regular tool

Defined inline in `server.js` (see `getWeather`) or in a separate file. Pass them via `tools: [...]` to `createDeepAgent`. Built-in filesystem tools (`ls`, `read_file`, `write_file`, `edit_file`, `glob`, `grep`) come from `createFilesystemMiddleware` and use the configured backend automatically — do not redefine them.

```js
const myTool = tool(async ({ ... }) => { /* ... */ }, {
  name: "my_tool",
  description: "...",
  schema: z.object({ /* ... */ }),
});

return createDeepAgent({
  tools: [getWeather, myTool],
  // ...
});
```

---

## Model compatibility

The agent stack relies on **OpenAI function-calling** semantics. Confirmed-good and known-bad models:

| Model | Status | Notes |
|---|---|---|
| `kimi-k2.6` | ✅ works | Default. Calls tools reliably. |
| `gpt-4o`, `gpt-4o-mini` | ✅ works | Native function-calling. |
| Anthropic Claude (via `ChatAnthropic`) | ✅ works | Best tool-loop reliability. Requires swapping `ChatOpenAI` → `ChatAnthropic`. |
| `gemma-*` | ❌ broken | No function-calling support. Responses come back empty / silent because tool calls can't be emitted. |

If you swap to a model that doesn't support tool calls, you'll see this in the **App Log** panel:
- `[API] stream_start ...`
- `[API] stream_end ... messages=0 tools=0`

Stick to function-calling-capable models.

---

## Known-good model behavior contract

The system prompt enforces (most importantly):

1. **No announce-then-stop.** If the agent says "let me check X", the same response must include the tool call. Otherwise langgraph terminates the loop with no further tool calls and the UI shows `idle`.
2. **No fabrication.** The agent must not claim a file was saved/read unless the tool call appears in the Tool Trace panel.
3. **Chain multi-step actions in one turn.** read → edit must happen together.
4. **Memory writes happen before the reply.** Any durable info triggers `edit_file` first, prose second.

These rules are repeated in `server.js` under `SYSTEM_PROMPT`. Keep them when editing.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| TUI restarts on every keystroke | Using `tsx watch` (parent binds stdin) | Use `yarn start` or `yarn run dev` — both run plain `tsx tui.jsx` |
| Agent replies but `Tools: 0` and nothing on disk | Model without function-calling, or `backend`/`memory` passed to `ChatOpenAI` instead of `createDeepAgent` | Switch model to `kimi-k2.6`/Claude/GPT; verify `backend:` is inside `createDeepAgent({...})` not `new ChatOpenAI({...})` |
| Agent says "let me check" then `Idle` | Model emitted intent without `tool_calls` array → loop terminated | The system prompt addresses this; if the model still does it, switch to Claude or a stronger model |
| `Missing SUMOPOD_API_KEY` error on init | `.env` not loaded / variable missing | Ensure `.env` exists at project root, `SUMOPOD_API_KEY=...` set |
| `Path traversal not allowed` from FilesystemBackend | Agent tried to write outside `/memories/` or `/workspace/` | Expected — that's the security guard. Use the correct prefix. |
| `internet_search` fails with auth error | `TAVILY_API_KEY` missing | Add it to `.env`, or skip research-agent if not needed |

---

## File-by-file reference (for future-you and the agent)

- **`tui.jsx`** — Ink/React TUI. Three-panel right column (Status / Tool Trace / App Log). Key wiring:
  - `useInput` with strict Ctrl+C / Esc gates (won't exit on normal typing).
  - `render(<App />, { exitOnCtrlC: false })` to disable Ink's built-in Ctrl+C handler — we own that.
  - Console interceptor pipes `console.*` and `process.stderr.write` into the App Log panel without corrupting Ink's stdout.
  - `handleSubmit` consumes `streamEvents(v3)` returning `{ messages, toolCalls, output }` and emits API telemetry into the App Log.

- **`server.js`** — Agent factory. Builds:
  - `ChatOpenAI` model (OpenAI-compatible client pointed at Sumopod)
  - `CompositeBackend` for memory + workspace routing
  - `createDeepAgent` wiring with system prompt, custom tool, subagents, memory file list
  - Bootstrap (`ensureMemoryDir`) on every call (idempotent)
  - Headless mode (`runHeadless`) when invoked directly with `node server.js`

- **`tools/subagents/webSearch.js`** — Tavily-backed research subagent. Defines `internet_search` tool + `research-agent` subagent with structured output schema.

- **`memories/<user>/*.md`** — Generated and maintained by the agent. Safe to hand-edit. Per-user, by OS username unless `AGENT_USER_ID` is set.

---

## License

MIT. See `package.json`.
