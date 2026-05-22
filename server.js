import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getToolSchemas,
  runTool,
  getToolCategory,
  WORKSPACE_ROOT,
} from "./tools.js";
import {
  openDatabase,
  saveMessage,
  loadMessages,
  windowedHistory,
  loadMemoryPreamble,
} from "./src/db.js";
import {
  buildSystemPrompt,
  buildReinforcePrompt,
  SOLIDITY_AUDIT_CHECKLIST,
} from "./src/prompts.js";
import { looksLikeRefusal, stripThinkingTags } from "./src/refusal.js";
import {
  toolCallFingerprint,
  isTripleLoop,
  rescueJsonToolCalls,
} from "./src/tool-rescue.js";
import { callOllamaChat, listOllamaTags } from "./src/ollama.js";
import { detectSolidityAuditIntent } from "./src/audit.js";
import { setupSseResponse, originGuard } from "./src/sse.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "8787", 10);
const HOST = process.env.HOST || "127.0.0.1";
const OLLAMA_HOST = process.env.OLLAMA_HOST || "http://127.0.0.1:11435";
const DEFAULT_MODEL = process.env.MODEL || "qwen3-coder-uncensored:30b-a3b-q4";
const THINKING_MODEL = process.env.AUDIT_MODEL || "huihui_ai/gpt-oss-abliterated:20b";
const HISTORY_WINDOW = parseInt(process.env.HISTORY_WINDOW || "40", 10);
const OPERATOR_NAME = process.env.OPERATOR_NAME || "the operator";
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const DATA_DIR = path.join(__dirname, "data");

const db = await openDatabase(DATA_DIR);
const SYSTEM_PROMPT = buildSystemPrompt({ operatorName: OPERATOR_NAME, workspaceRoot: WORKSPACE_ROOT });
const REINFORCE_PROMPT = buildReinforcePrompt({ operatorName: OPERATOR_NAME });

const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);

const pendingApprovals = new Map();

function requestApproval(callId, payload, send) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pendingApprovals.has(callId)) {
        pendingApprovals.delete(callId);
        resolve({ approved: false, reason: "timeout" });
      }
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(callId, {
      resolve: (decision) => {
        clearTimeout(timer);
        pendingApprovals.delete(callId);
        resolve(decision);
      },
    });
    send("approval_required", { callId, ...payload });
  });
}

function decideApprovalDefault(name, mode) {
  if (mode === "auto") return "auto";
  const category = getToolCategory(name);
  if (mode === "safe-auto" && category === "read") return "auto";
  return "needs_approval";
}

process.on("unhandledRejection", (reason) => {
  console.error(`[unhandledRejection] ${reason?.stack || reason}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[uncaughtException] ${err?.stack || err}`);
});

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use((req, _res, next) => {
  if (req.path.startsWith("/api/")) console.log(`[req] ${req.method} ${req.path}`);
  next();
});
app.use(originGuard(ALLOWED_HOSTS, ALLOWED_ORIGINS));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (_req, res) => {
  try {
    const tags = await listOllamaTags(OLLAMA_HOST);
    res.json({ ok: true, model: DEFAULT_MODEL, ollama: OLLAMA_HOST, workspace: WORKSPACE_ROOT, tags });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
});

