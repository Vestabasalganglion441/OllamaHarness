import assert from "node:assert/strict";
import {
  toolCallFingerprint,
  detectLoop,
  isTripleLoop,
  rescueJsonToolCalls,
} from "../src/tool-rescue.js";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

test("fingerprint stable for identical calls", () => {
  const a = { function: { name: "read_file", arguments: { path: "a.txt" } } };
  const b = { function: { name: "read_file", arguments: { path: "a.txt" } } };
  assert.equal(toolCallFingerprint(a), toolCallFingerprint(b));
});

test("fingerprint differs for different args", () => {
  const a = { function: { name: "read_file", arguments: { path: "a.txt" } } };
  const b = { function: { name: "read_file", arguments: { path: "b.txt" } } };
  assert.notEqual(toolCallFingerprint(a), toolCallFingerprint(b));
});

test("fingerprint parses stringified arguments", () => {
  const a = { function: { name: "shell", arguments: { command: "ls" } } };
  const b = { function: { name: "shell", arguments: '{"command":"ls"}' } };
  assert.equal(toolCallFingerprint(a), toolCallFingerprint(b));
});

test("detectLoop: identical fingerprints = exact", () => {
  const fp = "read_file::{\"path\":\"a\"}";
  const loop = detectLoop([fp, fp]);
  assert.ok(loop);
  assert.equal(loop.kind, "exact");
});

test("detectLoop: different tool names = no loop", () => {
  const a = "read_file::{\"path\":\"a\"}";
  const b = "write_file::{\"path\":\"a\"}";
  assert.equal(detectLoop([a, b]), null);
});

test("detectLoop: shell with same leading binary = loop", () => {
  const a = "shell::{\"command\":\"python --version\"}";
  const b = "shell::{\"command\":\"python -m pip list\"}";
  const loop = detectLoop([a, b]);
  assert.ok(loop);
  assert.equal(loop.kind, "shell_same_binary");
  assert.equal(loop.binary, "python");
});

test("detectLoop: shell with different leading binary = no loop", () => {
  const a = "shell::{\"command\":\"python --version\"}";
  const b = "shell::{\"command\":\"ls\"}";
  assert.equal(detectLoop([a, b]), null);
});

test("isTripleLoop: 3 different calls = no loop", () => {
  const hist = ["a::{}", "b::{}", "c::{}"];
  assert.equal(isTripleLoop(hist), null);
});

test("isTripleLoop: 3 identical calls = loop", () => {
  const fp = "read_file::{\"path\":\"a\"}";
  const loop = isTripleLoop([fp, fp, fp]);
  assert.ok(loop);
});

test("isTripleLoop: 3 shell calls with same binary = loop", () => {
  const hist = [
    "shell::{\"command\":\"python a\"}",
    "shell::{\"command\":\"python b\"}",
    "shell::{\"command\":\"python c\"}",
  ];
  const loop = isTripleLoop(hist);
  assert.ok(loop);
  assert.equal(loop.kind, "shell_same_binary");
});

test("isTripleLoop: under 3 history items = null", () => {
  assert.equal(isTripleLoop(["a"]), null);
  assert.equal(isTripleLoop(["a", "b"]), null);
});

test("rescue: fenced JSON tool call recovered", () => {
  const content = '```json\n{"name":"write_file","arguments":{"path":"x","content":"y"}}\n```';
  const r = rescueJsonToolCalls(content, new Set(["write_file"]));
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, "write_file");
  assert.deepEqual(r.toolCalls[0].function.arguments, { path: "x", content: "y" });
});

test("rescue: bare JSON object tool call recovered", () => {
  const content = '{"name":"read_file","arguments":{"path":"a"}}';
  const r = rescueJsonToolCalls(content, new Set(["read_file"]));
  assert.equal(r.toolCalls.length, 1);
  assert.equal(r.toolCalls[0].function.name, "read_file");
});

test("rescue: unknown tool name ignored", () => {
  const content = '```json\n{"name":"unknown_tool","arguments":{}}\n```';
  const r = rescueJsonToolCalls(content, new Set(["read_file", "write_file"]));
  assert.equal(r.toolCalls.length, 0);
});

test("rescue: non-JSON content returns empty", () => {
  const r = rescueJsonToolCalls("just some prose with no JSON", new Set(["read_file"]));
  assert.equal(r.toolCalls.length, 0);
  assert.equal(r.remaining, "just some prose with no JSON");
});

test("rescue: multiple fenced blocks all recovered", () => {
  const content = '```json\n{"name":"read_file","arguments":{"path":"a"}}\n```\nthen\n```json\n{"name":"read_file","arguments":{"path":"b"}}\n```';
  const r = rescueJsonToolCalls(content, new Set(["read_file"]));
  assert.equal(r.toolCalls.length, 2);
});

test("rescue: 'parameters' key alias works", () => {
  const content = '```json\n{"name":"shell","parameters":{"command":"ls"}}\n```';
  const r = rescueJsonToolCalls(content, new Set(["shell"]));
  assert.equal(r.toolCalls.length, 1);
  assert.deepEqual(r.toolCalls[0].function.arguments, { command: "ls" });
});

test("rescue: empty content returns empty", () => {
  const r = rescueJsonToolCalls("", new Set(["read_file"]));
  assert.equal(r.toolCalls.length, 0);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
