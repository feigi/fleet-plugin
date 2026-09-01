// Regression gate for #578, and the durable half of a fix that has now been
// declared complete twice and been wrong twice.
//
// The class: a guard that suppresses git's own stderr and then `die`s with a
// message the script cannot know to be the cause. #559 fixed it in
// verify-sha.sh and recorded that as the sweep. #566 then found prove-merge.sh
// and stated IT was the last instance. #578 found five more. The per-site fix
// is not what fails here — the enumeration is, every time. So this file stops
// enumerating and asks git what ships.
//
// The mechanism, measured (git 2.50.1, throwaway repo) rather than inferred:
//
//   $ git rev-parse --verify --quiet nosuchref   # exit 1,   0 bytes of stderr
//   $ git rev-parse --verify nosuchref           # exit 128, `fatal: Needed a single revision`
//
// So the suppression is the whole defect, and removing it is the whole fix.
//
// `--verify` is the other half, and it looks redundant next to a dropped
// `--quiet` — which is exactly why it is pinned below rather than left to a
// comment. Measured:
//
//   $ git rev-parse f.txt            # prints `f.txt`, exit 0
//   $ git rev-parse --verify f.txt   # exit 128
//
// Without it a `$base` that names a FILE clears the guard and the script
// proceeds on something that is not a ref.
//
// WHAT IS AND IS NOT IN THE CLASS. The discriminator is the operator, and it
// is not a stylistic tell — the two shapes want opposite things:
//
//   `|| die`  failure is FATAL. git's reason is the missing information, and
//             the guard is silent when it succeeds. Unmute it.
//   `&& …`    failure is the EXPECTED answer (a branch-existence probe asking
//             whether a name is free). Unmuting prints `fatal: Needed a single
//             revision` on every HEALTHY run. `--quiet` is load-bearing; leave
//             it. Measured: exit 1 / 0 bytes muted, exit 128 / 32 bytes not.
//
// Deliberately outside this sweep, each with its reason:
//
//   - `fetch --quiet` (prove-merge.sh, reap.sh, verify-sha.sh). Measured
//     against a broken remote: 196 bytes of `fatal:` still reach stderr,
//     because `--quiet` suppresses progress, not diagnosis. Nothing is muted.
//   - The `2>/dev/null` probes. An adjacent mechanism, tracked in #481, #482
//     and #391, and not this one.
//
// This file is `.mjs` and the sweep reads `*.sh`, so it cannot match its own
// prose — the failure mode where a check quotes the pattern it greps for and
// reports on itself. Comment lines inside the shell scripts ARE stripped for
// the same reason: no-undo-audit.sh discusses this exact flag combination in a
// comment about a DIFFERENT guard, and a sweep that read it would fail on a
// sentence rather than on code.
//
// Zero deps: `node --test skills/fleet/scripts/muted-git-guard-sweep.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = fileURLToPath(new URL(".", import.meta.url));

// Asks git what ships rather than walking the directory: an untracked scratch
// script is not what ships, and a fleet script that moves out of this directory
// must not fall out of the sweep with it. Same rule, and same reason, as
// unattended-git-sweep.test.mjs. Needs an ambient working tree; a `git archive`
// extraction has none and this file alone reds there.
const REPO = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: DIR, encoding: "utf8" }).trim();
const SHELL_SCRIPTS = execFileSync("git", ["ls-files", "*.sh"], { cwd: REPO, encoding: "utf8" })
  .split("\n").filter(Boolean);

/**
 * Every `git rev-parse` guard in a script, with continuations joined and
 * comments dropped.
 *
 * Joined, because the sharp site in no-undo-audit.sh puts its `|| die` on the
 * next physical line: a per-line scan classifies it as having no `die` at all
 * and silently exempts the one guard this ticket was filed about.
 */
function guards(path) {
  const text = readFileSync(join(REPO, path), "utf8");
  return text
    .replace(/\\\n\s*/g, " ")            // join continuations FIRST
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#"))   // prose is not code — see the header
    .filter((l) => /\bgit\b.*\brev-parse\b/.test(l))
    .map((line) => ({ path, line }));
}

