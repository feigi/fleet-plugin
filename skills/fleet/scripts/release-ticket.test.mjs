// Regression gate for release-ticket.sh, which deletes a claim's worktree and
// branch. Zero deps: `node --test skills/fleet/scripts/release-ticket.test.mjs`.
//
// It is guarded by four preconditions and every one of them is the only thing
// standing between a member's work and a delete, so each has a case here that
// proves it blocks ON ITS OWN — asserting the blocker it emits, not merely that
// the script exited non-zero, since any other precondition firing would satisfy
// that. Deleting a check must fail the case named after it.
//
// Real git throughout: a shell script that reasons about git history can only be
// tested against real git history. `gh` is stubbed on PATH for every case. `git`,
// `sed` and `awk` are stubbed on PATH too, but only by the cases that simulate a
// specific failure, and each of those shims falls through to the real binary for
// every invocation it is not aimed at.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./release-ticket.sh", import.meta.url));
const INFLIGHT = fileURLToPath(new URL("./inflight.sh", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixtures, so a
// local pull.rebase or hook cannot change what these repos look like. BASE_REF
// is unset for the reason prove-merge.test.mjs unsets it: the fleet harness is
// exactly the caller that has it set, and inheriting it would point every
// fixture at a local main while the suite stayed green.
const ENV = {
  ...process.env,
  BASE_REF: undefined,
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

// Every fixture below that reaches its condition through `chmod` rests on the
// bits being ENFORCED, and root ignores them: it searches an 0o000 directory
// and traverses an 0o400 one. Under euid 0 those fixtures do not test a weaker
// thing, they test a different one — `a stray worktree the script may not stat
// keeps the hand-release remedy` would go green under the very mutation it
// exists to catch (`gone "$stray"` -> `[ ! -e "$stray" ]`), silently ceasing to
// be the only case that tells the ancestor walk from a naive `-e`. CI is
// `ubuntu-latest` with no `container:` key, so this is not live today; moving
// the suite into a container is an ordinary thing to do, and this makes that
// loud instead of silent. (#184)
// Named once rather than inlined at every site, unlike the inlined
// `process.getuid?.() === 0` guards the sibling suites carry: a guard that
// fires unconditionally turns every one of those fixtures into a skip with
// nothing failing, and a single named predicate is the only thing
// `the euid-0 guard does not fire on a normal run, and the modes it guards
// really deny (#184)` can pin.
// Deliberately no count of those fixtures is written down here or below: this
// block carried a stale one once already, when a commit added a fixture and
// left the prose at the old number (#661). Re-derive rather than trust prose,
// with a pattern whose `^[[:space:]]+if` forces `if` to be the line's first
// non-space token, so a `//` prefix can never match and no comment quoting the
// guard is counted, at any indent. That exclusion is the requirement; pinning
// the guards to exactly two spaces of indent only ever met it by accident, and
// silently undercounts a guard nested one block deeper:
//   grep -cE '^[[:space:]]+if \(EUID0\)' skills/fleet/scripts/release-ticket.test.mjs
// `geteuid`, not `getuid`, because the EFFECTIVE uid is what the kernel checks
// permissions against -- the two differ only under setuid, where getuid is the
// one that gets it wrong.
const EUID0 = process.geteuid?.() === 0;
const NO_DENIAL = "chmod denies nothing under euid 0";

// The real git behind every PATH shim below, resolved once at import so the
// bodies that need the binary before falling through can name it. `command -v`
// like the sed and awk shims further down, rather than the `which` these git
// shims each used: `which` is not POSIX and need not exist.
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

// Same, for `awkShim` below. The #395 counter shim keeps its own inline body: it
// exits 1 with nothing on stderr, modelling an awk that could not run and had
// nothing to say, where `awkShim` exits 2 with a diagnostic.
const REAL_AWK = execFileSync("sh", ["-c", "command -v awk"], { encoding: "utf8" }).trim();

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Commit `content` as f.txt on the current branch; returns its sha. */
const commit = (w, msg, content) => {
  writeFileSync(join(w, "f.txt"), content);
  git(w, "add", "f.txt");
  git(w, "commit", "-q", "-m", msg);
  return git(w, "rev-parse", "HEAD");
};

/**
 * Bare origin + working clone with one commit on main, plus a `gh` stub on
 * PATH. Returns the clone dir, the stub's call log path, and an env builder.
 */
function repo(t, dir = "w") {
  const root = mkdtempSync(join(tmpdir(), "release-ticket-"));
  // Restore the search bits before deleting, rather than trusting each fixture's
  // own restore to have run. A fixture that chmods a directory unsearchable and
  // then fails BEFORE restoring it -- `release()` throws on `JSON.parse` when a
  // regression emits a malformed payload, which is exactly when one of these
  // fixtures is most likely to be the one that fails -- leaves `rmSync` throwing
  // ENOTEMPTY (measured), and node drops that error on the floor: the temp dir
  // leaks with nothing said. Doing it here covers every permission fixture in
  // the file at once, including any added later, and leaves `release()` free to
  // propagate the real error instead of swallowing it into a null payload that
  // the `assert.equal(json, null)` cases would then accept as a clean refusal.
  // spawnSync, not execFileSync: a chmod that fails must not become a second
  // error masking the first. (#184)
  t.after(() => {
    spawnSync("chmod", ["-R", "u+rwX", root]);
    rmSync(root, { recursive: true, force: true });
  });
  const origin = join(root, "origin.git");
  const w = join(root, dir);
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  commit(w, "root", "root\n");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");

  // The stub answers the two calls release-ticket.sh makes and the two
  // inflight.sh makes, keyed on the whole argument line because both scripts
  // reach GitHub through `gh issue view`. GH_RC turns any call into a failure.
  const bin = join(root, "bin");
  execFileSync("mkdir", ["-p", bin]);
  const log = join(root, "gh.log");
  writeFileSync(
    join(bin, "gh"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
[ "\${GH_RC:-0}" = 0 ] || { echo "gh: simulated failure" >&2; exit "\$GH_RC"; }
# GH_RC fails the label READ, which aborts before any delete. This one fails only
# the write, the single call that lands after both artefacts are already gone.
case "$*" in
  *"issue edit"*) [ "\${GH_EDIT_RC:-0}" = 0 ] || { echo "gh: HTTP 502" >&2; exit "\$GH_EDIT_RC"; } ;;
esac
[ -z "\${GH_STDERR:-}" ] || echo "\$GH_STDERR" >&2
# The check-then-act window: this call sits between the last precondition and
# the first delete, so writing here is a member committing during the round trip.
[ -z "\${GH_DIRTY:-}" ] || echo late > "\$GH_DIRTY"
# Same window, a different appearance: the claim's directory is replaced by a
# symlink standing in for it. That is the shape \`git worktree remove\` clears the
# registration for and only THEN fails on, and the precondition that refuses a
# non-directory has already run by the time this call lands.
[ -z "\${GH_SYMLINK:-}" ] || { mv "\$GH_SYMLINK" "\$GH_SYMLINK.real" && ln -s "\$GH_SYMLINK.real" "\$GH_SYMLINK"; }
case "$*" in
  *closedByPullRequestsReferences*) ;;
  *"--json labels"*) printf '%s\\n' "\${GH_LABELS-in-progress}" ;;
  *"pr list"*) printf '[]\\n' ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  writeFileSync(log, "");

  return {
    w,
    log,
    env: (extra = {}) => ({ ...ENV, PATH: `${bin}:${ENV.PATH ?? process.env.PATH}`, ...extra }),
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean),
  };
}

/**
 * Re-point the registration for `wt` at `dest` and take the real directory away.
 *
 * `git worktree list --porcelain` derives the worktree path from the entry's
 * `gitdir` file, so rewriting that file is how a fixture gets git to name a
 * path whose FIRST component under `/` does not exist — the one shape
 * `git worktree add` cannot produce, since it has to create the directory. In
 * production this is the hand-added worktree outside the checkout whose
 * ancestor chain was removed (`git worktree add /scratch/wt`, then
 * `rm -rf /scratch`). The registry entry itself survives, so any
 * listed-vs-registered count stays balanced.
 */
function relocate(w, wt, dest) {
  const admin = join(w, ".git", "worktrees");
  // realpathSync: git canonicalises what it writes into `gitdir`, and on macOS
  // a tmpdir path reaches this suite as /var/... while git recorded
  // /private/var/... — the scan matches nothing without resolving first.
  const target = join(realpathSync(wt), ".git");
  const name = readdirSync(admin).find(
    (n) => readFileSync(join(admin, n, "gitdir"), "utf8").trim() === target,
  );
  assert.ok(name, `fixture: no registry entry points at ${wt}`);
  writeFileSync(join(admin, name, "gitdir"), `${dest}/.git\n`);
  rmSync(wt, { recursive: true, force: true });
  return dest;
}

/**
 * Leave an Orphaned worktree directory: the claim's directory on disk with its
 * registration cleared and its branch untouched.
 *
 * Built by taking the directory out of git's reach, pruning, and putting it
 * back — rather than by deleting the registry entry by hand, so the repo is
 * left in a state git itself produced and any listed-vs-registered count stays
 * balanced. Production reaches the same state through a `git worktree remove`
 * that cleared the registration before failing to delete the directory; the
 * end-to-end case below drives that route instead of this one.
 */
function orphan(r, c) {
  const aside = `${c.wt}.aside`;
  renameSync(c.wt, aside);
  git(r.w, "worktree", "prune");
  renameSync(aside, c.wt);
  assert.ok(
    !git(r.w, "worktree", "list", "--porcelain").includes(c.wt),
    "fixture: the registration must really be gone, or this is just a stray",
  );
}

/** What claim-ticket.sh leaves behind: a worktree on a fresh branch off origin/main. */
function claim(w, issue, slug, type = "fix") {
  const branch = `${type}/${issue}-${slug}`;
  const wt = join(w, ".worktrees", `${issue}-${slug}`);
  git(w, "worktree", "add", "-q", wt, "-b", branch, "origin/main");
  return { branch, wt, args: [String(issue), slug, type] };
}

/**
 * A `git` on the fixture's PATH — the same `bin` dir `repo` puts the `gh` stub
 * in — that runs `body` first and defers to real git for whatever `body` leaves
 * unhandled. `body` may interpolate `REAL_GIT` when it has to call the real
 * binary and then keep going (the #395 case appends a line to its listing).
 */
function gitShim(r, body) {
  writeFileSync(join(r.w, "..", "bin", "git"), `#!/bin/sh\n${body}\nexec '${REAL_GIT}' "$@"\n`, { mode: 0o755 });
}

/**
 * Fail `awk` on PATH for the one program whose text contains `marker`, and hand
 * every other invocation straight to the real binary. The marker is a substring
 * of the awk PROGRAM, never a count of invocations: release-ticket.sh runs
 * several awks over the same listing and only the program text tells them apart.
 */
function awkShim(r, marker) {
  writeFileSync(
    join(r.w, "..", "bin", "awk"),
    `#!/bin/sh\ncase "$*" in *'${marker}'*) echo "awk: simulated failure" >&2; exit 2 ;; esac\nexec '${REAL_AWK}' "$@"\n`,
    { mode: 0o755 },
  );
}

function release(r, c, { apply = true, env = {}, cwd = r.w } = {}) {
  const argv = apply ? [...c.args, "--apply"] : c.args;
  const res = spawnSync("sh", [SCRIPT, ...argv], {
    cwd,
    env: r.env(env),
    encoding: "utf8",
  });
  return {
    code: res.status,
    json: res.stdout.trim() ? JSON.parse(res.stdout) : null,
    // Raw, alongside the parsed form: a receipt that must not move with a
    // prose change can only be pinned by its bytes. Parsing and re-serialising
    // would accept a reordered or reformatted payload as identical.
    out: res.stdout,
    stderr: res.stderr,
  };
}

/** Does the claim still exist on disk and in git? */
const artefacts = (r, c) => ({
  dir: existsSync(c.wt),
  worktree: git(r.w, "worktree", "list", "--porcelain").includes(`branch refs/heads/${c.branch}`),
  branch: git(r.w, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").includes(c.branch),
});

test("a clean undispatched claim releases all three artefacts", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "fixture");

  const { code, json } = release(r, c);
  assert.equal(json.released, true);
  assert.deepEqual(json.blockers, []);
  assert.equal(code, 0);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
  assert.ok(
    r.calls().includes(`issue edit 9 --remove-label in-progress`),
    `the label is the half that hides the ticket from candidates.mjs: ${r.calls()}`,
  );
});

test("after a release the in-flight probe no longer reads the ticket as taken", (t) => {
  // The acceptance criterion, measured against the real consumer rather than
  // against this test's idea of one: inflight.sh, the script phase 0 runs.
  if (spawnSync("python3", ["-c", ""]).status !== 0) return t.skip("inflight.sh needs python3");
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const probe = () => spawnSync("sh", [INFLIGHT, "9"], { cwd: r.w, env: r.env(), encoding: "utf8" });
  assert.equal(probe().status, 1, "fixture: the claim really does read as taken first");

  assert.equal(release(r, c).code, 0);
  assert.equal(probe().status, 0, "a released ticket must go back into the pool");
});

