// #1002. Phase 2 hands the controller a run of `>` blocks and says to carry
// each one VERBATIM into every implementer prompt; the Reviewers section does
// the same for the fix-applier prompt and for the halt-cause text it gives the
// finisher. Those blocks are the only text a member ever sees.
//
// The presence pins on them — `dispatch-block-pins-prose.test.mjs`,
// `member-prompt-prose.test.mjs`, `stash-prohibition-prose.test.mjs`,
// `fix-applier-correction-rules-prose.test.mjs` — cover the LOCATION half and
// only that half. A block deleted, gutted or moved out of the `>` quoting reds
// there. A sentence APPENDED inside a block, carving an exception out of a rule
// already pinned in it, leaves every pinned fragment byte-identical and stays
// green; so does a meaning-changing clause inserted MID-GAP, between the two
// anchors of an `<anchor A>.{0,N}?<anchor B>` span, wherever that gap still has
// headroom. Both shapes are measured, not assumed — four mutants of the first
// and four of the second, each recorded on #1002.
//
// MECHANISM, and #1002's triage ruling. A whole-block golden fixture. Not a
// tighter regex: `doesNotMatch(/\bunless\b|\bexcept\b/i)` was tried against this
// exact question and failed all three of its controls — scoped to the pinned
// sentence it did not kill its own mutant, broadened enough to kill it four
// rewordings preserved the defect, and it reds on a legitimate edit, since a
// standing rule containing the word "unless" is exactly the kind of text that
// belongs in a verbatim block. Not an LLM judge and not a schema'd rule format
// either: both were considered and rejected on #1002, the first for buying
// semantics at the price of a nondeterministic gate, the second as a large
// change that still has to keep these blocks readable as prose. What settles it
// is what the blocks ARE: verbatim dispatch text, whose whole purpose is
// reaching the member unchanged. The assertion that fits that is equality
// against a known-good copy, not the presence of fragments inside it.
//
// THE COST IS INTENDED. Because the expected text lives HERE, a legitimate edit
// to a block reds until its fixture is updated in the same change. These blocks
// are change-controlled by construction, and that re-blessing is the review
// point a presence pin does not have. Every failure message below says so and
// says where, so the next editor updates the fixture deliberately rather than
// reading the red as breakage.
//
// COMPLEMENTARY TO THE PRESENCE PINS, never a replacement, and none of them was
// deleted for this. A golden red says "this block changed"; a fragment red says
// WHICH RULE was lost, and that is the more actionable half. Dropping a fragment
// pin because this file now covers its block would trade a message naming the
// rule for a diff the reader has to read.
//
// THE FIXTURES ARE OWNED HERE, never derived from `SKILL.md` at test time. A
// fixture read out of the instruction file compares that file to itself and
// asserts nothing — which is the one way to write this mechanism so that it
// passes unconditionally.
//
// SCOPE. Every quote run in phase 2's verbatim region and in the Reviewers
// section has a fixture, and the two coverage tests below are what keep that
// true as blocks are added — a block this file does not name is a block a
// carve-out can be appended to unseen. Prose that is NOT verbatim dispatch text
// is deliberately left out: the golden form is justified by these blocks being
// change-controlled, and that argument does not carry to ordinary prose, where
// the same ceiling stays recorded and open in
// `immutable-body-claim-prose.test.mjs`. The copies of these blocks in other
// files are a separate question too — `docs/agents/issue-tracker.md` reproduces
// the issue-read block, and `tracker-block-copy-prose.test.mjs` compares the two
// (#374 owns that comparison's own fixture; nothing here touches it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, phrase, quoteBlock, quoteBlocks } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

const START = "and each of these verbatim:";
const END = "Each rule in the enumerate-and-declare block";

// Both surfaces are sliced before any opener is looked for, for the reason
// `quoteBlock`'s uniqueness assert would otherwise fire: "You are ALREADY in
// worktree" opens BOTH phase 2's worktree block and the fix-applier prompt, so a
// file-wide lookup would find two blocks and pin neither. `between` keeps its
// start anchor, hence the `slice` — the region is what comes AFTER the intro
// line, or that line's own words would read as part of the first block.
//
// Each takes the text to slice, defaulting to the real file, so the mutation
// controls below can re-run the whole extraction against a modified copy instead
// of asserting against a hand-built imitation of it.
const region = (text = RUN_TEAM) =>
  between(text, START, END, "phase 2's verbatim-blocks region").slice(START.length);
const reviewers = (text = RUN_TEAM) =>
  between(text, "### Reviewers", "#### Fallback: hand-dispatched reviewer", "run-team's Reviewers section");

