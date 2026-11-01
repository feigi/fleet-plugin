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
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { memberPrompt } from "./support/render-brief.mjs";
import { EVENT_HEADER } from "./support/fleet-event-header.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const REVIEW_AND_FIX = Pin.file(join(REPO, "commands", "review-and-fix.md"));

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
const step5 = () => flat(REVIEW_AND_FIX.between("5. File each deferred finding", "\n6. Diff-check green", "review-and-fix step 5").text);
// Duty 2 and the report are stated in the finisher's agent body, which the
// harness injects as its system prompt; run-team's SKILL.md no longer restates them.
const finisherBody = () => Pin.of(memberPrompt("finisher", "fresh"), "the finisher's member prompt");
const finisherDeferrals = () =>
  flat(finisherBody().between("**Confirm every deferral — and every claimed APPLY —", "**Duty 3 is one script", "finisher duty 2").text);
// Duty 2's own paragraph — the file-it branch — moved, with its war story, to
// references/finisher.md; the finisher's agent body states the rule.
const FINISHER_MD = Pin.file(join(REPO, "skills", "run-team", "references", "finisher.md"));
const finisherFileIt = () =>
  flat(FINISHER_MD.section("## Duty 2: every deferral, and every claimed APPLY, has a home that outlives the merge", "references/finisher.md duty 2").text);
// check's exit codes and verdicts live in references/ledger.md, which step 5 and
// the wake section point at; the checkExits section below is what these tests read.
const LEDGER_MD = Pin.file(join(REPO, "skills", "run-team", "references", "ledger.md"));
const checkExits = () => flat(LEDGER_MD.section("## `check`'s exits and its `verdict`", "references/ledger.md check section").text);

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

test("step 5 cites references/ledger.md, and the section it cites enumerates the verdicts", () => {
  // Step 5 defers the full exit-code and `verdict` semantics rather than
  // restating them — a cross-file citation that rots silently if the file or
  // its section is renamed, since neither file's prose fails on its own.
  assert.match(step5(), /references\/ledger\.md/, "step 5 no longer defers the exit-code semantics to references/ledger.md");
  assert.match(checkExits(), /`verdict` is `already-filed`, `tracker-hit`, `clean`, `soft-hit` or `unverified`/, "the cited section no longer enumerates the verdict values");
});

test("step 5's exit-code readings agree with the section it cites", () => {
  // Step 5 cites run-team for the full semantics but states the reading of each
  // code inline, because the agent acting on it is mid-filing and a second file
  // read is a cost it will skip. Two copies of a number→meaning mapping drift,
  // and neither file fails on its own when they do: each stays internally
  // coherent while an agent reading one acts on the other's contract. So the
  // numbers are pinned on BOTH sides — renumbering in either file alone reddens
  // the suite, which is the only signal the split produces. One test per side,
  // though, and this is not the one holding step 5: it reads references/ledger.md only, and
  // the step-5 side is pinned by "step 5 tells exit 1 from exit 3" above.
  // Measured: `exit **3**` → `exit **4**` in review-and-fix.md alone reds that
  // test and leaves this one green; the same edit in run-team alone inverts it.
  const exits = checkExits();
  assert.match(exits, /\*\*1\*\* already in this run's filed list/, "ledger.md no longer reads exit 1 as already filed this run — step 5 still does");
  assert.match(exits, /\*\*2\*\* usage\s+error/, "ledger.md no longer reads exit 2 as a usage error — step 5 still does");
  assert.match(exits, /\*\*3\*\* the ledger is clean but open or closed tracker issues match/, "ledger.md no longer reads exit 3 as a tracker hit — step 5 still does");
  // The exit-0 hazard is the one both files must state, not merely agree on:
  // it is the code that reads as permission.
  assert.match(checkExits(), /Exit 0 is not\s+automatically "safe to file"/, "the cited section no longer warns that exit 0 can mean unverified");
});

test("both filing sites read soft-hit as rows to read rather than as permission", () => {
  // `soft-hit` exits 0, which is the code an instruction is most likely to read
  // as a green light — the same hazard `unverified` carries and the same reason
  // it is pinned above. A verdict no caller understands is worse than the wrong
  // verdict it replaced (#388), and there are two callers because two different
  // agents file issues and each reads only its own instructions.
  assert.match(step5(), /`soft-hit`[\s\S]{0,400}?read the rows/i, "step 5 names soft-hit without telling its reader to read the rows it printed");
  assert.match(checkExits(), /`soft-hit`[\s\S]{0,400}?read\s+them before filing/i, "the cited section names soft-hit without saying what to do about it");
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
    /\*\*A fix-applier's "applied" is a claim like any other\*\*.{0,200}?Confirm `git diff origin\/main\.\.\.<your dispatch pin>` actually contains what it reported applying\./,
    "duty 2 no longer requires the finisher to verify a claimed APPLY against the branch diff — an applier's \"applied\" becomes self-certifying and a dropped fix ships labelled",
  );
  // The owned worktree's HEAD may differ from the pin and hold nothing the pin
  // lacks, so a diff taken there is a diff of a head no reviewer was shown.
  assert.doesNotMatch(
    finisherDeferrals(),
    /git diff origin\/main\.\.\.HEAD/,
    "duty 2 diffs the owned worktree's HEAD again — that head may differ from the dispatch pin, and the diff is then not the reviewed one",
  );
});

