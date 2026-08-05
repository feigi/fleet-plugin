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
// So cut the archive and RUN the default in it. Parsing the command to predict
// what it will do is the same bet that produced the defect — a guard that did
// that passed `./agent-test skills/…/*.test.mjs`, treating the first token as
// "the executable" and never checking it.
const REPO = join(import.meta.dirname, "..", "..", "..");
const SOURCE = readFileSync(join(REPO, "workflows", "review-pr.js"), "utf8");

// review-pr.js runs a top-level `await pipeline(...)` and cannot be imported for
// this value. Reading the source couples us to the default's literal spelling —
// a behaviour-preserving requote breaks it, but breaks LOUDLY with the message
// below, and only ever binds the default, never a caller's args.testCmd.
const defaultTestCmd = () => {
  // `A` is review-pr.js's decoded `args` — it reads args once through a
  // JSON-string guard and destructures off the result, so the binding here is
  // `A.testCmd`, not `args.testCmd`.
  const m = SOURCE.match(/\bA\.testCmd\s*\|\|\s*"([^"]+)"/);
  assert.ok(m, "review-pr.js no longer has a quoted default testCmd — update this test");
  return m[1];
};

// The default's glob matches THIS file, so the run below re-enters it.
const NESTED = "REVIEW_PR_TESTCMD_NESTED";

test("the default testCmd runs from a git archive snapshot and actually runs tests", (t) => {
  if (process.env[NESTED]) return t.skip("this is the nested run being measured");
  // `rev-parse` walks UP, so a snapshot sitting anywhere inside another repo
  // answers yes. Only the checkout whose toplevel IS this repo can cut an
  // archive of it; anywhere else SKIP, which is visible in the output where a
  // quieter fallback check would read as a pass.
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
    // `node --test` marks its children with these; inherited, the nested run
    // emits the v8-serialized worker stream instead of the readable report —
    // stdout arrives empty and the count below reads `tests 0`, a false red.
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
    // Exit status alone is not enough, which is the whole ticket: a glob
    // matching nothing exits 0 reporting `tests 0`, and no node flag fails a
    // zero-test run (checked on v26.5.0). Assert on the count.
    // Both prefixes: the default reporter is spec on a terminal and on newer
    // node, tap when older node writes to a pipe. Pinning only `ℹ` reads a tap
    // run — every CI run — as `tests 0`, which is this assertion's own failure
    // message inverted: a false red claiming a silent green.
    const ran = r.stdout.match(/^(?:ℹ|#) tests (\d+)$/m);
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
  // indexOf returns -1 when absent and slice(-1) is a truthy one-character
  // string, so asserting on the slice passes with the prompt gone. Assert the
  // index — and bound the END too: unbounded, this slice ran to EOF and the
  // assertions below were satisfiable from the verifier prompt further down.
  const at = SOURCE.indexOf("READ ONLY FROM THE SNAPSHOT");
  assert.notEqual(at, -1, "the specialist prompt moved — update this test");
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
