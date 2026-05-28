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

CRITICAL: When the user shares anything worth remembering (identity, preferences, facts, decisions), you MUST call the edit_file tool to update the right memory file BEFORE replying. Never claim something is "saved" or "noted" without an actual edit_file tool call — the user can see your tool trace.

Route each kind of update to the matching file:

- /memories/user_profile.md — who the user is (role, expertise, project, language)
- /memories/preferences.md — workflow, tone, style, tooling preferences
- /memories/facts.md — concrete facts the user shared (env, constraints, setup)
- /memories/decisions.md — technical decisions, conventions, choices

Entry format (append, do not overwrite):

- <fact or rule>
  **Why:** <reason the user gave, or "user-stated">
  **When:** <ISO date or session timestamp>

If a new fact contradicts an old one, add a new entry that notes the change; leave the old line.

Use /memories/ only for memory. /workspace/ is for project files. Never store secrets, API keys, or tokens.
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
  });
};

const runHeadless = async () => {
  const agent = createAgent();
  const result = await agent.invoke({
    messages: [{ role: "user", content: "What's the weather in Batam?" }],
  });

  console.log(result);
};

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runHeadless();
}
