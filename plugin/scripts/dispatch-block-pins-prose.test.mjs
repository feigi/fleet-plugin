// #400. Phase 2 hands the controller a run of `>` blocks and says to carry each
// one VERBATIM into every implementer prompt. Those blocks are not prose about
// the fleet — they are the only text a member ever sees, so a block that goes
// missing does not misinform the member, it silently stops governing it.
//
// Measured against `origin/main` before this file existed: deleting the
// enumerate-the-class block outright left the suite green, and no test file
// mentioned `Commit incrementally` at all. `member-prompt-prose.test.mjs` pins
// the identity block and the two `next-ticket` step handoffs;
// `tracker-block-copy-prose.test.mjs` pins the issue-read block by comparing it
// whole against `docs/agents/issue-tracker.md`. This file covers the blocks
// between those, and adds a content pin to the issue-read block for the one
// case the copy comparison cannot see: an identical gutting of BOTH files
// agrees with itself and passes there.
//
// SHAPE, and the thing to preserve when editing these tests. A positive regex
// over the whole member-prompt region is a vacuous pin — every word of every
// block is somewhere in it, so the assertion passes with the block it names
// deleted. Two things do the work instead:
//
//   1. Each block gets its OWN slice, bounded at both ends by the neighbouring
//      block's opening words. Slice size is what anchors a prose pin; assertion
//      count over a large slice does not.
//   2. Each pinned fragment is bound to the content beside it, never asserted
//      alone. Independent presence checks pin N facts and never the relation
//      between them: two such checks on `**step 6**` and `**step 7**` stayed
//      green through a swap of the two numbers, which told a member to open its
//      PR at the sizing checkpoint. So a rule is pinned together with the
//      command that carries it out, and an instruction together with the
//      alternative it excludes — a swap then reds where presence would not.
//
// A word blacklist was tried for this and rejected on measurement, so do not
// reach for one when this file next feels too loose: `doesNotMatch(/\bunless\b|
// \bexcept\b/i)` scoped to a pinned sentence does not kill its own mutant,
// broadened enough to kill it four trivial rewordings preserve the defect and
// stay green, and it reddens on a legitimate edit this repo is likely to make —
// a standing rule containing the word "unless" is exactly the kind of text that
// belongs in a verbatim block.
//
// THE CEILING THESE PINS HAVE, and it is why they are no longer alone. These
// are pins on text being PRESENT and adjacent. A sentence APPENDED inside a
// block, carving an exception out of a pinned rule, touches no pinned fragment
// and stays green; so does a meaning-changing clause inserted MID-GAP, inside
// one of the six `.{0,N}?` spans below (five assertions, one of which spans
// two gaps), wherever that gap still has headroom.
// Both shapes were measured green here.
//
// #1002 closed that half with a mechanism that is not a regex —
// `dispatch-block-golden-prose.test.mjs` holds a whole-block golden fixture for
// every block this file slices, and any insertion reds there because the block
// no longer equals its known-good copy. An LLM judge and a schema'd rule format
// were the two candidates and both were rejected: a nondeterministic gate, and
// a large change that still has to keep these blocks readable as prose.
//
// So read a green run here as "every pinned rule is still present and still
// adjacent", never as "no exception was added to these blocks" — that second
// claim belongs to the golden file, and these two are complementary. A golden
// red says the block changed; a red HERE says WHICH RULE was lost, which is the
// more actionable half and the reason none of these pins was deleted when the
// golden landed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

const START = "and each of these verbatim:";
const END = "Each rule in the enumerate-and-declare block";

// Scoped to the member-prompt region first, for the reason `indexOf` demands
// it: "You are ALREADY in worktree" also opens the fix-applier prompt further
// down the file, and a file-wide anchor would silently pin that one instead.
function region() {
  const at = RUN_TEAM.indexOf(START);
  assert.notEqual(at, -1, `phase 2's verbatim-blocks intro ('${START}') moved — update this test`);
  const end = RUN_TEAM.indexOf(END, at);
  assert.notEqual(end, -1, `the rationale anchor ('${END}') moved — update this test`);
  return RUN_TEAM.slice(at + START.length, end);
}

