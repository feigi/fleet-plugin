// #407. PR #404 gave `candidates.mjs` a third exit code and touched no document
// outside the script. Every consumer-facing statement of the contract still
// named two, so a model consumer meeting exit 3 had no rule for it and the
// nearest rule it did have was "2 = the query broke" — the likeliest reading of
// a successful all-specs query was a failed one.
//
// The condition these pins describe is derived from the script, not from the
// ticket's paraphrase: `allFilteredOut = rawCount > 0 && rows.length === 0`
// (candidates.mjs's `allFilteredOut`), reassigned WHOLESALE in the fallback
// branch and never OR'd with pass 1's value, then `rows.length === 0 ?
// (allFilteredOut ? 3 : 1) : 0` at that script's `process.exitCode`
// assignment. So exit 3 is "the FINAL query attempt returned rows and
// dropSpecs removed every one" — a labeled pass the filter emptied that falls
// back to a genuinely empty unfiltered pass is exit 1, which candidates.test.mjs
// pins from the other side.
//
// THE CEILING, same as inflight-exit2-prose.test.mjs: these are PRESENCE pins
// over a bounded slice. Text spliced INSIDE a pinned phrase reddens them; a
// whole new sentence appended after one, carving out an exception, does not.
// A reflow (line wraps, `**bold**` moved) stays green by design. The
// declared-code scan carries a second ceiling of its own, explained in the
// comment above `scriptHeader` and implemented at `codesIn`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, logicalLines, phrase, stripSlashGutter } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const read = (...p) => readFileSync(join(REPO, ...p), "utf8");
const NEXT_TICKET = read("skills", "next-ticket", "SKILL.md");
const RUN_TEAM = read("skills", "run-team", "SKILL.md");
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SPEC = readFileSync(join(REPO_ROOT, "docs", "specs", "2026-07-23-fleet-plugin-design.md"), "utf8");

const candidatesStep = () =>
  between(NEXT_TICKET, "## 1. Candidates", "## 2. Dependencies", "next-ticket/SKILL.md");

test("next-ticket's exit-code line tells exit 3 from the empty queue and from the broken query", () => {
  const s = candidatesStep();
  assert.match(s, phrase("Exit 1 = query fine, queue empty"));
  assert.match(s, phrase("Exit 3 = query fine, rows came back and the to-spec filter took every one"));
  assert.match(s, phrase("Exit 2 = query broke"));
});

test("next-ticket sends exit 3 to to-tickets rather than reading it as no work", () => {
  // The distinction the code exists to make: this caller's own invocation
  // reaches exit 3, so "empty" here would send it to the wrong conclusion.
  assert.match(candidatesStep(), phrase("run to-tickets rather than reading it as no work"));
});

test("next-ticket scopes exit 3 to the final pass, so it agrees with the fallback trigger", () => {
  // `--allow-fallback` is this caller's prescribed invocation, so the
  // final-pass rule is not a footnote here — it decides whether exit 3 or
  // exit 1 comes back, and a reader who misses it connects exit 3 to the
  // "counts as empty" sentence above and concludes the two disagree.
  const s = candidatesStep();
  assert.match(s, phrase("Exit 3 judges the LAST pass alone"));
  assert.match(s, phrase("falls back to a genuinely empty one is exit 1"));
});

// The same slice candidates.test.mjs bounds for the `--require-label` rule —
// `1. **Build the Shortlist**` to the step after it. A match anywhere in phase 0 is
// vacuous: phase 0 discusses `inflight.sh`'s exit 2 at length a few steps down,
// so a file-wide search for "exit" finds another script's contract and reports
// this one as documented.
const scanStep = () =>
  between(RUN_TEAM, "1. **Build the Shortlist**", "\n2. ", "run-team/SKILL.md");

test("phase 0 denies that exit 3 is the empty queue", () => {
  const s = scanStep();
  assert.match(s, phrase("Exit 3 is not that empty queue"));
  assert.match(s, phrase("the to-spec filter took every one"));
});