const ALL = SHELL_SCRIPTS.flatMap(guards);

test("the sweep sees the scripts it is supposed to police", () => {
  // A guard on the guard: a bad glob, a moved directory or a `git ls-files`
  // that answers nothing turns every assertion below into a vacuous pass over
  // an empty list — green, and blind. Named scripts, because those are the ones
  // whose defect this file exists to hold shut.
  for (const s of ["no-undo-audit.sh", "worktree-audit.sh", "release-ticket.sh", "reap.sh", "prove-merge.sh"]) {
    assert.ok(
      ALL.some((g) => g.path.endsWith(`/${s}`)),
      `${s} contributed no rev-parse line to the sweep — the file list or the join above is broken, not the script`,
    );
  }
});

test("no fatal rev-parse guard suppresses git's own diagnosis", () => {
  // `|| die` is the whole population: the guard cannot name the cause, so
  // git's line is the only thing that can.
  const muted = ALL.filter((g) => /\|\|\s*die\b/.test(g.line) && /--quiet\b/.test(g.line));
  assert.deepEqual(
    muted.map((g) => `${g.path}: ${g.line}`),
    [],
    "each of these dies on a failure whose reason only git knows, and `--quiet` throws that reason away. "
      + "Drop `--quiet` — keep `--verify`. If the failure here is the EXPECTED answer, the guard wants `&& …`, not `|| die`.",
  );
});

test("every rev-parse resolution guard keeps --verify", () => {
  // The regression a reader "tidying up" after the fix would introduce, and the
  // one a comment alone does not survive.
  //
  // Scoped to guards that DISCARD stdout: those lines exist only to ask whether
  // a name resolves, which is this ticket's population, and the probes belong
  // to it for the same reason — a file name must not read as a ref.
  //
  // A CAPTURE (`tip=$(git rev-parse …)`) is deliberately out. It asks a
  // different question — it wants the value, not the yes/no — and verify-sha.sh
  // has one, without `--verify`, that this sweep flagged on first run. Measured:
  // with a file `origin/weird` present, `git rev-parse "origin/weird"` exits 0
  // and prints the path, so that capture can carry a non-sha onward. It is
  // real, it is NOT this class (it suppresses nothing — git's diagnosis already
  // reaches the operator there), and widening this test to cover it would fix a
  // second mechanism under a ticket that named neither the site nor the defect.
  // Reported separately rather than smuggled in here.
  const unverified = ALL.filter((g) => /\brev-parse\b/.test(g.line)
    && />\/dev\/null/.test(g.line)
    && /"\$(base|sha)"|origin\/|refs\/heads\//.test(g.line)
    && !/--verify\b/.test(g.line));
  assert.deepEqual(
    unverified.map((g) => `${g.path}: ${g.line}`),
    [],
    "without `--verify`, `git rev-parse <a-file-path>` prints the path and exits 0, so a ref argument naming a FILE clears the guard",
  );
});

// ---------------------------------------------------------------------------
// Behaviour. The static sweep above pins the spelling; these pin what the
// spelling buys, per site, at the script's own boundary.

const ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Bare origin, a clone on `main`, and a linked worktree on a pushed `feat`. */
function repo(t) {
  // realpath'd: on macOS `$TMPDIR` sits under the `/var` → `/private/var`
  // symlink and the scripts report the RESOLVED path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "muted-guard-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  const wt = join(root, "wt");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, work], { env: ENV });
  writeFileSync(join(work, "f.txt"), "x\n");
  git(work, "add", "f.txt");
  git(work, "commit", "-q", "-m", "init");
  git(work, "push", "-q", "origin", "main");
  git(work, "worktree", "add", "-q", wt, "-b", "feat");
  git(work, "push", "-q", "origin", "feat");
  git(work, "fetch", "-q", "origin");
  return { root, origin, work, wt };
}

const run = (cwd, script, args = [], extraEnv = {}) =>
  spawnSync("sh", [join(DIR, script), ...args], { cwd, env: { ...ENV, ...extraEnv }, encoding: "utf8" });

