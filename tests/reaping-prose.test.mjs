// #87. Three documents said `release-ticket.sh` recomputes all four
// preconditions at the moment of the delete. Two things are wrong with that,
// and only the second is obvious once stated.
//
// The dirty check is the CONDITIONAL one: it opens inside
// `[ -n "$wt" ] && [ -d "$wt" ]`, so a claim whose worktree directory is
// established absent has three preconditions recomputed, not four. (The
// established-absent path is the only one that reaches the delete with it
// skipped — a directory git cannot stat dies on the unknown-existence guard
// above it, and a non-directory blocks.)
//
// And `git worktree remove` without `--force` is no backstop for the one it
// skips. It gates its own clean check on the same `stat` the script's `gone`
// guard does, so it is not an independent second opinion — it reaches the same
// verdict by the same means. Measured here, git 2.50.1 (Apple Git-155):
//
//   path stattable + untracked file -> rc 128, "contains modified or untracked
//                                      files, use --force to delete it"
//   directory rm -rf'd              -> rc 0, entry deregistered
//   live worktree, chmod 000 parent -> rc 0, entry deregistered, the untracked
//                                      file still sitting on disk
//
// That third row is the whole point: git deregistered a worktree that was
// holding uncommitted work, at rc 0, because it could not stat it either. It is
// why the fail-open fixed in `1e54bac` survived being reasoned about — guard and
// backstop fail on the same inputs — and why the guard establishes absence
// instead of inferring it from a failed `-e`.
//
// Pinned where the claim is made, because a correction applied to one
// document is the one a reader does not reach: reaping.md carries the
// evidence, and release-ticket.sh's own comment sits at the check. SKILL.md
// no longer restates the release's or the reap's preconditions — its event
// loop left it — so it keeps only the by-hand fallback a refusal sends the
// controller to, pinned below.
// The script's header (release-ticket.sh) already carried the corrected
// wording when this was filed; the comment at the dirty check did not.
//
// NOT pinned, deliberately: reap.sh's sibling prose. Its "recomputed inside this
// invocation" makes no delete-time claim, and reaping.md's reap-side
// "double-covers dirty check" is about the BREADTH of what git refuses on
// (modified and untracked) rather than independence from the stat — reap routes
// cannot-stat to KEEP before its delete is reachable, so its delete is never
// sole arbiter of a path it could not stat.
//
// THE CEILING, same as refuter-scratch-prose.test.mjs: these are PRESENCE pins
// over a bounded slice, each a single regex, so text spliced INSIDE a pinned
// clause reddens them. What they cannot catch is a whole new sentence appended
// AFTER a clause carving out an exception. Reflow stays green by design — the
// words are pinned, not their layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pin } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..", "plugin");
const REAPING = Pin.file(join(REPO, "skills", "run-team", "references", "reaping.md"));
const RUN_TEAM = Pin.file(join(REPO, "skills", "run-team", "SKILL.md"));
const SCRIPT = Pin.file(join(REPO, "scripts", "release-ticket.sh"));

const releaseSection = () =>
  REAPING.section("## Why reap declines a claim that was never dispatched", "reaping.md").text;

test("reaping.md: the dirty check is named as the conditional precondition", () => {
  // Without this, "four preconditions, recomputed inside same invocation as
  // delete" reads as four checks that always run — and the claim whose worktree
  // directory is gone gets released on three.
  assert.match(
    releaseSection(),
    /dirty\s+check\s+is\s+the\s+conditional\s+one.{0,120}only\s+when\s+the\s+worktree\s+directory\s+is\s+there\s+to\s+read.{0,120}established\s+absent\s+it\s+does\s+not\s+run\s+at\s+all/s,
    "the dirty check reads as unconditional again — it opens inside `[ -d \"$wt\" ]`, so a claim whose worktree directory is established absent has three preconditions recomputed, not four",
  );
});

