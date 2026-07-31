import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// review-pr.js tells every specialist to run `testCmd` FROM THE SNAPSHOT, and
// the snapshot is `git archive HEAD | tar -x` — tracked files only. A default
// naming an untracked path (it was `./agent-test`, which claim-ticket.sh writes
// into the worktree at :110 and adds to .git/info/exclude at :166) resolves to
// `No such file or directory` for every caller that does not pass args.testCmd,
// and specialists reason from source instead of measuring.
//
// Guard it by CUTTING THE ARCHIVE AND RUNNING THE DEFAULT IN IT. An earlier
// version of this file parsed the command string and checked its arguments
// against `git ls-files` instead, and that guard reported three green on
// `./agent-test skills/fleet/scripts/*.test.mjs` — this ticket's own defect —
// because it dropped the first token as "the executable" and only ever checked
// the arguments. Predicting what a shell command will do is the same bet that
// produced the defect; running it is the only answer that cannot be gamed.
const REPO = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");

// review-pr.js runs a top-level `await pipeline(...)`, so it cannot be imported
// for this value. Reading the source couples this test to the literal spelling
// of the default — a behaviour-preserving requote breaks it — but it breaks
// LOUDLY, with the message below, and only ever binds the default, never a
// caller's args.testCmd.
const defaultTestCmd = () => {
  const m = SOURCE.match(/args\.testCmd\)\s*\|\|\s*"([^"]+)"/);
  assert.ok(m, "review-pr.js no longer has a quoted default testCmd — update this test");
  return m[1];
};

// The default's glob matches THIS file, so the run below re-enters it.
const NESTED = "REVIEW_PR_TESTCMD_NESTED";

test("the default testCmd runs from a git archive snapshot and actually runs tests", (t) => {
  if (process.env[NESTED]) return t.skip("this is the nested run being measured");
  // `rev-parse` walks UP, so a copy of this tree sitting anywhere inside another
  // repo answers yes — a snapshot under a scratch dir that happens to be in one
  // included. Only the checkout whose toplevel IS this repo can cut an archive
  // of it. Anywhere else, SKIP: a skip is visible in the output, where a quieter
  // fallback check would read as a pass.
  let top;
  try {
    top = execFileSync("git", ["-C", REPO, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    return t.skip("not a git checkout — cannot cut an archive here");
  }
  if (realpathSync(top) !== realpathSync(REPO)) {
    return t.skip("not this repo's toplevel — cannot cut an archive here");
  }

  const dir = mkdtempSync(join(tmpdir(), "review-pr-testcmd-"));
  try {
    const tar = join(dir, "snapshot.tar");
    execFileSync("git", ["-C", REPO, "archive", "-o", tar, "HEAD"]);
    execFileSync("tar", ["-x", "-f", tar, "-C", dir]);

    const cmd = defaultTestCmd();
    // `node --test` marks its own children with these. Inheriting them makes the
    // nested run believe it is a test worker and emit the v8-serialized stream
    // instead of the readable report — stdout arrives empty and the count below
    // reads as `tests 0`, failing this test for the wrong reason.
    const env = { ...process.env, [NESTED]: "1" };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_TEST_WORKER_ID;
    // `shell: true` is /bin/sh, which is the shell that passes a zero-match glob
    // through literally. zsh would error on it and hide the case being tested.
    const r = spawnSync(cmd, { cwd: dir, shell: true, encoding: "utf8", env });
    assert.equal(
      r.status,
      0,
      `default testCmd '${cmd}' does not run in the snapshot (exit ${r.status}):\n${r.stdout}${r.stderr}`,
    );
    // Exit status alone is not enough, and that is the whole ticket: a glob
    // matching nothing exits 0 reporting `tests 0`, having run nothing. No node
    // flag fails a zero-test run (checked on v26.5.0), so assert on the count.
    const ran = r.stdout.match(/^ℹ tests (\d+)$/m);
    assert.ok(
      ran && Number(ran[1]) > 0,
      `default testCmd '${cmd}' ran no tests in the snapshot — 'tests 0' at exit 0 is a silent green:\n${r.stdout}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The prompt is what specialists actually obey, so the reading rule has to be in
// it. Without this, a specialist that guesses a glob still reports `tests 0` as
// a pass — the exact failure the default fix alone does not cover.
test("the specialist prompt hands the command over verbatim and rules 'tests 0' a failure", () => {
  // indexOf returns -1 when absent, and slice(-1) is a truthy one-character
  // string — so asserting on the slice would pass with the prompt gone. Assert
  // the index instead.
  const at = SOURCE.indexOf("READ ONLY FROM THE SNAPSHOT");
  assert.notEqual(at, -1, "the specialist prompt moved — update this test");
  // Bound the END too. Unbounded, this slice ran to EOF and the assertions below
  // could be satisfied from the verifier prompt further down the file — verified
  // by moving the ruling there, which left this test green while the specialist
  // prompt no longer carried it at all.
  const end = SOURCE.indexOf("Scratch files go in", at);
  assert.notEqual(end, -1, "the specialist prompt's scratch line moved — update this test");
  const prompt = SOURCE.slice(at, end);
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
