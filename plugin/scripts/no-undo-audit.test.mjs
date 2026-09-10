// Regression gate for no-undo-audit.sh, all three of its outcomes. Zero deps:
// `node --test scripts/no-undo-audit.test.mjs`.
//
// The audit answers one question — is this worktree safe to rebase — and the
// only thing that makes it refuse is uncommitted work in the worktree. It used
// to also refuse on a nonzero repo-global stash count, which is unrelated to
// that question: a rebase never consumes a pre-existing entry, so the count
// refused every run in a repo holding any entry while proving nothing about the
// branch. Both directions are pinned, because a fix for a false refusal is one
// keystroke from deleting the true one.
//
// The refusal is only half of it. A clean worktree exits 0 while still
// answering "what would a careless resolution eat", and everything below the
// `conflicts[] and atRisk[]` banner pins that half — the half that had no
// coverage at all while this file called itself the regression gate.
//
// Exit 2 is its own outcome: the question could not be answered. Its rule is
// that no payload is emitted, because a payload is an answer, and every exit-2
// test asserts that as well as the code. Reported safe on a question never
// asked is the one failure this script exists to prevent, so a shape it cannot
// answer must exit 2 rather than exit 0 with an empty `atRisk`.
//
// Real git throughout: a shell script that reasons about git state can only be
// tested against real git state.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { between, phrase, stripHashGutter } from "./prose-pin.mjs";

const SCRIPT = fileURLToPath(new URL("./no-undo-audit.sh", import.meta.url));

// Pin identity and cut the developer's ~/.gitconfig out of the fixtures, so a
// local pull.rebase or hook cannot change what these repos look like. BASE_REF
// is unset because the fleet harness is exactly the caller that would have it
// set, and inheriting it would point every fixture at a local main while the
// suite stayed green.
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
  // GIT_CONFIG_GLOBAL alone does not isolate: these two carry config in through
  // a separate door and outrank the files. A suite run from inside a git hook
  // inherits whatever set them, which is a false red nobody can reproduce by
  // hand.
  GIT_CONFIG_COUNT: undefined,
  GIT_CONFIG_PARAMETERS: undefined,
};

const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Bare origin + clone with `main` and a pushed feature branch, checked out. */
function repo(t, branch = "fix/1-thing", prefix = "no-undo-audit-") {
  const root = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  writeFileSync(join(w, "f.txt"), "root\n");
  git(w, "add", "f.txt");
  git(w, "commit", "-q", "-m", "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  git(w, "checkout", "-q", "-b", branch);
  writeFileSync(join(w, "g.txt"), "branch work\n");
  git(w, "add", "g.txt");
  git(w, "commit", "-q", "-m", "branch work");
  git(w, "push", "-q", "-u", "origin", branch);
  return { w, branch };
}

/** Leave a stash entry behind without leaving the worktree dirty. */
function stashSomething(w, name = "h.txt") {
  writeFileSync(join(w, name), "stashed\n");
  git(w, "add", name);
  git(w, "stash", "push", "-q", "-m", `pre-existing ${name}`);
}

/** Add/add conflict on `path`, with main holding the later commit that made it. */
// Two decoys make `atRisk` discriminating rather than merely nonempty. Without
// them every main commit since the fork touches the conflicting path and the
// root commit touches nothing else, so "filtered by path", "filtered by range"
// and "not filtered at all" all return exactly one line — and dropping either
// filter from the script leaves the suite green. DECOY_OLD is on the path but
// before the fork; DECOY_NEW is after the fork but on another file.
// `branch` and `prefix` pass straight through to `repo`, so a case can plant a
// marker in the branch name or in the worktree path — the two values #431's
// escape block renders, and the only two a content-selected shim can address
// there. Both default through `repo`'s own defaults, so every existing caller
// is unchanged.
function conflictRepo(t, path, branch, prefix) {
  const c = repo(t, branch, prefix);
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, path), "older, already shared\n");
  git(c.w, "add", "--", `:(literal)${path}`);
  git(c.w, "commit", "-q", "-m", "DECOY_OLD before the fork");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);
  git(c.w, "merge", "-q", "main", "-m", "carry main into the branch");
  writeFileSync(join(c.w, path), "branch side\n");
  git(c.w, "add", "--", `:(literal)${path}`);
  git(c.w, "commit", "-q", "-m", "branch edits the file");
  git(c.w, "push", "-q", "origin", c.branch);
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, "decoy.txt"), "untouched by the conflict\n");
  git(c.w, "add", "--", "decoy.txt");
  git(c.w, "commit", "-q", "-m", "DECOY_NEW after the fork");
  writeFileSync(join(c.w, path), "MAIN SIDE\n");
  git(c.w, "add", "--", `:(literal)${path}`);
  git(c.w, "commit", "-q", "-m", "MAIN COMMIT AT RISK");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);
  return c;
}

/** Both sides add `path`; nothing else. Used where the decoys would be noise. */
function bareConflictRepo(t, path) {
  const c = repo(t);
  writeFileSync(join(c.w, path), "branch side\n");
  git(c.w, "add", "--", `:(literal)${path}`);
  git(c.w, "commit", "-q", "-m", "branch edits the file");
  git(c.w, "push", "-q", "origin", c.branch);
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, path), "MAIN SIDE\n");
  git(c.w, "add", "--", `:(literal)${path}`);
  git(c.w, "commit", "-q", "-m", "MAIN COMMIT AT RISK");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);
  return c;
}

/**
 * Both sides add a path spelled as a `printf` FORMAT, plus `plain.txt`, so
 * merge-tree reports TWO conflicting paths, and main's later commit is
 * `MAIN COMMIT AT RISK` — the same shape `conflictRepo` builds, reached without
 * ever naming the path in JavaScript.
 *
 * The name has to be produced by the SHELL. `execFileSync` re-encodes every JS
 * string as UTF-8, so a JS `"\xFF"` arrives as the two bytes `\303\277` — valid
 * UTF-8, which reproduces nothing. `printf 'b\377ad.txt'` is the only way to get
 * the raw byte across, and it keeps this file pure ASCII.
 *
 * The commits go in through a THROWAWAY `GIT_INDEX_FILE` and are pushed straight
 * to origin, so neither the real index nor the filesystem ever has to hold the
 * name — APFS refuses it outright (`touch $(printf 'b\377ad.txt')` → `Illegal
 * byte sequence`, status 1), which is what makes `--cacheinfo` load-bearing
 * rather than a shortcut. Nothing needs checking out either: the audit reads
 * `origin/main` and `origin/<branch>` and compares neither against local HEAD,
 * so the local branch stays one commit behind and `status --porcelain` stays
 * clean. That is also why no sparse-checkout is needed to keep it clean.
 */
function byteConflictRepo(t, printfPath) {
  const c = repo(t);
  execFileSync("sh", ["-c", `
    set -eu
    w=$1; idx=$2; branch=$3; p=$(printf "$4")
    cd "$w"
    side() {
      parent=$(git rev-parse "$1")
      blob=$(printf '%s\\n' "$2" | git hash-object -w --stdin)
      GIT_INDEX_FILE=$idx git read-tree "$parent"
      GIT_INDEX_FILE=$idx git update-index --add --cacheinfo "100644,$blob,$p" --cacheinfo "100644,$blob,plain.txt"
      tree=$(GIT_INDEX_FILE=$idx git write-tree)
      git commit-tree "$tree" -p "$parent" -m "$3"
    }
    git push -q origin "$(side "origin/$branch" 'branch side' 'branch edits the file')":"refs/heads/$branch"
    git push -q origin "$(side origin/main 'MAIN SIDE' 'MAIN COMMIT AT RISK')":refs/heads/main
  `, "sh", c.w, join(c.w, "..", "idx"), c.branch, printfPath], { env: ENV, encoding: "utf8" });
  return c;
}

/**
 * Add/add conflicts on 20 paths, introduced on main by TWO distinct commits
 * that INTERLEAVE through the pathspec list: the even-numbered paths come
 * from one, the odd-numbered from the other, and the audit hands them to
 * `git log` in sorted order. So a batch — always a contiguous run of that
 * list — holds paths from both commits and reports both, and the
 * concatenation across batches is `B A B A …` rather than `A A B B`.
 *
 * Every part of that shape is load-bearing, and one commit pinned none of it:
 * with a single commit each batch emits the same line, so all duplicates are
 * adjacent and a merely-ADJACENT dedupe (`uniq`) passes; interleaved, `uniq`
 * has nothing adjacent to collapse and returns one line per batch. The two
 * subjects share a first word so a dedupe keyed on `$2` — the subject's first
 * word rather than `$1`, the SHA that is the actual commit identity —
 * collapses them to one and fails. And two DISTINCT commits are what pin that
 * the dedupe drops only true duplicates: both must survive the split.
 *
 * Returns `paths` so the test asserts against the fixture's own count instead
 * of a literal repeated at the call site.
 *
 * Real ARG_MAX needs thousands of ordinary-length paths to split on its own —
 * the exact figure is ambient-environment-size dependent, since xargs' budget
 * is the limit minus the inherited environment — so `withSplitXargs` below
 * forces the split at 20 instead.
 */
function manyConflictsTwoCommits(t) {
  const c = repo(t);
  const paths = Array.from({ length: 20 }, (_, i) => `conflict-${String(i).padStart(2, "0")}.txt`);
  const evens = paths.filter((_, i) => i % 2 === 0);
  const odds = paths.filter((_, i) => i % 2 === 1);
  git(c.w, "checkout", "-q", "main");
  for (const [subject, batch] of [["MAIN COMMIT AT RISK, even paths", evens], ["MAIN COMMIT AT RISK, odd paths", odds]]) {
    for (const p of batch) writeFileSync(join(c.w, p), "MAIN SIDE\n");
    git(c.w, "add", "--", ...batch);
    git(c.w, "commit", "-q", "-m", subject);
  }
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);
  for (const p of paths) writeFileSync(join(c.w, p), "branch side\n");
  git(c.w, "add", "--", ...paths);
  git(c.w, "commit", "-q", "-m", "branch edits every file");
  git(c.w, "push", "-q", "origin", c.branch);
  return { ...c, paths };
}

/**
 * Shadows `xargs` on PATH with a wrapper that inserts `-s size` ahead of
 * whatever args the script passes, forcing the ARG_MAX split #148 describes
 * on an ordinary small fixture instead of a ~1 MiB pathspec list — the same
 * technique the ticket used to measure the bug. Both wrappers resolve the real
 * binary once up front — outside the shadowed PATH, so the lookup cannot
 * recurse into the wrapper — and then `exec` it, so nothing else changes.
 *
 * `git` is shadowed too, and only to COUNT the batches: it records every
 * invocation carrying a `:(literal)` pathspec, which is the one call xargs
 * drives, so the count IS the number of batches. Without it the split is an
 * unasserted side condition and the test is only conditionally a test — an
 * xargs that clamps or ignores a small `-s` runs the whole fixture in one
 * batch, and then every assertion below passes with the dedupe DELETED,
 * measured end to end. `batches()` is what makes that platform fail red
 * instead of green-on-nothing.
 */
function withSplitXargs(t, size = 300) {
  const bin = mkdtempSync(join(tmpdir(), "no-undo-audit-xargs-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = join(bin, "batches");
  const shim = (name, body) => {
    const real = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}exec ${real} "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  };
  shim("xargs", `set -- -s ${size} "$@"\n`);
  shim("git", `case " $* " in *':(literal)'*) echo x >>"${log}" ;; esac\n`);
  return {
    path: `${bin}:${process.env.PATH}`,
    batches: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").length - 1 : 0),
  };
}

/**
 * A wrapper factory for the two shims below: resolves the real binary once, up
 * front and outside the shadowed PATH so the lookup cannot recurse into the
 * wrapper, then writes an executable of the given body. Same technique as
 * `withSplitXargs`, kept separate because these two need a whole script rather
 * than a prefix ahead of a trailing `exec`.
 */
function shimDir(t, prefix) {
  const bin = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  return {
    bin,
    real: (name) => execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim(),
    write: (name, body) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n${body}`);
      chmodSync(join(bin, name), 0o755);
    },
    path: () => `${bin}:${process.env.PATH}`,
  };
}

/**
 * Makes the file holding merge-tree's `-z` output unreadable at the moment the
 * audit reads it, and not one step earlier: the `git` wrapper chmods it only
 * after the real `merge-tree` has written and exited, so the emptiness guard
 * that sits between the write and the read still sees a non-empty file and
 * passes. That ordering is the whole point — the fault has to land on the stage
 * that READS, which is the stage a pipeline's exit status does not report.
 *
 * `chmod 000` rather than `rm` for the same reason: a removed file fails the
 * emptiness guard instead, and the test would then be green on a refusal raised
 * by a different guard about a different fault, proving nothing about this one.
 *
 * The `mktemp` wrapper exists only to learn the name of a temporary that is
 * otherwise private to the script. It records the FIRST one, which is the file
 * merge-tree writes; a later temporary is left alone.
 */
function withUnreadableMergeTreeOutput(t) {
  const s = shimDir(t, "no-undo-audit-mtout-");
  const recorded = join(s.bin, "first-temp-path");
  s.write("mktemp", `f=$(${s.real("mktemp")} "$@") || exit $?
[ -e "${recorded}" ] || printf '%s\\n' "$f" >"${recorded}"
printf '%s\\n' "$f"
`);
  s.write("git", `case " $* " in
  *" merge-tree "*)
    ${s.real("git")} "$@"
    rc=$?
    chmod 000 "$(cat "${recorded}")"
    exit $rc ;;
esac
exec ${s.real("git")} "$@"
`);
  return s.path();
}

/**
 * Fails every `mktemp` after the first, leaving merge-tree's own temporary
 * intact so the run reaches the point where a second one is asked for. A full
 * TMPDIR or a TMPDIR that has gone missing does this for real.
 *
 * The path the first call handed back is recorded, not merely the fact that a
 * call happened, because the abort this injects is also the abort that has to
 * clean up after itself: the caller reads `firstTemp` to check the file is gone
 * once the run has exited. Recording it is what lets the assertion name a real
 * path rather than trusting the trap.
 */
function withLaterMktempFailing(t) {
  const s = shimDir(t, "no-undo-audit-mktemp-");
  const firstTemp = join(s.bin, "first-temp-path");
  s.write("mktemp", `if [ -e "${firstTemp}" ]; then
  echo "mktemp: failed to create file" >&2
  exit 1
fi
f=$(${s.real("mktemp")} "$@") || exit $?
printf '%s\n' "$f" >"${firstTemp}"
printf '%s\n' "$f"
`);
  return { path: s.path(), firstTemp };
}

/**
 * Add/add conflicts on enough paths, each named long enough, that merge-tree's PROSE tail — the
 * `Auto-merging`/`CONFLICT` section that follows the empty record, and the part
 * of the output the audit deliberately never wants — is larger than a pipe
 * buffer.
 *
 * That size is the whole fixture. The reader stops at the empty record by
 * design, so on any conflicted run it leaves the tail unread; once the tail no
 * longer fits in the buffer, whatever is upstream of the reader is still trying
 * to write when the reader goes away. A `tr | tr | awk` reads back
 * `141 141 0 0` there — two stages killed by SIGPIPE on a run whose answer is
 * completely CORRECT. Anything that adopts a prefix stage's status as the
 * pipeline's own, `set -o pipefail` most obviously, converts exactly this run
 * into a refusal. So the fixture is a control: it must keep answering.
 *
 * One main commit, not `manyConflictsTwoCommits`' two — the dedupe across xargs
 * batches is that fixture's claim and not this one's.
 */
function longTailConflictRepo(t) {
  const c = repo(t);
  const paths = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, "0")}-${"x".repeat(220)}.txt`);
  git(c.w, "checkout", "-q", "main");
  for (const p of paths) writeFileSync(join(c.w, p), "MAIN SIDE\n");
  git(c.w, "add", "--", ...paths);
  git(c.w, "commit", "-q", "-m", "MAIN COMMIT AT RISK");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);
  for (const p of paths) writeFileSync(join(c.w, p), "branch side\n");
  git(c.w, "add", "--", ...paths);
  git(c.w, "commit", "-q", "-m", "branch edits every file");
  git(c.w, "push", "-q", "origin", c.branch);
  return { ...c, paths };
}

