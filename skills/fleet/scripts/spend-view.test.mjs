import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// `board.html` is served as ONE self-contained file — board.mjs stages it with a
// single copyFileSync and createBoardServer routes only `/`, `/board.html` and
// `/board.json` — so its script is inline and there is nothing to import. The
// decision under test is lifted out of the SOURCE TEXT and evaluated instead,
// the same technique select-dimensions.test.mjs uses against workflows/review-pr.js.
//
// Extraction to a module is deliberately NOT the shape here: it would need a
// second staged file and a fourth route, and a page that renders blank whenever
// the staging of that second file fails. Coupling to the literal spelling is the
// cheaper risk, because it breaks loudly, here.
const HTML = readFileSync(join(import.meta.dirname, "board.html"), "utf8");

// A lift reads a COPY. Three guards below keep that copy tied to the page: this
// one, so a second declaration cannot shadow the lifted one at runtime (a
// duplicate placed AFTER the real declaration wins by hoisting and is otherwise
// invisible to every lift); the call-site pin, so the page still routes through
// what is pinned; and the parse check, so the script the browser gets is valid.
for (const [name, re] of [
  ["spendView", /^function\s+spendView\s*\(/gm],
  ["k", /^const k = /gm],
]) {
  test(`board.html declares ${name} exactly once at top level`, () => {
    assert.equal(HTML.match(re)?.length, 1,
      `${name} must be declared exactly once — a second top-level declaration wins at runtime and the lift below would still read the first`);
  });
}

// Slice to renderSpend's own body before matching, and drop comment lines: a
// whole-file assert.match is satisfied by any mention anywhere, including a
// commented-out one.
// Parameter names are matched as `\w+` throughout, never as the literal `sp`.
// Renaming a parameter is not a defect, and a lift that misses because of one
// throws where node registers no test at all — the file's whole total drops in
// silence rather than reporting a named failure.
const renderSpend = HTML.match(/^function renderSpend\((\w+)\) \{[\s\S]*?^\}$/m);
const renderSpendBody = renderSpend
  ? renderSpend[0].split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n")
  : "";

test("renderSpend routes through spendView rather than re-deriving the branch", () => {
  assert.ok(renderSpend, "board.html no longer declares renderSpend as a top-level function — update this test");
  // Without this the whole decision can be disconnected in one token and every
  // case below still passes, against a function the page never calls.
  // The call, not the name it is bound to — a renamed local is not a defect.
  assert.match(renderSpendBody, /=\s*spendView\(\w+\);/);
  // The tri-state must not be re-tested in the renderer; that is what the split
  // removed. The decision's own fields may be read freely; the raw argument
  // reaches exactly one place, the spendView call, and nowhere else. Matching
  // `if (…)` shapes instead pins one spelling of a re-derivation: a pattern
  // anchored on the argument being followed by `.` or `)` is evaded by
  // `if (sp && sp.error)`, by `if (sp?.error)`, and by `const { error } = sp`.
  const bodySansCall = renderSpendBody
    .replace(/^function renderSpend\(\w+\) \{/m, "")
    .replace(/=\s*spendView\(\w+\);/, "");
  assert.doesNotMatch(bodySansCall, new RegExp(`\\b${renderSpend[1]}\\b`));
});

// The test above pins that the decision is REACHED; these pin that each field
// lands in its own slot. Without them the panel can be miswired one token at a
// time and every case below still passes, because those only ever look at what
// spendView RETURNS: drop the hidden branch and a `kind:"hidden"` decision
// appends an empty `spend-wrap` every tick at run start — the #371 behaviour
// itself, a box where the panel must render nothing — or swap the two column
// lists, or the two header strings, and nothing goes red.
for (const [claim, re] of [
  ["the hidden decision appends nothing", /if \(\w+\.kind === "hidden"\) return;/],
  ["a text-only decision reaches the DOM", /el\("div", "spend-wrap", \w+\.text\)/],
  ["the lede string fills the lede slot", /el\("span", "lede", \w+\.lede\)/],
  ["the note string fills the note slot", /el\("span", "note", \w+\.note\)/],
  ["the tool heading fills the tool heading", /el\("h3", null, \w+\.toolHeading\)/],
  ["the role column is fed the role list", /spendRows\(\w+, \w+\.roles,/],
  ["the tool column is fed the tool list", /spendRows\(\w+, \w+\.tools,/],
]) {
  test(`renderSpend wires the decision through: ${claim}`, () => {
    assert.match(renderSpendBody, re);
  });
}

test("board.html's inline script parses", () => {
  // An extraction is a restructure of this file's script; a broken one would not
  // fail any other test in the suite, it would blank the page at runtime.
  const m = HTML.match(/<script>\n([\s\S]*?)\n<\/script>/);
  assert.ok(m, "board.html no longer carries its renderer in a bare inline <script> — update this test");
  assert.doesNotThrow(() => new Function(`return function(){${m[1]}}`));
});

// `spendView` closes over `k`, a module-level const declared above it, so the
// lift takes both. Left out, `k` is a ReferenceError rather than a wrong answer —
// it fails loud rather than pinning a stale result.
const K_SRC = HTML.match(/^const k = .*;$/m);
const VIEW_SRC = HTML.match(/^function spendView\(\w+\) \{[\s\S]*?^\}$/m);

test("board.html still declares k and spendView in the shape this file lifts", () => {
  // Named, and outside the lift itself: asserting inside it throws before node
  // registers anything, which drops the file's total to zero and reports one
  // file-level error instead of telling you which claim stopped holding.
  assert.ok(K_SRC, "board.html no longer declares `k` as a one-line top-level const — update this test");
  assert.ok(VIEW_SRC, "board.html no longer declares spendView as a top-level function — update this test");
});

const spendView = K_SRC && VIEW_SRC
  ? new Function(`${K_SRC[0]}\n${VIEW_SRC[0]}\nreturn spendView;`)()
  : () => { throw new Error("spendView could not be lifted from board.html — see the shape test above"); };

// A run whose transcripts all read fine. Fields are the ones gatherSpend returns.
const ok = (o = {}) => ({
  totals: { cacheWrite: 2_000_000, cacheRead: 500_000, output: 12_000, agents: 4 },
  roles: [{ role: "reviewer", agents: 2, cacheWrite: 1_500_000, pct: 75 }],
  tools: [{ tool: "Bash", calls: 9, cacheWrite: 400_000, pct: 40 }],
  reviewPct: 75,
  attributedPct: 60,
  skipped: 0,
  ...o,
});

test("no spend yet hides the panel", () => {
  // Normal at run start: gatherSpend returns null when there is no transcript
  // dir to read and nothing was skipped.
  assert.deepEqual(spendView(null), { kind: "hidden" });
  assert.deepEqual(spendView(undefined), { kind: "hidden" });
});

test("an error is shown, never hidden", () => {
  // The operator has to act on this one, and stderr is not a channel: the board
  // is launched backgrounded and the operator is watching the page.
  assert.deepEqual(spendView({ error: "no transcript dir for cwd /x" }),
    { kind: "error", text: "spend unavailable: no transcript dir for cwd /x" });
});

test("a success object with no cache-write but a non-zero skipped count reports the skip, not nothing (#371)", () => {
  // THE REGRESSION THIS FILE EXISTS FOR. renderSpend used to return early on a
  // falsy cacheWrite and swallow `skipped` with it, so a run whose transcripts
  // were unreadable rendered identically to a run that had not started. The fix
  // shipped with nothing to pin it.
  assert.deepEqual(spendView(ok({ totals: { cacheWrite: 0, cacheRead: 0, output: 0, agents: 0 }, skipped: 3 })),
    { kind: "note", text: "3 transcripts skipped; no spend recorded yet" });
  // Same conflation one step earlier: totals absent entirely rather than zeroed.
  assert.deepEqual(spendView({ skipped: 1 }),
    { kind: "note", text: "1 transcripts skipped; no spend recorded yet" });
});

test("no cache-write and nothing skipped is the one legitimate hide", () => {
  // Zeroes would read as "this run was free", a worse lie than absence. With no
  // skipped count there is nothing to report, so absence is correct here.
  assert.deepEqual(spendView(ok({ totals: { cacheWrite: 0, cacheRead: 0, output: 0, agents: 0 }, skipped: 0 })),
    { kind: "hidden" });
});

test("a funded run renders the panel, with both headline strings", () => {
  const v = spendView(ok());
  assert.equal(v.kind, "panel");
  assert.equal(v.lede, "2.0M cache-write · 500k cache-read · 12k output · 4 agents · review 75%");
  assert.equal(v.note, "ranked on cache-creation; tool split is attributed, not billed");
  assert.equal(v.toolHeading, "by tool — 60% of cache-write attributed");
  assert.deepEqual(v.roles, [{ role: "reviewer", agents: 2, cacheWrite: 1_500_000, pct: 75 }]);
  assert.deepEqual(v.tools, [{ tool: "Bash", calls: 9, cacheWrite: 400_000, pct: 40 }]);
});

test("a funded run still carries its skipped count into the panel note", () => {
  // The skip does not stop mattering once there is spend to show: the count is
  // live every tick, and the note is the only place it reaches the operator.
  assert.equal(spendView(ok({ skipped: 2 })).note,
    "2 transcripts skipped; ranked on cache-creation; tool split is attributed, not billed");
});

test("a fully unattributed run says 0%, and only an absent figure falls back", () => {
  // The guard is `!= null`, not truthiness: 0% attributed is a real measurement
  // and reads differently from "this build does not compute one".
  assert.equal(spendView(ok({ attributedPct: 0 })).toolHeading, "by tool — 0% of cache-write attributed");
  assert.equal(spendView(ok({ attributedPct: null })).toolHeading, "by tool");
});

test("the tool column is capped and both columns tolerate a missing list", () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ tool: `t${i}`, calls: 1, cacheWrite: 1, pct: 1 }));
  assert.equal(spendView(ok({ tools: many })).tools.length, 8);
  const bare = spendView(ok({ roles: undefined, tools: undefined }));
  assert.deepEqual(bare.roles, []);
  assert.deepEqual(bare.tools, []);
});

test("an error with an empty message is currently routed to success and hidden — enumerated, not fixed (#371)", () => {
  // A contract/code divergence, measured here rather than a claim about live
  // traffic: gatherSpend's outer catch returns `{ error: e.message }`, and
  // e.message is "" for any error thrown without one, so the contract admits the
  // shape. The discriminant is truthiness, so `{ error: "" }` misses the error
  // branch, finds no totals, and hides — the same "a bug looks like an idle run"
  // conflation the error branch exists to remove. Whether any producer actually
  // throws a message-less error into that catch is not established here.
  // NOT changed here: #371 rules the contract reshape out of
  // scope and requires rendering to be unchanged. This pins today's routing so
  // the follow-up flips one assertion instead of discovering the case again.
  assert.deepEqual(spendView({ error: "" }), { kind: "hidden" });
});
