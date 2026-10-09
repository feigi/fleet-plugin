// #493. Every guard protecting `ready-to-merge` sits UPSTREAM of the label —
// the finisher's dispatch pin, the halt on a moved head, the worktree audit all
// run before the label exists. Downstream the label is unconditional: measured
// on PR #426, a finisher audited a head and labelled it, a fix-applier then
// surfaced a defect, the controller approved a fix, and the label sat on a
// commit nobody had audited with nothing left to go stale. #180 is the
// confirmed half of the mechanism — a GitHub label does not follow the branch.
//
// The ruled fix is that the merge bot re-derives the head, as a REQUIREMENT
// rather than bot discretion. It already held in practice — the merge bots that
// merged #1090 and #1091 both re-derived every gate at the merge instant — but
// it held because their dispatch prompts said so, which is precisely what this
// file exists to stop being the only reason.
//
// THE CEILING: these are presence pins on prose. They prove the rules are
// stated where their reader reaches them; they cannot prove a merge bot obeys
// them, and nothing here runs `gh`. The record filter is the one exception
// below: it runs the fenced block's `-q` program through `jq`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { between, phrase } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const DOC = readFileSync(join(REPO, "commands", "run-merge-bot.md"), "utf8");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
const REVIEW_AND_FIX = readFileSync(join(REPO, "commands", "review-and-fix.md"), "utf8");

// The record filter goes through jq. Without it every filter case would fail
// with a spawn error, which reads as a real red but proves nothing.
try {
  execFileSync("jq", ["--version"], { stdio: "ignore" });
} catch {
  throw new Error("jq is required to run the record filter; install it before running this suite");
}

// Bounded at both ends. Unbounded to EOF, `ready-to-merge`, `head` and
// `finisher` each occur freely through the per-PR sequence and the watcher
// loop, so every assertion below would survive deletion of the section itself.
// The end anchor is the NEXT heading — `## Per-PR sequence` again since #1806
// retired the gate-proof section #966 had put between them.
const labelledHead = () =>
  between(DOC, "## The labelled head", "## Per-PR sequence", "run-merge-bot.md");

// Step 3 is the merge gate, run twice, so the head leg has to be IN it — not
// in a later paragraph a reader reaches the merge without having read.
const step3 = () =>
  between(DOC, "3. **Gate the merge with `merge-gate.mjs`", "4. `gh pr merge <pr> --merge`", "run-merge-bot.md");

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

// #2945: the labelled head is the head its labeller RECORDED. Before it, the
// bot derived it from the timeline — the `beforeCommit` of the first
// force-push, refused when one of its commits carried a committer date after
// the label. A committer date is when the commit was made, not when it was
// pushed, so a commit made before the label, pushed after it and force-pushed
// over passed that guard and the rebase was carried as an audit that never
// covered it. The record is the only reading of the audited head, so the bot
// reads it first, before anything can move the head.
test("the labelled head is the labeller's recorded head, read first, before anything can move the head", () => {
  const s = labelledHead();
  assert.match(s, phrase("**The labelled head is the head its labeller recorded.**"));
  assert.match(s, phrase("posts a PR comment whose whole body is `ready-to-merge-head: <sha>`, naming the head it audited, immediately before the label"));
  assert.match(s, phrase("Read the newest one before `gh pr update-branch` and before anything else that can move the head"));
});

// Why no timeline read can stand in for the record — the reason a later reader
// needs before restoring the committer-date guard as a "cheaper" derivation.
test("the record is stated as the only reading, with why commit dates cannot replace it", () => {
  assert.match(
    labelledHead(),
    phrase("A commit's dates are when it was made, not when it was pushed, so a commit made before the label and pushed after it carries no date after the label"),
  );
});

// The retired derivation must not survive beside the record: two answers to
// "which head was labelled" is the drift this section exists to prevent.
test("the committer-date guard and the beforeCommit derivation are gone", () => {
  const s = labelledHead();
  assert.doesNotMatch(s, /%ct/);
  assert.doesNotMatch(s, /beforeCommit/);
});