test("the finisher files its own deferrals through the same guard", () => {
  // The finisher reaches `gh issue create` by a different route — auditing the
  // reviewer's deferrals and filing whatever is missing — so it is precisely
  // the agent most likely to re-file what a reviewer already filed.
  assert.match(finisherFileIt(), /ledger\.mjs check/, "the finisher's file-it branch no longer runs the dedupe guard");
});

// ── Filers record what they file (#531) ──────────────────────────────────────
//
// `check`'s ledger arm — exit 1, `already-filed`, and the near-miss rows behind
// `soft-hit` — reads a `## Filed` list, and until #531 no filing site wrote to
// it: both sites ran `check` and then `gh issue create`, and the controller,
// which owned every ledger write, never files. So the arm had never held a row.
// The fix is the filer recording its own filing, under a ledger lock that lets
// a second kind of writer exist; these pin the instruction half of it.
const finisherReport = () =>
  flat(finisherBody().between("Report to the controller in the report file your brief names", "Then send the one line your brief gives", "finisher report line").text);
// The fix-applier's report line is in its agent body, which the member reads
// with the brief the renderer prints; SKILL.md carries no copy of it.
const fixApplierReport = () =>
  flat(Pin.of(memberPrompt("fix-applier", "review"), "the fix-applier's member prompt").between("Then write your report to the file your brief names", "**Deferring everything", "fix-applier report line").text);

test("both filing sites run `ledger.mjs filed` right after `gh issue create`, under the subject they checked", () => {
  // The subject is half of it: `check` matches the filed list by the words in
  // the subject, so a filing recorded under different words is one the next
  // `check` for the same finding can only score as a near miss, never exit 1.
  const s = step5();
  assert.match(s, /immediately after each `gh issue create`, run `[^`]*ledger\.mjs filed <N> "<subject>"`/, "step 5 no longer records the issue it just created");
  assert.match(s, /the same subject string you passed to `check`/, "step 5 no longer ties the recorded subject to the one it checked");
  const f = finisherFileIt();
  assert.match(f, /`ledger\.mjs filed <N> "<subject>"` immediately after `gh issue create`/, "the finisher's file-it branch no longer records the issue it created");
  assert.match(f, /the same subject string you passed to `check`/, "the finisher no longer ties the recorded subject to the one it checked");
});

test("a failed `filed` is retried once, then reported unrecorded — never a second issue", () => {
  // The issue exists and is correct once `gh issue create` returned; only its
  // ledger row is missing. Re-filing to "fix" that makes the duplicate the
  // whole guard exists to stop.
  for (const [where, s] of [["step 5", step5()], ["finisher duty 2", finisherFileIt()]]) {
    assert.match(s, /retry (it )?once/, `${where} no longer retries a failed \`filed\``);
    assert.match(s, /leave the issue alone — it exists and is correct/, `${where} no longer says to leave a created issue alone`);
    assert.match(s, /`unrecorded: #N <subject>`/, `${where} no longer reports a filing it could not record`);
  }
});

test("both report contracts carry the issues filed and the `unrecorded` fallback", () => {
  assert.match(fixApplierReport(), /`filed` for every issue step 5 created, and `unrecorded` for one whose `ledger\.mjs filed` failed twice/,
    "fix-applier report no longer carries the filed issues and the unrecorded fallback");
  assert.match(finisherReport(), /`filed` for every issue duty 2 created, and `unrecorded` for one whose `filed` failed twice/,
    "finisher report no longer carries the filed issues and the unrecorded fallback");
  assert.match(step5(), /`filed: #N <subject>`/, "step 5 no longer returns the issues it filed");
});

test("the controller records every filing a filer reported unrecorded", () => {
  // The fallback is only a fallback if someone acts on it: an `unrecorded`
  // entry nobody turns into a `filed` row leaves the arm exactly as blind as
  // before, one filing at a time. The entry is in the member's report file,
  // and `settle --from-report` records it, which `fleet-event.mjs`'s fix-report
  // and finisher-report kinds run; a finisher settled by hand past an exit 3
  // has its entries recorded by hand, which the script's header says.
  assert.match(EVENT_HEADER, Pin.phrase("fix-report <fix-pr-M[-x]> `settle --from-report`, which records the filings and rulings the report carries."));
  assert.match(EVENT_HEADER, Pin.phrase("finisher-report <finisher-pr-M[-x]> `settle --from-report`."));
  assert.match(EVENT_HEADER, Pin.phrase("settle it `ledger.mjs settle finisher-pr-<M>=labelled` as reported, and `ledger.mjs filed <N> \"<subject>\"` for each `unrecorded` entry"),
    "the finisher settled by hand past its exit 3 no longer has its unrecorded filings recorded");
});

test("references/ledger.md states the writer policy and the check→create gap", () => {
  const writer = flat(LEDGER_MD.section("## Writer policy: every write is serialized by `<file>.lock`", "references/ledger.md writer policy").text);
  assert.match(
    writer,
    /the controller owns run state \(`row`\/`token`\/`settle`\/`dispatch`\/`review`\/`drain`\/`ruled`\); filers append filings with `filed`; all writes are serialized by `<file>\.lock`/,
    "references/ledger.md no longer states who writes what, and that the lock serializes it",
  );
  // The lock covers each command alone. Step 5 cites this file for the gap, so
  // the gap is pinned at the section that states it.
  const gap = flat(LEDGER_MD.section("## The gap the lock does not close", "references/ledger.md gap section").text);
  assert.match(gap, /`check` → `gh issue create` → `filed` is three commands/, "references/ledger.md no longer states the check→create gap");
  assert.match(gap, /both read `clean`/, "references/ledger.md no longer says what the gap lets through");
});
