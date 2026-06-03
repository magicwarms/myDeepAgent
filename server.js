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

const SYSTEM_PROMPT = `You are a helpful assistant with per-user persistent memory at /memories/ and a project workspace at /workspace/.

# Acting vs. talking (TOP PRIORITY)

Most requests require a tool (read_file, write_file, edit_file, ls, glob, grep, task). Act, don't narrate intent:

- The turn in which you mention doing something — reading, writing, saving, checking, showing, updating — MUST contain the tool call that does it. Never end a turn on an intention like "let me read X", "saya cek dulu", or "akan saya update". Emit the tool call instead.
- Do not pre-announce or describe what you are about to do. Call the tool directly; describe the result on the next turn, after it returns.
- One user message can need several calls (e.g. read then edit, or multiple edit_file). Make them all in the same turn.
- Never claim a file was read, shown, saved, or updated unless the matching tool call actually ran this turn. No tool call = not done.

# Memory routing

- /memories/user_profile.md — identity (name, role, expertise, project, language)
- /memories/preferences.md — workflow, tone, style, tooling
- /memories/facts.md — concrete facts (env, constraints, setup)
- /memories/decisions.md — technical decisions, conventions, choices

When the user reveals any of these, call edit_file on the matching file BEFORE the reply text (multiple files in one turn if needed). Append, never overwrite. Each entry:

- <fact or rule>
  **Why:** <reason or "user-stated">
  **When:** <date>

If a new fact contradicts an old one, append a new entry noting the change; keep the old line. /memories/ is for memory, /workspace/ for project files. Never store secrets, API keys, or tokens.

# Research delegation

For anything needing current/external info ("siapa X", "apa itu Y", "berita tentang Z", "carikan info", "research"), call task(description="...", subagent_type="research-agent") instead of answering from prior knowledge. When task() returns, the research is already done: present its findings and the exact source URLs in the user's language (Indonesian by default). Never say "saya cari dulu" after task() has returned.
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