test("a commit already upstream-equivalent still blocks: `ahead` catches what `git cherry` cannot", (t) => {
  // The case that proves the two commit checks are not one check written twice.
  // The branch's patch has been cherry-picked onto main, so `git cherry` calls it
  // equivalent and emits `-`; only the ahead count still sees the local commit.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const sha = commit(c.wt, "the member's work", "work\n");
  // -x, so the upstream copy is a distinct commit. A plain cherry-pick here
  // reproduces the branch commit byte for byte — same tree, parent, message and
  // second — and lands on the same sha, which is a different fixture entirely.
  git(r.w, "cherry-pick", "-x", sha);
  git(r.w, "push", "-q", "origin", "main");
  git(r.w, "fetch", "-q", "origin");
  assert.equal(
    git(r.w, "cherry", "origin/main", `refs/heads/${c.branch}`).charAt(0),
    "-",
    "fixture: git cherry really does read this commit as upstream-equivalent",
  );

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `only the ahead check can fire here: ${json.blockers}`);
  assert.match(json.blockers[0], /1 commit\(s\) ahead of/);
  assert.equal(json.released, false);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a commit that exists nowhere else blocks, and `git cherry` says so", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  commit(c.wt, "the member's work", "work\n");

  const { code, json, stderr } = release(r, c);
  assert.ok(
    json.blockers.some((b) => /unique to .* \(git cherry\)/.test(b)),
    `the cherry check must report the commit as its own finding: ${json.blockers}`,
  );
  assert.equal(json.released, false);
  assert.equal(code, 1);
  // Refused BEFORE anything was attempted, which is a different finding from a
  // mutation refused mid-flight with nothing landed — same three artefacts
  // standing, different thing for the operator to do about it. The two prose
  // lines are what carry that distinction, so they may not collide.
  assert.match(stderr, /#9 NOT released — nothing was touched/);
  assert.doesNotMatch(stderr, /HALTED/, "nothing was attempted, so nothing halted");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

// #387: a `die` firing after a `block` used to discard every accumulated
// blocker whole — exit 2, prose on stderr, and no JSON receipt on stdout at
// all, so a caller that already had a real finding computed got none of it.
// Drive exactly that shape: the ahead check blocks first (one real finding
// accumulated into `$blockers`), then `git cherry` itself fails, which is the
// die this fix reaches. The shim is matched on argv, never on content — `git
// cherry origin/main ...` is the only call this script makes whose first two
// words are "cherry origin/main".
test("a die after a block still emits the accumulated blockers, not a bare exit 2 (#387)", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  commit(c.wt, "the member's work", "work\n");
  gitShim(r, `case "$1 $2" in "cherry origin/main") echo 'cherry shim failure' >&2; exit 1 ;; esac`);

  const { code, json, stderr } = release(r, c);
  const cause = `git cherry failed on ${c.branch} against origin/main, so whether it carries unique commits is unknown`;

  assert.equal(code, 2, "still a die, not the exit 1 a plain blocked verdict uses");
  assert.notEqual(json, null, "a receipt is still printed — die used to exit before any printf");
  assert.equal(json.released, false);
  assert.equal(json.label, null, "the label is read after every one of these dies can fire, so it cannot be known here");
  assert.equal(json.applied, true, "the flag value survives, even though nothing was attempted");
  // `die` has its OWN inlined printf, not shared with `halt`, the blocked
  // checkpoint or the success receipt, so nothing else in this file pins these
  // two fields for THIS emitter: hardcoding either here passed the whole suite.
  // `git worktree list --porcelain` reports the realpath, which on macOS is not
  // the /var symlink the fixture built.
  assert.equal(json.branch, c.branch, "the receipt names the claim's branch, not a literal from a copy-paste");
  assert.equal(json.worktree, realpathSync(c.wt), "and the worktree path git listed, likewise");
  assert.equal(json.blockers.length, 2, `the ahead finding and the die's own cause, both: ${json.blockers}`);
  assert.match(json.blockers[0], /^1 commit\(s\) ahead of origin\/main$/, "the finding computed before the die is not dropped");
  assert.equal(json.blockers[1], cause, "and the die's own cause is appended last, exactly where `block` would have put it");
  assert.match(stderr, new RegExp(cause.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "stderr prose is unchanged");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

// The same die-after-block path with `--apply` withheld. Without it nothing in
// the suite discriminates the receipt's `applied` field from a hardcoded
// `true`: this path is reached exactly once, and `release` defaults the flag
// on, so a die printf that ignored `$apply` entirely stayed green across all
// 98 cases in this file.
test("the die receipt's applied field is the flag, not a constant (#387)", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  commit(c.wt, "the member's work", "work\n");
  gitShim(r, `case "$1 $2" in "cherry origin/main") echo 'cherry shim failure' >&2; exit 1 ;; esac`);

  const { code, json } = release(r, c, { apply: false });

  assert.equal(code, 2, "a dry run still dies here — the scan is what failed");
  assert.notEqual(json, null, "and still prints its receipt");
  assert.equal(json.applied, false, "the flag is reported as passed, not as the default the other case happens to use");
  assert.equal(json.blockers.length, 2, `the same two findings a dry run computes: ${json.blockers}`);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

// `die`'s guard is `[ -n "${blockers:-}" ]`, and `set -u` is satisfied by an
// INHERITED value just as well as by one the run computed. An ambient variable
// of that name therefore took the guard true on an early die — before `$issue`
// exists — and the receipt printf aborted on `issue: unbound variable`, losing
// the very diagnostic the die is there to print. Any non-empty value does it:
// `[ -n ]` tests non-emptiness, not JSON validity, so `[]` is as fatal as
// `[x]`. The pin is on the PROSE and not on the exit code, because the code the
// defect produced is platform-asymmetric — bash-as-/bin/sh gave 1, dash gave 2 —
// and a code pin measured on one of them says nothing about CI running the
// other.
for (const inherited of ["[]", "[x]", '"x",']) {
  test(`an inherited blockers=${inherited} does not silence an early die (#387)`, () => {
    const res = spawnSync("sh", [SCRIPT], {
      env: { ...process.env, blockers: inherited },
      encoding: "utf8",
    });
    assert.match(res.stderr, /release-ticket: usage: release-ticket\.sh/, "the usage diagnostic still prints");
    assert.doesNotMatch(res.stderr, /unbound variable|parameter not set/, "and the die is not itself killed by set -u");
    assert.equal(res.stdout, "", "no half-written receipt: this die has nothing accumulated to report");
  });
}

// The control this fix must not break: a die with nothing accumulated stays
// exactly as it was — no `$blockers` reference reached at all, so the check is
// exercised by the existing "an unreachable remote" and ".git file" cases below
// (each asserts `json === null` for a die on a claim with no blocker computed
// yet), not repeated here.

test("a dirty worktree blocks on its own", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "scratch.txt"), "work that exists nowhere else\n");

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `no commit exists, so only the dirty check can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /1 uncommitted change\(s\)/);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

// #119, the other direction: the library is present and its tools are not.
// `block()` used to splice `$(jstr "$1")` straight into the accumulator, which
// is not a simple command, so `set -e` read only the assignment — a failed
// escape aborted at exit 1, byte-identical to the blocked verdict below, with
// neither the receipt that verdict carries nor a line on stderr. Assigned
// first, the status is readable and the answer becomes a 2.
//
// The shim is selected on CONTENT, not on argv: `branch_j`/`wt_j` are escaped
// well before the precondition scan and go through the same `jstr`, so a sed
// that failed unconditionally would abort there instead and prove nothing about
// `block()`. Only a blocker string carries "uncommitted change".
test("a blocker that cannot be escaped is exit 2 with a cause, never the blocked verdict", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "scratch.txt"), "work that exists nowhere else\n");

  const bin = mkdtempSync(join(tmpdir(), "release-ticket-esc-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const realSed = execFileSync("sh", ["-c", "command -v sed"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "sed"), `#!/bin/sh
case " $* " in
  *:a*)
    in=$(cat)
    case "$in" in *'uncommitted change'*) exit 1 ;; esac
    printf '%s\\n' "$in" | exec ${realSed} "$@" ;;
esac
exec ${realSed} "$@"
`, { mode: 0o755 });

  const res = release(r, c, { env: { PATH: `${bin}:${r.env().PATH}` } });

  assert.equal(res.code, 2,
    "exit 1 is `NOT released — blocked`, and a run that could not render its blocker has not established one");
  assert.match(res.stderr, /could not escape the blocker for #9/,
    "and the cause names the field rather than leaving the operator with a silent 1");
  assert.equal(res.out, "", "no receipt: a blockers array missing an element is not the record this exit promises");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a pushed branch blocks on its own", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(r.w, "push", "-q", "origin", c.branch);

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `the tree is clean and empty, so only the remote check can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /exists on origin/);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a blocked claim reports its blocker without asking GitHub", (t) => {
  // Measured in a fresh clone whose origin is not a GitHub remote: reaching for
  // the tracker first turns every offline blocked claim into an unanswerable
  // one and buries the finding. The blockers already decided the answer.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "scratch.txt"), "work that exists nowhere else\n");

  const { code, json } = release(r, c, { env: { GH_RC: "1" } });
  assert.equal(code, 1, "blocked, not unanswerable");
  assert.equal(json.blockers.length, 1);
  assert.equal(json.label, null, "the label was never read, and must not be reported as if it were");
  assert.deepEqual(r.calls(), [], "no tracker call is needed to know this claim is blocked");
});

test("the main checkout is never mistaken for the claim's worktree", (t) => {
  // Found in a fresh clone, where the claim branch is what HEAD points at. Match
  // the main worktree and `git worktree remove` refuses — but only after the
  // label has been dropped, leaving the ticket hidden from candidates.mjs with
  // both artefacts still on disk.
  const r = repo(t);
  git(r.w, "checkout", "-q", "-b", "fix/9-release-ticket", "origin/main");

  const { code, json } = release(r, { args: ["9", "release-ticket", "fix"] });
  assert.equal(json.worktree, "", "the main checkout is not a worktree this script may remove");
  assert.match(json.blockers.join(" "), /checked out in the main checkout/);
  assert.equal(code, 1);
  assert.deepEqual(r.calls(), [], "and the label is never touched");
  assert.ok(
    git(r.w, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").includes("fix/9-release-ticket"),
    "the branch survives",
  );
});

test("a worktree that is no longer on the branch blocks instead of releasing around it", (t) => {
  // `worktree list` locates the claim by its branch, and the worktree does not
  // stay on it: an interrupted rebase leaves it detached, a member can switch it.
  // Find nothing and the dirty check is skipped, so a claim whose worktree still
  // holds uncommitted work reports released — and the in-flight probe below still
  // reads the ticket as taken, which is the failure this script exists to fix.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(c.wt, "checkout", "-q", "--detach", "HEAD");
  writeFileSync(join(c.wt, "scratch.txt"), "work that exists nowhere else\n");

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /is this claim's but is not on fix\/9-release-ticket/);
  assert.equal(json.released, false);
  assert.equal(code, 1);
  assert.deepEqual(r.calls(), [], "and the label is never touched");
  assert.equal(existsSync(join(c.wt, "scratch.txt")), true, "the member's work stays put");
  assert.ok(
    git(r.w, "for-each-ref", "--format=%(refname:short)", "refs/heads").split("\n").includes(c.branch),
    "the branch survives",
  );
});

test("a stray worktree whose directory is gone names the prune that clears it", (t) => {
  // Same guard, the other outcome: `stray` is matched on the worktree LIST, and
  // the registration outlives the directory — `worktree list --porcelain` keeps
  // the entry, annotated `prunable`, after an `rm -rf`. Asking only whether it is
  // registered sent every such claim to "release it by hand", which names an
  // action on a directory that is not there: nothing to release, so nothing the
  // operator does clears it, so the next run blocks identically — permanently,
  // with the label and the branch standing and the in-flight probe still reading
  // the ticket as taken.
  //
  // Still a blocker, not a release: the claim's branch is not what this worktree
  // has checked out, so releasing would delete a different ref and then reach the
  // `git worktree prune` every apply ends with — unanchoring a detached HEAD's
  // commits, which nothing else points at, as a side effect of releasing
  // something else. Naming that prune is handing the operator the same command
  // as a decision they make. It does clear the entry, and the run after it
  // releases (measured, git 2.50.1).
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(c.wt, "checkout", "-q", "--detach", "HEAD");
  rmSync(c.wt, { recursive: true, force: true });

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /git worktree prune/, "the remedy must be the one that clears a registration");
  assert.doesNotMatch(json.blockers[0], /by hand/, "there is no directory left for the operator to release");
  assert.equal(code, 1);
  assert.deepEqual(r.calls(), [], "and the label is never touched");
  // `artefacts().worktree` asks whether a worktree is registered ON THE BRANCH,
  // which a detached one never is — that is what makes it stray in the first
  // place. So the entry this case is about is measured by its path instead.
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: true }, "the branch survives");
  assert.ok(
    git(r.w, "worktree", "list", "--porcelain").includes("/.worktrees/9-release-ticket\n"),
    "and so does the stale entry: clearing it is the prune's job, not this blocked run's",
  );
});

test("a LOCKED stray worktree names the unlock, not a prune git silently skips", (t) => {
  // The remedy the guard above hands out has to be one git will actually
  // perform. `git worktree prune` SKIPS a locked entry — rc 0, nothing printed,
  // the registration still sitting there afterwards (measured, git 2.50.1) — so
  // naming it for a locked stray names no action the operator can take, and
  // every later run blocks identically. That is the permanent refusal this
  // script exists to clear, reintroduced by the remedy meant to clear it.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(c.wt, "checkout", "-q", "--detach", "HEAD");
  git(r.w, "worktree", "lock", c.wt, "--reason", "held by a review");
  rmSync(c.wt, { recursive: true, force: true });

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /git worktree unlock/, "the lock is what makes both other remedies refuse, so it is named first");
  assert.doesNotMatch(json.blockers[0], /prune to clear the registration/, "a bare prune clears nothing here");
  assert.equal(code, 1);
  assert.deepEqual(r.calls(), [], "and the label is never touched");
  assert.ok(
    git(r.w, "worktree", "list", "--porcelain").includes("/.worktrees/9-release-ticket\n"),
    "the locked entry survives the blocked run: clearing it is the operator's decision",
  );
});

test("a stray worktree the script may not stat keeps the hand-release remedy", (t) => {
  if (EUID0) return t.skip(NO_DENIAL);
  // -e is false for a directory that is gone and for one inside a prefix we may
  // not search, and only the first is an absence — the distinction the ancestor
  // walk exists to make, which a bare `[ -e "$stray" ]` would collapse. Read as
  // gone, this hands the operator `git worktree prune`: a command that discards
  // the registration of a worktree that is still sitting there with uncommitted
  // work in it, unregistering the only record of where that work lives.
  //
  // 0o000 on the PARENT, not on the worktree: the walk stops at the nearest
  // ancestor that exists, so making the worktree itself unsearchable leaves it
  // stat-able from outside and -e still answers true. Dropping the parent's bits
  // is what makes the entry unstattable while the ancestor that does answer is
  // the unsearchable one.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(c.wt, "checkout", "-q", "--detach", "HEAD");
  writeFileSync(join(c.wt, "precious.txt"), "work that exists nowhere else\n");
  const parent = join(r.w, ".worktrees");

  chmodSync(parent, 0o000);
  const { code, json } = release(r, c);
  // Restored before the first assert, for the reason "a worktree the script may
  // not look at is unknown, never a release" gives: the `precious.txt` read
  // below goes through this directory and gets EACCES while it is 0o000.
  chmodSync(parent, 0o755);

  assert.equal(code, 1);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.doesNotMatch(json.blockers[0], /prune/, "never a prune of a registration whose worktree may still be there");
  assert.match(json.blockers[0], /release it by hand/);
  assert.equal(readFileSync(join(c.wt, "precious.txt"), "utf8"), "work that exists nowhere else\n");
});

test("a stray worktree with no surviving ancestor below / still names the prune (#178)", (t) => {
  // The escalation of the two cases above, and the one the ancestor walk used
  // to lose: `${p%/*}` on `/x` yields the empty string rather than `/`, so a
  // path whose every ancestor below the root is gone fell out of the loop on
  // "" and `[ -x "" ]` answered unknown — for a path that is provably absent
  // with a searchable root. That sent it to the `else` and printed
  // "release it by hand" about a directory that is not there: nothing for the
  // operator to release, so nothing clears it, so every later run blocks the
  // same way. That is the #81 permanent refusal, reached through the one path
  // shape nobody tested.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(c.wt, "checkout", "-q", "--detach", "HEAD");
  // Ends in the claim's own `<issue>-<slug>`, because `stray` is matched on
  // that exact path suffix — a leaf of any other name is not this claim's.
  const dest = relocate(r.w, c.wt, "/nonexistent-top-level-178/9-release-ticket");

  const { code, json } = release(r, c);
  assert.equal(code, 1);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /git worktree prune/, "the remedy must be the one that clears a registration");
  assert.doesNotMatch(json.blockers[0], /by hand/, "there is no directory left for the operator to release");
  assert.ok(json.blockers[0].includes(dest), "and it must name the path git listed");
  assert.deepEqual(r.calls(), [], "and the label is never touched");
});

test("a stray worktree whose HEAD git could not resolve blocks without claiming a branch mismatch", (t) => {
  // A fourth way into the same `else`, distinct from the two above: the
  // worktree is sitting on exactly the claim's branch, present and readable,
  // but git could not resolve its admin HEAD file — so the branch lookup that
  // finds `wt` comes back empty and this worktree reads as `stray` too. The
  // old `else` then told the operator the worktree was on some OTHER branch,
  // which is false: it is on this one, and git simply could not say so.
  //
  // Garbage content is the fixture here — no permission bits, no symlink —
  // and it reproduces the exact porcelain shape all four broken-HEAD routes
  // produce: the null object id with no `branch` line. The four are enumerated
  // at `unresolved_head` in release-ticket.sh; the dangling-symlink and
  // directory routes are built in "the symlink and directory HEAD shapes reach
  // the same arm, `detached` line and all", and the `chmod 000` route in "the
  // chmod 000 HEAD shape reaches the same arm, and prints no `detached` line".
  //
  // No checkout call: this worktree never left the branch claim-ticket.sh put
  // it on. Only its admin HEAD file is broken.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(r.w, ".git", "worktrees", "9-release-ticket", "HEAD"), "garbage\n");

  // The other half of `unresolved_head`'s parenthetical, and the fixture-shape
  // pin the `chmod 000` case carries too: this route is the second of the two
  // that print no `detached` line, and unlike `chmod 000` it needs no
  // permission bit, so it still measures under euid 0. Without it this fixture
  // can be quietly rebuilt as the dangling-symlink shape and the whole suite
  // stays green, leaving one of the four routes untested (measured).
  assert.doesNotMatch(git(r.w, "worktree", "list", "--porcelain"), /^detached$/m,
    "fixture: garbage content, like chmod, prints no detached line");

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /could not read its HEAD/);
  // Anchored against the exact branch-mismatch phrase, not a shared word: this
  // message and the `else`'s both end "... by hand", so a bare /by hand/ check
  // would pass whichever one fired.
  assert.doesNotMatch(json.blockers[0], /is not on fix\/9-release-ticket/, "the worktree IS on this branch — git just could not tell");
  assert.doesNotMatch(json.blockers[0], /release it by hand/, "distinct message from the branch-mismatch else");
  assert.doesNotMatch(json.blockers[0], /prune/, "not the directory-gone remedy either");
  assert.equal(json.released, false);
  assert.equal(code, 1);
  assert.deepEqual(r.calls(), [], "and the label is never touched");
  assert.deepEqual(
    artefacts(r, c),
    { dir: true, worktree: false, branch: true },
    "`artefacts().worktree` keys on the branch LINE, which the corrupt HEAD removed — the directory and branch both survive untouched",
  );
});

