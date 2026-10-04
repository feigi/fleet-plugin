// #1378. Documentation and test-file headers across this repo cited the test
// suite as living at `scripts/<file>` — a path that does not exist. The real
// suite root was `plugin/scripts/` then, and is `tests/` since the suite moved
// out of the shipped surface (#2232). 32 tracked files carried the stale form
// before this ticket corrected every one: 27 test-file header comments
// citing themselves, 2 comments in non-test source files (`repo-root.mjs`
// citing its sibling `repo-root.test.mjs`, `strip-comments.mjs` inside an
// example string) rather than a test file citing itself, one prose citation
// in `references/reaping.md`, and the load-bearing pair in
// `commands/review-and-fix.md` and `skills/run-team/SKILL.md` that hand the
// command to a dispatched agent as an instruction, not a comment. This file
// is what keeps the stale form from creeping back in one file at a time,
// the way it crept in 32 times before anyone swept for it.
//
// A DIFFERENT citation class from #516's own sweep
// (citation-sweep-prose.test.mjs, `path.ext:NNN` line numbers) and does not
// reach it: that file polices a fixed per-file table of stale/live pairs,
// this one asks git what ships and reads every one of them, because
// enumerating by hand is the shape that let this exact defect recur 32 times
// silently.
//
// Composed, never written contiguously: the two fragments the check joins
// below only spell the stale citation once concatenated, so this file's own
// source — itself tracked under `tests/`, inside the sweep — cannot satisfy
// the check it performs. A plain string literal holding the whole stale form
// would report this file as its own first offender.
//
// repo-root.mjs's `trackedPaths`, not a directory walk: an untracked scratch
// file must never become a false positive, and a tracked file that moves out
// of `plugin/` and `tests/` must fall out of the sweep with it — same premise
// `repo-root.mjs` states for the sibling `*-sweep.test.mjs` files in this
// directory. Both roots, because the test-file headers this sweep was written
// for moved from `plugin/` to `tests/` and must not leave its reach with them.
//
// KNOWN LIMIT, same as those siblings: needs an ambient `.git` to ask what
// ships. Absent one — a bare `git archive` extraction, how review specialists
// used to measure this very suite (#1056; the review snapshot carries a `.git`
// since then) — the tests below DECLINE with a reason rather than running;
// nothing here polices a tree it cannot see.
//
// Zero deps: `node --test tests/scripts-path-citation-sweep.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, skipWithoutRepo, trackedPaths } from "../plugin/scripts/repo-root.mjs";

const DIR = fileURLToPath(new URL("../plugin/scripts", import.meta.url));
const ROOT = repoRoot(DIR);
const SKIP_WITHOUT_REPO = skipWithoutRepo(ROOT, "the sweep for the nonexistent scripts/ citation");

// Never written as one literal — see the header's "composed" note.
const STALE_CITATION = ["node --test", " scripts/"].join("");

/** Every tracked path under `plugin/` and `tests/`, repo-relative. */
const FILES = ROOT === null ? [] : trackedPaths(ROOT, ["plugin", "tests"]);

test("the sweep sees the tree it is supposed to police", { skip: SKIP_WITHOUT_REPO }, () => {
  // Per root, not one total: with one pathspec dropped, the other root alone
  // could still clear a floor on the total.
  for (const [root, floor] of [["plugin/", 50], ["tests/", 100]]) {
    const n = FILES.filter((relPath) => relPath.startsWith(root)).length;
    assert.ok(
      n > floor,
      `trackedPaths(ROOT, ["plugin", "tests"]) returned only ${n} entries under ${root} — too few to be its real tree, and the check below would pass vacuously over an empty or near-empty list`,
    );
  }
});

test("no tracked file under plugin/ or tests/ cites the nonexistent scripts/ suite root", { skip: SKIP_WITHOUT_REPO }, () => {
  const offenders = FILES.filter((relPath) =>
    readFileSync(join(ROOT, relPath), "utf8").includes(STALE_CITATION),
  );
  assert.deepEqual(
    offenders,
    [],
    `these files cite a bare "scripts/" test path that does not exist — the suite root is "tests/": ${offenders.join(", ")}`,
  );
});
