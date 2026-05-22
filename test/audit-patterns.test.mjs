import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runTool, WORKSPACE_ROOT } from "../tools.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
async function test(name, fn) {
  try { await fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const FIXTURE_NAME = "__audit_fixture.sol";
const fixturePath = path.join(WORKSPACE_ROOT, FIXTURE_NAME);
const fixture = `pragma solidity ^0.8.20;
contract Bad {
  address owner;
  function badAuth() external { require(tx.origin == owner); }
  function badPay(address to) external { payable(to).transfer(1 ether); }
  function badSig(bytes32 sig) external view returns (bool) {
    return sig == keccak256(abi.encodePacked("x"));
  }
  function badOracle() external view returns (uint) {
    (uint112 r0,,) = IUniswapV2Pair(0x0).getReserves();
    return r0;
  }
  function whenIsIt() external view returns (uint) { return block.timestamp; }
  function badTransfer(IERC20 t) external { t.transfer(msg.sender, 1); }
}
`;

const cleanFixtureName = "__audit_clean.sol";
const cleanFixturePath = path.join(WORKSPACE_ROOT, cleanFixtureName);
const cleanFixture = `pragma solidity 0.8.20;
contract Good {
  mapping(address => uint) bal;
  function deposit() external payable { bal[msg.sender] += msg.value; }
}
`;

const pyFixtureName = "__audit_fixture.py";
const pyFixturePath = path.join(WORKSPACE_ROOT, pyFixtureName);
const pyFixture = `import os
import sqlite3
def login(conn, u, p):
    return conn.execute("SELECT * FROM users WHERE u = '" + u + "'").fetchone()
def filter_expr(p):
    return eval(p)
def healthcheck(h):
    os.system("ping " + h)
API_KEY = "sk-live-abc123def456ghi789jkl"
`;

await fs.writeFile(fixturePath, fixture, "utf8");
await fs.writeFile(cleanFixturePath, cleanFixture, "utf8");
await fs.writeFile(pyFixturePath, pyFixture, "utf8");

try {
  await test("dirty Solidity: catches tx.origin", async () => {
    const r = await runTool("audit_patterns", { path: FIXTURE_NAME });
    const names = r.hits.map((h) => h.pattern);
    assert.ok(names.includes("tx_origin_auth"), `expected tx_origin_auth in ${names}`);
  });

  await test("dirty Solidity: catches .transfer 2300 gas", async () => {
    const r = await runTool("audit_patterns", { path: FIXTURE_NAME });
    assert.ok(r.hits.some((h) => h.pattern === "transfer_send_2300_gas"));
  });

  await test("dirty Solidity: catches fake keccak signature", async () => {
    const r = await runTool("audit_patterns", { path: FIXTURE_NAME });
    assert.ok(r.hits.some((h) => h.pattern === "raw_keccak_signature"));
  });

  await test("dirty Solidity: catches getReserves spot oracle", async () => {
    const r = await runTool("audit_patterns", { path: FIXTURE_NAME });
    assert.ok(r.hits.some((h) => h.pattern === "spot_oracle_get_reserves"));
  });

  await test("dirty Solidity: catches block.timestamp", async () => {
    const r = await runTool("audit_patterns", { path: FIXTURE_NAME });
    assert.ok(r.hits.some((h) => h.pattern === "block_timestamp_critical"));
  });

  await test("dirty Solidity: catches unchecked transfer return", async () => {
    const r = await runTool("audit_patterns", { path: FIXTURE_NAME });
    assert.ok(r.hits.some((h) => h.pattern === "unchecked_transfer_return"));
  });

  await test("dirty Solidity: catches floating pragma", async () => {
    const r = await runTool("audit_patterns", { path: FIXTURE_NAME });
    assert.ok(r.hits.some((h) => h.pattern === "pragma_floating"));
  });

  await test("language is auto-inferred from .sol extension", async () => {
    const r = await runTool("audit_patterns", { path: FIXTURE_NAME });
    assert.equal(r.language, "solidity");
  });

  await test("each hit has line + snippet + severity + attack_class + verify", async () => {
    const r = await runTool("audit_patterns", { path: FIXTURE_NAME });
    for (const h of r.hits) {
      assert.ok(typeof h.line === "number" && h.line > 0, `bad line: ${h.line}`);
      assert.ok(typeof h.snippet === "string" && h.snippet.length > 0);
      assert.ok(["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(h.severity_hint));
      assert.ok(typeof h.attack_class === "string" && h.attack_class.length > 10);
      assert.ok(typeof h.verify === "string");
    }
  });

  await test("clean Solidity: no false positives on common dangerous patterns", async () => {
    const r = await runTool("audit_patterns", { path: cleanFixtureName });
    const dangerous = r.hits.filter((h) =>
      ["tx_origin_auth", "raw_keccak_signature", "spot_oracle_get_reserves",
       "spot_oracle_uniswap_v3_slot0", "delegatecall_to_dynamic", "selfdestruct"].includes(h.pattern)
    );
    assert.equal(dangerous.length, 0, `unexpected: ${dangerous.map((h) => h.pattern)}`);
  });

  await test("Python: catches SQL string concat", async () => {
    const r = await runTool("audit_patterns", { path: pyFixtureName });
    assert.ok(r.hits.some((h) => h.pattern === "sql_string_concat"));
  });

  await test("Python: catches eval(input)", async () => {
    const r = await runTool("audit_patterns", { path: pyFixtureName });
    assert.ok(r.hits.some((h) => h.pattern === "eval_input"));
  });

  await test("Python: catches os.system concat", async () => {
    const r = await runTool("audit_patterns", { path: pyFixtureName });
    assert.ok(r.hits.some((h) => h.pattern === "os_system_concat"));
  });

  await test("Python: catches hardcoded API_KEY", async () => {
    const r = await runTool("audit_patterns", { path: pyFixtureName });
    assert.ok(r.hits.some((h) => h.pattern === "hardcoded_secret"));
  });

  await test("explicit language overrides extension", async () => {
    const r = await runTool("audit_patterns", { path: FIXTURE_NAME, language: "python" });
    assert.equal(r.language, "python");
  });

  await test("returns hit_count matching hits.length", async () => {
    const r = await runTool("audit_patterns", { path: FIXTURE_NAME });
    assert.equal(r.hit_count, r.hits.length);
  });
} finally {
  await fs.unlink(fixturePath).catch(() => {});
  await fs.unlink(cleanFixturePath).catch(() => {});
  await fs.unlink(pyFixturePath).catch(() => {});
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