test("reaping.md: worktree remove's refusal is scoped to the live directory and named as the same stat", () => {
  // ONE contiguous span, not three asserts: the scope, the shared stat and the
  // sole-arbiter consequence are the same claim, and a sentence spliced between
  // them can carve the exception back out.
  assert.match(
    releaseSection(),
    /live-directory\s+case\s+ONLY.{0,200}same\s+`stat`.{0,200}not\s+an\s+independent\s+second\s+opinion.{0,400}sole\s+arbiter/s,
    "the delete-time backstop reads as covering the dirty check outright again — `worktree remove` gates its clean check on the same stat the guard does, accepts an unstattable path at rc 0, and deregisters a worktree still holding work (measured, git 2.50.1)",
  );
});

test("reaping.md: the rc-0 deregistration of an unstattable worktree is measured, not asserted", () => {
  assert.match(
    releaseSection(),
    /rc\s+0.{0,160}still\s+on\s+disk.{0,80}measured,\s+git\s+2\.50\.1/s,
    "the measurement behind the correction is gone — without it the claim is one more assertion about git, which is what produced the wrong text in the first place",
  );
});

test("reap.sh: its worktree check runs before the delete", () => {
  // Live lines only: both names recur in comments, and a comment hit would
  // read as the code.
  const lines = readFileSync(join(REPO, "scripts", "reap.sh"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(?:#|echo\b)/.test(l));
  const only = (re, what) => {
    const hits = lines.flatMap((l, i) => (re.test(l) ? [i] : []));
    assert.equal(hits.length, 1, `reap.sh: expected exactly one live line that ${what}, found ${hits.length}`);
    return hits[0];
  };
  const check = only(/^\s*if\s+wt_holding\s+"refs\/heads\/\$b"/, "runs wt_holding on the branch");
  const del = only(/\bgit\s+update-ref\s+--no-deref\s+-d\s+"refs\/heads\/\$b"\s+"\$tip"/, "runs `git update-ref -d` on the branch at its tip");
  assert.ok(check < del, "reap.sh runs its worktree check after the delete, not before it");
});

test("run-team/SKILL.md: the by-hand fallback names worktree-audit.sh's no-argument contract", () => {
  // #525. The by-hand fallback for a claim `release-ticket.sh` refused sends
  // the reader to `worktree-audit.sh`, which takes NO argument and audits
  // every worktree at once — unlike the path-taking siblings all around it in
  // this runbook. Passing it this claim's worktree path is exit 2; before
  // #525's guard it was worse, a full audit of every OTHER worktree at exit 0
  // with the main checkout as the first row, read as if it were this claim's.
  //
  // The slice is the Failure handling row's own sentence about the refusal.
  const fallback = RUN_TEAM.between(
    "**That refusal is the",
    "Update the released tickets' ledger rows",
    "run-team/SKILL.md",
  ).text;
  // ONE contiguous phrase: the no-argument half and the row-lookup half are
  // the same instruction. Pinned separately, dropping the lookup leaves a
  // reader taking the first row — the main checkout — as this claim's.
  assert.match(
    fallback,
    Pin.phrase("run `worktree-audit.sh` (it audits every worktree; find this claim's row in the output)"),
    "the by-hand fallback no longer says `worktree-audit.sh` audits every worktree and needs a row lookup — a reader passing it this claim's path gets exit 2, and one reading the first row reads the main checkout",
  );
});

test("release-ticket.sh: the comment at the dirty check does not contradict the header above it", () => {
  // The header (release-ticket.sh) states the limitation; this comment
  // said git recomputes this same check at the delete, full stop. Whichever a
  // reader reaches first is the one they act on.
  const comment = SCRIPT.between(
    "  # Ignored files are deliberately not a blocker",
    "  n=$(printf",
    "release-ticket.sh",
  ).stripGutter("#").text;
  assert.match(
    comment,
    /recomputed\s+by\s+git\s+at\s+the\s+moment\s+of\s+the\s+delete.{0,120}only\s+while\s+the\s+directory\s+is\s+there/s,
    "the dirty-check comment claims an unqualified delete-time recomputation again, contradicting this script's own header",
  );
});
