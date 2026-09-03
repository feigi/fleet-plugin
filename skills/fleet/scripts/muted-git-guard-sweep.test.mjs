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
// The mechanism, measured (git 2.50.1 Apple Git-155, throwaway repo) rather
// than inferred:
//
//   $ git rev-parse --verify --quiet nosuchref   # exit 1,   0 bytes of stderr
//   $ git rev-parse -q --verify nosuchref        # exit 1,   0 bytes of stderr
//   $ git rev-parse --verify nosuchref           # exit 128, `fatal: Needed a single revision`
//
// So the suppression is the whole defect, and removing it is the whole fix.
//
// `-q` and `--quiet` are the WHOLE spelling surface, measured rather than
// assumed: `git rev-parse` does not take abbreviated long options, so the
// near-misses are not synonyms and need no pattern of their own —
// `--quie`, `--qui`, `--qu` and `--q` each come back exit 128 with `fatal:
// Needed a single revision`, i.e. treated as a revision argument, not as
// `--quiet`. (`--veri` likewise is not `--verify`: it exits 0 and verifies
// nothing, which the `--verify` test below catches as a missing `--verify`.)
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
// WHAT IS AND IS NOT IN THE CLASS. The discriminator is which OUTCOME is
// fatal, and it is not a stylistic tell — the two shapes want opposite things:
//
//   failure is fatal   git's reason is the missing information, and the guard
//                      is silent on an unambiguous success. Unmute it.
//   success is fatal   (`&& die`, `&& has_branch=true`) failure is the
//                      EXPECTED answer — a branch-existence probe asking
//                      whether a name is free. Unmuting prints `fatal: Needed
//                      a single revision` on every HEALTHY run. `--quiet` is
//                      load-bearing; leave it. Measured: exit 1 / 0 bytes
//                      muted, exit 128 / 32 bytes not.
//
// "Failure is fatal" is read off the SHAPE, not off one spelling of it: the
// sweep below joins shell's own line continuations first, so `|| die`,
// `|| { die …; }`, a `||` left dangling at end of line, and
// `if ! … ; then die` are one population, and a guard escapes by being
// correct rather than by being written differently. Each of those spellings,
// and each way a comment could move a verdict, has a fixture in
// `SHAPES` below — a sweep whose own blind spots are only argued for is this
// ticket repeating.
//
// Deliberately outside this sweep, each with its reason:
//
//   - `fetch --quiet` (prove-merge.sh, reap.sh, verify-sha.sh). Measured
//     against a broken remote: 196 bytes of `fatal:` still reach stderr,
//     because `--quiet` suppresses progress, not diagnosis. Nothing is muted.
//   - The `2>/dev/null` probes. An adjacent mechanism, tracked in #481, #482
//     and #391, and not this one.
//   - Captures (`tip=$(git rev-parse …)`), which suppress nothing — a capture
//     is read, so git's diagnosis reaches the operator on failure whether or
//     not `--verify` is present. verify-sha.sh had one without `--verify`,
//     a real defect of a DIFFERENT mechanism (#1146 fixed it: the capture now
//     carries `--verify`, so a working-directory path can no longer clear it
//     at exit 0). Whether captures join THIS sweep is a separate decision,
//     left open rather than folded in here — #1146 is one fixed site, not a
//     general capture audit. The `>/dev/null` clause in the `--verify` test
//     below is what keeps captures out structurally, regardless of that
//     decision.
//
// Comment text inside the shell scripts is stripped before any of this, and
// the strip is quote-aware. Not because some sentence happens to trip the
// scan today — it does not — but because prose about this defect is exactly
// what a contributor writes NEXT TO a guard, in both directions: a `--quiet`
// in a trailing comment on an already-correct line must not raise a false
// failure, and a `--verify` in a trailing comment must not silence a real one.
// Both directions are pinned in `SHAPES`. Quote-aware, because a `#` inside a
// `die` message is text, not the start of a comment.
//
// This file is `.mjs` and the sweep reads `*.sh`, so it cannot match its own
// prose or its own fixtures — the failure mode where a check quotes the
// pattern it greps for and reports on itself.
//
// KNOWN LIMIT: this file needs an ambient `.git` (see `REPO` below) and throws
// at module load without one, so it cannot run from a `git archive`
// extraction — measured, 2 of 93 test files in this directory. It fails loudly
// there rather than passing vacuously, and CI checks out a real clone, but it
// is how review specialists measure the suite (#1056). Tracked with its
// sibling, which has the same defect and predates this file, in #1149.
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
 * Drop a trailing `#` comment. Quote-aware: a `#` inside a `die` message is
 * text — stripping at it would truncate the guard and lose the `|| die` that
 * classifies it.
 */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"') i++;
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * One logical shell statement per element, comments already gone.
 *
 * Joined, because a guard's `die` routinely sits on a later physical line and
 * a per-line scan then classifies it as having no `die` at all — silently
 * exempting the very sites this ticket is about. Three continuations ship in
 * this codebase and all three are joined: a trailing backslash, a bare `||`
 * or `&&` left at end of line (shell continues on its own — release-ticket.sh
 * and inflight.sh both use it), and `then` at end of line for the
 * `if ! … ; then` / newline / `die` shape.
 *
 * Comments are stripped BEFORE joining, so a sentence ending in `||` cannot
 * glue two unrelated statements together.
 *
 * Ceiling: the `then` join reaches the first statement of the branch, not the
 * whole branch. A `die` three lines into an `if !` body is not seen. Every
 * guard of this class in this codebase is one statement; widen the join if
 * that stops being true.
 */