// The shipped filter, run. A presence pin cannot tell a filter that reads the
// newest record from one that reads the oldest, or one that a quoted record
// inside a longer comment satisfies, so the fenced block's own `-q` program
// goes through `jq` against comment lists shaped like `gh pr view --json
// comments`. ACCEPT and REFUSE both: a filter that never answers passes every
// refuse case.
const recordFilter = () => {
  const block = /```bash\n(gh pr view <pr> --json comments[\s\S]*?)```/.exec(labelledHead());
  assert.ok(block, "no fenced `gh pr view <pr> --json comments` block reads the record");
  const q = /-q '([\s\S]*?)'\n/.exec(block[1]);
  assert.ok(q, "the record block carries no single-quoted -q program");
  return q[1];
};
const readRecord = (comments) =>
  execFileSync("jq", ["-r", recordFilter()], { input: JSON.stringify({ comments }), encoding: "utf8" }).trimEnd();
const A = "a".repeat(40);
const B = "b".repeat(40);

test("the record filter reads the newest record's SHA", () => {
  assert.equal(readRecord([{ createdAt: "2026-10-01T00:00:00Z", body: `ready-to-merge-head: ${A}` }]), A);
  // Newest by createdAt, not by array position.
  assert.equal(
    readRecord([
      { createdAt: "2026-10-02T00:00:00Z", body: `ready-to-merge-head: ${B}` },
      { createdAt: "2026-10-01T00:00:00Z", body: `ready-to-merge-head: ${A}` },
    ]),
    B,
  );
  // A trailing newline is still the whole body.
  assert.equal(readRecord([{ createdAt: "2026-10-01T00:00:00Z", body: `ready-to-merge-head: ${A}\n` }]), A);
});

test("the record filter reads nothing from a comment that is not exactly a record", () => {
  assert.equal(readRecord([]), "");
  // Quoted inside a longer comment — a review discussing the record is not one.
  assert.equal(readRecord([{ createdAt: "2026-10-01T00:00:00Z", body: `the bot read\nready-to-merge-head: ${A}\nhere` }]), "");
  assert.equal(readRecord([{ createdAt: "2026-10-01T00:00:00Z", body: `ready-to-merge-head: ${A.slice(0, 12)}` }]), "");
  assert.equal(readRecord([{ createdAt: "2026-10-01T00:00:00Z", body: "ready-to-merge-head: <sha>" }]), "");
  // A non-record comment newer than the record does not hide it.
  assert.equal(
    readRecord([
      { createdAt: "2026-10-01T00:00:00Z", body: `ready-to-merge-head: ${A}` },
      { createdAt: "2026-10-02T00:00:00Z", body: "LGTM" },
    ]),
    A,
  );
});

test("without a record the timeline is the fallback, keyed on the three events that move a head", () => {
  const s = labelledHead();
  assert.match(s, phrase("**No record — a hand-added label, or one applied before its labeller recorded a head — falls back to the timeline, which can refuse a moved head but never name the labelled one.**"));
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
    phrase("Read it before `gh pr update-branch` too"),
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
// suites. Inverted, the doc tells the bot to refuse the ordinary PR and
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
      "A `committed` or `head_ref_force_pushed` line after the last `labeled ready-to-merge` means the head moved after the audit. **With no record, refuse:**",
    ),
  );
});

// The carry half (ADR 0024): a moved head is handed to the gate against the
// RECORDED head, not refused on sight, and the gate's verdict is what refuses.
// Each pin is one span with its verdict, for the reason the refusal pin above
// gives.
test("a recorded head that is not the current head is handed to the gate, with the record as --pre", () => {
  const s = labelledHead();
  assert.match(s, phrase("**A recorded head that is not the current head is not refused on sight — it may be a rebase-carry, and the merge gate decides.**"));
  assert.match(s, phrase("anything a push adds, drops or edits does not, whenever it was pushed and however its commits are dated"));
  assert.match(s, phrase("run step 3's gate now, before step 1, with `--pre <labelled head>` and no `--post`. **`rebaseCarry` null → refuse:**"));
  assert.match(s, phrase("step 1's `pre` must read `rebaseCarry.accepted` (any other head is a push since the proof — refuse with `head-moved-after-label-#<pr>`)"));
});