// Quote markers and `**` emphasis are stripped and whitespace collapsed before
// matching, so a pinned span may cross a `>` gutter or a bold boundary, and
// neither a rewrap nor an emphasis move is a failure. `phrase()` alone cannot
// do either: its `\s+` joins do not span a `>`, so every multi-line pin here
// would red on the wrap points rather than on the meaning, and it escapes `*`
// as a regex metacharacter, which makes the exact position of a `**` seam
// literal test surface. Measured: narrowing the bold span on the re-derive
// sentence to `**Re-derive the ticket's claims** against ...` — same words,
// same order, same meaning — reddened this file with a message claiming
// `origin/main` was no longer pinned, which was false. A false red on a
// meaning-preserving copy-edit is how a pin gets deleted by the next person to
// touch the prose.
//
// Only `**` is stripped, deliberately. A single `*` and `_` are live characters
// in this region — `*.test.mjs` globs and `SNAKE_CASE` identifiers inside code
// spans — so stripping those would corrupt the text the pins match against
// rather than normalize it. No `**` appears inside a code span here (measured);
// if one ever does, this is the line that has to learn about backticks.
const flatten = (s) =>
  s
    .split("\n")
    .map((l) => l.replace(/^>\s?/, ""))
    .join(" ")
    .replace(/\*\*/g, "")
    .split(/\s+/)
    .join(" ")
    .trim();

// Each block is bounded by the opening words of the block that follows it, so a
// block deleted outright reds on its own anchor and names itself. A closing
// phrase would anchor on today's last sentence instead, leaving anything
// appended after it outside the slice entirely.
const block = (from, to, what) => flatten(between(region(), from, to, what));

const worktreeBlock = () => block("You are ALREADY in worktree", "Read the issue with", "phase 2's worktree block");
const issueReadBlock = () => block("Read the issue with", "**Re-derive the ticket", "phase 2's issue-read block");
const rederiveBlock = () => block("**Re-derive the ticket", "Commit incrementally", "phase 2's re-derive block");
const commitBlock = () => block("Commit incrementally", "**Every scratch file", "phase 2's commit-incrementally block");
const scratchBlock = () => block("**Every scratch file", "**The `eval` kernel is shared", "phase 2's scratch-discipline block");
const evalKernelBlock = () => block("**The `eval` kernel is shared", "Your ticket names the cases", "phase 2's eval-kernel-discipline block");
const enumerateBlock = () => block("Your ticket names the cases", "Run `sizing-a-ticket`", "phase 2's enumerate-the-class block");

// The LAST block in the region has no following block to bound it, so it takes
// the region's own closing anchor instead — same two bounds as every slicer
// above, one level up. `region()` has already consumed END, which is why this
// one re-slices from START rather than calling it.
const sizingBlock = () => {
  const at = RUN_TEAM.indexOf(START);
  assert.notEqual(at, -1, `phase 2's verbatim-blocks intro ('${START}') moved — update this test`);
  return flatten(between(RUN_TEAM.slice(at + START.length), "Run `sizing-a-ticket`", END, "phase 2's sizing-and-PR block"));
};

test("the worktree block forbids a second worktree and carries the check that settles it", () => {
  const b = worktreeBlock();
  // Prohibition bound to the command that verifies it. Alone, "Do NOT create
  // another worktree" is an instruction a member cannot act on: what it needs
  // is the pair of `rev-parse` calls that tell it where it already is.
  assert.match(
    b,
    phrase("Do NOT create another worktree. Verify with `git rev-parse --git-dir` and `git rev-parse --git-common-dir`"),
    "the no-second-worktree rule is no longer carried with the rev-parse check that settles it",
  );
  assert.match(
    b,
    phrase("Skip the using-git-worktrees skill's Step 1"),
    "the block no longer names which step of using-git-worktrees the member skips",
  );
});

