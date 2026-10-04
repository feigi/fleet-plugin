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
// Pinned in all four places the claim is made, because a correction applied to
// one document is the one a reader does not reach: SKILL.md asserts, reaping.md
// carries the evidence, and release-ticket.sh's own comment sits at the check.
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
import { between, paragraph, phrase, stripHashGutter } from "./prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const REAPING = readFileSync(
  join(REPO, "skills", "run-team", "references", "reaping.md"),
  "utf8",
);
const RUN_TEAM = readFileSync(join(REPO, "skills", "run-team", "SKILL.md"), "utf8");
const SCRIPT = readFileSync(join(REPO, "scripts", "release-ticket.sh"), "utf8");

const releaseSection = () =>
  between(
    REAPING,
    "## Why reap declines a claim that was never dispatched",
    "## Never reap a branch a live member is on",
    "reaping.md",
  );

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

test("run-team/SKILL.md: the release-claims section carries the same limitation", () => {
  // The assertion doc is where a controller actually reads this. Corrected in
  // reaping.md alone, it is corrected in the document nobody opens mid-run.
  const section = between(
    RUN_TEAM,
    "### Release the claims that never became PRs",
    // Short of a wrap point: SKILL.md hard-wraps this sentence mid-phrase.
    "**That refusal is the",
    "run-team/SKILL.md",
  );
  assert.match(
    section,
    /whenever\s+the\s+worktree\s+directory\s+is\s+there\s+to\s+read.{0,200}established\s+absent.{0,120}no\s+backstop.{0,200}sole\s+arbiter/s,
    "SKILL.md is back to promising all four preconditions are recomputed at the delete — the dirty check does not run when the directory is established absent, and `worktree remove` does not stand in for it",
  );
});

test("run-team/SKILL.md: the release deletes the branch with update-ref's compare-and-swap, not `-D`", () => {
  // release-ticket.sh deletes with `git update-ref -d refs/heads/<branch> <tip>`
  // on a tip read once, which refuses if the ref moved off that tip. SKILL.md
  // kept saying `-D` after the script stopped using it, so a controller read
  // the release as a force-delete of whatever the ref held at that moment.
  const section = between(
    RUN_TEAM,
    "### Release the claims that never became PRs",
    "**That refusal is the",
    "run-team/SKILL.md",
  );
  assert.match(
    section,
    phrase("deletes the branch with `git update-ref -d` on the tip it read once"),
    "SKILL.md's release section no longer names `git update-ref -d` on a tip read once as the branch delete",
  );
  assert.match(
    section,
    phrase("compare-and-swap that refuses if the branch has moved off that tip"),
    "SKILL.md's release section no longer says the update-ref delete is a compare-and-swap that refuses if the branch has moved off the tip",
  );
  assert.doesNotMatch(
    section,
    /(?:deletes?|deleted)\s+(?:the\s+branch\s+)?(?:is\s+)?with\s+`(?:git\s+branch\s+)?-D`/,
    "SKILL.md's release section says the branch is deleted with `-D` — release-ticket.sh deletes it with `git update-ref -d`",
  );
});

// The reap paragraph's twin of the release pin above. reap.sh deletes a
// `[gone]` branch with `git update-ref --no-deref -d refs/heads/<b> <tip>`,
// never `-D`, and keeps a branch the cherry check cleared whenever a fresh
// worktree check finds it held — so naming `-D`, or the cherry check as the
// delete's only authorizer, is false as written.
const reapParagraph = () =>
  paragraph(RUN_TEAM, "`~/.fleet/bin/fleet-run reap.sh --apply` recomputes every precondition", "run-team/SKILL.md's reap paragraph");

test("run-team/SKILL.md: reap's cherry check authorizes the update-ref delete, with the fresh worktree check beside it", () => {
  const p = reapParagraph();
  assert.match(
    p,
    phrase("`git cherry origin/main` to authorize the `git update-ref -d` delete"),
    "SKILL.md's reap paragraph no longer names the cherry check as authorizing the `git update-ref -d` delete",
  );
  assert.match(
    p,
    phrase("a fresh check that no worktree holds the branch"),
    "SKILL.md's reap paragraph no longer names the fresh worktree check — reap.sh keeps a branch the cherry check cleared whenever a worktree holds it",
  );
  assert.doesNotMatch(p, /(?:^|[\s`])(?:git\s+branch\s+)?-D\b/, "SKILL.md's reap paragraph names `-D` — reap.sh deletes with `git update-ref -d`");
  assert.doesNotMatch(
    p,
    /\bonly\s+by\b|\bnothing\s+else\b|\bsolely\b|\balone\b/i,
    "SKILL.md's reap paragraph makes one check the delete's only authorizer — reap.sh's worktree check stops that delete too",
  );
});

test("run-team/SKILL.md: the reap paragraph keeps the preconditions it already named", () => {
  // Input the assertions above must ACCEPT: the corrected clause sits in a
  // list whose other entries stay as they were.
  const p = reapParagraph();
  assert.match(p, phrase("`for-each-ref` for `[gone]`"));
  assert.match(p, phrase("worktree removal without `--force`"));
});

test("reap.sh: the worktree check the reap paragraph names runs before the delete", () => {
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
  // Slice starts at the wrap point the section-scoped test above ENDS on, so
  // the two spans abut rather than overlap and neither can satisfy the other.
  const fallback = between(
    RUN_TEAM,
    "**That refusal is the",
    "Run it over every claimed ticket",
    "run-team/SKILL.md",
  );
  // ONE contiguous phrase: the no-argument half and the row-lookup half are
  // the same instruction. Pinned separately, dropping the lookup leaves a
  // reader taking the first row — the main checkout — as this claim's.
  assert.match(
    fallback,
    phrase("run `worktree-audit.sh` (it audits every worktree; find this claim's row in the output)"),
    "the by-hand fallback no longer says `worktree-audit.sh` audits every worktree and needs a row lookup — a reader passing it this claim's path gets exit 2, and one reading the first row reads the main checkout",
  );
});

test("release-ticket.sh: the comment at the dirty check does not contradict the header above it", () => {
  // The header (release-ticket.sh) states the limitation; this comment
  // said git recomputes this same check at the delete, full stop. Whichever a
  // reader reaches first is the one they act on.
  const comment = stripHashGutter(
    between(
      SCRIPT,
      "  # Ignored files are deliberately not a blocker",
      "  n=$(printf",
      "release-ticket.sh",
    ),
  );
  assert.match(
    comment,
    /recomputed\s+by\s+git\s+at\s+the\s+moment\s+of\s+the\s+delete.{0,120}only\s+while\s+the\s+directory\s+is\s+there/s,
    "the dirty-check comment claims an unqualified delete-time recomputation again, contradicting this script's own header",
  );
});
