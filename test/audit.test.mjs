import assert from "node:assert/strict";
import { detectSolidityAuditIntent } from "../src/audit.js";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

test("'.sol' mention triggers", () => {
  assert.ok(detectSolidityAuditIntent("audit Vault.sol"));
});

test("'solidity' mention triggers", () => {
  assert.ok(detectSolidityAuditIntent("review this solidity contract"));
});

test("'audit' + 'contract' triggers", () => {
  assert.ok(detectSolidityAuditIntent("audit this contract for vulnerabilities"));
});

test("'find vulnerabilities' + 'ERC20' triggers", () => {
  assert.ok(detectSolidityAuditIntent("find vulnerabilities in this ERC20 token"));
});

test("'exploit' + 'defi' triggers", () => {
  assert.ok(detectSolidityAuditIntent("can this defi protocol be exploited?"));
});

test("generic 'audit' alone does NOT trigger (no domain word)", () => {
  assert.equal(detectSolidityAuditIntent("audit the python file"), false);
});

test("generic 'security' alone does NOT trigger", () => {
  assert.equal(detectSolidityAuditIntent("any security tips for my flask app?"), false);
});

test("normal coding task does NOT trigger", () => {
  assert.equal(detectSolidityAuditIntent("write fib in javascript"), false);
});

test("empty / null message safe", () => {
  assert.equal(detectSolidityAuditIntent(""), false);
  assert.equal(detectSolidityAuditIntent(null), false);
  assert.equal(detectSolidityAuditIntent(undefined), false);
});

test("'find bug' + 'smart contract' triggers", () => {
  assert.ok(detectSolidityAuditIntent("find a bug in this smart contract"));
});

test("case insensitive", () => {
  assert.ok(detectSolidityAuditIntent("AUDIT MyContract.SOL please"));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