// Wrapping is normalized away on both sides, and nothing else is.
//
// Wrapping, because every editor that touches `SKILL.md` reflows it, and a pin
// that reds on a rewrap is one the next person weakens or deletes. `**`
// emphasis, punctuation and word choice are NOT normalized: they are the
// verbatim text itself. This is the one place where the golden is deliberately
// stricter than the presence pins beside it, which do strip `**` — they have
// to, because a `**` seam inside a regex-matched span makes the seam's exact
// position test surface and reds with a message claiming some rule was lost. A
// golden cannot misdirect that way: its message says the block changed, which a
// moved `**` is.
//
// Paragraph boundaries are kept. A quote line with no words on it is a paragraph
// break the member reads, so merging two paragraphs is a change to the block and
// not a rewrap. Any such line closes the paragraph whatever its own gutter says,
// which is also what keeps a gutter left with a trailing space (`> `) from
// silently joining two paragraphs — the same false green `prose-pin.mjs`'s
// `paragraph` matches `\n[ \t]*\n` to avoid.
//
// NESTING DEPTH IS STRUCTURE, not text, and this is the half a plain
// one-level strip gets wrong. The fix-applier prompt quotes a refuter prompt
// inside itself at `> >`; strip one level and those inner `>` markers become
// ordinary words, so their position depends on where the OUTER block happens to
// wrap — a pure reflow of that prompt then reds, which is exactly the false red
// that gets a pin deleted (measured: the first draft of this file did that, and
// the fix-applier fixture reddened on a 45-column rewrap of identical words).
// Strip every level, count it instead, and re-emit the depth as a marker, and
// the comparison is reflow-proof while un-nesting that prompt — which changes
// what the fix-applier pastes — still reds.
//
// Depth is RELATIVE to the block's own outermost level, so how many gutter
// levels the FIXTURE carries does not matter: a block re-blessed by copying it
// out of `SKILL.md` with its `> ` markers left on normalizes the same as one
// with them taken off, while the nesting INSIDE it is preserved either way.
// Measured over lines that carry words, never over the breaks — a break written
// as a bare newline rather than a bare `>` would otherwise drag the base level
// down and re-read the whole block as one level of nesting.
const norm = (text) => {
  const rows = text.split("\n").map((line) => {
    const gutter = line.match(/^(?:>[ \t]?)*/)[0];
    return { depth: (gutter.match(/>/g) ?? []).length, words: line.slice(gutter.length).trim() };
  });
  const written = rows.filter((r) => r.words !== "");
  const base = written.length === 0 ? 0 : Math.min(...written.map((r) => r.depth));
  const paragraphs = [];
  for (const { depth, words } of rows) {
    const open = paragraphs[paragraphs.length - 1];
    if (words === "") {
      if (open) open.closed = true;
      continue;
    }
    if (open && !open.closed && open.depth === depth) open.words.push(words);
    else paragraphs.push({ depth, words: [words], closed: false });
  }
  return paragraphs
    .map((p) => `${"> ".repeat(Math.max(p.depth - base, 0))}${p.words.join(" ").split(/\s+/).join(" ")}`)
    .join("\n\n");
};

