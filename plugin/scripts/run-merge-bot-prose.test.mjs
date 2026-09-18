// Pins the #170 addition to run-merge-bot.md's step 4: dropping `in-progress`
// from every issue a merged PR closes. Same discipline as
// issue-tracker-prose.test.mjs — a positive match on a whole file is a
// vacuous pin, so this slices to step 4 alone before asserting.
//
// THE CEILING: this proves the phrase is PRESENT in step 4. It cannot prove
// the rule is not negated by a sentence added beside it, and it does not run
// the step — drop-merged-label.test.mjs owns the script's own behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { between, paragraph, phrase } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const DOC = readFileSync(join(REPO, "commands", "run-merge-bot.md"), "utf8");

// Bounded to step 4 alone: unbounded to EOF the slice runs through staleness,
// the no-undo audit and the watcher loop, and a mention of `in-progress`
// anywhere in those would satisfy the assertions with step 4 itself untouched.
function step4() {
  const start = "4. `gh pr merge <pr> --merge`";
  const at = DOC.indexOf(start);
  assert.notEqual(at, -1, `'${start}' moved — update this test`);
  const rest = DOC.slice(at + start.length);
  const end = rest.indexOf("**Staleness fires");
  assert.notEqual(end, -1, "step 4's end marker moved — update this test");
  return start + rest.slice(0, end);
}

test("step 4 drops in-progress from every issue the merged PR closes", () => {
  assert.match(step4(), /Drop `in-progress` from every issue this PR closes/);
  assert.match(step4(), /drop-merged-label\.sh <pr> --apply/);
});

test("step 4 says a failed removal must be reported, never swallowed", () => {
  assert.match(step4(), /a removal failed — report it as `label-drop-failed-#<issue>`, never swallow it/);
});

test("the drop runs only after the merge is confirmed, never before", () => {
  assert.match(step4(), /call this only after the merge is confirmed/);
});

// #303: on `unknown` the runbook used to send the operator to `git stash list`
// alone, which is empty at rc 0 in two of the three states that produce
// `unknown` (measured: `chmod 000` on `refs/stash`, and on `logs/refs/stash`).
// Sliced to the audit section, same discipline as step4(): it pins the text to
// the section that has to carry it, so a later paragraph naming `refs/stash`
// somewhere else in the doc can never stand in for this one.
function noUndoAudit() {
  const start = "## No-undo audit (before every rebase)";
  const at = DOC.indexOf(start);
  assert.notEqual(at, -1, `'${start}' moved — update this test`);
  const rest = DOC.slice(at + start.length);
  const end = rest.indexOf("**4. Take `main`'s side wholesale");
  assert.notEqual(end, -1, "the audit section's end marker moved — update this test");
  return rest.slice(0, end);
}

// THE CEILING: presence of the instruction, not its correctness. The paths are
// pinned as written — `--git-common-dir`, not `.git/` — because a linked
// worktree's `.git` is a file and `.git/refs/stash` reaches nothing there.
test("the `unknown` path sends the operator to both stash files, via the common dir", () => {
  // The instruction is pinned by its rule, not by a tally of the causes: the
  // sentence used to count them, and #482 added one, which is how a count
  // written into prose goes stale.
  assert.match(noUndoAudit(), /On `unknown` do not stop at that list: the causes git stays silent about leave it empty at rc 0/);
  assert.match(noUndoAudit(), /c=\$\(git rev-parse --git-common-dir\)/);
  assert.match(noUndoAudit(), /ls -l "\$c"\/refs\/stash "\$c"\/logs\/refs\/stash`/);
  assert.match(noUndoAudit(), /cat "\$c"\/logs\/refs\/stash`/);
});

