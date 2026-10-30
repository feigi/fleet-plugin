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
import { Pin } from "./support/prose-pin.mjs";
import { memberPrompt } from "./support/render-brief.mjs";
import { stripComments } from "./support/strip-comments.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const DOC = Pin.file(join(REPO, "commands", "run-merge-bot.md"));
const RUN_TEAM = Pin.file(join(REPO, "skills", "run-team", "SKILL.md"));
const REVIEW_AND_FIX = Pin.file(join(REPO, "commands", "review-and-fix.md"));

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
  DOC.section("## The labelled head", "run-merge-bot.md").text;

// Step 3 is the merge gate, run twice, so the head leg has to be IN it — not
// in a later paragraph a reader reaches the merge without having read.
const step3 = () =>
  DOC.between("3. **Gate the merge with `merge-gate.mjs`", "4. `gh pr merge <pr> --merge`", "run-merge-bot.md").text;

test("the head re-derivation is stated as a requirement, not left to bot discretion", () => {
  assert.match(labelledHead(), Pin.phrase("re-deriving the head is a requirement here, not bot discretion"));
});

test("the labelled head names why no upstream guard covers this window", () => {
  // Without the reason this reads as a redundant fourth check and gets deleted
  // as one. The two facts it rests on: the label does not move with the branch,
  // and every other guard runs before the label exists.
  assert.match(labelledHead(), Pin.phrase("A GitHub label does not follow the branch"));
  assert.match(
    labelledHead(),
    Pin.phrase("runs *before* the label exists, so none of them is watching this window"),
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
  assert.match(s, Pin.phrase("**The labelled head is the head its labeller recorded.**"));
  assert.match(s, Pin.phrase("posts a PR comment whose whole body is `ready-to-merge-head: <sha>`, naming the head it audited, immediately before the label"));
  assert.match(s, Pin.phrase("Read the newest one before `gh pr update-branch` and before anything else that can move the head"));
});

// Why no timeline read can stand in for the record — the reason a later reader
// needs before restoring the committer-date guard as a "cheaper" derivation.
test("the record is stated as the only reading, with why commit dates cannot replace it", () => {
  assert.match(
    labelledHead(),
    Pin.phrase("A commit's dates are when it was made, not when it was pushed, so a commit made before the label and pushed after it carries no date after the label"),
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
  // A trailing newline, CRLF or blank lines are still the whole body.
  assert.equal(readRecord([{ createdAt: "2026-10-01T00:00:00Z", body: `ready-to-merge-head: ${A}\n` }]), A);
  assert.equal(readRecord([{ createdAt: "2026-10-01T00:00:00Z", body: `ready-to-merge-head: ${A}\r\n\n` }]), A);
});

test("the record filter reads nothing from a comment that is not exactly a record", () => {
  assert.equal(readRecord([]), "");
  // Each anchor is pinned by a fixture only IT rejects. One fixture carrying
  // both a prefix and a suffix is rejected by either anchor alone, so deleting
  // `\A` or `\z` left every case green. A prefix with nothing after the SHA is
  // what `\A` refuses; a suffix with nothing before the keyword is what `\z`
  // refuses; the multi-line cases put the stray text on its own line. Measured
  // on jq 1.7.1, `^` and `$` are string anchors too (`"x\nready"|test("^ready")`
  // is false), so spelling the anchors `^`/`$` is no weaker and no fixture can
  // tell the two spellings apart; deleting either anchor is what this catches.
  const record = (body) => readRecord([{ createdAt: "2026-10-01T00:00:00Z", body }]);
  assert.equal(record(`see: ready-to-merge-head: ${A}`), "");
  assert.equal(record(`the bot read\nready-to-merge-head: ${A}`), "");
  assert.equal(record(`ready-to-merge-head: ${A} trailing`), "");
  assert.equal(record(`ready-to-merge-head: ${A}\nhere`), "");
  assert.equal(record(`ready-to-merge-head: ${A}a`), "");
  assert.equal(record(`ready-to-merge-head: ${A}\nready-to-merge-head: ${B}`), "");
  assert.equal(record(`the bot read\nready-to-merge-head: ${A}\nhere`), "");
  assert.equal(record(` ready-to-merge-head: ${A}`), "");
  assert.equal(record(`ready-to-merge-head: ${"A".repeat(40)}`), "");
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
  assert.match(s, Pin.phrase("**No record — a hand-added label, or one applied before its labeller recorded a head — falls back to the timeline, which can refuse a moved head but never name the labelled one.**"));
  assert.match(s, /issues\/<pr>\/timeline\?per_page=100/);
  assert.match(s, /\.event == "labeled" and \.label\.name == env\.label/);
  assert.match(s, /\.event == "committed" or \.event == "head_ref_force_pushed"/);
});

// The timeline fallback's own `-q` program, run. The string reaches it through
// the environment (`env.label`), so a string holding `'` cannot end the
// single-quoted program; the fixture label below holds one.
const timelineProgram = () => {
  const block = /```bash\n(label="<ready-to-merge string>" gh api [\s\S]*?)```/.exec(labelledHead());
  assert.ok(block, "no fenced block reads the timeline with the string in the environment");
  const q = /-q '([\s\S]*?)'\n/.exec(block[1]);
  assert.ok(q, "the timeline block carries no single-quoted -q program");
  return q[1];
};
const readTimeline = (label, events) =>
  execFileSync("jq", ["-r", timelineProgram()], { input: JSON.stringify(events), encoding: "utf8", env: { ...process.env, label } })
    .trimEnd()
    .split("\n")
    .filter(Boolean);
const TIMELINE = [
  { event: "labeled", label: { name: "won't fix" } },
  { event: "labeled", label: { name: "other" } },
  { event: "committed", sha: A },
  { event: "head_ref_force_pushed", sha: B },
  { event: "commented" },
];

test("the timeline program prints the labeled line for a string holding an apostrophe, none for another label, and the commit and force-push lines", () => {
  assert.deepEqual(readTimeline("won't fix", TIMELINE), ["labeled won't fix", `committed ${A}`, `head_ref_force_pushed ${B}`]);
  assert.deepEqual(readTimeline("never-applied", TIMELINE), [`committed ${A}`, `head_ref_force_pushed ${B}`]);
});

// The research note's row 43 cites the two reads by line range. Moving the
// record block ahead of the timeline block left its old range pointing at the
// wrong command with nothing red, so this resolves each range it cites against
// the shipped doc: every range must hold one of the two commands, and both
// must be cited. The line numbers are the row's; the commands are what the
// ranges are checked for, so an edit above either block reds here until the
// row is re-cited.
test("the research note's row for the labelled-head reads cites ranges that hold them", () => {
  const note = readFileSync(join(import.meta.dirname, "..", "docs", "research", "external-assumptions", "prose.md"), "utf8");
  const row = note.split("\n").find((l) => l.startsWith("| 43 |"));
  assert.ok(row, "prose.md has no row 43");
  const lines = DOC.text.split("\n");
  const cited = [...row.matchAll(/run-merge-bot\.md:(\d+)-(\d+)/g)].map(([, a, b]) => lines.slice(a - 1, b).join("\n"));
  assert.equal(cited.length, 2, "row 43 cites the record read and the timeline fallback, one range each");
  assert.ok(cited.some((t) => t.includes("gh pr view <pr> --json comments")), "no cited range holds the record read");
  assert.ok(cited.some((t) => t.includes("issues/<pr>/timeline?per_page=100")), "no cited range holds the timeline fallback");
  for (const t of cited) {
    assert.ok(
      t.includes("gh pr view <pr> --json comments") || t.includes("issues/<pr>/timeline?per_page=100"),
      `a cited range holds neither read: ${t.slice(0, 60)}`,
    );
  }
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
    Pin.phrase("Read it before `gh pr update-branch` too"),
  );
  assert.match(
    labelledHead(),
    Pin.phrase("once you have rebased this read can no longer tell your commits from someone else's"),
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
    Pin.phrase(
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
  assert.match(s, Pin.phrase("**A recorded head that is not the current head is not refused on sight — it may be a rebase-carry, and the merge gate decides.**"));
  assert.match(s, Pin.phrase("anything a push adds, drops or edits does not, whenever it was pushed and however its commits are dated"));
  assert.match(s, Pin.phrase("run step 3's gate now, before step 1, with `--pre <labelled head>` and no `--post`. **`rebaseCarry` null → refuse:**"));
  assert.match(s, Pin.phrase("step 1's `pre` must read `rebaseCarry.accepted` (any other head is a push since the proof — refuse with `head-moved-after-label-#<pr>`)"));
});

test("the refusal names its token, leaves the label alone, and sends a fresh finisher", () => {
  const s = labelledHead();
  assert.match(s, Pin.phrase("report `head-moved-after-label-#<pr>` and stop on that PR"));
  assert.match(s, Pin.phrase("Leave the label where it is"));
  assert.match(s, Pin.phrase("the first audit does not transfer, because it verified a different tree"));
});

// AC-4, the ACCEPT side. A bot that refuses whenever the labelled SHA is not
// the current head must not refuse the ordinary PR. Pinned as one span
// with its verdict, because a bare "this is the normal case" with the outcome
// deleted is what leaves a reader guessing.
test("the normal path — label applied, head unchanged — is stated as proceeding untouched", () => {
  const s = labelledHead();
  assert.match(
    s,
    Pin.phrase(
      "**A recorded head that is the current head (`gh pr view <pr> --json headRefOid -q .headRefOid`) is the normal case, and it proceeds untouched** — label applied, head unchanged, merge goes ahead exactly as it did before this gate existed",
    ),
  );
  // The record-less fallback keeps its own accept half: a hand-added label on
  // an unmoved head merges, as it always did.
  assert.match(s, Pin.phrase("**Nothing after that label line is the normal case, and it proceeds untouched.**"));
});

// Step 3's comparison has an operand, and this section is the only place that
// captures it. Step 1's `pre` exists only where step 1 runs, so a PR already
// current has none — the instruction has to stand on its own read, and it has
// to say the read happens BEFORE the rebase or it captures the wrong SHA.
test("the pre-rebase head is recorded here, since step 3 compares against it and nothing rebuilds it", () => {
  const s = labelledHead();
  assert.match(s, Pin.phrase("Record the head before you rebase"));
  // `phrase`, not a raw regex: this command sits in prose, not in a fenced
  // block, so a hard-wrap can put a newline between any two of its words.
  // Measured — the raw form reddened on a same-wording rewrap of the section.
  assert.match(s, Pin.phrase("gh pr view <pr> --json headRefOid -q .headRefOid"));
  assert.match(s, Pin.phrase("on an already-current PR it is simply the head you merge"));
});

// The other ACCEPT-side half: the two things the gate deliberately does NOT
// answer. A hand-added label reads clean here (run-team owns reviewer-only),
// and a head rebased by an abandoned earlier pass gets no exemption either
// way — it is carried or refused on its net change like any force-push. Both
// are the sentences a later reader would delete as hedging, and deleting
// either turns a stated limit into a silent one.
test("the gate declares what it does not cover, and how an abandoned pass's rebase is judged", () => {
  const s = labelledHead();
  assert.match(s, Pin.phrase("a hand-added `ready-to-merge` with no finisher behind it reads clean here"));
  assert.match(s, Pin.phrase("**earlier, abandoned pass of this command** is judged like any other moved head: with a record, carried when its net change is the labelled head's, refused when it is not; without one, refused"));
});

test("step 3 re-derives the head at the merge instant, against pre, the rebase's post, or a proven carry", () => {
  // The gate compares the PR head against `--pre`/`--post`, so the operands
  // have to be the labelled head and the bot's own rebase — any other source
  // for `--pre` certifies whatever head the bot read last.
  const s = step3();
  assert.match(s, Pin.phrase("`--pre` is the head you recorded at **The labelled head**; `--post` is the head step 1's rebase produced"));
  assert.match(s, Pin.phrase("**`head-moved-after-label`** — the PR head is neither `pre` nor `post`, nor a head whose net change the gate proved identical to `pre`'s"));
  assert.match(s, Pin.phrase("A carry is proven only for the head `gh pr view` read; a different head at `ci-state`'s own read is still this row."));
});

test("step 3 says why no CI gate above it can see a push that landed during the wait", () => {
  // The reason is the load-bearing half: `ci-state.mjs` selects the run whose
  // headSha equals the CURRENT PR head (`r.headSha === prHead`), so a member's
  // push plus its own green run clears step 2 outright. Without this sentence
  // the head comparison looks like a duplicate of the CI binding and gets cut.
  const s = step3();
  assert.match(s, Pin.phrase("Any third SHA is a push that landed while you waited on CI, and no CI check can see it"));
  assert.match(s, Pin.phrase("`r.headSha === prHead` filter"));
});

// #493 AC-3, and the reason it reaches into run-team: the merge bot's refusal
// stops a bad merge but costs a pass. The cheap half is upstream — the
// controller not dispatching a finisher into a window a member is about to
// move. Sliced to the finisher-dispatch paragraph; `question`, `outbox` and
// `dispatch` all recur through a 2000+ line file.
const dispatchGate = () =>
  RUN_TEAM.between(
    "**finisher** — a fresh small agent, not the fix-applier resumed.",
    "**A final report is not proof the member stopped.**",
    "run-team/SKILL.md",
  ).text;

// The rule's paragraph moved, with its war story, to references/finisher.md;
// the dispatch paragraph keeps the rule beside the pointer.
const FINISHER_REFERENCE = Pin.file(join(REPO, "skills", "run-team", "references", "finisher.md"));
const outboxQuestion = () =>
  FINISHER_REFERENCE.section("## An unanswered question from the member is an outbox item", "references/finisher.md").text;

test("an unanswered member question blocks finisher dispatch, with the same weight as an owed reply", () => {
  assert.match(
    dispatchGate(),
    Pin.phrase(
      "**An unanswered question from the member is an outbox item, and it blocks dispatch with the same weight as a reply you have already decided on.** See references/finisher.md.",
    ),
  );
  const s = outboxQuestion();
  assert.match(
    s,
    Pin.phrase(
      "An unanswered question from the member is an outbox item, and it blocks dispatch with the same weight as a reply you have already decided on",
    ),
  );
  // WHY it does not feel like one is what stops it being read as a restatement
  // of the owed-ruling rule and deleted as duplication.
  assert.match(s, Pin.phrase("you have decided nothing yet, so the outbox reads empty"));
  // Both exits, or "answer it" reads as a mandate to rule on everything.
  assert.match(s, Pin.phrase("tell the member you are not ruling and it should proceed on its own default"));
});

// The recovery the ticket asks to keep in the runbook, at the moment it
// applies: the label is already on and the controller is about to approve a
// push. Sliced to that paragraph — `ready-to-merge` and `finisher` are
// everywhere in this file. The why moved to references/finisher.md, beside
// the pointer the paragraph ends on.
const labelRecovery = () =>
  RUN_TEAM.paragraph(
    "**Once the label is on, take it off before you approve any push.**",
    "run-team/SKILL.md label recovery paragraph",
    "### Own the CI waits",
  ).text;
const labelRecoveryWhy = () =>
  FINISHER_REFERENCE.section("## Take the label off before you approve any push", "references/finisher.md").text;

test("the recovery removes the label before approving, and says why messaging the bot is not the stop", () => {
  const s = labelRecovery();
  assert.match(s, Pin.phrase("then remove the label (`gh pr edit <pr> --remove-label \"<ready-to-merge string>\"`"));
  assert.match(s, Pin.phrase("the string `show ready-to-merge` prints), then approve"));
  assert.match(s, Pin.phrase("dispatch a **fresh** finisher against the new head"));
  assert.match(s, Pin.phrase("See references/finisher.md."));
  const why = labelRecoveryWhy();
  assert.match(why, Pin.phrase("removing the artifact the merge bot gates on is the reliable stop"));
  assert.match(why, Pin.phrase("a label has been observed holding until after an abort message arrived"));
});

// #2945, the writing half: the record is only as good as every path that adds
// named in the finisher's member prompt) and
// `review-and-fix` step 6 standalone. Each must post the record BEFORE the
// label, so a merge bot dispatched the moment the label appears finds the
// record already there, and must name the head it audited, not whatever the
// branch tip reads.
const recordBeforeLabel = (slice, where, head) => {
  const record = slice.indexOf(`gh pr comment <`);
  const label = slice.indexOf('--add-label "<ready-to-merge string>"');
  assert.ok(record !== -1, `${where} posts no record before labelling`);
  assert.ok(label !== -1, `${where} no longer adds the label`);
  assert.ok(record < label, `${where} labels before it records the head`);
  assert.match(slice, Pin.phrase(`--body "ready-to-merge-head: ${head}"`), `${where} records something other than the audited head`);
};

// The finisher no longer spells the two commands, so its prose is held to
// handing the script the audited head, and the script's own source to writing
// the record before the label. The order is also run, against a stub `gh`, in
// finisher-label.test.mjs.
const FINISHER_LABEL = stripComments(readFileSync(join(REPO, "scripts", "finisher-label.mjs"), "utf8"));

test("every writer of ready-to-merge records the audited head before the label", () => {
  for (const [slice, where] of [
    [
      Pin.of(memberPrompt("finisher", "fresh"), "the finisher's member prompt").between("**Duty 3 is one script, and its exit code is your verdict.**", "Report to the controller in the report file your brief names", "finisher duty-3 block").text,
      "the finisher's duty-3 block in its member prompt",
    ],
  ]) {
    assert.match(slice, Pin.phrase("finisher-label.mjs --pr"), `${where} no longer runs the script that records the head and adds the label`);
    assert.match(slice, Pin.phrase("--pin <your dispatch pin>"), `${where} hands the script something other than the audited head`);
  }
  const record = FINISHER_LABEL.indexOf('"pr", "comment"');
  // The `patch` a Ticketless PR is given is a release label, not a writer of ready-to-merge: the write that is, is the one that adds LABEL.
  const label = FINISHER_LABEL.indexOf('"--add-label", LABEL');
  assert.ok(record !== -1, "finisher-label.mjs posts no record");
  assert.ok(label !== -1, "finisher-label.mjs no longer adds the label");
  assert.ok(record < label, "finisher-label.mjs labels before it records the head");
  assert.match(FINISHER_LABEL, /`ready-to-merge-head: \$\{pin\}`/, "finisher-label.mjs records something other than the audited head");
  recordBeforeLabel(
    REVIEW_AND_FIX.between("6. Diff-check green", "**Bind green to the *run*", "review-and-fix.md step 6").text,
    "review-and-fix.md step 6",
    "<prHead>",
  );
});

// Cross-file, same hazard #447 recorded: run-team's failure table is the
// controller's index of merge-bot outcomes, so a token that exists only in
// run-merge-bot.md leaves the controller with a report it cannot place.
const failureTable = () =>
  RUN_TEAM.between("## Failure handling", "A red PR never silently becomes", "run-team/SKILL.md").text;

test("the failure table carries the head-moved outcome and its response", () => {
  const s = failureTable();
  assert.match(s, Pin.phrase("Merge bot finds the head moved after `ready-to-merge` was applied"));
  assert.match(s, Pin.phrase("a proven rebase-carry keeps the label — the bot proceeds and reports `rebase-carry-#<pr>`"));
  assert.match(s, Pin.phrase("Any other move is `head-moved-after-label-#<pr>`, PR stays queued, label untouched"));
});

test("the report vocabulary includes head-moved-after-label and rebase-carry", () => {
  // Bounded to the Report line itself: the token survives elsewhere in the doc,
  // so a whole-file match would mask its removal from the vocabulary list.
  assert.match(DOC.text, /^Report merged [^\n]*head-moved-after-label-#X/m);
  assert.match(DOC.text, /^Report merged [^\n]*rebase-carry-#X/m);
});

// §3.4 is HARD, so the rule it states is the one the bot must follow; a
// requirement still binding the label to one SHA would contradict the gate.
test("requirements §3.4 binds the label to the net change and names the carry", () => {
  const REQ = Pin.file(join(import.meta.dirname, "..", "docs", "requirements.md"));
  const s = REQ.section("### 3.4 `ready-to-merge` — HARD", "requirements.md").text;
  assert.match(s, Pin.phrase("Binds to the head's net change at application time, not to one SHA"));
  assert.match(s, Pin.phrase("a proven rebase-carry"));
  assert.match(s, Pin.phrase("Any other push after (a review fix, a conflict resolution, an edited commit) makes bot halt with `head-moved-after-label-#<pr>`"));
});