// The fixtures. One entry per quote run, in source order — the coverage tests
// below hold both halves of that: one per run, and in that order.
//
// `opener` is the block's identifier: the words it BEGINS with, which is what
// makes it name the block rather than merely occur in it. `golden` is the block
// as it must reach the member, gutter stripped, wrapped however `SKILL.md`
// happened to wrap it when the fixture was last blessed — `norm` makes that
// wrapping irrelevant on both sides.
const REGION_BLOCKS = [
  {
    what: "phase 2's unattended-member identity block",
    opener: "**You are an unattended fleet member.**",
    golden: [
      "**You are an unattended fleet member.** No maintainer is reachable, no user",
      "will answer you, and no approval gate will ever clear for you. Report to the",
      "controller and to nobody else. Where a skill offers a maintainer-present step",
      "and an unattended one, yours is the unattended one.",
    ],
  },
  {
    what: "phase 2's worktree block",
    opener: "You are ALREADY in worktree",
    golden: [
      "You are ALREADY in worktree `<abs-path>` on branch `<branch>`. Do NOT create",
      "another worktree. Verify with `git rev-parse --git-dir` and",
      "`git rev-parse --git-common-dir`. Skip the using-git-worktrees skill's Step 1.",
    ],
  },
  {
    what: "phase 2's distilled-brief block",
    opener: "Here is the ticket's distilled brief",
    golden: [
      "Here is the ticket's distilled brief, already read once in phase 0 step 4 —",
      "title, plus whichever of the `## Agent Brief` comment or the issue body",
      "carries the ticket's actual brief, and its `Out of scope`, pasted verbatim:",
      "`<distilled brief>`. Skip the fetch below if this already answers what you",
      "need.",
    ],
  },
  {
    what: "phase 2's issue-read block",
    opener: "Read the issue with",
    golden: [
      "Read the issue with `gh issue view <N> --json title,body,comments --jq '.title, .body, (.comments[]|.author.login + \": \" + .body)'`.",
      "Not bare `gh issue view <N> --comments` — non-interactively that prints only",
      "the comments, and nothing at all when there are none, dropping the title and",
      "body either way, exit 0, so the loss is silent. The `## Agent Brief` comment",
      "is authoritative over the issue body. Read the issue **before",
      "touching code**: with the repo in front of you, still undecided or needing",
      "human hands you do not have → bail, name the cause, do not implement.",
    ],
  },
  {
    what: "phase 2's re-derive block",
    opener: "**Re-derive the ticket's claims",
    golden: [
      "**Re-derive the ticket's claims against `origin/main` before implementing** —",
      "not the working tree, and not the ticket's line numbers, which drift. Phase 0",
      "runs a cheap version of this check, so what reaches you is what a `grep` could",
      "not settle; you have the tree, so you are the backstop. Already fixed → report",
      "that with the commit and do NOT invent work. An acceptance criterion the tree",
      "now **contradicts** is a bail, not a thing to implement: say which, and stop.",
    ],
  },
  {
    what: "phase 2's commit-incrementally block",
    opener: "Commit incrementally as you go",
    golden: [
      "Commit incrementally as you go. Do not accumulate a large uncommitted diff — if",
      "you stop for any reason, uncommitted work is invisible to the controller and",
      "effectively unrecoverable.",
    ],
  },
  {
    what: "phase 2's stash-prohibition block",
    opener: "**Never `git stash` or `git stash pop` to shelve",
    golden: [
      "**Never `git stash` or `git stash pop` to shelve your own progress — take a",
      "WIP commit instead: `git commit -m wip`, then amend it or",
      "`git reset --soft HEAD^` once you have something real to commit.** The",
      "stash stack is repo-global, not per-worktree or per-session — the same",
      "`refs/stash` is shared by every worktree, the main checkout, and every",
      "concurrent member. A bare pop takes whichever entry is on top, from any",
      "worktree, and it is **silent** about it — rc 0, no error — exactly when the",
      "tree receiving it is clean on the affected paths, which is the moment you",
      "would assume it is safe; it refuses loudly only when that tree is already",
      "dirty on them. A bare `git stash` (push) does **not** reach into a sibling",
      "worktree's uncommitted work — that half is unfounded, it acts on your own",
      "tree only — so the hazard is entirely on the pop side: yours can take a",
      "sibling's entry, or a sibling's pop can take yours. Nothing partitions the",
      "stack the way the scratch root below is partitioned — one `refs/stash` per",
      "repository, with no per-member address for it — so this prohibition is the",
      "whole of the protection, not a stopgap standing in for one.",
    ],
  },
  {
    what: "phase 2's scratch-discipline block",
    opener: "**Every scratch file",
    golden: [
      "**Every scratch file, fixture or mutation copy you create goes under",
      "`<scratch>/impl-<N>/`, never into the scratch root by itself.** The scratchpad",
      "root your own system prompt names is injected unprompted into every dispatched",
      "member and is shared with every sibling running this session — `SKILL.md` does",
      "not choose that root and cannot keep it from being handed to you, so writing to",
      "it directly, not a subdir under it, is the defect. Derive your own path the",
      "same way `claim-ticket.sh` already derives per-ticket ports from the issue",
      "number (`postgres=16<N>`, `ollama=22<N>`): `<scratch>/impl-<N>/`, not a second",
      "scheme, and `mkdir -p` it yourself the first time — nothing creates it for you.",
      "The harm is a false measurement, not untidiness: a mutation harness writes a",
      "broken copy of a file, measures against it, then restores from `.orig`, and",
      "two members in one directory are one filename collision away from restoring a",
      "sibling's `.orig` over their own file, or measuring a \"clean baseline\" that is",
      "actually a sibling's mutant — silently, indistinguishable from a real result.",
      "This is not the worktree isolation rule: `claim-ticket.sh` already gives you",
      "your own worktree, and the scratch root sits deliberately outside every",
      "worktree so a harness never dirties one — nothing partitions the scratch root",
      "itself but this rule.",
    ],
  },
  {
    what: "phase 2's enumerate-the-class block",
    opener: "Your ticket names the cases",
    golden: [
      "Your ticket names the cases it was written from. **Before implementing, enumerate",
      "every member of that class — including any the ticket names only in passing — and",
      "say which you cover and which you deliberately leave** — a guard on one path",
      "has siblings, a predicate has other inputs, a check on a directory has",
      "subdirectories. Fixing exactly the named cases is how a fix ships without",
      "closing its own ticket.",
      "",
      "Build that list from **the ticket's own prose first**, then from the mechanism.",
      "A case the body names in passing is still a named case, and enumerating from",
      "first principles is how you miss it. Then ask the other half: **what can this",
      "change wrongly REFUSE?** A new guard's false-positive class is not its",
      "false-negative class, and a suite that only feeds it valid input pins neither —",
      "so leave one test behind that feeds it input it must ACCEPT.",
      "",
      "**Both halves above are about the bug class. The third is about YOUR EDIT:",
      "enumerate what your change newly does, not only what the code already did",
      "wrong.** Moving, reordering or wrapping a statement has effects the ticket",
      "never mentions — the last command of a script sets its exit status, a",
      "relocated line changes what `set -e` covers, a hoisted guard changes what runs",
      "first. **Ask which of the ticket's own acceptance criteria your restructuring",
      "could newly violate, and test that path.** Measured: #265 required \"no path in",
      "the script exits 1\", and the fix for it moved a guard to the file's end,",
      "regressing the default dry run from exit 0 to exit 1 — the ticket's exact",
      "defect, relocated onto the path nobody tested. The implementer had enumerated",
      "every exit-1 path and declared two it was leaving; all of them were",
      "pre-existing, and none was the one its own edit created.",
      "",
      "**Then check the suite can even see the mode you changed.** That regression",
      "shipped under 616 green tests because all eight call sites passed the same",
      "flag, so the default mode had no test at all. A green suite is evidence only",
      "about the paths it exercises.",
    ],
  },
  {
    what: "phase 2's sizing-and-PR block",
    opener: "Run `sizing-a-ticket`",
    golden: [
      "Run `sizing-a-ticket` for the process path and proceed on **either row** —",
      "heavy is never a bail reason, and that skill owns the fleet's heavy-row entry",
      "point, whose condition you are. A brief that will not support a plan is the",
      "undecided case: bail and name the cause, never a heavy row. Selection and",
      "claiming are already done (`next-ticket` steps 1-5), so you start at",
      "`next-ticket` **step 6**, which is that sizing run.",
      "",
      "Then `next-ticket` **step 7**: rebase, re-run tests, push, `gh pr create` with",
      "`Closes #N` in the body, then `gh pr edit --add-label` as its own command",
      "carrying exactly one release label — `patch`/`minor`/`major`, the *label*, not",
      "the branch *type*. **Never fold `--label` into the create**: a create that",
      "outruns your tool timeout is backgrounded with the PR already open, its flags",
      "unapplied and no exit status for you to react to, so the label goes missing",
      "and every later gate still reads the PR as correctly opened. Separate, the",
      "label write has its own exit status and fails loudly. **Put your step-6 sizing verdict in the PR",
      "body on its own line, `Sizing: light` or `Sizing: heavy`, and name the signal",
      "it turned on beside it** — `Sizing: heavy — >3 implementation files, arg.mjs",
      "plus four consumers`. Your own words, one clause: never paste the skill's",
      "output, because that format will change and this line has to outlive it. A",
      "verdict with nothing beside it is indistinguishable from a guess, and is",
      "recorded as one. The controller reads this line as a difficulty covariate when",
      "it rules your review, and the PR body is the only place it survives your exit.",
      "**Report to the controller the PR number, the head SHA, and WHEN you ran",
      "`sizing-a-ticket` relative to opening the PR** — \"ran sizing-a-ticket at step",
      "6, before `gh pr create`\" if you kept that order, and say so plainly if you did",
      "not, including if the `Sizing:` line was written before the run and corrected",
      "after. Nothing in the PR body separates a measured verdict from one typed in",
      "early; that clause is the only thing that does, and an unreported ordering",
      "costs the covariate. Then exit. Never apply `ready-to-merge`, never merge.",
    ],
  },
];