test("the issue-read block carries the command, the caveat that motivates it, and which text wins", () => {
  const b = issueReadBlock();
  // The `--json` form bound to the fields it must request. `gh issue view <N>`
  // on its own is satisfied by the very invocation the next sentence forbids.
  assert.match(
    b,
    phrase("Read the issue with `gh issue view <N> --json title,body,comments"),
    "the issue-read command no longer requests title, body and comments together",
  );
  // The caveat bound to its consequence. The defect is silent — exit 0 — so the
  // reason is the load-bearing half: a member told only "not `--comments`" has
  // no way to recognise the failure when it sees it.
  assert.match(
    b,
    /`gh issue view <N> --comments`.{0,200}?so the loss is silent/,
    "the bare --comments caveat is no longer bound to the silent-loss consequence it exists to explain",
  );
  // The precedence rule, and the direction it runs in. Asserting the two nouns
  // separately would pass with the precedence reversed.
  assert.match(
    b,
    phrase("The `## Agent Brief` comment is authoritative over the issue body"),
    "the block no longer says the Agent Brief outranks the issue body, or now says the reverse",
  );
  // The bail rule, bound to BOTH its timing and its trigger. This is the case
  // the header says these pins exist for, and it was measured open: the
  // sentence could be deleted from `run-team/SKILL.md` and
  // `docs/agents/issue-tracker.md` at once with the whole suite green — the
  // copy comparison in `tracker-block-copy-prose.test.mjs` agrees with an
  // identical gutting of both sides, and its only red was its own fixture
  // going stale, whose message instructs the edit that closes it.
  //
  // Bound this way rather than on the word "bail", which survives the inversion
  // that matters: "→ implement anyway" is the reading that puts an undecided
  // member into a tree it cannot reason about, and it reds here.
  assert.match(
    b,
    /Read the issue before touching code.{0,60}?still undecided or needing human hands you do not have.{0,40}?bail, name the cause, do not implement/,
    "the read-before-touching-code rule no longer sends an undecided member to bail instead of implementing",
  );
});

test("the re-derive block names origin/main as the reference, and says a contradicted criterion is a bail", () => {
  const b = rederiveBlock();
  // Reference bound to the alternatives it excludes. `origin/main` present
  // anywhere in the block satisfies a bare presence check even after the
  // sentence has been rewritten to send the member at its own working tree.
  assert.match(
    b,
    phrase("against `origin/main` before implementing — not the working tree, and not the ticket's line numbers"),
    "re-derivation is no longer pinned to origin/main against the working tree and the ticket's line numbers",
  );
  assert.match(
    b,
    phrase("Already fixed → report that with the commit and do NOT invent work"),
    "the already-fixed exit no longer tells the member to report the commit instead of inventing work",
  );
  // Bail bound to its trigger, and to the thing it is NOT. Swapping the two
  // halves — "is a thing to implement, not a bail" — is the reading that turns
  // a stale ticket into a shipped regression, and it reds here.
  assert.match(
    b,
    phrase("is a bail, not a thing to implement"),
    "a criterion the tree contradicts no longer reads as a bail, or now reads as a thing to implement",
  );
});

test("the commit-incrementally block carries the instruction with the loss that justifies it", () => {
  const b = commitBlock();
  assert.match(
    b,
    phrase("Commit incrementally as you go. Do not accumulate a large uncommitted diff"),
    "the commit-incrementally instruction is no longer carried verbatim to the member",
  );
  // The reason, bound to the instruction by the slice being this one paragraph.
  // `SKILL.md` calls this block not optional because a member that goes idle
  // leaves a diff the controller can neither see nor reap; a member told to
  // commit often, with no reason, treats it as style.
  assert.match(
    b,
    phrase("uncommitted work is invisible to the controller and effectively unrecoverable"),
    "the block no longer says why incremental commits are not optional — the stall consequence is gone",
  );
});

