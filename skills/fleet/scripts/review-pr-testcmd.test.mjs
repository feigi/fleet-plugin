import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// review-pr.js tells every specialist to run `testCmd` FROM THE SNAPSHOT, and
// the snapshot is `git archive HEAD | tar -x` — tracked files only. A default
// naming an untracked path (it was `./agent-test`, which claim-ticket.sh writes
// into the worktree and adds to .git/info/exclude) resolves to `No such file or
// directory` for every caller that does not pass args.testCmd, and specialists
// reason from source instead of measuring. Guard the invariant, not the string:
// whatever the default becomes, its file arguments must be tracked.
const REPO = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");

const defaultTestCmd = () => {
  const m = SOURCE.match(/args\.testCmd\)\s*\|\|\s*"([^"]+)"/);
  assert.ok(m, "review-pr.js no longer has a quoted default testCmd — update this test");
  return m[1];
};

// `git ls-files <pathspec>` lists tracked paths only, which is exactly what the
// archive carries. Empty output = the default cannot exist in the snapshot.
const tracked = (pathspec) =>
  execFileSync("git", ["-C", REPO, "ls-files", "--", pathspec], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

test("every file argument in the default testCmd is tracked, so it survives git archive", () => {
  const args = defaultTestCmd().split(/\s+/).filter((a) => !a.startsWith("-"));
  // Drop the executable; what remains is what the runner is pointed at.
  const paths = args.slice(1);
  assert.ok(paths.length > 0, "default testCmd names no path to run");
  for (const p of paths) {
    assert.ok(
      tracked(p).length > 0,
      `default testCmd names '${p}', which git does not track — it is absent from the snapshot`,
    );
  }
});

// The defect class the ticket is about: a glob matching nothing is a SILENT
// green. node exits 0 reporting `tests 0`, so a specialist reports a pass having
// run nothing. Node has no flag that fails a zero-test run (checked on v26.5.0),
// so the only guard is that the default actually matches files today.
test("the default testCmd cannot be a zero-match glob", () => {
  const cmd = defaultTestCmd();
  const paths = cmd.split(/\s+/).filter((a) => !a.startsWith("-")).slice(1);
  const matched = paths.flatMap(tracked);
  assert.ok(
    matched.length > 0,
    `default testCmd '${cmd}' matches no tracked file — it would report 'tests 0' and exit 0`,
  );
  assert.ok(
    matched.some((f) => /\.test\.mjs$/.test(f)),
    `default testCmd '${cmd}' matches tracked files but no test file`,
  );
});

// The prompt is what specialists actually obey, so the reading rule has to be in
// it. Without this, a specialist that guesses a glob still reports `tests 0` as
// a pass — the exact failure the default fix alone does not cover.
test("the specialist prompt hands the command over verbatim and rules 'tests 0' a failure", () => {
  const prompt = SOURCE.slice(SOURCE.indexOf("READ ONLY FROM THE SNAPSHOT"));
  assert.ok(prompt, "the specialist prompt moved — update this test");
  // The worked example must INTERPOLATE the default, not restate it. A
  // hardcoded copy drifts from testCmd the moment either one changes, and a
  // caller passing args.testCmd would be handed the wrong command.
  assert.match(
    prompt,
    /run exactly this[^\n]*\n\s*\$\{testCmd\}/,
    "the prompt no longer hands specialists the interpolated command verbatim",
  );
  // Match the ruling itself, not the phrase `tests 0` — that appears in the
  // surrounding explanation too, so a looser assertion passes with the rule
  // deleted (observed: it did).
  assert.match(
    prompt,
    /'tests 0' is a FAILED run/,
    "the prompt no longer rules a zero-test run a failure",
  );
});