const REVIEWER_BLOCKS = [
  {
    what: "the fix-applier prompt",
    opener: "You are ALREADY in worktree",
    golden: [
      "You are ALREADY in worktree `<abs-path>`. Do NOT create another worktree. The",
      "review is done and these findings are its output — do not re-review, do not",
      "dispatch specialists.",
      "",
      "Read `$(~/.fleet/bin/fleet-run --root)/commands/review-and-fix.md` and run **steps 2, 3",
      "and 5 only**: split apply-now/defer, commit, push, file every deferral as its",
      "own issue with the label the finding's state calls for. Skip step 1 — the",
      "review already ran — and steps 4 and 6: the controller owns the CI wait and",
      "dispatches the finisher.",
      "",
      "**Every factual claim your diff restates needs a settling command run",
      "against the tree first** — the issue body is a lead, never a citation.",
      "**No positional references** (`the closing/second/last X`); name the thing",
      "semantically. **Never write a COUNT or a tally into prose; state the",
      "property instead** — unless it is a past-tense record of a measurement you",
      "performed, which stays as written; a present-tense claim about a live",
      "property must be restated as a property (`every other test in the file`),",
      "true at any count.",
      "",
      "**Apply `survived` findings. A finding in `unverified` whose refuters ran and",
      "crashed always defers** — and which of the two it is, you read off",
      "`refutersDispatched`, never off severity and never off an empty vote list:",
      "above zero with nothing surviving means every refuter dispatched against it",
      "died, and at `critical` that is every one of them. Severity records how much a",
      "finding would matter if true, never whether anything looked. Say *in the",
      "deferral* that its refuters crashed rather than that it went unchecked — the",
      "run is resumable and I hold the tool that resumes it, so a deferral that names",
      "the crash can still be re-verified. **A `suggestion` is also in `unverified`,",
      "for a different reason — `refutersDispatched` of zero, the 0-refuter budget",
      "the workflow gives that band by policy — and the rule below, not this one,",
      "covers it.**",
      "",
      "**A `suggestion` is budgeted 0 refuters, so it is unchecked until you check",
      "it.** For each one, first decide scope: is it inside the scope of the PR's own",
      "ticket, or a different piece of work? **Out of scope → defer and file, never",
      "apply.** **In scope → dispatch ONE refuter** against the finding before",
      "touching the tree, biased to refuse:",
      "",
      "> Try to REFUTE this finding. Default to refuted=true if uncertain. Verify by",
      "> RUNNING something — compile it, run the test, apply the mutation. Do not",
      "> reason your way to agreement. Observe that run synchronously — run the",
      "> command, wait for it, read its exit code. Never poll a log file for a",
      "> completion marker: prefer ONE blocking run to a poll loop, and treat its",
      "> return as permission to look, never as the answer. Reading a log the run has",
      "> already finished writing is fine; waiting on one is not. If you match a test",
      "> reporter's own output, accepting both `ℹ` and `#` is necessary but NOT",
      "> sufficient — strip SGR escapes first as well. node's prefix moves with the",
      "> node version and with whether stdout is a TTY, and color wraps the whole line",
      "> so it begins with ESC and no prefix anchor matches at all, which returns",
      "> empty at exit 0 — indistinguishable from a hung run and from a run of zero",
      "> tests. For an uncolored baseline use `env -u FORCE_COLOR`; `FORCE_COLOR=`",
      "> empty still enables color, so it is not a control. State your search scope",
      "> AND what your pattern would have missed. A grep over one ref does not",
      "> support a claim about history; a pattern built from the token a diff removed",
      "> does not support a claim that the category is empty. A failure injection with",
      "> no positive control has produced NO result, never a negative one. Before you",
      "> read an injected fault — an env var, an argv word, a mutant — as having had",
      "> no effect, prove the injection reached the child: one run whose output",
      "> differs with it present versus absent, or the child echoing the injected",
      "> value back. Uncontrolled, the cell is unrun — say so in your verdict instead",
      "> of reporting a no-effect result. Build such an invocation as an array",
      "> expanded braced and quoted —",
      "> `cfg=(SETB=1 BADJ=1); env \"${cfg[@]}\" sh ./probe.sh` — or inline the",
      "> assignments literally — `env SETB=1 BADJ=1 sh ./probe.sh`; NEVER from an",
      "> unquoted scalar — `cfg=\"SETB=1 BADJ=1\"; env $cfg sh ./probe.sh` — which under",
      "> zsh passes ONE argument, sets a variable literally named `SETB` to",
      "> `1 BADJ=1`, never sets `BADJ` at all, and still exits 0. `env $cfg[@]` is not",
      "> the portable spelling either: measured, bash word-splits it into `SETB=1`",
      "> and `BADJ=1[@]`, so the injection variable is set to a corrupted value,",
      "> while zsh behaves exactly as with the bare `$cfg` — `BADJ` never set,",
      "> exit 0. Everything you",
      "> write — mutants, fixtures,",
      "> scratch repos — goes under `<scratch>/pr<N>/<finding>/` and nowhere else;",
      "> the checkout and any worktree are never write targets, though",
      "> `git show`/`git archive` at a pinned ref read fine anywhere. Chain the",
      "> directory change into the command, `cd \"$D\" && git …`, never",
      "> `cd \"$D\"; git …`, so a failed `cd` cannot leave a `git` command running in",
      "> the checkout — and bracket a fixture's own git with",
      "> `git rev-parse --show-toplevel`: before `git init` it must NOT resolve to",
      "> the repository, and a fresh scratch dir's `fatal: not a git repository`",
      "> (exit 128) is the pass, not a failure; before any `git commit` it must",
      "> equal your scratch path.",
      "",
      "Survives → apply it, with one hold: if its refuter reports a blast radius",
      "touching lines another finding also changes, report that to the controller and",
      "wait for a ruling before applying — only the controller holds every finding, so",
      "only it can see that the two cannot both land. Refuted → defer and file it, and",
      "say the refutation in the issue body. **Apply only what survives — no report is not a survival.** A",
      "refuter you never hear from leaves the finding exactly as unchecked as it",
      "arrived, so it defers like a refuted one.",
      "",
      "**A finding's `suggested_fix` is a hypothesis, not a patch — the review never",
      "ran it.** Only the claim is verified adversarially; the remedy text is unchecked.",
      "Three were wrong as written in one run: a stated end state that dropped a",
      "load-bearing option and measured RED, an assertion against a property the test",
      "helper does not expose (`TypeError`), and an enumeration that stopped short of",
      "two further stale clauses — one of them false in the *dangerous* direction. Run",
      "the remedy before you commit it, and re-derive an assertion from the post-fix",
      "tree rather than from the finding, since a sibling finding may edit the very",
      "text it asserts on.",
      "",
      "**Retrieve that report yourself; do not wait to be handed it — this covers the",
      "refuters YOU dispatch, and only those.** The review's own specialists do leave",
      "transcripts, but nothing gives you their address: the workflow had `agent()`",
      "return their findings into the script, so what you are handed names no file, and",
      "nothing on disk indexes a transcript by PR or dimension. Asking for their paths",
      "gets you nothing; ask for the text. A report from a refuter you spawned is",
      "different — it surfaces to the controller rather than to you, and waiting for a",
      "relay that never comes strands the finding. Its transcript is at the output file",
      "named in your spawn result, and its report is the last record:",
      "",
      "CLAUDE: retrieve via `tail -1 <output-file> | jq -r '.message.content[]?|select(.type==\"text\").text'` — never read the whole file, it is the full JSONL transcript and will overflow your context. Pinging is not retrieval and never becomes one: `SendMessage` to a finished subagent returns `had no active task; resumed from transcript` without the report (~15 pinged in one run, 0 retrieved).",
      "OMP: the tail/jq recipe does not apply — a depth-2 helper cannot dispatch further (`task.maxRecursionDepth: 2`); reach it directly instead, by its full dotted id (`<member>.<helper>`), via `hub send` — delivered, woken, no transcript workaround needed.",
      "",
      "If retrieval comes back empty, ask the controller by name. Only when neither",
      "works is the finding **unchecked** — defer and file it, and say so in the body. This is",
      "`review-and-fix.md`'s **Specialists** rule; it reaches you here because the",
      "steps that point at it are the ones you skip.",
      "",
      "The CI facts in that file apply to you — a `rebase-check` red, or heavy jobs",
      "`skipped`, **solely** off a non-zero behind-count, is staleness and not a",
      "failure. Never rebase to clear it. **`solely` is the load-bearing word:**",
      "`ci.yml`'s `rebase-check` exits 1 on five conditions and only one is",
      "staleness, so a non-zero behind-count does not by itself settle which fired.",
      "The job log names the condition — and because the staleness condition exits",
      "before the merge-commit condition is evaluated, the log is silent on that one",
      "by construction, so measure it separately with",
      "`git fetch origin && git rev-list --merges --count \"origin/<base>..HEAD\"` —",
      "keep the fetch, or a stale local `origin/<base>` widens the range over the",
      "base's own merge commits and reports a merge commit this branch never added.",
      "A non-zero count does not send you to a local rebase either: the merge bot's",
      "step-1 `gh pr update-branch --rebase` drops merge commits too",
      "(`run-merge-bot.md` step 1), so both conditions clear on that one server-side",
      "rebase. What it buys you is knowing the red was never solely staleness.",
      "",
      "**Run `<testCmd>` from the worktree before committing**, copied verbatim.",
      "`tests 0` is a FAILED run, not a pass. Red or zero-test → fix it, or move that",
      "finding to defer; never commit over it. **Never `--no-verify`** — a failing",
      "hook is a finding you report, not an obstacle you route around. Report the test",
      "result with your SHA. Nothing re-reviews this commit: the review ran against a",
      "snapshot cut before your edits existed, and a refuter checked the finding's",
      "claim, never your patch.",
      "",
      "**A test you ADD must kill its own mutant** — break what it pins, confirm it and",
      "only it goes red, restore. **Then a change it should *not* catch, staying",
      "green** — else you proved it fails, not that it discriminates: a pin asserting",
      "whole-file text clears \"it and only it goes red\" and still reddens on any edit",
      "(measured). A green suite says nothing about a new test: one pin this run",
      "survived the exact mutation it was named for.",
      "",
      "**A mutation that never landed is not a green — it is a cell that did not",
      "run.** Same rule for any fault you inject to see what breaks: prove the",
      "injection reached the child before you read its result — one run whose output",
      "differs with the injection present versus absent, or the child echoing the",
      "injected value back. Without one, a probe that exits 0 reporting the mutant",
      "behaving exactly like its baseline is indistinguishable from a real no-effect",
      "result, and a reproduction that never happened reads as a refutation. Build",
      "such an invocation as an array expanded braced and quoted —",
      "`cfg=(SETB=1 BADJ=1); env \"${cfg[@]}\" sh ./probe.sh` — or inline the",
      "assignments literally — `env SETB=1 BADJ=1 sh ./probe.sh`; NEVER from an",
      "unquoted scalar — `cfg=\"SETB=1 BADJ=1\"; env $cfg sh ./probe.sh` — which under",
      "zsh passes ONE argument, sets a variable literally named `SETB` to `1 BADJ=1`,",
      "never sets `BADJ` at all, and still exits 0. `env $cfg[@]` is not the portable",
      "spelling either: measured, bash word-splits it into `SETB=1` and",
      "`BADJ=1[@]`, so the injection variable is set to a corrupted value, while",
      "zsh behaves exactly as with the bare `$cfg` — `BADJ` never set, exit 0.",
      "",
      "**Commit BEFORE you mutate, and restore with `cp`, never a git discard.**",
      "`git checkout -- <file>` reverts the whole file, not your mutant — so it also",
      "eats uncommitted edits you made earlier, and the \"clean baseline\" you measure",
      "next is silently the reverted file. Two members hit this in one run; one lost",
      "prose edits and caught it only because a non-catch control failed. Copy the",
      "file aside and copy it back. Better still, mutate a copy under",
      "`<scratch>/pr<N>/mutate/` and leave the worktree untouched — that is what",
      "refuters are already required to do, and it has no blast radius at all.",
      "",
      "**Never `git stash` or `git stash pop` here either — a WIP commit is the",
      "substitute, not a second scratch mechanism: `git commit -m wip`, then",
      "restore or amend once you're back to real work.** The stash stack is",
      "repo-global too, not per-worktree or per-session — the same `refs/stash`",
      "every concurrent member and the main checkout share, not partitioned the",
      "way `<scratch>/pr<N>/mutate/` above is. A bare pop takes whichever entry is",
      "on top, from any worktree, silently — rc 0, no error — when the tree",
      "receiving it is clean on the affected paths, and refuses only when that",
      "tree is already dirty there. A bare `git stash` (push) does not reach into",
      "a sibling's tree, so that half is not the risk — the pop is. Nothing",
      "partitions the stack; this prohibition is the whole of the protection.",
      "",
      "**Report LAST, and only once nothing can still change.** A report you have",
      "sent **pins that SHA** for the controller, which dispatches a finisher against",
      "it. If a further instruction arrives after you have reported, reply saying the",
      "SHA is moving *before* you touch the tree again — do not silently do the work",
      "and re-report. Measured: three members in one run sent a final report and kept",
      "working; one had its worktree audited mid-mutation, another handed over a SHA",
      "that was two commits stale, and a finisher dispatched on either would have",
      "halted on a diverged head.",
      "",
      "Then `SendMessage` the controller the pushed SHA, your apply/defer split, and",
      "the deferral issue numbers, and exit. **Deferring everything is a normal",
      "outcome, not a stall:** nothing is then staged, `git commit` refuses an empty",
      "index, `git push` prints `Everything up-to-date`, and you report `no-op, HEAD",
      "unchanged at <sha>` in place of a new SHA. Say it explicitly — silence there is",
      "indistinguishable from a member that died. Never manufacture a commit to make",
      "CI fire.",
    ],
  },
  {
    what: "the finisher's instrument re-check block",
    opener: "**Re-check the instrument set before you act on what duty 1 or duty 2 read",
    golden: [
      "**Re-check the instrument set before you act on what duty 1 or duty 2 read,",
      "and again before you add the label.**",
      "`~/.fleet/bin/fleet-run instruments.sh --repo \"$(dirname \"$(env -u GIT_DIR -u GIT_WORK_TREE git rev-parse --git-common-dir)\")\"`.",
      "Exit 0 is the only code that lets you go on. Exit 1 (the set changed) and",
      "exit 2 (the check could not answer) both halt you: report what it printed,",
      "add no label, and do NOT re-read the script that gave you the reading.",
      "`--repo` is required and the spelling is the point — the run's baseline lives",
      "in the audited checkout's gitignored `.fleet/`, which the scratch worktree",
      "you take at duty 2 does not carry, so a bare invocation from there exits 2 on",
      "a missing baseline instead of comparing anything. The `env -u GIT_DIR -u",
      "GIT_WORK_TREE` wrapper guards against an ambient `GIT_DIR` in your own shell",
      "pointing this check at the wrong tree — the script's own internal unset",
      "cannot reach back and fix a path you already resolved wrong.",
    ],
  },
  {
    what: "the finisher's halt-cause block",
    opener: "Worktree differs from your pin",
    golden: [
      "Worktree differs from your pin, or from what you last read. **Check",
      "head-equality first: `worktree HEAD == the SHA you were dispatched against` on",
      "a clean tree settles it.** Against your dispatch pin, never against",
      "`PR headRefOid`: a member that kept working and pushed after the pin matches",
      "the branch tip on a clean tree, so a headRefOid comparison reports \"settled\"",
      "over commits no reviewer read — the exact divergence this halt exists to",
      "catch. `headRefOid` is a second, separate read (pushed vs unpushed), never the",
      "equality the halt turns on. A rebase entry sitting at or behind the pin is",
      "that head's provenance — the implementer's own pre-push replay — not",
      "divergence from it, and needs no adjudication at all. Three finishers in one",
      "run adjudicated a reflog this one check had already answered. Only when the",
      "head differs from your pin, work out what happened. Each cause below is cheap",
      "and self-checkable, and `anything else` is a cause too, not a gap:",
      "",
      "- **Live editor.** `git status --porcelain -unormal` is dirty. Sample",
      "  `git diff --stat` twice, a minute apart — diffstat growing means someone",
      "  is still writing. Halt, name `live editor`, report both samples.",
      "- **Rebase.** `git status --porcelain -unormal` is clean, head still differs",
      "  from your pin. `git reflog` in the worktree: a `reset`/rebase entry near",
      "  the move, not a plain `commit`, means the branch replayed onto a new",
      "  base — its own commits on a new parent, content-identical only on a",
      "  conflict-free replay.",
      "  Halt, name `rebase`, report the reflog line.",
      "- **Work past the pin.** `git status --porcelain -unormal` is clean, head",
      "  still differs from your pin, and `git reflog` in the worktree reads a plain",
      "  `commit` at the move — no `reset`/rebase entry there, any of those sitting",
      "  at or behind the pin as provenance. A member kept working and committed",
      "  after you were dispatched. Measured 2026-08-28 on #983, where the finisher",
      "  matched neither cause above and halted on its own judgement (#997).",
      "  Halt, name `commit past the pin`, and report **the commit, and whether it",
      "  is pushed, unpushed, or unknown**: `git log -1 --format='%h %s'` names it,",
      "  and `git ls-remote origin <branch>` answers the rest — a non-zero exit or",
      "  any other failed read is **unknown**, never folded into \"unpushed\": the",
      "  same rule `release-ticket.sh`'s own `ls-remote` names (\"a failure here is",
      "  an unknown answer, never a 'no'\") and `reaping.md`'s remote check shares",
      "  (\"its failure is an unknown answer, never a 'not pushed'\"). Only a",
      "  successful read settles pushed vs not: equal to that commit means pushed,",
      "  and a fresh finisher can audit it; a successful read that comes back",
      "  without it means the commit exists only in that worktree, where no",
      "  reviewer can reach it. Ask the remote, not the PR object, whose head lags",
      "  a ref move — the same field `run-merge-bot.md` refuses to poll, for that",
      "  reason. The controller's next move differs between pushed, unpushed, and",
      "  unknown, so a report naming only two of the three is not a report of this",
      "  cause.",
      "- **Anything else.** Matching none of the above is not a licence to report",
      "  the mismatch as unexplained — that report is the one this block exists to",
      "  make unnecessary, and it is where labelling over a moved head starts",
      "  looking reasonable. Halt, and name what you did find: both",
      "  `git status --porcelain -unormal` samples, the `git reflog` line at the",
      "  move, and both SHAs. A cause nobody has named yet is still a cause you",
      "  observed, and your report is what gets it named.",
      "",
      "Every cause halts, always — named or not, you never verify the dirt is",
      "harmless and label over it, a rebase is not a fast-forward you get to accept,",
      "a commit past the pin is not one either, and a cause you could not name is",
      "the least settled of the lot. Naming the cause makes the halt cheap to",
      "resolve, never a reason to skip it.",
    ],
  },
];