/** Bytes of merge-tree's output after the empty record — the part left unread. */
function unreadTailBytes({ w, branch }) {
  const mt = spawnSync("git", ["-C", w, "merge-tree", "--write-tree", "--name-only", "-z", "origin/main", `origin/${branch}`],
    { env: ENV, maxBuffer: 1 << 27 });
  const end = mt.stdout.indexOf(Buffer.from([0, 0]));
  assert.notEqual(end, -1, "merge-tree must emit the empty record that ends the filename section");
  return mt.stdout.length - (end + 2);
}

/**
 * A linked worktree NESTED inside the clone, `.worktrees/` gitignored — the
 * fleet's own layout, and the only one where breaking the linkage is dangerous:
 * an enclosing repo is standing by to answer in the worktree's place, and being
 * clean it answers "nothing uncommitted here". A worktree with no repo above it
 * has nothing to walk up to, so git fails there and the script already refuses.
 * `precious.txt` is the uncommitted work that exists nowhere else.
 */
function nestedWorktree(t) {
  const branch = "fix/9-nested";
  const c = repo(t);
  writeFileSync(join(c.w, ".gitignore"), ".worktrees/\n");
  git(c.w, "add", ".gitignore");
  git(c.w, "commit", "-q", "-m", "ignore the nested worktree");
  const w = join(c.w, ".worktrees", "9-x");
  git(c.w, "worktree", "add", "-q", "-b", branch, w);
  git(w, "push", "-q", "-u", "origin", branch);
  writeFileSync(join(w, "precious.txt"), "work that exists nowhere else\n");
  return { parent: c.w, w, branch };
}

/**
 * `nestedWorktree` plus a SECOND linked worktree under the same parent,
 * named `8-y` to match the ticket's own repro. `sibling` is where it lives;
 * `siblingAdmin` is its admin dir — the thing #189's spoof names in place of
 * $wt's own.
 */
function nestedWorktreePair(t) {
  const c = nestedWorktree(t);
  const sibling = join(c.parent, ".worktrees", "8-y");
  git(c.parent, "worktree", "add", "-q", "-b", "fix/8-sibling", sibling);
  // Asked of git itself, not built with `join`: on macOS `tmpdir()` sits under
  // a `/var` that is itself a symlink to `/private/var`, and git's own
  // `--git-dir` answers with the resolved form. A hand-joined path would
  // still WORK if spoofed into a `.git` file — the filesystem resolves either
  // spelling — but comparing it against a later `--git-dir` call in a test
  // assertion needs the same spelling git itself produces.
  const siblingAdmin = git(sibling, "rev-parse", "--git-dir");
  return { ...c, sibling, siblingAdmin };
}

// The payload is parsed here rather than at the call site: "the audit passed and
// then the caller crashed on its own stdout" is a distinct outcome from "the
// audit refused", and a test cannot tell them apart if the parse throws inside
// the helper that also reports the exit code.
// `cwd` defaults to `$wt`, which is what every fixture predating #376 wants.
// The real caller runs from its own directory; the cwd-independence test below
// passes that in rather than relying on the two happening to coincide.
const audit = ({ w, branch }, env = ENV, cwd = w) => {
  const r = spawnSync("sh", [SCRIPT, w, branch], { cwd, env, encoding: "utf8" });
  const out = r.stdout.trim();
  let json = null;
  let jsonError = null;
  if (out) {
    try {
      json = JSON.parse(out);
    } catch (e) {
      jsonError = e;
    }
  }
  return { ...r, json, jsonError };
};

/** `atRisk` with the abbreviated SHA stripped, so a test can pin the exact set. */
const subjects = (r) => r.json.atRisk.map((l) => l.replace(/^\S+ /, ""));

/**
 * The audit's own stash line, pulled out of stderr whole. Pinned as a literal
 * rather than a substring match: #304 appends git's diagnostic to this line,
 * and the thing that must not happen is a separator appended with nothing
 * after it — which every `/unknown/` match above would still pass.
 */
const UNKNOWN_LINE =
  "    stash entries (repo-global, not gated): unknown — the list came back empty but refs/stash is not absent (an unreadable ref or reflog, or a ref pointing at a missing object)";
/**
 * #376's line, and deliberately NOT the one above: there `refs/stash` is
 * present and unreadable, here it is gone while its reflog is not. Reusing
 * UNKNOWN_LINE would tell the operator "refs/stash is not absent" about a
 * state whose whole shape is that it IS, and send them to `ls -l` on a file
 * that no longer exists.
 */
const ORPHAN_LINE =
  "    stash entries (repo-global, not gated): unknown — refs/stash is absent but its reflog is not, and still names entries no ref points at";
/**
 * #482's line, and the third of the three: the two above are reached with an
 * EMPTY list, this one with entries printed and a nonzero rc. Literal for the
 * same reason they are — `/unknown/` passes on any wording, so a reword naming
 * the wrong call as the one that failed would go unseen. git's own diagnostic
 * is appended after it, so what is pinned here is the prefix, not the line.
 */
const RC_FAILED_LINE =
  "    stash entries (repo-global, not gated): unknown — the list call itself failed, so what it printed cannot be read as a count";
/**
 * #570's line, and the fourth. Of the three above only ORPHAN_LINE is reached
 * with the reflog path in hand: the resolution is guarded on an empty list AND
 * an absent ref, so UNKNOWN_LINE (ref present) and RC_FAILED_LINE (entries
 * printed) never ask for the path at all — measured. This one is reached
 * because asking for it FAILED. So it says only that the reflog could not be
 * reached and nothing about what it holds — ORPHAN_LINE's claim that the
 * reflog "still names entries no ref points at" is a claim about contents this
 * state has not read and cannot make.
 */
const UNREACHED_LINE =
  "    stash entries (repo-global, not gated): unknown — the reflog path could not be resolved, so the reflog could not be read";
const stashLine = (r) => r.stderr.split("\n").find((l) => l.includes("stash entries (repo-global"));
/**
 * `stashLine`'s sibling: every matching line, not just the first. `.find()`
 * above answers "what is the first sentence", and nothing built on it can
 * therefore see a SECOND stash-entry line appear — so a future edit that
 * breaks the if/elif/elif/else below into independent `if`s, letting two
 * arms fire for one state, would go unnoticed. The design rule for that
 * chain is one sentence per state (see the script's own comment ahead of
 * it); the length-1 assertions below are what actually enforces it. #1210.
 */
const stashLines = (r) => r.stderr.split("\n").filter((l) => l.includes("stash entries (repo-global"));

// `$wt` is caller-supplied and reaches the operator through a step header.
// Under `#!/bin/sh` an `echo` operand expands escapes, so a worktree whose
// name holds `\c` truncated that header and the next stderr line landed on
// top of it. No corrupt repo needed — which makes this a strictly more
// reachable instance of the same hazard as the stash line's, and the reason
// `printf` is used at both sites.
test("a worktree path holding a backslash escape reaches the operator whole", (t) => {
  const c = repo(t, "fix/1-thing", "no-undo-audit-back\\clue-");
  assert.match(c.w, /back\\clue/, "fixture must actually put a `\\c` in the path");

  const r = audit(c);
  assert.equal(r.status, 0, `fixture must be clean; got ${r.status} ${r.stderr}`);
  assert.ok(
    r.stderr.includes(`$ git -C ${c.w} status --porcelain`),
    "`echo` truncates the header at the `\\c` — it must name the worktree verbatim",
  );
});

// The same hazard on the refusal path. `die` interpolates `$wt` into 11 of
// its messages and is the single place they all route through, so one `printf`
// covers every one of them.
test("a die message naming an unreachable worktree keeps the path whole", (t) => {
  const c = repo(t);
  const notARepo = `${c.w}-back\\clue-notarepo`;
  mkdirSync(notARepo);

  const r = audit({ w: notARepo, branch: c.branch });
  assert.equal(r.status, 2, `a non-worktree is unanswerable, not a refusal; got ${r.status} ${r.stderr}`);
  assert.ok(
    r.stderr.includes(`${notARepo} is not a git worktree`),
    `\`echo\` truncates the refusal at the \`\\c\`; got ${JSON.stringify(r.stderr)}`,
  );
});

// `$porcelain` carries the uncommitted file list — the audit's whole subject,
// and the lines it prints when it REFUSES. A filename is free to hold `\c`.
test("an uncommitted path holding a backslash escape survives the refusal listing", (t) => {
  const c = repo(t);
  writeFileSync(join(c.w, "back\\clue.txt"), "work that exists nowhere else\n");

  const r = audit(c);
  assert.equal(r.status, 1, `uncommitted work must refuse; got ${r.status} ${r.stderr}`);
  // git C-quotes a path holding a backslash, so the bytes on the wire are `\\`.
  // `echo` collapses that pair to one, silently rewriting the quoted path into
  // a different one — corruption rather than truncation here, but on the very
  // line the refusal prints. `-z` turns the same quoting OFF for the conflict
  // list below, which is why that one truncates outright instead.
  assert.ok(
    r.stderr.includes('?? "back\\\\clue.txt"'),
    `the C-quoted path must keep its doubled backslash; got ${JSON.stringify(r.stderr)}`,
  );
});

test("a pre-existing stash does not refuse a clean worktree", (t) => {
  const c = repo(t);
  stashSomething(c.w);
  assert.equal(git(c.w, "status", "--porcelain"), "", "fixture must leave the worktree clean");
  assert.equal(git(c.w, "stash", "list").split("\n").filter(Boolean).length, 1, "fixture must leave one stash");

  const r = audit(c);
  assert.equal(r.status, 0, `a stash the rebase will not consume must not refuse; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.clean, true);
  assert.equal(r.json.stash, 1, "the count is still reported, just not gated on");
  assert.doesNotMatch(r.stderr, /REFUSED/);
});

test("several pre-existing stashes still do not refuse", (t) => {
  const c = repo(t);
  stashSomething(c.w, "h1.txt");
  stashSomething(c.w, "h2.txt");
  stashSomething(c.w, "h3.txt");

  const r = audit(c);
  assert.equal(r.status, 0, "the refusal must not scale with the count either");
  assert.equal(r.json.stash, 3);
});

test("a dirty worktree still refuses, and names the worktree not the stash", (t) => {
  const c = repo(t);
  writeFileSync(join(c.w, "uncommitted.txt"), "work that exists nowhere else\n");

  const r = audit(c);
  assert.equal(r.status, 1, "uncommitted work is the whole point of this audit");
  assert.equal(r.json.clean, false);
  assert.match(r.stderr, /REFUSED/);
  assert.match(r.stderr, /commit the worktree before rebasing/);
  // The old message told the caller to clear the stash list and forbade
  // `git stash drop` in the same refusal. Removing the gate must remove the
  // instruction, or the contradiction outlives the bug.
  assert.doesNotMatch(r.stderr, /stash-list-clear/);
  // `git stash`, not `git stash drop`: stashing to clear a dirty worktree now
  // leaves `clean` true, so this line is the only thing in the repo forbidding
  // a maneuver nothing detects. Narrowing it back to `drop` reads like a
  // consistency fix and silently reopens the hole.
  assert.match(r.stderr, /`git stash` to make a rebase start/);
});

// #730 (see reap.sh's branch sweep for the full explanation) — a bare
// `--porcelain` reads `clean` over a dirty tree under
// `status.showUntrackedFiles = no`. Load-bearing here beyond a reap: the
// merge bot leans on this audit to authorize a REBASE, and the work a
// rebase replays over may exist nowhere else.
test("a dirty worktree still refuses under status.showUntrackedFiles=no (#730)", (t) => {
  const c = repo(t);
  writeFileSync(join(c.w, "uncommitted.txt"), "work that exists nowhere else\n");
  git(c.w, "config", "status.showUntrackedFiles", "no");
  assert.equal(git(c.w, "status", "--porcelain"), "",
    "fixture: the config must really silence the unpinned probe, or this test measures nothing");

  const r = audit(c);
  assert.equal(r.status, 1, `a silenced probe must not become a clean verdict; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.clean, false);
  assert.match(r.stderr, /REFUSED/);
  assert.match(r.stderr, /commit the worktree before rebasing/);
  // Exit 1 is the refusal that means dirty; exit 2 means unanswerable. A fix
  // that turned the silenced answer into a refusal-to-answer would satisfy a
  // bare "not 0" and report the wrong thing about a worktree git can read.
  assert.match(r.stderr, /uncommitted\.txt/, "the file git could only see with the mode pinned must be named");
});

test("a dirty worktree refuses with an empty stash stack", (t) => {
  const c = repo(t);
  writeFileSync(join(c.w, "uncommitted.txt"), "work\n");
  assert.equal(git(c.w, "stash", "list"), "", "fixture must leave no stash");

  const r = audit(c);
  assert.equal(r.status, 1, "clean is the sole gate — it must fire on its own");
  assert.equal(r.json.stash, 0);
});

test("a clean worktree with no stash passes", (t) => {
  const c = repo(t);
  const r = audit(c);
  assert.equal(r.status, 0);
  assert.equal(r.json.clean, true);
  assert.equal(r.json.stash, 0);
});

// #147: `git stash list` prints nothing at rc 0 when the reflog behind
// `refs/stash` cannot be read — no error to catch, so this used to report
// `stash: 0`, indistinguishable from the case right above, where there really
// is nothing. `show-ref` still finds `refs/stash` here (rc 0), which is what
// tells the two apart.
test("stash entries present but the reflog is unreadable reports unknown, not zero", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads a 000 file regardless");
  const c = repo(t);
  stashSomething(c.w);
  assert.equal(git(c.w, "stash", "list").split("\n").filter(Boolean).length, 1, "fixture must leave one stash");
  chmodSync(join(c.w, ".git", "logs", "refs", "stash"), 0o000);

  const r = audit(c);
  assert.equal(r.status, 0, `unknown must not gate the audit; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.stash, null, "an unreadable reflog must report unknown, not the zero this used to silently report");
  assert.match(r.stderr, /unknown/);
});

// The third trap, and the one a `rev-parse --verify` cross-check cannot see:
// the `refs/stash` FILE itself unreadable. The list comes back empty at rc 0
// exactly as above, but this time the ref does not resolve either — so
// rev-parse takes the genuinely-empty branch and prints the confident `0`
// that #147 exists to remove. `show-ref` returns 1 only for a ref that is
// genuinely ABSENT, and 128 for one that is there but unreadable, which is
// what keeps the two apart.
test("stash entries present but refs/stash is unreadable reports unknown, not zero", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads a 000 file regardless");
  const c = repo(t);
  stashSomething(c.w);
  assert.equal(git(c.w, "stash", "list").split("\n").filter(Boolean).length, 1, "fixture must leave one stash");
  chmodSync(join(c.w, ".git", "refs", "stash"), 0o000);

  const r = audit(c);
  assert.equal(r.status, 0, `unknown must not gate the audit; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.stash, null, "an unreadable refs/stash must report unknown, not the zero a rev-parse cross-check reports");
  assert.match(r.stderr, /unknown/);
});

// The second, different trap: a corrupted stash ref (missing object) makes
// `git stash list` itself fail — `fatal: bad object refs/stash`, rc 1 — but
// the pipeline's exit status was always `wc`'s, never git's, so an rc capture
// on the old pipeline would not have caught this either. `show-ref` fails
// here at rc 128 rather than the rc 1 that means genuinely absent, so the
// same cross-check catches this case too.
test("a corrupted stash ref reports unknown, not zero", (t) => {
  const c = repo(t);
  stashSomething(c.w);
  const sha = git(c.w, "rev-parse", "refs/stash");
  rmSync(join(c.w, ".git", "objects", sha.slice(0, 2), sha.slice(2)));

  const r = audit(c);
  assert.equal(r.status, 0, `unknown must not gate the audit; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.stash, null, "a corrupted stash object must report unknown, not zero");
  assert.match(r.stderr, /unknown/);
});

// #304: of the states above, exactly one has git saying anything —
// `fatal: bad object refs/stash`. The counting pipeline's `2>/dev/null` threw
// it away, so the operator got the guess in place of the answer git had
// already named. Appended, never substituted: in the other states git is
// silent, and the generic line is all there is.
test("a corrupted stash ref passes git's own diagnostic through to the operator", (t) => {
  const c = repo(t);
  stashSomething(c.w);
  const sha = git(c.w, "rev-parse", "refs/stash");
  rmSync(join(c.w, ".git", "objects", sha.slice(0, 2), sha.slice(2)));

  const r = audit(c);
  assert.equal(r.status, 0, `unknown must not gate the audit; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.stash, null, "the diagnostic is stderr only — the payload still says unknown");
  // The whole line, not `startsWith` plus a substring match: those two leave
  // the text between them unconstrained, so `msg="$msg$diag"` — separator
  // dropped entirely — satisfies both, as does any other joiner.
  assert.equal(
    stashLine(r),
    `${UNKNOWN_LINE} — fatal: bad object refs/stash`,
    "git named the fault; the audit must append it to the generic line, ` — ` and all, not substitute for it and not run it together",
  );
  assert.equal(stashLines(r).length, 1, "exactly one stash-entry line — a broken elif chain would let a second one through, #1210");
});