// Each site, by the caller-facing way in. `release-ticket.sh` accepts only a
// remote-tracking base — an earlier guard refuses any other shape — so the
// fixture must be `origin/…` there or the run never reaches the line under test.
const SITES = [
  { script: "worktree-audit.sh", args: [], env: { BASE_REF: "origin/nosuchref" }, names: "origin/nosuchref" },
  { script: "reap.sh", args: [], env: { BASE_REF: "origin/nosuchref" }, names: "origin/nosuchref" },
  { script: "release-ticket.sh", args: ["578", "feat", "fix"], env: { BASE_REF: "origin/nosuchref" }, names: "origin/nosuchref" },
  { script: "no-undo-audit.sh", args: ["@WT@", "feat"], env: { BASE_REF: "origin/nosuchref" }, names: "origin/nosuchref" },
  // The sharp site: a branch that resolves locally but was never pushed. Its
  // message used to assert `fetch it, or it was never pushed` — a two-item
  // cause list this guard cannot distinguish between, and not even the whole
  // set. BASE_REF is left healthy so the `$base` guard above it cannot fire.
  { script: "no-undo-audit.sh", args: ["@WT@", "never-pushed"], env: {}, names: "origin/never-pushed" },
];

for (const s of SITES) {
  test(`${s.script} (${s.names}): git's own reason reaches stderr, and the exit is unchanged`, (t) => {
    const c = repo(t);
    const r = run(c.work, s.script, s.args.map((a) => (a === "@WT@" ? c.wt : a)), s.env);

    // Dropping `--quiet` moves the rev-parse's OWN status 1 → 128. `die` exits
    // 2 unconditionally, so the script's vocabulary must not move with it.
    assert.equal(r.status, 2, `refusal must stay exit 2, got ${r.status}; stderr ${JSON.stringify(r.stderr)}`);
    assert.match(r.stderr, new RegExp(`${s.names.replace("/", "\\/")} does not resolve`),
      "the guard must still say what it observed");
    assert.match(r.stderr, /fatal: Needed a single revision/,
      "git's own diagnosis must survive to stderr — this is the whole point of the ticket");
    // The message states an observation and stops. Anything of the form
    // `— do X, or Y` is the guard guessing between causes it cannot tell apart.
    assert.doesNotMatch(r.stderr, /does not resolve —/,
      "no message may append a cause list to what the guard observed");
  });
}

test("a healthy guard is silent — unmuting costs the healthy path nothing", (t) => {
  const c = repo(t);
  // Both invocation forms that ship: with `-C <worktree>` and without.
  for (const args of [["rev-parse", "--verify", "origin/main"], ["-C", c.wt, "rev-parse", "--verify", "origin/feat"]]) {
    const r = spawnSync("git", args, { cwd: c.work, env: ENV, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "", `a guard that SUCCEEDS must add nothing to stderr, got ${JSON.stringify(r.stderr)}`);
  }
});

test("reap.sh: the base guard sits under the fetch guard, and the order holds", (t) => {
  // The one ordering this ticket flagged for checking rather than reasoning
  // about. Both legs refuse at 2, so the exit alone cannot tell them apart —
  // the MESSAGE is what the runbook reads, and each must name its own failure.
  const c = repo(t);

  const healthyFetch = run(c.work, "reap.sh", [], { BASE_REF: "origin/nosuchref" });
  assert.equal(healthyFetch.status, 2);
  assert.match(healthyFetch.stderr, /reap: origin\/nosuchref does not resolve/);
  assert.doesNotMatch(healthyFetch.stderr, /fetch failed/, "the fetch succeeded — this must be the guard after it");

  // Now break the fetch. The base is still unresolvable, so if the order ever
  // inverts this leg starts reporting the base instead of the transport.
  git(c.work, "remote", "set-url", "origin", join(c.root, "nope.git"));
  const brokenFetch = run(c.work, "reap.sh", [], { BASE_REF: "origin/nosuchref" });
  assert.equal(brokenFetch.status, 2);
  assert.match(brokenFetch.stderr, /reap: fetch failed — refusing to reap on stale refs/);
  assert.doesNotMatch(brokenFetch.stderr, /does not resolve/,
    "a broken transport must not be reported as an unresolvable base — the fetch guard runs first");
});