const SURFACES = [
  { label: "phase 2's implementer prompt", slice: region, blocks: REGION_BLOCKS, table: "REGION_BLOCKS" },
  { label: "run-team's Reviewers section", slice: reviewers, blocks: REVIEWER_BLOCKS, table: "REVIEWER_BLOCKS" },
];
const ALL = SURFACES.flatMap(({ slice, blocks, table }) => blocks.map((b) => ({ ...b, slice, table })));

// Says the red is a re-blessing point, and where. A golden's failure message is
// the whole difference between an editor updating the fixture on purpose and an
// editor reading an equality failure as breakage and loosening the comparison.
const reblessing = (what, table) =>
  `${what} no longer matches its golden fixture. These blocks reach a member VERBATIM and are change-controlled, so this red is a re-blessing point, not necessarily a defect: if you edited the block on purpose, update the "${what}" entry in \`${table}\` in plugin/scripts/dispatch-block-golden-prose.test.mjs in the SAME change — copy the block out of skills/run-team/SKILL.md, with or without its "> " markers. A pure re-wrap cannot cause this; wrapping is normalized away on both sides. If you did NOT edit it, a sentence or clause was added to the block, which is what this fixture exists to catch.`;

for (const { what, opener, golden, slice, table } of ALL) {
  test(`${what} matches its golden fixture`, () => {
    assert.equal(norm(quoteBlock(slice(), opener, what)), norm(golden.join("\n")), reblessing(what, table));
  });
}