test("the scratch-discipline block names the shared injected root, the per-member path, and the false-measurement harm", () => {
  const b = scratchBlock();
  // The imperative itself, bound to the exclusion it carries. Every other
  // assertion here pins an explanatory sentence; measured on this PR's own
  // review, inverting this one clause — "goes under `<scratch>/impl-<N>/`,
  // never into the scratch root by itself" rewritten to "may go under ... or
  // straight into the scratch root — either is fine" — left all seven tests in
  // this file green, and all 298 in `*prose*.test.mjs` too. Rule 2 of this
  // file's header is exactly that: a rule is pinned together with the command
  // that carries it out, and an instruction together with the alternative it
  // excludes. The path and the prohibition are ONE span deliberately, so an
  // edit that keeps `<scratch>/impl-<N>/` and drops the "never" cannot pass.
  assert.match(
    b,
    phrase("copy you create goes under `<scratch>/impl-<N>/`, never into the scratch root by itself"),
    "the per-member path is no longer bound to the prohibition on writing into the scratch root itself",
  );
  // The root bound to it being shared and injected, not merely "use a subdir".
  // #581: an implementer is TOLD to use that root by its own system prompt
  // before SKILL.md ever reaches it, so the rule has to name the root and say
  // it is shared, or it reads as tidiness advice competing with an instruction
  // the member already received.
  assert.match(
    b,
    phrase("The scratchpad root your own system prompt names is injected unprompted into every dispatched member and is shared with every sibling"),
    "the block no longer names the injected scratch root as shared with every sibling member",
  );
  // The per-member path bound to the SAME derivation phase 1 already uses, not
  // a second scheme invented for this rule.
  assert.match(
    b,
    phrase("Derive your own path the same way `claim-ticket.sh` already derives per-ticket ports from the issue number (`postgres=16<N>`, `ollama=22<N>`): `<scratch>/impl-<N>/`, not a second scheme"),
    "the per-member scratch path is no longer derived the same way claim-ticket.sh derives per-ticket ports",
  );
  // Absence handled: nothing else creates this directory, so a member that
  // never `mkdir -p`s it has no path to write into.
  assert.match(
    b,
    phrase("`mkdir -p` it yourself the first time — nothing creates it for you"),
    "the block no longer tells the member to create its own scratch dir when absent",
  );
  // The harm bound to the mechanism, and stated as a false measurement, not
  // clutter — bare "keep things tidy" is the framing #581 says gets skipped
  // under time pressure, which is exactly when concurrency is highest.
  //
  // Two `phrase()` pins over the mechanism's two halves, NOT one regex spanning
  // both with a `.{0,N}?` cap between them. Measured on this PR's own review:
  // the cap was `{0,400}` and today's wording already spends 303 of it, so one
  // added clause in that sentence reds the pin — with a message claiming the
  // mechanism was removed, when it was extended. A false red that misdirects is
  // how a pin gets deleted by the next person to touch the prose (see the
  // `flatten` comment above for the same failure). Widening the cap only moves
  // the cliff; a contiguous span has no character budget to approach.
  assert.match(
    b,
    phrase("The harm is a false measurement, not untidiness: a mutation harness writes a broken copy of a file, measures against it, then restores from `.orig`"),
    "the harm is no longer stated as a false measurement bound to the mutation harness that produces it",
  );
  assert.match(
    b,
    phrase("one filename collision away from restoring a sibling's `.orig` over their own file, or measuring a \"clean baseline\" that is actually a sibling's mutant — silently, indistinguishable from a real result"),
    "the filename collision is no longer bound to the false result it produces, or to that result being indistinguishable from a real one",
  );
  // Explicitly NOT the worktree isolation rule — folding the two together is
  // the thing #581's brief rules out.
  assert.match(
    b,
    phrase("This is not the worktree isolation rule: `claim-ticket.sh` already gives you your own worktree"),
    "the scratch-discipline block no longer distinguishes itself from worktree isolation",
  );
});

