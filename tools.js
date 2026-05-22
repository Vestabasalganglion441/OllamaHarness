import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dns from "node:dns/promises";
import net from "node:net";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function validateWorkspaceEnv(envValue) {
  const abs = path.resolve(envValue);
  const rel = path.relative(PROJECT_ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `WORKSPACE env must point inside project root (${PROJECT_ROOT}). Got: ${abs}`
    );
  }
  return abs;
}

const ROOT = process.env.WORKSPACE
  ? validateWorkspaceEnv(process.env.WORKSPACE)
  : path.join(PROJECT_ROOT, "workspace");

await fs.mkdir(ROOT, { recursive: true });

export function maybeUnescapeOverquoted(s) {
  if (typeof s !== "string" || !s.length) return s;
  const hasLiteralEscapes = /\\[ntr"\\]/.test(s);
  if (!hasLiteralEscapes) return s;
  if (s.includes("\n")) return s;
  try {
    const wrapped = '"' + s.replace(/(?<!\\)"/g, '\\"') + '"';
    const parsed = JSON.parse(wrapped);
    if (typeof parsed === "string" && parsed.includes("\n")) return parsed;
  } catch {}
  return s
    .replace(/\\\\/g, "\x00")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\x00/g, "\\");
}

function resolveInsideWorkspace(p) {
  const raw = String(p ?? "");
  if (raw.includes("\0")) throw new Error("path contains null byte");
  let cleaned = raw.replace(/\\/g, "/").trim();
  cleaned = cleaned.replace(/^\.?\/+/, "").replace(/^workspace\/+/i, "");
  const abs = path.resolve(ROOT, cleaned);
  const rel = path.relative(ROOT, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return abs;
}

async function resolveInsideWorkspaceReal(p) {
  const abs = resolveInsideWorkspace(p);
  try {
    const real = await fs.realpath(abs);
    const rel = path.relative(ROOT, real);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`symlink escapes workspace: ${p}`);
    }
    return real;
  } catch (e) {
    if (e.code === "ENOENT") return abs;
    throw e;
  }
}

const SECRET_ENV_PATTERNS = [
  /PRIVATE[_-]?KEY/i,
  /SECRET/i,
  /_TOKEN(_|$)/i,
  /API[_-]?KEY/i,
  /PASSWORD/i,
  /PASSPHRASE/i,
  /SESSION/i,
  /COOKIE/i,
  /AWS_/i,
  /AZURE_/i,
  /GCP_/i,
  /STRIPE_/i,
  /OPENAI/i,
  /ANTHROPIC/i,
];

function scrubbedEnv() {
  const out = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV_PATTERNS.some((re) => re.test(k))) continue;
    out[k] = v;
  }
  out.HARNESS_WORKSPACE = ROOT;
  return out;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true;
    if (lower.startsWith("fe80")) return true;
    if (lower.startsWith("::ffff:")) {
      return isPrivateIp(lower.slice(7));
    }
    return false;
  }
  return true;
}

async function assertPublicUrl(urlStr, { allowLocalFetch }) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    throw new Error("invalid url");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`scheme not allowed: ${u.protocol}`);
  }
  if (allowLocalFetch) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host.toLowerCase() === "localhost") {
    throw new Error("blocked: localhost (enable Local net to allow)");
  }
  let ip = host;
  if (!net.isIP(host)) {
    const records = await dns.lookup(host, { all: true });
    for (const r of records) {
      if (isPrivateIp(r.address)) {
        throw new Error(`blocked: private IP ${r.address} (enable Local net to allow)`);
      }
    }
    ip = records[0]?.address || host;
  } else if (isPrivateIp(host)) {
    throw new Error(`blocked: private IP ${host} (enable Local net to allow)`);
  }
  return u;
}

