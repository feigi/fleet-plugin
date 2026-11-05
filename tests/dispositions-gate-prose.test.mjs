// The disposition record and its gate, as the prose states them to the
// two seats that act on it: review-and-fix.md step 2 tells the fix-applier to
// write `<scratch>/dispositions-<your name>.json` and what passes, and run-team's
// gate paragraph tells the controller when `ledger.mjs dispatch` refuses a
// finisher and what each refusal asks of it. The fix-applier's restatement of
// the record lives in its agent body, which the dispatch-block golden fixture
// pins whole; these two paragraphs sit in review-and-fix.md and run-team's
// SKILL.md, which no golden fixture holds, so nothing else holds them.
//
// THE CEILING: presence pins over bounded slices, each a contiguous clause —
// the rule and its condition in one span, so an inverted verdict (`ok` →
// `mismatch`), a flipped consequence (`no finisher` → `a finisher`) or a
// renamed file reds, where a keyword pin would not. They prove the clauses are
// there, not that nothing near them contradicts them. One pin crosses into
// code: the deferral reasons the prose lists are read against ALLOWED_DEFER,
// the list the check enforces, so the two cannot drift apart silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";
import { CASES, memberPrompt, renderBrief } from "./support/render-brief.mjs";
import { ALLOWED_DEFER } from "../plugin/scripts/dispositions-check.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const REVIEW_AND_FIX = Pin.file(join(REPO, "commands", "review-and-fix.md"));
const SKILL = Pin.file(join(REPO, "skills", "run-team", "SKILL.md"));
const CHECK = Pin.file(join(REPO, "scripts", "dispositions-check.mjs"));
const ESCALATION = Pin.file(join(REPO, "skills", "run-team", "references", "dispositions-escalation.md"));

// Step 2's record paragraph: one line, bounded by step 3's opener.
const recordStep = () =>
  REVIEW_AND_FIX.between("**Write every ruling to `<scratch>/dispositions-<your name>.json`", "\n3. **Run `checkCmd` and `testCmd`", "review-and-fix.md").text;
const gate = () => SKILL.paragraph("That `dispatch` refuses a finisher", "run-team/SKILL.md", "**It refuses a finisher, too, while the PR sits on a conflict hold").text;

test("step 2 names the record's file, one per fix-applier, and that the check judges it before any finisher", () => {
  assert.match(recordStep(), Pin.phrase(
    "**Write every ruling to `<scratch>/dispositions-<your name>.json`, `<your name>` the `fix-pr-<pr>[-x]` you were dispatched as (standalone, `fix-pr-<pr>`) — the disposition record `dispositions-check.mjs` judges against the review result file before any finisher is dispatched.**",
  ));
});

test("step 2 reads scope off the diff before the declared scope", () => {
  assert.match(recordStep(), Pin.phrase(
    "a finding with no `line`, or on a line `git diff` touches from the PR's merge-base with `origin/main` to the review's `head`, is in scope whatever `scope` says, and only otherwise does the declared one stand.",
  ));
});

test("step 2's deferral reasons are exactly the ones the check accepts, and anything else refuses the finisher", () => {
  const s = recordStep();
  const listed = /An in-scope `survived` finding deferred passes only with `reason` `([^`]+)`, `([^`]+)`, `([^`]+)` or `([^`]+)`\./.exec(s);
  assert.ok(listed, "step 2 no longer lists the in-scope deferral reasons in one sentence — update this test");
  assert.deepEqual(listed.slice(1), [...ALLOWED_DEFER]);
  assert.match(s, Pin.phrase(
    "Any other reason, none, or a `survived` or `unverified` finding with no entry is a mismatch: the script exits 1 naming each violating entry's bucket, index and rule, and `ledger.mjs dispatch` refuses the PR's finisher.",
  ));
});

test("step 2 requires a remedy file absent from the PR's diff for remedy-outside-diff, and refuses none or every one inside it", () => {
  assert.match(recordStep(), Pin.phrase(
    "`remedy-outside-diff` — the remedy would edit a file the PR's diff does not touch — also needs `remedyFiles` to name at least one file absent from `git diff` from that merge-base to the review's `head`: none named, or every one in that diff, is a mismatch.",
  ));
});

