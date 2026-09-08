// #493. Every guard protecting `ready-to-merge` sits UPSTREAM of the label —
// the finisher's dispatch pin, the halt on a moved head, the worktree audit all
// run before the label exists. Downstream the label is unconditional: measured
// on PR #426, a finisher audited a head and labelled it, a fix-applier then
// surfaced a defect, the controller approved a fix, and the label sat on a
// commit nobody had audited with nothing left to go stale. #180 is the
// confirmed half of the mechanism — a GitHub label does not follow the branch.
//
// The ruled fix is that the merge bot re-derives the head, as a REQUIREMENT
// rather than bot discretion. It already held in practice — the wave bots that
// merged #1090 and #1091 both re-derived every gate at the merge instant — but
// it held because their dispatch prompts said so, which is precisely what this
// file exists to stop being the only reason.
//
// THE CEILING: these are presence pins on prose. They prove the rules are
// stated where their reader reaches them; they cannot prove a merge bot obeys
// them, and nothing here runs `gh`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const DOC = readFileSync(join(REPO, "commands", "run-merge-bot.md"), "utf8");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// Bounded at both ends. Unbounded to EOF, `ready-to-merge`, `head` and
// `finisher` each occur freely through the per-PR sequence and the watcher
// loop, so every assertion below would survive deletion of the section itself.
const labelledHead = () =>
  between(DOC, "## The labelled head", "## Per-PR sequence", "run-merge-bot.md");

// Step 3 is where the merge-instant re-check already lives (label, review
// decision), so the head leg has to be IN it — not in a later paragraph a
// reader reaches the merge without having read.
const step3 = () =>
  between(DOC, "3. Green → re-check immediately before merging", "4. `gh pr merge <pr> --merge`", "run-merge-bot.md");

test("the head re-derivation is stated as a requirement, not left to bot discretion", () => {
  assert.match(labelledHead(), phrase("re-deriving the head is a requirement here, not bot discretion"));
});

test("the labelled head names why no upstream guard covers this window", () => {
  // Without the reason this reads as a redundant fourth check and gets deleted
  // as one. The two facts it rests on: the label does not move with the branch,
  // and every other guard runs before the label exists.
  assert.match(labelledHead(), phrase("A GitHub label does not follow the branch"));
  assert.match(
    labelledHead(),
    phrase("runs *before* the label exists, so none of them is watching this window"),
  );
});

test("the timeline read is the mechanism, keyed on the three events that move a head", () => {
  const s = labelledHead();
  assert.match(s, /issues\/<pr>\/timeline\?per_page=100/);
  assert.match(s, /\.event == "labeled" and \.label\.name == "ready-to-merge"/);
  assert.match(s, /\.event == "committed" or \.event == "head_ref_force_pushed"/);
});

test("the read's ordering constraint rides in the same sentence as its reason", () => {
  // The whole rule is WHEN. `gh pr update-branch` lands commits dated after the
  // label by construction — measured on this repo: #1090 (never rebased) lists
  // `labeled ready-to-merge` after its commits, #1091 (rebased by its merge
  // bot) lists three `committed` plus a `head_ref_force_pushed` after the
  // label. So a read taken post-rebase cannot tell the bot's own commits from a
  // member's. One contiguous span, so splitting the constraint away from the
  // command it governs reds this.
  assert.match(
    labelledHead(),
    phrase("Read the timeline before `gh pr update-branch` and before anything else that can move the head"),
  );
  assert.match(
    labelledHead(),
    phrase("once you have rebased this read can no longer tell your commits from someone else's"),
  );
});

// The decision rule itself — WHICH SIDE of the label line a commit has to fall
// on. Everything above pins that the query is present and that a refusal
// follows; nothing pinned the predicate between them. Measured on the commit
// BEFORE this one: inverting `after` to `BEFORE` left this file 14/14 green,
// and deleting the sentence outright left 36/36 green across both prose
// suites. Inverted, the doc tells the bot to refuse the ordinary wave PR and
// to merge #180's shape — the head this ticket exists to stop.
//
// One contiguous span through `**Refuse:`, not two matches: N separate matches
// pin N facts and never the text between them. Verified as-of-commit on three
// mutants and two controls — the two above red, so does splicing `unless the
// commits are plausibly your own predecessor's, in which case proceed` between
// the predicate and its verdict (the informative one: every pinned token
// survives it and only the binding flips), while re-wrapping the same wording
// across three lines and rewording the unpinned sentence above both stay
// green. `phrase`, not a raw regex, is what makes that rewrap green.
test("a commit AFTER the last label line is what the refusal keys on", () => {
  assert.match(
    labelledHead(),
    phrase(
      "A `committed` or `head_ref_force_pushed` line after the last `labeled ready-to-merge` means the head moved after the audit. **Refuse:",
    ),
  );
});

test("the refusal names its token, leaves the label alone, and sends a fresh finisher", () => {
  const s = labelledHead();
  assert.match(s, phrase("report `head-moved-after-label-#<pr>` and stop on that PR"));
  assert.match(s, phrase("Leave the label where it is"));
  assert.match(s, phrase("the first audit does not transfer, because it verified a different tree"));
});

// AC-4, the ACCEPT side. A bot that refuses whenever the labelled SHA is not
// the current head must not refuse the ordinary wave PR. Pinned as one span
// with its verdict, because a bare "this is the normal case" with the outcome
// deleted is what leaves a reader guessing.
test("the normal path — label applied, head unchanged — is stated as proceeding untouched", () => {
  assert.match(
    labelledHead(),
    phrase(
      "Nothing after that label line is the normal case, and it proceeds untouched** — label applied, head unchanged, merge goes ahead exactly as it did before this gate existed",
    ),
  );
});