// #376: the fourth `show-ref` state, and the only one that used to print a
// number. The three above all leave `refs/stash` resolvable, so they land on
// rc 0 or rc 128 and trip the `-ne 1` guard. Delete the ref FILE and leave
// `.git/logs/refs/stash` behind and `show-ref` exits **1** — the exact rc that
// guard defines as genuine absence — while both stash commits are still named
// in the reflog and still reachable. `git stash list` is empty at rc 0, so
// nothing contradicts the `0`, and `0` is the value the runbook reads as
// nothing to look at before an irreversible rebase.
test("a deleted refs/stash with an intact reflog reports unknown, not zero", (t) => {
  const c = repo(t);
  stashSomething(c.w, "h1.txt");
  stashSomething(c.w, "h2.txt");
  rmSync(join(c.w, ".git", "refs", "stash")); // the ref file only — the reflog is untouched

  // The three conditions that make this indistinguishable from an empty stash
  // by everything the script asked before this change.
  const reflog = readFileSync(join(c.w, ".git", "logs", "refs", "stash"), "utf8").split("\n").filter(Boolean);
  assert.equal(reflog.length, 2, "fixture must leave both reflog entries behind");
  const showRef = spawnSync("git", ["show-ref", "refs/stash"], { cwd: c.w, env: ENV, encoding: "utf8" });
  assert.equal(showRef.status, 1, "the whole defect is this rc — the same one a genuinely empty stash gives");
  assert.equal(git(c.w, "stash", "list"), "", "and the list agrees with it, at rc 0");

  const r = audit(c);
  assert.equal(r.status, 0, `an orphaned stash reflog is a report, not a refusal; got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.equal(r.json.stash, null, "two recoverable stash commits are still named in the reflog — `0` is not a claim the audit can make");
  assert.equal(stashLine(r), ORPHAN_LINE);
  assert.equal(stashLines(r).length, 1, "exactly one stash-entry line — a broken elif chain would let a second one through, #1210");
});

// The reflog path has to come from the repo's REAL gitdir. `$wt` is routinely a
// linked worktree — the fleet's own layout, which is where this script actually
// runs — and there `.git` is a FILE, so `$wt/.git/logs/refs/stash` reaches
// nothing. A probe built on that path reads "no reflog", takes the accept
// branch, and prints the same confident `0` this fix exists to remove, in the
// one layout that matters. The stash stack is repo-global, so the entries are
// created in the parent and seen from the worktree.
test("the orphaned-reflog probe resolves against the shared gitdir, not $wt/.git", (t) => {
  const c = nestedWorktree(t);
  rmSync(join(c.w, "precious.txt")); // this fixture is otherwise dirty, and dirty refuses at exit 1
  stashSomething(c.parent, "h1.txt");
  rmSync(join(c.parent, ".git", "refs", "stash"));

  assert.ok(!existsSync(join(c.w, ".git", "logs", "refs", "stash")), "a naive $wt/.git path must find nothing here — that is what this test discriminates");
  assert.ok(existsSync(join(c.parent, ".git", "logs", "refs", "stash")), "the reflog lives in the shared gitdir");
  assert.equal(git(c.w, "status", "--porcelain"), "", "fixture must leave the worktree clean");

  const r = audit(c);
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.equal(r.json.stash, null, "the reflog is one directory up, and the probe has to follow git there");
  assert.equal(stashLine(r), ORPHAN_LINE);
  assert.equal(stashLines(r).length, 1, "exactly one stash-entry line — a broken elif chain would let a second one through, #1210");
});

// Every other fixture in this file spawns the script with `cwd === $wt`, which
// is not how it is called: `run-merge-bot.md` runs `no-undo-audit.sh <worktree>
// <branch>` from wherever the operator's shell already sits. `--git-path`
// answers relative to `-C` in a main checkout, so a probe that keeps that
// answer looks for the reflog under the CALLER's cwd, finds nothing, takes the
// accept branch and prints the confident `0` this fix exists to remove — in the
// one invocation that actually happens. Pinned as behaviour, not mechanism: the
// probe has to resolve from anywhere, and how the path is made absolute is
// git's business, not this test's.
test("the orphaned-reflog probe resolves from a cwd that is not $wt", (t) => {
  const c = repo(t);
  stashSomething(c.w, "h1.txt");
  rmSync(join(c.w, ".git", "refs", "stash")); // the ref file only — the reflog is untouched

  const r = audit(c, ENV, tmpdir());
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.equal(r.json.stash, null, "the reflog is under $wt — resolved against the caller's cwd instead, it reads as absent and reports the `0` #376 removes");
  assert.equal(stashLine(r), ORPHAN_LINE);
  assert.equal(stashLines(r).length, 1, "exactly one stash-entry line — a broken elif chain would let a second one through, #1210");
});

// #570: the reflog path is resolved lazily, and resolving it needs search
// permission on every ancestor directory. An unsearchable `logs/refs` makes
// that call fail, and the `|| die` behind it turned a fault in a field the
// script declares "reported, not gated" into a refusal of the WHOLE audit —
// exit 2 with a zero-byte payload, withholding the `clean`, `conflicts` and
// `atRisk` answers the audit exists to give before an irreversible rebase.
// The suite already pins that rule twice above, with `unknown must not gate
// the audit`, for the unreadable-reflog FILE and unreadable-ref FILE faults;
// the unsearchable DIRECTORY is the same class.
//
// Both rows reach the probe: it is entered on an empty list plus a genuinely
// absent ref, which is what a never-stashed repo looks like and what an
// orphaned reflog looks like. So the common state — a repo that never stashed
// at all — is one of them, and needed no stash history to refuse.
//
// The die's stated rationale was that a failure here means the repo went away
// mid-run. These fixtures falsify it: the repository is entirely present, and
// the worktree status and three earlier revision resolutions have already
// succeeded on it. A repo that really goes away still refuses from the steps
// that need it — the status and merge-tree probes both die on their own.
for (const [why, prepare] of [
  ["a repository that never stashed", () => {}],
  ["a stash ref deleted while its reflog survived", (w) => { stashSomething(w); rmSync(join(w, ".git", "refs", "stash")); }],
]) {
  test(`an unsearchable reflog directory reports unknown rather than refusing the whole audit — ${why}, #570`, (t) => {
    if (process.getuid?.() === 0) return t.skip("root searches a 000 directory regardless");
    const c = repo(t);
    prepare(c.w);
    const dir = join(c.w, ".git", "logs", "refs");
    mkdirSync(dir, { recursive: true });
    assert.equal(git(c.w, "stash", "list"), "", "both fixtures must leave the list empty — that is what reaches the probe");
    chmodSync(dir, 0o000);
    const probe = spawnSync("git", ["-C", c.w, "rev-parse", "--path-format=absolute", "--git-path", "logs/refs/stash"], { env: ENV, encoding: "utf8" });
    assert.notEqual(probe.status, 0, "fixture must actually defeat the path resolution — that failure is the whole subject");

    const r = audit(c);
    // Restored here, not in a `t.after`: `repo` registers its own teardown
    // first and node runs them in that order, so an rmSync that cannot recurse
    // into a 000 directory fires before any later hook could reopen it.
    chmodSync(dir, 0o755);
    assert.equal(r.status, 0, `unknown must not gate the audit; got ${r.status} ${r.stderr}`);
    assert.equal(r.jsonError, null, `payload must parse — this used to be zero bytes; got ${r.jsonError?.message}\n${r.stdout}`);
    assert.equal(r.json.stash, null, "the probe could not look, so a number is not a claim it can make");
    assert.equal(stashLine(r), UNREACHED_LINE);
    assert.equal(stashLines(r).length, 1, "exactly one stash-entry line — the ticket's own measured mutation (elif -> fi/if) doubles this state, #1210");
    // The other half of the ruling: this state must not borrow the sentence
    // that asserts what the reflog CONTAINS.
    assert.notEqual(stashLine(r), ORPHAN_LINE);
    // Degrading must not fall through to the confident `0` either: with the
    // path unresolved, the `-s` test that guards the orphan branch is false
    // against an empty string and the trailing branch prints the count.
    assert.doesNotMatch(r.stderr, /stash entries \(repo-global, not gated\): 0$/m);
    // git's own `fatal:` naming the path and the errno is the operator's whole
    // lead on WHICH directory to reopen — the audit's own sentence names none.
    // Unpinned, a `2>/dev/null` on that `rev-parse` deletes it silently: the
    // mutation leaves every other assertion here green (measured).
    assert.match(
      r.stderr,
      /fatal: .*logs\/refs\/stash.*Permission denied/,
      "git's unwrapped diagnostic is the only thing naming the directory",
    );
    // The audit's real subject still answers, which is the point of degrading.
    assert.equal(r.json.clean, true);
    assert.deepEqual(r.json.conflicts, []);
  });
}

// The control that keeps the guard above honest in the other direction, and
// the one state it must NOT reach. Not by the count: an unsearchable
// `logs/refs` empties `git stash list` too — it prints nothing at rc 0
// (measured) — so `$stash` is 0 here exactly as in the rows above. What keeps
// this state off #570's probe is `show-ref refs/stash` still answering rc 0,
// which fails the probe's `sr_rc = 1` guard, so an unsearchable directory
// lands on the existing empty-list unknown line, unchanged.
test("a healthy stash under an unsearchable reflog directory keeps the sentence it already printed, #570", (t) => {
  if (process.getuid?.() === 0) return t.skip("root searches a 000 directory regardless");
  const c = repo(t);
  stashSomething(c.w);
  const dir = join(c.w, ".git", "logs", "refs");
  chmodSync(dir, 0o000);

  const r = audit(c);
  chmodSync(dir, 0o755); // see the sibling above — `repo`'s teardown runs before any `t.after` here
  assert.equal(r.status, 0, `unknown must not gate the audit; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.stash, null);
  assert.equal(stashLine(r), UNKNOWN_LINE, "this state never reaches #570's probe — its line must not move");
  assert.equal(stashLines(r).length, 1, "exactly one stash-entry line — a broken elif chain would let a second one through, #1210");
});

// The other half of #376, and the more expensive one to get wrong. This script
// gates an irreversible action; an operator who sees `unknown` on every run
// stops reading it, and then the three states above go unread too. So the
// accept case is pinned explicitly, across every way a stack empties honestly.
//
// Measured, git 2.50.1: `pop`, `drop`, `clear` and `update-ref -d` each remove
// `.git/logs/refs/stash` outright — there is no lifecycle that empties the
// stack and leaves the reflog behind, which is why the probe can be this
// blunt. The zero-byte row is not reachable that way; it is here because
// `-s` and `-e` differ on exactly it, and a probe testing mere existence
// would turn it into `unknown` for nothing.
for (const [why, prepare] of [
  ["never stashed at all", () => {}],
  // `pop` restores the entry staged, so the fixture has to put the worktree
  // back itself — the audit refuses a dirty one at exit 1 before it ever
  // reaches the stash line.
  ["stashed and popped", (w) => { stashSomething(w); git(w, "stash", "pop", "-q"); git(w, "rm", "-q", "-f", "h.txt"); }],
  ["stashed and dropped", (w) => { stashSomething(w); git(w, "stash", "drop", "-q"); }],
  ["stashed twice and cleared", (w) => { stashSomething(w, "h1.txt"); stashSomething(w, "h2.txt"); git(w, "stash", "clear"); }],
  ["the ref deleted with update-ref, which takes the reflog with it", (w) => { stashSomething(w); git(w, "update-ref", "-d", "refs/stash"); }],
  ["a zero-byte reflog left behind with no ref", (w) => { stashSomething(w); git(w, "stash", "clear"); mkdirSync(join(w, ".git", "logs", "refs"), { recursive: true }); writeFileSync(join(w, ".git", "logs", "refs", "stash"), ""); }],
]) {
  test(`an honestly empty stash still reports a confident zero — ${why}`, (t) => {
    const c = repo(t);
    prepare(c.w);
    assert.equal(git(c.w, "status", "--porcelain"), "", "fixture must leave the worktree clean");
    assert.equal(git(c.w, "stash", "list"), "", "fixture must leave no stash");

    const r = audit(c);
    assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
    assert.equal(r.json.stash, 0, "nothing is recoverable here — reporting `unknown` would be a worse bug than the one #376 fixes");
    assert.equal(stashLine(r), "    stash entries (repo-global, not gated): 0");
    assert.equal(stashLines(r).length, 1, "exactly one stash-entry line — a broken elif chain would let a second one through, #1210");
  });
}

// #306: CHARACTERIZATION TEST, not a spec. The three tests above close every
// unreadable-reflog case that fails LOUDLY enough for the `show-ref`
// cross-check to notice. A reflog that is merely TRUNCATED — some lines
// gone, the rest still parses — is the one case left open, named in-line,
// right above the stash-counting pipeline this exercises, as "a remaining
// ceiling" (grep the phrase rather than a line number — those drift). This
// pins that known undercount so a later change to the block cannot silently
// move it. It does NOT assert desired behavior, and no detection logic is
// being added here — that was ruled out on the issue. If the gap is ever
// closed for real, this test goes red and whoever closed it deletes it
// deliberately; that is the point, not a regression.
test("a truncated-but-parseable stash reflog reports the too-low count as exact — pins a known ceiling, not desired behaviour, #306", (t) => {
  // The citation above is an anchor, not decoration: the phrase it sends the
  // next reader to grep for has to still be in the script.
  assert.match(readFileSync(SCRIPT, "utf8"), /a remaining ceiling/, "no-undo-audit.sh no longer names the ceiling this test cites by phrase");
  const c = repo(t);
  stashSomething(c.w, "h1.txt");
  stashSomething(c.w, "h2.txt");
  stashSomething(c.w, "h3.txt");
  assert.equal(git(c.w, "stash", "list").split("\n").filter(Boolean).length, 3, "fixture must leave three stashes");

  // Drop the oldest reflog line — one per stash push, oldest first. The
  // remaining lines still parse, so `stash list` resolves the ref and
  // returns a shorter-but-nonempty list instead of failing loudly.
  const reflogPath = join(c.w, ".git", "logs", "refs", "stash");
  const lines = readFileSync(reflogPath, "utf8").split("\n").filter(Boolean);
  writeFileSync(reflogPath, lines.slice(1).join("\n") + "\n");

  // The two conditions that make the undercount invisible to the script's own
  // cross-check: the list call itself does not fail, and `show-ref` still
  // finds the ref. Neither signature the three tests above rely on fires.
  const list = spawnSync("git", ["stash", "list"], { cwd: c.w, env: ENV, encoding: "utf8" });
  assert.equal(list.status, 0, `truncation must not make the list call itself fail; got ${list.status} ${list.stderr}`);
  assert.equal(list.stdout.split("\n").filter(Boolean).length, 2, "fixture must leave a nonempty, undercounted list");
  const showRef = spawnSync("git", ["show-ref", "refs/stash"], { cwd: c.w, env: ENV, encoding: "utf8" });
  assert.equal(showRef.status, 0, `refs/stash must still resolve — this is why the cross-check sees no disagreement; got ${showRef.status} ${showRef.stderr}`);

  const r = audit(c);
  assert.equal(r.status, 0, `a truncated reflog must not gate the audit; got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.equal(r.json.stash, 2, "known-wrong: the true count is 3, and this pins the undercount printing as exact rather than `unknown`");
  assert.doesNotMatch(r.stderr, /unknown/, "the cross-check misses this state, which is the whole ceiling");
  assert.equal(stashLine(r), "    stash entries (repo-global, not gated): 2", "the operator-facing line must print the undercount as a plain number");
  assert.equal(stashLines(r).length, 1, "exactly one stash-entry line — a broken elif chain would let a second one through, #1210");
});

// #482: one shape of that ceiling, and the one that is not a ceiling any more.
// Only this half of it — a MISSING non-tip object is skipped in silence at rc 0
// and stays under #306, which is why this fixture corrupts rather than removes.
// Corrupt the loose object behind a NON-TIP entry and the reflog stays
// intact, so `stash list` resolves the ref, prints the entries it could read,
// names the fault and exits 1 — a nonempty list at a nonzero rc, which is the
// one shape none of the `show-ref` states above produce. The cross-check sees
// no disagreement, so the rc is the whole signal, and the old pipeline gave
// `wc`'s status instead of git's. The count printed was short by exactly the
// entries git refused to read.
test("a corrupt loose object behind a non-tip stash entry reports unknown, not the count git could not finish, #482", (t) => {
  const c = repo(t);
  stashSomething(c.w, "h1.txt");
  stashSomething(c.w, "h2.txt");
  stashSomething(c.w, "h3.txt");
  const sha = git(c.w, "rev-parse", "refs/stash@{2}"); // the OLDEST entry, not the tip
  const obj = join(c.w, ".git", "objects", sha.slice(0, 2), sha.slice(2));
  chmodSync(obj, 0o644); // loose objects are mode 444
  writeFileSync(obj, "junk\n");

  // The signature that makes this state its own: git fails, and it fails
  // AFTER printing entries. Measured here rather than asserted in prose,
  // because both halves are what the fix reads and neither is obvious.
  const list = spawnSync("git", ["stash", "list"], { cwd: c.w, env: ENV, encoding: "utf8" });
  assert.equal(list.status, 1, `a corrupt non-tip object must make the list call fail; got ${list.status} ${list.stderr}`);
  assert.equal(list.stdout.split("\n").filter(Boolean).length, 2, "fixture must leave a nonempty, undercounted list — an empty one lands on the show-ref branch instead");
  const showRef = spawnSync("git", ["show-ref", "refs/stash"], { cwd: c.w, env: ENV, encoding: "utf8" });
  assert.equal(showRef.status, 0, `refs/stash must still resolve — this is why the cross-check cannot see it; got ${showRef.status} ${showRef.stderr}`);
  const reflog = readFileSync(join(c.w, ".git", "logs", "refs", "stash"), "utf8").split("\n").filter(Boolean);
  assert.equal(reflog.length, 3, "the reflog is intact — the true count is 3, which is what makes the printed 2 a lie rather than a limit");

  const r = audit(c);
  assert.equal(r.status, 0, `unknown must not gate the audit; got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.equal(r.json.stash, null, "a list call that failed is not a count — the payload must say unknown, never the short number");
  assert.equal(stashLine(r).slice(0, RC_FAILED_LINE.length), RC_FAILED_LINE, "the operator-facing line must name THIS cause, not just say unknown — the other two say the list came back empty, which this state is not");
  assert.match(stashLine(r), /fatal: loose object \S+ .* is corrupt/, "git named the fault outright; the audit must pass it through rather than guess");
  assert.equal(stashLines(r).length, 1, "exactly one stash-entry line — a broken elif chain would let a second one through, #1210");
});

// A stash object that is CORRUPT rather than missing reaches the same branch —
// list empty at rc 1, show-ref rc 0 — but git answers in SEVEN lines there, and
// a bad `objects/info/alternates` both adds three more and puts a backslash in
// them. That fixture is what makes the two hazards of `msg="$msg — $diag";
// echo "$msg"` observable at once: unfolded newlines put git's text at column 0
// where only the audit's own `$ git ...` step headers belong, and `echo` under
// `#!/bin/sh` eats the operator's line from the `\c` onward.
//
// The alternates path also makes git's LATER calls complain at column 0, which
// is why the fold assertion below is scoped to the diagnostic's own text rather
// than to every unindented line.
test("a multi-line diagnostic holding a backslash arrives folded and whole", (t) => {
  const c = repo(t);
  stashSomething(c.w);
  const sha = git(c.w, "rev-parse", "refs/stash");
  const obj = join(c.w, ".git", "objects", sha.slice(0, 2), sha.slice(2));
  chmodSync(obj, 0o644);
  writeFileSync(obj, "junk\n");

  // The rc both comments name for this state, measured rather than asserted in
  // prose (#494). `stash list` FAILS here, unlike the states it stays silent
  // about — and the counting pipeline takes `wc`'s status, so the branch still
  // fires and the rc is discarded. That discard is why a wrong rc in the prose
  // above could sit here for as long as it did without a test noticing.
  const list = spawnSync("git", ["stash", "list"], { cwd: c.w, env: ENV, encoding: "utf8" });
  assert.equal(list.status, 1, `a corrupt tip object must make the list call itself fail; got ${list.status} ${list.stderr}`);

  mkdirSync(join(c.w, ".git", "objects", "info"), { recursive: true });
  writeFileSync(join(c.w, ".git", "objects", "info", "alternates"), "/no\\clue/objects\n");

  const r = audit(c);
  assert.equal(r.json.stash, null, "a corrupt (not missing) stash object must reach the unknown branch too");
  assert.match(stashLine(r), /fatal: loose object \S+ .* is corrupt/, "git named the fault; the audit must not drop it");
  assert.match(
    stashLine(r),
    /\/no\\clue\/objects/,
    "`echo` expands the `\\c` and truncates the line there — the path must arrive verbatim",
  );
  assert.equal(stashLines(r).length, 1, "exactly one stash-entry line — a broken elif chain would let a second one through, #1210");
  const atColumn0 = r.stderr.split("\n").filter((l) => /^\S/.test(l) && /loose object|unable to unpack|inflate/.test(l));
  assert.deepEqual(atColumn0, [], "git's diagnostic belongs folded into the audit's own indented line, never at column 0");
});

// Its own test, not a line inside the behaviour test above: `assert` aborts the
// whole test function, so a prose drift ahead of `audit(c)` would pre-empt this
// file's only coverage of the #304 fold and `printf` hazards, and report the
// comment instead of the behaviour. Measured — with the fold dropped AND the
// comment reverted, the fold regression went unnamed and only the comment was
// reported.
test("no-undo-audit.sh's own comment names the rc the fixture above measures", () => {
  // Bounded to the paragraph under test, not matched against the whole file: an
  // unbounded end lets a later, unrelated occurrence of the phrase satisfy this
  // after the real clause is deleted. Measured — that false green reproduces
  // against an unbounded match and reds here. The gutter comes off before
  // `phrase`'s wrap-tolerant `\s+`, because the clause is hard-wrapped and it is
  // the `#`, not whitespace, that sits at the break.
  const paragraph = between(
    stripHashGutter(readFileSync(SCRIPT, "utf8")),
    "A stash object that is CORRUPT",
    "`printf`, not `echo`",
    "no-undo-audit.sh",
  );
  assert.match(
    paragraph,
    phrase("list empty at rc 1"),
    "no-undo-audit.sh states this same rc in its own comment; the two must not drift apart again",
  );
});

// The other half of #304, and the half a careless append breaks: the `stash
// list` this branch captures says nothing in either permission state, so the
// line must come out exactly as it did before — no trailing separator, no
// empty parenthetical, nothing dangling where the diagnostic would have gone.
// One test for both, because it is one behaviour: an empty capture appends
// nothing. Git as a whole is NOT silent in both — see the narrowing below.
test("the states `stash list` is silent about print the unknown line unchanged", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads a 000 file regardless");
  for (const path of [[".git", "logs", "refs", "stash"], [".git", "refs", "stash"]]) {
    const c = repo(t);
    stashSomething(c.w);
    chmodSync(join(c.w, ...path), 0o000);

    const r = audit(c);
    assert.equal(r.json.stash, null, `${path.join("/")}: fixture must reach the unknown branch`);
    assert.equal(stashLine(r), UNKNOWN_LINE, `${path.join("/")}: git said nothing, so nothing may be appended`);
    assert.equal(stashLines(r).length, 1, `${path.join("/")}: exactly one stash-entry line — a broken elif chain would let a second one through, #1210`);
    // Reflog only. The `stash list` this branch captures is silent in both
    // states, but git as a whole is not: in the `refs/stash` case the
    // `show-ref` cross-check above prints `fatal: git show-ref: bad ref
    // refs/stash (0000…)`, and the audit only looks silent there because that
    // call runs under `>/dev/null 2>&1` (#481). Asserting no `fatal:` over
    // that state would convert an unstated ceiling into an invariant, and make
    // the follow-up edit a passing test.
    if (path.includes("logs")) {
      assert.doesNotMatch(r.stderr, /fatal:|warning:/, "the unreadable reflog is the one state git says nothing about at all");
    }
  }
});

// The count stays reported-only, even at "unknown" — the dirty check is the
// sole gate, and an unreadable reflog must not mask it either.
test("a dirty worktree refuses even when the stash is unknown", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads a 000 file regardless");
  const c = repo(t);
  stashSomething(c.w);
  chmodSync(join(c.w, ".git", "logs", "refs", "stash"), 0o000);
  writeFileSync(join(c.w, "uncommitted.txt"), "work\n");

  const r = audit(c);
  assert.equal(r.status, 1, "unknown must not mask the dirty check, in either direction");
  assert.equal(r.json.clean, false);
  assert.equal(r.json.stash, null);
});

// `clean` is now the sole gate, so a `git status` that fails must not read as a
// clean worktree. It used to have an accidental backstop: a repo holding any
// stash refused anyway, whatever `status` did. That backstop left with the gate.
test("a git status that fails is unanswerable (2), never clean (0)", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads a 000 file regardless");
  const c = repo(t);
  writeFileSync(join(c.w, "uncommitted.txt"), "work that exists nowhere else\n");
  chmodSync(join(c.w, ".git", "index"), 0o000);

  const r = audit(c);
  assert.equal(r.status, 2, "an unreadable index cannot answer the question — it must not answer 'clean'");
  assert.match(r.stderr, /cannot tell a clean worktree from a dirty one/);
  assert.doesNotMatch(r.stdout, /"clean":true/);
});

test("a dirty worktree refuses even when a stash is also present", (t) => {
  const c = repo(t);
  stashSomething(c.w);
  writeFileSync(join(c.w, "uncommitted.txt"), "work\n");

  const r = audit(c);
  assert.equal(r.status, 1, "the stash must not mask the dirty check, in either direction");
  assert.equal(r.json.clean, false);
  assert.equal(r.json.stash, 1);
});

// ---------------------------------------------------------------------------
// conflicts[] and atRisk[]. The refusal above is only half the audit: a clean
// worktree still exits 0 while answering "what would a careless resolution
// eat", and that answer had no coverage at all.
// ---------------------------------------------------------------------------

// One path carries both failures, because they compound. The space made the
// pathspec word-split into `has` + `space.txt`, so `atRisk` came back empty on
// a branch that really was about to eat a commit — a false safe, which is the
// one outcome this script exists to prevent. The quote made the payload
// unparseable, on exit 0, so a caller that got as far as reading the answer
// crashed instead. A path that git has to quote also proves the paths reaching
// the caller are real paths and not git's C-quoted rendering of them.
test("a conflicting path with a space and a quote still names the commits at risk", (t) => {
  const path = 'has"quote and space.txt';
  const c = conflictRepo(t, path);

  const fork = git(c.w, "merge-base", "origin/main", `origin/${c.branch}`);
  const truth = git(c.w, "log", "--oneline", `${fork}..origin/main`, "--", path);
  assert.equal(truth.split("\n").filter(Boolean).length, 1, "fixture must put exactly one main commit at risk");

  const r = audit(c);
  assert.equal(r.status, 0, `a clean worktree passes even with conflicts; got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `a passing audit must emit parseable JSON; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.deepEqual(r.json.conflicts, [path], "the real path, not git's C-quoted rendering of it");
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"], `ground truth was ${truth}`);
  assert.match(r.stderr, /at risk: /);
});

// Same question, asked the other way: an ordinary path must not regress while
// the quoted one is being fixed.
test("a plain conflicting path names the commits at risk", (t) => {
  const c = conflictRepo(t, "plain.txt");

  const r = audit(c);
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.conflicts, ["plain.txt"]);
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"]);
});

// #148: above ARG_MAX, `xargs -0` runs `git log` once per batch of the
// pathspec list, and each invocation reports every commit touching ITS OWN
// batch — so a commit spanning several batches used to come back once per
// batch. `withSplitXargs` forces that split at 20 files instead of the
// thousands real ARG_MAX needs, reproducing the ticket's own measurement
// (`xargs -s 300`) without a ~1 MiB fixture.
//
// Sorted, because the set is the whole claim: once xargs splits, `atRisk` is
// the concatenation of per-batch outputs in PATHSPEC order, not `git log`'s
// reverse-chronological one, and which commit lands first depends on how the
// batch boundaries fall — which depends on the length of the tmpdir path.
// Asserting the emitted order would pin the environment, not the dedupe.
test("two commits spanning the conflicting paths are each named once in atRisk, even when xargs splits the pathspec list into several batches", (t) => {
  const c = manyConflictsTwoCommits(t);
  const xargs = withSplitXargs(t);

  const r = audit(c, { ...ENV, PATH: xargs.path });
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.equal(r.json.conflicts.length, c.paths.length, "fixture must put every file in conflict");
  assert.ok(xargs.batches() > 1, `xargs must actually split — ran git log ${xargs.batches()}x, and at 1 this test passes with the dedupe deleted`);
  assert.deepEqual(
    subjects(r).sort(),
    ["MAIN COMMIT AT RISK, even paths", "MAIN COMMIT AT RISK, odd paths"],
    "each commit named once, not once per xargs batch it lands in",
  );
});

// #522: this pipeline's status is `xargs`' — the last command — not that of the
// `git log` xargs drives, and there is no `pipefail` in POSIX sh to change
// that. So an xargs-side fault reaches the guard, and the guard used to answer
// for it by naming git log, sending the reader to git for a fault git never had.
// Induced with the same shim #148's test uses, at a size that leaves xargs no
// room for the command line at all, so it exits nonzero without running git.
// Only the audit's own line is pinned: the accompanying diagnostic is xargs'
// own and its wording differs between implementations.
test("an xargs-side failure listing the at-risk commits is unanswerable, and does not answer for it by naming git log", (t) => {
  const c = bareConflictRepo(t, "plain.txt");
  const xargs = withSplitXargs(t, 60);

  const r = audit(c, { ...ENV, PATH: xargs.path });
  assert.equal(r.status, 2, `an at-risk list that could not be built is unanswerable, not a verdict; got ${r.status} ${r.stderr}`);
  assert.equal(r.stdout.trim(), "", `exit 2 emits no payload — a payload is an answer; got ${r.stdout}`);
  assert.match(
    r.stderr,
    /listing commits for the conflicting paths failed \(git log or xargs\)/,
    "the guard no longer names both commands that can produce the status it reads",
  );
  assert.doesNotMatch(
    r.stderr,
    /git log failed for the conflicting paths/,
    "the guard is back to blaming git log for a fault that can be xargs' own",
  );
});

/**
 * Shadows `awk` on PATH with a wrapper that fails ONLY the dedupe call this
 * guard reads, and defers to the real awk otherwise — so the earlier
 * stash-counting `awk 'END{print NR}'` keeps working and the fault lands on
 * the one statement under test. Same technique as `withBrokenEscaper`, and
 * for its reason: the call is selected on the at-risk list flowing THROUGH
 * it, never on the program text handed to it. Selecting on the literal
 * `!seen[$1]++` looked equivalent and was not — a behaviour-preserving
 * rewrite to `{if(!seen[$1]++)print}` fell straight through to the real awk,
 * disarming the injection while the test went red as if the `|| die` had
 * regressed (measured).
 *
 * Input is captured to a file and replayed byte-for-byte rather than through
 * `printf`, which would turn the stash call's empty input into one blank line
 * and its `NR` from 0 into 1.
 *
 * `fired` is the residual that selecting on content cannot cover: a rewrite
 * routing the dedupe away from awk altogether still disarms the fault, and
 * without this the run would again red as a guard regression rather than as
 * an injection that never fired.
 */
function withFailingDedupeAwk(t) {
  const bin = mkdtempSync(join(tmpdir(), "no-undo-audit-awk-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const real = execFileSync("sh", ["-c", "command -v awk"], { encoding: "utf8" }).trim();
  writeFileSync(join(bin, "awk"), `#!/bin/sh
f="${bin}/stdin.$$"
cat > "$f"
if grep -qF 'MAIN COMMIT AT RISK' "$f"; then
  : > "${bin}/fired"
  echo "SHIM: forced awk failure for test" >&2
  exit 13
fi
exec ${real} "$@" < "$f"
`);
  chmodSync(join(bin, "awk"), 0o755);
  return { path: `${bin}:${process.env.PATH}`, fired: join(bin, "fired") };
}

// This statement is kept separate from the xargs/git-log pipe above it (see
// the comment ahead of the dedupe line in the script) precisely so an
// awk-side fault is diagnosed by name instead of swallowed into that pipe's
// status. Nothing forced that statement to fail before this test, so the
// separation it documents was unpinned -- deleting the `|| die` left this
// exact fixture green (measured): under `set -eu` a bare
// `at_risk=$(... | awk ...)` still aborts on the shim's exit 13, but with
// awk's own status and no named message, which is what the assertions below
// discriminate from the guard actually firing.
test("an awk-side failure deduplicating the at-risk commits is unanswerable, and names awk rather than the git-log/xargs pipe ahead of it", (t) => {
  const c = bareConflictRepo(t, "plain.txt");

  const awk = withFailingDedupeAwk(t);
  const r = audit(c, { ...ENV, PATH: awk.path });
  assert.ok(existsSync(awk.fired),
    "the fault injection never fired — the at-risk list no longer flows through awk, so every assertion below is measuring an unmutated run");
  assert.equal(r.status, 2, `an at-risk list that could not be deduplicated is unanswerable, not a verdict; got ${r.status} ${r.stderr}`);
  assert.equal(r.stdout.trim(), "", `exit 2 emits no payload -- a payload is an answer; got ${r.stdout}`);
  assert.match(
    r.stderr,
    /awk failed deduplicating the at-risk commits/,
    "the guard must name awk, not fall through to a bare set -e abort",
  );
  assert.doesNotMatch(
    r.stderr,
    /listing commits for the conflicting paths failed \(git log or xargs\)/,
    "an awk-side fault must not be misreported as the git-log/xargs pipe ahead of it",
  );
});

// #583: a POSIX pipeline's status is its LAST command's, so a fault in any
// earlier stage is invisible to `set -e` and to a trailing `|| die` alike. The
// stage that reads merge-tree's output is the one that can fail — measured on
// the locale fault #582 filed, `PIPESTATUS: 1 0 0`, the first stage exiting 1
// and truncating while the two behind it exit 0 on the short input handed to
// them. What came out was a SMALLER conflicts list at exit 0: a false safe from
// the one tool whose job is to say whether a rebase would eat a commit.
//
// The fault is injected on the file rather than on any one command, so the
// pin survives a change of reader: whatever reads merge-tree's output, it must
// refuse when it cannot.
test("merge-tree's output going unreadable at the moment it is read is unanswerable (2), never an empty conflicts list at exit 0", (t) => {
  const c = bareConflictRepo(t, "plain.txt");

  const r = audit(c, { ...ENV, PATH: withUnreadableMergeTreeOutput(t) });
  assert.equal(r.status, 2,
    `a conflicts list that could not be read is unanswerable, not a verdict; got ${r.status} ${r.stderr}`);
  assert.equal(r.stdout.trim(), "",
    `exit 2 emits no payload — an empty conflicts[] here would be a false safe on a branch that really conflicts; got ${r.stdout}`);
  assert.match(r.stderr, /could not read git merge-tree's output \(python3\)/,
    "the guard names the command whose status it actually reads, the way #522 taught the at-risk guard to");
});

// The other half of #583, and the one that rules `set -o pipefail` out even
// where a shell offers it: on a large CORRECT run the reader stops at the empty
// record by design and leaves merge-tree's prose tail unread, so a `tr | tr |
// awk` reads back `141 141 0 0` — two stages killed by SIGPIPE with nothing
// wrong. Adopting a prefix stage's status would refuse this run. It must
// answer, and answer in full.
test("a conflicting run whose unread tail outgrows a pipe buffer still answers, and answers in full", (t) => {
  const c = longTailConflictRepo(t);
  const tail = unreadTailBytes(c);
  assert.ok(tail > 65536,
    `the fixture must leave more unread than a pipe buffer holds, or nothing is being controlled for — left ${tail} bytes`);

  const r = audit(c);
  assert.equal(r.status, 0, `a large correct run is an answer, not a refusal; got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}`);
  assert.deepEqual([...r.json.conflicts].sort(), [...c.paths].sort(),
    "every conflicting path, not the prefix that fitted before the reader stopped");
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"]);
});

// The at-risk half of #583. Its `|| die` reads the status of the LAST command
// in the pipeline that built the pathspec list, so the `printf | sed | tr` that
// once sat ahead of `xargs` could fail and leave `at_risk` short or empty at
// exit 0 — a branch reported as eating nothing while it really was about to.
// The fix is that the list no longer passes through them at all, and this is
// the assertion that says so: break `sed` on the invocation that used to build
// the pathspecs and the answer must be unchanged, because there is no longer
// such an invocation. Restore the pipeline and the decoy commit comes back with
// the real one, since an empty pathspec list leaves `git log` filtering by
// nothing.
//
// `conflictRepo`, not `bareConflictRepo`: the decoys are what make an
// unfiltered `git log` distinguishable from a correctly filtered one. Without
// them the range holds a single commit and the broken run returns the right
// answer for the wrong reason.
test("breaking the sed that used to build the at-risk pathspecs changes nothing, because nothing ahead of xargs can fail unseen", (t) => {
  const c = conflictRepo(t, "plain.txt");

  const r = audit(c, { ...ENV, PATH: withBrokenEscaper(t, { tool: "sed", marker: "plain.txt", selector: "literal" }) });
  assert.equal(r.status, 0, `nothing failed, so nothing is unanswerable; got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}`);
  assert.deepEqual(r.json.conflicts, ["plain.txt"]);
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"],
    "the decoys are back, which means the pathspec list went through something that could fail without the guard hearing it");
});

// A temporary the audit cannot create is a question it cannot answer, and the
// exit code has to say so: bare `set -eu` would abort with mktemp's own 1,
// which out of THIS script is the dirty-worktree refusal — fabricated on a
// worktree already measured clean, with no payload and nothing on stderr.
//
// The last assertion is about the abort PATH, not the verdict, and it is the
// one that needs saying: the fault lands between the two `mktemp` calls, so a
// cleanup trap armed after both would not yet exist when this run dies, and the
// temporary the first call created would outlive it. Exit code and message are
// both correct in that world, which is why they cannot be the whole pin —
// asking whether the file is gone is the only question that separates a trap
// armed early enough from one armed too late.
test("a temporary file the at-risk step cannot create is unanswerable (2), never the refusal that means dirty", (t) => {
  const c = bareConflictRepo(t, "plain.txt");

  const m = withLaterMktempFailing(t);
  const r = audit(c, { ...ENV, PATH: m.path });
  assert.equal(r.status, 2,
    `the worktree is clean and was measured clean — exit 1 here would report it dirty on the strength of a full TMPDIR; got ${r.status} ${r.stderr}`);
  assert.equal(r.stdout.trim(), "", `exit 2 emits no payload; got ${r.stdout}`);
  assert.match(r.stderr, /cannot create a temporary file/,
    "and it names the cause rather than exiting silently");

  const first = readFileSync(m.firstTemp, "utf8").trim();
  assert.ok(first, "the shim must have recorded the temporary the first call handed back, or the check below proves nothing");
  assert.equal(existsSync(first), false,
    `the temporary created before the failing call has to be cleaned up by the abort that follows it, or a run that dies here leaks one; ${first} survived`);
});

// #146: a BS, tab, FF, CR or DEL in a conflicting path used to be replaced
// with a space, so `conflicts[]` named a file that exists nowhere on disk —
// this is the case the ticket itself measured. RFC 8259 gives short forms to
// all four control bytes (\b \t \f \r) and DEL (\177) is not a C0 byte at
// all, so all five must round-trip, and `conflictsRewritten` must say so. BS
// and FF are here because the first version of this fix scrubbed them anyway.
test("a conflicting path with a BS, a tab, a FF, a CR and a DEL round-trips and is not flagged rewritten", (t) => {
  const path = "has\bbs\ttab\fff\rcr\x7fdel.txt";
  const c = conflictRepo(t, path);

  const r = audit(c);
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.deepEqual(r.json.conflicts, [path], "the real path, byte for byte — this is what a consumer pastes into `git diff --`");
  assert.deepEqual(r.json.conflictsRewritten, [false], "escaped or preserved, not replaced");
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"]);
});

// The other half: a byte with no JSON short form still has to be replaced —
// unlike tab/CR/DEL, JSON has nowhere to put it — but the payload must now say
// so, since the runbook step that pastes `conflicts[]` into a diff command must
// skip exactly this path.
// \013 (VT) rides along with \002: it is the C0 byte that looks like it has a
// short form and does not — RFC 8259 lists no \v — so narrowing the scrub set
// to make room for \b and \f must not take VT out with them. Unescaped in a
// JSON string it is a parse error, so `jsonError` is the discriminator.
test("a conflicting path with bytes that have no short form is replaced and flagged rewritten", (t) => {
  const path = "has\x02bell\x0bvt.txt";
  const c = conflictRepo(t, path);

  const r = audit(c);
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.deepEqual(r.json.conflicts, ["has bell vt.txt"], "no short form for \\002 or \\013 — both still neutralised to a space");
  assert.deepEqual(r.json.conflictsRewritten, [true], "and the payload must disclose that it was");
});

// `--` ends the options, not the pathspec magic, so a real file named
// `:colon.txt` is parsed as a pathspec expression and matches nothing. Same
// false safe as the space, reached by a different byte, and `:(literal)` is
// what closes it.
test("a conflicting path that looks like pathspec magic names the commits at risk", (t) => {
  const path = ":colon.txt";
  const c = conflictRepo(t, path);

  const r = audit(c);
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.deepEqual(r.json.conflicts, [path]);
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"], "a leading `:` must be matched literally, not as magic");
});

// #582: `tr` is locale-sensitive, and under a UTF-8 locale BSD tr exits 1 on a
// byte that is not valid UTF-8. What that cost was measured on the `tr | tr |
// awk` that used to split merge-tree's output, where the FIRST stage was the
// one that failed — PIPESTATUS `1 0 0`, the second `tr` and `awk` both exiting
// 0 on the short input it handed them — so the real status sat in a non-final
// slot where `set -e` could not see it (the pipeline's status was awk's) and
// where the line carried no `|| die` of its own either. `conflicts` came back
// holding the single truncated entry `b`, `plain.txt` was dropped from the list
// entirely, `atRisk` was `[]`, and the audit exited 0: a false safe from the one
// tool whose whole job is to say whether a rebase would eat a commit, which is
// the outcome the comment above `conflicts=` says must be exit 2.
// `export LC_ALL=C` is the fix, and it is the convention inflight.sh already
// follows, both globally and per site.
//
// Past tense throughout, because that mechanism is no longer here to reproduce:
// #583 replaced the split with a single byte-oriented reader whose status
// nothing discards, so the pin is not what stands between that byte and a false
// safe on this path any more. The assertions below are unchanged by that —
// they assert the correct ANSWER, which is what both the split and the reader
// owe.
//
// WHAT KILLS THE MUTANT TODAY IS NOT THE MECHANISM ABOVE, and the difference
// matters to anyone tidying the script. Measured on this tree, with the pin
// deleted: the reader parses both conflicting paths correctly whatever the
// locale, and the run then dies further down, when the `conflict: ` render that
// prints them to stderr crashes on the byte — `sed: RE error: illegal byte
// sequence`, and the script exits 1 rather than reporting a short list at 0.
// So this test's kill now rests on a diagnostic render that decides nothing,
// carries no `|| die`, and reads like safe cleanup. Neutralise or remove that
// render and the mutant stops dying, with nothing going red to say so. #1160
// tracks that render's own defect — it aborts a clean audit with the status
// that means dirty — and carries the same warning in the other direction:
// whoever fixes it must give this test a new kill mechanism first.
//
// The locale goes in as `LANG`, with `LC_ALL` explicitly UNSET, and both halves
// are load-bearing. Explicit rather than inherited, because a suite that takes
// whatever the runner happens to export pins nothing at all — same reasoning,
// and same technique, as inflight.test.mjs' own locale test. `LANG` rather than
// `LC_ALL`, because passing `LC_ALL` in puts it in the child's environment
// BEFORE the script runs, and a POSIX shell keeps a variable's export attribute
// once it is already there: a plain `LC_ALL=C` with the `export` keyword
// dropped would still reach `tr`, and these tests would go on passing against a
// script that exports nothing. Measured both ways — under
// `{ LC_ALL: "en_US.UTF-8" }` that mutant survives, under this shape it dies.
// It is also the honest shape: the ambient failure is an operator's
// `LANG=en_US.UTF-8` with `LC_ALL` unset.
//
// Platform ceiling, stated rather than hidden: BSD tr — macOS, the fleet's own
// platform — rejects the byte, while GNU tr is byte-oriented and accepts it, so
// on Linux the unpatched script already answers correctly and this test passes
// with or without the pin. Measured under a full GNU toolchain (coreutils 9.11,
// gnu-sed 4.10, gawk 5.4.1 ahead of PATH): the whole file stays green with
// `export LC_ALL=C` deleted. This test asserts the correct ANSWER, which is
// right on both platforms; only the macOS run kills the mutant. `ci.yml` runs
// ubuntu-latest, so the half CI can check is the source assertion in
// locale-pin-prose.test.mjs, not this one.
test("a conflicting path holding an invalid-UTF-8 byte still names every conflict and every commit at risk under an ambient UTF-8 locale", (t) => {
  const c = byteConflictRepo(t, "b\\377ad.txt");

  const r = audit(c, { ...ENV, LANG: "en_US.UTF-8", LC_ALL: undefined });
  assert.equal(r.status, 0, `a clean worktree passes even with conflicts; got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.equal(r.json.conflicts.length, 2,
    `both conflicting paths, not a list truncated at the bad byte; got ${JSON.stringify(r.json.conflicts)}`);
  assert.equal(r.json.conflicts[1], "plain.txt",
    "the path AFTER the bad one is what truncation drops, and dropping it silently is the false safe");
  assert.match(r.json.conflicts[0], /^b.ad\.txt$/, "the bad path arrives whole, not cut down to `b`");
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"],
    "and the commit a careless resolution would eat is named, rather than atRisk: [] at exit 0");
});

// #613: the test above parses the payload through `audit()`'s
// `encoding: "utf8"`, and Node decodes a child's stdout as UTF-8 LOSSILY on
// the way in — the same silent U+FFFD substitution `jq` performs — so it
// cannot tell "the script emitted valid UTF-8" from "the script emitted a raw
// invalid byte and Node papered over it before JSON.parse ever saw it". This
// reads the raw bytes instead and checks them against the two consumers the
// issue measured: `jq`, which substitutes U+FFFD silently at exit 0
// (corrupting the data without saying so), and `python3 json.load`, a strict
// parser that refuses the payload outright with `UnicodeDecodeError`. Both
// must now accept the SAME bytes the script wrote, and the field naming which
// element lost a byte must say so honestly rather than silently.
test("a conflicting path holding an invalid-UTF-8 byte round-trips as valid, parseable UTF-8 JSON, with the fault flagged rather than hidden (#613)", (t) => {
  const c = byteConflictRepo(t, "b\\377ad.txt");

  const r = spawnSync("sh", [SCRIPT, c.w, c.branch], { env: ENV, encoding: "buffer" });
  assert.equal(r.status, 0,
    `a clean worktree passes even with conflicts; got ${r.status} ${r.stderr?.toString("utf8")}`);
  const raw = r.stdout;

  // Round-trip validity: re-encoding what a lossy UTF-8 decode produces
  // reproduces the same bytes only when the buffer was already valid UTF-8.
  assert.deepEqual(Buffer.from(raw.toString("utf8"), "utf8"), raw,
    "the audit's own stdout is not valid UTF-8 — a raw invalid byte reached the payload");

  // `jq -e '.'` cannot pin the #613 bug on its own — it is one of the two
  // LENIENT consumers the issue names, silently substituting U+FFFD at exit 0
  // on a raw invalid byte just like Node's own decode above, so it would
  // exit 0 against the pre-fix payload too. The round-trip check above and
  // the strict `python3 json.load` below are what actually pin validity;
  // this only confirms a real downstream consumer of this payload (several
  // fleet scripts pipe conflicts/atRisk through jq) can parse it as
  // well-formed JSON at all.
  const jq = spawnSync("jq", ["-e", "."], { input: raw });
  assert.equal(jq.status, 0, `jq must accept the payload as well-formed JSON; stderr: ${jq.stderr?.toString("utf8")}`);

  const py = spawnSync("python3", ["-c", "import json,sys; json.load(sys.stdin.buffer)"], { input: raw });
  assert.equal(py.status, 0,
    `a strict UTF-8 JSON parser must accept the payload; stderr: ${py.stderr?.toString("utf8")}`);

  const json = JSON.parse(raw.toString("utf8"));
  assert.equal(json.conflicts.length, 2, "both conflicting paths are present");
  assert.match(json.conflicts[0], /^b.ad\.txt$/, "the bad path arrives whole, not cut down to `b`");
  assert.equal(json.conflicts[0].includes("�"), true,
    "the fault must render as U+FFFD, not the original invalid byte and not silence");
  assert.equal(json.conflictsRewritten[0], true,
    "the path that lost a byte to U+FFFD must be flagged rewritten — a caller must not treat it as the real path");
  assert.equal(json.conflictsRewritten[1], false, "the untouched path must not be flagged");
});

// The other half of the same pin, and the half a fix-only suite never covers:
// what does `export LC_ALL=C` now REFUSE? It makes every `tr`, `sed` and `awk`
// in the script byte-oriented, so a path of legitimate multi-byte UTF-8 must
// still round-trip whole and must NOT be flagged rewritten. Every scrub set in
// this script is \001-\037 and every byte of a multi-byte UTF-8 sequence is
// >= \200 — the script's own jstr comment says so — so the pin cannot reach it.
// This is the test that keeps that true.
//
// Built through the same shell-side `printf` as the invalid case rather than
// through `conflictRepo`: written to disk, the name goes through the
// filesystem's Unicode normalisation, and `caf\303\251.txt` (NFC) can come back
// NFD — a byte-for-byte assertion failing for a reason that has nothing to do
// with this script.
test("a conflicting path of valid multi-byte UTF-8 round-trips whole under the pinned locale and is not flagged rewritten", (t) => {
  const c = byteConflictRepo(t, "caf\\303\\251.txt");

  const r = audit(c, { ...ENV, LANG: "en_US.UTF-8", LC_ALL: undefined });
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.deepEqual(r.json.conflicts, ["café.txt", "plain.txt"],
    "byte for byte — this is what a consumer pastes into `git diff --`");
  assert.deepEqual(r.json.conflictsRewritten, [false, false],
    "a byte >= \\200 is outside every scrub set, and pinning the locale must not change that");
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"]);
});

// A commit subject is free text, so it reaches the payload with whatever the
// author typed. `\` matters as much as `"`: escaping the quote first and the
// backslash second turns `\` into `\\` twice over, so the order is load-bearing
// and only a subject holding both can tell a correct pipeline from that one.
// The \x01 rides along because git stores control bytes in a subject happily and
// JSON forbids them unescaped — dropping the scrub leaves the payload
// unparseable, which is this PR's own defect class one byte over.
// `$conflicts` and `$at_risk` are the last two operands carrying caller text,
// and `$at_risk` is the most reachable of the whole class: it holds
// `git log --oneline` output, so an ordinary commit subject is enough — no
// corrupt repo, no exotic filename. It is also the audit's most consequential
// line, the commits a careless resolution deletes. One fixture pins both.
test("a backslash escape in a conflicting path and in an at-risk subject reaches the operator whole", (t) => {
  const c = conflictRepo(t, "back\\clue.txt");
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, "back\\clue.txt"), "MAIN AGAIN\n");
  git(c.w, "commit", "-q", "-am", "fix: the \\connection retry");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);

  const r = audit(c);
  assert.equal(r.status, 0, `fixture must be clean; got ${r.status} ${r.stderr}`);
  assert.match(r.stderr, /^    conflict: back\\clue\.txt$/m, "`echo` truncates the conflict line at the `\\c`");
  assert.match(r.stderr, /^    at risk: \S+ fix: the \\connection retry$/m, "`echo` truncates the at-risk line at the `\\c` — an ordinary commit subject is enough to lose it");
});

test("a quote, a backslash and a control byte in a commit subject keep the payload parseable", (t) => {
  const c = conflictRepo(t, "plain.txt");
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, "plain.txt"), "MAIN AGAIN\n");
  git(c.w, "commit", "-q", "-am", 'fix: the "quoted" back\\slash \x01 case');
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);
  assert.match(git(c.w, "log", "-1", "--pretty=%s", "origin/main"), /\x01/, "fixture must keep the control byte in the subject");

  const r = audit(c);
  assert.equal(r.status, 0);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.ok(
    r.json.atRisk.some((l) => l.includes('the "quoted" back\\slash   case')),
    `the subject must survive escaping verbatim, the control byte scrubbed to a space; got ${JSON.stringify(r.json.atRisk)}`,
  );
  assert.deepEqual(r.json.atRiskRewritten, [true, false], "\\001 has no JSON short form — the payload must disclose the scrub");
});

// #146: BS, tab, FF, CR and DEL in a commit subject get the opposite treatment
// from \x01 above — four now have JSON short forms and the fifth is not a C0
// byte at all, so all five must round-trip in atRisk[] too, and none may flag
// the entry as rewritten.
test("a BS, a tab, a FF, a CR and a DEL in a commit subject round-trip in atRisk without being flagged rewritten", (t) => {
  const c = conflictRepo(t, "plain.txt");
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, "plain.txt"), "MAIN AGAIN\n");
  git(c.w, "commit", "-q", "-am", "fix: has\bbs\ttab\fff\rcr\x7fdel case");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);

  const r = audit(c);
  assert.equal(r.status, 0);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.ok(
    r.json.atRisk.some((l) => l.includes("has\bbs\ttab\fff\rcr\x7fdel case")),
    `all five bytes must survive verbatim; got ${JSON.stringify(r.json.atRisk)}`,
  );
  assert.deepEqual(r.json.atRiskRewritten, [false, false]);
});