test("the symlink and directory HEAD shapes reach the same arm, `detached` line and all", (t) => {
  // The other two broken-HEAD routes enumerated at `unresolved_head` in
  // release-ticket.sh. The garbage fixture above pins that the arm fires; these
  // pin that it is keyed on the right FIELD, which nothing here could pin
  // before.
  //
  // All four routes produce the null object id with no `branch` line, but only
  // these two ALSO print a `detached` line (measured, git 2.50.1: chmod and
  // garbage do not). That makes them the only fixtures in this file whose
  // porcelain can tell `unresolved_head`'s `branch` key from a `detached` one —
  // adding `cur&&/^detached$/{hasbranch=1}` to it reds these and leaves every
  // other test in the file green (measured). Not because nothing else prints
  // the line — the genuine `--detach` fixtures elsewhere in this file do — but
  // because those carry a real sha, so the `nullhead` half of the guard never
  // fires for them and the added trigger has nothing left to flip. That
  // mutation is the exact misread the function's own comment warns about, and
  // until this fixture it was refuted by nothing.
  //
  // Neither shape touches a permission bit, so unlike the `chmod 000` route
  // built in "the chmod 000 HEAD shape reaches the same arm, and prints no
  // `detached` line", both reproduce as any user and mean the same thing
  // under euid 0, with no `EUID0` skip to carry.
  for (const shape of ["symlink", "dir"]) {
    const r = repo(t);
    const c = claim(r.w, 9, "release-ticket");
    const head = join(r.w, ".git", "worktrees", "9-release-ticket", "HEAD");
    rmSync(head);
    // Dangling INSIDE the fixture root, not at `/nonexistent`: the link only
    // has to fail to resolve, and one anchored in the temp repo cannot start
    // resolving because of something on the machine running the suite.
    if (shape === "symlink") symlinkSync(join(r.w, "no-such-head"), head);
    else mkdirSync(head);

    // The shape really reached the porcelain this test is named for, measured
    // on the repo rather than inferred from the prose above. A fixture that
    // quietly produced the garbage shape's output instead would duplicate the
    // test above and pin nothing new — the vacuous pass this whole case exists
    // to avoid. Only the claim's worktree can supply the line: the main
    // checkout is on `main` and carries a `branch` line.
    assert.match(git(r.w, "worktree", "list", "--porcelain"), /^detached$/m,
      `fixture: the ${shape} shape must really print the detached line`);

    const { code, json } = release(r, c);
    assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
    assert.match(json.blockers[0], /could not read its HEAD/, shape);
    assert.doesNotMatch(json.blockers[0], /is not on fix\/9-release-ticket/, `the worktree IS on this branch, ${shape}`);
    assert.doesNotMatch(json.blockers[0], /release it by hand/, `distinct message from the branch-mismatch else, ${shape}`);
    assert.equal(json.released, false, shape);
    assert.equal(code, 1, shape);
    // The sibling's two lines, not redundancy: a regression that blocked and
    // ALSO touched the tracker or deleted the worktree left this case green
    // while reddening the sibling (measured, both mutations). `worktree: false`
    // because `artefacts()` keys on the `branch` LINE, which the broken HEAD
    // removes — the directory and branch themselves both survive.
    assert.deepEqual(r.calls(), [], `and the label is never touched, ${shape}`);
    assert.deepEqual(artefacts(r, c), { dir: true, worktree: false, branch: true }, shape);
  }
});

test("the chmod 000 HEAD shape reaches the same arm, and prints no `detached` line", (t) => {
  // The fourth broken-HEAD route enumerated at `unresolved_head` in
  // release-ticket.sh, and the only one of the four needing a permission bit —
  // hence the skip below, which the garbage, symlink and directory routes do
  // not carry. Under euid 0 the mode denies nothing: git reads the HEAD, the
  // `branch` line comes back, the worktree stops being a stray at all and the
  // release proceeds. The fixture would build the HEALTHY shape and assert the
  // broken one's remedy.
  if (EUID0) return t.skip(NO_DENIAL);

  // A file's own bits do not gate its unlink, only its parent directory's do, so
  // a mode-000 HEAD costs `repo()`'s chmod-back teardown nothing — a naive
  // `rmSync` already clears it, where the fixtures putting a mode on a DIRECTORY
  // still rest on that chmod-back and get `ENOTEMPTY` without it (measured).
  // What this route does need is the in-body restore below, which the garbage,
  // symlink and directory routes have nothing to restore for.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const head = join(r.w, ".git", "worktrees", "9-release-ticket", "HEAD");
  chmodSync(head, 0o000);

  // Both reads taken while the bit is off, asserted only after the restore
  // below: `artefacts()` runs `worktree list` itself, so an assert that fired
  // here would leave the mode at 000 for the rest of the case.
  const porcelain = git(r.w, "worktree", "list", "--porcelain");
  const { code, json } = release(r, c);
  // Guarded, because the restore runs before the first assert and must not
  // become the failure itself: strip this fixture's `chmodSync(head, 0o000)`
  // and the release SUCCEEDS, taking the whole worktree with it, so a bare
  // chmod here dies ENOENT and buries the shape assertion below that is the
  // real report (measured — it was the raw failure this case first produced).
  // Nothing leaks either way: a mode-000 FILE never blocks `rmSync`, and
  // `repo()`'s teardown chmods the root back regardless.
  if (existsSync(head)) chmodSync(head, 0o644);

  // The shape, measured on the repo rather than inferred from the enumeration.
  // Only the claim's worktree can supply either line: the main checkout is on
  // `main`, carrying a real sha and a `branch` line of its own.
  assert.match(porcelain, /^HEAD 0+$/m, "fixture: the mode alone must produce the null object id");
  assert.doesNotMatch(porcelain, /^branch refs\/heads\/fix\/9-release-ticket$/m, "fixture: and must take the branch line with it");
  // The half of the sibling's parenthetical that nothing in this file asserted
  // before: this route is one of the two that do NOT print `detached`, which is
  // why `unresolved_head` can key on that line in neither direction.
  assert.doesNotMatch(porcelain, /^detached$/m, "fixture: and chmod, unlike the symlink and directory shapes, prints no detached line");

  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /could not read its HEAD/);
  assert.doesNotMatch(json.blockers[0], /is not on fix\/9-release-ticket/, "the worktree IS on this branch — the mode just stopped git reading it");
  assert.doesNotMatch(json.blockers[0], /release it by hand/, "distinct message from the branch-mismatch else");
  assert.equal(json.released, false);
  assert.equal(code, 1);
  assert.deepEqual(r.calls(), [], "and the label is never touched");
  // All three true, where the other three routes leave `worktree: false`: the
  // fault was the mode and nothing else, so the restore above puts the `branch`
  // line back. Nothing on disk was damaged, and nothing was released.
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true });
});

test("a symlink over HEAD that RESOLVES never reaches the unresolved-HEAD arm — the linkage probe refuses first", (t) => {
  // What this case pins is the LINKAGE PROBE, not `unresolved_head`, and the
  // name says so because the obvious reading is wrong: point the link at the
  // real HEAD file and `worktree list --porcelain` reads straight through it —
  // a real sha with the `branch` line intact (measured, git 2.50.1). That
  // `branch` line is what sets `wt`, so the `[ -z "$wt" ] && [ -n "$stray" ]`
  // block that owns the unresolved-HEAD arm is skipped entirely and
  // `unresolved_head` is never called. Measured, not reasoned: mutating it to
  // `END{exit 0}` — unresolved for every input — leaves this case green while
  // reddening four others. The acceptance direction is pinned by the case
  // below, which detaches the worktree so the arm actually runs.
  //
  // What refuses this claim is git's own repository-validity check, which
  // rejects a symlinked HEAD where `worktree list` accepts it: the linkage
  // probe dies (measured) and the run emits no payload at all. This is the
  // only case in the suite that pins that die, so the phrase below is asserted
  // rather than the mere absence of a blocker — against a null payload every
  // `doesNotMatch` on a blocker would pass for the wrong reason.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const head = join(r.w, ".git", "worktrees", "9-release-ticket", "HEAD");
  renameSync(head, `${head}.real`);
  symlinkSync(`${head}.real`, head);

  const listed = git(r.w, "worktree", "list", "--porcelain");
  assert.match(listed, /^branch refs\/heads\/fix\/9-release-ticket$/m,
    "fixture: a resolving symlink must leave the branch line git could not produce for the dangling one");
  assert.doesNotMatch(listed, /^HEAD 0+$/m, "and a real sha, not the null OID the four broken routes share");

  const { code, json, stderr } = release(r, c);
  assert.equal(json, null, "the linkage probe refuses before any payload is emitted");
  // The distinguishing prefix, not the shared tail: the `.git`-file refusal
  // ends in the same words, so a tail-only match could not tell them apart.
  assert.match(stderr, /cannot read the git linkage of/);
  assert.doesNotMatch(stderr, /could not read its HEAD/, "HEAD resolved fine — this refusal is about the linkage");
  assert.equal(code, 2);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "and nothing is touched");
});

test("a RESOLVING symlink over HEAD is ACCEPTED by the unresolved-HEAD guard, not refused for being a symlink", (t) => {
  // The acceptance direction, and the arm the case above cannot reach. Detaching
  // the worktree drops the `branch` line, so `wt` comes back empty, `stray` is
  // set, and the block that owns `unresolved_head` runs for real — with a HEAD
  // git reads perfectly well, through a symlink.
  //
  // The guard has to key on the FAULT (git could not resolve HEAD) and not on
  // the file type. A guard keyed on "HEAD is a symlink" refuses this worktree
  // and tells the operator its branch is unknown, when git can read it and the
  // honest answer is the branch-mismatch `else` below the arm. Nothing pinned
  // that direction before: the case above asserts it in prose but never
  // executes the function.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(c.wt, "checkout", "-q", "--detach", "HEAD");
  const head = join(r.w, ".git", "worktrees", "9-release-ticket", "HEAD");
  renameSync(head, `${head}.real`);
  symlinkSync(`${head}.real`, head);

  // A real sha, so `nullhead` never fires — and the `detached` line present,
  // which is exactly the field `unresolved_head` must NOT key on. This fixture
  // is the counterexample to that misread as well as to the file-type one.
  const listed = git(r.w, "worktree", "list", "--porcelain");
  assert.doesNotMatch(listed, /^HEAD 0+$/m, "fixture: git reads through the symlink to a real sha");
  assert.match(listed, /^detached$/m, "fixture: and prints the line a `detached`-keyed guard would trip on");

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /is not on fix\/9-release-ticket/, "git read HEAD fine — the worktree is simply elsewhere");
  assert.doesNotMatch(json.blockers[0], /could not read its HEAD/, "where a guard keyed on the file type rather than the fault would land");
  assert.equal(json.released, false);
  assert.equal(code, 1);
  assert.deepEqual(r.calls(), [], "and the label is never touched");
});

test("a stray worktree whose directory is gone still gets the prune remedy, even with an unresolvable HEAD", (t) => {
  // Arm order is locked, then gone, then unresolved-HEAD, then the
  // branch-mismatch else. This worktree qualifies for both of the middle two
  // — its directory is gone AND its admin HEAD is corrupted — and gone must
  // keep winning: the unresolved-HEAD fault is only interesting while there
  // is still a directory to talk about, and prune is right regardless of
  // what HEAD says.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(r.w, ".git", "worktrees", "9-release-ticket", "HEAD"), "garbage\n");
  rmSync(c.wt, { recursive: true, force: true });

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /git worktree prune/, "the directory-gone remedy outranks the HEAD one");
  assert.doesNotMatch(json.blockers[0], /could not read its HEAD/);
  assert.equal(code, 1);
});

test("an unborn-branch stray worktree is not swept into the unresolved-HEAD arm", (t) => {
  // A null object id is not by itself evidence git could not resolve HEAD: an
  // unborn branch (`git worktree add --orphan`) is a legitimate null OID that
  // DOES carry a `branch` line (measured, git 2.50.1). Sweeping it in would
  // refuse a healthy worktree the moment it is created, before it holds a
  // single commit — the false-positive class this arm must not open.
  //
  // Same directory, different branch: an orphan worktree cannot be added onto
  // an existing ref, so the claim's branch survives untouched and this is a
  // plain branch-mismatch case wearing a null OID.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(r.w, "worktree", "remove", "--force", c.wt);
  git(r.w, "worktree", "add", "-q", "--orphan", "-b", "orphan-9", c.wt);

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /is not on fix\/9-release-ticket/);
  assert.equal(code, 1);
  assert.equal(artefacts(r, c).branch, true, "the claim's own branch survives untouched");
});

test("a SIBLING's unresolvable HEAD is not this claim's unresolvable HEAD", (t) => {
  // `unresolved_head` reads the whole porcelain listing, so the per-entry `cur`
  // reset is the only thing standing between a sibling's broken HEAD and this
  // claim. Every other fixture for this arm registers exactly one worktree,
  // which exercises none of it: making `cur` sticky (`{if(...)cur=1}`, set but
  // never reset), or dropping the `cur&&` guard off `nullhead=1`, leaves every
  // other fixture in this file green and reds only this one (measured, both).
  //
  // The sibling is 99, and the number is load-bearing for the same reason it is
  // in "a lock on a SIBLING worktree is not this claim's lock": `worktree list
  // --porcelain` orders entries LEXICOGRAPHICALLY, so a `10-` sibling sorts
  // BEFORE `9-release-ticket` and its lines have already gone by before
  // anything sets the flag. 99 sorts after, which is the order that exercises
  // the reset.
  //
  // The direction is chosen for the same reason: the claim is genuinely
  // detached (a real sha, no `branch` line) and the SIBLING is the one whose
  // admin HEAD is garbage. Both mutants then answer TRUE for this claim off the
  // sibling's null OID — asserting a HEAD fault about a worktree whose HEAD is
  // fine — where the honest answer is the ordinary branch mismatch the `else`
  // exists for.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  claim(r.w, 99, "other-claim");
  git(c.wt, "checkout", "-q", "--detach", "HEAD");
  writeFileSync(join(r.w, ".git", "worktrees", "99-other-claim", "HEAD"), "garbage\n");

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /is not on fix\/9-release-ticket/);
  assert.doesNotMatch(json.blockers[0], /could not read its HEAD/, "the unreadable HEAD is the sibling's — this claim's resolved fine");
  assert.equal(code, 1);
});

test("a LOCKED stray with a corrupt HEAD still names the unlock", (t) => {
  // Arm precedence between the top two, which nothing else reaches. The one
  // other locked-stray fixture leaves HEAD readable and `rmSync`s the
  // directory, so `unresolved_head` is false there and the ordering is never
  // exercised; hoisting the HEAD arm above `locked` reds only the GONE test,
  // because that mutation jumps `gone` as well. Measured: gating the lock arm
  // on `! unresolved_head` survives the whole suite without this fixture.
  //
  // The lock has to win. `git worktree prune` SKIPS a locked entry at rc 0 and
  // `remove` rejects one, so every remedy stays unreachable until the operator
  // unlocks — telling them to go repair a HEAD file first is the two-round-trip
  // version of the refusal this script exists to clear.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(r.w, ".git", "worktrees", "9-release-ticket", "HEAD"), "garbage\n");
  git(r.w, "worktree", "lock", c.wt, "--reason", "held by a review");

  const { code, json } = release(r, c);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /git worktree unlock/);
  assert.doesNotMatch(json.blockers[0], /could not read its HEAD/, "the lock is what blocks both remedies, whatever HEAD says");
  assert.equal(code, 1);
});

test("a stray worktree taken out by rm -rf .worktrees still names the prune", (t) => {
  // The stray half of the guard reaching the WALK, not just the one-level lookup.
  // `rm -rf .worktrees` is how this usually happens and it takes the parent along
  // with the child — the case the predicate's own comment names as its motive —
  // yet the two cases above only ever remove the child. Without this, a
  // stray-only precondition like `[ -d "${stray%/*}" ] &&` on the guard leaves the
  // whole file green while handing back "release it by hand" for a directory that
  // is not there: the permanent refusal, reinstated, with nothing to catch it.
  // The dirty-check caller has this covered at "the whole .worktrees directory
  // deleted by hand still releases"; the stray caller did not.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(c.wt, "checkout", "-q", "--detach", "HEAD");
  rmSync(join(r.w, ".worktrees"), { recursive: true, force: true });

  const { code, json } = release(r, c);
  assert.equal(code, 1);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed, so only the stray worktree can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /git worktree prune/, "the parent going too does not make the child unanswerable");
});

