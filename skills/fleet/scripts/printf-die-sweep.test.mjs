// Regression gate for #484: `echo` expands backslash escapes in its operand,
// so every fleet script that reported caller-supplied text through
// `die() { echo "$NAME: $1" >&2; … }` could truncate its own refusal.
//
// The mechanism, measured rather than inferred (dash on CI's ubuntu-latest and
// macOS `sh` both do this):
//
//   $ sh -c 'a="x \cy"; echo "n: $a"' | od -c
//   0000000   n   :       x
//
// `\c` truncates the line AND swallows the newline, so the next stderr line
// collides with it. `\t \n \b \f \r \v \\ \0` mangle in their own ways.
//
// The trap this file exists to avoid: **unknown escapes like `\s` pass through
// unharmed.** A fixture spelled `back\slash` exercises the safe member of the
// class, reads as coverage, and catches nothing — `no-undo-audit.test.mjs` had
// exactly such a fixture and was blind to five live defects (#480). Every
// fixture below therefore uses `\c`, the member that actually truncates.
//
// Two directions are pinned, because a suite that only feeds valid input pins
// neither:
//   - REJECT: a `\c` message must arrive verbatim (the bug).
//   - ACCEPT: a `%`-carrying message must arrive verbatim too (the fix's own
//     regression risk — `printf "$msg\n"` would eat it; `printf '%s\n' "$msg"`
//     does not).
//
// Zero deps: `node --test skills/fleet/scripts/printf-die-sweep.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL(".", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixture, so a
// local `pull.rebase` or hook cannot change what these repos look like.
const ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_TEMPLATE_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Bare origin + working clone with one commit on main. Returns the clone dir. */
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), "printf-die-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, work], { env: ENV });
  writeFileSync(join(work, "f.txt"), "x\n");
  git(work, "add", "f.txt");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "origin", "main");
  return work;
}

const run = (cwd, script, args, extraEnv = {}) =>
  spawnSync("sh", [join(DIR, script), ...args], {
    cwd,
    env: { ...ENV, ...extraEnv },
    encoding: "utf8",
  });

// One reachable `die()` per script, chosen so the message interpolates text the
// CALLER supplied — the only text that can carry a backslash. `$NAME: ` is
// prefixed by `die` itself, so asserting the whole line also pins the prefix.
//
// `exit` codes are asserted because they are part of each script's contract and
// a `printf` substitution must not disturb them: eight scripts refuse at 2,
// `derive-testcmd.sh` at 1. The ticket does not mention that asymmetry.
const CASES = [
  {
    script: "verify-sha.sh",
    args: ["main", "back\\clue"],
    exit: 2,
    line: "verify-sha: cannot resolve back\\clue to a commit in this repository",
  },
  {
    script: "drop-merged-label.sh",
    args: ["back\\clue"],
    exit: 2,
    line: "drop-merged-label: pr must be a number, got 'back\\clue'",
  },
  {
    script: "inflight.sh",
    args: ["back\\clue"],
    exit: 2,
    line: "inflight: issue must be a number, got 'back\\clue'",
  },
  {
    script: "claim-ticket.sh",
    args: ["back\\clue", "slug", "fix"],
    exit: 2,
    line: "claim-ticket: issue must be a number, got 'back\\clue'",
  },
  {
    script: "worktree-audit.sh",
    args: [],
    env: { BASE_REF: "origin/back\\clue" },
    exit: 2,
    line: "worktree-audit: origin/back\\clue does not resolve",
  },
  {
    script: "release-ticket.sh",
    args: ["back\\clue", "slug", "fix"],
    exit: 2,
    line: "release-ticket: issue must be a number, got 'back\\clue'",
  },
  {
    script: "reap.sh",
    args: [],
    env: { BASE_REF: "origin/back\\clue" },
    exit: 2,
    line: "reap: origin/back\\clue does not resolve",
  },
  {
    script: "prove-merge.sh",
    args: ["back\\clue", "deadbee", "deadbee"],
    exit: 2,
    line: "prove-merge: cannot resolve back\\clue to a commit in this repository",
  },
  {
    // The one script that refuses at 1, not 2.
    script: "derive-testcmd.sh",
    args: ["back\\clue-nope", "main"],
    exit: 1,
    line: "derive-testcmd: back\\clue-nope is not a git repository",
  },
];

for (const c of CASES) {
  test(`${c.script}: die() reports a \\c-carrying message verbatim`, (t) => {
    const w = repo(t);
    // The fixture is only useful if it really carries the escape that breaks.
    // `\s` would pass through `echo` unharmed and pin nothing.
    assert.ok(
      c.line.includes("\\c"),
      "fixture must carry a `\\c`, the escape that truncates — not an inert one",
    );
    const r = run(w, c.script, c.args, c.env);
    assert.equal(
      r.status,
      c.exit,
      `${c.script} must still refuse at ${c.exit}; got ${r.status}, stderr ${JSON.stringify(r.stderr)}`,
    );
    // Whole line, anchored, WITH its newline: `echo` drops both the tail and
    // the trailing newline at the `\c`, so a substring match on the surviving
    // head would pass against the very defect this pins.
    assert.ok(
      r.stderr.includes(`${c.line}\n`),
      `\`echo\` truncates this refusal at the \`\\c\` — it must arrive verbatim and newline-terminated.\nwant: ${JSON.stringify(`${c.line}\n`)}\ngot:  ${JSON.stringify(r.stderr)}`,
    );
  });
}

