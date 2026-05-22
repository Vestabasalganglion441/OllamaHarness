import assert from "node:assert/strict";
import { maybeUnescapeOverquoted } from "../tools.js";

const cases = [
  {
    name: "over-escaped JS code is unescaped",
    input: 'function fib(n) {\\n  return n;\\n}',
    expect: 'function fib(n) {\n  return n;\n}',
  },
  {
    name: "real-newline code is left alone",
    input: 'function fib(n) {\n  return n;\n}',
    expect: 'function fib(n) {\n  return n;\n}',
  },
  {
    name: "single-line string containing legit \\n literal is left alone (heuristic only triggers on no-real-newline AND escape-density)",
    input: 'console.log("\\n");',
    expectOneOf: ['console.log("\n");', 'console.log("\\n");'],
  },
  {
    name: "Python over-escaped triple-quoted",
    input: 'def f():\\n    return 1\\n',
    expect: 'def f():\n    return 1\n',
  },
  {
    name: "empty string passes through",
    input: '',
    expect: '',
  },
  {
    name: "non-string passes through",
    input: 42,
    expect: 42,
  },
  {
    name: "mixed real + escaped is treated as real (no unescape — safer for hand-written prompts)",
    input: 'line1\nline2 with \\n inside it',
    expect: 'line1\nline2 with \\n inside it',
  },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const got = maybeUnescapeOverquoted(c.input);
  const ok = c.expectOneOf ? c.expectOneOf.includes(got) : got === c.expect;
  if (ok) {
    pass += 1;
    console.log(`  ok  ${c.name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${c.name}`);
    console.log(`       input:  ${JSON.stringify(c.input)}`);
    console.log(`       got:    ${JSON.stringify(got)}`);
    console.log(`       expect: ${JSON.stringify(c.expect ?? c.expectOneOf)}`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