test("phase 0 forbids answering exit 3 by widening the net", () => {
  // The hazard this rule exists to close, and the one a careless wording
  // opens: exit 3 proves there ARE labeled items, which reads as evidence the
  // filter is too tight. It is not — the items are specs, and the fallback
  // pass is unfiltered, so widening reaches `ready-for-human` and untriaged
  // work an unattended run still has no channel to a human for.
  const s = scanStep();
  assert.match(s, phrase("never a reason to widen the net"));
  assert.match(s, phrase("still do not pass `--allow-fallback`"));
});

test("phase 0 names what exit 3's queue actually holds, so the run reports it rather than claiming no work", () => {
  const s = scanStep();
  assert.match(s, phrase("to-tickets' input rather than claimable tickets"));
  assert.match(s, phrase("Log it as specs awaiting to-tickets"));
});

// --- The script-surface contract table, and the preamble that scopes it.
const scriptSurface = () =>
  between(SPEC, "## Script surface", "| Script | In | Out |", "the fleet-plugin design spec");

const candidatesRow = () => {
  const line = SPEC.split("\n").find((l) => l.startsWith("| `candidates.mjs` |"));
  assert.ok(line, "the design spec's script-surface table no longer has a `candidates.mjs` row — update this test");
  return line;
};

test("the spec's candidates row stops reading an all-specs queue as exit 1", () => {
  const row = candidatesRow();
  // The clause as it stood absorbed the exit-3 case: "no candidate survived"
  // is true of a queue the filter emptied, which is exit 3. Narrowing it is
  // the correction — appending exit 3 while leaving this would ship two
  // clauses in one cell that contradict each other.
  assert.doesNotMatch(row, phrase("no candidate survived"));
  assert.match(row, phrase("no row came back at all"));
  assert.match(row, phrase("the to-spec filter removed every one"));
});

test("the spec's preamble states the further-code property instead of naming one carrier", () => {
  // Naming `ledger.mjs check` as THE script with an extra code made the
  // preamble false by omission the moment a second script minted one. A
  // property carries no carrier list to go stale and no tally to rot.
  const s = scriptSurface();
  assert.doesNotMatch(s, phrase("`ledger.mjs check` mints one further code"));
  assert.match(s, phrase("Where a script needs a verdict those meanings cannot carry, it mints a further code and states it in its own row"));
});

// Derived from the script's own contract rather than restating it: this is the
// check that would have caught #407 the day PR #404 landed. Add a code to the
// header in the `N = ` form every code there uses today, and each carrier the
// coverage test reads reddens until it names the code too.
//
// THE SCAN'S CEILING: `N = ` is the only spelling it reads. Declare a code in
// the same contract block as `exit 4 — ...` and this scan does not see it, so
// the coverage test stays green over a code no document names — measured, next
// to a `4 = ` control that reddens. Widening the scan to any digit next to `=`
// or an em-dash was measured too: it does catch that spelling, and it also
// mints a code out of ordinary header prose, so a bare `(#7 — see there)`
// reddens the coverage test over a code nobody declared. What holds this up
// is the contract's own wording — declare a new code `N = `, or teach this
// scan the spelling you chose.
//
// Guarded at each step and called from a test body, never run at module scope:
// an unguarded index here fails at IMPORT, taking the unrelated tests in this
// file down with it and naming nothing as the thing to look at.
//
// #1619: `codesIn` runs the header through `stripSlashGutter` then
// `logicalLines` before this regex ever sees it — same fix shape as #1609's
// `pointer-target-prose.test.mjs`. `\b(\d) = ` is a single inter-word space
// on each side, and a raw physical-line scan turns that space into a
// newline the instant a reflow wraps the header between the digit and `=`,
// or between `=` and the word after it. Measured against the scan this
// replaced, reflowing this exact header with not one word changed: at 27
// columns both 1 and 3 drop from the derived list, at 33 columns 2 drops
// alone, at 56 columns 3 drops alone — in every case with the coverage
// assertion below still PASSING, because a code this scan never finds is a
// code that loop never checks. Worse than #1609's own symptom: that one
// reddened loudly; this one stays green over a real coverage gap.
function scriptHeader() {
  const src = read("scripts", "candidates.mjs");
  return src.slice(0, src.indexOf("\nimport "));
}

