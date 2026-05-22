const $ = (s) => document.querySelector(s);
const messagesEl = $("#messages");
const composer = $("#composer");
const sendBtn = $("#sendBtn");
const convListEl = $("#convList");
const memListEl = $("#memList");
const memCountEl = $("#memCount");
const convTitleEl = $("#convTitle");
const healthDot = $("#healthDot");
const healthLabel = $("#healthLabel");
const modelLabel = $("#modelLabel");
const newChatBtn = $("#newChatBtn");
const thinkingEl = $("#thinking");
const elapsedEl = $("#elapsed");
const stopBtn = $("#stopBtn");
const modelPicker = $("#modelPicker");
const modePill = $("#modePill");
const localNetToggle = $("#localNetToggle");

let currentModel = localStorage.getItem("atlas:model") || "";
let currentMode = localStorage.getItem("atlas:mode") || "safe-auto";
let allowLocalFetch = localStorage.getItem("atlas:localnet") === "1";
let currentConvId = null;
let streaming = false;
let runStart = 0;
let elapsedTimer = null;
let currentAbort = null;
const openApprovals = new Set();

function setMode(mode) {
  currentMode = mode;
  localStorage.setItem("atlas:mode", mode);
  if (!modePill) return;
  for (const seg of modePill.querySelectorAll(".mp-seg")) {
    seg.classList.toggle("active", seg.dataset.mode === mode);
  }
}

if (modePill) {
  modePill.addEventListener("click", (e) => {
    const seg = e.target.closest(".mp-seg");
    if (!seg) return;
    setMode(seg.dataset.mode);
  });
}

if (localNetToggle) {
  localNetToggle.addEventListener("change", () => {
    allowLocalFetch = localNetToggle.checked;
    localStorage.setItem("atlas:localnet", allowLocalFetch ? "1" : "0");
  });
}

