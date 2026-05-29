import {
  createApp,
  ref,
  reactive,
  computed,
  onMounted,
  onBeforeUnmount,
  nextTick,
  watch,
} from "https://unpkg.com/vue@3.5.13/dist/vue.esm-browser.prod.js";

const MAX_HISTORY = 200;
const MAX_TOOL_TRACE = 50;
const MAX_APP_LOG = 200;

const SUGGESTIONS = [
  "What can you do?",
  "Cek isi /memories/user_profile.md",
  "Cuaca di Jakarta hari ini?",
  "Carikan berita AI terbaru.",
];

const formatDuration = (ms) => {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
};

const formatSession = (ms) => {
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
};

const formatTs = (ts) => new Date(ts).toISOString().slice(11, 19);

const truncate = (s, n) => {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

const App = {
  setup() {
    const input = ref("");
    const chatHistory = ref([]);
    const pending = ref(null);
    const toolTrace = ref([]);
    const appLog = ref([]);
    const running = ref(false);
    const runStart = ref(null);
    const lastDuration = ref(null);
    const now = ref(Date.now());
    const sessionStart = ref(Date.now());
    const error = ref("");
    const initError = ref("");
    const health = reactive({ ok: false, model: "", error: null });

    const scrollEl = ref(null);
    const logEl = ref(null);
    const inputEl = ref(null);

    let nowTimer = null;
    let abortCtrl = null;
    let idCount = 0;
    const nextId = () => `${Date.now()}-${++idCount}`;

    const suggestions = SUGGESTIONS;

    const elapsed = computed(() => {
      if (running.value && runStart.value != null) {
        return now.value - runStart.value;
      }
      return lastDuration.value;
    });

    const sessionElapsed = computed(() => now.value - sessionStart.value);

    const reversedTools = computed(() => [...toolTrace.value].reverse());

    const stateLabel = computed(() => {
      if (initError.value) return "Init Error";
      if (error.value) return "Error";
      if (running.value) return "Running";
      return "Idle";
    });

    const stateClass = computed(() => {
      if (initError.value || error.value) return "err";
      if (running.value) return "running";
      return "idle";
    });

    const pushLog = (entry) => {
      appLog.value = [
        ...appLog.value,
        {
          id: nextId(),
          level: String(entry.level || "info"),
          text: String(entry.text ?? ""),
          ts: entry.ts ?? Date.now(),
        },
      ].slice(-MAX_APP_LOG);
      scrollLogToBottom();
    };

    const scrollChatToBottom = () => {
      nextTick(() => {
        if (scrollEl.value) {
          scrollEl.value.scrollTop = scrollEl.value.scrollHeight;
        }
      });
    };

    const scrollLogToBottom = () => {
      nextTick(() => {
        if (logEl.value) {
          logEl.value.scrollTop = logEl.value.scrollHeight;
        }
      });
    };

    const autoresize = () => {
      const el = inputEl.value;
      if (!el) return;
      el.style.height = "auto";
      el.style.height = Math.min(200, el.scrollHeight) + "px";
    };

    const applySuggestion = (text) => {
      input.value = text;
      nextTick(() => {
        autoresize();
        inputEl.value?.focus();
      });
    };

    const clearAll = () => {
      chatHistory.value = [];
      pending.value = null;
      toolTrace.value = [];
      appLog.value = [];
      error.value = "";
      lastDuration.value = null;
    };

    const cancel = () => {
      if (abortCtrl) {
        abortCtrl.abort();
        error.value = "Cancelled current run.";
        pushLog({ level: "warn", text: "run cancelled by user" });
      }
    };

    const onKeyDown = (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
        return;
      }
      if (e.key === "Escape" && running.value) {
        e.preventDefault();
        cancel();
        return;
      }
      if (e.key.toLowerCase() === "l" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        clearAll();
      }
    };

    // Parse SSE chunks from a fetch ReadableStream
    const consumeSSE = async (response, handler) => {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf("\n\n")) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!raw.trim()) continue;

          let event = "message";
          const dataLines = [];
          for (const line of raw.split("\n")) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:"))
              dataLines.push(line.slice(5).replace(/^\s/, ""));
          }
          const dataStr = dataLines.join("\n");
          let data = null;
          try {
            data = dataStr ? JSON.parse(dataStr) : null;
          } catch {
            data = dataStr;
          }
          handler(event, data);
        }
      }
    };

    const submit = async () => {
      const trimmed = input.value.trim();
      if (!trimmed || running.value) return;
      if (!health.ok) {
        error.value = initError.value || "Agent unavailable.";
        return;
      }

      const userMsg = { id: nextId(), role: "user", content: trimmed };
      const updated = [...chatHistory.value, userMsg].slice(-MAX_HISTORY);
      chatHistory.value = updated;
      input.value = "";
      autoresize();
      error.value = "";
      running.value = true;
      const startedAt = Date.now();
      runStart.value = startedAt;
      pending.value = { id: null, content: "" };
      scrollChatToBottom();

      abortCtrl = new AbortController();

      try {
        const res = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            messages: updated.map(({ role, content }) => ({ role, content })),
          }),
          signal: abortCtrl.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `HTTP ${res.status}`);
        }

        let activePending = null;

        await consumeSSE(res, (event, data) => {
          switch (event) {
            case "log":
              pushLog(data);
              break;
            case "assistant_start":
              activePending = { id: data.id, content: "" };
              pending.value = activePending;
              break;
            case "assistant_chunk": {
              if (!activePending || activePending.id !== data.id) {
                activePending = { id: data.id, content: "" };
              }
              activePending = {
                id: data.id,
                content: activePending.content + (data.content ?? ""),
              };
              pending.value = activePending;
              break;
            }
            case "assistant_end": {
              const finalText =
                data.content ?? (activePending ? activePending.content : "");
              chatHistory.value = [
                ...chatHistory.value,
                { id: data.id, role: "assistant", content: finalText },
              ].slice(-MAX_HISTORY);
              pending.value = null;
              activePending = null;
              scrollChatToBottom();
              break;
            }
            case "tool_start":
              toolTrace.value = [
                ...toolTrace.value,
                {
                  id: data.id,
                  name: data.name,
                  input: data.input ?? "",
                  output: "",
                  status: "running",
                  startedAt: Date.now(),
                },
              ].slice(-MAX_TOOL_TRACE);
              break;
            case "tool_end": {
              toolTrace.value = toolTrace.value.map((t) =>
                t.id === data.id
                  ? {
                      ...t,
                      output: data.output ?? "",
                      status: data.status ?? "done",
                      endedAt: Date.now(),
                    }
                  : t
              );
              break;
            }
            case "error":
              error.value = data?.message ?? "Agent run failed.";
              break;
            case "done":
              lastDuration.value = data?.duration ?? Date.now() - startedAt;
              break;
            default:
              break;
          }
        });
      } catch (err) {
        if (err?.name === "AbortError") {
          // already noted by cancel()
        } else {
          const msg = err?.message ?? "Request failed.";
          error.value = msg;
          pushLog({ level: "error", text: `request failed: ${msg}` });
        }
      } finally {
        running.value = false;
        runStart.value = null;
        pending.value = null;
        abortCtrl = null;
        scrollChatToBottom();
      }
    };

    const fetchHealth = async () => {
      try {
        const r = await fetch("/api/health");
        const j = await r.json();
        health.ok = !!j.ok;
        health.model = j.model || "";
        health.error = j.error || null;
        if (!j.ok && j.error) {
          initError.value = j.error;
        } else {
          initError.value = "";
        }
        pushLog({
          level: j.ok ? "api" : "error",
          text: j.ok
            ? `agent online · model=${j.model}`
            : `agent offline: ${j.error || "unknown"}`,
        });
      } catch (err) {
        health.ok = false;
        initError.value = err?.message ?? "Health check failed.";
        pushLog({ level: "error", text: `health check failed: ${err?.message ?? err}` });
      }
    };

    onMounted(() => {
      nowTimer = setInterval(() => {
        now.value = Date.now();
      }, 250);
      fetchHealth();
      autoresize();
      nextTick(() => inputEl.value?.focus());
    });

    onBeforeUnmount(() => {
      if (nowTimer) clearInterval(nowTimer);
      abortCtrl?.abort();
    });

    watch(pending, () => scrollChatToBottom());

    return {
      input,
      chatHistory,
      pending,
      toolTrace,
      appLog,
      running,
      error,
      initError,
      health,
      elapsed,
      sessionElapsed,
      lastDuration,
      reversedTools,
      stateLabel,
      stateClass,
      scrollEl,
      logEl,
      inputEl,
      suggestions,
      submit,
      cancel,
      clearAll,
      applySuggestion,
      onKeyDown,
      autoresize,
      formatDuration,
      formatSession,
      formatTs,
      truncate,
    };
  },
};

createApp(App).mount("#app");