function statements(text) {
  return text
    .split("\n").map(stripComment).join("\n")
    .replace(/\\\n[ \t]*/g, " ")
    .replace(/(\|\||&&|\bthen)[ \t]*\n[ \t]*/g, "$1 ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * The `git … rev-parse …` command itself, cut at the first redirection, pipe,
 * list operator or `$(` close.
 *
 * Flags are read off THIS, never off the whole statement: `--quiet` in a `die`
 * message and `--verify` in a trailing comment are prose about the guard, not
 * arguments to it, and neither may move a verdict.
 */
function revParseCmd(statement) {
  const m = /\bgit\b.*?\brev-parse\b/.exec(statement);
  return m ? statement.slice(m.index).split(/\s*\d?[<>|;&)]/)[0] : "";
}

/** Every `git rev-parse` invocation a script ships, as { path, line, cmd }. */
function scan(path, text) {
  return statements(text)
    .filter((line) => /\bgit\b.*\brev-parse\b/.test(line))
    .map((line) => ({ path, line, cmd: revParseCmd(line) }));
}

const ALL = SHELL_SCRIPTS.flatMap((p) => scan(p, readFileSync(join(REPO, p), "utf8")));

/**
 * Does a FAILURE of this rev-parse end the script? That — not `|| die`
 * literally — is the population: `|| { die …; }` and `if ! … ; then die` are
 * the same guard. `&& die` is the opposite shape and stays out by construction.
 */
const failureIsFatal = (g) => /\|\|\s*\{?\s*die\b/.test(g.line)
  || /^if\s+!\s.*\bthen\b.*\bdie\b/.test(g.line);

/** `-q` and `--quiet` are exact synonyms and the whole surface — see the header. */
const isMuted = (g) => /(?:^|\s)(?:-q|--quiet)(?=\s|$)/.test(g.cmd);

/**
 * Does this rev-parse name a REF, as opposed to asking about the repository?
 * `--git-dir`, `--show-toplevel`, `--absolute-git-dir` and friends take no rev
 * operand, which is why they are exempt — a property of the call, not a list of
 * script names to keep up to date.
 */
const resolvesARef = (g) => {
  const words = g.cmd.split(/\s+/);
  const rest = words.slice(words.indexOf("rev-parse") + 1);
  return rest.some((w, i) => !w.startsWith("-") && rest[i - 1] !== "--git-path");
};

// The two verdicts, written once. The fixtures below and the sweep over what
// ships must ask the SAME question, or the fixtures stop defending anything.
const isMutedGuard = (g) => failureIsFatal(g) && isMuted(g);
const isUnverifiedGuard = (g) => failureIsFatal(g)
  && />\/dev\/null/.test(g.line)
  && resolvesARef(g)
  && !/--verify\b/.test(g.cmd);

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
  const muted = ALL.filter(isMutedGuard);
  assert.deepEqual(
    muted.map((g) => `${g.path}: ${g.line}`),
    [],
    "each of these dies on a failure whose reason only git knows, and `-q`/`--quiet` throws that reason away. "
      + "Drop it — keep `--verify`. If the failure here is the EXPECTED answer, the guard wants `&& …`, not `|| die`.",
  );
});