test("a repo path containing a space does not truncate the worktree it reads", (t) => {
  // `worktree list --porcelain` prints the path raw, so taking awk's $2 stops at
  // the first space — and every worktree under a directory like "My Repos", which
  // is ordinary on macOS, then reads as a different path. The dirty check either
  // dies on it or, if the truncation happens to name a clean directory, passes.
  const r = repo(t, "my repos");
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "scratch.txt"), "work that exists nowhere else\n");

  const { code, json } = release(r, c);
  // endsWith, not equal: macOS resolves the tmpdir through /private, so the
  // prefix legitimately differs. The part after the space is the whole point.
  assert.ok(
    json.worktree.endsWith("/my repos/.worktrees/9-release-ticket"),
    `the whole path, not the part before the space: ${json.worktree}`,
  );
  assert.equal(json.blockers.length, 1, `only the dirty check can fire: ${json.blockers}`);
  assert.match(json.blockers[0], /1 uncommitted change\(s\)/);
  assert.equal(code, 1);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a clean claim under a path with a space still releases", (t) => {
  // The other half: the space must not turn every release into a refusal either.
  const r = repo(t, "my repos");
  const c = claim(r.w, 9, "release-ticket");

  const { code, json } = release(r, c);
  assert.deepEqual([json.released, json.blockers, code], [true, [], 0]);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
});