function hideEmpty() { const e = document.getElementById("empty"); if (e) e.remove(); }
function setThinking(on) {
  thinkingEl.style.display = on ? "" : "none";
  if (on) {
    runStart = Date.now();
    elapsedTimer = setInterval(() => {
      const s = Math.floor((Date.now() - runStart) / 1000);
      elapsedEl.textContent = `${s}s`;
    }, 250);
  } else {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
  }
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

function addMsg(role, body) {
  const div = document.createElement("div");
  div.className = `msg ${role}`;
  div.innerHTML = `<div class="role">${role}</div><div class="body">${escapeHtml(body)}</div>`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function addStep(n, remaining) {
  const d = document.createElement("div");
  d.className = "step-line";
  d.id = `step-${n}`;
  const stamp = new Date().toLocaleTimeString();
  const rem = typeof remaining === "number" ? ` · ${remaining} left` : "";
  d.textContent = `step ${n} · ${stamp}${rem}`;
  messagesEl.appendChild(d);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addInferenceTiming(data) {
  const step = document.getElementById(`step-${data.step}`);
  const secs = (data.ms / 1000).toFixed(2);
  const tps = data.tok_per_s ? ` · ${data.tok_per_s} tok/s` : "";
  const tokens = data.eval_count ? ` · ${data.eval_count} tok` : "";
  const suffix = ` · infer ${secs}s${tokens}${tps}`;
  if (step) step.textContent += suffix;
  else {
    const d = document.createElement("div");
    d.className = "step-line";
    d.textContent = `inference${suffix}`;
    messagesEl.appendChild(d);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addToolCall(name, args, gated) {
  const wrap = document.createElement("div");
  wrap.className = "msg tool";
  const tag = gated ? " · awaiting approval" : "";
  wrap.innerHTML = `<div class="role">tool call${tag}</div>
    <div class="tool-block"><span class="tool-name">${escapeHtml(name)}</span>(${escapeHtml(JSON.stringify(args || {}, null, 2))})</div>`;
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addApprovalCard(callId, name, args) {
  const card = document.createElement("div");
  card.className = "approval-card";
  card.dataset.callid = callId;
  const argsJson = JSON.stringify(args || {}, null, 2);
  card.innerHTML = `
    <div class="ac-head"><span>approval required</span><span class="ac-name">${escapeHtml(name)}</span></div>
    <pre>${escapeHtml(argsJson)}</pre>
    <div class="ac-actions">
      <button class="ac-deny">deny</button>
      <button class="ac-approve">approve</button>
    </div>`;
  card.querySelector(".ac-approve").addEventListener("click", () => decide(callId, "approve"));
  card.querySelector(".ac-deny").addEventListener("click", () => decide(callId, "deny"));
  messagesEl.appendChild(card);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  openApprovals.add(callId);
}

async function decide(callId, decision) {
  const card = messagesEl.querySelector(`.approval-card[data-callid="${callId}"]`);
  if (card) card.classList.add("resolved");
  openApprovals.delete(callId);
  try {
    await fetch("/api/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callId, decision }),
    });
  } catch {}
}

function addToolResult(name, result, isError, ms) {
  const wrap = document.createElement("div");
  wrap.className = "msg tool";
  const txt = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  const timing = typeof ms === "number" ? ` · ${(ms / 1000).toFixed(2)}s` : "";
  wrap.innerHTML = `<div class="role">${isError ? "tool error" : "tool result"} · ${escapeHtml(name)}${timing}</div>
    <div class="tool-block"><pre>${escapeHtml(txt)}</pre></div>`;
  messagesEl.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function checkHealth() {
  try {
    const r = await fetch("/api/health");
    const j = await r.json();
    if (j.ok) {
      healthDot.className = "dot ok";
      healthLabel.textContent = `ollama up · ${j.tags?.models?.length ?? 0} model(s)`;
      if (!currentModel) currentModel = j.model;
      modelLabel.textContent = currentModel || j.model;
    } else {
      healthDot.className = "dot err";
      healthLabel.textContent = "ollama down";
    }
  } catch {
    healthDot.className = "dot err";
    healthLabel.textContent = "server unreachable";
  }
}

async function loadModels() {
  try {
    const r = await fetch("/api/models");
    const j = await r.json();
    modelPicker.innerHTML = "";
    for (const m of j.models || []) {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m.replace("huihui_ai/", "");
      modelPicker.appendChild(opt);
    }
    if (!currentModel) currentModel = j.default;
    if ([...modelPicker.options].some((o) => o.value === currentModel)) {
      modelPicker.value = currentModel;
    }
    modelLabel.textContent = currentModel;
  } catch (e) { /* ignore */ }
}

modelPicker.addEventListener("change", () => {
  currentModel = modelPicker.value;
  localStorage.setItem("atlas:model", currentModel);
  modelLabel.textContent = currentModel;
});

async function loadConvs() {
  const r = await fetch("/api/conversations");
  const list = await r.json();
  convListEl.innerHTML = "";
  for (const c of list) {
    const li = document.createElement("li");
    li.className = "conv-item" + (c.id === currentConvId ? " active" : "");
    li.innerHTML = `<span>${escapeHtml(c.title)}</span><span class="del" data-id="${c.id}">×</span>`;
    li.addEventListener("click", (e) => {
      if (e.target.classList.contains("del")) return;
      openConv(c.id, c.title);
    });
    li.querySelector(".del").addEventListener("click", async (e) => {
      e.stopPropagation();
      await fetch(`/api/conversations/${c.id}`, { method: "DELETE" });
      if (currentConvId === c.id) { currentConvId = null; messagesEl.innerHTML = ""; convTitleEl.textContent = "No conversation"; }
      loadConvs();
    });
    convListEl.appendChild(li);
  }
}

async function loadMems() {
  const r = await fetch("/api/memories");
  const list = await r.json();
  memCountEl.textContent = list.length;
  memListEl.innerHTML = "";
  for (const m of list) {
    const li = document.createElement("li");
    li.className = "mem-item";
    li.innerHTML = `<span><span class="mem-key">${escapeHtml(m.key)}</span> · <span class="mem-val">${escapeHtml(m.value.slice(0, 70))}${m.value.length > 70 ? "…" : ""}</span></span><span class="del" data-k="${escapeHtml(m.key)}">×</span>`;
    li.querySelector(".del").addEventListener("click", async (e) => {
      e.stopPropagation();
      await fetch(`/api/memories/${encodeURIComponent(m.key)}`, { method: "DELETE" });
      loadMems();
    });
    memListEl.appendChild(li);
  }
}

async function openConv(id, title) {
  currentConvId = id;
  convTitleEl.textContent = title || `Chat #${id}`;
  messagesEl.innerHTML = "";
  const r = await fetch(`/api/conversations/${id}/messages`);
  const msgs = await r.json();
  for (const m of msgs) {
    if (m.role === "user") addMsg("user", m.content);
    else if (m.role === "assistant") {
      if (m.content) addMsg("assistant", m.content);
      if (m.tool_calls) {
        const calls = JSON.parse(m.tool_calls);
        for (const c of calls) addToolCall(c.function?.name, c.function?.arguments);
      }
    } else if (m.role === "tool") {
      let parsed; try { parsed = JSON.parse(m.content); } catch { parsed = m.content; }
      addToolResult(m.tool_name || "tool", parsed, false, null);
    }
  }
  loadConvs();
}

async function newConv() {
  const r = await fetch("/api/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title: "New chat" }),
  });
  const j = await r.json();
  await loadConvs();
  openConv(j.id, j.title);
}

async function send(prefill) {
  const raw = typeof prefill === "string" ? prefill : composer.value;
  const text = String(raw ?? "").trim();
  if (!text || streaming) return;
  if (!currentConvId) {
    await newConv();
  }
  hideEmpty();
  composer.value = "";
  addMsg("user", text);
  streaming = true;
  sendBtn.disabled = true;
  stopBtn.style.display = "";
  setThinking(true);
  currentAbort = new AbortController();

  try {
    const resp = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        conversationId: currentConvId,
        message: text,
        model: currentModel || undefined,
        mode: currentMode,
        allowLocalFetch,
      }),
      signal: currentAbort.signal,
    });
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop();
      for (const ev of events) {
        const lines = ev.split("\n");
        let event = null, data = null;
        for (const l of lines) {
          if (l.startsWith("event: ")) event = l.slice(7);
          else if (l.startsWith("data: ")) data = JSON.parse(l.slice(6));
        }
        if (!event) continue;
        if (event === "step") addStep(data.n, data.remaining);
        else if (event === "inference_done") addInferenceTiming(data);
        else if (event === "assistant") { if (data.content) addMsg("assistant", data.content); }
        else if (event === "tool_call") addToolCall(data.name, data.args, !!data.gated);
        else if (event === "approval_required") addApprovalCard(data.callId, data.name, data.args);
        else if (event === "tool_result") addToolResult(data.name, data.result, data.isError, data.ms);
        else if (event === "audit_mode") {
          const d = document.createElement("div");
          d.className = "step-line";
          d.style.background = "#1c2733";
          d.style.color = "#7fd6ff";
          d.textContent = `audit mode: ${data.language} · routed to ${data.routed_to} · ${data.multi_pass} internal passes`;
          messagesEl.appendChild(d);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        else if (event === "loop_break") {
          const d = document.createElement("div");
          d.className = "step-line";
          d.style.background = "#3a1f14";
          d.style.color = "#ffb454";
          d.textContent = `loop break (${data.kind}) — retry refused, model must change strategy`;
          messagesEl.appendChild(d);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        else if (event === "refusal_detected") {
          const d = document.createElement("div");
          d.className = "step-line";
          d.style.background = "#3a1f14";
          d.style.color = "#ffb454";
          d.textContent = `refusal caught (attempt ${data.attempt}) — reinforcing`;
          messagesEl.appendChild(d);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        }
        else if (event === "done") {
          const d = document.createElement("div");
          d.className = "step-line";
          const total = data.total_ms ? ` · ${(data.total_ms / 1000).toFixed(1)}s total` : "";
          d.textContent = `done (${data.reason}, ${data.steps} step${data.steps === 1 ? "" : "s"}${total})`;
          messagesEl.appendChild(d);
        } else if (event === "error") {
          addMsg("system", `error: ${data.message}`);
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") addMsg("system", "stopped by you.");
    else addMsg("system", `network error: ${e}`);
  } finally {
    streaming = false;
    sendBtn.disabled = false;
    stopBtn.style.display = "none";
    setThinking(false);
    currentAbort = null;
    loadMems();
    loadConvs();
  }
}

stopBtn.addEventListener("click", () => {
  for (const id of [...openApprovals]) decide(id, "deny");
  if (currentAbort) currentAbort.abort();
});

document.addEventListener("click", (e) => {
  const qp = e.target.closest(".qp");
  if (qp) { send(qp.dataset.q); }
});

composer.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); send(); }
});
sendBtn.addEventListener("click", () => send());
newChatBtn.addEventListener("click", newConv);

(async function init() {
  setMode(currentMode);
  if (localNetToggle) localNetToggle.checked = allowLocalFetch;
  await checkHealth();
  await loadModels();
  await loadConvs();
  await loadMems();
  setInterval(loadMems, 4000);
})();
