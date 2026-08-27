import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModel, parseMemberName } from "./member-outcomes.mjs";

test("a versioned model id is kept verbatim", () => {
  assert.equal(normalizeModel("claude-opus-5"), "claude-opus-5");
  assert.equal(normalizeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5-20251001");
});

test("the [1m] context variant is stripped — it is the same model", () => {
  // impl-580.meta.json records "claude-opus-5[1m]" while its own messages say
  // "claude-opus-5". Two spellings of one model would split every count.
  assert.equal(normalizeModel("claude-opus-5[1m]"), "claude-opus-5");
});

test("a bare alias stays bare — it cannot be resolved to a version", () => {
  // Guessing a version here would invent data. `opus` is honestly less precise
  // than `claude-opus-5`, and a read-out can group on the family prefix.
  assert.equal(normalizeModel("opus"), "opus");
  assert.equal(normalizeModel("sonnet"), "sonnet");
});

test("<synthetic> is dropped, not mapped — it is not a model", () => {
  assert.equal(normalizeModel("<synthetic>"), null);
});

test("empty and absent are dropped", () => {
  assert.equal(normalizeModel(""), null);
  assert.equal(normalizeModel(undefined), null);
});

test("impl-<n> names a TICKET, not a PR", () => {
  assert.deepEqual(parseMemberName("impl-580"), { ticket: "580", pr: "" });
});

test("every pr-shaped member name yields a PR and no ticket", () => {
  assert.deepEqual(parseMemberName("fix-pr-662"), { ticket: "", pr: "662" });
  assert.deepEqual(parseMemberName("review-pr-555"), { ticket: "", pr: "555" });
  assert.deepEqual(parseMemberName("finisher-pr-904"), { ticket: "", pr: "904" });
});

test("merge-bot's number is a WAVE, so it is neither ticket nor pr", () => {
  // merge-bot-12 is the twelfth wave, not PR 12. Booking it as a pr would join
  // this row to an unrelated PR's verdict row.
  assert.deepEqual(parseMemberName("merge-bot-12"), { ticket: "", pr: "" });
});

test("a retry suffix does not change what the name identifies", () => {
  // run-team spawns `impl-<N>-b` when a member is re-dispatched.
  assert.deepEqual(parseMemberName("impl-580-b"), { ticket: "580", pr: "" });
});

test("an unrecognised name yields blanks, never a guess", () => {
  assert.deepEqual(parseMemberName("size candidate 7"), { ticket: "", pr: "" });
  assert.deepEqual(parseMemberName(""), { ticket: "", pr: "" });
});