test("the gate refuses a finisher unless the verdict answering the latest review's run is ok", () => {
  const s = gate();
  assert.match(s, Pin.phrase(
    "That `dispatch` refuses a finisher — exit 2, nothing written — on a PR whose latest `reviewed=` counts a survived or unverified finding, unless the dispositions verdict answering that review's run is `ok`**: among the `dispositions-*=fix-pr-<M>[-x]:<run>` tokens naming its run, the one from the highest-suffixed fix-applier — so a second review at the same head is answered by none of the first one's verdicts.",
  ));
  assert.match(s, Pin.phrase("A PR whose latest review counts `0/<n>/0` is not gated."));
  assert.match(s, Pin.phrase(
    "One counting `0/<n>/<u>` with `<u>` above zero is gated like survivors, and the tick prints `DISPATCH fix-pr PR#<M>` for it: that fix-applier's `no-op` and its `ok` verdict are what open the finisher.",
  ));
});

test("the fix-applier bullet dispatches on DISPATCH fix-pr for a review counting survived or unverified findings, with no fix-applier live", () => {
  const s = SKILL.bullet("- **The fix-applier.**", "- **The conflict hold.**", "run-team/SKILL.md fix-applier bullet").text;
  assert.match(s, Pin.phrase("`DISPATCH fix-pr PR#<M>` on a `reviewed=` count that survived or unverified findings, with no fix-applier live"));
});

test("the gate says what each refusal asks of the controller", () => {
  const s = gate();
  assert.match(s, Pin.phrase(
    "`dispositions unchecked` — no verdict answers that review: run `ledger.mjs dispositions` for the fix-applier that answered the review",
  ));
  assert.match(s, Pin.phrase(
    "`dispositions mismatch` — no finisher: the tick prints `DISPATCH fix-pr PR#<M>` for it, and the next-suffix fix-applier answers it",
  ));
  assert.match(s, Pin.phrase(
    "`dispositions escalate` — no finisher, no `fix-due` row: a finding above `suggestion` deferred `remedy-outside-diff` clears with the maintainer's answers, a second mismatch only with a new review (**Dispositions escalation**).",
  ));
  assert.match(s, Pin.phrase(
    "it refuses too while a fix-applier on the PR is still live, verdict or not** — `fix-pr-<M>[-x] still live`: settle it, run `ledger.mjs dispositions` for it, then dispatch again.",
  ));
});

test("a mismatch is retried once by the next suffix, whose prompt carries the violation list, and a second failure escalates", () => {
  const s = SKILL.paragraph("`DISPATCH fix-pr PR#<M>` on a dispositions mismatch", "run-team/SKILL.md", "### The main-gain hit", { emphasisTolerant: true }).text;
  assert.match(s, Pin.phrase("is one automatic retry, a review fix-applier named the next suffix (`fix-pr-<M>-b`)"));
  assert.match(s, Pin.phrase(
    "first one's with the retry paragraph added: `--mismatched-record`, the mismatched member's record `<scratch>/dispositions-<member>.json` it starts from, and `--violations`, the check's violation list as printed",
  ));
  // The two arguments reach the member: the rendered retry brief carries the
  // mismatched record's path and the violation list the controller passed.
  const retry = CASES.find((c) => c.role === "fix-applier" && c.kind === "dispositions-retry").args;
  const brief = renderBrief("fix-applier", "dispositions-retry");
  assert.match(brief, Pin.phrase(`The mismatched member's record is \`${retry["mismatched-record"]}\``));
  assert.match(brief, Pin.phrase(`each naming a bucket, an index and a rule: ${retry.violations}`));
  assert.match(s, Pin.phrase(
    "A second failure on the same review is written as `dispositions-escalate=fix-pr-<M>-b:<run>` in place of a mismatch: the tick prints no `DISPATCH fix-pr` for it. Post the verb's output with `gh pr comment <M>`. A second failure is flagged for a human. A new review of the PR counts again from none.",
  ));
});