// #1447. This block is the only one in the region whose hazard leaves NO trace
// in the repo: a shared-kernel variable collision writes no file, so `git
// status`, `worktree-audit.sh` and the instrument re-check all stay green
// through it. That is why the rule has to reach the member as text — there is
// no gate behind it to catch a member that never read it.
test("the eval-kernel block binds the sharing fact to all three of its rules, and to the citation that proves it", () => {
  const b = evalKernelBlock();
  // The imperative bound to BOTH exclusions it carries. Split into two
  // independent presence checks ("namespace" somewhere, "relative path"
  // somewhere), this passes with either rule deleted — the sharing premise and
  // the two duties it implies are one span deliberately.
  assert.match(
    b,
    phrase("The `eval` kernel is shared with every sibling member and with the controller that dispatched you — namespace every binding you make in it, and never hand it a relative path"),
    "the shared-kernel premise is no longer bound to the namespacing duty and the no-relative-path duty it implies",
  );
  // The naming rule bound to the counter-example. `WT` is not decoration: it is
  // the exact bare name the reported collision happened on, so a member reading
  // this sees the shape it must not repeat, not an abstract "use good names".
  assert.match(
    b,
    phrase("prefix what you bind with your own member number (`WT_1447`, never `WT`)"),
    "the member-prefixed binding rule no longer shows the bare name it excludes",
  );
  // The cwd fact bound to WHY it cannot be fixed the way `bash` calls are. A
  // member that knows only "use absolute paths" reaches for eval's cwd
  // parameter, finds none, and improvises.
  assert.match(
    b,
    /The kernel's cwd is the MAIN CHECKOUT, not your worktree.{0,60}?unlike `bash`, `eval` takes no `cwd` parameter at all/,
    "the eval-cwd hazard is no longer bound to the absence of a cwd parameter that would otherwise fix it",
  );
  // The measured resolution, bound to the tree it landed in AND the tree it
  // did not. This is the half of #1447 that WAS independently visible (the
  // stray `work/` tree), so the evidence stays attached to the rule it
  // justifies. Deliberately not a literal checkout path: `install-root-audit`
  // rule (b) forbids one in prose under `plugin/skills/` (ADR 0003), and this
  // block reaches members on machines where such a path is simply wrong.
  assert.match(
    b,
    /a bare `work\/scripts` in a member's cell resolved under the main checkout root, never under that member's own worktree/,
    "the measured relative-path resolution into the main checkout is gone, or no longer contrasts with the worktree it skipped",
  );
  // `reset` bound to its blast radius. A member reads `reset: true` as
  // house-keeping on its OWN kernel; the prohibition only makes sense with the
  // sibling damage stated beside it.
  assert.match(
    b,
    phrase("never call `eval` with `reset: true`, which is destructive to every other member sharing that backend session"),
    "the reset prohibition no longer names the sibling damage that is its whole reason",
  );
  // The citation, bound to the keying it is evidence for. Quoted from
  // `omp://tools/eval.md` so the next editor can re-check the claim at its
  // source rather than trusting this file.
  assert.match(
    b,
    /keyed by `python:\$\{sessionId\}`, normalized cwd and interpreter.{0,80}?Parent and ordinary task subagents may share an inherited eval executor id/,
    "the kernel-keying claim is no longer bound to the upstream sentence that establishes subagents inherit the executor id",
  );
  // THE ACCEPT CASE. Every assertion above pins something the block must
  // FORBID; a rule this emphatic is one edit away from being read as "do not
  // use the kernel", which would be wrong — eval's own `agent()` children are
  // isolated by construction, and per-member use is fine once namespaced. This
  // pin is what keeps the permission in the block alongside the prohibitions.
  assert.match(
    b,
    phrase("Using the kernel is not the defect, and this is not the `isolated` question — the bare name, the relative path and the reset are"),
    "the block no longer states what it permits, so its prohibitions read as a ban on using the eval kernel at all",
  );
});