test("every rev-parse resolution guard keeps --verify", () => {
  // The regression a reader "tidying up" after the fix would introduce, and the
  // one a comment alone does not survive.
  //
  // Scoped by shape, not by variable name: a fatal guard that DISCARDS stdout
  // and names a ref exists only to ask whether that name resolves, whatever the
  // variable holding it is called. Keying on `"$base"`/`"$sha"` instead would be
  // the enumerate-by-name failure this file's header condemns.
  //
  // A CAPTURE (`tip=$(git rev-parse …)`) is deliberately out, which is what the
  // `>/dev/null` clause buys. It asks a different question — the value, not the
  // yes/no — and it suppresses nothing, so git's diagnosis already reaches the
  // operator there. verify-sha.sh had one without `--verify`; measured, with a
  // file `origin/weird` present `git rev-parse "origin/weird"` exits 0 and
  // prints the path, so that capture could carry a non-sha onward. Real, and a
  // different mechanism: fixed at its own site by #1146 rather than widened
  // into here — verify-sha.sh's capture now carries `--verify` too.
  const unverified = ALL.filter(isUnverifiedGuard);
  assert.deepEqual(
    unverified.map((g) => `${g.path}: ${g.line}`),
    [],
    "without `--verify`, `git rev-parse <a-file-path>` prints the path and exits 0, so a ref argument naming a FILE clears the guard",
  );
});

// The sweep's own blind spots, pinned. Every escape below was a real hole in
// the first version of this file: each ships the identical defect, and each was
// green. `verdict` is what the two static tests above must now say.
const SHAPES = [
  { why: "the long spelling", muted: true, src: 'git rev-parse --quiet --verify "$base" >/dev/null || die "no"' },
  { why: "`-q`, an exact synonym", muted: true, src: 'git rev-parse -q --verify "$base" >/dev/null || die "no"' },
  { why: "`-q` written after `--verify`", muted: true, src: 'git rev-parse --verify -q "$base" >/dev/null || die "no"' },
  { why: "a backslash continuation", muted: true, src: 'git rev-parse -q --verify "$base" >/dev/null \\\n  || die "no"' },
  { why: "a bare `||` left at end of line", muted: true, src: 'git rev-parse -q --verify "$base" >/dev/null ||\n  die "no"' },
  { why: "a braced die", muted: true, src: 'git rev-parse -q --verify "$base" >/dev/null || { die "no"; }' },
  { why: "`if ! … ; then die`", muted: true, src: 'if ! git rev-parse -q --verify "$base" >/dev/null; then\n  die "no"\nfi' },
  { why: "a trailing comment must not hide a real one", muted: true, src: 'git rev-parse -q --verify "$base" >/dev/null || die "no"  # fixed in #578' },
  { why: "`-C` before the subcommand", muted: true, src: 'git -C "$wt" rev-parse -q --verify "$base" >/dev/null || die "no"' },

  { why: "an already-correct guard", muted: false, src: 'git rev-parse --verify "$base" >/dev/null || die "no"' },
  { why: "a `--quiet` in a trailing comment must not raise a false failure", muted: false, src: 'git rev-parse --verify "$base" >/dev/null || die "no"  # never add --quiet here' },
  { why: "a `--quiet` in the die message is prose, not an argument", muted: false, src: 'git rev-parse --verify "$b" >/dev/null || die "unresolved; never silence this with --quiet again"' },
  { why: "a `|| die` inside a comment must not make a probe look fatal", muted: false, src: 'git rev-parse --verify --quiet "refs/heads/$b" >/dev/null && has_branch=true  # not a || die site: failure is the answer' },
  { why: "a whole-line comment is not code", muted: false, src: '# git rev-parse --quiet --verify "$base" >/dev/null || die "no"' },
  { why: "success-is-fatal: a branch-existence probe wants --quiet", muted: false, src: 'git rev-parse --verify --quiet "refs/heads/$b" >/dev/null && die "branch exists"' },
  { why: "a `#` inside the message must not truncate the guard", muted: false, src: 'git rev-parse --verify "$b" >/dev/null || die "$b does not resolve (see #578)"' },
];