test("an escalate whose verb printed no violations is the maintainer's to answer, and the answers are recorded through the verb", () => {
  const s = SKILL.paragraph("`DISPATCH fix-pr PR#<M>` on a dispositions mismatch", "run-team/SKILL.md", "### The main-gain hit", { emphasisTolerant: true }).text;
  assert.match(s, Pin.phrase(
    "An escalate whose verb printed no violations is the maintainer's to answer instead, one yes/no per escalated finding: yes upholds the deferral, no sends it back to be applied in this PR.",
  ));
  assert.match(s, Pin.phrase(
    "With every finding explicitly answered this session, record them with `ledger.mjs dispositions` and its `--uphold` and `--send-back`: `ok` gets the finisher, `mismatch` the tick's retry, `escalate` is a second failure.",
  ));
  // The flags the prose names are the ones the check takes, and its header names the token they write.
  const header = CHECK.stripGutter("//").text;
  assert.match(header, Pin.phrase("escalation-answer=<run>:<bucket>[<index>]:upheld|sent-back"));
  assert.match(header, Pin.phrase("`--uphold <list>` and `--send-back <list>`, each a comma-separated list of `<bucket>[<index>]`"));
});

test("the escalation reference has the controller ask one yes/no per finding, record nothing before every one is answered, and run the check, the ruled lines and the comment in that order", () => {
  const s = ESCALATION.text;
  assert.match(s, Pin.phrase(
    "Then put one message to the maintainer, with one yes/no for each escalated finding.",
  ));
  assert.match(s, Pin.phrase("its address, `<bucket>[<index>]` as the check printed it, its severity and its claim, read from `<scratch>/pr<M>/<run>/review.json`;"));
  assert.match(s, Pin.phrase("its remedy files, as the check printed them;"));
  assert.match(s, Pin.phrase("the issue it was filed to and the fix-applier's reason, read from the escalated member's record `<scratch>/dispositions-<member>.json`."));
  assert.match(s, Pin.phrase("Yes means upheld: the deferral stands. No means sent back: the finding is applied in this PR."));
  assert.match(s, Pin.phrase("Record nothing until every finding has an answer, and nothing without the maintainer's explicit answer in this session."));
  assert.match(s, Pin.phrase("Run `ledger.mjs dispositions <member> --scratch <scratch> --uphold '<list>' --send-back '<list>'`"));
  assert.match(s, Pin.phrase("Record one line per finding: `ledger.mjs ruled <M> \"escalation answer <bucket>[<index>]: upheld|sent back — <reason>\"`, the maintainer's reason."));
  assert.match(s, Pin.phrase("Post one PR comment under the escalate comment, quoting the answers."));
  assert.ok(s.indexOf("Run `ledger.mjs dispositions") < s.indexOf("Record one line per finding") && s.indexOf("Record one line per finding") < s.indexOf("Post one PR comment"));
});

test("the escalation reference says what each verdict of the answers earns, and what any other answer is", () => {
  const s = ESCALATION.text;
  assert.match(s, Pin.phrase("`ok`: dispatch the finisher, as for any `ok`."));
  assert.match(s, Pin.phrase("`mismatch`: a sent-back finding is a broken rule, so the tick prints `DISPATCH fix-pr PR#<M>` and the retry runs as any mismatch's does."));
  assert.match(s, Pin.phrase(
    "deferring a sent-back finding again, for any reason, is a second failure, and applying it while deferring an upheld one `remedy-outside-diff` passes.",
  ));
  assert.match(s, Pin.phrase(
    "`escalate`: an earlier fix-applier on the review had already failed, so the send-back is the second failure. Comment, flag the PR for a human, and a new review of the PR counts again from none.",
  ));
  assert.match(s, Pin.phrase("An escalate whose verb printed violations is a second mismatch on one review: no answer clears it, you comment and flag the PR for a human, and a new review of the PR counts again from none."));
  assert.match(s, Pin.phrase("Record `ledger.mjs ruled <M> <decision>` and carry it out."));
});