test("the enumerate-the-class block carries all three of its halves, each with its own instruction", () => {
  const b = enumerateBlock();
  // Half one: enumerating bound to declaring. Enumerating privately and fixing
  // the named cases is the exact failure the block exists to stop, and it
  // satisfies a pin on "enumerate" alone.
  assert.match(
    b,
    /enumerate every member of that class.{0,120}?say which you cover and which you deliberately leave/,
    "enumerating the class is no longer bound to declaring what is covered and what is left",
  );
  // The ordering, as one span: prose FIRST, mechanism second. Two independent
  // presence checks pass with the two sources swapped, which is precisely the
  // enumeration order that missed a case its own ticket named in passing.
  assert.match(
    b,
    phrase("Build that list from the ticket's own prose first, then from the mechanism"),
    "the enumeration order no longer runs from the ticket's prose to the mechanism",
  );
  // Half two: the false-positive question bound to the test it demands. The
  // question alone is answerable on paper; the test is what makes it evidence.
  assert.match(
    b,
    /what can this change wrongly REFUSE\?.{0,300}?leave one test behind that feeds it input it must ACCEPT/,
    "the wrongly-REFUSE half no longer asks for a test feeding input the change must accept",
  );
  // Half three, and the one most easily read as a restatement of half one: it
  // is about the EDIT, not the bug class. Bound to the instruction that makes
  // it actionable, or it degenerates into advice.
  assert.match(
    b,
    phrase("The third is about YOUR EDIT: enumerate what your change newly does"),
    "the third half no longer distinguishes the edit's own effects from the bug class",
  );
  assert.match(
    b,
    phrase("Ask which of the ticket's own acceptance criteria your restructuring could newly violate, and test that path"),
    "the third half no longer names the acceptance criteria a restructuring can newly violate",
  );
  // The closing rule, bound to what a green suite does and does not prove.
  assert.match(
    b,
    /check the suite can even see the mode you changed.{0,400}?A green suite is evidence only about the paths it exercises/,
    "the suite-visibility rule is no longer bound to what a green suite is evidence of",
  );
});

test("the sizing block makes the verdict checkable — signal beside it, and the run dated in the report", () => {
  // #1070. The controller's whole read of this covariate is one `Sizing:` line,
  // and a line typed in before `sizing-a-ticket` ever ran is byte-identical to
  // one the skill produced. Measured on a member that wrote the verdict first
  // and caught itself afterwards; nothing in the pipeline would have.
  //
  // Two halves, pinned as spans rather than as presence, for this file's
  // standing reason: the instruction to emit a verdict already existed and was
  // already pinned (tier-outcomes-header.test.mjs), and every mutation that
  // matters here leaves that instruction intact while gutting what makes it
  // checkable.
  const b = sizingBlock();

  // Half one: the verdict bound to the signal it must carry. A pin on
  // `Sizing: light`/`Sizing: heavy` alone is satisfied by the pre-#1070 wording.
  assert.match(
    b,
    /`Sizing: light` or `Sizing: heavy`, and name the signal it turned on beside it/,
    "the sizing line no longer has to carry the signal the verdict turned on",
  );
  // …and the consequence, which is what a spliced "the verdict alone is fine"
  // has to contradict rather than merely sit beside.
  assert.match(
    b,
    phrase("A verdict with nothing beside it is indistinguishable from a guess, and is recorded as one"),
    "a bare verdict no longer costs the member anything, so the signal is advisory",
  );
  // The form the signal takes, bound to its reason. Without the reason this
  // reads as style advice; with it, pasting the skill's output is the named
  // wrong answer — which is the half that keeps this line alive across a
  // `sizing-a-ticket` output change.
  assert.match(
    b,
    phrase("never paste the skill's output, because that format will change and this line has to outlive it"),
    "the signal's form is no longer held independent of the sizing skill's own output layout",
  );

  // Half two: the report's ordering clause, bound to what it is ordered
  // AGAINST. "Report when you ran it" alone is satisfied by a member reporting
  // a wall-clock time nobody can compare the PR against.
  assert.match(
    b,
    phrase("the head SHA, and WHEN you ran `sizing-a-ticket` relative to opening the PR"),
    "the report no longer has to date the sizing run against the PR being opened",
  );
  // The direction, as one span. `before` and `after` are a one-word splice, and
  // a pin that matched either would pass on the exact defect this ticket is.
  assert.match(
    b,
    phrase('"ran sizing-a-ticket at step 6, before `gh pr create`"'),
    "the worked example no longer shows the sizing run preceding the PR, so the clause no longer has a direction",
  );
  assert.match(
    b,
    phrase("an unreported ordering costs the covariate"),
    "omitting the ordering clause no longer costs the member anything, so the clause is optional in practice",
  );
});

