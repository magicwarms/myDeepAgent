import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAgent } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.join(__dirname, "web");
const PORT = Number(process.env.WEB_PORT ?? 5173);
const DEFAULT_MODEL = process.env.SUMOPOD_MODEL ?? "kimi-k2.6";

let cachedAgent = null;
let cachedAgentError = null;
try {
  cachedAgent = createAgent();
} catch (err) {
  cachedAgentError = err?.message ?? String(err);
  console.error("[web-server] agent init failed:", cachedAgentError);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

const safeStringify = (value) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const getMessageRole = (m) => {
  if (!m) return "assistant";
  if (m.role) return m.role;
  if (m.message?.role) return m.message.role;
  if (typeof m._getType === "function") return m._getType();
  if (m.type) return m.type;
  return "assistant";
};

const isAssistantRole = (r) => r === "assistant" || r === "ai";

async function* toAsyncIterable(value) {
  if (value == null) return;
  if (typeof value === "string") {
    yield value;
    return;
  }
  if (typeof value[Symbol.asyncIterator] === "function") {
    for await (const c of value) yield String(c ?? "");
    return;
  }
  if (typeof value[Symbol.iterator] === "function") {
    for (const c of value) yield String(c ?? "");
    return;
  }
  yield String(value);
}

const serveStatic = async (req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/" || urlPath === "") urlPath = "/index.html";
  const filePath = path.normalize(path.join(WEB_ROOT, urlPath));
  if (!filePath.startsWith(WEB_ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
};

const readJsonBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });

const sseWrite = (res, event, data) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const handleHealth = (res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      ok: cachedAgent != null,
      model: DEFAULT_MODEL,
      error: cachedAgentError,
    })
  );
};

const handleChat = async (req, res) => {
  if (!cachedAgent) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: cachedAgentError ?? "Agent unavailable.",
      })
    );
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err?.message ?? "Bad body" }));
    return;
  }

  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "messages required" }));
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const startedAt = Date.now();
  const controller = new AbortController();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try {
      controller.abort();
    } catch {}
    try {
      res.end();
    } catch {}
  };
  req.on("close", () => {
    if (!res.writableEnded) close();
  });

  const log = (level, text) => {
    if (closed) return;
    try {
      sseWrite(res, "log", { level, text, ts: Date.now() });
    } catch {}
  };

  // Patch console for this run so that agent-side console.* lines stream out.
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  const fmt = (args) =>
    args.map((a) => (typeof a === "string" ? a : safeStringify(a))).join(" ");
  console.log = (...a) => {
    orig.log(...a);
    log("info", fmt(a));
  };
  console.info = (...a) => {
    orig.info(...a);
    log("info", fmt(a));
  };
  console.warn = (...a) => {
    orig.warn(...a);
    log("warn", fmt(a));
  };
  console.error = (...a) => {
    orig.error(...a);
    log("error", fmt(a));
  };
  console.debug = (...a) => {
    orig.debug(...a);
    log("info", fmt(a));
  };

  const restoreConsole = () => {
    console.log = orig.log;
    console.info = orig.info;
    console.warn = orig.warn;
    console.error = orig.error;
    console.debug = orig.debug;
  };

  let assistantCount = 0;
  let toolCount = 0;
  let idCounter = 0;
  const nextId = () => `${Date.now()}-${++idCounter}`;

  log("api", `stream_start model=${DEFAULT_MODEL} msgs=${messages.length}`);

  let messageTask = Promise.resolve();
  let toolTask = Promise.resolve();

  try {
    const run = await cachedAgent.streamEvents(
      { messages: messages.map(({ role, content }) => ({ role, content })) },
      { version: "v3", signal: controller.signal }
    );

    messageTask = (async () => {
      for await (const msg of run.messages) {
        if (closed) return;
        const role = getMessageRole(msg);
        if (!isAssistantRole(role)) continue;

        const id = nextId();
        let buf = "";
        sseWrite(res, "assistant_start", { id });

        const source =
          msg.text ?? msg.message?.text ?? msg.content ?? msg.message?.content;
        for await (const token of toAsyncIterable(source)) {
          if (closed) return;
          buf += token;
          sseWrite(res, "assistant_chunk", { id, content: token });
        }
        assistantCount += 1;
        sseWrite(res, "assistant_end", { id, content: buf });
        log("api", `assistant_message #${assistantCount} len=${buf.length}`);
      }
    })().catch((err) => {
      log("error", `message stream error: ${err?.message ?? err}`);
    });

    toolTask = (async () => {
      for await (const call of run.toolCalls) {
        if (closed) return;
        const id = nextId();
        const name = call.name ?? "tool";
        toolCount += 1;
        log("api", `tool_call #${toolCount} name=${name}`);

        let inputText = "";
        try {
          inputText = safeStringify(await call.input);
        } catch (err) {
          inputText = err?.message ?? "Failed to read tool input.";
        }
        sseWrite(res, "tool_start", { id, name, input: inputText });

        try {
          const outputText = safeStringify(await call.output);
          sseWrite(res, "tool_end", {
            id,
            output: outputText,
            status: "done",
          });
        } catch (err) {
          const outputText = err?.message ?? "Tool failed.";
          log("error", `tool_error name=${name} err=${outputText}`);
          sseWrite(res, "tool_end", {
            id,
            output: outputText,
            status: "error",
          });
        }
      }
    })().catch((err) => {
      log("error", `tool stream error: ${err?.message ?? err}`);
    });

    try {
      await run.output;
    } catch (err) {
      const msg = err?.message ?? "Agent run failed.";
      log("error", `run.output error: ${msg}`);
      sseWrite(res, "error", { message: msg });
    }
  } catch (err) {
    const msg = err?.message ?? "Agent run failed.";
    log("error", `streamEvents error: ${msg}`);
    sseWrite(res, "error", { message: msg });
  } finally {
    await Promise.allSettled([messageTask, toolTask]);
    const duration = Date.now() - startedAt;
    log(
      "api",
      `stream_end duration=${duration}ms messages=${assistantCount} tools=${toolCount}`
    );
    sseWrite(res, "done", {
      duration,
      messages: assistantCount,
      tools: toolCount,
    });
    restoreConsole();
    close();
  }
};

const server = http.createServer(async (req, res) => {
  const url = req.url || "/";

  if (req.method === "GET" && url === "/api/health") {
    handleHealth(res);
    return;
  }

  if (req.method === "POST" && url === "/api/chat") {
    handleChat(req, res);
    return;
  }

  if (req.method === "GET") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`[web-server] http://localhost:${PORT}`);
  console.log(`[web-server] model=${DEFAULT_MODEL}`);
  if (cachedAgentError) {
    console.error(`[web-server] agent init error: ${cachedAgentError}`);
  }
});