// The coverage half, and what keeps the mechanism from decaying one block at a
// time: a block added to a dispatch surface that this file does not name is a
// block an appended carve-out reaches unseen, and every per-block test above
// would still pass. Compares the located runs against ALL the surface's runs, so
// an unfixtured block reds, and so does a reordering — which changes the order
// the member reads the rules in.
//
// Source-to-source, never against the fixtures: the equality tests above own
// that comparison, and repeating it here would red twice for one edit while
// saying nothing about coverage.
for (const { label, slice, blocks, table } of SURFACES) {
  test(`every verbatim block in ${label} has a golden fixture, in source order`, () => {
    assert.deepEqual(
      blocks.map((b) => quoteBlock(slice(), b.opener, b.what)),
      quoteBlocks(slice()),
      `${label} holds a quote block \`${table}\` does not name, or its blocks were reordered. A block with no fixture is one a carve-out can be appended to with this whole file green — add it to \`${table}\`, in source order.`,
    );
  });
}

// The two coverage tests above are each bounded by their OWN surface's
// anchors, not by the dispatch surface as a whole — a verbatim block added
// past `region()`'s or `reviewers()`'s anchors but still inside `## Phase 2`
// (or wherever a future dispatch surface lands) is invisible to both loops
// above and to the whole prose suite. This test catches that shape: it counts
// every quote run in the WHOLE file and asserts it equals the sum of the runs
// inside the two named surfaces, so a quote run outside both reds here even
// though no per-surface loop above ever saw it.
test("run-team/SKILL.md has no verbatim block outside both fixtured surfaces", () => {
  assert.equal(
    quoteBlocks(RUN_TEAM).length,
    quoteBlocks(region()).length + quoteBlocks(reviewers()).length,
    "run-team/SKILL.md holds a quote block outside both fixtured surfaces — a block added past either surface's anchors is invisible to the coverage tests above",
  );
});