test("review-and-fix.md step 2 says a critical or important outside-diff deferral goes to the maintainer, and the finisher waits for the answer", () => {
  assert.match(recordStep(), Pin.phrase(
    "A `critical` or `important` finding deferred for it goes to the maintainer instead of passing: the script exits 1 with verdict `escalate`, `ledger.mjs dispatch` refuses the PR's finisher until answered; a `suggestion` deferred for it passes.",
  ));
});

// A sentence of the runbook, the command or the grammar comment that speaks of an
// escalate and says it gets no retry or no further fix-applier, or that only a
// human rules on it: the maintainer's answers clear an outside-diff one, and a
// sent-back finding's mismatch gets the retry. The finisher-halt table's
// `**Escalate**` rows are a different escalation, and no part of it.
const STALE_ESCALATE = /\bno retry\b|no further fix-applier|nothing retries|only a human|a human rules|a hold only a human/i;
const staleEscalate = (text) => Pin.sentences(text.replace(/\s+/g, " ")).filter((x) => /\bescalat/i.test(x) && STALE_ESCALATE.test(x) && !x.includes("**Escalate**"));

test("no sentence of the runbook, the command or the grammar says an escalate gets no retry or no further fix-applier, or that only a human rules on it", () => {
  const files = [
    join(REPO, "skills", "run-team", "SKILL.md"), join(REPO, "skills", "run-team", "references", "dispositions-escalation.md"),
    join(REPO, "commands", "review-and-fix.md"), join(REPO, "scripts", "ledger-grammar.mjs"),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8").replace(/^\s*\/\/ ?/gm, "");
    assert.deepEqual(staleEscalate(text), [], `${file} still says an escalate is no one's but a human's, or gets no retry`);
  }
  // The control: the matcher catches the sentences this change removed.
  assert.equal(staleEscalate("`dispositions escalate` — no finisher, no retry and no further fix-applier. Another sentence.").length, 1);
  assert.equal(staleEscalate("An escalate goes to a human and nothing retries it; a suggestion passes.").length, 1);
  assert.equal(staleEscalate("The grammar calls an escalate a hold only a human answers.").length, 1);
  assert.equal(staleEscalate("An escalate is the maintainer's to answer. A sent-back finding's mismatch gets the retry.").length, 0);
  assert.equal(staleEscalate("| `human` | **Escalate** — no retry. A Ticketless PR.").length, 0, "a finisher halt's escalation is another one");
});

test("a reversed refutation reaches the ledger from the disposition record", () => {
  const reviewers = Pin.file(join(REPO, "skills", "run-team", "references", "reviewers.md"));
  assert.match(reviewers.paragraph("`refuted` comes back deliberately as well", "references/reviewers.md", "**`dimensionsRun` is the dispatch; `dimensionsUnrun` is").text, Pin.phrase(
    "The fix-applier may reverse one; it records each reversal as a `refuted` entry in its disposition record, the evidence in `reason`, and you copy those entries to the ledger's `ruled` line",
  ));
});

// Step 6's label conditions: the check over the member's own record is the
// fourth, so a standalone run — no controller, no ledger — holds its own label.
const labelStep = () => REVIEW_AND_FIX.paragraph("6. Diff-check green (run-bound", "review-and-fix.md", "**`verdict: \"no-ci\"` — this repo has").text;

test("step 6 makes the dispositions check over the member's own record a label condition", () => {
  assert.match(labelStep(), Pin.phrase(
    "**and** `dispositions-check.mjs --member fix-pr-<pr> --scratch <scratch>` run over your own record exiting 0",
  ));
});

test("step 6 halts a non-zero dispositions exit before the label and has the member report its violations", () => {
  assert.match(labelStep(), Pin.phrase(
    "A non-zero dispositions exit halts you before the label, and you report the violations it printed.",
  ));
});

test("step 6 has a standalone member pass --no-ledger and --review: no token is written and the exit status is the verdict", () => {
  assert.match(labelStep(), Pin.phrase(
    "`--review <path>` names the review file, which you write yourself from the findings step 1 collected",
  ));
  assert.match(labelStep(), Pin.phrase(
    "standalone you pass `--no-ledger` with it, so it writes no token and the exit status is the verdict",
  ));
  assert.match(labelStep(), Pin.phrase(
    "without the flag it exits 2 whenever a ledger exists",
  ));
});

