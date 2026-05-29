import "dotenv/config";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ChatOpenAI } from "@langchain/openai";
import {
  CompositeBackend,
  FilesystemBackend,
  StateBackend,
  createDeepAgent,
} from "deepagents";
import { tool } from "langchain";
import * as z from "zod";
import webResearchSubagent from "./tools/subagents/webSearch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_MODEL = process.env.SUMOPOD_MODEL ?? "kimi-k2.6";
const DEFAULT_BASE_URL =
  process.env.SUMOPOD_BASE_URL ?? "https://ai.sumopod.com/v1";

const MEMORY_USER = process.env.AGENT_USER_ID ?? os.userInfo().username;
const MEMORY_ROOT = path.join(__dirname, "memories", MEMORY_USER);
const WORKSPACE_ROOT = __dirname;

console.log({ WORKSPACE_ROOT });

const MEMORY_FILES = {
  "AGENTS.md": `---
name: agents-index
description: Index for the agent's long-term memory. Always loaded.
---

# Agent Memory Index

User namespace: ${MEMORY_USER}

This directory is the agent's persistent memory. Each file holds a category:

- [User profile](user_profile.md) — who the user is (role, expertise, goals)
- [Preferences](preferences.md) — workflow, tone, tooling, style preferences
- [Facts](facts.md) — specific facts the user has shared
- [Decisions](decisions.md) — technical decisions, conventions, choices made together

Keep entries terse. Lead with the fact, follow with **Why:** and **When:** lines when the reasoning matters.
`,
  "user_profile.md": `---
name: user-profile
description: Who the user is — role, expertise, goals, constraints.
---

# User Profile

(empty — fill in as the user reveals identity details)
`,
  "preferences.md": `---
name: preferences
description: Workflow, tone, tooling, and style preferences.
---

# Preferences

(empty — fill in as the user states preferences or you observe consistent corrections)
`,
  "facts.md": `---
name: facts
description: Specific facts the user has shared (project context, constraints, environment).
---

# Facts

(empty — append fact + **Why:** + **When:** as facts surface)
`,
  "decisions.md": `---
name: decisions
description: Technical decisions, conventions, and choices made together.
---

# Decisions

(empty — log decision + **Why:** + **When:** + alternatives considered)
`,
};

const SYSTEM_PROMPT = `You are a helpful assistant with per-user persistent memory at /memories/.

# Tool-use rules (MOST IMPORTANT)

1. **Never announce, then stop.** If you say "let me read X", "gue tunjukin", "saya cek dulu", "I'll check", or "akan saya update", the SAME response MUST include the tool call. Do not end your turn after announcing intent.
2. **Execute first, narrate after.** Prefer to just emit the tool call. Summarize the result in the NEXT step, after the tool returns.
3. **No fabrication.** Never claim a file was saved, noted, read, or shown unless the tool call for it appears in this turn's tool trace.
4. **Chain multi-step actions in one turn.** If a request needs read → edit, emit both calls before replying with prose. Do not split "I'll read it" and the actual read across turns.
5. **If asked to show a file, call read_file in the same turn and quote the content back.**

Wrong:
  > "Coba gue tunjukin sekarang." (turn ends, no tool call) ← BUG

Right:
  > [tool_call: read_file(file_path="/memories/user_profile.md")]
  > "Ini isinya: ..."

# Memory routing

- /memories/user_profile.md — identity (name, role, expertise, project, language)
- /memories/preferences.md — workflow, tone, style, tooling preferences
- /memories/facts.md — concrete facts (env, constraints, setup)
- /memories/decisions.md — technical decisions, conventions, choices

When user reveals any of these, call edit_file on the matching file BEFORE the reply text. One user message can trigger multiple edit_file calls — do all of them in one turn.

# Entry format

Append; do not overwrite. Each entry:

- <fact or rule>
  **Why:** <reason or "user-stated">
  **When:** <ISO date or session timestamp>

If a new fact contradicts an old one, append a new entry noting the change; leave the old line.

# Scope

/memories/ is for memory only. /workspace/ is for project files. Never store secrets, API keys, or tokens.

# Research delegation (CRITICAL)

For any question that needs current/external information — "siapa X", "apa itu Y", "berita tentang Z", "carikan info", "research", etc. — delegate to the **research-agent** subagent via the built-in **task()** tool. Do NOT try to answer from prior knowledge.

How to call:
  > [tool_call: task(description="Research who Chris John is. Provide a comprehensive summary with sources.", subagent_type="research-agent")]

After task() returns, the output IS the research findings. You MUST:
  1. Read the task() output carefully
  2. Present its findings to the user in your own words, in the user's language (Indonesian by default)
  3. Include the key facts AND the sources from the output
  4. NEVER say "let me research" or "saya cari dulu" after task() has already returned — the research is done; just present it

Wrong (after task() returns):
  > "Oke, saya cari dulu ya..." ← BUG. Task sudah dieksekusi.

Right (after task() returns):
  > "Chris John adalah petinju Indonesia, juara dunia WBA kelas bulu (2003-2013)...
  > Sumber: https://..., https://..."
`;

const ensureMemoryDir = () => {
  fs.mkdirSync(MEMORY_ROOT, { recursive: true });
  for (const [filename, template] of Object.entries(MEMORY_FILES)) {
    const fullPath = path.join(MEMORY_ROOT, filename);
    if (!fs.existsSync(fullPath)) {
      fs.writeFileSync(fullPath, template, "utf8");
    }
  }
};

export const createAgent = () => {
  const apiKey = process.env.SUMOPOD_API_KEY;
  if (!apiKey) {
    throw new Error(
      "Missing SUMOPOD_API_KEY. Set it in your env or .env file.",
    );
  }

  ensureMemoryDir();

  const model = new ChatOpenAI({
    model: DEFAULT_MODEL,
    apiKey,
    temperature: 0,
    configuration: {
      baseURL: DEFAULT_BASE_URL,
    },
  });

  const getWeather = tool(({ city }) => `It's always sunny in ${city}!`, {
    name: "get_weather",
    description: "Get the weather for a given city",
    schema: z.object({ city: z.string() }),
  });

  return createDeepAgent({
    model,
    tools: [getWeather],
    systemPrompt: SYSTEM_PROMPT,
    memory: [
      "/memories/AGENTS.md",
      "/memories/user_profile.md",
      "/memories/preferences.md",
      "/memories/facts.md",
      "/memories/decisions.md",
    ],
    backend: new CompositeBackend(new StateBackend(), {
      "/memories/": new FilesystemBackend({
        rootDir: MEMORY_ROOT,
        virtualMode: true,
      }),
      "/workspace/": new FilesystemBackend({
        rootDir: WORKSPACE_ROOT,
        virtualMode: true,
      }),
    }),
    subagents: [webResearchSubagent],
  });
};

const runHeadless = async () => {
  const agent = createAgent();
  const result = await agent.invoke({
    messages: [
      {
        role: "user",
        content: "Bagaimana berita terakhir tentang AI sampai saat ini?",
      },
    ],
  });

  console.log({ result: JSON.stringify(result, null, 2) });
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runHeadless();
}