test("an unreachable remote is an unknown answer, never a 'not pushed'", (t) => {
  // Swallowing this failure reads as "no remote branch" and releases a claim
  // whose work is already on the server.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(r.w, "remote", "set-url", "origin", join(r.w, "..", "definitely-not-a-repo"));

  const { code, json, stderr } = release(r, c);
  assert.equal(json, null);
  assert.equal(code, 2, "unanswerable is exit 2, not the exit 1 that means blocked");
  assert.match(stderr, /whether .* was pushed is unknown/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a gh failure aborts before anything is deleted", (t) => {
  // The label is read first on purpose: a release that removes the worktree and
  // branch but leaves in-progress hides the ticket from candidates.mjs entirely.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, stderr } = release(r, c, { env: { GH_RC: "1" } });
  assert.equal(code, 2);
  assert.match(stderr, /in-progress label cannot be released/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("the agent-test runner claim-ticket.sh writes is not dirt", (t) => {
  // Every fleet worktree carries it, and it is gitignored. Treating an ignored
  // file as dirt would block every release the drain step exists to make.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  appendFileSync(join(r.w, ".git", "info", "exclude"), "agent-test\n");
  writeFileSync(join(c.wt, "agent-test"), "#!/bin/sh\nexec npm test -- \"$@\"\n", { mode: 0o755 });

  const { code, json } = release(r, c);
  assert.deepEqual(json.blockers, []);
  assert.equal(code, 0);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
});

test("a locked worktree blocks the same way in a dry run and under --apply", (t) => {
  // #86: the dirty check only looked at whether $wt is a directory, and lock
  // state is orthogonal to that — a locked, clean, present worktree cleared
  // every guard, the dry run predicted "released":true, and --apply reached
  // `git worktree remove`, which refuses a locked entry outright regardless of
  // how clean it is.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(r.w, "worktree", "lock", c.wt, "--reason", "held by a review");

  const dry = release(r, c, { apply: false });
  assert.equal(dry.json.released, false, "the dry run must not promise what --apply will refuse");
  assert.match(dry.json.blockers.join(" "), /is locked/);

  const apply = release(r, c);
  assert.equal(apply.code, 1, "blocked before any mutation, not the exit 2 a mid-flight refusal produces");
  assert.match(apply.json.blockers.join(" "), /is locked/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be touched");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("a locked worktree whose directory was removed by hand still blocks, not a mid-flight refusal", (t) => {
  // The measured #86 repro: lock, then `rm -rf` the directory. The registration
  // outlives the directory (same as the stray case above), so -d reads false and
  // the old dirty check never opened at all — nothing blocked, the dry run said
  // "released":true, and --apply's `git worktree remove` refused the locked
  // entry (rc 128) with the directory already gone, exit 2 PARTIALLY RELEASED.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(r.w, "worktree", "lock", c.wt, "--reason", "held by a review");
  rmSync(c.wt, { recursive: true, force: true });

  const dry = release(r, c, { apply: false });
  assert.equal(dry.json.released, false, "must not predict a release git worktree remove will refuse");
  assert.match(dry.json.blockers.join(" "), /is locked/);

  const apply = release(r, c);
  assert.equal(apply.code, 1, "blocked before any mutation, not the exit 2 #86 measured");
  assert.match(apply.json.blockers.join(" "), /is locked/);
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("a regular file at the worktree path blocks instead of promising a release", (t) => {
  // The other #86 case: `git worktree remove` validates $wt/.git before
  // touching anything else, and a plain file at $wt has none — refused at rc
  // 128 ("does not exist"), measured. The old dirty check only opened when -d
  // held, so a non-directory sitting at $wt cleared every guard silently and
  // only --apply found out.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  rmSync(c.wt, { recursive: true, force: true });
  writeFileSync(c.wt, "not a worktree\n");

  const dry = release(r, c, { apply: false });
  assert.equal(dry.json.released, false);
  assert.match(dry.json.blockers.join(" "), /exists but is not a directory/);

  const apply = release(r, c);
  assert.equal(apply.code, 1, "blocked before any mutation");
  assert.match(apply.json.blockers.join(" "), /exists but is not a directory/);
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
  assert.equal(readFileSync(c.wt, "utf8"), "not a worktree\n", "the stand-in file is untouched");
});

test("a symlink standing in for the worktree directory blocks instead of promising a release", (t) => {
  // The shape the -e/-d pair cannot see on its own: every `test` primary except
  // -L FOLLOWS the link, so a symlink pointing at the real worktree directory
  // reads as present-and-a-directory, clears every blocker, and the dry run
  // promises a release. --apply then reaches `git worktree remove`, which
  // unregisters the entry and only THEN fails ("Not a directory") — so the
  // receipt says the worktree was not removed for a run that had already
  // landed something. A false receipt is worse than the refusal it reports.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const real = `${c.wt}-real`;
  renameSync(c.wt, real);
  symlinkSync(real, c.wt);

  const dry = release(r, c, { apply: false });
  assert.equal(dry.json.released, false, "the dry run must not promise what --apply will refuse");
  assert.match(dry.json.blockers.join(" "), /exists but is not a directory/);

  const apply = release(r, c);
  assert.equal(apply.code, 1, "blocked before any mutation, not the exit 2 a mid-flight refusal produces");
  assert.match(apply.json.blockers.join(" "), /exists but is not a directory/);
  assert.equal(lstatSync(c.wt).isSymbolicLink(), true, "the symlink is untouched");
  assert.equal(existsSync(join(real, ".git")), true, "and so is the real worktree behind it");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be touched");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("a dangling symlink at the worktree path blocks, not a mid-flight refusal", (t) => {
  // The other symlink shape, and the one the guard's own comment cites: -e is
  // false through a dangling link, so `gone` reports it established-absent and
  // the unknown-existence die above deliberately stands down. Nothing else
  // looked, the dry run said "released":true, and --apply got git's rc-128
  // `validation failed, cannot remove working tree: '.../.git' does not exist`.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  rmSync(c.wt, { recursive: true, force: true });
  symlinkSync(`${c.wt}-nowhere`, c.wt);

  const dry = release(r, c, { apply: false });
  assert.equal(dry.json.released, false, "must not predict a release git worktree remove will refuse");
  assert.match(dry.json.blockers.join(" "), /exists but is not a directory/);

  const apply = release(r, c);
  assert.equal(apply.code, 1, "blocked before any mutation");
  assert.match(apply.json.blockers.join(" "), /exists but is not a directory/);
  assert.equal(lstatSync(c.wt).isSymbolicLink(), true, "the symlink is untouched");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("a real worktree directory is not mistaken for a stand-in", (t) => {
  // The other half of the guard above: what `git worktree add` actually creates
  // must walk through it. -L tests the final component only, and that component
  // is always a real directory, so no fleet worktree trips the new blocker.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const dry = release(r, c, { apply: false });
  assert.deepEqual(dry.json.blockers, [], "an ordinary claim must clear the stand-in guard");
  assert.equal(dry.json.released, true);
});

test("a backslash in the worktree path does not make the lock probe answer `no`", (t) => {
  // POSIX has awk process escape sequences in a `-v` assignment, so the path
  // reached the lock probe mangled — this fixture's `back\slash` arriving as
  // `backslash` — and could never equal what the porcelain printed. The guard
  // then answered "not locked" for a locked worktree, which is the permissive
  // answer, and #86's split reopened underneath the fix for it: dry run
  // `"released":true` with no blockers, `--apply` exit 2 HALTED on git's
  // `cannot remove a locked working tree`.
  const r = repo(t, "back\\slash");
  const c = claim(r.w, 9, "release-ticket");
  git(r.w, "worktree", "lock", c.wt, "--reason", "held by a review");

  const dry = release(r, c, { apply: false });
  assert.equal(dry.json.released, false, "the dry run must not promise what --apply will refuse");
  assert.match(dry.json.blockers.join(" "), /is locked/);

  const apply = release(r, c);
  assert.equal(apply.code, 1, "blocked before any mutation, not the exit 2 a mid-flight refusal produces");
  assert.match(apply.json.blockers.join(" "), /is locked/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be touched");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("the dry run's plan names a backslashed worktree path verbatim", (t) => {
  // The plan is the operator's only chance to see what `--apply` would delete,
  // and it ran through `echo`, which expands escapes in its operand: a `\c` in
  // the path truncated the line at `back` and swallowed its newline, so the
  // plan named a directory that does not exist and the line after it collided
  // onto the remains (#484).
  //
  // `back\clue`, not the `back\slash` the lock fixture above uses: `\s` is an
  // unknown escape and passes through `echo` untouched, which is what makes a
  // `\slash` fixture read as coverage while catching nothing. Only `\c`
  // truncates.
  //
  // Asserted on the tail rather than on `c.wt`: this file's `repo()` does not
  // realpath its mkdtemp root, while git reports the RESOLVED path, so on
  // macOS the two differ by a `/private` prefix. The leaf and the newline are
  // what the defect destroys anyway.
  const r = repo(t, "back\\clue");
  const c = claim(r.w, 9, "release-ticket");

  const dry = release(r, c, { apply: false });
  assert.equal(dry.code, 0, `an ordinary claim must plan cleanly: ${dry.stderr}`);
  assert.match(
    dry.stderr,
    /\n {4}would: git worktree remove \S*back\\clue\/\.worktrees\/9-release-ticket\n/,
    `the planned path must arrive verbatim and newline-terminated; got ${JSON.stringify(dry.stderr)}`,
  );
});

test("a lock on a SIBLING worktree is not this claim's lock", (t) => {
  // The lock probe reads the whole porcelain listing, so the per-entry `cur`
  // reset is the only thing standing between a sibling's `locked` line and this
  // claim. Every other lock fixture here registers exactly one worktree, which
  // exercises none of it: flipping the awk from "is THIS worktree locked" to
  // "is ANY worktree locked" passes all of them and fails only this one.
  //
  // The sibling is 99, and the number is load-bearing. `worktree list
  // --porcelain` orders entries LEXICOGRAPHICALLY, so a `10-other-claim` sorts
  // BEFORE `9-release-ticket` — and against that order the mutation that
  // matters most, a `cur` made sticky (`{if(...)cur=1}`, set but never reset),
  // passes: the sibling's `locked` line has already gone by before anything
  // sets the flag. Measured, 57/57 green on the sticky mutant with a `10-`
  // sibling. 99 sorts after, which is the order that exercises the reset.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const other = claim(r.w, 99, "other-claim");
  git(r.w, "worktree", "lock", other.wt, "--reason", "held by a review");

  const dry = release(r, c, { apply: false });
  assert.deepEqual(dry.json.blockers, [], "someone else's lock may not block this claim");
  assert.equal(dry.json.released, true);

  const { code, json } = release(r, c);
  assert.equal(code, 0);
  assert.deepEqual(json.blockers, []);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
  assert.deepEqual(
    artefacts(r, other),
    { dir: true, worktree: true, branch: true },
    "and the locked sibling is left exactly as it was",
  );
});

test("a dry run reports the release without performing it", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, json, stderr } = release(r, c, { apply: false });
  assert.deepEqual([json.released, json.applied, code], [true, false, 0]);
  assert.match(stderr, /DRY RUN/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true });
  assert.ok(!r.calls().some((l) => l.startsWith("issue edit")), `dry run must not write: ${r.calls()}`);
});

test("a mistyped slug refuses instead of dropping the label off a live claim", (t) => {
  const r = repo(t);
  claim(r.w, 9, "release-ticket");

  const res = spawnSync("sh", [SCRIPT, "9", "relase-tikcet", "fix", "--apply"], {
    cwd: r.w, env: r.env(), encoding: "utf8",
  });
  assert.equal(res.status, 2);
  assert.match(res.stderr, /check the <slug> and <type> arguments/);
  assert.deepEqual(r.calls(), [], "not even a read, let alone the label edit");
});

test("an already-dropped label still releases the worktree and branch", (t) => {
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, json } = release(r, c, { env: { GH_LABELS: "" } });
  assert.deepEqual([json.label, json.released, code], [false, true, 0]);
  assert.ok(!r.calls().some((l) => l.startsWith("issue edit")), "nothing to remove, so no write");
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
});

test("the script carries no escape hatch", () => {
  // `git worktree remove --force` discards uncommitted work and `git branch -D`
  // deletes commits that exist nowhere else — the two calls that make
  // commit-commands:clean_gone unusable here, and the two a future edit would
  // reach for the first time a precondition refuses.
  const src = readFileSync(fileURLToPath(new URL("./release-ticket.sh", import.meta.url)), "utf8")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(src, /--force/);
  assert.doesNotMatch(src, /branch\s+-D/);
});

test("usage errors exit 2", (t) => {
  const r = repo(t);
  // Assert the message, not just the code: a non-numeric issue falls through to
  // the mistyped-slug guard, which also exits 2, so deleting the numeric check
  // left this case green.
  const bad = (...a) => spawnSync("sh", [SCRIPT, ...a], { cwd: r.w, env: r.env(), encoding: "utf8" });
  assert.equal(bad("9").status, 2, "too few arguments");
  const nine = bad("nine", "slug", "fix");
  assert.equal(nine.status, 2);
  assert.match(nine.stderr, /issue must be a number/);
  // #121: all-digits is not a JSON number. A zero-padded `007` used to clear
  // the numeric check and reach all three payload printfs, each emitting
  // `{"issue":007,…}` — unparseable, at whatever exit the release earned. Two
  // widths, because one does not pin the guard: `0?*` narrowed to `0??*` still
  // refuses `007` and re-admits `01`, which is the same bug back.
  for (const p of ["007", "01"]) {
    const padded = bad(p, "slug", "fix");
    assert.equal(padded.status, 2, p);
    assert.match(padded.stderr, /issue must be a number/);
  }
});

test("a bare 0 clears the numeric guard", (t) => {
  // `0?*`, not `0*`: #121 lists `sh inflight.sh 0 -> parses` among its PASSING
  // cases, beside `42`. A bare `0` is a valid RFC 8259 number and `$((0))` is
  // `0`, so neither hazard the guard exists to close applies to it. Widening
  // the arm would refuse a value the ticket's own worked example shows working.
  const r = repo(t);
  const zero = spawnSync("sh", [SCRIPT, "0", "slug", "fix"], { cwd: r.w, env: r.env(), encoding: "utf8" });
  assert.doesNotMatch(zero.stderr, /issue must be a number/);
  // Positive, not just the absence of one string: `0` has to reach the *next*
  // precondition, and `fix/0-slug` shows it arrived there as the issue number.
  assert.match(zero.stderr, /no branch fix\/0-slug/);
});

test("a chatty but successful gh does not fake an already-dropped label", (t) => {
  // The label was read with 2>&1 and substring-matched, so gh's own upgrade
  // notice on a SUCCESSFUL call broke the match: the script deleted the worktree
  // and branch and left in-progress on the ticket — invisible to candidates.mjs
  // with no artefact left to explain it, and exit 0 identical to a real release.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, json } = release(r, c, {
    env: { GH_STDERR: "A new release of gh is available: 2.62.0 → 2.63.2" },
  });
  assert.equal(json.label, true, "the label is there and must be reported as there");
  assert.equal(code, 0);
  assert.ok(
    r.calls().includes("issue edit 9 --remove-label in-progress"),
    `the label must actually be dropped: ${r.calls()}`,
  );
});

test("a refused worktree removal leaves the label on the issue", (t) => {
  // The two local deletes run before the label edit, so a refusal — which is the
  // dirty check recomputed by git at delete time — leaves the claim exactly as
  // it was. Dropping the label first made every such refusal leave the ticket
  // reading free while re-claiming failed on the branch that was still there.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  // Clean at check time, dirty by delete time: the stub runs in between.
  const { code, json, stderr } = release(r, c, { env: { GH_DIRTY: join(c.wt, "late.txt") } });

  assert.equal(code, 2);
  // This script's own prose, not git's refusal text, which is git's to reword.
  assert.match(stderr, /#9 HALTED mid-release — nothing landed: git worktree remove refused/);
  assert.equal(json.released, false, "a receipt is still printed — die used to exit before any printf");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
  assert.ok(
    !r.calls().some((l) => l.startsWith("issue edit")),
    `in-progress must survive so the ticket keeps reading as taken: ${r.calls()}`,
  );
});

test("a tracker that fails after both deletes still emits a receipt", (t) => {
  // The label edit runs last, so it is the one failure that ends with both
  // artefacts gone and in-progress still on the ticket — the single state a
  // caller cannot reconstruct by looking, and the one it must not guess at.
  // `die` printed prose and exited before every printf, so stdout was empty
  // exactly there. Of the other two halt() sites, the worktree removal is
  // reached with nothing deleted and `git branch -d` with the worktree already
  // gone — which is why this one is the only PARTIALLY RELEASED naming both.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  const { code, json, stderr } = release(r, c, { env: { GH_EDIT_RC: "1" } });
  assert.equal(code, 2);
  assert.notEqual(json, null, "a receipt is still printed — die exited before any printf");
  assert.equal(json.released, false);
  assert.equal(json.applied, true, "the mutations were attempted, unlike a blocked run");
  assert.equal(json.label, true, "in-progress survives, so the ticket keeps reading as taken");
  assert.match(stderr, /PARTIALLY RELEASED/);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false }, "both deletes landed");
});

test("the halt headline names what landed: nothing at all, or a partial release", (t) => {
  // Both forms against a git that refuses on command, so the two receipts are
  // deterministic to the byte and can be asserted whole: the headline is
  // operator-facing prose and the payload may not move with it. A refusal
  // provoked by a real dirty worktree quotes git's own message instead, which
  // is git's to reword.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  gitShim(r, `case "$1 $2" in "\${GIT_FAIL:-}") echo 'refused by the git shim' >&2; exit 1 ;; esac`);
  // The worktree path the SCRIPT reports, never the one node built: git resolves
  // symlinks, so the /var tmpdir node is handed comes back as /private/var
  // (measured, macOS). A dry run reads the same `wt` the halt receipt prints and
  // mutates nothing.
  const wt = release(r, c, { apply: false }).json.worktree;
  const receipt = (blocker) =>
    `{"issue":9,"branch":"fix/9-release-ticket","branchRewritten":false,"worktree":"${wt}","worktreeRewritten":false,` +
    `"label":true,"released":false,"applied":true,"blockers":["${blocker}"]}\n`;

  // The worktree removal is the first mutation attempted when there is a
  // worktree, so its refusal leaves zero of the three artefacts touched.
  const none = release(r, c, { env: { GIT_FAIL: "worktree remove" } });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /#9 HALTED mid-release — nothing landed: git worktree remove refused/);
  assert.doesNotMatch(none.stderr, /PARTIALLY/, "no part of the release landed, so none was released");
  // The measured outcome, not the exit code: the shim refuses before real git
  // runs, so the registration and the directory really are both still there and
  // `Unreleased` is what the probe finds. The half that is a call log still
  // reads as one — the line is deliberately uneven, because `git branch -d`
  // lands atomically and `git worktree remove` does not.
  assert.ok(
    none.stderr.includes(`worktree ${wt} is Unreleased — registration and directory both still present`),
    `the detail line must name the measured state: ${none.stderr}`,
  );
  assert.match(none.stderr, /branch deleted: false, in-progress: still on the issue/, "and the branch half stays a boolean");
  assert.doesNotMatch(none.stderr, /worktree removed:/, "the worktree half is no longer a boolean");
  assert.equal(
    none.out,
    receipt(
      `git worktree remove refused ${wt}: refused by the git shim` +
        ` — worktree ${wt} is Unreleased — registration and directory both still present`,
    ),
    "and the receipt carries the outcome in the blocker, the one field a caller without stderr can read",
  );
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "and that headline is the truth");

  // One artefact gone and the next refused — one of the two shapes a partial
  // release takes, the other being both deletes landing and the label edit
  // refusing, pinned by the tracker case above. Runs second on purpose: it
  // consumes the worktree the case above left standing. Keyed on what landed
  // and not on the call site, since this same `git branch -d` refusal is
  // reached with nothing removed on a claim that has no worktree.
  const partial = release(r, c, { env: { GIT_FAIL: "branch -d" } });
  assert.equal(partial.code, 2);
  assert.match(partial.stderr, /#9 PARTIALLY RELEASED — git branch -d refused/);
  assert.ok(
    partial.stderr.includes(`worktree ${wt} is Released — registration and directory both gone`),
    `a removal that returned 0 really did both deletes: ${partial.stderr}`,
  );
  assert.match(partial.stderr, /branch deleted: false, in-progress: still on the issue/, "the detail line agrees");
  assert.equal(
    partial.out,
    receipt(
      "git branch -d refused fix/9-release-ticket: refused by the git shim" +
        ` — worktree ${wt} is Released — registration and directory both gone`,
    ),
  );
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: true }, "the removal really did land");
});

test("the headline is keyed on what landed, not on which call site halted", (t) => {
  // The two cases above leave the design's central claim unpinned: both reach
  // `git worktree remove` first, so keying the headline on the CALL SITE passes
  // them. A claim whose worktree was removed by hand separates the two — the
  // removal is skipped entirely, so `git branch -d` halts with nothing landed,
  // and the branch delete then halts with a branch gone and no worktree ever
  // touched. Without this the (false, true) row of the table is unreachable
  // too, and dropping `done_branch` from the condition survives the suite.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  gitShim(r, `case "$1 $2" in "\${GIT_FAIL:-}") echo 'refused by the git shim' >&2; exit 1 ;; esac`);
  // By hand, with real git: the registration goes, the branch stays.
  execFileSync("git", ["worktree", "remove", c.wt], { cwd: r.w, env: ENV });

  // Call site says "the branch delete refused"; what landed says nothing did.
  const none = release(r, c, { env: { GIT_FAIL: "branch -d" } });
  assert.equal(none.code, 2);
  assert.match(none.stderr, /#9 HALTED mid-release — nothing landed: git branch -d refused/);
  assert.doesNotMatch(none.stderr, /PARTIALLY/, "the same call site as the partial case above, and nothing landed");
  assert.match(none.stderr, /branch deleted: false, in-progress: still on the issue/, "the detail line agrees");
  // No worktree line at all. `Unreleased` means registration and directory both
  // still present, and this claim has no worktree of ours to say that about —
  // the starting value may not be reported as a measurement that was taken.
  assert.doesNotMatch(none.stderr, /is Unreleased/, "no state is asserted about a worktree that is not there");
  assert.equal(
    none.out,
    '{"issue":9,"branch":"fix/9-release-ticket","branchRewritten":false,"worktree":"","worktreeRewritten":false,"label":true,' +
      '"released":false,"applied":true,"blockers":["git branch -d refused fix/9-release-ticket: ' +
      'refused by the git shim"]}\n',
    "an empty worktree field, and the receipt still whole",
  );

  // Branch gone, worktree never ours to remove: the (false, true) row.
  const partial = release(r, c, { env: { GH_EDIT_RC: "1" } });
  assert.equal(partial.code, 2);
  assert.match(partial.stderr, /#9 PARTIALLY RELEASED — could not drop in-progress from issue 9/);
  assert.match(partial.stderr, /branch deleted: true, in-progress: still on the issue/, "the detail line agrees");
  assert.doesNotMatch(partial.stderr, /is Unreleased/, "still no worktree of ours to report a state for");
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false }, "the branch really did go");
});

test("a removal that cleared the registration is a partial release, never `nothing landed`", (t) => {
  // #208 itself. `git worktree remove` deletes the registration BEFORE the
  // directory and does not put it back when that delete fails, so its exit code
  // answers for neither — and `done_wt=false` was rendered as the headline
  // `nothing landed`, a positive assertion that is false here.
  //
  // The symlink trigger, not `chmod`: it reproduces as any user, needs no
  // permission bits, and has no root-vacuity hole. The second reachable shape is
  // a subdirectory left at mode 555 mid-delete, which fails the same way (rc 255
  // with the registration already cleared, measured on git 2.50.1); it is named
  // here rather than built, because a mode-based fixture goes vacuous under
  // euid 0 (#184).
  //
  // Swapped in during the gh round trip, since the precondition that refuses a
  // non-directory worktree runs first and would otherwise block this before any
  // mutation — which is the check-then-act window, not a contrivance.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const wt = release(r, c, { apply: false }).json.worktree;

  const { code, json, stderr } = release(r, c, { env: { GH_SYMLINK: wt } });

  // The fixture reached the state this test is named for, measured on the
  // repo rather than assumed from the prose the script printed.
  assert.equal(
    git(r.w, "worktree", "list", "--porcelain").includes(`worktree ${wt}\n`),
    false,
    "fixture: git must really have cleared the registration",
  );
  assert.ok(lstatSync(wt).isSymbolicLink(), "fixture: and really have left the path occupied");

  assert.equal(code, 2);
  assert.match(stderr, /#9 PARTIALLY RELEASED — git worktree remove refused/);
  assert.doesNotMatch(stderr, /nothing landed/, "the registration landed, so that headline is false");
  assert.ok(
    stderr.includes(`worktree ${wt} is Deregistered — the registration is cleared, the directory is still on disk`),
    `the detail line must name the measured state: ${stderr}`,
  );
  assert.equal(json.released, false);
  assert.match(json.blockers[0], /is Deregistered/, "and the receipt carries it where a caller without stderr can read it");
  assert.equal(json.label, true, "in-progress survives, so the ticket keeps reading as taken");
});

test("the run after a Deregistered halt refuses instead of releasing over the directory", (t) => {
  // The knock-on, end to end and through the real route rather than a
  // hand-built registry: run one halts with the registration cleared, and run
  // two used to find no `wt` and no `stray` — `stray` is awk over git's
  // registry, so an Orphaned worktree directory is invisible to it BY
  // CONSTRUCTION — delete the branch, drop the label, and exit 0 with
  // `"released":true,"blockers":[]` over a directory still on disk. The next
  // claim-ticket.sh for the slug then died on it with nothing left to explain
  // why.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const wt = release(r, c, { apply: false }).json.worktree;
  assert.equal(release(r, c, { env: { GH_SYMLINK: wt } }).code, 2, "fixture: run one halts");

  const { code, json, stderr } = release(r, c);

  assert.equal(code, 1, "blocked, not released");
  assert.equal(json.released, false);
  assert.equal(json.blockers.length, 1, `only the orphan can fire — nothing is committed or pushed: ${json.blockers}`);
  assert.match(json.blockers[0], /has no registration/);
  assert.match(stderr, /#9 NOT released — nothing was touched/);
  assert.deepEqual(
    { dir: existsSync(wt), branch: artefacts(r, c).branch },
    { dir: true, branch: true },
    "the branch may not be deleted out from under a directory that is still there",
  );
  assert.ok(
    !r.calls().some((l) => l.startsWith("issue edit")),
    `and in-progress must stay on the ticket: ${r.calls()}`,
  );
});

test("an orphaned worktree directory names a manual removal, never a prune that cannot work", (t) => {
  // `git worktree prune` clears registrations, and the defining property of
  // this state is that there is no registration left to clear — so naming it
  // hands the operator a command that changes nothing and every later run
  // blocks identically: the permanent refusal this script exists to clear. The
  // mirror-image case one guard up has the opposite answer for the same reason.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "precious.txt"), "work that exists nowhere else\n");
  orphan(r, c);

  const { code, json } = release(r, c);

  assert.equal(code, 1);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed: ${json.blockers}`);
  assert.doesNotMatch(json.blockers[0], /prune/, "there is no registration left for a prune to clear");
  assert.match(json.blockers[0], /remove the directory by hand/);
  assert.match(json.blockers[0], new RegExp(`${c.wt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|9-release-ticket`));
  assert.equal(
    readFileSync(join(c.wt, "precious.txt"), "utf8"),
    "work that exists nowhere else\n",
    "and nothing is deleted automatically — the contents were never inspected",
  );
  assert.equal(artefacts(r, c).branch, true, "the branch survives a blocked run");
});

test("the dry run and --apply report an orphaned directory identically", (t) => {
  // The check lives in the precondition block, not the mutation path, so the
  // dry run predicts it for free. Placed below, it would report only under
  // --apply and rebuild the dry/apply asymmetry class #86, #385 and #386 were
  // filed against — this case is what would fail if only one path saw it.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  orphan(r, c);

  const dry = release(r, c, { apply: false });
  const applied = release(r, c);

  assert.deepEqual(dry.json.blockers, applied.json.blockers, "the same blocker, word for word");
  assert.equal(dry.code, applied.code);
  assert.equal(dry.code, 1);
  // `applied` is the only field that may differ: it reports which mode ran, not
  // what was found. Everything else about a blocked run is the same verdict.
  assert.equal(dry.json.applied, false);
  assert.equal(applied.json.applied, true);
  assert.deepEqual({ ...dry.json, applied: null }, { ...applied.json, applied: null });
  assert.equal(existsSync(c.wt), true, "and --apply removed nothing either");
});

test("a clean claim is not mistaken for an orphaned directory", (t) => {
  // The other half of the new precondition: it must not refuse a state that is
  // fine. A healthy claim's worktree sits at exactly the path the orphan probe
  // reconstructs, so a probe that asked the filesystem WITHOUT first asking
  // whether anything registered owns that path would block every release.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  assert.equal(c.wt, join(r.w, ".worktrees", "9-release-ticket"), "fixture: the same path the probe builds");

  const { code, json } = release(r, c);

  assert.deepEqual(json.blockers, [], "a registered directory is owned by the guards above, not this one");
  assert.equal(json.released, true);
  assert.equal(code, 0);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
});

test("the orphan probe is anchored at the checkout, never at the caller's cwd", (t) => {
  // Every other case in this file runs the script from the checkout root, where
  // $PWD and git's own listing agree — so the anchor is unpinned there and a
  // `main_wt=$PWD` regression stays green across the whole suite. This is the
  // caller the script actually has: run-team releases a ticket from wherever the
  // operator stands, routinely inside another member's worktree, where a
  // cwd-relative ".worktrees/..." names nothing and the orphan goes unseen.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const elsewhere = claim(r.w, 10, "other-member");
  orphan(r, c);

  const { code, json } = release(r, c, { cwd: elsewhere.wt });

  assert.equal(code, 1, `blocked from a foreign cwd too: ${JSON.stringify(json)}`);
  assert.match(json.blockers[0], /has no registration/);
  assert.match(json.blockers[0], /9-release-ticket/);
  assert.equal(existsSync(c.wt), true, "and the orphan is still there to be inspected");
});

test("a worktree directory the script may not stat is unknown, never a release", (t) => {
  if (EUID0) return t.skip(NO_DENIAL);
  // -e is false for a directory that is not there and for one inside a prefix
  // we may not search, and only the first is an absence. Collapsed, an
  // unsearchable `.worktrees` reads as "no orphan" and the run releases the
  // claim — branch deleted, label dropped, exit 0 — over a directory that may
  // be sitting right there. `gone` is what establishes the absence instead.
  //
  // `chmod` is unavoidable here, unlike the Deregistered fixture above: being
  // unable to stat the path IS the condition under test, and no permission-free
  // shape produces it. Restored before the first assert like its neighbours,
  // though unlike them this case does not need it: it asserts `branch` alone,
  // which `for-each-ref` answers without searching `.worktrees` (measured —
  // dropping this line leaves this case green while four neighbours go red).
  // #184 owns the residual euid-0 vacuity this shares with them.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  execFileSync("git", ["worktree", "remove", c.wt], { cwd: r.w, env: ENV });
  const parent = join(r.w, ".worktrees");

  chmodSync(parent, 0o000);
  const { code, json } = release(r, c);
  chmodSync(parent, 0o755);

  assert.equal(code, 1);
  assert.equal(json.blockers.length, 1, `nothing is committed or pushed: ${json.blockers}`);
  assert.match(json.blockers[0], /cannot tell whether an orphaned worktree directory/);
  assert.equal(artefacts(r, c).branch, true, "an unknown answer may not delete the branch");
});

test("a removal whose effect cannot be measured asserts neither headline", (t) => {
  // Indeterminate: the probe could not establish which state holds, so the run
  // says so. `nothing landed` would be #208 with a different trigger, and a
  // partial release would invent an effect nothing measured.
  //
  // The listing is how the registration is read, so a listing git cannot
  // produce leaves it unknown. Failing it from the SECOND call on is what
  // isolates the re-measurement: the script's own first call, at the top, has
  // to succeed or the run dies long before any mutation.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const seen = join(r.w, "..", "list.count");
  gitShim(
    r,
    `case "$1 $2" in
  "worktree list")
    n=$(cat "${seen}" 2>/dev/null || echo 0)
    n=$((n + 1)); echo "$n" > "${seen}"
    [ "$n" -le 1 ] || { echo 'listing refused by the git shim' >&2; exit 1; } ;;
  "worktree remove") echo 'refused by the git shim' >&2; exit 1 ;;
esac`,
  );

  const { code, json, stderr } = release(r, c);

  assert.equal(code, 2);
  assert.match(stderr, /#9 HALTED mid-release — what landed could not be measured/);
  assert.doesNotMatch(stderr, /nothing landed/, "nothing established that nothing landed");
  assert.doesNotMatch(stderr, /PARTIALLY/, "and nothing established that anything did");
  assert.match(stderr, /is Indeterminate — what the removal landed could not be measured/);
  assert.match(json.blockers[0], /is Indeterminate/);
});

test("a successful release survives a failing `git worktree prune`", (t) => {
  // prune ran unchecked as the last statement under `set -e`, so its failure
  // exited 1 — this script's code for "NOT released, nothing was touched" — out
  // of a release that had already dropped the label and deleted both artefacts.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  // A `git` shim on PATH that fails only on prune, and defers everything else.
  gitShim(r, `[ "$1" = worktree ] && [ "$2" = prune ] && exit 3`);
  // Alone among the shimmed cases, this one's assertions are satisfied by a
  // shim that does NOTHING: a git that never refuses prune releases cleanly,
  // which is what the case below expects. So the shim is pinned directly, in
  // both directions — a `gitShim` that dropped `body` would empty this case
  // rather than fail it, and the refusal it exists to survive would go untested
  // while the suite stayed green. `cwd` pins both probes to the fixture: on
  // the failure path the body stops matching and `exec` reaches real git,
  // which would then prune whatever repo the runner happens to stand in.
  const shim = join(r.w, "..", "bin", "git");
  assert.equal(spawnSync(shim, ["worktree", "prune"], { cwd: r.w }).status, 3, "the body really does refuse prune");
  assert.equal(spawnSync(shim, ["--version"], { cwd: r.w }).status, 0, "and everything else really does reach real git");

  const { code, json } = release(r, c);
  assert.equal(code, 0, "the release succeeded; prune is housekeeping");
  assert.equal(json.released, true);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
});

test("BASE_REF must be a remote-tracking ref", (t) => {
  // The fleet harness is exactly the caller that sets it. Pointed at the claim's
  // own branch, ahead is 0 and cherry is empty on a branch carrying unpushed
  // work, so both commit guards pass and the release proceeds.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  commit(c.wt, "unpushed work", "work\n");

  const { code, json, stderr } = release(r, c, { env: { BASE_REF: `refs/heads/${c.branch}` } });
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /BASE_REF must be a remote-tracking ref/);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be deleted");
});

test("a mistyped --apply is refused, never silently downgraded to a dry run", (t) => {
  // `--aply` matched nothing, so the run reported "released":true having deleted
  // nothing. A caller keying on that field marks the claim released while every
  // artefact survives: the silent queue shrink this script exists to undo.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");

  for (const arg of ["--aply", "--apply=true", "-n"]) {
    const res = spawnSync("sh", [SCRIPT, ...c.args, arg], { cwd: r.w, env: r.env(), encoding: "utf8" });
    assert.equal(res.status, 2, `${arg} must be refused`);
    assert.match(res.stderr, /unknown argument/);
    assert.equal(res.stdout.trim(), "", `${arg} must not report a release: ${res.stdout}`);
  }
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true });
});

test("an unreadable worktree is an unknown answer, never a clean one", (t) => {
  // A worktree whose .git file points nowhere: the directory is there, still
  // registered and still on the branch, and its status cannot be read.
  // Swallowed, that reads as no uncommitted changes and the release proceeds.
  // The directory has to still exist for this to be the unknown case — a gone
  // one is answerable, and "a worktree directory deleted by hand releases
  // instead of blocking forever" is what proves it. Named, not "the case
  // below": the .git-is-gone case now sits between the two and asserts the
  // opposite, so a positional reference here points at the wrong test.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, ".git"), `gitdir: ${join(r.w, ".git", "worktrees", "nope")}\n`);

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2);
  assert.equal(json, null);
  assert.match(stderr, /whether it holds uncommitted work is unknown/);
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("a worktree whose .git file is gone is unknown, never clean", (t) => {
  // Disjoint from both cases around it: the directory EXISTS, so -d is true, and
  // the .git file is not broken but absent — so `git -C` does not fail either. It
  // walks UP and reports the PARENT repository at rc 0, and the guard that exists
  // to answer "does THIS worktree hold uncommitted work?" answers about a
  // different repo. With `.worktrees/` gitignored — the fleet's own layout — the
  // worktree never appears in that parent status, so a clean parent makes the
  // leaked answer EMPTY: a positive assertion of clean, produced without ever
  // having looked at the worktree.
  const r = repo(t);
  writeFileSync(join(r.w, ".gitignore"), ".worktrees/\n");
  git(r.w, "add", ".gitignore");
  git(r.w, "commit", "-q", "-m", "ignore the worktrees dir");
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "precious.txt"), "work that exists nowhere else\n");
  rmSync(join(c.wt, ".git"));
  assert.equal(git(r.w, "status", "--porcelain"), "", "fixture: the leaked answer really is an empty one");

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2);
  // `git worktree remove` refuses this on its own, so a run that believed the
  // leaked answer still reaches exit 2 — by `halt`, announcing nothing landed
  // and having asked the tracker. Pinning the die is what separates the guard
  // being right from a second, unrelated guard catching it downstream.
  assert.equal(json, null, "refused before any mutation, not halted after the delete refused");
  // The whole message, not the shared tail: all three dies end in "whether it
  // holds uncommitted work is unknown", so the tail alone cannot tell the new
  // guard firing from the status die firing — which is the distinction the
  // comment above claims this case makes.
  assert.match(stderr, /has no \.git file, so whether it holds uncommitted work is unknown/);
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be touched");
  assert.equal(readFileSync(join(c.wt, "precious.txt"), "utf8"), "work that exists nowhere else\n");
});

test("a worktree directory deleted by hand releases instead of blocking forever", (t) => {
  // `worktree list --porcelain` keeps listing an entry whose directory is gone
  // (it marks it `prunable`), so the dirty check ran `git -C` against a path
  // that is not there and died at exit 2 — every run, permanently, leaving the
  // label and the branch behind for the in-flight probe to keep reading as
  // taken. That is the state this script exists to clear.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  rmSync(c.wt, { recursive: true, force: true });

  const { code, json } = release(r, c);
  assert.equal(code, 0, "a directory that does not exist holds no work to protect");
  assert.deepEqual(json.blockers, []);
  assert.equal(json.released, true);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false }, "including the stale entry");
  assert.ok(
    r.calls().includes("issue edit 9 --remove-label in-progress"),
    `the label is what had to come off: ${r.calls()}`,
  );
});

test("a worktree deleted by hand while its branch carries work still blocks", (t) => {
  // The gone directory is the only thing the case above makes answerable. Every
  // other refusal is measured on the branch ref or on the worktree LIST, never
  // on the directory, and none of them may weaken because it went missing.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  commit(c.wt, "work", "work that exists nowhere else\n");
  rmSync(c.wt, { recursive: true, force: true });

  const { code, json } = release(r, c);
  assert.equal(code, 1);
  assert.match(json.blockers.join(" "), /1 commit\(s\) ahead/);
  assert.deepEqual(
    artefacts(r, c),
    { dir: false, worktree: true, branch: true },
    "the branch, and the commit on it, survive",
  );
});

test("a worktree whose .git is a directory is unknown, never clean", (t) => {
  // Same leak as the absent .git, reached by a different input and missed by the
  // obvious predicate: `-e` is TRUE for a .git DIRECTORY, so an existence test
  // waves it through, git walks UP exactly as it does for an absent one, and the
  // parent's status is believed at rc 0. Only `-f` separates them, and it costs
  // nothing — `git worktree add` always writes .git as a regular file, so no
  // healthy linked worktree is refused by it.
  //
  // Left to `worktree remove` this ends the way the absent case does: a `halt`
  // exit 2 announcing nothing landed, after the tracker was already asked.
  const r = repo(t);
  writeFileSync(join(r.w, ".gitignore"), ".worktrees/\n");
  git(r.w, "add", ".gitignore");
  git(r.w, "commit", "-q", "-m", "ignore the worktrees dir");
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "precious.txt"), "work that exists nowhere else\n");
  rmSync(join(c.wt, ".git"));
  mkdirSync(join(c.wt, ".git"));
  assert.equal(git(r.w, "status", "--porcelain"), "", "fixture: the leaked answer really is an empty one");

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2);
  assert.equal(json, null, "refused before any mutation");
  assert.match(stderr, /has no \.git file, so whether it holds uncommitted work is unknown/);
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
  assert.equal(readFileSync(join(c.wt, "precious.txt"), "utf8"), "work that exists nowhere else\n");
});

test("an unsearchable worktree is not reported as having no .git", (t) => {
  if (EUID0) return t.skip(NO_DENIAL);
  // The .git-linkage guard tests `-e "$wt/.git"`, and -e is false for two
  // different reasons: the file is absent, or $wt is not searchable so the entry
  // cannot be stat'ed at all. Only the first is an absence. Without the `! -x`
  // clause the guard fires here and announces "has no .git" about a worktree
  // whose .git is sitting right there — the same inference from a failed stat
  // that the block above the guard exists to forbid, and it costs git's own
  // "Permission denied" on the way out, since git never runs.
  //
  // 0o644 and not 0o000: the directory must stay stat-able from its parent so
  // that -d is true and the run reaches the linkage guard at all. Only the
  // search bit is dropped, which is exactly what makes -e answer false.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "precious.txt"), "work that exists nowhere else\n");

  chmodSync(c.wt, 0o644);
  const { code, json, stderr } = release(r, c);
  // Restored before the first assert, for the reason "a worktree the script may
  // not look at is unknown, never a release" gives: the `precious.txt` read
  // below is inside this directory and needs the search bit back.
  chmodSync(c.wt, 0o755);

  assert.equal(code, 2);
  assert.equal(json, null);
  // The negative is the whole point, so it is pinned even though "a worktree the
  // script may not look at is unknown, never a release" deliberately declines to
  // pin wording on a permission path: refusing is not in question here — both
  // versions refuse — and the only thing separating this fix from the bug it
  // replaces is WHICH refusal it is.
  assert.doesNotMatch(stderr, /has no \.git/, "never an absence nothing established");
  // The positive half. Excluding one wrong wording left every OTHER wrong
  // wording green: the linkage block below the guard was added ungated, so
  // `cd "$wt"` fired first and this path died with "cannot resolve $wt" — the
  // script's own invention — while the assert above still passed. Pinning WHICH
  // die fires is what makes the `-f` gate on that block load-bearing, and it is
  // the only assertion that fails if the gate is removed again.
  assert.match(stderr, /cannot read the status of/, "git's own denial, not one this script invented");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
  assert.equal(readFileSync(join(c.wt, "precious.txt"), "utf8"), "work that exists nowhere else\n");
});

test("a worktree the script may not look at is unknown, never a release", (t) => {
  if (EUID0) return t.skip(NO_DENIAL);
  // -d is false for a directory we are not permitted to stat as surely as for
  // one that is gone, and git cannot separate them either: it marks both
  // `prunable` and `worktree remove` ACCEPTS a prunable entry, so the delete
  // cannot recompute what this guard gets wrong. Read as "gone", this released
  // the claim outright — branch deleted, label dropped, exit 0 — with the
  // member's uncommitted work still sitting on disk, unregistered and with no
  // branch left pointing at it.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "precious.txt"), "work that exists nowhere else\n");
  const parent = join(r.w, ".worktrees");

  chmodSync(parent, 0o000);
  const { code } = release(r, c);
  // Restored before the first assert, or `artefacts`'s `existsSync(c.wt)` reads
  // through a directory it still may not search, and "nothing may be touched"
  // fails over work that is sitting right there (measured).
  chmodSync(parent, 0o755);

  // The property, not this script's wording for it: the pre-fix code refused
  // here too, by a different route, and a case that pins the message would
  // call that safe version broken.
  assert.equal(code, 2);
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be touched");
  assert.equal(readFileSync(join(c.wt, "precious.txt"), "utf8"), "work that exists nowhere else\n");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("the whole .worktrees directory deleted by hand still releases", (t) => {
  // `rm -rf .worktrees` is how this usually happens, and it takes the parent
  // along with the child. Establishing absence one level up finds no parent
  // either and calls that unknown — which puts the case above straight back on
  // the permanent exit 2 this script was fixed to stop producing.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  rmSync(join(r.w, ".worktrees"), { recursive: true, force: true });

  const { code, json } = release(r, c);
  assert.equal(code, 0, "the parent going too does not make the child unanswerable");
  assert.deepEqual(json.blockers, []);
  assert.equal(json.released, true);
});

test("a worktree with no surviving ancestor below / still releases, never a permanent refusal (#178)", (t) => {
  // One rung past the case above: there the parent went too and the walk found
  // the repo root; here nothing below `/` survives at all. The walk ended on ""
  // rather than `/`, so `[ -x "" ]` was false, `gone` answered unknown, and this
  // guard died — "cannot tell whether ... exists", exit 2, forever, with the
  // label and the branch standing and the in-flight probe still reading the
  // ticket as taken. `/` is searchable and the path is provably absent, so
  // there is nothing here to protect and nothing to be unsure about.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const dest = relocate(r.w, c.wt, "/nonexistent-top-level-178/wt");

  const { code, json, stderr } = release(r, c);
  // The guard's own marker, not just the exit code: a later refusal would
  // reproduce exit 2 with no JSON just as well, and asserting the pair alone
  // would pass with this guard still dying.
  assert.doesNotMatch(stderr, /cannot tell whether/, "an absent path with a searchable root is not an unknown one");
  assert.equal(code, 0);
  assert.deepEqual(json.blockers, []);
  assert.equal(json.released, true);
  assert.equal(json.worktree, dest, "the payload names the path git listed, not the one claim-ticket.sh would have written");
  // Reaching the delete is the half exit 0 alone does not prove. The guard
  // died BEFORE it, so a fix that merely downgraded that `die` to a warning
  // would exit 0 here too, with the stale registration still standing and the
  // claim reported released — the same false success from the other side.
  assert.doesNotMatch(
    git(r.w, "worktree", "list", "--porcelain"),
    /nonexistent-top-level-178/,
    "the registration must actually be gone, not merely un-refused",
  );
});

test("an unreadable worktree registry is unknown, never a release", (t) => {
  if (EUID0) return t.skip(NO_DENIAL);
  // `.git/worktrees` is a different directory from `.worktrees` above — git's
  // own admin dir, one subdir per linked worktree, which `worktree list
  // --porcelain` reads to produce its listing. Unreadable, git does not error:
  // it drops every entry it cannot read and still exits 0 (verified, git
  // 2.50.1), so `wt` and `stray` both come back empty for a claim that plainly
  // has one — the exact fail-open #84 exists to close.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const wtroot = join(r.w, ".git", "worktrees");

  // 0o000 is the realistic fault. 0o400 is what tells the guard's `&&` from an
  // `||`: read-without-execute satisfies one half, and under `||` the guard
  // would pass — 0o000 alone zeroes both bits at once and cannot distinguish
  // them. The count check downstream does not cover this: with the registry
  // unreadable its glob finds nothing, so zero-on-disk AGREES with the empty
  // listing git returns for the same reason, and only this guard is left.
  for (const mode of [0o000, 0o400]) {
    chmodSync(wtroot, mode);
    const { code, json, stderr } = release(r, c);
    // Restored before the first assert — `artefacts` below runs `worktree list`
    // itself, and would read this claim's worktree as absent while the registry
    // is still unreadable.
    chmodSync(wtroot, 0o755);

    const at = `mode 0o${mode.toString(8).padStart(3, "0")}`;
    assert.equal(code, 2, at);
    assert.equal(json, null, `refused before any mutation, ${at}`);
    assert.match(stderr, /worktree registry .* could not be read/, at);
    assert.deepEqual(r.calls(), [], `and the tracker is never asked, ${at}`);
    assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, `nothing may be touched, ${at}`);
  }
});

test("an entry git cannot read INSIDE is unknown too, not just an unreadable entry", (t) => {
  if (EUID0) return t.skip(NO_DENIAL);
  // #84 itself, and the case a permission test on the entry cannot reach:
  // naming an entry needs read+execute on the PARENT only, so this claim's
  // entry directory stays readable, executable and `ls`-able while the
  // `gitdir` file git opens inside it does not. `worktree list --porcelain`
  // drops the worktree and still exits 0 (verified, git 2.50.1) — so `wt` and
  // `stray` come back empty for a claim that has one, the branch is deleted as
  // unclaimed, and the member's uncommitted work is orphaned on disk.
  //
  // Which file git needs is git's business and changes between versions, so
  // the check does not guess: it counts entries on disk against the listing.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const gitdir = join(r.w, ".git", "worktrees", `9-release-ticket`, "gitdir");

  chmodSync(gitdir, 0o000);
  const { code, json, stderr } = release(r, c);
  // Restored before the first assert — `artefacts` below runs `worktree list`
  // itself, and would read this claim's own worktree as absent while git still
  // cannot open the file.
  chmodSync(gitdir, 0o644);

  assert.equal(code, 2);
  assert.equal(json, null, "refused before any mutation");
  assert.match(stderr, /git listed 0 worktrees for 1 registry entries/);
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be touched");
});

test("the euid-0 guard does not fire on a normal run, and the modes it guards really deny (#184)", (t) => {
  // The guard above is by construction unreachable wherever this suite actually
  // runs, so a green suite says nothing about it. What a green suite CAN say is
  // the half that matters here: that the guard is not firing, and that the modes
  // the EUID0 fixtures chmod really do deny when it does not. A guard that
  // fired unconditionally would turn every one of them into a skip with nothing
  // failing — indistinguishable, in the summary, from that many tests passing.
  if (process.geteuid?.() === 0) return t.skip(NO_DENIAL);
  assert.equal(EUID0, false, "a guard that fires here voids every permission fixture in this file, silently");

  const dir = mkdtempSync(join(tmpdir(), "release-ticket-euid-"));
  t.after(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "f"), "x");
  const read = () => readFileSync(join(dir, "f"), "utf8");

  chmodSync(dir, 0o000);
  assert.throws(read, { code: "EACCES" }, "an 0o000 DIRECTORY must deny the search — the EUID0 fixtures that chmod a DIRECTORY 0o000 rest on it");
  // 0o400 and 0o644 both drop the search bit while leaving the read -- the
  // asymmetry 0o000 cannot express, because it zeroes both bits at once. Each
  // mode is here for its own fixture: 0o400 is what lets `an unreadable
  // worktree registry is unknown, never a release` tell its guard's `&&` from
  // an `||`, and 0o644 is what `an unsearchable worktree is not reported as
  // having no .git` chmods its worktree to, keeping the directory stat-able
  // from its parent while -e on the .git inside it answers false. No other
  // `chmodSync(..., 0o644)` in this file is a further consumer: every one of
  // them RESTORES a FILE after that fixture's own 0o000 denial, and a file has
  // no search bit to drop.
  for (const mode of [0o400, 0o644]) {
    const at = `mode 0o${mode.toString(8).padStart(3, "0")}`;
    chmodSync(dir, mode);
    assert.throws(read, { code: "EACCES" }, `the search must be denied, ${at}`);
    assert.deepEqual(readdirSync(dir), ["f"], `while the read is still granted, ${at}`);
  }

  // Every fixture that chmods a FILE 0o000 rests on this assert rather than the
  // one above: a file's denial is its own read, which is a different
  // precondition from the 0o000-DIRECTORY fixtures' denied search.
  chmodSync(dir, 0o755);
  chmodSync(join(dir, "f"), 0o000);
  assert.throws(read, { code: "EACCES" }, "an 0o000 FILE must deny its own read");
});