// Step 5's record duties: one line, bounded by step 6's opener.
const filingStep = () =>
  REVIEW_AND_FIX.between("**Name where each deferral went, in the disposition record.**", "\n6. Diff-check green", "review-and-fix.md").text;

test("step 5 has every deferred entry name in issue where it went, and a suggestion's entry its refuter verdict file in either scope", () => {
  const s = filingStep();
  assert.match(s, Pin.phrase("Every entry you defer carries `issue`: the number of the issue you filed it to, commented it onto, or appended it to"));
  assert.match(s, Pin.phrase(
    "A `suggestion`'s entry — an `unverified` finding with `refutersDispatched` of zero — also carries `verdictPath`, applied or deferred, in scope and, above the claim bar, out of scope: the absolute path of a file holding its refuter's verdict as JSON, `{\"refuted\": <boolean>, \"reason\": \"<string>\"}`, under your own `<scratch>/pr<N>/fix-XXXXXXXX/<finding>/` run root.",
  ));
  assert.match(s, Pin.phrase(
    "out of scope, that file missing or holding no decision files the finding open `needs-triage`, while in scope it is a mismatch.",
  ));
});

// Step 2's plan paragraph: one line, bounded by the record paragraph's opener.
const planStep = () =>
  REVIEW_AND_FIX.between("2. Plan the actions.", "\n   **Write every ruling to", "review-and-fix.md").text;

test("step 2 runs the claim bar first out of scope, then checks every other suggestion with one refuter, in scope or out", () => {
  const s = planStep();
  assert.match(s, Pin.phrase(
    "a suggestion whose claim is about shape — step 5's worth-a-claim bar, recorded `claimKind: shape` — gets no refuter and goes to the `PR #<pr> review: the suggestion band, checked` record, and every other out-of-scope suggestion gets the same refuter an in-scope one does, dispatched the same way, before it is filed.",
  ));
  assert.match(s, Pin.phrase("In scope → dispatch one refuter against it, biased to refuse"));
});

test("step 2 files a refuted out-of-scope suggestion on the closed record and any other open needs-triage, and step 4 reports the dispatch count", () => {
  const s = planStep();
  assert.match(s, Pin.phrase(
    "Refuted → the `PR #<pr> review: the suggestion band, checked` record, never an open issue. Survived, or its refuter crashed or abstained → its own open issue labelled `needs-triage`, citing the verdict, or the run that crashed, in the body.",
  ));
  assert.match(REVIEW_AND_FIX.text, Pin.phrase(
    "your apply/defer adjudication + how many refuters you dispatched against out-of-scope suggestions + the pushed SHA",
  ));
});

test("step 5 says a mismatch names the filing row, and that an unreadable tracker is unchecked, never ok", () => {
  const s = filingStep();
  assert.match(s, Pin.phrase("`dispositions-check.mjs` reads each named issue back through `gh issue view --json labels,state,title` and each verdict file off disk; a mismatch names the row of its filing table the entry broke"));
  assert.match(s, Pin.phrase("with nothing else broken the verdict is `unchecked` — never `ok`, and it exits 1 — so run the check again once `gh` answers."));
});

// Step 5's duplicate duty: one line, bounded by the record duties' opener.
const duplicateStep = () =>
  REVIEW_AND_FIX.between("**A duplicate that should hold an open deferral is a comment, never a relabel.**", "\n   **Name where each deferral went", "review-and-fix.md").text;

test("step 5 lands a duplicate as a comment citing the refuters and changing no label, never relabels down, and refiles a closed one", () => {
  const s = duplicateStep();
  assert.match(s, Pin.phrase("cite the refuters' verdict — or the review's votes — in the comment you leave there, and change no label."));
  assert.match(s, Pin.phrase("Never relabel `ready-for-agent` down to `needs-triage`"));
  assert.match(s, Pin.phrase("A closed one cannot hold it: file a new open issue citing it"));
  // The relabel-up rule this duty replaced: no filing path sets ready-for-agent.
  assert.doesNotMatch(s, /--add-label ready-for-agent/, "step 5's duplicate duty relabels up to `ready-for-agent` again — only triage sets that label");
});