// Re-wrapped, one gutter depth at a time, so the fix-applier prompt's nested
// refuter prompt is re-wrapped as its own quote rather than having its inner `>`
// markers shuffled into the outer text. Wrapping at word boundaries, never one
// word per line: an unconditional break would split the block's own opener and
// red the extractor on its anchor instead of exercising the comparison.
const rewrap = (block, width) =>
  block
    .split("\n")
    .reduce((groups, line) => {
      const gutter = line.match(/^(?:>[ \t]?)+/)[0];
      const depth = (gutter.match(/>/g) ?? []).length;
      const words = line.slice(gutter.length).trim();
      const last = groups[groups.length - 1];
      if (words !== "" && last && last.text.length > 0 && last.depth === depth) last.text.push(words);
      else groups.push({ gutter, depth, text: words === "" ? [] : [words] });
      return groups;
    }, [])
    .map(({ gutter, text }) => {
      const words = text.join(" ").split(/\s+/).filter(Boolean);
      if (words.length === 0) return gutter.trimEnd();
      return words
        .reduce((out, w) => {
          const tail = out[out.length - 1];
          if (tail !== undefined && `${tail} ${w}`.length <= width) out[out.length - 1] = `${tail} ${w}`;
          else out.push(w);
          return out;
        }, [])
        .map((l) => `${gutter}${l}`)
        .join("\n");
    })
    .join("\n");

// The ACCEPT side, and the half that decides whether this mechanism survives
// contact with an editor. Re-wrapping is not drift, and a golden that reddened
// on it would be re-blessed once and then deleted.
//
// Every block, not one: these fixtures were blessed at TODAY'S wrap points, so a
// `norm` that handled them by accident would pass a single-block control. The
// staleness guard is per block for the same reason the comparison is — a block
// already at the target width would be re-wrapped to itself and prove nothing.
test("a re-wrapped block does not red — this mechanism refuses drift, not reflow", () => {
  for (const { what, opener, golden, slice } of ALL) {
    const raw = quoteBlock(slice(), opener, what);
    const narrow = rewrap(raw, 45);
    assert.notEqual(narrow, raw, `the rewrap fixture no longer changes ${what}'s wrapping — it is already at or below 45 columns, so this control proves nothing about it`);
    // Replacer function, not a replacement string: `$&`, `$'` and `` $` `` are
    // interpreted in the latter, and the fix-applier prompt carries a literal
    // `$(...)` command substitution today.
    const mutated = RUN_TEAM.replace(raw, () => narrow);
    const after = quoteBlock(slice(mutated), opener, what);
    assert.notEqual(after, raw, `the re-wrap never landed in ${what}'s slice — this control did not run`);
    const flat = norm(after);
    assert.equal(flat, norm(golden.join("\n")), `${what} reds on a pure re-wrap — the words are identical and only the wrap points moved, so the normalization above is broken, not the block`);
  }
});