test("repo()'s teardown deletes a root a fixture left unsearchable (#184)", (t) => {
  if (EUID0) return t.skip(NO_DENIAL);
  // The shape this pins cannot be reproduced by letting a test body throw: when
  // the BODY throws first — `release()` on a malformed payload, the very case
  // the restore-before-delete exists for — node reports only that error and
  // drops the teardown's ENOTEMPTY on the floor (measured), so the leak is
  // silent and no assertion anywhere can see it. `repo()` reaches the runner
  // only through `t.after`, so a stand-in `t` collects that teardown and runs
  // it here, in the body, where its effect IS assertable. Without the
  // `chmod -R u+rwX`, the `rmSync` below throws and this case is the one that
  // goes red.
  const afters = [];
  const r = repo({ after: (fn) => afters.push(fn) });
  const root = dirname(r.w);
  // Belt and braces: the stand-in's teardown is what is under test, so it must
  // not also be this case's only cleanup.
  t.after(() => {
    spawnSync("chmod", ["-R", "u+rwX", root]);
    rmSync(root, { recursive: true, force: true });
  });

  chmodSync(join(r.w, ".git"), 0o000);
  for (const after of afters) after();
  assert.equal(existsSync(root), false, "the temp root must not survive an unrestored chmod");
});

test("something that is not a registry entry is not counted as a dropped worktree", (t) => {
  // The count above globs the registry directory, so it sees whatever is in
  // there — and anything that is not a directory is not a worktree
  // registration. Counted, it would outnumber the listing and refuse every
  // release of every ticket with an "incomplete listing" naming a file that
  // reads fine — until someone works out that `git worktree prune` deletes it.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(r.w, ".git", "worktrees", "stray-note"), "not a worktree\n");

  const { code, json } = release(r, c);
  assert.equal(code, 0);
  assert.deepEqual(json.blockers, []);
  assert.equal(json.released, true);
});