test("the gate refuses a finisher on an unchecked verdict, which running the verb again answers", () => {
  assert.match(gate(), Pin.phrase(
    "It names a `dispositions-unchecked=` verdict too — no rule broke, but the verb could not read where a deferral was filed, `gh` unreachable or an issue unreadable: run the verb again for that fix-applier once `gh` answers (an issue that does not exist is unreadable too, and no re-run answers that one: the verb's stderr names it, and the record's issue number needs correcting); the tick offers no fix-applier for it.",
  ));
});

// The two record rules a fix-applier meets first, stated in each of the three
// places that describe the record: the checker's own header comment, step 2,
// and the fix-applier prompt block in run-team. The block is also pinned whole
// by the dispatch-block golden fixture; these pins name the rule that was lost.
const headerRecord = () => CHECK.stripGutter("//").between("The record:", "Rules — each broken one", "dispositions-check.mjs header").text;
const headerDeferRule = () =>
  CHECK.stripGutter("//").bullet("- An in-scope `survived` finding deferred passes only with `reason` one", "`remedy-outside-diff` passes only when", "dispositions-check.mjs header").text;
const fixApplierRecord = () =>
  Pin.of(memberPrompt("fix-applier", "review"), "the fix-applier member prompt").stripGutter(">").between("**The dispositions record**, the one your brief names the path of:", "Then write your report to the file your brief names", "the fix-applier member prompt").text;

const REFUTED_ENTRY =
  "A `refuted` entry carries `scope`, `claimKind` and `disposition` like every other entry, and a non-empty `reason` holding the evidence that reverses it; a missing or blank `reason` is a mismatch.";
const VERIFIED_CORRECT =
  "`disposition` has no `dismiss`: an in-scope `survived` finding verified correct, needing no change, is deferred with `reason` `false-rationale` and filed on the suggestion-band record";

test("a refuted entry needs scope, claimKind, disposition and a non-empty reason, in the header, step 2 and the fix-applier block", () => {
  for (const [where, slice] of [["header", headerRecord], ["step 2", recordStep], ["fix-applier block", fixApplierRecord]]) {
    assert.match(slice(), Pin.phrase(REFUTED_ENTRY), `${where} no longer states what a refuted entry needs`);
  }
});

test("the header's schema line says a refuted entry requires a non-empty reason", () => {
  assert.match(headerRecord(), Pin.phrase("required, non-empty, on a `refuted` entry"), "the header's reason field annotation no longer says a refuted entry requires a non-empty reason");
});

test("a finding verified correct is deferred false-rationale onto the suggestion-band record, in the header, step 2 and the fix-applier block", () => {
  for (const [where, slice] of [["header", headerDeferRule], ["step 2", recordStep], ["fix-applier block", fixApplierRecord]]) {
    assert.match(slice(), Pin.phrase(VERIFIED_CORRECT), `${where} no longer says how a verified-correct finding is recorded`);
  }
});

// The suggestion-band record is named by its title, never as a "closed" one.
// The sweep joins hard-wrapped lines first — a `//` or `#` comment marker and
// the whitespace around a line break read as one space — since a single-line
// grep misses the phrase wrapped across two comment lines.
test("nothing under plugin/ calls the suggestion-band record a closed one, across line wraps", () => {
  const files = readdirSync(REPO, { recursive: true })
    .filter((rel) => /\.(md|mjs|sh)$/.test(rel) && !rel.split("/").includes("node_modules"));
  assert.ok(files.includes(join("scripts", "dispositions-check.mjs")), "the sweep no longer reaches dispositions-check.mjs");
  const hits = files.filter((rel) =>
    /\bclosed\s+suggestion-band\s+record\b/i.test(readFileSync(join(REPO, rel), "utf8").replace(/\s*\n\s*(?:\/\/|#)?\s*/g, " ")));
  assert.deepEqual(hits, [], "a file under plugin/ still calls the suggestion-band record a closed one");
});
