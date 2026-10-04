// reap.sh's branch sweep runs more checks than `git cherry` before its
// `git update-ref --no-deref -d`: the worktree registry and listing checks,
// the dirty check, the `worktree remove` refusal and the `wt_holding` re-read
// can each keep the branch. The cherry check is the only one of them that
// asks whether the tip is merged, so a comment saying the delete is
// "authorized by this check and by nothing else" is false as written. The
// component doc said reap deletes with `-D`; it deletes with `update-ref -d`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { END, bullet, paragraph, phrase, runAbove, stripHashGutter } from "./support/prose-pin.mjs";

const REPO = join(import.meta.dirname, "..");
const SCRIPT = readFileSync(join(REPO, "plugin", "scripts", "reap.sh"), "utf8");
const DOC = readFileSync(join(REPO, "docs", "components", "reaping-and-liveness.md"), "utf8");

// The comment block above the branch sweep's cherry probe, and the one above
// its cherry scan: the two blocks that justify why the cherry check fails
// closed.
const probeComment = () =>
  stripHashGutter(runAbove(SCRIPT, 'if ! cherry=$(git cherry "$base_rev" "$tip"', "reap.sh cherry probe", "#"));
const scanComment = () =>
  stripHashGutter(
    runAbove(SCRIPT, `if ! grep_probe "$cherry" '^+'; then keep "$b"`, "reap.sh cherry scan", "#"),
  );

const NOTHING_ELSE = phrase("authorized by this check and by nothing else");

for (const [name, comment] of [
  ["cherry-probe", probeComment],
  ["cherry-scan", scanComment],
]) {
  test(`reap.sh: the ${name} comment does not call the cherry check the delete's sole authorizer`, () => {
    assert.doesNotMatch(
      comment(),
      NOTHING_ELSE,
      `reap.sh's ${name} comment says the delete is authorized by the cherry check and by nothing else — the worktree checks and \`wt_holding\` can stop the delete too`,
    );
  });
}

test("reap.sh: the cherry-probe comment does not quote the retired \"By nothing else\" sentence", () => {
  assert.doesNotMatch(
    probeComment(),
    phrase('"By nothing else" bounds'),
    "reap.sh's cherry-probe comment says \"By nothing else\" bounds what ELSE authorizes the delete — the worktree checks and `wt_holding` can stop the delete too, and the sentence restates the sole-authorizer claim",
  );
});

test("reap.sh: the cherry comments still say why an unanswerable probe must keep", () => {
  // Input the pins above must ACCEPT: the fail-closed argument the old
  // sentence carried survives, restated as what makes the cherry check
  // unique — it is the only check that asks whether the tip is merged.
  assert.match(probeComment(), phrase("this is the only one that asks whether `$tip` is merged"));
  assert.match(probeComment(), phrase("never a `$tip` that is unmerged — so an unanswerable probe must KEEP"));
  assert.match(scanComment(), phrase("no check between here and the delete below asks whether the branch is merged"));
});

const reapStep = () =>
  bullet(DOC, "1. **Reap after every merge pass**", "2. **Release a claim", "reaping-and-liveness.md reap step");
// The doc's last list item, so the blank-line bound is the end of the file.
const reapAndRelease = () =>
  paragraph(
    DOC,
    "- **Reap and release are two different scripts on purpose.**",
    "reaping-and-liveness.md reap-and-release choice",
    END,
  );

test("reaping-and-liveness.md: the reap step names the delete as a compare-and-swap `update-ref -d`, not `-D`", () => {
  const step = reapStep();
  assert.match(step, phrase("compare-and-swap `git update-ref -d`"));
  assert.doesNotMatch(step, /`-D`/, "reaping-and-liveness.md's reap step says the delete is `-D` — reap.sh deletes with `git update-ref -d`");
});

test("reaping-and-liveness.md: the reap-and-release choice names reap's delete as `update-ref -d`, not `-D`", () => {
  const choice = reapAndRelease();
  assert.match(choice, phrase("Reap authorizes a destructive `git update-ref -d`"));
  assert.doesNotMatch(choice, /`-D`/, "reaping-and-liveness.md says reap authorizes a `-D` — reap.sh deletes with `git update-ref -d`");
});
