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

const REPO = join(import.meta.dirname, "..", "..", "..");
const DOC = readFileSync(join(REPO, "skills", "fleet", "commands", "run-merge-bot.md"), "utf8");

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
    /Both fail only where the ref FILE is itself the broken one — unreadable, or holding text that is not a SHA — and there the SHA `cat` already printed, in the reflog's second field, is what `git stash show -p <that sha>` recovers instead/,
  );
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
// wording must NOT license skipping the STOP where the hazard is real. On the
// fallback the bot rebases locally and then verifies that local head, so an
// unpushed commit corrupts what you verify — the STOP's own wording for that
// hazard is *your rebase would carry into the merge*, and that sentence is
// what this pins. (The merge itself still takes the remote head there too;
// the fallback "never needs to reach the remote" and step 4 merges "the
// pre-rebase head, since nothing here was pushed".) Pinned positively — the
// verdict and its rationale, both inside the bullet that carries them —
// rather than by forbidding a word, which would red on an unrelated correct
// edit.
//
// Sliced to the fallback, not to step 1: the citation of that same rationale
// in the server-side paragraph satisfies a bare step1() match all by itself,
// so a step1()-wide assertion stayed green with the rationale deleted from the
// bullet (measured by mutation, 2026-08-29).
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
  assert.match(
    fallbackBlock(),
    /leaves an unpushed, unreviewed commit that a clean-tree audit passes and your rebase would carry into the merge/,
  );
});

// #447 AC-3, and the reason this pin reaches across files: run-team's failure
// table promised `worktree-diverged-#<pr>` for "the worktree ahead of the PR
// head" with no path qualifier, while the halt itself lives only in the
// fallback. Whichever file is edited alone, the other goes back to lying.
const RUN_TEAM = readFileSync(join(REPO, "skills", "fleet", "skills", "run-team", "SKILL.md"), "utf8");

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
// cosmetic: prove-merge.sh:173 is `[ "$parents" -ge 2 ] || die "... not a merge
// commit"` and die() exits 2, so an actual fast-forward yields no proof and a
// halt. Pinned so a future member cannot read the doc as permitting one.
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
