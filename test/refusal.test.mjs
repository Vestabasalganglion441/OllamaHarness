import assert from "node:assert/strict";
import { looksLikeRefusal, stripThinkingTags } from "../src/refusal.js";

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass += 1; console.log(`  ok  ${name}`); }
  catch (e) { fail += 1; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

test("classic 'I can't help with that'", () => {
  assert.ok(looksLikeRefusal("I can't help with that request."));
});

test("'as an AI' phrasing", () => {
  assert.ok(looksLikeRefusal("As an AI language model, I cannot generate that content."));
});

test("'against my guidelines'", () => {
  assert.ok(looksLikeRefusal("That goes against my guidelines."));
});

test("'I'm sorry, but'", () => {
  assert.ok(looksLikeRefusal("I'm sorry, but I can't comply with this request."));
});

test("technical answer is NOT a refusal", () => {
  assert.equal(looksLikeRefusal("Here's the function: function fib(n) { return n < 2 ? n : fib(n-1) + fib(n-2); }"), false);
});

test("empty string not a refusal", () => {
  assert.equal(looksLikeRefusal(""), false);
  assert.equal(looksLikeRefusal(null), false);
  assert.equal(looksLikeRefusal(undefined), false);
});

test("'I won't write that'", () => {
  assert.ok(looksLikeRefusal("I won't write that for you."));
});

test("code that happens to contain the word 'sorry' is not a refusal", () => {
  assert.equal(looksLikeRefusal("console.log('sorry, file not found');"), false);
});

test("stripThinkingTags removes <think> blocks", () => {
  const input = "<think>let me reason about this</think>The answer is 42.";
  assert.equal(stripThinkingTags(input), "The answer is 42.");
});

test("stripThinkingTags handles multiline thinking", () => {
  const input = "<think>\nfirst line\nsecond line\n</think>\nFinal output.";
  assert.equal(stripThinkingTags(input), "Final output.");
});

test("stripThinkingTags handles multiple blocks", () => {
  const input = "<think>a</think>middle<think>b</think>end";
  assert.equal(stripThinkingTags(input), "middleend");
});

test("stripThinkingTags passes through text without tags", () => {
  assert.equal(stripThinkingTags("plain text"), "plain text");
});

test("stripThinkingTags handles empty/null", () => {
  assert.equal(stripThinkingTags(""), "");
  assert.equal(stripThinkingTags(null), null);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