// #482: the cause whose whole shape is that the list did NOT come back empty —
// `git stash list` printed entries, then exited nonzero, and the audit answers
// `unknown` instead of the number it could have counted. The runbook has to
// carry both halves: that the state exists at all, since an operator who reads
// `unknown` as "the list was empty" goes looking for the wrong thing, and that
// git's own words are already on the audit's line, since the earlier
// instruction sends them to re-read a list whose stderr they have.
test("the `unknown` path names the cause where the list printed entries and then failed", () => {
  assert.match(noUndoAudit(), /`git stash list` printed entries and then exited nonzero, so what it printed is short/);
  assert.match(noUndoAudit(), /a corrupt loose object behind an entry that is not the tip does this, and the audit reports `unknown` there/);
  assert.match(noUndoAudit(), /the audit's own line carries that text for you/);
});

// `----------` alone is under-inclusive: an unreadable logs/refs DIRECTORY
// (`chmod 000 .git/logs/refs`) produces the same `unknown`, but `ls` fails
// before it prints a mode column — `ls: .git/logs/refs/stash: Permission
// denied`, with `refs/stash` beside it at a healthy `-rw-r--r--`. Both halves
// of the tell are pinned, or the second silently rots back out.
test("the fault tell covers a Permission denied from `ls`, not only a `----------` mode", () => {
  assert.match(noUndoAudit(), /a mode of `----------` on either, or a `Permission denied` from `ls` itself, is the fault,/);
});

test("the `unknown` path warns that a missing refs/stash file is not an empty stash", () => {
  assert.match(noUndoAudit(), /A missing `refs\/stash` file is not an empty stash: `git gc` packs it into `packed-refs`/);
});

// Whitespace-normalized so a same-words reflow of the audit paragraph cannot
// false-red these two pins: they hold the two longest spans in this file, and
// the paragraph is currently one unwrapped line, so a future hard-wrap landing
// inside a span is the live hazard. Scoped to the #437 pins below on purpose —
// converting the file's other pins is a separate change.
const flat = (s) => s.replace(/\s+/g, " ");

// #437 item 3: of the four `unknown` causes, the stash-object-missing one is
// the one `git stash list` itself refuses to stay silent about. Measured, git
// 2.50.1: `stash list` against a repo with `rm .git/objects/<stash-sha>`
// prints nothing on stdout but exits 1 with stderr `fatal: bad object
// refs/stash`, while the other three causes (unreadable ref file, unreadable
// reflog, absent ref beside a live reflog) are each rc 0 with no stdout and no
// stderr. The doc names the cause rather than counting to it: this paragraph
// already spends "the fourth" on the absent-ref/live-reflog case, so an
// ordinal here would bind the same word to two members of the same set.
test("the `unknown` path says the missing-object cause names itself in git's own stderr", () => {
  assert.match(
    flat(noUndoAudit()),
    /The missing-object cause is the one git is not silent about: `git stash list`'s own stderr there already ends `fatal: bad object refs\/stash`/,
  );
});

// #437 item 1: `git show refs/stash` recovers the entry in the states where
// `ls -l`/`cat` come back with nothing — measured, git 2.50.1, over the twelve
// states {staged, unstaged} x {loose, packed} x {reflog unreadable, reflog
// blank, reflog removed}: `git show refs/stash` printed the `WIP on <branch>`
// label in all twelve, but printed NO diff in all six staged ones, because the
// stash tree equals the index-commit parent and the default `--cc` combined
// diff suppresses every hunk. `git stash show -p refs/stash` printed the hunk
// in all twelve, so it is the command the doc names for the content.
// Both fail only where the ref FILE is the broken one — chmod 000 (`git show`
// rc 128 `ambiguous argument`, `git stash show -p` rc 1) or `printf
// 'not-a-sha' > refs/stash` (both, after `ignoring broken ref`) — and measured
// in both of those the reflog is untouched and still names the stash SHA as
// its second field, where `git stash show -p <that sha>` printed the hunk
// staged or not, while `git show <that sha>` again printed none when staged.
// #1055 added the third member of that enumeration: measured, git 2.50.1, `rm
// refs/stash` with no `packed-refs` fails both the same way (`ambiguous
// argument` / `refs/stash is not a valid reference`) while the reflog still
// names the SHA, and after `git pack-refs --all` both succeed at rc 0 — so the
// clause enumerates the UNPACKED absence, not absence as such.
test("the `unknown` path names git show refs/stash as the recovery when the file reads come back empty", () => {
  assert.match(
    flat(noUndoAudit()),
    /`git show refs\/stash` still resolves the ref whether loose or packed, printing the `WIP on <branch>` label/,
  );
  assert.match(
    flat(noUndoAudit()),
    /it prints no diff beside that label when the stashed change was staged before `git stash`, so read the content with `git stash show -p refs\/stash`, which prints the hunk either way/,
  );
  assert.match(
    flat(noUndoAudit()),
    /Both fail only where the ref FILE is itself the broken one — unreadable, holding text that is not a SHA, or gone with nothing in `packed-refs` — and there the SHA `cat` already printed, in the reflog's second field, is what `git stash show -p <that sha>` recovers instead/,
  );
});

// #1055: the fallback above IS a SHA `cat` printed, so it is unavailable in the
// double fault — where the premise clause ("`cat` denied") fires and the ref is
// also unresolvable — and the paragraph went on offering it there. Measured,
// git 2.50.1, all three shapes (`chmod 000` on `refs/stash` AND
// `logs/refs/stash`; `printf 'not-a-sha' > refs/stash` plus `chmod 000` on
// `logs/refs/stash`; `rm refs/stash` with no `packed-refs` plus `chmod 000`
// on `logs/refs`): `git stash list` empty at rc 0, `git show refs/stash`
// `ambiguous argument`, `git stash show -p refs/stash` `refs/stash is not a
// valid reference`, and `cat` rc 1 printing no SHA to fall back on.
//
// The recovery SPLITS by shape, measured, not inferred — an earlier draft
// claimed one outcome for all three, which is the defect #1055 fixed here.
// `chmod 644` on the two files (`chmod 755` on an unsearchable `logs/refs`)
// puts the entry straight back in `git stash list` ONLY where the ref FILE's
// own content survived — the both-unreadable shape. Where the ref file's
// content is itself gone or garbage, restoring the reflog's mode only makes
// `cat` print the SHA again; `git stash list` stays empty at rc 0 until the
// ref is re-pointed by hand: `git update-ref refs/stash <sha>` succeeds
// directly once the file is gone, but on garbage text it answers `fatal: …
// reference broken` even with `-d` — measured — so the file has to be `rm`'d
// first either way. Once re-pointed, both land the entry as a NEW
// `stash@{0}` (empty subject, the update's own reflog line) with the
// recovered one pushed down to `stash@{1}`, never restored to its original
// slot — measured with `git stash list` before and after `git update-ref`.
//
// Failing all of that, `git fsck` prints `dangling commit <sha>` per stash
// entry — 3 of 3 entries in a three-stash fixture, and still with every
// object packed by `repack -ad` — at rc 10 in the unreadable-ref shape while
// printing them, and still at rc 0 with both files simply deleted and
// nothing in `packed-refs`. `git stash show -p <that sha>` printed the hunk
// there, including for an entry staged before `git stash`, refusing a
// non-stash dangling commit with `is not a stash-like commit`. Its measured
// limits are why the doc calls it a lead: fsck hands back no `stash@{N}`,
// and an entry dropped by `git stash drop` is dangling with the same `WIP on
// <branch>:` subject and the same rc 0 from `git stash show -p` as a live
// one.
//
// `git gc --prune=now` is deliberately NOT mentioned either way: measured, it
// dies `fatal: bad object refs/stash` / `failed to run repack` at rc 128 in the
// unreadable-ref shape, so the obvious "recover before something prunes it"
// warning would be false for the shape it reads as being about.
//
// Six claims pinned separately, never one span: the STATE (now three
// shapes), the permission fix's SCOPE (one shape names it back outright),
// the re-point recovery the other two shapes need instead, the stash@{0}/
// stash@{1} shape that re-point leaves behind, the fsck lead, and the lead's
// unreliability — each rots independently. Dropping the state turns the
// caveat into unscoped advice; dropping the last one promotes a lead to a
// listing, which is the specific rewrite this paragraph's history predicts;
// widening the permission fix back across all three shapes silently
// reintroduces the exact false promise #1055 corrected, which is why its
// scope is pinned as a short span rather than folded into the fix
// instruction's own sentence.
test("the double fault leaves no ref-based recovery, and names the mode fix, the re-point fallback and the fsck lead in their place", () => {
  assert.match(
    flat(noUndoAudit()),
    /That fallback is a SHA `cat` printed, so it is gone where the reflog is the denied read too — both files unreadable, `refs\/stash` holding text that is not a SHA while the reflog cannot be read, or `refs\/stash` gone with nothing in `packed-refs` while the reflog cannot be read — and nothing ref-based recovers there/,
  );
  assert.match(
    flat(noUndoAudit()),
    /Only the both-files-unreadable shape then has `git stash list` name the entry again on its own/,
  );
  assert.match(
    flat(noUndoAudit()),
    /so restoring the reflog's mode only unlocks the SHA `cat` now prints; `git stash list` stays empty at rc 0 until you clear the broken ref and re-point it yourself/,
  );
  assert.match(
    flat(noUndoAudit()),
    /`git update-ref refs\/stash <that sha>` works directly once `refs\/stash` is already gone; where it instead holds garbage text, `git update-ref` refuses that too \(`reference broken`, even with `-d`\) until you `rm` the file first/,
  );
  assert.match(
    flat(noUndoAudit()),
    /Either path is measured to list the entry again as a new `stash@\{0\}` \(an empty-subject entry the update itself adds\), pushing the recovered one down to `stash@\{1\}` rather than restoring it to its original slot/,
  );
  assert.match(
    flat(noUndoAudit()),
    /`git fsck` still prints a `dangling commit <sha>` line per stash entry, objects loose or packed/,
  );
  assert.match(
    flat(noUndoAudit()),
    /refusing anything that is not a stash \(`is not a stash-like commit`\)/,
  );
  assert.match(
    flat(noUndoAudit()),
    /Treat it as a lead, not a listing: no `stash@\{N\}` comes back with it, and an entry someone dropped on purpose is indistinguishable from a live one/,
  );
  assert.match(flat(noUndoAudit()), /Restore read permission where the mode is yours to fix/);
});

// #376 added a fourth cause whose `ls -l` signature is the OPPOSITE of the
// three above — the ref file is gone rather than unreadable, so neither the
// `----------` mode nor the `Permission denied` tell fires, and an operator
// reading only those two concludes the audit was wrong and rebases. The
// reflog beside it is what makes the entries recoverable, so the instruction
// has to name both halves: the signature, and that the SHAs are the recovery.
//
// Two matches, not one on the whole sentence, and `\s+` between the words: a
// single literal spanning the clause reds on a pure reflow or on bolding
// `fourth cause` in place, neither of which changes what it guards. Measured —
// the first draft of this pin did exactly that.
test("the fourth cause — an absent refs/stash beside a live reflog — is named with its own ls signature", () => {
  assert.match(noUndoAudit(), /`No\s+such\s+file\s+or\s+directory`\s+for\s+`refs\/stash`\s+alone/);
  assert.match(noUndoAudit(), /recover\s+from\s+the\s+SHAs\s+`cat`\s+prints,\s+do\s+not\s+rebase\s+over\s+it/);
});

// #149: step 1 used to rebase locally and `git push --force-with-lease`,
// denied unpredictably by the auto-mode classifier — 2 allowed / 2 denied on
// byte-identical invocations in one session — sometimes stranding a rebased
// head that never reached the remote, so `gh pr merge` landed the stale one.
// settings.json has carried an `autoMode.allow` entry for that exact command
// since 1dadc5d, so adding one is not the fix for a denial here; the classifier
// judges per invocation. Step 1 now rebases server-side first: an API call, not
// a push, so the classifier is never consulted for it.
//
// THE CEILING: same as step4() above — presence, not correctness, and not
// that the fallback runs the way it's written.
function step1() {
  const start = "1. If the PR is behind";
  const at = DOC.indexOf(start);
  assert.notEqual(at, -1, `'${start}' moved — update this test`);
  const rest = DOC.slice(at + start.length);
  const end = rest.indexOf("2. Watch checks settle");
  assert.notEqual(end, -1, "step 1's end marker moved — update this test");
  return start + rest.slice(0, end);
}

test("step 1 rebases server-side first, not with a local force-push", () => {
  assert.match(step1(), /`gh pr update-branch <pr> --rebase`/);
  assert.match(step1(), /no local git command runs/);
});

test("step 1 falls back to a local, unpushed rebase when the server-side path can't run", () => {
  assert.match(step1(), /a real conflict, or `allow_update_branch` off/);
  assert.match(step1(), /Rebase locally, for verification only — this rebase never needs to reach the remote/);
  assert.match(step1(), /Report this path as `rebase-fallback-#<pr>`/);
});

// #408: a controller once told its merge bot to prove a post-rebase stale
// worktree safe with `git cherry origin/main HEAD` — trivially `+` for any
// unmerged PR, since main never had the PR's commits merged rebase or not.
// Measured directly (two local clones, one simulating the server-side rebase
// the other never sees) before writing this: origin/<branch> reads `-`
// (nothing unique), origin/main reads `+` on the identical stale HEAD.
test("step 1 names the correct upstream for proving a post-rebase worktree stale but safe", () => {
  assert.match(step1(), /`git cherry origin\/<branch> HEAD`/);
  assert.match(step1(), /\*\*not\*\* `git cherry origin\/main HEAD`/);
});

// #447. The probe above told the bot to run `git cherry` and then stopped:
// neither result had an instruction, on the path that is now the default. Two
// separate rots follow from that, and each is pinned to its own contiguous
// string rather than to a word appearing somewhere in step 1.
//
// (a) The ORDERING must ride in the same sentence as the command. GitHub
// deletes the remote branch when the PR lands, so `origin/<branch>` stops
// existing at the merge and a probe run afterwards dies on a missing ref —
// which reads like the divergence it was meant to rule out. A constraint
// parked in a later paragraph is one a reader can reach the command without
// having read, so the assertion below spans command and constraint as one
// literal run of text and reds if they are split apart.
test("step 1's staleness probe carries its ordering constraint in the same sentence as the command", () => {
  assert.match(
    step1(),
    /run `git cherry origin\/<branch> HEAD` from the worktree \*\*before the merge, never after\*\*/,
  );
  // the reason, without which the constraint is an unexplained rule
  assert.match(step1(), /GitHub deletes the remote branch when the PR lands/);
  assert.match(step1(), /fails on a missing ref/);
});

// (b) The OUTCOME. `+` must be answered on the server-side path, and answered
// with the structural reason — the path rebases through the API and pushes
// nothing, and step 4 merges the remote head, so an unpushed local commit
// cannot enter the merge. The reason is pinned with the verdict on purpose: a
// bare "no STOP here" is exactly the sentence a later reader would delete for
// looking unjustified.
test("step 1 answers a `+` on the server-side path, with the structural reason", () => {
  assert.match(step1(), /Neither result halts this path/);
  assert.match(step1(), /this step rebases through the API and pushes nothing/);
  assert.match(step1(), /structurally unable to enter the merge/);
});

// (c) WHICH output is clean. An earlier draft of this paragraph called silence
// the clean answer, which is false for the case the paragraph is about:
// git-cherry emits a line per commit in `origin/<branch>..HEAD` and marks a
// patch-equivalent one `-` rather than dropping it, so a worktree that has
// fetched the rebase reads all-`-` and only an un-fetched one reads nothing
// (measured 2026-08-29 against real git — scratch repo, branch rebased onto an
// advanced main and force-pushed, clone left at the pre-rebase head; nothing
// before that clone fetched, a `-` per rebased commit after, a `+` in both
// once an unpushed commit was added). Pinned to the rule, not to the shape of
// either listing: `+` is the signal, its absence is clean.
test("step 1 defines the probe's clean answer by the absence of `+`, not by silence", () => {
  assert.match(step1(), /The clean answer is the absence of a `\+`, not the absence of output/);
  assert.match(step1(), /one that has fetched reads `-` for every rebased commit\. Both are clean/);
});

// The other half of (b), and the one that costs real work if it rots: the new
// wording must NOT license skipping the STOP where the hazard is real. The
// verdict and the identifier are pinned here, inside the block that carries
// them; the RATIONALE gets its own tighter slice below, because the two rot
// independently — #1038 corrected a false reason while the verdict stayed
// right, and a pin holding both in one span cannot tell those apart.
//
// Sliced to the fallback, not to step 1: the server-side paragraph discusses
// this same STOP, so a step1()-wide assertion stayed green with the bullet
// gutted (measured by mutation, 2026-08-29).
function fallbackBlock() {
  const start = "**Fallback (server-side rebase unavailable).**";
  const at = DOC.indexOf(start);
  assert.notEqual(at, -1, `'${start}' moved — update this test`);
  const rest = DOC.slice(at + start.length);
  const end = rest.indexOf("2. Watch checks settle");
  assert.notEqual(end, -1, "the fallback block's end marker moved — update this test");
  return start + rest.slice(0, end);
}

test("the fallback's diverged-worktree STOP survives the primary path's `+` answer", () => {
  assert.match(fallbackBlock(), /\*\*Worktree ahead\*\* → STOP, report `worktree-diverged-#<pr>`/);
});

// The same false mechanism stated a third time, in the sentence that sends the
// bot to compare the two heads at all — "the rebase would carry an unreviewed
// local commit into the merge". Pinned positively in its own paragraph.
const headCheck = () =>
  paragraph(DOC, "**Confirm the worktree head", "run-merge-bot.md's fallback head check");

test("the fallback's head check states the mismatch as a corrupted verification, not a push into the merge", () => {
  assert.match(
    headCheck(),
    phrase("the rebase would fold an unreviewed local commit into the tree you verify, while the merge takes the remote head without it"),
  );
});

// #1512. The fallback's head check read `gh pr view <pr> --json headRefOid` as
// its SOLE comparison operand — the one field that lags the branch ref it is
// meant to describe, which is why step 1's own poll was moved off it (#903)
// and why the phase-1 dispatch site was moved off it (#1168). Both failure
// directions are live at this site: a false `worktree-diverged` STOP on a
// just-rebased worktree, and — the half that ships — a false EQUAL, because a
// worktree unfetched since the rebase and a PR object lagging the rebase hold
// the SAME pre-rebase sha, so the two stale values agree and the fallback
// verifies a tree the remote no longer has.
//
// These pins hold WHICH SOURCE the check turns on, not that a comparison
// exists. Measured: with the operand swapped, this file was 48/48 green on
// both the pre-fix and post-fix doc — `rev-parse HEAD` survives the swap, the
// `headRefOid` command survives in the block as the recorded diagnostic, and
// every arm's wording is unchanged. That is the shape the pins above cannot
// tell apart, and the reason these are mappings and bounded negatives rather
// than presences.
//
// MUTATION RECORD — #1512, scratch-copy method (`cp -R plugin/` to a tmp dir,
// mutate the copy, `node --test` the copy, read counts, discard; one mutant
// per copy, so the real checkout is never the subject). 18 semantic mutants,
// 9 controls, run against this file's 56 tests. 17 of 18 red, every red a
// true positive naming the pin whose claim was actually lost:
//
// The `ls-remote` line deleted from the command block; the block's "NOT the
// gate" comment reverted to the old one; the compare rule's re-admitting
// clause in all three wordings (naming `headRefOid` with and without
// "against", and naming "the PR object's head" with neither); the empty-read
// clause rewritten to fall back to the PR object; the `Equal` arm rewritten
// to accept either source; the one-re-read bound deleted; the refusal flipped
// to "take the newer reading and proceed"; the `Equal`-is-unreachable clause
// deleted; the fail-open clause deleted; the settle-window clause deleted;
// the `rev-parse origin/<branch>` prohibition deleted; the arm-discriminator
// paragraph deleted; the false-EQUAL clause deleted. Reverting the whole
// block to its pre-#1512 form reds 7.
//
// THE SURVIVOR, recorded rather than patched — see the count guard's own
// ceiling note: a re-admitting clause naming neither `headRefOid` nor
// "against" ("the PR object's value is also fine to use here") passes both
// counts, and is denied only by the block and the arms, which is where the
// instruction is actually executed.
//
// Controls all stayed 56/56 green: the compare rule rewrapped at 80 columns,
// the re-read paragraph at 70, the fail-open paragraph at 90 and the arm
// discriminator at 75; the unpinned measurement sentence reworded with
// different shas and a different git version; the unpinned "costing a wave"
// tail and the unpinned re-read rationale reworded; the block's operand
// comment reworded; and the out-of-scope `Worktree behind` arm reworded. The
// pins refuse operand drift, not layout, and they do not reach the arm the
// ticket put out of scope.

// The runnable half. A revert deletes the `ls-remote` line from the block, and
// the three-line block is the only place the operator is handed commands, so
// this is the one pin a revert cannot route around by rewording prose. Bounded
// to the block: `git ls-remote` recurs through step 1 above and `headRefOid`
// recurs through the whole file.
const headBlock = () =>
  between(
    DOC,
    "git -C <worktree> rev-parse HEAD",
    "**Compare the worktree head",
    "run-merge-bot.md's fallback head-check command block",
  );

test("the fallback reads the branch ref, and marks the PR-object read as not the gate", () => {
  assert.match(headBlock(), phrase("git ls-remote origin refs/heads/<branch> | cut -f1"));
  // The demotion travels with the command, not only in prose three paragraphs
  // down: a reader who runs the block and stops reading must still not take
  // `headRefOid` for the verdict.
  assert.match(headBlock(), phrase("gh pr view <pr> --json headRefOid -q .headRefOid"));
  assert.match(headBlock(), phrase("NOT the gate"));
});

// The operand as a MAPPING — which source the worktree head is compared
// AGAINST. The positive clause and the prohibition fail independently: a
// mutant that names the ref while leaving `headRefOid` admissible reds on the
// prohibition, one that drops the ref entirely reds on the mapping.
//
// `git rev-parse origin/<branch>` is the false fix waiting beside the real
// one, and the reason it is pinned separately: a reader who learns only "not
// the PR object" reaches for the local remote-tracking ref, which is the very
// value a stale worktree was cut from — it agrees by construction and passes
// every tree the check exists to catch. #1168 pinned the same prohibition at
// the sibling site for the same reason.
const compareRule = () =>
  paragraph(DOC, "**Compare the worktree head", "run-merge-bot.md's fallback compare rule");

test("the fallback compares against the branch ref, and forbids both cheaper operands", () => {
  assert.match(compareRule(), phrase("Compare the worktree head against the branch REF"));
  assert.match(
    compareRule(),
    phrase("never against `gh pr view <pr> --json headRefOid -q .headRefOid`"),
  );
  assert.match(compareRule(), phrase("Never `git rev-parse origin/<branch>` either"));
  assert.match(compareRule(), phrase("agrees with it by construction"));
  assert.match(compareRule(), phrase("never the operand this check turns on"));
});

// COUNT guard, and the ceiling on the presences above. Every assertion in
// that test is a presence, so a mutant that keeps all five verbatim and
// appends one clause re-admitting the PR object satisfies every one of them:
// measured, "…never the operand this check turns on — though where the ref
// read is awkward, comparing against `headRefOid` is acceptable." left this
// file 55/55 green. #1168 measured three mutants of exactly this class
// escaping its own literal negative at the sibling site, and answered with a
// count; this is that answer, over the two tokens such a clause has to use.
//
// Both counts are the paragraph AS WRITTEN. `headRefOid` is 3, not 2 — the
// prohibition spells the whole command, so `--json headRefOid -q .headRefOid`
// is two of them, and "The `headRefOid` read stays" is the third. `against`
// is 2: the mapping and the prohibition. A re-admitting clause has to add one
// or the other, whichever way it is worded.
//
// THE CEILING, measured rather than assumed: a clause that names neither
// token — "the PR object's head is also acceptable here" — passes both counts.
// What denies it is not this test but the block and the arms: the compare
// rule is prose, while `headBlock()` pins the commands the operator actually
// runs and `arms()` pins the place the verdict is actually taken, and neither
// admits the field. A doc mutated that way contradicts itself in one
// paragraph and still routes the reader to the ref.
test("no second operand is admitted beside the branch ref", () => {
  assert.equal(
    (compareRule().match(/headRefOid/g) ?? []).length,
    3,
    "the compare rule names headRefOid a fourth time — a re-admitting clause, under some wording the presences above all satisfy",
  );
  assert.equal(
    (compareRule().match(/\bagainst\b/g) ?? []).length,
    2,
    "a third compared-against clause entered the compare rule — the operand is no longer the ref and nothing else",
  );
});

// MAPPING guard, ceiling on the pin above. The prohibition is a presence pin,
// so a mutant that keeps it verbatim and re-admits the field through a second
// clause satisfies it — #1168 measured three such mutants escaping its own
// literal `doesNotMatch` at the sibling site. Two bounded negatives close the
// two places such a clause can live and still be obeyed.
//
// The empty-read clause is the first: "if the ref reads empty, use
// `headRefOid` instead" is the exception that reinstates the whole defect,
// and is exactly the mutant that escaped at the sibling site. This slice is
// that clause alone, where the PR object has no legitimate business at all.
const emptyReadClause = () =>
  between(
    DOC,
    "**An empty ref read is neither equal nor a mismatch**",
    "**Why the ref and not",
    "run-merge-bot.md's fallback empty-ref-read clause",
  );

test("an unreadable ref refuses, and never falls back to the PR object", () => {
  assert.match(emptyReadClause(), phrase("report the ref as unreadable and stop, `blocked`"));
  assert.doesNotMatch(
    emptyReadClause(),
    /headRefOid/,
    "the empty-ref-read clause hands the verdict to the PR object — the exception that reinstates the defect",
  );
});

// The arms are the second place. They are where the verdict is actually
// taken, so a `headRefOid` named inside one ("**Equal** — against the ref or
// the PR head — → proceed") is the operand back, under a wording no literal
// negative above covers. The arms name no source today and need none: the
// paragraphs above resolve the operand before the reader reaches them.
const arms = () =>
  between(DOC, "- **Equal** → proceed.", "**Plain `git fetch origin` only", "run-merge-bot.md's fallback arms");

test("no arm of the fallback names the PR object as a thing to compare against", () => {
  assert.doesNotMatch(
    arms(),
    /headRefOid/,
    "an arm names headRefOid — the verdict turns on the PR object again, whatever the paragraphs above say",
  );
  // Runs with the positives that make the negative mean something: a
  // `doesNotMatch` alone is satisfied by arms that were deleted.
  assert.match(arms(), phrase("**Equal** → proceed."));
  assert.match(arms(), phrase("**Worktree ahead** → STOP"));
  assert.match(arms(), phrase("**Worktree behind, or no worktree at all** → not a divergence"));
});

// The fail-open half, and the whole reason the OPERAND moved rather than the
// verdict gaining a settle window. Without it a reader is left with the false
// refusal alone — the cheap, visible half — and re-derives the settle-window
// remedy #1168's own ticket proposed, which fires only where the two operands
// disagree and so never reaches the pair that agrees. Pinned because that
// re-derivation restores the hole while looking like a fix.
//
// THE CEILING: the measurement sentence beside these clauses is deliberately
// unpinned — it is one run's reading at a sibling site, and re-measuring must
// not turn a test red.
const whyRef = () => paragraph(DOC, "**Why the ref and not", "run-merge-bot.md's fallback fail-open rationale");

test("the fallback says the PR-object compare fails open too, and that a re-read cannot fix it", () => {
  assert.match(whyRef(), phrase("both operands go stale in the SAME direction"));
  assert.match(whyRef(), phrase("fails OPEN as readily as it fails closed"));
  assert.match(whyRef(), phrase("the check reads **Equal**"));
  assert.match(
    whyRef(),
    phrase("Re-reading `headRefOid` on a settle window does not reach that half at all"),
  );
});

// The remedy for a mismatch and its bound, in one paragraph but four clauses
// that fail independently:
//
//   - no re-read at all, and a ref that moved mid-verification is read once
//     and acted on as a divergence;
//   - no bound, and the same instruction reads as "fetch until it agrees" —
//     the unbounded loop step 1 already had to be written out of once, and
//     the shape this doc forbids by name elsewhere;
//   - no refusal, and a head that moved during verification proceeds on an
//     audit of a tree that is gone;
//   - no `Equal`-is-unreachable clause, and the surviving mismatch can still
//     be waved through as equal, which is #1512's own defect restored one
//     paragraph later than where it was removed.
const reRead = () => paragraph(DOC, "**Unequal → `git fetch origin`", "run-merge-bot.md's fallback bounded re-read");

test("a mismatch is re-read exactly once, then refused rather than waited out", () => {
  assert.match(reRead(), phrase("`git fetch origin` and read the ref once more"));
  assert.match(reRead(), phrase("Bounded at one re-read, never a third"));
  assert.match(reRead(), phrase("refuse: report `head-moved-after-label-#<pr>` and stop"));
  assert.match(reRead(), phrase("Do not read a third time"));
  assert.match(
    reRead(),
    phrase("**`Equal` is not among the outcomes a surviving mismatch can reach**"),
  );
});

// The consequence of the operand swap that the swap alone does not settle.
// Against `headRefOid` the stale-plus-lagging worktree read EQUAL and never
// reached the arms; against the ref it reaches them, and the arms are labelled
// ahead/behind — a linear vocabulary the case does not fit, because a rebase
// orphans the pre-rebase head, so the ref does not carry the worktree's
// commits BY SHA even though it carries every patch in them. Read literally,
// "commits the ref lacks" sends a worktree holding no work of its own to the
// STOP: the false refusal, re-entering through the arm labels after being
// removed from the operand. The discriminator is `git cherry`, which this
// step already established two paragraphs up, and pinning it is what keeps
// the arms' unchanged behaviour actually reachable.
const armRouting = () => paragraph(DOC, "**Ahead or behind is", "run-merge-bot.md's fallback arm discriminator");

test("which arm a surviving mismatch takes is decided by patch equivalence, not by the sha compare", () => {
  assert.match(armRouting(), phrase("`git cherry origin/<branch> HEAD` from the worktree"));
  assert.match(armRouting(), phrase("not the sha compare"));
  assert.match(armRouting(), phrase("a `+` → ahead; no `+` → behind"));
});

// #1038's AC-4 is a property of the whole block, not of the two sentences that
// carried the false claim: no sentence in the fallback may say a local commit
// reaches the remote. The three positive pins cover the spans it was written
// in; this sweeps the rest, which is what catches a restore that lands in a
// paragraph nobody pinned. The negative runs with the property that MAKES it
// true on the same slice — the rebase is verification-only — because a bare
// `doesNotMatch` also passes on a slice that no longer says anything at all.
test("no sentence in the fallback claims the local rebase can carry a commit into the merge", () => {
  assert.match(
    fallbackBlock(),
    phrase("Rebase locally, for verification only — this rebase never needs to reach the remote"),
  );
  assert.doesNotMatch(fallbackBlock(), /carry[\s\S]{0,60}into the merge/);
});

// #1038. The STOP's verdict was right and its stated REASON was false: it
// justified halting because an unpushed commit is one "your rebase would
// carry into the merge", and the fallback contains no `git push`, no
// `--force` and no `--force-with-lease` at all. A refuter ran the documented
// sequence in a fixture: the unpushed commit appeared in neither the merge
// commit's ancestry nor its tree, while a control that pushed the rebased
// head did land it. The real hazard is the silent one — the fallback verifies
// the LOCAL rebased head, so a commit only the worktree holds moves the
// verified tree off the reviewed head and every green is measured against a
// tree no merge will take.
//
// Why the reason is load-bearing and not decoration: a bot that reasons from
// the old sentence, then observes that the fallback never pushes, can
// correctly conclude the stated hazard does not apply and proceed — the wrong
// action, reached from the page's own text. So the premise, the polarity
// clause and the wrong-tree clause are each pinned positively here, and the
// old reason's SHAPE is swept for one test above, over the whole fallback:
// a restore that replaces the corrected sentences reds these pins, while one
// that leaves both wordings standing — the two-sites-disagreeing shape this
// ticket exists to end — reds the sweep alone.
//
// Sliced to the arm itself, not to the whole fallback: `worktree-diverged`,
// the remote head and what gets verified all recur through the block's later
// paragraphs, and the sibling `Worktree behind` arm is the end bound, so a
// rationale lifted out of the bullet into prose below it reds here.
//
// MUTATION RECORD — #1038, scratch-copy method (`cp -R plugin/` to a tmp dir,
// mutate the copy, `node --test` the copy, read counts, discard; one mutant
// per copy, so the real checkout is never the subject). 16 semantic mutants,
// 8 controls, run against this file's 44 tests. Every mutant reds, and every
// red is a true positive:
//
// Red exactly one pin, the right one — the STOP rationale deleted; its
// polarity flipped to "can enter the merge"; the wrong-tree clause deleted;
// the rationale lifted out of the bullet into a paragraph below the arms (the
// slice bound); the fix-agent premise deleted; the verdict and identifier
// dropped (reds the verdict test alone, not the rationale one); the head
// check's verification clause softened to "the heads differ"; the old reason
// re-added BESIDE the corrected one at either site (reds the sweep alone);
// and each of the server-side paragraph's two corrected clauses deleted.
// Restoring the old reason by REPLACEMENT at either site reds two — that
// site's positive pin and the sweep — as does deleting the verification-only
// property, which reds the sweep and step 1's own fallback test.
//
// Controls all stayed 44/44 green: the STOP arm rewrapped at 80 columns, the
// premise at 60, the head check and the server-side paragraph at 70, the
// three unpinned sentences reworded (the silent-failure tail, the `+`-report
// tail, the head-check heading), and the sibling `Worktree behind` arm
// reworded — the pins refuse drift, not layout, and they do not reach the
// arm the ticket put out of scope.
const stopArm = () =>
  between(DOC, "- **Worktree ahead**", "- **Worktree behind", "run-merge-bot.md's fallback arms");

test("the STOP halts on verification against the wrong tree, not on a commit carried into the merge", () => {
  // the premise the old assertion carried on its true half: WHAT produces the
  // divergence. Retained here, or correcting the reason would quietly drop it.
  assert.match(stopArm(), phrase("leaves an unpushed, unreviewed commit that a clean-tree audit passes"));
  assert.match(
    stopArm(),
    phrase("Nothing on this path pushes, so that commit cannot enter the merge — what it corrupts is the verification"),
  );
  assert.match(
    stopArm(),
    phrase("both the `origin/main...HEAD` diff and the suite run against a tree that is not the reviewed head"),
  );
});

// The second site, and the reason a one-sentence fix would have been worse
// than the defect: the server-side paragraph did not merely omit the
// correction, it LAUNDERED the false reason — it told the reader that "your
// rebase would carry into the merge" names a hazard belonging to the fallback
// "where it still applies". Fix the STOP alone and that sentence stays on the
// page insisting the wrong reason is right, one paragraph above the bullet
// that now disagrees with it. Pinned inside the paragraph that carries the
// cross-reference, so the two sites cannot drift apart again in silence.
const plusOutcome = () =>
  paragraph(DOC, "**Neither result halts this path", "run-merge-bot.md's `+` outcome paragraph");

test("the server-side paragraph routes no carry-into-the-merge rationale to the fallback", () => {
  assert.match(plusOutcome(), phrase("neither path can carry a local commit to the remote, because neither pushes"));
  assert.match(
    plusOutcome(),
    phrase("so a commit only the worktree holds makes the verified tree something other than the reviewed head"),
  );
  assert.doesNotMatch(plusOutcome(), /carry[\s\S]{0,60}into the merge/);
});

// #447 AC-3, and the reason this pin reaches across files: run-team's failure
// table promised `worktree-diverged-#<pr>` for "the worktree ahead of the PR
// head" with no path qualifier, while the halt itself lives only in the
// fallback. Whichever file is edited alone, the other goes back to lying.
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");

// Sliced to the failure table alone. Unbounded, `worktree` and `fallback` both
// occur freely elsewhere in a file thousands of lines long.
function failureTable() {
  const start = "## Failure handling";
  const at = RUN_TEAM.indexOf(start);
  assert.notEqual(at, -1, `'${start}' moved — update this test`);
  const rest = RUN_TEAM.slice(at + start.length);
  const end = rest.indexOf("A red PR never silently becomes");
  assert.notEqual(end, -1, "the failure table's end marker moved — update this test");
  return rest.slice(0, end);
}

test("run-team scopes the diverged-worktree row to the fallback, not to every merge path", () => {
  assert.match(
    failureTable(),
    /\| Merge bot finds the worktree ahead of the PR head \*\*on the local-rebase fallback\*\* \|/,
  );
});

// #903: the poll read `gh pr view <pr> --json headRefOid` — the one field that
// desyncs from the branch it is meant to be watching. Measured on this repo:
// `gh pr update-branch --rebase` landed and moved the ref to 221f4e9 while
// headRefOid stayed on the pre-rebase 8bc2cc4 with no CI run on the new head,
// so the poll read a landed rebase as un-landed for all 60 iterations and fell
// through to the local-rebase fallback — which would have replayed commits the
// remote already carried. Both halves pinned: the ref read must be PRESENT, and
// the sentence naming which source is authoritative must survive with it. The
// second assert is what stops a future edit reverting the mechanism while
// leaving a now-lying rationale behind.
test("step 1 polls the branch ref, not the PR object's head", () => {
  // anchored to the POLL assignment inside the loop, not to any ls-remote in
  // step 1 — the `pre=` line uses the same command, so a bare presence match
  // stays green when only the loop body is reverted. Measured: it did.
  assert.match(step1(), /\n\s+post=\$\(git ls-remote origin "\$ref" \| cut -f1\)/);
  assert.match(step1(), /\*\*Poll `git ls-remote`, not `gh pr view headRefOid`\*\*/);
  // The DETECTOR, not just the fix. Both prose rules above describe a `pr_head`
  // field the printf has to actually emit, so deleting it leaves the doc
  // describing a field it no longer prints. Measured: with only the two asserts
  // above, deleting the printf field left this file 15/15 and the suite
  // 1155/1155, byte-identical to baseline. Bare /pr_head/ and /headRefOid/
  // matches were measured green on that same mutant too — `headRefOid` survives
  // in the headline and in "Keep the `headRefOid` read", and `pr_head` in the
  // desync verdict and the `<pr_head>` ancestry command — so both are anchored
  // to their own line here.
  assert.match(step1(), /\n\s+printf 'rc=%s branch=%s pre=%s post=%s pr_head=%s\\n%s\\n'/);
  assert.match(step1(), /\n\s+"\$\(gh pr view <pr> --json headRefOid -q \.headRefOid\)" "\$out"/);
});

// The settle-window paragraph is bracketed in the doc by two rules that ARE
// pinned — the test above anchors the headline naming which source is
// authoritative, the test below the ancestry precondition — and neither reaches
// the paragraph between them. That gap is the shape #1147 was scored for in this
// branch's own tier row: every explanatory sentence around a mandate pinned, the
// mandate itself left bare, so inverting it to "either is fine" costs nothing.
// Measured against the doc as it stood before this test existed: inverting the
// imperative to "report the desync on the first `headRefOid` read … without any
// re-poll or cap", deleting the whole paragraph, and reverting the prose hunk
// outright each left the whole suite green. So this anchors the two imperative
// clauses and nothing else.
//
// The clauses are split because they fail independently: dropping "on the same
// bounded cap" turns a bounded re-poll into an unbounded one while the "only if"
// clause still reads correctly, and dropping "only if … runs out" restores the
// single-read verdict while the re-poll instruction still stands.
//
// THE CEILING: the surrounding measurement sentence is deliberately unpinned —
// it reports one run's observed attempt numbers and wall clocks, and re-measuring
// must not turn a test red.
test("step 1 re-polls before calling a desync, and that mandate is pinned", () => {
  assert.match(
    step1(),
    /re-poll `headRefOid` on the same bounded cap you already use for `ls-remote`/,
  );
  assert.match(
    step1(),
    /report the desync only if `pr_head` is still on `pre` when that cap runs out/,
  );
});

// #903's expensive half. Close-and-reopen is the usual remedy for a desynced PR
// and is normally reversible — but a rebase orphans the recorded head by
// construction, and that is the very event that produced the desync. Measured:
// three reopen attempts on #903 each returned `Could not open the pull request`,
// and the only recovery was a replacement PR (#908), losing the review thread
// and every label on it. The precondition is the whole rule, so it is pinned
// alongside the verdict it forces.
test("step 1 requires an ancestry check before closing a desynced PR", () => {
  assert.match(step1(), /git merge-base --is-ancestor <pr_head> origin\/<branch>/);
  assert.match(step1(), /Non-ancestor → \*\*do not close\*\*/);
});

// #908: a controller brief predicted the merge would be "a fast-forward". True
// of the CONTENT (merge tree == pin tree == 988f29d1, `git diff` empty) and false
// of the SHAPE — `gh pr merge --merge` wrote two parents. The distinction is not
// cosmetic: prove-merge.sh guards the SHAPE with `[ "$parents" -ge 2 ]`, dying
// at "has no second parent — not a merge commit", and die() exits 2 — so an
// actual fast-forward yields no proof and a halt. Anchored on those strings
// rather than a line number, which drifted repeatedly here (#1136). Pinned so
// a future member cannot read the doc as permitting one.
test("step 4 says why --merge is load-bearing, not merely which flag to type", () => {
  assert.match(step4(), /\*\*`--merge` \(no-ff\) is load-bearing, not stylistic/);
  assert.match(step4(), /has no second parent — not a merge commit/);
  // pins the VALUE, not the markdown around it: a cosmetic reflow dropping the
  // bold must not red a correct document. Still discriminating — measured,
  // `exits **1**` reds this assert both with and without the bold.
  assert.match(step4(), /exits\s+\**2\**/);
});

// #18. Load-bearing like its sibling paragraphs in this section: without this
// pin, a future edit could soften "write it against `gates` instead" or drop
// it, and the doc would go on recommending a sanity check against a flat field
// that flips its own polarity per proof path.
test("step 4 says to read gates, not the flat fields", () => {
  assert.match(step4(), /Read `gates`, not the flat fields/);
  assert.match(step4(), /write it against `gates` instead/);
});

test("step 4 expects the fallback path to disprove, not to silently count as proved", () => {
  assert.match(step4(), /A `rebase-fallback-#<pr>` merge is expected to disprove here/);
  assert.match(step4(), /never as `proved`/);
});

// Bounded to the Report line itself. An unbounded whole-file match is the
// vacuous pin this file's header forbids: the token surviving anywhere else in
// the doc would mask its removal from the vocabulary list.
test("the report vocabulary includes rebase-fallback", () => {
  assert.match(DOC, /^Report merged [^\n]*rebase-fallback-#X/m);
});

// #966. The merge bot's falsifiability proof writes synthetic `ci-state`
// fixtures, and the doc said nothing about WHERE. The scratchpad root every
// dispatched member is handed is ONE shared root, not a per-member one, and
// the fixture names are identical across waves by design — measured
// 2026-08-28, merge-bot-5 found a sibling's payloads for a different PR (a
// different `prHead`) sitting in the root it was about to write. Benign that
// time; the shape it was one filename away from is a GREEN fixture standing
// in for a blocking one, which inverts the proof without changing a word of
// the report the bot then files.
//
// Sliced to the new section. Unbounded, `scratch`, `mkdir`, `gate` and
// `prHead` all recur through the per-PR sequence, the no-undo audit and the
// watcher loop, so every assertion below would survive deletion of the
// section itself.
//
// THE CEILING: presence pins on prose, same as every other slice in this
// file. They prove the rules are stated where the bot reads them — before the
// per-PR sequence, not after it. Nothing here runs a merge bot, creates a
// directory, or drives a payload through a gate.
//
// MUTATION RECORD — scratch-copy method (`cp -R plugin/` to a tmp dir,
// mutate the copy, `node --test` the copy, read counts, discard; one mutant
// per copy, so the real checkout is never the subject). 17 semantic mutants,
// 6 controls, all run against this file's 35 tests:
//
// Every semantic mutant reds EXACTLY ONE test, and the right one — the
// requirement deleted; the green-but-behind shape dropped; `pr<N>` dropped
// from the fixture path; the scratch-root prohibition deleted; the "never
// `mkdir -p`" clause flipped to "with `mkdir -p`"; the per-PR rationale deleted;
// the shared-root sentence deleted; the by-design name collision deleted;
// the harm rewritten as clutter; `mkdir -p`'s half of the exit-code contrast
// deleted; the occupied-namespace step deleted; set equality softened to
// "should generally be"; the unconditional-refusal sentence deleted; the
// live payload un-namespaced; the finding-id rationale deleted; and both
// halves of the run-team paragraph, separately.
//
// Controls all stayed 35/35 green: the section rewrapped at 80 columns, the
// run-team paragraph rewrapped at 70, every `**` stripped from the section,
// and three unpinned sentences reworded. `phrase()` is what buys the
// reflows; excluding markdown from the pinned spans is what buys the bold
// strip — the pins refuse drift, not layout.
//
// Slice bound measured, not assumed: deleting the whole section reds 9 of
// the 10 tests added here — the tenth reads run-team's SKILL.md, not this
// doc, and correctly survives — so no assertion below is satisfiable from
// elsewhere in `run-merge-bot.md`. Deleting that run-team paragraph reds
// exactly the tenth.
const gateProof = () =>
  between(DOC, "## Prove the gate blocks, in a directory you own", "## Per-PR sequence", "run-merge-bot.md");

// One span, not two matches: the imperative and what discharges it. Pinned
// separately, "prove it can go red" is satisfied by any nearby sentence
// mentioning the gate, and the requirement degrades to a slogan with no
// stated way to meet it.
test("the proof is required before a green is trusted, and is discharged by driving each shape through the real gate", () => {
  assert.match(
    gateProof(),
    phrase(
      "prove it can go red before you trust a green: drive a synthetic `ci-state` payload of each shape below through the gate you actually run, and confirm each one blocks",
    ),
    "the proof requirement is no longer bound to driving each shape through the gate the bot actually runs",
  );
});

// The set itself. A proof is only as strong as the shapes it drives, and each
// of these fails a different way — two pass a subset gate vacuously, one
// yields no output to compare at all, one is green on the wrong base, one is
// not finished. Dropping any one leaves a hole no other shape covers.
test("the section names every shape the gate has to refuse", () => {
  const s = gateProof();
  assert.match(s, phrase('`{"verdict":"rate-limited"}`'), "the rate-limited shape is gone from the proof set");
  assert.match(s, phrase("`{}`"), "the empty-object shape is gone from the proof set");
  assert.match(s, phrase("A zero-byte file"), "the zero-byte shape is gone from the proof set");
  assert.match(s, phrase("`verdict: \"green\"` with `behind` greater than 0"), "the green-but-behind shape is gone from the proof set");
  assert.match(s, phrase("A run still in progress"), "the in-progress shape is gone from the proof set");
});

// The path and the tool that claims it, in one span, with the scratch root
// excluded in the middle of it. `mkdir -p` is the natural thing to type and
// the one thing that cannot work here: it succeeds on a directory someone
// else created and hands over its contents, which is precisely the adoption
// this rule exists to refuse. An edit keeping the path and dropping either
// prohibition must not pass.
test("the fixture path is bound to the plain mkdir that claims it, and to not writing in the root", () => {
  assert.match(
    gateProof(),
    phrase(
      "Every fixture you write goes under `<scratch>/pr<N>/merge-bot-<wave#>/gate-proof/`, never into the scratch root by itself, and you create that leaf with plain `mkdir`, never `mkdir -p`",
    ),
    "the gate-proof fixture path is no longer bound to both the scratch-root prohibition and creating the leaf with plain `mkdir`",
  );
  // WHY the key is the PR and not the pass: a per-pass proof is one proof
  // reused across merges it never covered. The path pinned above is the
  // rule; this is the sentence that stops a later edit from re-keying it.
  assert.match(
    gateProof(),
    phrase("`pr<N>` is the PR you are about to gate, so the proof is bound to the merge it licenses instead of being driven once for the pass"),
    "the per-PR key is no longer tied to binding each proof to the merge it licenses",
  );
});

// Why the rule exists at all, on both legs: the root is shared and injected
// (not something the bot opted into), and the fixture NAMES are shared too,
// which is what makes the collision systematic rather than bad luck. Drop the
// second leg and a reader concludes a distinctive filename would do.
test("the shared injected root and the identical fixture names are both named as the mechanism", () => {
  const s = gateProof();
  assert.match(
    s,
    phrase(
      "The scratchpad root your own system prompt names is injected into every dispatched member and is shared with every sibling in the session; nothing partitions it but this rule",
    ),
    "the section no longer names the scratch root as injected and shared with every sibling",
  );
  assert.match(
    s,
    phrase("is the name every wave's bot reaches for, by design, so a collision here is systematic rather than unlucky"),
    "the section no longer says the fixture names collide by design",
  );
});

// The harm, stated as a false measurement rather than as untidiness — the
// framing that gets a rule obeyed. One span through the report the bot files,
// because the inverted proof and the confident report are the same fact: a
// pin on the fixture half alone survives deletion of what it costs.
test("the harm is a proof that silently did not happen, not a messy directory", () => {
  assert.match(
    gateProof(),
    phrase(
      "a sibling's GREEN fixture sitting under the name your loop expects to BLOCK makes that shape pass through, and you report the gate proven falsifiable with every shape blocked while the one that mattered was never measured",
    ),
    "the section no longer states the harm as an inverted proof reported as a passing one",
  );
});

// Why plain `mkdir` is the check and not a style preference. Both exit codes
// in one span: the refusal is only meaningful against what `-p` does instead,
// and a reader who knows only half of it reaches for `-p` the first time a
// path is missing.
test("mkdir is stated as the check, against what mkdir -p does instead", () => {
  assert.match(
    gateProof(),
    phrase(
      "It exits 1 with `File exists` on a path that already exists, so a directory you did not create refuses you at the moment you claim it, while `mkdir -p` exits 0 and hands you its contents silently",
    ),
    "the section no longer contrasts `mkdir`'s fail-closed refusal with `mkdir -p`'s silent success",
  );
});

// The refusal needs an exit, or a blocked bot invents one — and the invented
// one is `-p`. Bound to the report, so the directory actually used is
// recoverable afterwards.
test("an occupied namespace has a stated next step that is not writing into it", () => {
  assert.match(
    gateProof(),
    phrase(
      "take `gate-proof-2` and say in your report which directory you used, rather than writing into theirs",
    ),
    "the occupied-namespace path no longer names a fresh directory and the report that records it",
  );
});

// #966's second question, answered in the doc: the bot verifies the shapes it
// drove are its own. One span through the verdict, because a check whose
// failure has no stated consequence gets logged and walked past — "refuses
// the proof rather than folding the extra in" is the whole of it.
test("the shapes driven must equal the shapes written, and a mismatch refuses the proof", () => {
  assert.match(
    gateProof(),
    phrase(
      "the set of shapes you drove must be exactly the set you wrote — same count, same names — and a mismatch refuses the proof rather than folding the extra in",
    ),
    "the section no longer requires the driven set to equal the written set, or no longer refuses on a mismatch",
  );
  // The refusal is unconditional. Every payload inherited in the measured
  // instance was block-shaped, so the tempting reading is that absorbing one
  // is harmless — it is not, because a shape you did not write is a shape
  // you did not measure, and "measured" is the claim being made.
  assert.match(
    gateProof(),
    phrase("Refuse even when the intruder is block-shaped and appears to strengthen the proof"),
    "the refusal is now conditional on the foreign fixture looking dangerous",
  );
});

// The other half of the namespace: the live reading sits one level up from
// the fixtures, under the same per-PR path, so a synthetic shape and a real
// payload can never occupy one filename — and so the count check above,
// which counts the whole directory, stays exact.
test("the real ci-state reading is kept out of the fixture directory, under the same per-PR path", () => {
  const s = gateProof();
  assert.match(
    s,
    phrase(
      "keep the `ci-state` payload you actually gate on one level up, at `<scratch>/pr<N>/merge-bot-<wave#>/ci.json`, so a synthetic shape can never be read back as a live reading and the count above stays exact",
    ),
    "the live ci-state payload is no longer kept out of the fixture directory under the same per-PR path",
  );
  // Why run-team's existing two-level rule does not already cover this. A
  // reader who thinks it does deletes this section as a duplicate.
  assert.match(
    s,
    phrase("gate fixtures have no finding id, which is exactly why that rule never reached them"),
    "the section no longer says why run-team's `<scratch>/pr<N>/<finding>/` rule does not reach gate fixtures",
  );
});

// #966 follow-up: the prose above only ever proved a fixture existed
// somewhere in the document; the executable skeleton drives the actual gate
// and had no assertion of its own. Pinning it directly against mutation:
// flipping `mkdir` to `mkdir -p`, deleting the count-check lines, re-keying
// the namespace to wave-only, or deleting the whole bash block must each
// red at least one test below.
test("the skeleton claims its namespace with a plain, non-clobbering mkdir", () => {
  const s = gateProof();
  assert.match(s, phrase('mkdir "$d" 2>/dev/null && break'), "the skeleton no longer claims the leaf with a plain, fail-closed mkdir");
  assert.doesNotMatch(s, /mkdir -p "\$d"/, "the leaf mkdir now silently succeeds on a directory someone else already owns");
});

test("the skeleton retries the documented gate-proof-2 fallback and re-points $d at the namespace it actually claimed", () => {
  const s = gateProof();
  assert.match(s, phrase('for n in "" -2; do'), "the skeleton no longer retries the documented gate-proof-2 fallback on a collision");
  assert.match(s, phrase('d="$base/gate-proof$n"'), "$d is no longer re-pointed at whichever namespace the retry loop actually claimed");
  assert.match(s, phrase('[ -n "$d" ] || exit 1'), "an occupied primary and fallback no longer abort the skeleton instead of reading the wrong directory");
});

test("the skeleton's base path is keyed on both the PR and this pass's wave", () => {
  assert.match(
    gateProof(),
    phrase("base=<scratch>/pr<N>/merge-bot-<wave#>"),
    "the skeleton's base path no longer matches the documented per-PR, per-wave namespace",
  );
});

test("the skeleton's wrote counter increments on a real line, not only inside a comment", () => {
  assert.match(
    gateProof(),
    /^wrote=\$\(\(wrote\+1\)\)$/m,
    "wrote is only incremented inside a comment, so a literal copy of the skeleton leaves it at 0 forever",
  );
});

test("the skeleton floors the driven count at 5 and refuses on a name mismatch, not just a count mismatch", () => {
  const s = gateProof();
  assert.match(
    s,
    phrase('[ "$wrote" -eq 5 ] || { echo "PROOF VOID: $wrote shapes driven, need 5"; exit 1; }'),
    "the skeleton no longer floors the driven count at exactly 5 shapes, or the floor no longer exits non-zero",
  );
  assert.match(
    s,
    phrase('got=$(ls -1 "$d" | sort | tr'),
    "the skeleton no longer compares the written fixture names, only their count",
  );
  assert.match(
    s,
    phrase('[ "$got" = "$names " ] || { echo "PROOF VOID: wrote {$got}, expected {$names }"; exit 1; }'),
    "a name mismatch no longer exits non-zero, so a subset of the 5 named shapes would pass silently",
  );
});

// Cross-file, and the only half the controller can act on: the runbook above
// is what the BOT reads, so nothing in it reaches a controller reading a
// finished report. Sliced to the gate cluster's tail — `scratch`, `shared`
// and `directory` all recur through a 2000+ line file, and the question
// belongs beside the other one the controller is told to ask, not in an
// appendix.
const dispatchAsk = () =>
  between(
    RUN_TEAM,
    "So **gate on the payload's own fields**",
    "**You own the watcher, not the bot.**",
    "run-team/SKILL.md's Merge bot gate spec",
  );

test("the controller is told to ask which directory the bot proved its gate in", () => {
  const s = dispatchAsk();
  assert.match(
    s,
    phrase(
      "The scratch root the harness injects is one directory shared by every member you dispatch, so a proof driven in the root itself can absorb a sibling's fixtures and still report every shape blocked",
    ),
    "the dispatch section no longer says a proof driven in the shared root can absorb a sibling's fixtures and still report clean",
  );
  // The question itself, bound to the answer that fails it — same shape as
  // the fields question this sits beside ("a bot that cannot answer has not
  // got one"), because an unanswerable question with no stated verdict is
  // asked once and dropped.
  assert.match(
    s,
    phrase("what you own is the bot that cannot name its directory, the same way you own the one that cannot name its fields"),
    "the dispatch section no longer treats a bot that cannot name its proof directory as the controller's finding",
  );
});

// #705. `pr-overlap.mjs` grew a fourth signal, and a signal the runbook does
// not name is a signal the bot never reads — which is the same silent failure
// the ticket is about, moved from the script into its caller. The count is
// pinned in both of the places this document states it, because they rot
// independently: the invocation paragraph tells the bot what "firing" means,
// and the verdict-strength line tells it how hard to hold. Sliced to the hold
// rule alone — unbounded, "four signals" anywhere later in a 300-line
// document would satisfy these with the rule itself reverted to three.
const holdRule = () => between(DOC, "Before touching labeled PR `N`", "## The labelled head", "the hold rule");

test("the hold rule names all four signals, prose included", () => {
  const s = holdRule();
  assert.match(
    s,
    phrase("**Any** of its four signals (`files`, `modules`, `dirs`, `prose`) firing means related"),
    "the hold rule no longer names four signals — pr-overlap.mjs computes `prose` and a bot reading three ignores it",
  );
  assert.match(
    s,
    phrase("Directory-only and prose-only hits prompt investigation"),
    "the hold rule no longer rates a prose hit as weak evidence beside a directory one",
  );
});

// The half that is not the count: an empty `prose[]` is a clear only when the
// scan covered the diff, and the script reports that in its own field rather
// than on stderr alone. A runbook that names the signal and not its unrun
// field reintroduces #705's exact shape — the clearest-looking output being
// the one that missed something — one level in.
test("the hold rule says prose=0 clears only when proseUnrun is null", () => {
  assert.match(
    holdRule(),
    phrase("**`prose=0` is a clear only when `proseUnrun` is `null`.**"),
    "the hold rule no longer gates an empty prose result on the scan having run",
  );
});

// The soft-signal bullet this mechanises. It predates the signal and stayed
// pure judgement for years; what changed is that one third of it — a data
// file cited by name — now has a mechanism, and the bullet has to point at it
// or the bot re-derives by hand what the script already computed. The other
// two thirds deliberately stay human: the paragraph below the bullet is the
// measurement (two PRs sharing `reset_hint=`/`resetHint`/`terminalFailure`,
// provably unrelated) that says mechanising a bare symbol name would cost
// more than it buys.
test("the same-docs-section bullet points at signal 4 and keeps symbols human", () => {
  const s = paragraph(DOC, "they change the same exported symbol", "the same-section bullet");
  assert.match(
    s,
    phrase("signal 4 mechanises the half of this where the section is a **data file** cited by name"),
    "the same-section bullet no longer names the signal that mechanises its data-file half",
  );
  assert.match(
    s,
    phrase("a bare symbol or key name is still yours to read"),
    "the same-section bullet no longer keeps bare symbol and config-key matching a human read",
  );
});