test("a rewrapped block still matches — these pins refuse drift, not reflow", () => {
  // The ACCEPT side. Re-wrapping a paragraph is not drift, and a pin that
  // reddened on it would be deleted by the next person who reflowed this file.
  //
  // What this test uniquely holds open, measured rather than assumed: deleting
  // `flatten`'s gutter strip reds EVERY test in this file, not just this one —
  // every block pin above already spans a `>`. So all of them hold the
  // normalization open at TODAY'S wrap points, and this is the only test that
  // exercises it at wrap points the file does not currently contain. A
  // `flatten` that handled today's breaks by accident would survive every one.
  //
  // Stated as a property, not a count, deliberately. This comment said "six"
  // and "the five of them" until the PR one block below it added a seventh and
  // did not update them — a count is false the moment the next test lands, and
  // this one rotted inside the single PR that measured it.
  //
  // The fixture is DERIVED from the live block, never a quoted line. Measured:
  // the first draft quoted one, and then any reword of that line reddened this
  // test on the fixture guard rather than on the pin — an accept control that
  // reddens on the edits it exists to accept is worse than none.
  const raw = between(region(), "Commit incrementally", "**Every scratch file", "phase 2's commit-incrementally block");
  // Trimmed back to the BLOCK, not merely to the last non-space character.
  // `between`'s `to` anchor is the next block's opening words, so `raw` runs
  // past this block's last line through the blank line and onto the next
  // block's `>` marker. Measured on the first draft, which trimmed `/\s+$/`:
  // that leaves the `>` as the last character, the trailing empty word rejoins
  // as a second space, and the splice merges the two blocks into one line —
  // rewrapping the right words inside a blockquote that is no longer
  // well-formed. It also made the staleness guard below VACUOUS, since the
  // corrupted tail differed from `raw` no matter how the block was wrapped.
  const body = raw.replace(/\n*>?\s*$/, "");
  // Re-wrapped at a narrower width than the file uses, so every wrap point
  // lands somewhere different from today's. Wrapping at word boundaries, not
  // one word per line: an unconditional break would split the slice's own
  // opening anchor and red this test on the anchor rather than on the pin.
  const words = body.replace(/\n>\s?/g, " ").split(/\s+/).filter(Boolean);
  const lines = words.reduce((acc, w) => {
    const last = acc[acc.length - 1];
    if (last && `${last} ${w}`.length <= 45) acc[acc.length - 1] = `${last} ${w}`;
    else acc.push(w);
    return acc;
  }, []);
  // The separator re-appended explicitly, so the next block still opens its own
  // paragraph. With `body` bounded to the block this guard is load-bearing
  // again: it now reds when the source block is already at this width.
  const narrow = lines.join("\n> ") + "\n\n> ";
  assert.notEqual(narrow, raw, "the rewrap fixture no longer changes the block's wrapping — update it");
  // Replacer function, not a replacement string: `$&`, `$'` and `` $` `` are
  // interpreted in the latter. The commit block carries no `$` today, which is
  // exactly the kind of thing that stops being true without anyone noticing.
  const flat = flatten(between(RUN_TEAM.replace(raw, () => narrow).slice(RUN_TEAM.indexOf(START)), "Commit incrementally", "**Every scratch file", "rewrapped commit block"));
  assert.match(flat, phrase("Commit incrementally as you go. Do not accumulate a large uncommitted diff"));
  assert.match(flat, phrase("uncommitted work is invisible to the controller and effectively unrecoverable"));
});
