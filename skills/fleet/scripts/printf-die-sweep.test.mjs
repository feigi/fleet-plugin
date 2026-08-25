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
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

/**
 * Bare origin + working clone with one commit on main. Returns the clone dir.
 *
 * realpath'd: on macOS `$TMPDIR` sits under the `/var` → `/private/var`
 * symlink, and `git worktree list --porcelain` reports the RESOLVED path. An
 * unresolved fixture path never matches what the scripts print, which reads as
 * a truncation failure and hides whether the escaping is right.
 */
function repo(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "printf-die-")));
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
    // The `\c` sits in the BRANCH slot, not the sha slot. Both reach `die()`,
    // but only the branch reaches the fetch trace at verify-sha.sh:33 — the
    // one line in these scripts where raw argv is printed before any git
    // command has accepted it. With the escape in the sha slot the suite was
    // green over that line: the sha is read after the fetch, so it can never
    // get there. `trace` below is what pins it.
    script: "verify-sha.sh",
    args: ["back\\clue", "deadbee"],
    exit: 2,
    line: "verify-sha: cannot fetch origin/back\\clue",
    trace: "$ git fetch --quiet origin back\\clue",
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
    // A trace line ABOVE the refusal, where the script names the command it is
    // about to run. Only verify-sha.sh has one carrying unvalidated argv, and
    // the newline is the half that matters most: `echo` eats it, so git's own
    // `fatal:` lands welded to the tail of the trace and stops anchoring `^`.
    if (c.trace) {
      assert.ok(
        r.stderr.includes(`${c.trace}\n`),
        `the trace line must name the command verbatim and keep its newline.\nwant: ${JSON.stringify(`${c.trace}\n`)}\ngot:  ${JSON.stringify(r.stderr)}`,
      );
    }
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

// A plain message must still work — and this is the only case in the suite that
// notices if drop-merged-label.sh stops refusing ordinary input at all.
// Measured: widening its numeric guard's class (`*[!0-9]*` → `*[!0-9a-z]*`)
// reds this test ALONE, because `back\clue` and `100% done %s %d` fall outside
// any widened class and go on being refused, while `notanumber` does not.
//
// The "refuses everything" direction this was written for is already covered
// twice over — that mutant reds the `\c` and the `%` test as well — so it is
// the ordinary-input reachability above, not the accept direction, that makes
// this worth its fixture (#707 review).
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
  // Status first, as the test above already does. Without it an unrelated
  // early refusal — the script dying before it ever reaches this line — is
  // reported under the escaping headline below, naming a cause it did not have.
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(
    r.stderr.includes(`MISSING on disk: ${wt}\n`),
    `the missing path must arrive verbatim; got ${JSON.stringify(r.stderr)}`,
  );
});

// `keep()`'s reason is the single line eleven call sites converge on, and seven
// of them interpolate a worktree path. Neither number is worth trusting from
// prose — this comment shipped "four", which is the count of the sites that do
// NOT interpolate one: the cherry-probe-failed, unmerged-commits,
// worktree-remove-refused and branch-delete-failed reasons. Those four were
// cited by line number here and the numbers had already drifted off every one
// of them; naming them is what #129 asks for. Re-derive both counts instead:
//   grep -c 'keep "\$b"' reap.sh                    # 11
//   grep 'keep "\$b"' reap.sh | grep -c '\$wt'      # 7
// reap only considers a branch whose
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
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
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
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.ok(
    r.stderr.includes("would: git worktree add .worktrees/7-back\\clue -b fix/7-back\\clue origin/main\n"),
    `the planned path and branch must arrive verbatim — \`echo\` truncates both at the \`\\c\`; got ${JSON.stringify(r.stderr)}`,
  );
});

// ---------------------------------------------------------------------------
// The fix's own regression risk, at every site at once.
//
// The fixtures above are behavioural and cost a git repo each, so they pin one
// line per script. This pins the invariant the whole sweep rests on across all
// of them, statically: `printf` must be handed a LITERAL format, never one
// built by interpolation.
//
// Why a static test is the only thing that can catch it: `printf "$msg\n"` is
// the regression that reopens BOTH halves of #484, and every `\c` fixture above
// stays green over it. Measured on /bin/sh and /bin/dash — POSIX printf expands
// `\c` only under `%b`, never in the format it was handed, so
// `printf "$NAME: back\clue\n"` prints `back\clue` intact while
// `printf '%s\n' "back\clue"` does too. Only a `%`-carrying message tells them
// apart, and feeding one to all ~35 sites would need a fixture per site. Under
// that mutation the die() sites of verify-sha.sh and inflight.sh were reverted
// and the full suite stayed green.
//
// Not delegated to shellcheck: SC2059 is exactly this check, but it reports at
// `info`, and CI runs `shellcheck -x -S warning`, which filters it out before
// it is printed. Raising that floor is a change to a workflow file this ticket
// has no business in.
//
// It does NOT catch a revert to `echo` — nothing static can, since two thirds
// of the `echo` calls in these scripts interpolate values that are safe by
// construction (numbers, SHAs, refs git already accepted). That direction is
// what the behavioural fixtures above, and the per-script path fixtures in
// inflight.test.mjs and release-ticket.test.mjs, are for.
test("every printf in the fleet scripts is handed a literal format string", () => {
  // The format argument is the first token after `printf`: a single-quoted run
  // (literal through and through), a double-quoted run honouring `\"`, or a
  // bare word. Full-line comments are skipped — several of them quote the very
  // form being banned.
  const FORMAT = /(?:^|[;&|(){}\s])printf[ \t]+('[^']*'|"(?:[^"\\]|\\.)*"|[^\s;&|)]+)/g;
  // Single quotes cannot interpolate at all. Anything else does the moment it
  // carries an unescaped `$` or a backtick — `"\$arg"` is a literal dollar and
  // stays legal, which is what the agent-test runner claim-ticket.sh writes
  // through a heredoc relies on.
  const interpolates = (tok) => {
    if (tok.startsWith("'")) return false;
    const body = tok.startsWith('"') ? tok.slice(1, -1) : tok;
    return /(?:^|[^\\])[$`]/.test(body);
  };

  const scripts = readdirSync(DIR).filter((n) => n.endsWith(".sh")).sort();
  // A glob that matches nothing passes every assertion below it. Same failure
  // as `tests 0`, and the same reading rule: no scripts is a broken test.
  assert.ok(scripts.length >= 9, `expected the fleet scripts, found ${scripts.length}`);

  const bad = [];
  let checked = 0;
  for (const name of scripts) {
    readFileSync(join(DIR, name), "utf8").split("\n").forEach((line, i) => {
      if (/^\s*#/.test(line)) return;
      for (const m of line.matchAll(FORMAT)) {
        checked++;
        if (interpolates(m[1])) bad.push(`${name}:${i + 1}  ${m[1]}`);
      }
    });
  }
  assert.ok(checked >= 100, `expected to find the sweep's printf calls, found ${checked}`);
  assert.deepEqual(
    bad,
    [],
    `these printf calls build their format by interpolation, which consumes any \`%\` in the message and re-opens #484:\n  ${bad.join("\n  ")}`,
  );
});
