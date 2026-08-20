// #151. `ledger.mjs check` is the fleet's duplicate-filing guard, and #145
// rebuilt it into a real one — tracker query, `--state all`, overlap scoring,
// a warned failure mode, exit 3 on a tracker hit. The path that files most of a
// run's issues never called it: `review-and-fix.md` step 5 hand-rolled
// `gh issue list --search` and the file contained zero occurrences of "ledger".
// The measured 5x rediscovery of #114 came through that reviewer path — the
// filed row in #145's own fixture is tagged `(review-pr-108)` — so the guard
// had been improved on a path that was not the one producing duplicates.
//
// Two slices are pinned, because two different agents file issues and each
// reads only its own instructions: the reviewer/fix-applier gets step 5, and
// the finisher gets run-team's deferral-audit duty, whose "Not filed → file it"
// branch is a filing site of its own. A fix reaching only one leaves the other
// filing blind.
//
// The exit-code reading is pinned as tightly as the call itself, and for the
// opposite failure. `check` exits 0 for BOTH `clean` and `unverified`, so an
// instruction that reads exit 0 as a green light files over a tracker nobody
// read; and exit 2 is a usage error where nothing was checked at all, so an
// instruction that reads any non-zero as "duplicate" turns a deferral into a
// silent drop. Getting the guard called is half the fix; getting it read
// correctly is the other half.
//
// THE CEILING, same as fleet-tick-prose.test.mjs, issue-tracker-prose.test.mjs
// and refuter-scratch-prose.test.mjs: these are PRESENCE pins over a bounded
// slice. They prove a phrase is there and that the superseded instruction is
// not; they cannot prove a later sentence in the same slice does not carve out
// an exception. A reflow of the same words stays green by design.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dirname, "..", "..", "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");
const REVIEW_AND_FIX = readFileSync(join(REPO, "skills", "fleet", "commands", "review-and-fix.md"), "utf8");

// Bound at BOTH ends — an unbounded end lets a later, unrelated occurrence of
// the same phrase satisfy an assertion with the real clause deleted.
function between(text, from, to, what) {
  const at = text.indexOf(from);
  assert.notEqual(at, -1, `${what} no longer contains "${from}" — update this test`);
  const end = text.indexOf(to, at + from.length);
  assert.notEqual(end, -1, `${what} no longer contains "${to}" after "${from}" — update this test`);
  return text.slice(at, end);
}

// run-team's finisher duties are an indented ordered list, so a hard wrap puts
// leading spaces mid-phrase. Collapse whitespace so `\s+` spans a wrap.
const flat = (s) => s.replace(/\s+/g, " ");

// Flattened for the same reason as the run-team slices below. review-and-fix.md
// authors one long line per step today, so this is a no-op on the current file —
// but every pin here is a literal phrase with spaces in it, and the moment the
// file is wrapped, whichever pin a break happens to land inside reds on words
// that never changed. Measured at width 100: `never a dropped finding` split and
// reddened test 4 while 80/120/140 stayed green, i.e. the class is present in
// all five step-5 pins and line width merely samples which one fires.
const step5 = () => flat(between(REVIEW_AND_FIX, "5. File each deferred finding", "\n6. Diff-check green", "review-and-fix step 5"));
const finisherDeferrals = () =>
  flat(between(RUN_TEAM, "**Confirm every deferral — and every claimed APPLY —", "Add `ready-to-merge`", "run-team finisher duty 2"));

test("step 5 files through ledger.mjs check, not its own gh search", () => {
  const s = step5();
  assert.match(s, /ledger\.mjs check/, "step 5 no longer calls the duplicate-filing guard");
  // The superseded instruction, verbatim. Reverting to it is the exact
  // regression this ticket exists to close, and the new text still names
  // `gh issue list --search` (to rule it out), so only the old *phrasing*
  // can be excluded here.
  assert.doesNotMatch(
    s,
    /`gh issue list --search` first/,
    "step 5 is back to hand-rolling its own dedupe search instead of calling ledger.mjs check",
  );
  // Presence of the call is not the same as being required by it. Measured
  // GREEN on "run `ledger.mjs check` if you like" without this.
  assert.doesNotMatch(
    s,
    /ledger\.mjs check[\s\S]{0,140}?(optional|if you like|may be skipped|need not)/i,
    "step 5 turned the dedupe guard into a suggestion",
  );
});

test("step 5 tells exit 1 from exit 3 — already filed this run vs a tracker hit", () => {
  const s = step5();
  assert.match(s, /\*\*1\*\*[^.]{0,60}already filed/i, "step 5 no longer says exit 1 means already filed in this run");
  assert.match(s, /\*\*3\*\*[^.]{0,90}tracker/i, "step 5 no longer says exit 3 is a tracker hit");
});

test("step 5 refuses to read exit 0 as a green light", () => {
  // `check` exits 0 for `clean` and for `unverified` alike. An unreachable
  // `gh` degrades to a ledger-only answer that prints TRACKER NOT CHECKED, and
  // `verdict` on stdout is the only thing separating the two.
  const s = step5();
  assert.match(s, /Exit 0 is not automatically\s+"?safe to file"?/i, "step 5 no longer warns that exit 0 can mean unverified");
  assert.match(s, /`verdict`/, "step 5 no longer points at the stdout field that separates clean from unverified");
  assert.match(s, /TRACKER NOT CHECKED/, "step 5 no longer names the string an unread tracker prints");
  assert.match(s, /\bunverified\b/, "step 5 no longer names the unverified verdict by its own value");
});

