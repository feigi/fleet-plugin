import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeModel, parseMemberName, readMember } from "./member-outcomes.mjs";

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
  assert.deepEqual(parseMemberName("finish-pr-601"), { ticket: "", pr: "601" });
  assert.deepEqual(parseMemberName("finisher-532"), { ticket: "", pr: "532" });
  assert.deepEqual(parseMemberName("finish-567"), { ticket: "", pr: "567" });
});

test("merge-bot's number is a WAVE, so it is neither ticket nor pr", () => {
  // merge-bot-12 is the twelfth wave, not PR 12. Booking it as a pr would join
  // this row to an unrelated PR's verdict row.
  assert.deepEqual(parseMemberName("merge-bot-12"), { ticket: "", pr: "" });
});

test("a retry suffix does not change what the name identifies", () => {
  // run-team spawns `impl-<N>-b` when a member is re-dispatched.
  assert.deepEqual(parseMemberName("impl-580-b"), { ticket: "580", pr: "" });
  assert.deepEqual(parseMemberName("finisher-pr-903-c"), { ticket: "", pr: "903" });
});

test("an unrecognised name yields blanks, never a guess", () => {
  assert.deepEqual(parseMemberName("size candidate 7"), { ticket: "", pr: "" });
  assert.deepEqual(parseMemberName(""), { ticket: "", pr: "" });
});

const line = (o) => JSON.stringify(o);
const assistant = (model, effort, usage = {}) => line({
  type: "assistant", isSidechain: true, effort,
  timestamp: "2026-08-25T07:14:12.147Z",
  message: { model, usage: { cache_creation_input_tokens: 0, output_tokens: 0, ...usage } },
});
const meta = (o = {}) => ({ agentType: "impl-580", description: "Implement ticket 580", name: "impl-580", spawnDepth: 0, ...o });

test("model and effort come off the transcript, not the meta", () => {
  // meta.json never records effort, and records model only when the dispatch
  // supplied one — a frontmatter-resolved member has no `model` key at all.
  // The transcript is the only source that answers both.
  const row = readMember([
    assistant("claude-opus-5", "xhigh"),
    assistant("claude-opus-5", "xhigh"),
  ].join("\n"), meta());
  assert.equal(row.model, "claude-opus-5");
  assert.equal(row.effort, "xhigh");
  assert.equal(row.errored, "no");
});

test("usage sums across turns", () => {
  const row = readMember([
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 100, output_tokens: 7 }),
    assistant("claude-opus-5", "xhigh", { cache_creation_input_tokens: 250, output_tokens: 3 }),
  ].join("\n"), meta());
  assert.equal(row.tokensCacheCreate, 350);
  assert.equal(row.tokensOut, 10);
  assert.equal(row.turns, 2);
});

test("a torn final line is skipped, not fatal", () => {
  // A transcript can be read while it is still being written.
  const row = readMember(
    assistant("claude-opus-5", "xhigh", { output_tokens: 5 }) + '\n{"type":"assis',
    meta(),
  );
  assert.equal(row.tokensOut, 5);
  assert.equal(row.turns, 1);
});

test("errored keys on the LAST line being torn, not on how many turns there were", () => {
  // Distinct timestamps on purpose: the replaced rule keyed on
  // firstTs === lastTs and would answer "no" to BOTH cases here, so this is
  // the assertion that actually discriminates the two rules.
  const at = (ts) => line({
    type: "assistant", isSidechain: true, effort: "xhigh", timestamp: ts,
    message: { model: "claude-opus-5", usage: { cache_creation_input_tokens: 0, output_tokens: 0 } },
  });

  const endsTorn = readMember(
    [at("2026-08-25T07:14:12.147Z"), at("2026-08-25T07:15:00.000Z"), '{"type":"assis'].join("\n"),
    meta(),
  );
  assert.equal(endsTorn.errored, "yes");

  // A torn line in the MIDDLE is a hiccup, not a stall: the next good line
  // resets it.
  const recovers = readMember(
    [at("2026-08-25T07:14:12.147Z"), '{"type":"assis', at("2026-08-25T07:15:00.000Z")].join("\n"),
    meta(),
  );
  assert.equal(recovers.errored, "no");
});

test("a member with no effort field records blank, not a default", () => {
  // haiku carries no effort control at all. Defaulting to the session's value
  // would assert something never measured.
  const row = readMember(assistant("claude-haiku-4-5-20251001", undefined), meta());
  assert.equal(row.effort, "");
});

test("a transcript whose only model is <synthetic> yields no row", () => {
  assert.equal(readMember(assistant("<synthetic>", "xhigh"), meta()), null);
});

test("mixed models record the LAST — a mid-run switch is the tier it finished at", () => {
  const row = readMember([
    assistant("claude-opus-5", "xhigh"),
    assistant("claude-sonnet-5", "xhigh"),
  ].join("\n"), meta());
  assert.equal(row.model, "claude-sonnet-5");
});