// The other direction. `printf` treats its FIRST argument as a format string,
// which `echo` never did, so the fix introduces a hazard of its own: a message
// holding `%s` or `%d` is silently rewritten by `printf "$msg\n"` — measured,
// `100% done %s %d` comes out as `100 0one  0`. `printf '%s\n' "$msg"` is
// immune. Nothing else in the suite feeds a `%`, so without this the fix could
// regress to the format-string form and stay green.
test("a %-carrying message is passed through, not interpreted as a format", (t) => {
  const w = repo(t);
  const r = run(w, "drop-merged-label.sh", ["100% done %s %d"]);
  assert.equal(r.status, 2);
  assert.ok(
    r.stderr.includes("drop-merged-label: pr must be a number, got '100% done %s %d'\n"),
    `the message must survive verbatim — \`printf "$msg\\n"\` would consume the %-specifiers; got ${JSON.stringify(r.stderr)}`,
  );
});

// A plain message must still work. Cheap, and it is what proves the two tests
// above are testing escaping rather than a script that refuses everything.
test("an ordinary message with no escapes is unaffected", (t) => {
  const w = repo(t);
  const r = run(w, "drop-merged-label.sh", ["notanumber"]);
  assert.equal(r.status, 2);
  assert.ok(
    r.stderr.includes("drop-merged-label: pr must be a number, got 'notanumber'\n"),
    `got ${JSON.stringify(r.stderr)}`,
  );
});

// ---------------------------------------------------------------------------
// Path-carrying sites: the same class, reached through operator output rather
// than through `die()`. A worktree path is caller-supplied and a backslash is
// legal in one, which is what makes these reachable at all.
// ---------------------------------------------------------------------------

test("worktree-audit: a worktree path holding a backslash reaches the status line whole", (t) => {
  const w = repo(t);
  const wt = join(w, "back\\clue-wt");
  git(w, "worktree", "add", "-q", "-b", "fix/1-thing", wt);
  const r = run(w, "worktree-audit.sh", []);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(
    r.stderr.includes(`${wt}  branch=fix/1-thing`),
    `\`echo\` truncates the status line at the \`\\c\` — the path must arrive verbatim; got ${JSON.stringify(r.stderr)}`,
  );
});

test("worktree-audit: a worktree gone from disk is named verbatim as MISSING", (t) => {
  const w = repo(t);
  const wt = join(w, "back\\clue-gone");
  git(w, "worktree", "add", "-q", "-b", "fix/2-thing", wt);
  rmSync(wt, { recursive: true, force: true });
  const r = run(w, "worktree-audit.sh", []);
  assert.ok(
    r.stderr.includes(`MISSING on disk: ${wt}\n`),
    `the missing path must arrive verbatim; got ${JSON.stringify(r.stderr)}`,
  );
});

// `keep()`'s reason is the single line eleven call sites converge on, and four
// of them interpolate a worktree path. reap only considers a branch whose
// upstream reads `[gone]`, so the fixture has to push the branch and then
// delete it on origin — reap's own `fetch --prune` is what marks it gone.
test("reap: a KEEP reason holding a backslashed path reaches the operator whole", (t) => {
  const w = repo(t);
  const wt = join(w, "back\\clue-dirty");
  git(w, "worktree", "add", "-q", "-b", "fix/3-thing", wt);
  // Pushed with -u so the branch has an upstream, then deleted on origin so
  // that upstream becomes `[gone]`. No commit of its own: reap must get PAST
  // the unmerged check to reach a reason that names the worktree.
  git(wt, "push", "-q", "-u", "origin", "fix/3-thing");
  git(w, "push", "-q", "origin", "--delete", "fix/3-thing");
  writeFileSync(join(wt, "g.txt"), "uncommitted\n"); // dirty → `dirty worktree $wt`
  const r = run(w, "reap.sh", []);
  assert.ok(
    r.stderr.includes(`KEEP fix/3-thing — dirty worktree ${wt}\n`),
    `\`echo\` truncates the KEEP line at the \`\\c\` — the worktree path must arrive verbatim; got ${JSON.stringify(r.stderr)}`,
  );
});

test("claim-ticket: the dry-run plan names a backslashed worktree path verbatim", (t) => {
  const w = repo(t);
  writeFileSync(join(w, "package.json"), '{"name":"t","scripts":{"test":"true"}}\n');
  mkdirSync(join(w, "t"), { recursive: true });
  writeFileSync(join(w, "t", "a.test.mjs"), "\n");
  git(w, "add", "-A");
  git(w, "commit", "-q", "-m", "pkg");
  git(w, "push", "-q", "origin", "main");
  const r = run(w, "claim-ticket.sh", ["7", "back\\clue", "fix"]);
  assert.ok(
    r.stderr.includes("would: git worktree add .worktrees/7-back\\clue -b fix/7-back\\clue origin/main\n"),
    `the planned path and branch must arrive verbatim — \`echo\` truncates both at the \`\\c\`; got ${JSON.stringify(r.stderr)}`,
  );
});