test("step 5 does not let the guard turn a deferral into a drop", () => {
  // The guard's own failure directions. Exit 2 is a usage error — nothing was
  // checked, so reading it as a duplicate drops the finding; and a real
  // duplicate is a comment on the existing issue, never a dropped finding.
  const s = step5();
  assert.match(s, /\*\*2\*\*[\s\S]{0,200}?never read it as a duplicate/i, "step 5 lets a usage error read as a duplicate, dropping the finding");
  assert.match(s, /never a dropped finding/i, "step 5 no longer says a duplicate is a comment rather than a dropped deferral");
});

test("step 5 cites a Run ledger section that exists in run-team", () => {
  // Step 5 defers the full exit-code and `verdict` semantics rather than
  // restating them — a cross-file citation that rots silently if the section
  // is renamed, since neither file's prose fails on its own.
  assert.match(step5(), /\*\*Run ledger\*\*/, "step 5 no longer defers the exit-code semantics to run-team's Run ledger section");
  assert.match(RUN_TEAM, /^## Run ledger$/m, "run-team no longer has a `## Run ledger` section for step 5 to cite");
  // And that section has to still carry what step 5 sends a reader there for.
  // Flattened like the sibling below: the slice is hard-wrapped Markdown, so an
  // un-flattened match reds on a pure reflow — the one thing the header at the
  // top of this file promises stays green.
  const runLedger = flat(between(RUN_TEAM, "## Run ledger", "\n## Report", "run-team Run ledger section"));
  assert.match(runLedger, /`verdict` is `already-filed`, `tracker-hit`, `clean` or `unverified`/, "the cited section no longer enumerates the verdict values");
});

test("step 5's exit-code readings agree with the section it cites", () => {
  // Step 5 cites run-team for the full semantics but states the reading of each
  // code inline, because the agent acting on it is mid-filing and a second file
  // read is a cost it will skip. Two copies of a number→meaning mapping drift,
  // and neither file fails on its own when they do: each stays internally
  // coherent while an agent reading one acts on the other's contract. So the
  // numbers are pinned on BOTH sides — renumbering in either file alone reddens
  // the suite, which is the only signal the split produces. One test per side,
  // though, and this is not the one holding step 5: it reads RUN_TEAM only, and
  // the step-5 side is pinned by "step 5 tells exit 1 from exit 3" above.
  // Measured: `exit **3**` → `exit **4**` in review-and-fix.md alone reds that
  // test and leaves this one green; the same edit in run-team alone inverts it.
  const runLedger = flat(between(RUN_TEAM, "## Run ledger", "\n## Report", "run-team Run ledger section"));
  assert.match(runLedger, /\*\*1\*\* already in this run's filed list/, "run-team no longer reads exit 1 as already filed this run — step 5 still does");
  assert.match(runLedger, /\*\*2\*\* usage\s+error/, "run-team no longer reads exit 2 as a usage error — step 5 still does");
  assert.match(runLedger, /\*\*3\*\* the ledger is clean but open or closed tracker issues match/, "run-team no longer reads exit 3 as a tracker hit — step 5 still does");
  // The exit-0 hazard is the one both files must state, not merely agree on:
  // it is the code that reads as permission.
  assert.match(runLedger, /Exit 0 is not\s+automatically "safe to file"/, "the cited section no longer warns that exit 0 can mean unverified");
});

test("the finisher verifies a claimed APPLY against the branch diff, not the applier's word", () => {
  // Duty 2 audits deferrals AND applies. The review ran against a snapshot cut
  // before the fix-applier's edits existed, so nothing but the finisher ever
  // checks that a claimed APPLY actually landed — measured once at five applies
  // where the controller's hand-written list named three.
  //
  // ONE bounded span, not two presence pins: a pin on the claim sentence alone
  // stays green with the verification command deleted, and a pin on the command
  // alone stays green with the duty reworded into a suggestion. Bounded rather
  // than exact so a reflow of the sentence between them survives, which is the
  // ceiling this whole file already accepts.
  assert.match(
    finisherDeferrals(),
    /\*\*A fix-applier's "applied" is a claim like any other\*\*.{0,200}?Confirm `git diff origin\/main\.\.\.HEAD` actually contains what it reported applying\./,
    "duty 2 no longer requires the finisher to verify a claimed APPLY against the branch diff — an applier's \"applied\" becomes self-certifying and a dropped fix ships labelled",
  );
});

test("the finisher files its own deferrals through the same guard", () => {
  // The finisher reaches `gh issue create` by a different route — auditing the
  // reviewer's deferrals and filing whatever is missing — so it is precisely
  // the agent most likely to re-file what a reviewer already filed.
  assert.match(finisherDeferrals(), /ledger\.mjs check/, "the finisher's file-it branch no longer runs the dedupe guard");
});