const REFS = [
  { why: "a differently-named ref variable still escapes nothing", unverified: true, src: 'git rev-parse "$candidate" >/dev/null || die "no"' },
  { why: "a `--verify` in a trailing comment must not silence a real one", unverified: true, src: 'git rev-parse "$ref" >/dev/null || die "no"  # --verify deliberately omitted here' },
  { why: "a `--verify` in the die message is prose, not an argument", unverified: true, src: 'git rev-parse "$ref" >/dev/null || die "unresolved; pass --verify to fix this"' },
  { why: "`if ! … ; then die` on a bare name", unverified: true, src: 'if ! git rev-parse "$ref" >/dev/null; then\n  die "no"\nfi' },

  { why: "`--verify` present", unverified: false, src: 'git rev-parse --verify "$ref" >/dev/null || die "no"' },
  { why: "a repository probe names no ref", unverified: false, src: 'git rev-parse --git-dir >/dev/null 2>&1 || die "not inside a git repository"' },
  { why: "`--git-path` takes a path, not a rev", unverified: false, src: 'git rev-parse --path-format=absolute --git-path logs/refs/stash >/dev/null || die "no"' },
  { why: "a capture is a different mechanism — #1146 fixed this exact site, but the sweep excludes captures on shape, not on that ticket's status", unverified: false, src: 'tip=$(git rev-parse --verify "origin/$branch") || die "no"' },
  { why: "a probe whose failure is the answer", unverified: false, src: 'git rev-parse "$ref" >/dev/null && die "taken"' },
];

test("the sweep keys on the defect, not on one spelling of it", () => {
  for (const f of SHAPES) {
    const hit = scan("fixture.sh", f.src).filter(isMutedGuard);
    assert.equal(hit.length, f.muted ? 1 : 0,
      `${f.why}: expected ${f.muted ? "a hit" : "no hit"}, got ${JSON.stringify(hit.map((g) => g.line))} from ${JSON.stringify(f.src)}`);
  }
});