// `codesIn` is a pure extractor: it runs on the real header (via
// `declaredNonZeroCodes`, below) AND on synthetic reflow/fixture text the
// tests below construct by hand. Its three "update this test" guards only
// make sense against the FIRST source — fired against a fixture, they would
// blame `candidates.mjs` for a break the fixture (or this file's own
// transform pipeline) introduced. `scanCodes` does the shared computation;
// only `declaredNonZeroCodes` — the one caller reading the real file — turns
// a bad scan into an "update this test" guard.
function scanCodes(headerText) {
  const prose = logicalLines(stripSlashGutter(headerText)).text;
  const at = prose.indexOf("Exit-code contract");
  const codes = at === -1 ? [] : [...prose.slice(at).matchAll(/\b(\d) = /g)].map((m) => m[1]);
  const nonZero = [...new Set(codes)].filter((c) => c !== "0");
  return { at, codes, nonZero };
}

function codesIn(headerText) {
  return scanCodes(headerText).nonZero;
}

function declaredNonZeroCodes() {
  const { at, codes, nonZero } = scanCodes(scriptHeader());
  assert.notEqual(at, -1, "candidates.mjs' header no longer states an `Exit-code contract` — update this test");
  assert.ok(codes.includes("0"), "candidates.mjs' exit-code contract no longer declares 0 — update this test");
  assert.ok(nonZero.length > 0, "candidates.mjs' exit-code contract declares no non-zero code — update this test");
  return nonZero;
}

test("every non-zero code the script declares is named by the documents a consumer reads", () => {
  // run-team/SKILL.md's candidate scan step is deliberately NOT a carrier here.
  // It carries a rule for exit 3 alone — the exit that sends an all-specs queue
  // to to-tickets — and names neither exit 1 nor exit 2, reading an empty queue
  // as no work in prose instead. This loop asserts every declared code is named
  // by every carrier it reads, so listing that step reddens on exit 1 (measured).
  // Leaving it out is a decision, not an oversight.
  for (const [what, text] of [
    ["next-ticket/SKILL.md's candidate step", candidatesStep()],
    ["the design spec's candidates row", candidatesRow()],
  ]) {
    for (const code of declaredNonZeroCodes()) {
      assert.match(
        text,
        new RegExp(`exit ${code}\\b`, "i"),
        `${what} does not name exit ${code}, which candidates.mjs' own exit-code contract declares`,
      );
    }
  }
});