test("the refusal names its token, leaves the label alone, and sends a fresh finisher", () => {
  const s = labelledHead();
  assert.match(s, phrase("report `head-moved-after-label-#<pr>` and stop on that PR"));
  assert.match(s, phrase("Leave the label where it is"));
  assert.match(s, phrase("the first audit does not transfer, because it verified a different tree"));
});

// AC-4, the ACCEPT side. A bot that refuses whenever the labelled SHA is not
// the current head must not refuse the ordinary PR. Pinned as one span
// with its verdict, because a bare "this is the normal case" with the outcome
// deleted is what leaves a reader guessing.
test("the normal path — label applied, head unchanged — is stated as proceeding untouched", () => {
  const s = labelledHead();
  assert.match(
    s,
    phrase(
      "**A recorded head that is the current head (`gh pr view <pr> --json headRefOid -q .headRefOid`) is the normal case, and it proceeds untouched** — label applied, head unchanged, merge goes ahead exactly as it did before this gate existed",
    ),
  );
  // The record-less fallback keeps its own accept half: a hand-added label on
  // an unmoved head merges, as it always did.
  assert.match(s, phrase("**Nothing after that label line is the normal case, and it proceeds untouched.**"));
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
// and a head rebased by an abandoned earlier pass gets no exemption either
// way — it is carried or refused on its net change like any force-push. Both
// are the sentences a later reader would delete as hedging, and deleting
// either turns a stated limit into a silent one.
test("the gate declares what it does not cover, and how an abandoned pass's rebase is judged", () => {
  const s = labelledHead();
  assert.match(s, phrase("a hand-added `ready-to-merge` with no finisher behind it reads clean here"));
  assert.match(s, phrase("**earlier, abandoned pass of this command** is judged like any other moved head: with a record, carried when its net change is the labelled head's, refused when it is not; without one, refused"));
});

test("step 3 re-derives the head at the merge instant, against pre, the rebase's post, or a proven carry", () => {
  // The gate compares the PR head against `--pre`/`--post`, so the operands
  // have to be the labelled head and the bot's own rebase — any other source
  // for `--pre` certifies whatever head the bot read last.
  const s = step3();
  assert.match(s, phrase("`--pre` is the head you recorded at **The labelled head**; `--post` is the head step 1's rebase produced"));
  assert.match(s, phrase("**`head-moved-after-label`** — the PR head is neither `pre` nor `post`, nor a head whose net change the gate proved identical to `pre`'s"));
  assert.match(s, phrase("A carry is proven only for the head `gh pr view` read; a different head at `ci-state`'s own read is still this row."));
});

test("step 3 says why no CI gate above it can see a push that landed during the wait", () => {
  // The reason is the load-bearing half: `ci-state.mjs` selects the run whose
  // headSha equals the CURRENT PR head (`r.headSha === prHead`), so a member's
  // push plus its own green run clears step 2 outright. Without this sentence
  // the head comparison looks like a duplicate of the CI binding and gets cut.
  const s = step3();
  assert.match(s, phrase("Any third SHA is a push that landed while you waited on CI, and no CI check can see it"));
  assert.match(s, phrase("`r.headSha === prHead` filter"));
});

// #493 AC-3, and the reason it reaches into run-team: the merge bot's refusal
// stops a bad merge but costs a pass. The cheap half is upstream — the
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
    "A halt at step 1 reads identical from a bare SHA mismatch",
    "run-team/SKILL.md",
  );

test("the recovery removes the label before approving, and says why messaging the bot is not the stop", () => {
  const s = labelRecovery();
  assert.match(s, phrase("removing the artifact the merge bot gates on is the reliable stop"));
  assert.match(s, phrase("a label has been observed holding until after an abort message arrived"));
  assert.match(s, phrase("dispatch a **fresh** finisher against the new head"));
});

// #2945, the writing half: the record is only as good as every path that adds
// `ready-to-merge` writing it — the fleet finisher (its duty list and the
// verbatim block it is handed) and `review-and-fix` step 6 standalone. Each
// must post the record BEFORE the label, so a merge bot
// dispatched the moment the label appears finds the record already there, and
// must name the head it audited, not whatever the branch tip reads.
const recordBeforeLabel = (slice, where, head) => {
  const record = slice.indexOf(`gh pr comment <`);
  const label = slice.indexOf("--add-label ready-to-merge");
  assert.ok(record !== -1, `${where} posts no record before labelling`);
  assert.ok(label !== -1, `${where} no longer adds the label`);
  assert.ok(record < label, `${where} labels before it records the head`);
  assert.match(slice, phrase(`--body "ready-to-merge-head: ${head}"`), `${where} records something other than the audited head`);
};

test("every writer of ready-to-merge records the audited head before the label", () => {
  recordBeforeLabel(
    between(RUN_TEAM, "- **(b) Add the label:**", "4. Report you the label", "finisher duty 3(b)"),
    "finisher duty 3(b)",
    "<your dispatch pin>",
  );
  recordBeforeLabel(
    between(RUN_TEAM, "**Duty 3 is two steps, and only the second one labels.**", "**Once the label is on, take it off", "finisher duty-3 verbatim block"),
    "the finisher's verbatim duty-3 block",
    "<your dispatch pin>",
  );
  recordBeforeLabel(
    between(REVIEW_AND_FIX, "6. Diff-check green", "**Bind green to the *run*", "review-and-fix.md step 6"),
    "review-and-fix.md step 6",
    "<prHead>",
  );
});

// Cross-file, same hazard #447 recorded: run-team's failure table is the
// controller's index of merge-bot outcomes, so a token that exists only in
// run-merge-bot.md leaves the controller with a report it cannot place.
const failureTable = () =>
  between(RUN_TEAM, "## Failure handling", "A red PR never silently becomes", "run-team/SKILL.md");

test("the failure table carries the head-moved outcome and its response", () => {
  const s = failureTable();
  assert.match(s, phrase("Merge bot finds the head moved after `ready-to-merge` was applied"));
  assert.match(s, phrase("a proven rebase-carry keeps the label — the bot proceeds and reports `rebase-carry-#<pr>`"));
  assert.match(s, phrase("Any other move is `head-moved-after-label-#<pr>`, PR stays queued, label untouched"));
});

test("the report vocabulary includes head-moved-after-label and rebase-carry", () => {
  // Bounded to the Report line itself: the token survives elsewhere in the doc,
  // so a whole-file match would mask its removal from the vocabulary list.
  assert.match(DOC, /^Report merged [^\n]*head-moved-after-label-#X/m);
  assert.match(DOC, /^Report merged [^\n]*rebase-carry-#X/m);
});

// §3.4 is HARD, so the rule it states is the one the bot must follow; a
// requirement still binding the label to one SHA would contradict the gate.
test("requirements §3.4 binds the label to the net change and names the carry", () => {
  const REQ = readFileSync(join(import.meta.dirname, "..", "docs", "requirements.md"), "utf8");
  const s = between(REQ, "### 3.4 `ready-to-merge` — HARD", "### 3.5", "requirements.md");
  assert.match(s, phrase("Binds to the head's net change at application time, not to one SHA"));
  assert.match(s, phrase("a proven rebase-carry"));
  assert.match(s, phrase("Any other push after (a review fix, a conflict resolution, an edited commit) makes bot halt with `head-moved-after-label-#<pr>`"));
});