test("the --verify half keys on shape, not on a list of variable names", () => {
  for (const f of REFS) {
    const hit = scan("fixture.sh", f.src).filter(isUnverifiedGuard);
    assert.equal(hit.length, f.unverified ? 1 : 0,
      `${f.why}: expected ${f.unverified ? "a hit" : "no hit"}, got ${JSON.stringify(hit.map((g) => g.line))} from ${JSON.stringify(f.src)}`);
  }
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
  return { root, work, wt };
}

const run = (cwd, script, args, extraEnv) =>
  spawnSync("sh", [join(DIR, script), ...args], { cwd, env: { ...ENV, ...extraEnv }, encoding: "utf8" });

// Each site, by the caller-facing way in. `release-ticket.sh` accepts only a
// remote-tracking base — an earlier guard refuses any other shape — so the
// fixture must be `origin/…` there or the run never reaches the line under test.
//
// `remedy` is what may follow the observation, and only that. A guard may name
// an ACTION that is true whatever the cause; it may not guess BETWEEN causes it
// cannot tell apart. Measured: `git rev-parse --verify` answers
// `fatal: Needed a single revision` for a never-pushed branch, a stale ref,
// `main^99`, `refs/heads/nope` and a plain `nosuchref` alike — a constant, so
// git's stderr cannot pick the cause either and a cause list is always a guess.
const SITES = [
  { script: "worktree-audit.sh", args: [], env: { BASE_REF: "origin/nosuchref" }, names: "origin/nosuchref", remedy: null },
  { script: "reap.sh", args: [], env: { BASE_REF: "origin/nosuchref" }, names: "origin/nosuchref", remedy: null },
  { script: "release-ticket.sh", args: ["578", "feat", "fix"], env: { BASE_REF: "origin/nosuchref" }, names: "origin/nosuchref", remedy: null },
  { script: "no-undo-audit.sh", args: ["@WT@", "feat"], env: { BASE_REF: "origin/nosuchref" }, names: "origin/nosuchref", remedy: null },
  // The sharp site: a branch that resolves locally but was never pushed. Its
  // message used to assert `fetch it, or it was never pushed` — a two-item
  // cause list this guard cannot distinguish between, and not even the whole
  // set. What replaces it is an action, not a cause: one `git fetch origin` is
  // the right next move whichever of them fired, so it stays true where the
  // list could not. BASE_REF is left healthy so the `$base` guard above it
  // cannot fire.
  {
    script: "no-undo-audit.sh", args: ["@WT@", "never-pushed"], env: {}, names: "origin/never-pushed",
    remedy: /does not resolve — run 'git fetch origin' and retry/,
  },
];

for (const s of SITES) {
  test(`${s.script} (${s.names}): git's own reason reaches stderr, and the exit is unchanged`, (t) => {
    const c = repo(t);
    const r = run(c.work, s.script, s.args.map((a) => (a === "@WT@" ? c.wt : a)), s.env);

    // Dropping `--quiet` moves the rev-parse's OWN status 1 → 128. `die` exits
    // 2 unconditionally, so the script's vocabulary must not move with it.
    assert.equal(r.status, 2, `refusal must stay exit 2, got ${r.status}; stderr ${JSON.stringify(r.stderr)}`);
    assert.match(r.stderr, new RegExp(`${s.names} does not resolve`),
      "the guard must still say what it observed");
    assert.match(r.stderr, /fatal: Needed a single revision/,
      "git's own diagnosis must survive to stderr — this is the whole point of the ticket");
    if (s.remedy) {
      assert.match(r.stderr, s.remedy, "the remedy is an action, and it must survive verbatim");
    } else {
      // The message states an observation and stops. Anything of the form
      // `— …` here would be the guard guessing at a cause it cannot see.
      assert.doesNotMatch(r.stderr, /does not resolve —/,
        "this site has no action to offer, so it must append nothing to what it observed");
    }
    // No message, at any site, may guess between causes git's own constant
    // stderr cannot tell apart. This is the clause #578 removed.
    assert.doesNotMatch(r.stderr, /fetch it, or it was never pushed/,
      "a cause list the guard cannot distinguish between is a guess, not information");
  });
}

test("an unambiguous healthy guard is silent — unmuting costs that path nothing", (t) => {
  const c = repo(t);
  // Both invocation forms that ship: with `-C <worktree>` and without.
  for (const args of [["rev-parse", "--verify", "origin/main"], ["-C", c.wt, "rev-parse", "--verify", "origin/feat"]]) {
    const r = spawnSync("git", args, { cwd: c.work, env: ENV, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "", `a guard that SUCCEEDS must add nothing to stderr, got ${JSON.stringify(r.stderr)}`);
  }
});

test("an AMBIGUOUS name is what unmuting does cost — a succeeding guard warns", (t) => {
  // The one price of dropping `--quiet`, pinned rather than left to the word
  // "silent" above. A refname that is both a branch and a tag resolves fine —
  // exit 0, the audit still runs — but git now says so, and `--quiet` used to
  // swallow that. Worth knowing: it is a warning about the OPERATOR's ref, not
  // noise, and no guard here refuses on it.
  const c = repo(t);
  git(c.work, "tag", "dup", "main");
  git(c.work, "branch", "dup", "main");
  const r = spawnSync("git", ["rev-parse", "--verify", "dup"], { cwd: c.work, env: ENV, encoding: "utf8" });
  assert.equal(r.status, 0, "an ambiguous name still resolves — the guard passes");
  assert.match(r.stderr, /warning: refname 'dup' is ambiguous/,
    "this is the cost of unmuting, and it is stated here so the next reader does not read `silent` as unconditional");
  const quiet = spawnSync("git", ["rev-parse", "--quiet", "--verify", "dup"], { cwd: c.work, env: ENV, encoding: "utf8" });
  assert.equal(quiet.stderr, "", "and `--quiet` is what used to suppress it — that is why this is a cost, not a coincidence");
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
