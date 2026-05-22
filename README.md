# Ollama Harness

A browser-based, Claude-Code-style agent harness wrapping a local abliterated Ollama model. Single user (you), single machine, no external deps beyond Ollama. MIT-licensed.

**TL;DR**: gives a local uncensored LLM the same kind of tool loop a hosted coding agent has — file IO, shell, run_node, run_python, fetch_url, persistent memory, signed-in security audit mode — entirely on your own hardware. Streams every step (timestamps, tokens/s, per-tool latency) to a dark-mode browser UI.

## Quickstart

1. Install [Ollama](https://ollama.com/download) and start it.
2. Pull the recommended base + audit models:
   ```powershell
   ollama pull huihui_ai/qwen3-coder-abliterated:30b-a3b-instruct-q4_K_M
   ollama pull huihui_ai/gpt-oss-abliterated:20b
   ```
3. Build the tools-capable uncensored MoE (see Modelfile in this repo):
   ```powershell
   ollama create qwen3-coder-uncensored:30b-a3b-q4 -f Modelfile.qwen3-coder-uncensored
   ollama show qwen3-coder-uncensored:30b-a3b-q4   # capabilities should now include "tools"
   ```
4. ```powershell
   git clone <this repo>
   cd OllamaHarness
   npm install
   npm start
   ```
5. Open <http://127.0.0.1:8787>.

Configure via `.env` (copy from `.env.example`): `MODEL`, `AUDIT_MODEL`, `OPERATOR_NAME`, `PORT`, `OLLAMA_HOST`, `HISTORY_WINDOW`.

## Stack (lineup is 100% uncensored/abliterated)
- **Default model**: `qwen3-coder-uncensored:30b-a3b-q4` — custom build, abliterated MoE (Qwen3-Coder 30B total / ~3B active per token) with the official qwen3-coder `RENDERER` + `PARSER` directives bolted on so Ollama exposes `tools` capability. Built locally via `ollama create -f Modelfile.qwen3-coder-uncensored`. ~18 GB. Fastest end-to-end for coding because MoE activates only 3B params/token + the coder fine-tune generates terse, idiomatic code.
- **General uncensored fallback**: `huihui_ai/qwen3-abliterated:8b` (general-purpose 8B, native tool calling). Slower per task than the MoE because it generates more tokens — pick when you need broader knowledge than coding.
- **Heavy hitter**: `huihui_ai/gpt-oss-abliterated:20b` (20B F16, native tool calling + thinking). Slow but smart for hard problems.
- **Lightest**: `huihui_ai/qwen3-abliterated:4b-instruct-2507-q4_K_M` (~2.5 GB, native tool calling). Use on machines too small for the MoE.
- **FROM source (don't delete)**: `huihui_ai/qwen3-coder-abliterated:30b-a3b-instruct-q4_K_M` ships without `tools` capability, so the harness can't use it directly — but its weight blob is what the default custom build references.

### Custom-build recipe (how the default was made)
```powershell
# Inspect the official qwen3-coder to learn its tool-calling directives
ollama show --modelfile qwen3-coder:30b   # reveals: TEMPLATE {{ .Prompt }}, RENDERER qwen3-coder, PARSER qwen3-coder

# Build a Modelfile that points FROM the huihui abliterated blob and adds those directives.
# See Modelfile.qwen3-coder-uncensored in this repo. Then:
ollama create qwen3-coder-uncensored:30b-a3b-q4 -f Modelfile.qwen3-coder-uncensored
ollama show qwen3-coder-uncensored:30b-a3b-q4   # confirm capabilities now includes "tools"
```
Same recipe unlocks `tools` on any other abliterated MoE huihui ships without the capability tag.
- **Runtime**: Ollama on `http://127.0.0.1:11435`
- **Backend**: Node 24 + Express, SQLite (`better-sqlite3`) for conversations + persistent memory
- **Frontend**: vanilla JS, SSE streaming, dark UI. Each step prints timestamp + inference latency + tokens/sec + per-tool latency.

## Harness features (the engineering that makes a small local model actually work as an agent)

Failure-mode compensations:
- **`\n`-over-escape rescue** — small abliterated models often emit `\\n` literal instead of real newlines inside JSON tool args. `tools.js:maybeUnescapeOverquoted` detects (escape sequences present + no real newlines) and normalizes; `write_file`, `run_node`/`run_python` stdin all run through it. Unit tests in `test/helpers.test.mjs`.
- **JSON-fence tool-call rescue** — if a model returns a tool call as a ```json``` block in `content` instead of via Ollama's native `tool_calls`, `server.js:rescueJsonToolCalls` parses fenced or bare JSON objects matching a known tool name and executes them.
- **Refusal detector + reinforce loop** — regex catches "I can't / as an AI / against my guidelines" patterns; harness re-prompts up to 2× with a sharper system message reasserting uncensored behavior.
- **Loop break** — 3rd consecutive near-identical tool call (or 3rd consecutive `shell` with the same leading binary) is intercepted with a steering message + refused result, forcing the model to change strategy.
- **Shell command-not-found alternatives** — when a `shell` call gets "command not found", the harness probes a curated alternatives map (`python` → `py -3 / python3`, `pylint` → `ruff / py -m pylint`, etc.) and returns survivors in the tool result so the model pivots cleanly.
- **Python launcher fallback** — `run_python` tries `py -3 → python → python3` automatically (works on Windows where only `py` is on PATH).

Observability:
- **Per-step SSE timing** — `inference_done` event reports `ms`, `eval_count`, `prompt_eval_count`, `tok_per_s`; `tool_result` includes `ms`; `done` includes `total_ms`; `step` includes `remaining` step budget. Frontend renders all of it inline.

Performance + correctness:
- **Sliding-window history** (`HISTORY_WINDOW=40`) trims old turns so `num_ctx` stays sane on long conversations.
- **Coding-tuned sampling**: temperature 0.3, top_p 0.9, top_k 20, min_p 0, num_predict 4096.
- **Tool message format**: `{role:"tool", content, tool_call_id}` per Ollama spec (the misleading `name` field was dropped).

Security-audit mode (auto-activates when the user message mentions `.sol` / `audit` / `vulnerability`):
- **Solidity domain checklist** prepended to system prompt — explicit 4-pass framing (access control, oracle/economic, reentrancy/state, cryptographic/L2-specific/gas) with examples of common-class bugs (tx.origin, spot oracles, fake signature schemes, `.transfer()` 2300-gas DoS, L2 block-time semantics).
- **`audit_patterns` tool** — curated dangerous-pattern matchers for Solidity / Python / JS, returning line + snippet + severity hint + attack class for each hit. The model uses this as a seed and then verifies each hit in context.
- **Auto-routing to a thinking model** — Solidity audits default to `huihui_ai/gpt-oss-abliterated:20b` (which has the `thinking` capability) rather than the speed-optimized MoE; explicit `model` in the API call overrides.
- **Anti-confabulation prompt rule** — "an invented finding is worse than a missed finding; if a file is clean on an axis, say so — do not pad the list".

## Run

```powershell
cd path\to\OllamaHarness
npm install
npm start
```

Open http://127.0.0.1:8787

## Tools the agent has
- `read_file` / `write_file` / `list_dir` — workspace-sandboxed file IO under `./workspace/`
- `shell` — PowerShell (Windows) or sh (Unix), 60s timeout. Auto-detects "command not found" and returns `available_alternatives` so the model pivots.
- `run_node` / `run_python` — execute a workspace JS / Python script you just wrote, to test it. Python tries `py -3 → python → python3`.
- `fetch_url` — HTTP GET, 20 KB cap, private IPs blocked unless "Local net" toggled in the UI.
- `audit_patterns` — grep a file against a curated list of dangerous patterns for `solidity` / `python` / `js`. Returns structured hits (line + snippet + severity hint + attack class) — used as a seed for security audits.
- `remember` / `recall` / `forget` — durable memory (SQLite, top 25 auto-injected into every system prompt).
- `finish` — model calls this when the task is complete.

## How the loop works
1. User sends a task → server saves user message
2. Server builds chat = `[system + recent memory + full history]`
3. POST to Ollama `/api/chat` with `tools` list
4. If model returns `tool_calls`, server executes them, appends results, loops (max 12 steps)
5. Model calls `finish` to end cleanly, or loop exits on no-tool-call assistant turn

Everything streams to the browser via Server-Sent Events: step counter, assistant text, tool call, tool result, done.

## Memory model
Two layers:
- **Short-term**: full conversation history per chat (`messages` table)
- **Long-term**: key/value memories (`memories` table). Top 25 most recent get injected into every system prompt — the agent reads them automatically. It can `remember(key, value, tags)` to add and `recall(query)` to search.

## Files
- `server.js` — Express, agent loop, SSE, refusal/loop detection, audit-mode routing
- `tools.js` — tool definitions, sandboxed execution, `audit_patterns` pattern library
- `public/` — frontend (index.html / style.css / app.js)
- `test/helpers.test.mjs` — unit tests for the over-escape rescue heuristic
- `Modelfile.qwen3-coder-uncensored` — recipe to bolt the official qwen3-coder `RENDERER`/`PARSER` directives onto the huihui abliterated MoE weights so Ollama exposes `tools`
- `data/harness.db` — SQLite (gitignored)
- `workspace/` — agent's file sandbox (gitignored)

## Safety / what this isn't
This is the engineering layer. The model is whatever you point `MODEL=` at — by default an abliterated (refusal-stripped) Qwen3-Coder. **You are the trust boundary.** The harness sandboxes file IO to `./workspace/` and HTTP fetch to public IPs by default, but `shell` runs whatever you let it run (PowerShell or sh, with your environment); the approval modes (`auto` / `safe-auto` / `approve-all`) gate that. Read the system prompt in `server.js` and decide if you want what it says.

Do not deploy this on a public network. It is intended for `127.0.0.1` only and has an origin/host guard that enforces that — but the security model assumes one operator on one machine.

## License
MIT — see [LICENSE](./LICENSE).