// git accepts `"` in a ref name and every byte but NUL and `/` in a path
// component, so both of these are names a caller can really hand over. `\` is
// rejected in a ref but legal in a path, which is why the backslash rides on
// the worktree.
test("a quote in the branch and a backslash in the worktree path keep the payload parseable", (t) => {
  const c = repo(t, 'fix/1-say"hi', 'no-undo-audit-back\\slash-say"hi-');

  const r = audit(c);
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.equal(r.json.branch, 'fix/1-say"hi');
  assert.equal(r.json.worktree, c.w);
  assert.equal(r.json.branchRewritten, false);
  assert.equal(r.json.worktreeRewritten, false);
});

// #146, the scalar fields: git forbids control bytes in a ref outright, so
// `branch` cannot carry one — but `worktree` is a filesystem path, the same
// vector as the conflicting-path cases above. Tab, CR and DEL must round-trip
// there too, and a byte with no short form must still be replaced and flagged.
test("a BS, a tab, a FF, a CR and a DEL in the worktree path round-trip and are not flagged rewritten", (t) => {
  const c = repo(t, "fix/1-thing", "no-undo-audit-has\bbs\ttab\fff\rcr\x7fdel-");

  const r = audit(c);
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.equal(r.json.worktree, c.w, "BS, tab, FF, CR and DEL must all survive intact");
  assert.equal(r.json.worktreeRewritten, false);
});

