// #161. Gate for the CI checks that run a checker over `git ls-files '<glob>'`.
//
// `git ls-files '*.mjs' | xargs -r node --check` exits 0 on an empty match, and
// every checker in that job prints nothing on success — so a run that checked 23
// files and a run that checked 0 were byte-identical in the log (confirmed from
// runner log 30629390698, zero bytes between `##[endgroup]` and the next
// `##[group]`). `pipefail` cannot see it: the left-hand side SUCCEEDS, it just
// succeeds with nothing. One directory rename and a step is vacuously green
// forever. `shopt -s failglob`, which PR #157 used for the Tests step, does not
// apply — the glob is quoted and expanded by `git ls-files`, not by the shell.
//
// Two halves, because a guard that only ever sees valid input pins neither:
//   - REFUSE: an empty match is exit 1 and the checker never runs.
//   - ACCEPT: a populated tree still runs the checker on every file and exits 0,
//     and a failing checker still fails the step. All five globs in ci.yml match
//     files today (mjs 57, js 2, json 2, sh 13, py 7 at 6815db6), so the guard
//     is not firing on the real tree — these two cases are what says so.
//
// The behavioural cases pin the script. The source assertions at the bottom pin
// that ci.yml actually ROUTES through it: without them a step reverted to bare
// `xargs -r` leaves this whole file green while the defect is back.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("../../../.github/scripts/check-tracked.sh", import.meta.url));
const CI_YML = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));

// Cut the developer's ~/.gitconfig out of the fixtures, and stop a GIT_* export
// in the ambient environment from pointing them out of their own temp dir.
const ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

/** Throwaway repo with `files` tracked (name -> contents). Returns its path. */
function repo(t, files) {
  const dir = mkdtempSync(join(tmpdir(), "ci-vacuous-green-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", dir], { env: ENV });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  execFileSync("git", ["add", "-A"], { cwd: dir, env: ENV });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd: dir, env: ENV });
  return dir;
}

const check = (cwd, ...args) =>
  spawnSync(SCRIPT, args, { cwd, env: ENV, encoding: "utf8" });

test("empty match: exit 1, says so, and the checker never runs", (t) => {
  const dir = repo(t, { "readme.md": "no scripts here\n" });

  const r = check(dir, "*.mjs", "-n1", "sh", "-c", "echo CHECKER-RAN", "sh");

  assert.equal(r.status, 1);
  const out = r.stdout + r.stderr;
  assert.match(out, /::error::/, "an empty match must be loud in the runner log");
  assert.match(out, /\*\.mjs/, "the message must name the glob that matched nothing");
  // The point of the whole ticket: the old form exited 0 having run nothing.
  assert.doesNotMatch(out, /CHECKER-RAN/, "nothing may be checked on an empty match");
});

test("populated match: runs the checker on every file, prints the count, exits 0", (t) => {
  const dir = repo(t, { "a.mjs": "1\n", "b.mjs": "2\n", "c.txt": "3\n" });

  const r = check(dir, "*.mjs", "-n1", "sh", "-c", 'echo "saw $1"', "sh");

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /checking 2 file\(s\)/, "the count must be visible in the log");
  assert.match(r.stdout, /saw a\.mjs/);
  assert.match(r.stdout, /saw b\.mjs/);
  assert.doesNotMatch(r.stdout, /c\.txt/, "the glob must still select");
});

test("a checker that fails still fails the step", (t) => {
  const dir = repo(t, { "a.mjs": "1\n" });

  const r = check(dir, "*.mjs", "-n1", "false");

  assert.notEqual(r.status, 0, "the guard must not swallow the real check's status");
});

test("a path holding a space reaches the checker as one argument", (t) => {
  const dir = repo(t, { "a b.mjs": "1\n" });

  const r = check(dir, "*.mjs", "-n1", "sh", "-c", 'printf "[%s]\\n" "$1"', "sh");

  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /\[a b\.mjs\]/, "NUL-delimited, not word-split");
});

// --- ci.yml routes through the guard -----------------------------------------
// Flattened, so a re-indent or a line break inside the step cannot red this;
// only the command actually changing can. Same convention as the *-prose tests.
const flat = (s) => s.replace(/\s+/g, " ");
const phrase = (s) =>
  new RegExp(s.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+"));

test("every ls-files check in ci.yml goes through check-tracked.sh", () => {
  const ci = flat(readFileSync(CI_YML, "utf8"));

  for (const glob of ["*.mjs", "*.json", "*.sh", "*.py"]) {
    // ok(), not match(): a failed match dumps the whole flattened workflow into
    // the log and buries the one line saying which check lost its guard.
    assert.ok(phrase(`check-tracked.sh '${glob}'`).test(ci), `the ${glob} check no longer routes through check-tracked.sh`);
  }
  assert.ok(!/xargs\s+-r\b/.test(ci), "`xargs -r` is back — that is the vacuous-green form #161 removed");
});

test("the .js step refuses an empty match too", () => {
  const ci = flat(readFileSync(CI_YML, "utf8"));

  // Not an xargs step — a `for` loop over `git ls-files '*.js'`, which iterates
  // zero times and exits 0 on an empty match. Same defect, different shape, so
  // it carries its own guard rather than routing through the script.
  assert.ok(phrase("no tracked file matches *.js").test(ci), "the .js loop lost its empty-match refusal");
});