async function safeFetch(urlStr, { allowLocalFetch }) {
  let current = urlStr;
  for (let hop = 0; hop < 4; hop += 1) {
    await assertPublicUrl(current, { allowLocalFetch });
    const r = await fetch(current, {
      headers: { "User-Agent": "OllamaHarness/0.2" },
      redirect: "manual",
    });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
      const next = new URL(r.headers.get("location"), current).toString();
      current = next;
      continue;
    }
    const text = await r.text();
    return { status: r.status, url: current, body: text.slice(0, 20_000) };
  }
  throw new Error("too many redirects");
}

function inferLanguage(p) {
  const s = String(p || "").toLowerCase();
  if (s.endsWith(".sol")) return "solidity";
  if (s.endsWith(".py")) return "python";
  if (/\.(m?js|cjs|ts|tsx|jsx)$/.test(s)) return "js";
  return "";
}

const AUDIT_PATTERNS = {
  solidity: [
    { name: "tx_origin_auth", re: /\btx\.origin\b/, severity: "HIGH", why: "tx.origin is phishable — any contract the EOA interacts with can call your protected function via msg.sender chain. Use msg.sender for auth.", verify: "Confirm this is being used for authorization, not just logging." },
    { name: "transfer_send_2300_gas", re: /\.(transfer|send)\s*\(/, severity: "MEDIUM", why: ".transfer() / .send() forward only 2300 gas — breaks for smart wallets, Safe multisigs, and contracts with non-trivial receive(). DoS user funds.", verify: "Check if the recipient could ever be a contract." },
    { name: "raw_keccak_signature", re: /==\s*keccak256\s*\(/, severity: "CRITICAL", why: "Comparing a parameter to keccak256(...) is NOT a signature scheme — the hash is deterministic and computable by anyone with the inputs. Use ecrecover + EIP-712 or ECDSA.recover.", verify: "Confirm the right-hand side uses only data the attacker also knows." },
    { name: "spot_oracle_get_reserves", re: /\.getReserves\s*\(/, severity: "HIGH", why: "Uniswap V2 getReserves() returns spot reserves — manipulable in a single tx via flash loan. Use a TWAP (cumulative price) over 30+ minutes.", verify: "Check if the value feeds pricing for any transferable value." },
    { name: "spot_oracle_uniswap_v3_slot0", re: /\.slot0\s*\(/, severity: "HIGH", why: "Uniswap V3 slot0() returns the spot tick — manipulable. Use the TWAP observe() instead.", verify: "Check if the value feeds pricing for any transferable value." },
    { name: "delegatecall_to_dynamic", re: /\.delegatecall\s*\(/, severity: "HIGH", why: "delegatecall executes target code in this contract's storage context. If the target is attacker-controlled, full takeover.", verify: "Confirm the target address is immutable or fully trusted." },
    { name: "selfdestruct", re: /\bselfdestruct\s*\(/, severity: "MEDIUM", why: "Post-Cancun (EIP-6780) selfdestruct only sends balance when called in the same tx as creation — relying on it for upgrades or cleanup is broken on modern chains.", verify: "Confirm the contract isn't expected to be redeployed at the same address." },
    { name: "block_timestamp_critical", re: /\bblock\.timestamp\b/, severity: "LOW", why: "block.timestamp can be nudged ~15s by miners and is the SEQUENCER clock on L2s (Base, OP, Arbitrum) — not L1 time. Don't use as randomness or for short-window TWAPs.", verify: "OK for >5min deadlines; not OK for randomness, RNG, or short-window pricing." },
    { name: "block_number_l2", re: /\bblock\.number\b/, severity: "LOW", why: "On Base/OP-stack L2s, block.number ticks every 2s — NOT every 12s like L1. Time math using block.number is wrong on L2.", verify: "Convert to block.timestamp if measuring real-world time." },
    { name: "unchecked_transfer_return", re: /[A-Za-z0-9_)]\s*\.\s*(?:transfer|transferFrom)\s*\(/, severity: "MEDIUM", why: "ERC20.transfer/transferFrom can return false (USDT historically) or revert (non-standard tokens). Wrap in require(...) or use SafeERC20. Note: also fires on payable(addr).transfer(value) which has a separate 2300-gas issue — disambiguate by context.", verify: "Confirm return value is consumed by require/assert, OR that this is a payable.transfer call (different bug class)." },
    { name: "ecrecover_no_zero_check", re: /\becrecover\s*\(/, severity: "MEDIUM", why: "ecrecover returns address(0) on bad signature — must require(signer != address(0)) AFTER recovery, otherwise zero address can 'sign' anything.", verify: "Look for an explicit zero-check on the returned signer." },
    { name: "deprecated_assembly", re: /\bassembly\s*\{/, severity: "MEDIUM", why: "Inline assembly bypasses Solidity safety. Each block needs careful review for storage slot math, memory layout, return-data handling.", verify: "Read the entire assembly block in context." },
    { name: "hardcoded_eoa_address", re: /0x[a-fA-F0-9]{40}/, severity: "LOW", why: "Hardcoded address could be wrong on different chains or a stale deployment. Confirm it's a known protocol contract on the deploy chain.", verify: "Cross-reference the address with the expected contract on this L2." },
    { name: "owner_can_pull_arbitrary_token", re: /function\s+sweep(?:Token|ERC20)?\s*\(/i, severity: "HIGH", why: "Generic 'sweep token' admin function can drain user-deposited tokens, not just stuck dust. Restrict to non-protocol-asset tokens.", verify: "Check if the function excludes the protocol's own asset list." },
    { name: "pragma_floating", re: /^\s*pragma\s+solidity\s+\^/, severity: "LOW", why: "Floating pragma (^0.8.x) means the contract may compile with a different compiler than was audited — subtle codegen differences possible.", verify: "Pin the pragma for the production deploy." },
    { name: "missing_zero_address_check", re: /constructor\s*\([^)]*address\s+_[a-zA-Z]+/, severity: "LOW", why: "Constructor accepts an address parameter — verify it checks for address(0) before storing, otherwise contract is bricked on deploy mistake.", verify: "Confirm a require(_addr != address(0)) before assignment." },
    { name: "two_step_ownership_missing", re: /function\s+transferOwnership\s*\(/, severity: "LOW", why: "Single-step ownership transfer can brick the contract if the new address is wrong (typo, contract that can't call). Use 2-step accept pattern (OZ Ownable2Step).", verify: "Check for an acceptOwnership() function." },
  ],
  python: [
    { name: "sql_string_concat", re: /\.(?:execute|executemany)\s*\([^)]*[+%]\s*[a-zA-Z_]/, severity: "CRITICAL", why: "String concatenation or % formatting inside execute() = SQL injection. Use ?-parameterized queries.", verify: "Confirm user input flows into the concatenation." },
    { name: "eval_input", re: /\beval\s*\(/, severity: "CRITICAL", why: "eval() on user input = arbitrary code execution. Use ast.literal_eval for data, or a real parser for expressions.", verify: "Check if any caller passes external input." },
    { name: "exec_input", re: /\bexec\s*\(/, severity: "CRITICAL", why: "exec() on user input = arbitrary code execution.", verify: "Check if any caller passes external input." },
    { name: "shell_true", re: /shell\s*=\s*True/, severity: "HIGH", why: "subprocess with shell=True + concatenated input = shell injection. Use list args without shell=True.", verify: "Trace what gets concatenated into the command." },
    { name: "os_system_concat", re: /os\.system\s*\([^)]*\+/, severity: "HIGH", why: "os.system with string concat = shell injection. Use subprocess.run([list], shell=False).", verify: "Trace input flow." },
    { name: "pickle_load_input", re: /pickle\.loads?\s*\(/, severity: "CRITICAL", why: "Unpickling untrusted data = arbitrary code execution.", verify: "Confirm the data source is trusted." },
    { name: "yaml_load_unsafe", re: /yaml\.load\s*\([^,)]*\)/, severity: "HIGH", why: "yaml.load without SafeLoader can construct arbitrary Python objects. Use yaml.safe_load.", verify: "Check for SafeLoader argument." },
    { name: "md5_or_sha1", re: /hashlib\.(?:md5|sha1)\b/, severity: "MEDIUM", why: "MD5 and SHA1 are broken for collision resistance. Use sha256+ for integrity, scrypt/argon2/bcrypt for passwords.", verify: "Check the use case — integrity, password, or non-security?" },
    { name: "weak_random_in_security", re: /\brandom\.(?:random|randint|choice|sample|shuffle|seed)\s*\(/, severity: "LOW", why: "random is NOT cryptographically secure. Use secrets module for tokens/keys/IDs.", verify: "Check if the output is used for auth or secrets." },
    { name: "hardcoded_secret", re: /(?:API_KEY|SECRET|PASSWORD|TOKEN)\s*=\s*["'][A-Za-z0-9_\-+/]{8,}["']/i, severity: "HIGH", why: "Hardcoded secret in source = leak via git history / file disclosure. Load from env or secret manager.", verify: "Verify it's not a placeholder or test fixture." },
  ],
  js: [
    { name: "eval_input", re: /\beval\s*\(/, severity: "CRITICAL", why: "eval() on dynamic input = arbitrary code execution.", verify: "Trace input flow." },
    { name: "function_constructor", re: /new\s+Function\s*\(/, severity: "HIGH", why: "new Function() is eval-equivalent.", verify: "Trace input flow." },
    { name: "innerHTML_assignment", re: /\.innerHTML\s*=/, severity: "HIGH", why: "innerHTML with untrusted data = XSS. Use textContent or sanitize first.", verify: "Trace what gets assigned." },
    { name: "child_process_exec_concat", re: /(?:exec|execSync)\s*\([^)]*[`+]/, severity: "HIGH", why: "child_process.exec with template strings or concat = shell injection. Use execFile with array args.", verify: "Trace input flow." },
    { name: "math_random_security", re: /Math\.random\s*\(\s*\)/, severity: "LOW", why: "Math.random is NOT cryptographically secure. Use crypto.randomBytes / crypto.getRandomValues.", verify: "Check use case." },
    { name: "weak_jwt_none", re: /["']alg["']\s*:\s*["']none["']/, severity: "CRITICAL", why: "JWT alg:none accepts unsigned tokens. Always pin to HS256/RS256.", verify: "Confirm this isn't test config." },
    { name: "hardcoded_secret_js", re: /(?:apiKey|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-+/]{12,}["']/i, severity: "HIGH", why: "Hardcoded secret in source.", verify: "Verify it's not a placeholder." },
  ],
};

const ALT_MAP = {
  python: ["py -3", "python3"],
  python3: ["py -3", "python"],
  py: ["python", "python3"],
  pip: ["py -m pip", "python -m pip", "python3 -m pip"],
  pylint: ["py -m pylint", "ruff check"],
  ruff: ["py -m ruff", "pylint"],
  black: ["py -m black"],
  mypy: ["py -m mypy"],
  node: ["nodejs"],
  npm: ["pnpm", "yarn"],
  curl: ["Invoke-WebRequest", "wget"],
  wget: ["curl", "Invoke-WebRequest"],
  jq: ["python -c \"import sys,json,...\"", "PowerShell ConvertFrom-Json"],
  rg: ["grep", "Select-String"],
  grep: ["rg", "Select-String"],
  cat: ["Get-Content", "type"],
  ls: ["Get-ChildItem", "dir"],
};

async function probeAlternatives(binary, isWin) {
  const seeds = ALT_MAP[binary?.toLowerCase()] || [];
  const probeBin = isWin ? "where" : "which";
  const survivors = [];
  for (const alt of seeds) {
    const head = alt.split(/\s+/)[0];
    const r = await runChild(probeBin, [head], { timeoutMs: 5000 });
    if (r.exitCode === 0 && (r.stdout || "").trim()) {
      survivors.push(alt);
    }
  }
  return survivors;
}

function runChild(cmd, args, { stdin, cwd = ROOT, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { cwd, env: scrubbedEnv() });
    let out = "", err = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      proc.kill();
    }, timeoutMs);
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.stderr.on("data", (d) => (err += d.toString()));
    proc.on("error", (e) => {
      clearTimeout(timer);
      resolve({ stdout: "", stderr: String(e), exitCode: -1, error: String(e) });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: out.slice(-8000),
        stderr: err.slice(-2000),
        exitCode: code,
        ...(killed ? { timedOut: true } : {}),
      });
    });
    if (stdin) {
      try { proc.stdin.write(stdin); proc.stdin.end(); } catch {}
    } else {
      proc.stdin.end();
    }
  });
}

const tools = {
  read_file: {
    category: "read",
    schema: {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file from the workspace. Paths are workspace-relative.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative path inside the workspace." } },
          required: ["path"],
        },
      },
    },
    async run({ path: p }) {
      const abs = await resolveInsideWorkspaceReal(p);
      return await fs.readFile(abs, "utf8");
    },
  },

  write_file: {
    category: "write",
    schema: {
      type: "function",
      function: {
        name: "write_file",
        description: "Write a UTF-8 text file inside the workspace. Overwrites if it exists. Creates parent dirs.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Relative path inside the workspace." },
            content: { type: "string", description: "Full file content." },
          },
          required: ["path", "content"],
        },
      },
    },
    async run({ path: p, content }) {
      const abs = resolveInsideWorkspace(p);
      const normalized = maybeUnescapeOverquoted(content);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, normalized, "utf8");
      return `wrote ${Buffer.byteLength(normalized, "utf8")} bytes to ${p}`;
    },
  },

  list_dir: {
    category: "read",
    schema: {
      type: "function",
      function: {
        name: "list_dir",
        description: "List entries (name + type) in a workspace directory.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Relative directory path. '.' for root." } },
          required: ["path"],
        },
      },
    },
    async run({ path: p }) {
      const abs = await resolveInsideWorkspaceReal(p);
      const items = await fs.readdir(abs, { withFileTypes: true });
      return items.map((d) => ({ name: d.name, type: d.isDirectory() ? "dir" : "file" }));
    },
  },

  shell: {
    category: "write",
    schema: {
      type: "function",
      function: {
        name: "shell",
        description:
          "Run a shell command inside the workspace. PowerShell on Windows, sh elsewhere. 60s timeout. CWD is anchored to the workspace at the start of the command; do not cd outside it. Returns stdout+stderr+exitCode. If a command is not found, the result includes 'available_alternatives' listing what IS installed — use that and do NOT retry the same binary.",
        parameters: {
          type: "object",
          properties: { command: { type: "string", description: "Command to run." } },
          required: ["command"],
        },
      },
    },
    async run({ command }) {
      const isWin = process.platform === "win32";
      let result;
      if (isWin) {
        const wrapped = `Set-Location -LiteralPath ${JSON.stringify(ROOT)}; ${command}`;
        result = await runChild(
          "powershell.exe",
          ["-NoProfile", "-NonInteractive", "-Command", wrapped]
        );
      } else {
        const wrapped = `cd ${JSON.stringify(ROOT)} && ${command}`;
        result = await runChild("sh", ["-c", wrapped]);
      }
      const stderr = result.stderr || "";
      const notFound = /not recognized as|command not found|: not found|CommandNotFoundException/i.test(stderr);
      if (notFound) {
        const firstToken = String(command).trim().split(/\s+/)[0] || "";
        const alts = await probeAlternatives(firstToken, isWin);
        result.command_not_found = firstToken;
        if (alts.length) {
          result.available_alternatives = alts;
          result.hint = `'${firstToken}' is not installed. Available alternatives that DO work: ${alts.join(", ")}. Do NOT retry '${firstToken}' or aliases — use one of the alternatives, reason without it, or call finish().`;
        } else {
          result.hint = `'${firstToken}' is not installed and no obvious alternative was found on PATH. Do not retry — reason without it or call finish().`;
        }
      }
      return result;
    },
  },

  run_node: {
    category: "write",
    schema: {
      type: "function",
      function: {
        name: "run_node",
        description:
          "Execute a workspace-relative JavaScript file with Node. Use to TEST code you just wrote. 60s timeout. Returns stdout+stderr+exitCode.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative .js/.mjs/.cjs file to run." },
            args: { type: "array", items: { type: "string" }, description: "Optional argv to pass to the script." },
            stdin: { type: "string", description: "Optional stdin payload." },
          },
          required: ["path"],
        },
      },
    },
    async run({ path: p, args = [], stdin = "" }) {
      const abs = await resolveInsideWorkspaceReal(p);
      if (!/\.(js|mjs|cjs)$/i.test(abs)) throw new Error("run_node: path must be .js/.mjs/.cjs");
      return await runChild("node", [abs, ...args], { stdin: maybeUnescapeOverquoted(stdin) });
    },
  },

  run_python: {
    category: "write",
    schema: {
      type: "function",
      function: {
        name: "run_python",
        description:
          "Execute a workspace-relative Python file. Use to TEST Python code you just wrote. 60s timeout. Returns stdout+stderr+exitCode.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative .py file to run." },
            args: { type: "array", items: { type: "string" }, description: "Optional argv." },
            stdin: { type: "string", description: "Optional stdin payload." },
          },
          required: ["path"],
        },
      },
    },
    async run({ path: p, args = [], stdin = "" }) {
      const abs = await resolveInsideWorkspaceReal(p);
      if (!/\.py$/i.test(abs)) throw new Error("run_python: path must be .py");
      const normalizedStdin = maybeUnescapeOverquoted(stdin);
      const candidates = process.platform === "win32"
        ? [["py", ["-3", abs, ...args]], ["python", [abs, ...args]], ["python3", [abs, ...args]]]
        : [["python3", [abs, ...args]], ["python", [abs, ...args]]];
      let lastResult = null;
      for (const [bin, fullArgs] of candidates) {
        const r = await runChild(bin, fullArgs, { stdin: normalizedStdin });
        if (r.exitCode === -1 && /ENOENT/.test(r.stderr || r.error || "")) {
          lastResult = r;
          continue;
        }
        return r;
      }
      return lastResult || { stdout: "", stderr: "no python interpreter found (tried py, python, python3)", exitCode: -1 };
    },
  },

  fetch_url: {
    category: "write",
    schema: {
      type: "function",
      function: {
        name: "fetch_url",
        description:
          "HTTP GET a URL and return up to 20KB of text. Private IPs (127.x, 10.x, 192.168.x, etc.) are blocked unless the user has enabled Local net.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "Absolute URL (http/https)." } },
          required: ["url"],
        },
      },
    },
    async run({ url }, ctx) {
      return await safeFetch(url, { allowLocalFetch: !!ctx?.allowLocalFetch });
    },
  },

  remember: {
    category: "read",
    schema: {
      type: "function",
      function: {
        name: "remember",
        description:
          "Save a durable memory the model can recall in future conversations. Use for user facts, preferences, project state, lessons learned.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Short slug, e.g. 'user_name' or 'project_x_goal'." },
            value: { type: "string", description: "What to remember." },
            tags: { type: "string", description: "Comma-separated tags (optional)." },
          },
          required: ["key", "value"],
        },
      },
    },
    async run({ key, value, tags = "" }, ctx) {
      ctx.db
        .prepare(
          "INSERT INTO memories(key,value,tags,created_at) VALUES(?,?,?,?) " +
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value, tags=excluded.tags, created_at=excluded.created_at"
        )
        .run(key, value, tags, Date.now());
      return `remembered '${key}'`;
    },
  },

  recall: {
    category: "read",
    schema: {
      type: "function",
      function: {
        name: "recall",
        description: "Search memories by substring across key+value+tags. Returns up to 20 matches.",
        parameters: {
          type: "object",
          properties: { query: { type: "string", description: "Substring to look for. Empty string returns recent memories." } },
          required: ["query"],
        },
      },
    },
    async run({ query }, ctx) {
      const q = `%${query}%`;
      const rows = query
        ? ctx.db
            .prepare(
              "SELECT key,value,tags,created_at FROM memories WHERE key LIKE ? OR value LIKE ? OR tags LIKE ? ORDER BY created_at DESC LIMIT 20"
            )
            .all(q, q, q)
        : ctx.db.prepare("SELECT key,value,tags,created_at FROM memories ORDER BY created_at DESC LIMIT 20").all();
      return rows;
    },
  },

  forget: {
    category: "read",
    schema: {
      type: "function",
      function: {
        name: "forget",
        description: "Delete a memory by exact key.",
        parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
      },
    },
    async run({ key }, ctx) {
      const r = ctx.db.prepare("DELETE FROM memories WHERE key=?").run(key);
      return `deleted ${r.changes} row(s)`;
    },
  },

  audit_patterns: {
    category: "read",
    schema: {
      type: "function",
      function: {
        name: "audit_patterns",
        description:
          "Grep a workspace file for a curated list of known-dangerous patterns. Returns structured hits with line number, matched snippet, severity hint, and the attack class. Use this to seed your audit — every hit is a candidate vulnerability that you then verify by reading the surrounding code. Supports language='solidity' | 'python' | 'js'. If language is omitted, it is inferred from the file extension.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            language: { type: "string", description: "Optional. 'solidity', 'python', or 'js'." },
          },
          required: ["path"],
        },
      },
    },
    async run({ path: p, language }) {
      const abs = await resolveInsideWorkspaceReal(p);
      const text = await fs.readFile(abs, "utf8");
      const lines = text.split(/\r?\n/);
      const lang = (language || "").toLowerCase() || inferLanguage(p);
      const patterns = AUDIT_PATTERNS[lang] || [];
      const hits = [];
      for (const pat of patterns) {
        for (let i = 0; i < lines.length; i += 1) {
          if (pat.re.test(lines[i])) {
            hits.push({
              line: i + 1,
              snippet: lines[i].trim().slice(0, 200),
              pattern: pat.name,
              severity_hint: pat.severity,
              attack_class: pat.why,
              verify: pat.verify,
            });
          }
        }
      }
      return { language: lang, file: p, hit_count: hits.length, hits };
    },
  },

  finish: {
    category: "read",
    schema: {
      type: "function",
      function: {
        name: "finish",
        description: "Call this when the task is done and you want to return a final answer to the user.",
        parameters: {
          type: "object",
          properties: { summary: { type: "string", description: "Final answer or summary for the user." } },
          required: ["summary"],
        },
      },
    },
    async run({ summary }) {
      return { final: summary };
    },
  },
};

export function getToolSchemas() {
  return Object.values(tools).map((t) => t.schema);
}

export async function runTool(name, args, ctx) {
  const t = tools[name];
  if (!t) throw new Error(`unknown tool: ${name}`);
  return await t.run(args || {}, ctx);
}

export function getToolCategory(name) {
  return tools[name]?.category ?? "write";
}

export const TOOL_NAMES_BY_CATEGORY = Object.freeze({
  read: Object.entries(tools).filter(([, t]) => t.category === "read").map(([n]) => n),
  write: Object.entries(tools).filter(([, t]) => t.category === "write").map(([n]) => n),
});

export { ROOT as WORKSPACE_ROOT, PROJECT_ROOT };