// The multi-line half of #146. `wt` is argv $1, a filesystem path, and a
// directory name may hold a newline where a ref may not — so this is the one
// input json.sh's `jstr` receives as more than one line from any live caller.
// It is
// what the `:a;$!N;$!ba` slurp and the `s/\n/\\n/g` rule exist for: without
// the slurp sed cycles once per LINE and the LF rule never sees the byte, so
// the payload carries a raw newline inside a JSON string and no parser accepts
// it. Deleting either half left the whole suite green before this test.
//
// The same value cannot be driven through release-ticket.sh or inflight.sh:
// release-ticket reaches `awk -v b="refs/heads/$branch"` first and awk refuses
// a newline in a -v value (rc 2, before any receipt); its only other
// interpolated message is the pair of `halt` calls that already flatten git's
// stderr with `tr '\n' ' '`; and inflight builds every evidence string from
// line-oriented git output. (No line numbers: #129 tracks five citations in
// these files that have already drifted, one of them mid-review here.)
// Since #119 there is one `jstr`, in json.sh, rather than three copies: those
// two callers reach the shared slurp with values that can never be multi-line,
// so this test is still the only place a real value exercises it.
test("a newline in the worktree path round-trips as an escaped \\n", (t) => {
  const c = repo(t, "fix/1-thing", "no-undo-audit-has\nnewline-");

  const r = audit(c);
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.equal(r.json.worktree, c.w, "the newline arrives escaped, and the path comes back byte for byte");
  assert.equal(r.json.worktreeRewritten, false, "escaped, not replaced — \\012 is not in the scrub set");
});