// #1619, the pin the test above could not carry. It reads the header as
// checked in — one physical line per sentence — so it never notices that
// `codesIn`'s regex is `\n`-hostile by necessity. Same convention as
// `pointer-target-prose.test.mjs`'s #1609 reflow pin: reflowed HERE, never
// committed as a fixture, because a checked-in rewrapped copy rots away from
// `candidates.mjs`'s real header the moment one changes and not the other.
const reflow = (text, cols) => {
  const out = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^ {0,3}(?:```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || line.length <= cols || /(?:[ \t]{2}|\\)$/.test(line)) {
      out.push(line);
      continue;
    }
    const lead = line.match(/^[ \t]*/)[0];
    const indent = " ".repeat(line.match(/^(?:[ \t]*(?:[-*+]|\d+[.)])[ \t]+|[ \t]*)/)[0].length);
    const words = line.slice(lead.length).split(" ").filter(Boolean);
    let cur = lead + (words.shift() ?? "");
    for (const word of words) {
      if (`${cur} ${word}`.length > cols) {
        out.push(cur);
        cur = indent + word;
      } else cur = `${cur} ${word}`;
    }
    out.push(cur);
  }
  return out.join("\n");
};

// Three widths, each measured against `candidates.mjs`'s real header to lose
// a DIFFERENT code under the physical-line scan this file replaced: 27 drops
// both 1 and 3, 33 drops 2 alone, 56 drops 3 alone. One width alone measures
// one accident of where the breaks landed.
//
// LIVENESS: `assert.deepEqual` below only proves `codesIn` survives the
// rewrap — nothing here proves the rewrap still SPLITS a `N = ` pair. A
// future reword of the header's exit-code sentence could stop wrapping
// mid-pair at all three widths and every assertion below would still pass,
// pinning nothing. `oldStyleCodesIn` is the physical-line-only scan this
// file replaced (no gutter strip, no join); asserting its result is a
// STRICT subset of the full declared set is the same measurement the
// comment above states in prose, turned into a check that reddens the day
// it stops holding.
const oldStyleCodesIn = (headerText) => {
  const at = headerText.indexOf("Exit-code contract");
  const codes = at === -1 ? [] : [...headerText.slice(at).matchAll(/\b(\d) = /g)].map((m) => m[1]);
  return [...new Set(codes)].filter((c) => c !== "0");
};

for (const cols of [27, 33, 56]) {
  test(`a pure reflow of candidates.mjs' header at ${cols} columns changes no declared exit code`, () => {
    const before = scriptHeader();
    const rewrapped = reflow(before, cols);
    assert.notEqual(rewrapped, before, `reflow at ${cols} columns changed nothing — this pin is not exercising a rewrap`);
    assert.equal(
      rewrapped.replace(/\s+/g, " ").trim(),
      before.replace(/\s+/g, " ").trim(),
      "the reflow fixture changed the header's words, so the comparison below would prove nothing",
    );
    const declared = declaredNonZeroCodes();
    const stale = oldStyleCodesIn(rewrapped);
    assert.ok(
      stale.length < declared.length && stale.every((c) => declared.includes(c)),
      `reflowing at ${cols} columns no longer splits any \`N = \` pair onto two physical lines (the old scan still finds every code) — this pin is vacuous at this width and no longer exercises the hazard \`logicalLines\` exists to survive.`,
    );
    assert.deepEqual(
      codesIn(rewrapped),
      declared,
      `rewrapping candidates.mjs' header at ${cols} columns changes which non-zero exit codes this file finds — the scan is reading physical lines again, so an author who reflows the header silently drops coverage for whichever code the wrap split, with the guard above still passing.`,
    );
  });
}

// #1619's OTHER half. The fix is TWO steps — stripSlashGutter THEN
// logicalLines — but the three pins above only ever exercise logicalLines:
// this file's `reflow` helper never reprints a `// ` gutter on a line it
// wraps, so at every width tested (27/33/56, and every width from 20 to 80,
// measured) the header's own line breaks never land a continuation line's
// leading `// ` between a digit and its `= `. Dropping stripSlashGutter
// alone — `codesIn` calling `logicalLines(headerText).text` straight,
// keeping logicalLines — passes every test above unchanged (measured: 12/12
// green). A real rewrap of a `//` comment block DOES reprint the gutter on
// each new line, and this fixture is built to land the break exactly where
// that matters: the authored line ends on a bare `3`, and the next line
// opens with `// = `, so a scan that joins lines without first stripping
// that gutter inserts `// ` between the code and its `= `, right where
// `codesIn`'s regex needs one plain space.
test("codesIn still finds a code whose comment-line break falls right before its `= `", () => {
  const fixture = [
    "// Exit-code contract: 0 = ok, 1 = degraded, 2 = broken, 3",
    "// = every row removed by the filter.",
  ].join("\n");
  assert.deepEqual(codesIn(fixture), ["1", "2", "3"]);
});
