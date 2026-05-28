import "dotenv/config";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { createAgent } from "./server.js";

const COLORS = {
  accent: "#0a84ff",
  accentSoft: "#64d2ff",
  text: "#f5f5f7",
  textSoft: "#d1d1d6",
  textMuted: "#8e8e93",
  hairline: "#3a3a3c",
  success: "#34c759",
  warn: "#ff9f0a",
  error: "#ff453a",
};

const FONT_NAME = "Plus Jakarta Sans";

const DEFAULT_MODEL = process.env.SUMOPOD_MODEL ?? "kimi-k2.6";
const MAX_HISTORY = 200;
const MAX_TOOL_TRACE = 50;
const MAX_APP_LOG = 200;
const IS_WATCH_MODE = process.env.TUI_WATCH === "1";

if (process.stdin?.on) {
  process.stdin.on("error", (err) => {
    // Swallow stdin errors. Forcing process.exit here previously killed
    // the TUI on transient raw-mode read errors during typing.
    void err;
  });
}

// Keep the TUI alive across stray rejections coming from streaming tasks.
// Without this, Node >=15 default behavior tears the process down.
process.on("unhandledRejection", (reason) => {
  void reason;
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const truncateText = (text, maxLength) => {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
};

const safeStringify = (value) => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const normalizeWhitespace = (value) =>
  value.replace(/\s+/g, " ").trim();

const wrapText = (text, width) => {
  if (width <= 0) return [];
  if (!text) return [""];

  const lines = [];
  const rawLines = String(text).split("\n");

  for (const rawLine of rawLines) {
    let line = rawLine;
    if (line.length === 0) {
      lines.push("");
      continue;
    }

    while (line.length > width) {
      let splitAt = line.lastIndexOf(" ", width);
      if (splitAt <= 0) splitAt = width;
      lines.push(line.slice(0, splitAt));
      line = line.slice(splitAt).trimStart();
    }

    lines.push(line);
  }

  return lines;
};

const getMessageRole = (message) => {
  if (!message) return "assistant";
  if (message.role) return message.role;
  if (message.message?.role) return message.message.role;
  if (typeof message._getType === "function") return message._getType();
  if (message.type) return message.type;
  return "assistant";
};

const isAssistantRole = (role) => role === "assistant" || role === "ai";

async function* toAsyncIterable(value) {
  if (value == null) return;
  if (typeof value === "string") {
    yield value;
    return;
  }

  if (typeof value[Symbol.asyncIterator] === "function") {
    for await (const chunk of value) {
      yield String(chunk ?? "");
    }
    return;
  }

  if (typeof value[Symbol.iterator] === "function") {
    for (const chunk of value) {
      yield String(chunk ?? "");
    }
    return;
  }

  yield String(value);
}

const buildChatLines = (messages, pending, width) => {
  const lines = [];
  const renderMessage = (message) => {
    const roleLabel = message.role === "user" ? "You" : "Agent";
    const prefix = `${roleLabel.padEnd(6)} `;
    const contentWidth = Math.max(8, width - prefix.length);
    const wrapped = wrapText(message.content, contentWidth);
    wrapped.forEach((line, index) => {
      const text = index === 0 ? `${prefix}${line}` : `${" ".repeat(prefix.length)}${line}`;
      lines.push({
        text,
        color: message.role === "user" ? COLORS.accent : COLORS.text,
      });
    });
  };

  messages.forEach(renderMessage);
  if (pending?.content != null) {
    renderMessage({ role: "assistant", content: pending.content || "" });
  }

  if (lines.length === 0) {
    lines.push({ text: "Start a session to see messages here.", color: COLORS.textMuted });
  }

  return lines;
};

const buildToolLines = (entries, width) => {
  const lines = [];
  const ordered = [...entries].reverse();

  ordered.forEach((entry) => {
    const statusLabel = entry.status === "error" ? "ERR" : entry.status === "done" ? "OK" : "RUN";
    const statusColor = entry.status === "error" ? COLORS.error : entry.status === "done" ? COLORS.success : COLORS.accentSoft;
    const inputText = entry.input ? truncateText(normalizeWhitespace(entry.input), 60) : "";
    const outputText = entry.output ? truncateText(normalizeWhitespace(entry.output), 60) : "";
    const message = [
      `[${statusLabel}]`,
      entry.name,
      inputText ? `in=${inputText}` : "",
      outputText ? `out=${outputText}` : "",
    ]
      .filter(Boolean)
      .join(" ");

    wrapText(message, width).forEach((line) => {
      lines.push({ text: line, color: statusColor });
    });
  });

  if (lines.length === 0) {
    lines.push({ text: "No tool calls yet.", color: COLORS.textMuted });
  }

  return lines;
};

const formatDuration = (ms) => {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

const LOG_LEVEL_COLOR = {
  info: "textSoft",
  api: "accentSoft",
  warn: "warn",
  error: "error",
  stderr: "warn",
};

const buildLogLines = (entries, width) => {
  const lines = [];
  const ordered = [...entries].reverse();
  ordered.forEach((entry) => {
    const colorKey = LOG_LEVEL_COLOR[entry.level] ?? "textMuted";
    const color = COLORS[colorKey] ?? COLORS.textMuted;
    const ts = new Date(entry.ts).toISOString().slice(11, 19);
    const tag = String(entry.level || "log").toUpperCase().padEnd(5);
    const message = `${ts} [${tag}] ${normalizeWhitespace(entry.text)}`;
    wrapText(message, width).forEach((line) => {
      lines.push({ text: line, color });
    });
  });
  if (lines.length === 0) {
    lines.push({ text: "No log entries yet.", color: COLORS.textMuted });
  }
  return lines;
};

const CTRL_C = "";
const CTRL_D = "";
const CTRL_K = "";
const CTRL_L = "";
const CTRL_U = "";
const ESC = "";

const App = () => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 24;

  const [input, setInput] = useState("");
  const [chatHistory, setChatHistory] = useState([]);
  const [pending, setPending] = useState(null);
  const [toolTrace, setToolTrace] = useState([]);
  const [appLog, setAppLog] = useState([]);
  const [running, setRunning] = useState(false);
  const [runStart, setRunStart] = useState(null);
  const [lastDuration, setLastDuration] = useState(null);
  const [error, setError] = useState("");
  const [scrollOffset, setScrollOffset] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [agentState, setAgentState] = useState({ agent: null, error: "" });
  const abortRef = useRef(null);
  const idRef = useRef(0);
  const sessionStartRef = useRef(Date.now());
  const exitOnceRef = useRef(false);

  const nextId = () => {
    idRef.current += 1;
    return `${Date.now()}-${idRef.current}`;
  };

  const pushLog = useCallback((level, text) => {
    setAppLog((prev) => {
      const entry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        level: String(level || "info"),
        text: String(text ?? ""),
        ts: Date.now(),
      };
      return [...prev, entry].slice(-MAX_APP_LOG);
    });
  }, []);

  useEffect(() => {
    const fmt = (args) =>
      args
        .map((a) => (typeof a === "string" ? a : safeStringify(a)))
        .join(" ");

    const origLog = console.log;
    const origInfo = console.info;
    const origWarn = console.warn;
    const origError = console.error;
    const origDebug = console.debug;
    const origStderrWrite = process.stderr.write.bind(process.stderr);

    console.log = (...a) => pushLog("info", fmt(a));
    console.info = (...a) => pushLog("info", fmt(a));
    console.warn = (...a) => pushLog("warn", fmt(a));
    console.error = (...a) => pushLog("error", fmt(a));
    console.debug = (...a) => pushLog("info", fmt(a));
    process.stderr.write = (chunk, ...rest) => {
      try {
        pushLog("stderr", typeof chunk === "string" ? chunk : chunk.toString());
      } catch {
        // ignore
      }
      const cb = rest.find((r) => typeof r === "function");
      if (cb) cb();
      return true;
    };

    return () => {
      console.log = origLog;
      console.info = origInfo;
      console.warn = origWarn;
      console.error = origError;
      console.debug = origDebug;
      process.stderr.write = origStderrWrite;
    };
  }, [pushLog]);

  useEffect(() => {
    try {
      const agent = createAgent();
      setAgentState({ agent, error: "" });
      pushLog("api", "agent initialized");
    } catch (err) {
      const msg = err?.message ?? "Failed to initialize agent.";
      setAgentState({ agent: null, error: msg });
      pushLog("error", `agent init failed: ${msg}`);
    }
  }, [pushLog]);

  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(timer);
  }, [running]);

  const isNarrow = columns < 100;
  const headerHeight = 5;
  const inputHeight = 3;
  const bodyHeight = Math.max(8, rows - headerHeight - inputHeight);
  const rightWidth = isNarrow ? columns : Math.max(28, Math.floor(columns * 0.34));
  const leftWidth = isNarrow ? columns : Math.max(40, columns - rightWidth - 1);
  const chatHeight = isNarrow ? Math.max(6, Math.floor(bodyHeight * 0.6)) : bodyHeight;
  const rightHeight = isNarrow ? Math.max(6, bodyHeight - chatHeight) : bodyHeight;
  const statusHeight = Math.min(8, Math.max(6, Math.floor(rightHeight * 0.28)));
  const remainingRight = Math.max(8, rightHeight - statusHeight - 2);
  const toolHeight = Math.max(4, Math.floor(remainingRight / 2));
  const logHeight = Math.max(4, remainingRight - toolHeight);

  const chatInnerWidth = Math.max(10, leftWidth - 2);
  const toolInnerWidth = Math.max(10, rightWidth - 2);
  const logInnerWidth = Math.max(10, rightWidth - 2);

  const chatInnerHeight = Math.max(1, chatHeight - 2);
  const chatContentHeight = Math.max(1, chatInnerHeight - 1);

  const chatLines = useMemo(
    () => buildChatLines(chatHistory, pending, chatInnerWidth - 2),
    [chatHistory, pending, chatInnerWidth]
  );

  const toolLines = useMemo(
    () => buildToolLines(toolTrace, toolInnerWidth - 2),
    [toolTrace, toolInnerWidth]
  );

  const logLines = useMemo(
    () => buildLogLines(appLog, logInnerWidth - 2),
    [appLog, logInnerWidth]
  );

  const maxScrollOffset = Math.max(0, chatLines.length - chatContentHeight);
  const safeScrollOffset = clamp(scrollOffset, 0, maxScrollOffset);
  const pageStep = Math.max(3, Math.floor(chatContentHeight / 2));
  const lineStep = 1;

  useEffect(() => {
    if (scrollOffset > maxScrollOffset) {
      setScrollOffset(maxScrollOffset);
    }
  }, [scrollOffset, maxScrollOffset]);

  const scrollUp = (amount) =>
    setScrollOffset((offset) => clamp(offset + amount, 0, maxScrollOffset));
  const scrollDown = (amount) =>
    setScrollOffset((offset) => clamp(offset - amount, 0, maxScrollOffset));

  const handleExit = useCallback(() => {
    if (exitOnceRef.current) return;
    exitOnceRef.current = true;
    const sessionMinutes = ((Date.now() - sessionStartRef.current) / 60000).toFixed(1);
    // Print session length after Ink unmounts.
    console.log(`Durasi sesi: ${sessionMinutes} menit.`);

    abortRef.current?.abort();
    if (IS_WATCH_MODE && process.ppid && process.ppid !== 1) {
      try {
        process.kill(process.ppid, "SIGTERM");
      } catch {
        // Ignore if the watcher is already gone.
      }
    }
    exit();
    setTimeout(() => process.exit(0), 50);
  }, [exit]);

  useInput((inputKey, key) => {
    // Pass-through for any printable character — TextInput owns those.
    // We intentionally do NOT gate on `!key.escape` here: some terminals
    // briefly mark `key.escape` for the leading byte of compound sequences,
    // which previously made plain typing fall into the exit branch below.
    const isPrintable =
      typeof inputKey === "string" &&
      inputKey.length > 0 &&
      inputKey !== ESC &&
      inputKey !== CTRL_C &&
      inputKey !== CTRL_D &&
      inputKey !== CTRL_K &&
      inputKey !== CTRL_L &&
      inputKey !== CTRL_U &&
      !key.ctrl &&
      !key.meta;
    if (isPrintable) {
      return;
    }

    const isCtrlC =
      inputKey === CTRL_C ||
      (key.ctrl && inputKey === "c");

    const isEscAlone =
      inputKey === ESC &&
      key.escape === true &&
      !key.ctrl &&
      !key.meta &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.pageUp &&
      !key.pageDown &&
      !key.return &&
      !key.tab &&
      !key.backspace &&
      !key.delete;

    if (isCtrlC || isEscAlone) {
      handleExit();
      return;
    }

    if (inputKey === CTRL_L || (key.ctrl && inputKey === "l")) {
      setChatHistory([]);
      setPending(null);
      setToolTrace([]);
      setError("");
      setScrollOffset(0);
      return;
    }

    if (inputKey === CTRL_K || (key.ctrl && inputKey === "k")) {
      abortRef.current?.abort();
      setRunning(false);
      setError("Cancelled current run.");
      return;
    }

    if (key.pageUp || inputKey === CTRL_U || (key.ctrl && inputKey === "u")) {
      scrollUp(pageStep);
    }

    if (key.pageDown || inputKey === CTRL_D || (key.ctrl && inputKey === "d")) {
      scrollDown(pageStep);
    }

    if (key.home) {
      setScrollOffset(maxScrollOffset);
    }

    if (key.end) {
      setScrollOffset(0);
    }

    if (key.shift && key.upArrow) {
      scrollUp(lineStep);
    }

    if (key.shift && key.downArrow) {
      scrollDown(lineStep);
    }
  });

  const handleSubmit = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || running) return;
    if (!agentState.agent) {
      setError(agentState.error || "Agent is not available.");
      pushLog("error", "submit blocked: agent not available");
      return;
    }

    const userMessage = { id: nextId(), role: "user", content: trimmed };
    const updatedHistory = [...chatHistory, userMessage].slice(-MAX_HISTORY);

    setInput("");
    setChatHistory(updatedHistory);
    setError("");
    setRunning(true);
    const startedAt = Date.now();
    setRunStart(startedAt);

    const abortController = new AbortController();
    abortRef.current = abortController;

    let messageTask = Promise.resolve();
    let toolTask = Promise.resolve();
    let assistantMsgCount = 0;
    let toolCallCount = 0;

    pushLog(
      "api",
      `stream_start model=${DEFAULT_MODEL} msgs=${updatedHistory.length}`
    );

    try {
      const run = await agentState.agent.streamEvents(
        { messages: updatedHistory.map(({ role, content }) => ({ role, content })) },
        { version: "v3", signal: abortController.signal }
      );

      messageTask = (async () => {
        for await (const msg of run.messages) {
          const role = getMessageRole(msg);
          if (!isAssistantRole(role)) continue;

          const messageId = nextId();
          let buffer = "";
          setPending({ id: messageId, content: "" });

          const source = msg.text ?? msg.message?.text ?? msg.content ?? msg.message?.content;
          for await (const token of toAsyncIterable(source)) {
            buffer += token;
            setPending((prev) => (prev?.id === messageId ? { ...prev, content: buffer } : prev));
          }

          const finalText = buffer || "";
          assistantMsgCount += 1;
          pushLog(
            "api",
            `assistant_message #${assistantMsgCount} len=${finalText.length}`
          );
          setChatHistory((prev) =>
            [...prev, { id: messageId, role: "assistant", content: finalText }].slice(-MAX_HISTORY)
          );
          setPending((prev) => (prev?.id === messageId ? null : prev));
          if (safeScrollOffset === 0) {
            setScrollOffset(0);
          }
        }
      })().catch((err) => {
        pushLog("error", `message stream error: ${err?.message ?? err}`);
      });

      toolTask = (async () => {
        for await (const call of run.toolCalls) {
          const toolId = nextId();
          const name = call.name ?? "tool";
          toolCallCount += 1;
          pushLog("api", `tool_call #${toolCallCount} name=${name}`);
          let inputText = "";

          try {
            const inputValue = await call.input;
            inputText = safeStringify(inputValue);
          } catch (err) {
            inputText = err?.message ?? "Failed to read tool input.";
          }

          setToolTrace((prev) =>
            [...prev, {
              id: toolId,
              name,
              input: inputText,
              output: "",
              status: "running",
              startedAt: Date.now(),
            }].slice(-MAX_TOOL_TRACE)
          );

          try {
            const outputValue = await call.output;
            const outputText = safeStringify(outputValue);
            setToolTrace((prev) =>
              prev.map((entry) =>
                entry.id === toolId
                  ? { ...entry, output: outputText, status: "done", endedAt: Date.now() }
                  : entry
              )
            );
          } catch (err) {
            const outputText = err?.message ?? "Tool failed.";
            pushLog("error", `tool_error name=${name} err=${outputText}`);
            setToolTrace((prev) =>
              prev.map((entry) =>
                entry.id === toolId
                  ? { ...entry, output: outputText, status: "error", endedAt: Date.now() }
                  : entry
              )
            );
          }
        }
      })().catch((err) => {
        pushLog("error", `tool stream error: ${err?.message ?? err}`);
      });

      try {
        await run.output;
      } catch (err) {
        const msg = err?.message ?? "Agent run failed.";
        setError(msg);
        pushLog("error", `run.output error: ${msg}`);
      }
    } catch (err) {
      const msg = err?.message ?? "Agent run failed.";
      setError(msg);
      pushLog("error", `streamEvents error: ${msg}`);
    } finally {
      await Promise.allSettled([messageTask, toolTask]);
      const duration = Date.now() - startedAt;
      pushLog(
        "api",
        `stream_end duration=${duration}ms messages=${assistantMsgCount} tools=${toolCallCount}`
      );
      setRunning(false);
      abortRef.current = null;
      setLastDuration(duration);
    }
  }, [agentState, chatHistory, input, running, safeScrollOffset, pushLog]);

  const elapsed = running && runStart ? Date.now() - runStart : lastDuration;

  const visibleChatLines = chatLines.slice(
    Math.max(0, chatLines.length - chatContentHeight - safeScrollOffset),
    Math.max(0, chatLines.length - safeScrollOffset)
  );

  const visibleToolLines = toolLines.slice(0, Math.max(1, toolHeight - 3));
  const visibleLogLines = logLines.slice(0, Math.max(1, logHeight - 3));

  const renderLines = (lines) =>
    lines.map((line, index) => (
      <Text key={`${line.text}-${index}`} color={line.color}>
        {line.text}
      </Text>
    ));

  return (
    <Box flexDirection="column">
      <Box height={headerHeight} borderStyle="classic" borderColor={COLORS.hairline} paddingX={2}>
        <Box flexDirection="column">
          <Text color={COLORS.accent} bold>
            Deep Agent
          </Text>
          <Text color={COLORS.textMuted}>
            Clean session | Font: {FONT_NAME}
          </Text>
          <Text color={COLORS.textSoft}>
            Enter send | PgUp/PgDn or Ctrl+U/D scroll | Ctrl+K cancel | Ctrl+L clear | Ctrl+C or Esc exit
          </Text>
        </Box>
      </Box>

      <Box flexDirection={isNarrow ? "column" : "row"} height={bodyHeight}>
        <Box
          width={leftWidth}
          height={chatHeight}
          borderStyle="classic"
          borderColor={COLORS.hairline}
          paddingX={2}
          flexDirection="column"
        >
          <Text color={COLORS.textMuted}>Conversation</Text>
          <Box flexDirection="column">
            {renderLines(visibleChatLines)}
          </Box>
        </Box>

        <Box
          width={rightWidth}
          height={rightHeight}
          flexDirection="column"
          marginTop={isNarrow ? 1 : 0}
        >
          <Box
            height={statusHeight}
            borderStyle="classic"
            borderColor={COLORS.hairline}
            paddingX={2}
            flexDirection="column"
          >
            <Text color={COLORS.textMuted}>Status</Text>
            {running ? (
              <Text color={COLORS.accent}>
                <Spinner type="line" /> Running
              </Text>
            ) : (
              <Text color={COLORS.textMuted}>Idle</Text>
            )}
            <Text color={COLORS.textSoft}>Model: {DEFAULT_MODEL}</Text>
            <Text color={COLORS.textSoft}>Elapsed: {formatDuration(elapsed)}</Text>
            <Text color={COLORS.textSoft}>
              Messages: {chatHistory.length} | Tools: {toolTrace.length}
            </Text>
            {agentState.error ? (
              <Text color={COLORS.error}>Init: {agentState.error}</Text>
            ) : error ? (
              <Text color={COLORS.error}>Error: {error}</Text>
            ) : null}
          </Box>

          <Box
            height={toolHeight}
            borderStyle="classic"
            borderColor={COLORS.hairline}
            paddingX={2}
            flexDirection="column"
            marginTop={1}
          >
            <Text color={COLORS.textMuted}>Tool Trace</Text>
            <Box flexDirection="column">
              {renderLines(visibleToolLines)}
            </Box>
          </Box>

          <Box
            height={logHeight}
            borderStyle="classic"
            borderColor={COLORS.hairline}
            paddingX={2}
            flexDirection="column"
            marginTop={1}
          >
            <Text color={COLORS.textMuted}>App Log</Text>
            <Box flexDirection="column">
              {renderLines(visibleLogLines)}
            </Box>
          </Box>
        </Box>
      </Box>

      <Box height={inputHeight} borderStyle="classic" borderColor={COLORS.hairline} paddingX={2}>
        <Text color={COLORS.accent}>{running ? "#" : ">"}</Text>
        <Text> </Text>
        <TextInput
          value={input}
          onChange={(value) => {
            if (!running) setInput(value);
          }}
          onSubmit={handleSubmit}
          placeholder={running ? "Running..." : "Ask something"}
        />
      </Box>
    </Box>
  );
};

// `exitOnCtrlC: false` is the *render* option. The previous code passed it to
// `useInput`, where it has no effect — Ink's internal Ctrl+C handler stayed
// active and could tear the app down on signal noise.
render(<App />, { exitOnCtrlC: false });