// Step 3's comparison has an operand, and this section is the only place that
// captures it. Step 1's `pre` exists only where step 1 runs, so a PR already
// current has none — the instruction has to stand on its own read, and it has
// to say the read happens BEFORE the rebase or it captures the wrong SHA.
test("the pre-rebase head is recorded here, since step 3 compares against it and nothing rebuilds it", () => {
  const s = labelledHead();
  assert.match(s, phrase("Record the head before you rebase"));
  // `phrase`, not a raw regex: this command sits in prose, not in a fenced
  // block, so a hard-wrap can put a newline between any two of its words.
  // Measured — the raw form reddened on a same-wording rewrap of the section.
  assert.match(s, phrase("gh pr view <pr> --json headRefOid -q .headRefOid"));
  assert.match(s, phrase("on an already-current PR it is simply the head you merge"));
});

// The other ACCEPT-side half: the two things the gate deliberately does NOT
// answer. A hand-added label reads clean here (run-team owns reviewer-only),
// and a head rebased by an abandoned earlier pass refuses on purpose rather
// than as a false positive. Both are the sentences a later reader would delete
// as hedging, and deleting either turns a stated limit into a silent one.
test("the gate declares what it does not cover, and which refusal is intended", () => {
  const s = labelledHead();
  assert.match(s, phrase("a hand-added `ready-to-merge` with no finisher behind it reads clean here"));
  assert.match(s, phrase("earlier, abandoned pass of this command** refuses too"));
});

test("step 3 re-derives the head at the merge instant, against pre or the rebase's post", () => {
  const s = step3();
  assert.match(s, phrase("Re-derive the head here too, not only the label"));
  assert.match(
    s,
    phrase("must equal the `pre` you recorded at **The labelled head**, or the `post` your own step-1 rebase produced"),
  );
});

test("step 3 says why no CI gate above it can see a push that landed during the wait", () => {
  // The reason is the load-bearing half: `ci-state.mjs` selects the run whose
  // headSha equals the CURRENT PR head (`r.headSha === prHead`), so a member's
  // push plus its own green run clears step 2 outright. Without this sentence
  // the head comparison looks like a duplicate of the CI binding and gets cut.
  const s = step3();
  assert.match(s, phrase("no CI gate above can see it"));
  assert.match(s, phrase("`r.headSha === prHead` filter"));
});

// #493 AC-3, and the reason it reaches into run-team: the merge bot's refusal
// stops a bad merge but costs a wave. The cheap half is upstream — the
// controller not dispatching a finisher into a window a member is about to
// move. Sliced to the finisher-dispatch paragraph; `question`, `outbox` and
// `dispatch` all recur through a 2000+ line file.
const dispatchGate = () =>
  between(
    RUN_TEAM,
    "**finisher** — a fresh small agent, not the fix-applier resumed.",
    "**A final report is not proof the member stopped.**",
    "run-team/SKILL.md",
  );

test("an unanswered member question blocks finisher dispatch, with the same weight as an owed ruling", () => {
  const s = dispatchGate();
  assert.match(
    s,
    phrase(
      "An unanswered question from the member is an outbox item, and it blocks dispatch with the same weight as a ruling you have already made",
    ),
  );
  // WHY it does not feel like one is what stops it being read as a restatement
  // of the owed-ruling rule directly above and deleted as duplication.
  assert.match(s, phrase("you have decided nothing yet, so the outbox reads empty"));
  // Both exits, or "answer it" reads as a mandate to rule on everything.
  assert.match(s, phrase("tell the member you are not ruling and it should proceed on its own default"));
});

// The recovery the ticket asks to keep in the runbook, at the moment it
// applies: the label is already on and the controller is about to approve a
// push. Sliced to that paragraph — `ready-to-merge` and `finisher` are
// everywhere in this file.
const labelRecovery = () =>
  between(
    RUN_TEAM,
    "**Once the label is on, take it off before you approve any push.**",
    "A halt at step 1 has exactly two causes,",
    "run-team/SKILL.md",
  );

test("the recovery removes the label before approving, and says why messaging the bot is not the stop", () => {
  const s = labelRecovery();
  assert.match(s, phrase("removing the artifact the merge bot gates on is the reliable stop"));
  assert.match(s, phrase("a label has been observed holding until after an abort message arrived"));
  assert.match(s, phrase("dispatch a **fresh** finisher against the new head"));
});

// Cross-file, same hazard #447 recorded: run-team's failure table is the
// controller's index of merge-bot outcomes, so a token that exists only in
// run-merge-bot.md leaves the controller with a report it cannot place.
const failureTable = () =>
  between(RUN_TEAM, "## Failure handling", "A red PR never silently becomes", "run-team/SKILL.md");

test("the failure table carries the head-moved outcome and its response", () => {
  const s = failureTable();
  assert.match(s, phrase("Merge bot finds the head moved after `ready-to-merge` was applied"));
  assert.match(s, phrase("`head-moved-after-label-#<pr>`, PR stays queued, label untouched"));
});

test("the report vocabulary includes head-moved-after-label", () => {
  // Bounded to the Report line itself: the token survives elsewhere in the doc,
  // so a whole-file match would mask its removal from the vocabulary list.
  assert.match(DOC, /^Report merged [^\n]*head-moved-after-label-#X/m);
});