app.get("/api/models", async (_req, res) => {
  try {
    const tags = await listOllamaTags(OLLAMA_HOST);
    const models = (tags.models || []).map((m) => m.name).sort();
    res.json({ models, default: DEFAULT_MODEL });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/conversations", (_req, res) => {
  res.json(db.prepare("SELECT id,title,created_at FROM conversations ORDER BY id DESC LIMIT 100").all());
});

app.post("/api/conversations", (req, res) => {
  const title = (req.body && req.body.title) || "New chat";
  const r = db.prepare("INSERT INTO conversations(title,created_at) VALUES(?,?)").run(title, Date.now());
  res.json({ id: r.lastInsertRowid, title });
});

app.get("/api/conversations/:id/messages", (req, res) => {
  res.json(
    db
      .prepare("SELECT id,role,content,tool_calls,tool_name,created_at FROM messages WHERE conversation_id=? ORDER BY id ASC")
      .all(req.params.id)
  );
});

app.delete("/api/conversations/:id", (req, res) => {
  db.prepare("DELETE FROM messages WHERE conversation_id=?").run(req.params.id);
  db.prepare("DELETE FROM conversations WHERE id=?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/api/memories", (_req, res) => {
  res.json(db.prepare("SELECT key,value,tags,created_at FROM memories ORDER BY created_at DESC").all());
});

app.delete("/api/memories/:key", (req, res) => {
  const r = db.prepare("DELETE FROM memories WHERE key=?").run(req.params.key);
  res.json({ deleted: r.changes });
});

app.post("/api/approve", (req, res) => {
  const { callId, decision } = req.body || {};
  const p = pendingApprovals.get(callId);
  if (!p) return res.status(404).json({ error: "no such approval" });
  p.resolve({ approved: decision === "approve", reason: decision === "approve" ? "approved" : "denied" });
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  const {
    conversationId,
    message,
    maxSteps = 12,
    model,
    mode = "safe-auto",
    allowLocalFetch = false,
  } = req.body || {};
  if (!conversationId || !message || typeof message !== "string" || !message.trim()) {
    return res.status(400).json({ error: "conversationId and non-empty message required" });
  }
  const normalizedMode = ["auto", "safe-auto", "approve-all"].includes(mode) ? mode : "safe-auto";
  const send = setupSseResponse(res);

  const ollamaAbort = new AbortController();
  const openApprovalIds = new Set();
  res.on("close", () => {
    if (res.writableFinished) return;
    ollamaAbort.abort();
    for (const id of openApprovalIds) {
      const p = pendingApprovals.get(id);
      if (p) p.resolve({ approved: false, reason: "client_closed" });
    }
  });

  try {
    const isSolidityAudit = detectSolidityAuditIntent(message);
    const userExplicitModel = !!model;
    const activeModel = userExplicitModel
      ? model
      : (isSolidityAudit ? THINKING_MODEL : DEFAULT_MODEL);

    saveMessage(db, conversationId, "user", message);
    const history = loadMessages(db, conversationId);
    let systemContent = SYSTEM_PROMPT + loadMemoryPreamble(db);
    if (isSolidityAudit) systemContent += SOLIDITY_AUDIT_CHECKLIST;
    const chat = [{ role: "system", content: systemContent }, ...windowedHistory(history, HISTORY_WINDOW)];
    const toolSchemas = getToolSchemas();
    const toolNameSet = new Set(toolSchemas.map((s) => s.function.name));
    const ctx = { db, allowLocalFetch: !!allowLocalFetch };
    if (isSolidityAudit) {
      send("audit_mode", { language: "solidity", routed_to: activeModel, multi_pass: 4 });
    }

    let steps = 0;
    let finished = false;
    let refusalRetries = 0;
    const toolCallHistory = [];
    const runStart = Date.now();

    while (steps < maxSteps && !finished) {
      steps += 1;
      const tStep = Date.now();
      send("step", { n: steps, ts: tStep, model: activeModel, remaining: maxSteps - steps });

      const tInfer = Date.now();
      const resp = await callOllamaChat({
        host: OLLAMA_HOST,
        model: activeModel,
        messages: chat,
        tools: toolSchemas,
        signal: ollamaAbort.signal,
      });
      const inferMs = Date.now() - tInfer;

      const msg = resp.message || {};
      let content = stripThinkingTags(msg.content || "");
      let toolCalls = msg.tool_calls || [];
      if (!toolCalls.length && content) {
        const rescued = rescueJsonToolCalls(content, toolNameSet);
        if (rescued.toolCalls.length) {
          toolCalls = rescued.toolCalls;
          content = rescued.remaining;
          send("rescued_tool_calls", { count: toolCalls.length });
        }
      }

      const tokensEval = resp.eval_count || 0;
      const tokensPerSec = inferMs > 0 ? Math.round((tokensEval / inferMs) * 1000) : 0;
      send("inference_done", {
        step: steps,
        ms: inferMs,
        eval_count: tokensEval,
        prompt_eval_count: resp.prompt_eval_count || 0,
        tok_per_s: tokensPerSec,
      });

      const isRefusal =
        !toolCalls.length &&
        normalizedMode !== "approve-all" &&
        looksLikeRefusal(content) &&
        refusalRetries < 2;
      if (isRefusal) {
        refusalRetries += 1;
        send("refusal_detected", { attempt: refusalRetries, sample: content.slice(0, 200) });
        chat.push({ role: "assistant", content });
        chat.push({ role: "user", content: REINFORCE_PROMPT });
        continue;
      }

      saveMessage(db, conversationId, "assistant", content, toolCalls.length ? toolCalls : null);
      chat.push({ role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      if (content) send("assistant", { content });

      if (!toolCalls.length) {
        send("done", { reason: "no_tool_calls", steps, total_ms: Date.now() - runStart });
        finished = true;
        break;
      }

      for (let i = 0; i < toolCalls.length; i += 1) {
        const tc = toolCalls[i];
        const name = tc.function?.name;
        const toolCallId = tc.id || `${steps}:${i}`;
        let args = tc.function?.arguments;
        if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }

        const fp = toolCallFingerprint(tc);
        toolCallHistory.push(fp);
        const loop = isTripleLoop(toolCallHistory);
        if (loop) {
          const reason = loop.kind === "shell_same_binary"
            ? `Loop break: 3rd consecutive shell call starting with '${loop.binary}'. The binary is not behaving how you expect — stop retrying. Pivot strategy now: reason from what you already have, or call finish() with what you can deliver. The retry was refused.`
            : `Loop break: 3rd consecutive tool call with near-identical arguments (${name}). Stop. Change strategy: reason from prior results, try a different approach, or call finish(). The retry was refused.`;
          const interruptResult = { error: reason, denied: true, reason: "loop_break" };
          const interruptStr = JSON.stringify(interruptResult);
          saveMessage(db, conversationId, "tool", interruptStr, null, name);
          chat.push({ role: "tool", content: interruptStr, tool_call_id: toolCallId });
          send("tool_result", { name, result: interruptResult, isError: true, ms: 0 });
          send("loop_break", { name, kind: loop.kind });
          continue;
        }

        const verdict = decideApprovalDefault(name, normalizedMode);
        if (verdict === "needs_approval") {
          const callId = `${conversationId}:${steps}:${i}`;
          openApprovalIds.add(callId);
          send("tool_call", { name, args, gated: true });
          const decision = await requestApproval(callId, { name, args }, send);
          openApprovalIds.delete(callId);
          if (!decision.approved) {
            const result = { error: "denied by user", denied: true, reason: decision.reason };
            const resultStr = JSON.stringify(result);
            saveMessage(db, conversationId, "tool", resultStr, null, name);
            chat.push({ role: "tool", content: resultStr, tool_call_id: toolCallId });
            send("tool_result", { name, result, isError: true, ms: 0 });
            continue;
          }
        } else {
          send("tool_call", { name, args, gated: false });
        }

        let result, isError = false;
        const tTool = Date.now();
        try {
          result = await runTool(name, args, ctx);
        } catch (e) {
          result = { error: String(e?.message || e) };
          isError = true;
        }
        const toolMs = Date.now() - tTool;
        const resultStr = typeof result === "string" ? result : JSON.stringify(result);
        saveMessage(db, conversationId, "tool", resultStr, null, name);
        chat.push({ role: "tool", content: resultStr, tool_call_id: toolCallId });
        send("tool_result", { name, result, isError, ms: toolMs });
        if (name === "finish" && !isError) {
          send("done", { reason: "finish", steps, final: result.final, total_ms: Date.now() - runStart });
          finished = true;
        }
      }
    }
    if (!finished) send("done", { reason: "max_steps", steps, total_ms: Date.now() - runStart });
    res.end();
  } catch (e) {
    if (e?.name === "AbortError") {
      send("done", { reason: "aborted", steps: 0 });
    } else {
      console.error(`[chat-error] conv=${conversationId} ${e?.stack || e}`);
      send("error", { message: String(e?.message || e) });
    }
    res.end();
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Ollama Harness listening on http://${HOST}:${PORT}`);
  console.log(`Model: ${DEFAULT_MODEL}`);
  console.log(`Audit model: ${THINKING_MODEL}`);
  console.log(`Ollama: ${OLLAMA_HOST}`);
  console.log(`Workspace: ${WORKSPACE_ROOT}`);
});