// The REFUSE side, mutant by mutant. Each entry is a carve-out appended inside a
// block, after the rule it contradicts, keeping every word the presence pins
// match — the shape #1002 measured green against those pins four times, twice
// over on two different suites.
//
// `after` is asserted to be the block's own tail before the carve-out is
// appended, so a control that stops testing the measured insertion point says so
// instead of quietly moving to a different one.
const APPENDED = [
  {
    what: "phase 2's commit-incrementally block",
    after: "effectively unrecoverable.",
    carveOut: "A single commit at the end is fine when the diff is small.",
  },
  {
    what: "phase 2's enumerate-the-class block",
    after: "A green suite is evidence only about the paths it exercises.",
    carveOut: "Skip the enumeration entirely when the ticket names only one case.",
  },
  {
    what: "phase 2's re-derive block",
    after: "say which, and stop.",
    carveOut: "If the criterion looks close enough, implement it anyway.",
  },
  {
    what: "phase 2's issue-read block",
    after: "bail, name the cause, do not implement.",
    carveOut: "Unless the tree looks tractable to you, in which case implement anyway.",
  },
];

test("a carve-out appended inside a block reds — the shape the presence pins cannot see", () => {
  for (const { what, after, carveOut } of APPENDED) {
    const entry = ALL.find((b) => b.what === what);
    assert.ok(entry, `${what} has no golden fixture, so this mutant cannot be measured against one`);
    const raw = quoteBlock(entry.slice(), entry.opener, what);
    assert.ok(
      norm(raw).endsWith(after),
      `${what} no longer ends on "${after}" — this mutant's measured insertion point moved, so appending after it no longer tests what #1002 measured`,
    );
    // Appended to the block's last line, which carries the `>` gutter, so the
    // carve-out lands INSIDE the quote run rather than after it. A mutation that
    // never landed is not a green: the guard above and this splice's own
    // difference from `raw` are what make the assertion below evidence.
    const mutant = `${raw} ${carveOut}`;
    assert.notEqual(mutant, raw, "the mutant is identical to the block — nothing was appended");
    assert.notEqual(
      norm(quoteBlock(entry.slice(RUN_TEAM.replace(raw, () => mutant)), entry.opener, what)),
      norm(entry.golden.join("\n")),
      `a carve-out appended to ${what} does not red its golden fixture — the mechanism #1002 replaced the presence pins with is not seeing an insertion, which is the entire defect`,
    );
  }
});

// The second measured shape, and the one no assertion in this repo saw before:
// a meaning-changing clause inserted strictly BETWEEN the two anchors of an
// ordered span, touching neither fragment, absorbed by that span's `.{0,N}?`
// tolerance. Measured on the enumerate pin's first half, whose gap spends 56 of
// its 120 characters today — this 27-character insertion fits, and the presence
// pin stays green.
test("a clause inserted mid-gap reds — the second shape the gap-bounded spans absorb", () => {
  const entry = ALL.find((b) => b.what === "phase 2's enumerate-the-class block");
  const raw = quoteBlock(entry.slice(), entry.opener, entry.what);
  // Located through `phrase()`, never a literal: the words this clause is
  // inserted between are two thirds of the way through a wrapped line, so a
  // literal anchor stops finding them the moment the block is reflowed, and the
  // guard below would then decline a control that should have run. Measured —
  // it declined against a 45-column rewrap of the region until this anchor
  // learned to span a wrap point.
  const midGap = "every member of that class (yes, even the boring ones) —";
  const mutant = raw.replace(phrase("every member of that class —"), () => midGap);
  assert.notEqual(mutant, raw, "the mid-gap insertion point moved — the clause was never inserted, so what follows would measure nothing");
  assert.notEqual(
    norm(quoteBlock(entry.slice(RUN_TEAM.replace(raw, () => mutant)), entry.opener, entry.what)),
    norm(entry.golden.join("\n")),
    "a clause inserted between the enumerate pin's two anchors does not red its golden fixture — the gap tolerance that absorbs it is still the only thing reading this block",
  );
});

// The extractor's loud half. A golden mechanism whose extractor returns "" for a
// block it cannot find compares empty against empty, or against a fixture nobody
// re-blessed, and a DELETED block passes — the one failure that would make every
// test above vacuous. Both mutants below take the block out of the member's
// prompt: the first deletes it, the second moves it out of the `>` quoting,
// which is #172's own defect and leaves every word of it still in the file.
test("a block that is gone, or no longer quoted, throws instead of comparing against nothing", () => {
  const { what, opener, slice } = ALL.find((b) => b.what === "phase 2's scratch-discipline block");
  const raw = quoteBlock(slice(), opener, what);

  const deleted = RUN_TEAM.replace(raw, () => "");
  assert.notEqual(deleted, RUN_TEAM, "the block was not deleted, so the throw below would prove nothing");
  assert.throws(() => quoteBlock(slice(deleted), opener, what), /no quote block opens on/, `deleting ${what} did not throw — a golden comparison would run against whatever the extractor returned instead`);

  const unquoted = RUN_TEAM.replace(raw, () => raw.split("\n").map((l) => l.replace(/^>[ \t]?/, "")).join("\n"));
  assert.notEqual(unquoted, RUN_TEAM, "the gutter was not stripped, so the throw below would prove nothing");
  assert.throws(() => quoteBlock(slice(unquoted), opener, what), /no quote block opens on/, `moving ${what} out of the \`>\` quoting did not throw — the controller carries only the blocks, so an unquoted rule reaches the member by paraphrase or not at all`);
});