test("bytes with no short form in the worktree path are replaced and flagged rewritten", (t) => {
  // \013 (VT) alongside \002 for the same reason as the conflicting-path case:
  // RFC 8259 has no \v, so VT must stay in the scrub set after \b and \f left it.
  const c = repo(t, "fix/1-thing", "no-undo-audit-has\x02bell\x0bvt-");

  const r = audit(c);
  assert.equal(r.status, 0, `got ${r.status} ${r.stderr}`);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.equal(r.json.worktree, c.w.replace("\x02", " ").replace("\x0b", " "), "no short form for \\002 or \\013 — both still neutralised to a space");
  assert.equal(r.json.worktreeRewritten, true, "and the payload must disclose that it was");
});

// ---------------------------------------------------------------------------
// Exit 2. Every one of these is "the question could not be answered"; none of
// them may reach the payload, because a payload is an answer.
// ---------------------------------------------------------------------------

// `rev-parse --verify` resolves a tag to an object of ANY type, so a tag on a
// blob walks straight past it and into merge-tree, which refuses to merge it.
// git 2.50.1 spends exit 1 on that refusal — the same code it spends on "ran
// fine, found conflicts" — so the exit code alone cannot tell them apart and
// the audit used to print `"conflicts":[],"atRisk":[]` and exit 0. Safe, on a
// question it never asked.
// The section split reads an empty line as the end of the filename list, so a
// path holding a literal newline manufactures that marker: the list comes back
// short — sometimes empty — and the audit exits 0 saying nothing is at risk.
// git C-quoted such a path before `-z`, which at least emitted JSON the caller
// choked on, so answering "safe" here would be a strict downgrade. A shell
// variable cannot hold NUL, so the only honest answer is that there isn't one.
test("a conflicting path containing a newline is unanswerable (2), never safe (0)", (t) => {
  const c = bareConflictRepo(t, "lead\nline.txt");
  writeFileSync(join(c.w, "zz.txt"), "branch side\n");
  git(c.w, "add", "--", "zz.txt");
  git(c.w, "commit", "-q", "-m", "branch adds a second file");
  git(c.w, "push", "-q", "origin", c.branch);
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, "zz.txt"), "MAIN SIDE\n");
  git(c.w, "add", "--", "zz.txt");
  git(c.w, "commit", "-q", "-m", "MAIN ALSO AT RISK");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);

  const r = audit(c);
  assert.equal(r.status, 2, `got ${r.status} with stdout ${r.stdout}`);
  assert.equal(r.stdout, "", "an unanswerable audit must not emit a payload");
  assert.match(r.stderr, /contains a newline/);
});

// merge-tree refuses unrelated histories at exit 128. Note what this does NOT
// pin: that refusal also writes nothing, so `[ -s ]` alone catches it and the
// `mt_rc` half of the guard can be deleted with the suite staying green
// (measured). No reachable input produces a bad exit code AND output, so the
// code check is there for a git that prints the tree OID and then fails.
test("unrelated histories are unanswerable (2), never safe (0)", (t) => {
  const c = repo(t);
  git(c.w, "checkout", "-q", "--orphan", "orphan");
  git(c.w, "rm", "-rq", "--cached", ".");
  writeFileSync(join(c.w, "o.txt"), "no shared ancestor\n");
  git(c.w, "add", "--", "o.txt");
  git(c.w, "commit", "-q", "-m", "orphan root");
  git(c.w, "push", "-q", "origin", "orphan");
  git(c.w, "checkout", "-qf", "main");
  git(c.w, "clean", "-qfd");

  const r = audit({ w: c.w, branch: "orphan" });
  assert.equal(r.status, 2, `got ${r.status} with stdout ${r.stdout}`);
  assert.equal(r.stdout, "", "an unanswerable audit must not emit a payload");
  assert.match(r.stderr, /cannot determine conflicts/);
});

test("a BASE_REF that dereferences to a blob is unanswerable (2), never safe (0)", (t) => {
  const c = repo(t);
  const blob = git(c.w, "hash-object", "-w", "f.txt");
  git(c.w, "tag", "blobtag", blob);
  assert.equal(git(c.w, "rev-parse", "--verify", "--quiet", "blobtag"), blob, "fixture must pass the rev-parse guard");

  const r = audit(c, { ...ENV, BASE_REF: "blobtag" });
  assert.equal(r.status, 2, `merge-tree could not answer; got ${r.status} with stdout ${r.stdout}`);
  assert.doesNotMatch(r.stdout, /"conflicts"/, "an unanswerable audit must not emit a payload");
  assert.match(r.stderr, /cannot determine conflicts/);
});