test("a stray DIRECTORY in the registry is not a worktree git failed to report (#395)", (t) => {
  // The case above covers a stray *file*, which the `-d` test skipped anyway —
  // which is exactly why the directory case shipped green. A stray *directory*
  // is the one that bites: git ignores it, a `-d`-only count sees it, and the
  // mismatch then turns EVERY release of every ticket in that repo into a hard
  // refusal until a human notices. One `mkdir` under `.git/worktrees` is all it
  // takes (measured, git 2.50.1: git lists 2, the bare `-d` count said 2
  // registered against 1 linked).
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  mkdirSync(join(r.w, ".git", "worktrees", "stray-dir"), { recursive: true });

  const { code, json } = release(r, c);
  assert.equal(code, 0);
  assert.deepEqual(json.blockers, []);
  assert.equal(json.released, true);
});

test("a registry entry git cannot even open is unknown, not a stray to skip (#395)", (t) => {
  if (EUID0) return t.skip(NO_DENIAL);
  // The other half of that skip, and why the skip reads `ls`'s STATUS rather
  // than only its output: an entry chmod'd 000 answers "empty" to precisely the
  // same `ls -A` test a stray directory does. But git DROPS this one (measured:
  // listed 1, so linked 0), so skipping it as "not git's" would make the count
  // agree and release a claim whose checkout is still on disk — the wrong
  // "free" this whole check exists to rule out, reintroduced one layer in.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const entry = join(r.w, ".git", "worktrees", "9-release-ticket");

  chmodSync(entry, 0o000);
  const { code, json, stderr } = release(r, c);
  // Restored before the first assert — `artefacts` below runs `worktree list`
  // itself and would otherwise read this claim's worktree as absent.
  chmodSync(entry, 0o755);

  assert.equal(code, 2, "a dropped entry is unanswerable, never the exit 0 that releases");
  assert.equal(json, null, "refused before any mutation");
  assert.match(stderr, /git listed 0 worktrees for 1 registry entries/);
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be touched");
});

test("an entry that is searchable but UNREADABLE is unknown too, not an empty stray (#395)", (t) => {
  if (EUID0) return t.skip(NO_DENIAL);
  // The half an `-x` test cannot reach, and the one that costs a member their
  // work: 0111 is searchable, so `-x` passes it, but it is not readable, so
  // `ls -A` fails EACCES and — its stderr discarded — prints exactly what an
  // empty stray `mkdir` prints. Skip on the OUTPUT alone and this entry is
  // waved through as "not git's"; git drops it too (the `gitdir` inside is
  // unreadable), the counts AGREE at 0, and no refusal fires. Both anomalies
  // together is what makes this the dangerous one — they cancel, where either
  // alone disagrees in the safe direction.
  //
  // What that costs then depends on where the checkout is, and this fixture
  // deliberately pins the CHEAP half: the checkout sits at its canonical path,
  // so the orphan probe reconstructs it and blocks at exit 1 — refused, but
  // naming an orphan instead of the entry nobody could read, and the ticket
  // stays stuck. The expensive half needs the checkout somewhere else, which
  // is one `git worktree move`: `wt` and `stray` are both read off git's
  // listing, the one thing the unreadable entry already blinded, and the
  // orphan probe reconstructs one path only. Measured at euid 501 with the
  // checkout moved (its directory name kept, so `stray` WOULD have matched had
  // git listed it): exit 0, `released:true`, `blockers:[]`, branch deleted,
  // `in-progress` dropped, member's uncommitted work still on disk. Both
  // halves are the same skip, so this case is what stands between it and a
  // merge — it was the only case here that caught it.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const entry = join(r.w, ".git", "worktrees", "9-release-ticket");
  const gitdir = join(entry, "gitdir");

  chmodSync(gitdir, 0o000);
  chmodSync(entry, 0o111);
  const { code, json, stderr } = release(r, c);
  // Restored innermost first, before the first assert — `artefacts` below runs
  // `worktree list` itself and would otherwise read this claim's worktree as
  // absent. 0111 keeps the entry searchable, so naming `gitdir` inside it
  // still resolves while the restore runs.
  chmodSync(gitdir, 0o644);
  chmodSync(entry, 0o755);

  assert.equal(code, 2, "an entry we could not read is unanswerable, never the exit 0 that releases");
  assert.equal(json, null, "refused before any mutation");
  assert.match(stderr, /git listed 0 worktrees for 1 registry entries/);
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be touched");
});

test("a registry entry whose gitdir is GONE is unknown, not a stray to skip (#395)", (t) => {
  // Why the skip tests EMPTINESS and not the absence of a `gitdir` file — the
  // discriminator #384 shipped first and then replaced, which this copy must
  // not inherit. Git drops an entry whose `gitdir` was deleted (measured:
  // listed 1, linked 0), so keying the skip on that file waves a corrupt entry
  // through as "not git's", the count agrees at 0, and the claim releases while
  // its checkout may still be on disk. An operator's stray `mkdir` is empty;
  // even a corrupt entry still holds git's own files — commondir, HEAD, index,
  // logs, refs — and that is the difference the count can see.
  //
  // No chmod, so no euid-0 guard: this case discriminates as root too.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  rmSync(join(r.w, ".git", "worktrees", "9-release-ticket", "gitdir"));

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2, "a dropped entry is unanswerable, never the exit 0 that releases");
  assert.equal(json, null, "refused before any mutation");
  assert.match(stderr, /git listed 0 worktrees for 1 registry entries/);
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("git listing MORE than the registry reports THAT, not an incomplete listing (#395)", (t) => {
  // The mismatch has two directions with opposite causes, and one message
  // cannot serve both. FEWER listed than registered is git dropping an entry it
  // could not read — the fault this check exists to catch. MORE listed than
  // registered is the reverse: the on-disk count is the stale read, a sibling
  // agent's `git worktree add` having landed between the two, which in a
  // parallel fleet is routine. Calling that "the listing is incomplete" sends
  // an operator hunting a permissions fault that is not there.
  //
  // Shimmed rather than raced: git derives its listing FROM the registry, so no
  // real interleaving produces this deterministically.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  gitShim(
    r,
    `if [ "$1" = worktree ] && [ "$2" = list ]; then
  '${REAL_GIT}' "$@" || exit $?
  printf 'worktree /nonexistent/landed-between-the-two-reads\\n\\n'
  exit 0
fi`,
  );

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2);
  assert.equal(json, null, "refused before any mutation");
  assert.match(stderr, /git listed 2 worktrees but only 1 registry entries were counted/);
  assert.match(stderr, /the registry read missed entries git can see/);
  assert.doesNotMatch(stderr, /the listing is incomplete/,
    "the opposite direction's cause must not be reported for this one");
});

test("a worktree COUNT that could not run refuses, never a bogus tally (#395)", (t) => {
  // The counter is a stage like any other. It used to be
  // `grep -c '^worktree ' || true`, and that `|| true` was not optional:
  // `grep -c` exits 1 on zero matches, which is legitimate. But it absorbed a
  // grep that could not RUN just as happily, leaving the count empty,
  // `$((listed - 1))` at -1 (measured), and the die blaming `git worktree list`
  // for a tally no listing can produce. One awk, whose program contains no
  // `exit`, needs no such case absorbed — so the status is the counter's own.
  //
  // Selected by a substring of the awk PROGRAM, never by counting invocations:
  // `{c++}` appears in exactly one awk in this script, and the others read the
  // same listing right after.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const realAwk = execFileSync("/bin/sh", ["-c", "command -v awk"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(r.w, "..", "bin", "awk"),
    `#!/bin/sh\ncase "$*" in *'{c++}'*) exit 1 ;; esac\nexec '${realAwk}' "$@"\n`,
    { mode: 0o755 },
  );

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2, "unanswerable is exit 2, not the exit 0 that releases");
  assert.equal(json, null, "refused before any mutation");
  assert.match(stderr, /could not count the worktrees git listed for #9/);
  assert.doesNotMatch(stderr, /-1 worktrees/,
    "a counter that could not run never reports a count at all");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("a healthy repo with a second live worktree still releases (#395)", (t) => {
  // The acceptance case every guard on a refusal path needs: a guard that
  // refuses everything passes every "does it refuse?" test above. Two real
  // linked worktrees, so the arithmetic is exercised at registered=2/linked=2
  // rather than at the trivial 1-against-1 — the only case in this file that
  // does. Not the only case that CATCHES a broken count, and the prose here
  // once said so: dropping the `-1` reds most of this file, and a skip made
  // unconditional reds most of it too, because every fixture with a live
  // worktree walks this arithmetic (measured). The two subtle skips — dropping
  // the read check, or keying on `gitdir` — this case does not catch at all;
  // the permission fixtures above are the only ones that do.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const sibling = claim(r.w, 77, "other-claim");
  assert.equal(readdirSync(join(r.w, ".git", "worktrees")).length, 2,
    "fixture: two entries really are registered");

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 0, `a healthy repo must still release: ${stderr}`);
  assert.deepEqual(json.blockers, []);
  assert.equal(json.released, true);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
  // The sibling is untouched — the release names one claim, not every worktree.
  assert.equal(existsSync(sibling.wt), true, "the other claim's worktree must survive");
});

test("a claim whose worktree was actually removed and pruned still releases", (t) => {
  // The acceptance case the registry check must not regress, stated against
  // the registry rather than the checkout: `git worktree remove` clears this
  // claim's `.git/worktrees` entry along with the checkout, so once that has
  // happened the branch is genuinely all that is left — not a permission
  // problem in disguise — and the release must still go through.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  git(r.w, "worktree", "remove", c.wt);
  assert.equal(
    existsSync(join(r.w, ".git", "worktrees")),
    false,
    "fixture: removing the only worktree clears the registry entirely",
  );

  const { code, json } = release(r, c);
  assert.equal(code, 0);
  assert.deepEqual(json.blockers, []);
  assert.equal(json.released, true);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false }, "all three are released");
});

test("a quote in the slug cannot produce a payload the caller fails to parse", (t) => {
  // <slug> and <type> reach the JSON, as does git's own stderr, so a single `"`
  // used to emit output that JSON.parse rejects — after the delete, with the
  // exit code still reporting success.
  // A backslash is not a legal ref character, so the quote is the reachable half.
  const r = repo(t);
  const slug = 'a"b';
  git(r.w, "worktree", "add", "-q", join(r.w, ".worktrees", `9-${slug}`), "-b", `fix/9-${slug}`, "origin/main");

  const res = spawnSync("sh", [SCRIPT, "9", slug, "fix"], { cwd: r.w, env: r.env(), encoding: "utf8" });
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.branch, `fix/9-${slug}`, "and it round-trips, rather than being stripped");
});

