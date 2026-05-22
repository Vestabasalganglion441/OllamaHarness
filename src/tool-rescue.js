export function toolCallFingerprint(tc) {
  const name = tc.function?.name || "";
  let args = tc.function?.arguments;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = {}; }
  }
  const argStr = JSON.stringify(args || {});
  const norm = argStr.replace(/\s+/g, " ").slice(0, 400);
  return `${name}::${norm}`;
}

export function detectLoop(history) {
  if (history.length < 2) return null;
  const last = history[history.length - 1];
  const prev = history[history.length - 2];
  if (last === prev) return { kind: "exact", fingerprint: last };
  const [lastName, lastArgs = ""] = last.split("::");
  const [prevName, prevArgs = ""] = prev.split("::");
  if (lastName !== prevName) return null;
  if (lastName === "shell") {
    const lastCmd = (lastArgs.match(/"command":"([^"]+)"/) || [])[1] || "";
    const prevCmd = (prevArgs.match(/"command":"([^"]+)"/) || [])[1] || "";
    const lastFirst = lastCmd.trim().split(/\s+/)[0];
    const prevFirst = prevCmd.trim().split(/\s+/)[0];
    if (lastFirst && lastFirst === prevFirst) return { kind: "shell_same_binary", binary: lastFirst };
  }
  return null;
}

export function isTripleLoop(toolCallHistory) {
  if (toolCallHistory.length < 3) return null;
  const a = toolCallHistory[toolCallHistory.length - 1];
  const b = toolCallHistory[toolCallHistory.length - 2];
  const c = toolCallHistory[toolCallHistory.length - 3];
  if (a === b || b === c) return { kind: "exact" };
  const ab = detectLoop([b, a]);
  const bc = detectLoop([c, b]);
  if (ab && bc) return ab;
  return null;
}

export function rescueJsonToolCalls(content, toolNames) {
  if (!content) return { toolCalls: [], remaining: content };
  const calls = [];
  let remaining = content;
  const fencedRe = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/gi;
  const matches = [...content.matchAll(fencedRe)];
  for (const m of matches) {
    try {
      const parsed = JSON.parse(m[1]);
      const name = parsed.name || parsed.tool || parsed.function?.name;
      if (!name || !toolNames.has(name)) continue;
      const args = parsed.arguments || parsed.args || parsed.parameters || parsed.function?.arguments || {};
      calls.push({ id: `rescue:${calls.length}`, function: { name, arguments: args } });
      remaining = remaining.replace(m[0], "").trim();
    } catch {}
  }
  if (!calls.length) {
    const bareRe = /^\s*(\{[\s\S]*\})\s*$/;
    const m = content.match(bareRe);
    if (m) {
      try {
        const parsed = JSON.parse(m[1]);
        const name = parsed.name || parsed.tool || parsed.function?.name;
        if (name && toolNames.has(name)) {
          const args = parsed.arguments || parsed.args || parsed.parameters || parsed.function?.arguments || {};
          calls.push({ id: "rescue:0", function: { name, arguments: args } });
          remaining = "";
        }
      } catch {}
    }
  }
  return { toolCalls: calls, remaining };
}