test("every unanswerable precondition exits 2 and emits no payload", (t) => {
  const c = repo(t);
  const plain = mkdtempSync(join(tmpdir(), "no-undo-audit-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));

  const cases = [
    ["too few arguments", [c.w], ENV, /usage:/],
    ["too many arguments", [c.w, c.branch, "extra"], ENV, /usage:/],
    ["worktree does not exist", [join(c.w, "nope"), c.branch], ENV, /does not exist/],
    ["not a git worktree", [plain, c.branch], ENV, /is not a git worktree/],
    ["branch never pushed", [c.w, "never-pushed"], ENV, /origin\/never-pushed does not resolve/],
    ["BASE_REF does not resolve", [c.w, c.branch], { ...ENV, BASE_REF: "no/such/ref" }, /does not resolve/],
  ];

  for (const [why, args, env, re] of cases) {
    const r = spawnSync("sh", [SCRIPT, ...args], { cwd: c.w, env, encoding: "utf8" });
    assert.equal(r.status, 2, `${why}: expected 2, got ${r.status} — ${r.stderr}`);
    assert.match(r.stderr, re, why);
    assert.equal(r.stdout, "", `${why}: an unanswerable audit must not emit a payload`);
  }
});

// ---------------------------------------------------------------------------
// Whose worktree is the answer about. Exit 2 again for the refusals, but the
// question is upstream of every check above: the script has to be looking at
// the tree it was handed. The passing case closes the block, because a guard
// that establishes identity is one keystroke from refusing every real worktree.
// ---------------------------------------------------------------------------

// The `is not a git worktree` case in the preconditions above passes a plain
// directory with no repo ANYWHERE above it, so `rev-parse --git-dir` fails and
// the script refuses. That is the harmless half. These are the other half:
// `rev-parse --git-dir` WALKS UP, so with an enclosing repo present the gate
// passes at rc 0 having resolved a git dir that is not this worktree's, and
// `status --porcelain` then answers for that repo — empty, at rc 0, because the
// enclosing repo is clean and `.worktrees/` is gitignored. `clean:true` for a
// tree the script never looked at, with the work still sitting on disk. The
// `die` on a failing status is the wrong side of this: the command SUCCEEDS,
// it just answers about somewhere else.
//
// Both assert the refusal lands BEFORE the audit reports anything. Exit 2 alone
// would not pin it — a script that audits, prints "clean", and refuses
// afterwards has already put the wrong answer on the caller's screen.
function refusedAsUnknownBeforeAnySay(c) {
  assert.ok(existsSync(join(c.w, "precious.txt")), "fixture: the uncommitted work must still be on disk");
  assert.equal(git(c.parent, "status", "--porcelain"), "", "fixture: a CLEAN enclosing repo is what makes the leak answer 'clean'");
  assert.doesNotThrow(
    () => git(c.w, "rev-parse", "--git-dir"),
    "fixture: the script's own gate must still pass here, or this test pins nothing",
  );
  assert.equal(git(c.w, "status", "--porcelain"), "", "fixture: git answers for the enclosing repo — the manufactured clean this must refuse");

  const r = audit(c);
  assert.equal(r.status, 2, `got ${r.status} with stdout ${r.stdout}`);
  assert.equal(r.stdout, "", "an unanswerable audit must not emit a payload");
  assert.doesNotMatch(r.stderr, /status --porcelain/, "the refusal must land before the audit runs, let alone reports");
  assert.match(r.stderr, /answers for the repo above/);
}

test("a worktree whose .git was deleted is unanswerable (2), never clean (0)", (t) => {
  const c = nestedWorktree(t);
  rmSync(join(c.w, ".git"));

  refusedAsUnknownBeforeAnySay(c);
});

// One byte over: an EMPTY `.git` DIRECTORY is something a `-e "$wt/.git"` guard
// calls present, and git walks up past it exactly as it does past an absent one.
test("a worktree whose .git is an empty directory is unanswerable (2), never clean (0)", (t) => {
  const c = nestedWorktree(t);
  rmSync(join(c.w, ".git"));
  mkdirSync(join(c.w, ".git"));
  assert.ok(existsSync(join(c.w, ".git")), "fixture: a `-e` guard must call this .git present, or it pins the case above again");

  refusedAsUnknownBeforeAnySay(c);
});

// And one byte over again, which is why the guard asks git instead of stat-ing
// `.git`: a DIRECTORY holding a lone HEAD. Every "does the linkage exist" guard
// spelled against the filesystem calls this present — `-e "$wt/.git/HEAD"` most
// obviously — and git still walks up, because it wants HEAD *and* `objects/`
// *and* `refs/` before it will call a directory a git dir. Each subset below
// manufactured `clean:true` at exit 0 against such a guard (measured, git
// 2.50.1); the last is a REAL `.git` whose HEAD an interrupted write truncated,
// so this is not only a hand-built shape.
for (const [why, build] of [
  ["holding a lone HEAD", (g) => writeFileSync(join(g, "HEAD"), "ref: refs/heads/fix/9-nested\n")],
  ["whose HEAD is empty", (g) => writeFileSync(join(g, "HEAD"), "")],
  ["missing objects/", (g) => {
    writeFileSync(join(g, "HEAD"), "ref: refs/heads/fix/9-nested\n");
    mkdirSync(join(g, "refs"));
  }],
]) {
  test(`a worktree whose .git is a directory ${why} is unanswerable (2), never clean (0)`, (t) => {
    const c = nestedWorktree(t);
    rmSync(join(c.w, ".git"));
    mkdirSync(join(c.w, ".git"));
    build(join(c.w, ".git"));
    assert.ok(existsSync(join(c.w, ".git", "HEAD")), "fixture: HEAD must be present, or this pins the empty-directory case again");

    refusedAsUnknownBeforeAnySay(c);
  });
}

// The other direction, and it is not theory: a guard spelled `-e
// "$wt/.git/HEAD"` alone passes every refusal test above (measured) while
// refusing every LINKED worktree on disk, whose `.git` is a file and which
// therefore has no `.git/HEAD` to stat. That is the fleet's own shape —
// `claim-ticket.sh` makes worktrees with `git worktree add` — so the false
// refusal would land on every real caller while the suite stayed green. This
// pins the shape the refusal tests do not reach.
test("an intact linked worktree, whose .git is a file, still passes", (t) => {
  const c = nestedWorktree(t);
  rmSync(join(c.w, "precious.txt"));
  assert.ok(statSync(join(c.w, ".git")).isFile(), "fixture must leave the linkage intact, and leave it a FILE — the shape this test exists to pin");
  assert.equal(git(c.w, "status", "--porcelain"), "", "fixture must leave the worktree clean");

  const r = audit(c);
  assert.equal(r.status, 0, `a linked worktree is the fleet's own shape; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.clean, true);
});

// The same worktree, reached through a symlinked path. `--show-toplevel`
// resolves the symlink away and would make this look identical to the case
// above by construction — the reason the linkage guard never string-compares
// against it (see the comment ahead of the guard itself).
test("an intact linked worktree, reached through a symlinked path, still passes", (t) => {
  const c = nestedWorktree(t);
  rmSync(join(c.w, "precious.txt"));
  const link = `${c.w}-symlink`;
  symlinkSync(c.w, link);
  t.after(() => rmSync(link, { force: true }));

  const r = audit({ w: link, branch: c.branch });
  assert.equal(r.status, 0, `a symlinked path to a real worktree must still pass; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.clean, true);
});

// ---------------------------------------------------------------------------
// #189: whose ADMIN DIR answered, not just whose ROOT git resolved. A `.git`
// FILE takes its root from the file's own location, so a `.git` rewritten to
// name a SIBLING worktree's admin dir still passes --show-prefix — the root
// is genuinely $wt — while status is computed against the sibling's HEAD and
// index. Every case below refuses via `die`, exit 2, no payload: the guard
// establishes identity BEFORE the audit runs, same as the --show-prefix block
// above it, never a warning printed alongside a "clean" answer.
// ---------------------------------------------------------------------------

test("a .git file naming a sibling worktree's admin dir is refused, never clean — the ticket's repro", (t) => {
  const c = nestedWorktreePair(t);
  assert.ok(existsSync(join(c.w, "precious.txt")), "fixture: uncommitted work must still be on disk");
  // The ticket's leak needs more than an empty prefix: `status` is computed
  // against the sibling's INDEX, but the WORKING TREE stays $wt's own files
  // on disk (a `.git` file redirects the git-dir, not the work-tree). Content
  // collision is what makes that read clean — the sibling commits the exact
  // bytes $wt already has sitting there uncommitted.
  writeFileSync(join(c.sibling, "precious.txt"), readFileSync(join(c.w, "precious.txt")));
  git(c.sibling, "add", "precious.txt");
  git(c.sibling, "commit", "-q", "-m", "precious.txt, committed here and only here");
  writeFileSync(join(c.w, ".git"), `gitdir: ${c.siblingAdmin}\n`);
  // The spoof still resolves a root of $wt and a foreign, CLEAN HEAD/index —
  // the exact leak the ticket measured, reproduced before asserting the fix.
  assert.equal(git(c.w, "rev-parse", "--show-prefix"), "", "fixture: the root claim must still admit, or this pins nothing new");
  assert.equal(git(c.w, "status", "--porcelain"), "", "fixture: the sibling's HEAD must read clean, or this is the old leak by a different name");

  const r = audit(c);
  assert.equal(r.status, 2, `must be unanswerable, not clean; got ${r.status} ${r.stdout}`);
  assert.equal(r.stdout, "", "an unanswerable audit must not emit a payload");
  assert.match(r.stderr, /names another worktree's admin dir/);
});

test("a .git file naming a sibling's admin dir by a RELATIVE gitdir: path is refused the same way", (t) => {
  const c = nestedWorktreePair(t);
  // Relative to $wt/.git's own directory, i.e. $wt itself — same shape git
  // itself resolves relative gitdir: lines against. Spelled as the literal the
  // fixture's own layout already fixes, rather than computed: the assertion
  // below is what keeps it honest, since a wrong spelling resolves elsewhere
  // and fails there loudly.
  writeFileSync(join(c.w, ".git"), "gitdir: ../../.git/worktrees/8-y\n");
  assert.equal(git(c.w, "rev-parse", "--git-dir"), c.siblingAdmin, "fixture: git must resolve the relative spoof to the sibling admin dir, or this pins nothing new");

  const r = audit(c);
  assert.equal(r.status, 2, `must be unanswerable, not clean; got ${r.status} ${r.stdout}`);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /names another worktree's admin dir/);
});

// The same spoof, spelled as a SYMLINK instead of a `gitdir:` file. It is not a
// variant of the test above but a separate code path: `rev-parse --git-dir`
// answers the bare `.git` for this shape — the same string a main checkout
// answers — so a guard that reads that string as "the main worktree, nothing to
// verify" skips the linkage check entirely and admits the leak at exit 0.
// Measured on git 2.50.1, and measured admitted by the first spelling of this
// PR's own guard.
test("a .git SYMLINKED to a sibling worktree's admin dir is refused, never clean", (t) => {
  const c = nestedWorktreePair(t);
  assert.ok(existsSync(join(c.w, "precious.txt")), "fixture: uncommitted work must still be on disk");
  writeFileSync(join(c.sibling, "precious.txt"), readFileSync(join(c.w, "precious.txt")));
  git(c.sibling, "add", "precious.txt");
  git(c.sibling, "commit", "-q", "-m", "precious.txt, committed here and only here");
  rmSync(join(c.w, ".git"));
  symlinkSync(c.siblingAdmin, join(c.w, ".git"));
  assert.equal(git(c.w, "rev-parse", "--git-dir"), ".git", "fixture: this spelling must still answer the bare `.git`, or it is no longer the shape that bypassed the guard");
  assert.equal(git(c.w, "rev-parse", "--show-prefix"), "", "fixture: the root claim must still admit, or this pins nothing new");
  assert.equal(git(c.w, "status", "--porcelain"), "", "fixture: the sibling's HEAD must read clean, or this is the old leak by a different name");

  const r = audit(c);
  assert.equal(r.status, 2, `must be unanswerable, not clean; got ${r.status} ${r.stdout}`);
  assert.equal(r.stdout, "", "an unanswerable audit must not emit a payload");
  assert.match(r.stderr, /names another worktree's admin dir/);
});

test("an admin dir whose own gitdir back-pointer file is missing is unanswerable, never clean", (t) => {
  const c = nestedWorktree(t);
  const admin = git(c.w, "rev-parse", "--path-format=absolute", "--git-dir");
  rmSync(join(admin, "gitdir"));

  const r = audit(c);
  assert.equal(r.status, 2, `must be unanswerable, not clean; got ${r.status} ${r.stdout}`);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /gitdir is missing or unreadable/);
});

test("an admin dir whose own gitdir back-pointer file is unreadable is unanswerable, never clean", (t) => {
  const c = nestedWorktree(t);
  const admin = git(c.w, "rev-parse", "--path-format=absolute", "--git-dir");
  // No restore: the outer temp-dir cleanup (registered by `repo()`, and so
  // ahead of this test's own `t.after`) force-removes the whole tree first,
  // and deleting a file needs write access to its DIRECTORY, never to the
  // file itself — same reasoning the existing stash-reflog fixtures above
  // already rely on without restoring their own chmods.
  chmodSync(join(admin, "gitdir"), 0o000);

  const r = audit(c);
  assert.equal(r.status, 2, `must be unanswerable, not clean; got ${r.status} ${r.stdout}`);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /gitdir is missing or unreadable/);
});

// The false-refusal side of the same trim: a legitimate back-pointer file with
// trailing whitespace tacked on must still compare equal, or the guard refuses
// worktrees it has no reason to. Real git never writes trailing whitespace
// here, but a hand-edited or copy-touched one could, and the comparison being
// exact-string means a wrong turn on this trim is a silent over-refusal, not
// a loud one.
test("a back-pointer file with trailing whitespace still passes, not falsely refused", (t) => {
  const c = nestedWorktree(t);
  rmSync(join(c.w, "precious.txt"));
  const admin = git(c.w, "rev-parse", "--path-format=absolute", "--git-dir");
  const gitdirFile = join(admin, "gitdir");
  writeFileSync(gitdirFile, `${readFileSync(gitdirFile, "utf8").trimEnd()}  \t\n`);

  const r = audit(c);
  assert.equal(r.status, 0, `trailing whitespace on the back-pointer must not refuse; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.clean, true);
});

// ---------------------------------------------------------------------------
// The ACCEPT side of the same guard. A gate on an irreversible action is as
// wrong when it refuses a healthy checkout as when it admits a spoofed one, and
// a suite that only feeds a refusal guard spoofs pins nothing about what it must
// still answer for. Every shape below is one `git` itself produces, and each
// was measured REFUSED (exit 2, no payload) by the first spelling of this
// guard. The intact-linked-worktree and symlinked-path cases above, and every
// `repo(t)` test in this file (a plain main checkout), are the rest of the set.
// ---------------------------------------------------------------------------

// `--git-dir` answers the bare `.git` here too, exactly as it does for the
// sibling-admin-dir SYMLINK spoof above — so this is the pair that shows the
// guard discriminates on whose admin dir answered rather than on that string:
// same `--git-dir` answer, opposite verdict.
test("a .git symlinked to the worktree's OWN admin dir still passes", (t) => {
  const c = nestedWorktree(t);
  rmSync(join(c.w, "precious.txt"));
  const admin = git(c.w, "rev-parse", "--path-format=absolute", "--git-dir");
  rmSync(join(c.w, ".git"));
  symlinkSync(admin, join(c.w, ".git"));
  assert.equal(git(c.w, "rev-parse", "--git-dir"), ".git", "fixture: this must be the same `--git-dir` answer the spoof gives, or the pair proves nothing");

  const r = audit(c);
  assert.equal(r.status, 0, `a .git symlinked to its own admin dir must pass; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.clean, true);
});

// git writes the back-pointer RELATIVE, not absolute, whenever
// `worktree.useRelativePaths` is set — per-repo config, or `git worktree add
// --relative-paths` per invocation. Written here by hand rather than by that
// flag, in the exact spelling git produces (relative to the admin dir, which is
// what git resolves it against): the flag and the config both arrived in git
// 2.48, and a fixture that needs them stops covering anything, silently and
// green, on any older git the suite is run under.
test("a RELATIVE back-pointer still passes, not read as another worktree's admin dir", (t) => {
  const c = nestedWorktree(t);
  rmSync(join(c.w, "precious.txt"));
  const admin = git(c.w, "rev-parse", "--path-format=absolute", "--git-dir");
  writeFileSync(join(admin, "gitdir"), "../../../.worktrees/9-x/.git\n");

  const r = audit(c);
  assert.equal(r.status, 0, `a relative back-pointer must not refuse; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.clean, true);
});

// Neither shape below is a linked worktree, so neither admin dir carries a
// `gitdir` back-pointer to check — and "has no back-pointer" is not "belongs to
// another worktree". Both are `.git` FILES redirecting to a git dir elsewhere,
// which is what makes them land in the same guard as #189's spoof; both are
// DIRTY, so a pass here is the audit actually answering (exit 1, `clean:false`)
// rather than a refusal wearing a fail-safe exit code.
test("a submodule checkout is audited, not refused for carrying no back-pointer", (t) => {
  const c = repo(t);
  const sub = repo(t, "fix/2-sub", "no-undo-audit-sub-");
  git(c.w, "-c", "protocol.file.allow=always", "submodule", "add", "-q", git(sub.w, "remote", "get-url", "origin"), "sub");
  const w = join(c.w, "sub");
  writeFileSync(join(w, "dirt.txt"), "uncommitted, inside a submodule\n");

  const r = audit({ w, branch: "main" });
  assert.equal(r.status, 1, `a dirty submodule must report dirty, not refuse; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.clean, false);
});

test("a --separate-git-dir clone is audited, not refused for carrying no back-pointer", (t) => {
  const c = repo(t);
  const w = `${c.w}-sgd`;
  execFileSync("git", ["clone", "-q", "--separate-git-dir", `${w}.git`, git(c.w, "remote", "get-url", "origin"), w], { env: ENV });
  writeFileSync(join(w, "dirt.txt"), "uncommitted, in a --separate-git-dir clone\n");

  const r = audit({ w, branch: "main" });
  assert.equal(r.status, 1, `a dirty --separate-git-dir clone must report dirty, not refuse; got ${r.status} ${r.stderr}`);
  assert.equal(r.json.clean, false);
});

// Named in #189 alongside the spoof: not this ticket's mechanism (git refuses
// before the linkage guard even runs, same as a deleted `.git`), but the same
// enumerate pass that found the spoof named it too, so it is pinned here
// rather than assumed.
test("a dangling .git symlink is unanswerable (2), never clean (0)", (t) => {
  const c = nestedWorktree(t);
  rmSync(join(c.w, ".git"));
  symlinkSync("/nonexistent-target-189", join(c.w, ".git"));

  refusedAsUnknownBeforeAnySay(c);
});

// ---------------------------------------------------------------------------
// Dirty means dirty. Every fixture above leaves an untracked file, which is the
// one form `status --porcelain` reports with no index involved at all.
// ---------------------------------------------------------------------------

// A payload that could not be written is not an answer, but the script's exit
// code is spent before the write: without a guard the failing `printf` exits 1
// under `set -e`, and 1 is "REFUSED, worktree dirty" — a clean worktree
// reported as dirty, with no payload to contradict it. Same shape as the guard
// inflight.sh carries on its own final printf.
test("a payload that cannot be written is unanswerable (2), never a refusal (1)", (t) => {
  const c = repo(t);

  // node cannot hand a child a closed fd 1, so sh closes it after the fork.
  const r = spawnSync("sh", ["-c", '"$0" "$@" >&-', SCRIPT, c.w, c.branch], {
    cwd: c.w,
    env: ENV,
    encoding: "utf8",
  });
  assert.equal(r.status, 2, `got ${r.status}; 1 would claim the worktree is dirty`);
});

test("a modified tracked file refuses, like an untracked one", (t) => {
  const c = repo(t);
  writeFileSync(join(c.w, "f.txt"), "edited in place, committed nowhere\n");
  // `git` trims, and porcelain spends its first column on the index — so the
  // status this fixture needs is ` M`, read here with that column already gone.
  assert.equal(git(c.w, "status", "--porcelain"), "M f.txt", "fixture must modify a tracked file, unstaged");

  const r = audit(c);
  assert.equal(r.status, 1, "an edit to a tracked file exists nowhere else either");
  assert.equal(r.json.clean, false);
});

test("a staged change refuses", (t) => {
  const c = repo(t);
  writeFileSync(join(c.w, "staged.txt"), "staged, never committed\n");
  git(c.w, "add", "staged.txt");
  assert.equal(git(c.w, "status", "--porcelain"), "A  staged.txt", "fixture must stage without committing");

  const r = audit(c);
  assert.equal(r.status, 1, "the index is not a commit — a rebase does not carry it");
  assert.equal(r.json.clean, false);
});

// The design spec's script-surface table names this script's payload field by
// field, and #146 added four fields to it. The table went stale in the same
// commit that added them — the fix for that is one edited row, and this is the
// part that keeps the next one from going stale silently. Derived from a real
// run, never from a hand-written key list: a list typed here drifts from the
// script exactly the way the table did.
test("the design spec's script-surface row names every field the payload actually emits", (t) => {
  const c = repo(t);
  const r = audit(c);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);

  const spec = readFileSync(
    fileURLToPath(new URL("../../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
    "utf8",
  );
  const row = spec.split("\n").find((l) => l.startsWith("| `no-undo-audit.sh` |"));
  assert.ok(row, "the script-surface table must still carry a no-undo-audit.sh row");

  // The Out cell alone, since the rest of the row legitimately names things that
  // are not keys: scanning the whole row let the In cell's `<worktree>` satisfy
  // `worktree` and the `Non-zero when` prose's "the stash count is reported"
  // satisfy `stash`, so either could be dropped from the type signature with
  // this test green (measured, both directions).
  const out = row.split("|")[3];

  // Word-boundary match, so `worktree` cannot be satisfied by `worktreeRewritten`
  // sitting elsewhere in the cell — the exact substring trap that would let the
  // four new flags be dropped again while this test stayed green.
  const missing = Object.keys(r.json).filter((k) => !new RegExp(`\\b${k}\\b`).test(out));
  assert.deepEqual(missing, [], `the spec row omits fields the script emits: ${missing.join(", ")}`);
});

// Both docs describe this script's exit-2 causes, and its linkage clause covers
// TWO failures git reports differently. A parenthetical naming only the walk-up
// one stood, byte-identical, in both files, and was false for the other (#420).
// Measured, git 2.50.1: delete the worktree's `.git` and `rev-parse
// --show-prefix` returns `.worktrees/<wt>/` while `--show-toplevel` is the
// enclosing repo; rewrite that file to `gitdir: …/worktrees/<sibling>` and
// `--show-prefix` is empty at rc 0 with `--show-toplevel` the worktree itself,
// while HEAD, the branch and `status` all answer from the sibling.
//
// ONE exact-span assertion rather than a match per mechanism, because the claim
// lives in the JOIN: separate matches for `enclosing repo` and for `another
// worktree's HEAD and index` are both satisfied by a rewrite that re-merges the
// two into a single wrong account ("git walks up and reports the enclosing
// repo, or reads another worktree's HEAD and index"), which is the defect this
// pin exists to keep out. Safe to pin as an exact span because both carriers
// are one unwrapped line — a table row and a prose paragraph — so there is no
// reflow to survive.
//
// SCOPE of the rc-0 clause: measured for a worktree nested inside its repo —
// the only shape this fleet builds, since `claim-ticket.sh` derives the
// worktree path under `.worktrees/` relative to the repo root. Outside any
// repo the clause's own subject does not exist: with `.git` deleted git has
// nothing to walk up to and `rev-parse` exits 128, though the script still
// refuses at exit 2, via its not-a-git-worktree die rather than the one for
// git answering above the worktree (measured, git 2.50.1). Re-open if the
// fleet ever places a worktree outside the repo — the clause then needs
// scoping, and the string is byte-identical across the docs this test reads
// and this constant, so every carrier moves together.
const LINKAGE_PARENTHETICAL =
  "its linkage is broken, and git still answers at rc 0 — for the enclosing repo when the `.git` is gone, from another worktree's HEAD and index when it names that worktree's admin dir";

test("both docs' exit-2 prose keeps the two linkage failures distinct", () => {
  for (const [rel, anchor] of [
    ["../commands/run-merge-bot.md", (l) => l.includes("Exit **2**")],
    ["../../docs/specs/2026-07-23-fleet-plugin-design.md", (l) => l.startsWith("| `no-undo-audit.sh` |")],
  ]) {
    const line = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
      .split("\n").find(anchor);
    assert.ok(line, `${rel} must still describe this script's exit-2 causes`);
    assert.ok(line.includes(LINKAGE_PARENTHETICAL),
      `${rel} no longer names both linkage failures as distinct: a deleted \`.git\` is the one git walks up from, and a \`.git\` naming another worktree's admin dir is the one git answers for this worktree while reading the other one's HEAD and index. Merging them, or generalising until it names neither, both land here.`);
  }
});

// --- #119: the escaping library this script now sources rather than carries.
//
// `.` is a POSIX special builtin, so failing to open its operand aborts a
// non-interactive shell before any `||` on the line can run — measured, /bin/sh
// (macOS bash 3.2), bash 3.2 and `bash --posix` all exit 1 with the guard
// unfired. Exit 1 is a VERDICT here — `REFUSED — commit the worktree before
// rebasing`, and "refused" means a dirty worktree this script actually looked
// at — so a bare 1 out of a missing file would report that refusal without
// having measured anything. The `[ -r ]` ahead of the `.` is what makes it a 2.
test("a missing json.sh is exit 2, not a verdict about the worktree", (t) => {
  const c = repo(t);
  const lone = mkdtempSync(join(tmpdir(), "no-undo-audit-nolib-"));
  t.after(() => rmSync(lone, { recursive: true, force: true }));
  copyFileSync(SCRIPT, join(lone, "no-undo-audit.sh"));

  const r = spawnSync("sh", [join(lone, "no-undo-audit.sh"), c.w, c.branch], {
    cwd: c.w, env: ENV, encoding: "utf8",
  });

  assert.equal(r.status, 2,
    "a missing library is `the question could not be answered`. Exit 0 would call an unexamined worktree safe to rebase, which is the false safe this whole script exists to prevent.");
  assert.match(r.stderr, /json\.sh/,
    "and it names the file — this script has many exit-2 paths and the operator should not have to guess which fired");
  assert.equal(r.stdout, "", "no payload: nothing was measured");
});

// --- #119, second half: what happens when the library is THERE and its tools
// are not. `jarr`/`jarr_rewritten` return non-zero on a failed stage now, which
// is the whole point of the extraction — and under `set -eu` a bare
// `var=$(… | jarr)` would then abort with the failing tool's own status. On
// this script that status is 1, byte-identical to the dirty-worktree refusal,
// on a worktree the run had already logged as clean, with no payload and no
// diagnostic. These three pin the `|| die` that converts it to a 2.
//
// One shim shape, selected on CONTENT rather than on argv, because the two jarr
// call sites are invoked with identical arguments and only the values passing
// through them differ. `sed` fails jarr; `tr -d` fails jrewritten and therefore
// jarr_rewritten, which is the other operand of each `&&` chain.
//
// `selector` overrides that default arg match, which is what #431's cases need:
// `jstr` ends in a `tr` carrying no `-d`, so the two defaults above cannot
// address it. Passing json.sh's shared scrub set matches BOTH the replacing
// `tr` that closes `jstr` and the deleting one inside `jrewritten` — which is
// not ambiguity to route around, because the caller consults `jstr` first and
// therefore always reports `jstr` as the escaper that failed.
function withBrokenEscaper(t, { tool, marker, selector }) {
  const bin = mkdtempSync(join(tmpdir(), "no-undo-audit-esc-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const real = execFileSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).trim();
  // The selector arg is what keeps this off the script's OWN sed/tr calls:
  // `s/^/"/` appears only in jarr's rule list and `-d` only in jrewritten's.
  selector = selector ?? (tool === "sed" ? `'s/^/"/'` : "-d");
  writeFileSync(join(bin, tool), `#!/bin/sh
case " $* " in
  *${selector}*)
    in=$(cat)
    case "$in" in *'${marker}'*) exit 1 ;; esac
    printf '%s\\n' "$in" | exec ${real} "$@" ;;
esac
exec ${real} "$@"
`);
  chmodSync(join(bin, tool), 0o755);
  return `${bin}:${process.env.PATH}`;
}

test("a jarr that cannot escape the conflicts is exit 2 with a cause, never the refusal that means dirty", (t) => {
  const c = bareConflictRepo(t, "boom-conflict.txt");
  const r = audit(c, { ...ENV, PATH: withBrokenEscaper(t, { tool: "sed", marker: "boom-conflict" }) });

  assert.equal(r.status, 2,
    "the worktree is clean and was measured clean — exit 1 here would report it dirty on the strength of a broken sed");
  assert.match(r.stderr, /could not escape the conflicting paths/,
    "and it names which stage failed rather than exiting silently");
  assert.equal(r.stdout, "", "no payload: an unescaped conflicts list is not an answer");
});

test("a jarr that cannot escape the at-risk commits is exit 2 with its own cause", (t) => {
  const c = bareConflictRepo(t, "plain.txt");
  git(c.w, "checkout", "-q", "main");
  writeFileSync(join(c.w, "plain.txt"), "later main side\n");
  git(c.w, "add", "--", ":(literal)plain.txt");
  git(c.w, "commit", "-q", "-m", "BOOMATRISK subject");
  git(c.w, "push", "-q", "origin", "main");
  git(c.w, "checkout", "-q", c.branch);

  const r = audit(c, { ...ENV, PATH: withBrokenEscaper(t, { tool: "sed", marker: "BOOMATRISK" }) });

  // A distinct message, not the conflicts one: the two guards are separate
  // statements and a single shared message could not tell the operator which
  // array the run lost.
  assert.equal(r.status, 2, "an at-risk list that could not be rendered is unanswerable, not a dirty worktree");
  assert.match(r.stderr, /could not escape the at-risk commits/,
    "and the cause names the at-risk list, not the conflicts one");
  assert.equal(r.stdout, "", "no payload: a run that cannot say what a resolution would eat has not answered");
});

test("a jarr_rewritten that cannot answer is exit 2 too — the `&&` chain covers both operands", (t) => {
  const c = bareConflictRepo(t, "boom-conflict.txt");
  const r = audit(c, { ...ENV, PATH: withBrokenEscaper(t, { tool: "tr", marker: "boom-conflict" }) });

  assert.equal(r.status, 2,
    "`conflictsRewritten` is what tells the runbook a path is not safe to hand to `git diff` — a run that cannot compute it has not answered");
  assert.match(r.stderr, /could not escape the conflicting paths/);
  assert.equal(r.stdout, "", "no payload: half the pair is not a receipt");
});

// --- #431: the same broken escaper, one block further down, and the OPPOSITE
// answer. The three cases above escape `conflicts[]` and `atRisk[]` — findings
// the operator can obtain nowhere else, and which step 5 of the no-undo runbook
// hands to `git diff -- <path>`. A run that cannot render those has not
// answered, so they keep their `die`.
//
// `worktree` and `branch` are the other kind. They are echoes of argv: the
// caller supplied both and still holds them, and by the time this block runs
// `clean` has been measured, `stash` counted, and both arrays already rendered.
// A `tr` that has gone missing there used to convert that finished audit into
// exit 2 with no payload — discarding every real finding over the formatting of
// two values the caller typed. Each renders independently now and reports JSON
// `null` when it cannot, which is what #120 shipped for the same class in
// inflight.sh.
//
// `null` is the honest report and not a quieter `""`: a field that could not be
// escaped has no usable path to hand to `git diff` in any case, and `""` is
// indistinguishable from a path, which is the false-reassurance direction.
test("an escaper that cannot render the branch reports it null and still delivers every finding", (t) => {
  const c = conflictRepo(t, "plain.txt", "fix/1-BOOMBRANCH");
  const r = audit(c, { ...ENV, PATH: withBrokenEscaper(t, {
    tool: "tr", marker: "BOOMBRANCH", selector: `'\\001-\\007\\013\\016-\\037'`,
  }) });

  assert.equal(r.status, 0,
    "the worktree was measured clean and every finding survived — exit 2 here would retract a finished audit over a formatter");
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.equal(r.json.branch, null, "the unrenderable field is null, not a truncated or empty string");
  assert.equal(r.json.branchRewritten, null,
    "and its paired flag too — a `false` there would claim nothing was replaced in a value nothing could examine");

  // The point of the whole change: everything the audit established is still on
  // the payload, and the OTHER escaped field is untouched by its sibling's
  // failure.
  assert.equal(r.json.worktree, c.w, "the worktree renders independently and keeps its real value");
  assert.equal(r.json.worktreeRewritten, false);
  assert.equal(r.json.clean, true, "measured before the escape ran, and still reported");
  assert.equal(r.json.stash, 0);
  assert.deepEqual(r.json.conflicts, ["plain.txt"], "the conflicting path was found and is still named");
  assert.deepEqual(r.json.conflictsRewritten, [false]);
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"],
    "the commit a careless resolution would eat is still named — that finding is the reason this script exists");

  assert.match(r.stderr, /could not render the branch .*\(jstr\)/,
    "and the operator is told which field and which escaper, not left to diff the payload against a healthy one");
});

test("an escaper that cannot say whether the worktree path was rewritten reports it null, leaving the branch intact", (t) => {
  const c = conflictRepo(t, "plain.txt", undefined, "no-undo-audit-BOOMWT-");
  const r = audit(c, { ...ENV, PATH: withBrokenEscaper(t, { tool: "tr", marker: "BOOMWT" }) });

  assert.equal(r.status, 0);
  assert.equal(r.jsonError, null, `payload must parse; got ${r.jsonError?.message}\n${r.stdout}`);
  assert.equal(r.json.worktree, null,
    "`jstr` rendered this path perfectly and `jrewritten` still could not say whether a byte was replaced — an undisclosed rewrite is not a path a reader may trust");
  assert.equal(r.json.worktreeRewritten, null);
  assert.equal(r.json.branch, c.branch, "the branch renders independently and is unaffected");
  assert.equal(r.json.branchRewritten, false);
  assert.deepEqual(r.json.conflicts, ["plain.txt"]);
  assert.deepEqual(subjects(r), ["MAIN COMMIT AT RISK"]);

  // Named separately from `jstr` because the two fail independently: `jstr` can
  // render a string while `jrewritten` cannot judge it, which is exactly this
  // case. One shared word would send a debugger to whichever it guessed.
  assert.match(r.stderr, /could not render the worktree .*\(jrewritten\)/);
});

// #431's acceptance criterion that lives in prose rather than in the payload: a
// reader of the runbook has to meet what a `null` field means BEFORE they act
// on one. Both carriers state it, on the same two lines the linkage pin above
// anchors on — the runbook's exit-2 paragraph and the design spec's own row.
//
// Two phrases, not one, because either alone is satisfied by a rewrite that
// loses the point. `there is no worktree` alone passes prose that names the
// misreading without ruling it out; `could not render the path you passed in`
// alone passes prose that says what the field IS while leaving the dangerous
// reading unaddressed. The claim is the pair: this is what `null` means, and
// that is what it does not.
//
// Deliberately NOT pinned as one span: the two docs word the surrounding
// sentence differently on purpose — the runbook bolds its `never` for an
// operator mid-pass, the spec row does not — and a span pin would force one
// voice on both or drift into pinning nothing.
test("both docs rule out reading a null worktree as an absent one", () => {
  for (const rel of ["../commands/run-merge-bot.md", "../../docs/specs/2026-07-23-fleet-plugin-design.md"]) {
    const doc = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
    assert.ok(doc.includes("could not render the path you passed in"),
      `${rel} must say what a null worktree/branch IS — the run could not render the argument the caller supplied — since the field is an echo of argv rather than a finding`);
    assert.ok(doc.includes('"there is no worktree"'),
      `${rel} must rule out the false-reassurance reading by name: a null path is not an absent worktree, and an operator who reads it as one skips the proof step believing there was nothing to prove`);
  }
});