test("a control character in the worktree name cannot produce an unparseable payload", (t) => {
  // git rejects a control character in a ref, so the quote above is the only way
  // in through <slug>-as-branch — but `stray` matches on the DIRECTORY name, and
  // a detached worktree can be called anything the filesystem allows. JSON
  // forbids every character below \040 unescaped, so escaping only `"` and `\`
  // left this emitting output the caller cannot parse.
  const r = repo(t);
  const slug = "ab";
  git(r.w, "worktree", "add", "-q", "--detach", join(r.w, ".worktrees", `9-${slug}`), "origin/main");

  const res = spawnSync("sh", [SCRIPT, "9", slug, "fix"], { cwd: r.w, env: r.env(), encoding: "utf8" });
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.branch, "fix/9-a b", "the control character is neutralised, not emitted raw");
  // The blockers carry an em-dash, so the scrub must be byte-safe for UTF-8.
  assert.match(parsed.blockers[0], /—/, "multibyte text must survive the scrub");
});

test("a BS, a tab, a FF, a CR and a DEL in the worktree name round-trip rather than being scrubbed", (t) => {
  // `branch` is `$type/$issue-$slug`, built before any git ref check runs, so
  // the same directory-name route that gets a control byte past the ref rules
  // above gets these three past it too. Unlike the byte in the case above, all
  // three now have somewhere to go: tab and CR have JSON short forms, and DEL
  // (\177) is not a C0 byte at all, so none of the five should reach the
  // space-scrub — and none should be reported as rewritten, since the value
  // the caller gets back IS the name on disk, byte for byte. BS (\010) and FF
  // (\014) are here because RFC 8259 gives them short forms too (\b and \f)
  // and the first version of this fix scrubbed both while its comment claimed
  // no such short form existed.
  const r = repo(t);
  const slug = "a\tb\rc\x7fd\be\ff";
  git(r.w, "worktree", "add", "-q", "--detach", join(r.w, ".worktrees", `9-${slug}`), "origin/main");

  const res = spawnSync("sh", [SCRIPT, "9", slug, "fix"], { cwd: r.w, env: r.env(), encoding: "utf8" });
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.branch, `fix/9-${slug}`, "BS, tab, FF, CR and DEL must all survive intact");
  assert.equal(parsed.branchRewritten, false, "escaped or preserved, not replaced — nothing here was rewritten");
});

test("a byte with no JSON short form is replaced in the worktree name and flagged rewritten", (t) => {
  // \013 (VT) rides along because it is the one C0 byte that LOOKS like it has
  // a short form and does not: RFC 8259 lists \b \f \n \r \t and no \v, so
  // narrowing the scrub set to make room for \b and \f must not take VT with
  // it. Unescaped in a JSON string it is a parse error, so JSON.parse below is
  // the discriminator.
  // The case two above already pins that \001 gets neutralised to a space; this
  // pins the other half of #146 — that the payload now says so, so a consumer
  // reading `branch` back cannot mistake the neutralised string for the real
  // name on disk.
  const r = repo(t);
  const slug = "a\x02b\x0bc";
  git(r.w, "worktree", "add", "-q", "--detach", join(r.w, ".worktrees", `9-${slug}`), "origin/main");

  const res = spawnSync("sh", [SCRIPT, "9", slug, "fix"], { cwd: r.w, env: r.env(), encoding: "utf8" });
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.branch, "fix/9-a b c", "no short form for \\002 or \\013 — both still neutralised to a space");
  assert.equal(parsed.branchRewritten, true, "and the payload must disclose that it was");
});

test("a tab, a CR and a DEL in the worktree PATH round-trip in the worktree field too", (t) => {
  // The two cases above only reach `branch`: a detached worktree's directory
  // name IS the slug, so a control byte that breaks the ref also breaks the
  // by-branch lookup and `wt` never gets set. `wt` is located by branch, not by
  // path, so a linked worktree on a perfectly ordinary branch can still sit at
  // a path holding these bytes — a real shape, since claim-ticket.sh's own
  // directory name is `<issue>-<slug>` and nothing stops a slug from carrying
  // them apart from convention.
  const r = repo(t);
  const branch = "fix/9-clean";
  const name = "9-a\tb\rc\x7fd";
  const dir = join(r.w, ".worktrees", name);
  git(r.w, "worktree", "add", "-q", dir, "-b", branch, "origin/main");

  const res = spawnSync("sh", [SCRIPT, "9", "clean", "fix"], { cwd: r.w, env: r.env(), encoding: "utf8" });
  const parsed = JSON.parse(res.stdout);
  // Suffix, not the whole path: git resolves symlinks, so a /var tmpdir comes
  // back as /private/var on macOS (measured — same reason the halt-receipt
  // fixture above reads `wt` back from the script rather than building it).
  assert.ok(parsed.worktree.endsWith(join(".worktrees", name)),
    `tab, CR and DEL in the path must all survive intact, got ${parsed.worktree}`);
  assert.equal(parsed.worktreeRewritten, false, "escaped or preserved, not replaced — nothing here was rewritten");
});

test("a byte with no JSON short form in the worktree PATH is replaced and flagged rewritten", (t) => {
  const r = repo(t);
  const branch = "fix/9-clean";
  const name = "9-a\x02b";
  const dir = join(r.w, ".worktrees", name);
  git(r.w, "worktree", "add", "-q", dir, "-b", branch, "origin/main");

  const res = spawnSync("sh", [SCRIPT, "9", "clean", "fix"], { cwd: r.w, env: r.env(), encoding: "utf8" });
  const parsed = JSON.parse(res.stdout);
  assert.ok(parsed.worktree.endsWith(join(".worktrees", name.replace("\x02", " "))),
    `no short form for \\002 — still neutralised to a space, got ${parsed.worktree}`);
  assert.equal(parsed.worktreeRewritten, true, "and the payload must disclose that it was");
});

test("a .git linkage naming another repository's worktree refuses instead of leaking that repo's clean status", (t) => {
  // #135's own repro: a hand-written .git naming a gitdir whose core.worktree is
  // some OTHER directory is a well-formed regular file, so the existence guard
  // above passes, and `git -C "$wt" status --porcelain` then answers about THAT
  // tree at rc 0 — "this claim is clean" derived from a repository the claim
  // never touched, with its own uncommitted files sitting untouched in $wt.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  writeFileSync(join(c.wt, "precious.txt"), "work that exists nowhere else\n");
  const other = join(r.w, "..", "other");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  commit(other, "root", "root\n");
  git(other, "config", "core.worktree", other);
  rmSync(join(c.wt, ".git"));
  writeFileSync(join(c.wt, ".git"), `gitdir: ${join(other, ".git")}\n`);
  assert.equal(
    git(c.wt, "status", "--porcelain"),
    "",
    "fixture: the leaked answer really is an empty one",
  );

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2);
  assert.equal(json, null, "refused before any mutation, not halted after the delete refused");
  assert.match(stderr, /does not point at .*\/9-release-ticket/, "names the mismatch, not just 'unknown'");
  assert.match(stderr, /whether it holds uncommitted work is unknown/);
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing may be touched");
  assert.equal(readFileSync(join(c.wt, "precious.txt"), "utf8"), "work that exists nowhere else\n");
});

test("a healthy worktree reached through a symlinked parent still releases normally", (t) => {
  // The false refusal the widened linkage guard must not introduce: `worktree
  // list --porcelain` echoes the admin file's recorded path verbatim, and that
  // recorded path is legitimately non-canonical once a directory that was a
  // plain dir at `worktree add` time is later replaced by a symlink to its own
  // former self — `.worktrees` moved aside, then symlinked back to where it was.
  // `git rev-parse --show-toplevel` and `cd $wt && pwd -P` both resolve through
  // the symlink to the same physical place (measured), so this must release
  // exactly as it would without the symlink — not the permanent exit 2 this
  // script has already been fixed twice to stop producing.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const worktreesDir = join(r.w, ".worktrees");
  const realDir = join(r.w, ".worktrees-real");
  renameSync(worktreesDir, realDir);
  symlinkSync(realDir, worktreesDir);

  const { code, json } = release(r, c);
  assert.deepEqual(json.blockers, []);
  assert.equal(json.released, true);
  assert.equal(code, 0);
  assert.deepEqual(artefacts(r, c), { dir: false, worktree: false, branch: false });
});

// --- #119: the escaping library this script now sources rather than carries.
//
// `.` is a POSIX special builtin, so failing to open its operand aborts a
// non-interactive shell before any `||` on the line can run — measured, /bin/sh
// (macOS bash 3.2), bash 3.2 and `bash --posix` all exit 1 with the guard
// unfired. This script's contract defines 0 and 2 only, so a bare 1 is a code
// no caller knows how to read. Worse, the guard must fire BEFORE anything is
// deleted: an abort partway through the release is the "partially released"
// state `halt` exists to report, and a missing file must never reach it.
test("a missing json.sh is exit 2, before anything is deleted", (t) => {
  const r = repo(t);
  const c = claim(r.w, 5, "thing");
  const lone = mkdtempSync(join(tmpdir(), "release-ticket-nolib-"));
  t.after(() => rmSync(lone, { recursive: true, force: true }));
  copyFileSync(SCRIPT, join(lone, "release-ticket.sh"));

  const res = spawnSync("sh", [join(lone, "release-ticket.sh"), ...c.args, "--apply"], {
    cwd: r.w, env: r.env(), encoding: "utf8",
  });

  assert.equal(res.status, 2,
    "a missing library is a refusal, not a verdict — exit 1 here is `NOT released — blocked`, and a library that merely went missing must not be able to say it");
  assert.match(res.stderr, /json\.sh/, "and it names the file rather than leaving the operator to guess");
  assert.equal(res.stdout, "", "no receipt: nothing was released");
  assert.ok(existsSync(c.wt),
    "and the worktree is still there — the guard fires ahead of every mutation, so this is a clean refusal and not a partial release");
});

// --- #243: the lookups over `git worktree list --porcelain` refuse in the
// script's own voice.
//
// Each awk below is a bare `$(...)` assignment, so an awk that cannot answer
// ends the run through `set -e` carrying awk's diagnostic and nothing else. The
// exit code is right — 2, unanswerable — but a caller grepping stderr for
// `release-ticket:` sees no line at all, and the refusal is indistinguishable
// from an awk that simply had nothing to say.
//
// One shim case per guarded assignment, all four of them: the branch lookup, the
// main checkout's branch, the main checkout's path, and the stray scan. Each
// shim picks its victim by a substring of that program's own text, so the other
// three answer normally and deleting one `|| die` reds the case named after it
// and nothing else (measured). The two PREDICATE lookups over the same listing,
// `locked` and `unresolved_head`, are not covered here and cannot be: they
// answer THROUGH awk's exit status, which `|| die` cannot separate from a real
// answer. The sites are named by construct throughout, never by line: they have
// moved every time this file was touched.
test("a newline in the slug refuses in the script's own voice, not awk's (#243)", (t) => {
  // The trigger the ticket measured, and it needs no shim — but it is BSD awk's
  // behaviour rather than awk's. Measured: one-true-awk 20200816 rejects a
  // newline inside a `-v` assignment, while mawk 1.3.4 and gawk 5.4.1 both
  // accept it. So this case pins the guard on macOS, where fleet members run
  // this script, and NOT on a mawk/gawk CI, where the run walks past the lookup
  // and dies later — still prefixed, so this case still passes, pinning nothing.
  //
  // The bare prefix is asserted deliberately for that reason: tightening it to
  // the guard's own message would turn the vacuous pass into a red on those
  // awks, which is worse, not better. The four LOOKUP cases below carry the pin
  // on every implementation — their shim replaces awk's behaviour instead of
  // depending on it, measured under mawk by stripping each guard in turn.
  //
  // No claim is made first because git will not hold a ref with a newline in
  // it, so there is nothing to release.
  const r = repo(t);
  const { code, out, stderr } = release(r, { args: ["9", "a\nb", "fix"] });

  assert.equal(code, 2, "unanswerable is exit 2");
  assert.match(stderr, /^release-ticket: /m,
    "the caller's grep is for this prefix — awk's own diagnostic alone leaves it with nothing");
  assert.equal(out, "", "no payload on a refusal");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("a worktree LOOKUP that could not run refuses in the script's own voice (#243)", (t) => {
  // The first site, and the one the ticket names first. Reached without going
  // through <slug> at all — awk failing on the listing itself rather than on a
  // `-v` value. That route needs the shim: #243 measured only the newline
  // trigger, and the byte that would otherwise reach these programs as record
  // data is held shut by the script's own `export LC_ALL=C` (#582). Selected by
  // `refs/heads/`, which is this lookup's own `-v b=` and appears in no other
  // awk this script runs.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  awkShim(r, "refs/heads/");

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2, "unanswerable is exit 2, not the exit 0 that releases");
  assert.equal(json, null, "refused before any mutation");
  assert.match(stderr, /^release-ticket: .*worktree git listed for #9/m,
    "the script says which lookup could not answer, in the voice its callers grep for");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing was touched");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("a main-checkout branch LOOKUP that could not run refuses in its own voice (#243)", (t) => {
  // The second site in script order, and one of the two this PR guarded beyond
  // the pair the ticket names — so nothing pinned it until this case. `n==1&&`
  // is this program's own first-worktree test and is the only occurrence in the
  // script (`grep -c`), so the lookup above still answers and only this fails.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  awkShim(r, "n==1&&");

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2, "unanswerable is exit 2, not the exit 0 that releases");
  assert.equal(json, null, "refused before any mutation");
  assert.match(stderr, /^release-ticket: .*main checkout's branch/m,
    "the script says which lookup could not answer, in the voice its callers grep for");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing was touched");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("a main-checkout path LOOKUP that could not run refuses in its own voice (#243)", (t) => {
  // The third site, the other one guarded beyond the ticket's pair. The marker
  // is this program's whole body: the stray scan's `p=substr($0,10)` and the
  // branch lookup's `w=substr($0,10)` both ASSIGN rather than print, so
  // `print substr($0,10); exit` matches here and nowhere else (`grep -cF`).
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  awkShim(r, "print substr($0,10); exit");

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2, "unanswerable is exit 2, not the exit 0 that releases");
  assert.equal(json, null, "refused before any mutation");
  assert.match(stderr, /^release-ticket: .*main checkout's path/m,
    "the script says which lookup could not answer, in the voice its callers grep for");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing was touched");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("a stray LOOKUP that could not run refuses in the script's own voice (#243)", (t) => {
  // The fourth site, and the second the ticket names. `length(d)` is the stray
  // lookup's own suffix comparison and appears in no other awk here, so the
  // three lookups above still answer and only this one fails — a guard on the
  // first site alone leaves this red.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  awkShim(r, "length(d)");

  const { code, json, stderr } = release(r, c);
  assert.equal(code, 2, "unanswerable is exit 2, not the exit 0 that releases");
  assert.equal(json, null, "refused before any mutation");
  assert.match(stderr, /^release-ticket: .*stray worktree/m,
    "the script says which lookup could not answer, in the voice its callers grep for");
  assert.deepEqual(artefacts(r, c), { dir: true, worktree: true, branch: true }, "nothing was touched");
  assert.deepEqual(r.calls(), [], "and the tracker is never asked");
});

test("a healthy run says nothing on stderr and still releases (#243)", (t) => {
  // The acceptance half. A guard that refuses whenever its lookup came back
  // empty would pass every refusal case above, and these awks are entitled to
  // match nothing: the stray lookup finds no directory on an ordinary release,
  // and a claim whose worktree was already pruned leaves both lookups empty.
  // Both shapes must stay exit 0 with a clean stderr.
  const r = repo(t);
  const c = claim(r.w, 9, "release-ticket");
  const pruned = claim(r.w, 77, "other-claim");
  git(r.w, "worktree", "remove", pruned.wt);

  // Every line a successful run writes to stderr is the `$ <command>` trace, and
  // every refusal this script can emit is prefixed with its own name — so "no
  // line that is not the trace" is the byte-level statement of "nothing
  // refused", without pinning the trace's wording.
  const traceOnly = (stderr, what) =>
    assert.deepEqual(stderr.split("\n").filter((l) => l && !l.startsWith("$ ")), [], what);

  const first = release(r, c);
  assert.equal(first.code, 0, `an ordinary release must still go through: ${first.stderr}`);
  traceOnly(first.stderr, "a run that refused nothing writes only the trace");
  assert.equal(first.json.released, true);

  const second = release(r, pruned);
  assert.equal(second.code, 0, `a branch-only claim must still release: ${second.stderr}`);
  traceOnly(second.stderr, "both lookups empty is an answer, not a failure");
  assert.equal(second.json.released, true);
});
