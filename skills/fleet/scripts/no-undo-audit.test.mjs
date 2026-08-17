// Regression gate for no-undo-audit.sh, all three of its outcomes. Zero deps:
// `node --test skills/fleet/scripts/no-undo-audit.test.mjs`.
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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

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
function conflictRepo(t, path) {
  const c = repo(t);
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
 * Shadows `xargs` on PATH with a wrapper that inserts `-s 300` ahead of
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
function withSplitXargs(t) {
  const bin = mkdtempSync(join(tmpdir(), "no-undo-audit-xargs-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  const log = join(bin, "batches");
  const shim = (name, body) => {
    const real = execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).trim();
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}exec ${real} "$@"\n`);
    chmodSync(join(bin, name), 0o755);
  };
  shim("xargs", `set -- -s 300 "$@"\n`);
  shim("git", `case " $* " in *':(literal)'*) echo x >>"${log}" ;; esac\n`);
  return {
    path: `${bin}:${process.env.PATH}`,
    batches: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").length - 1 : 0),
  };
}

/**
 * A linked worktree NESTED inside the clone, `.worktrees/` gitignored — the
 * fleet's own layout, and the only one where breaking the linkage is dangerous:
 * an enclosing repo is standing by to answer in the worktree's place, and being
 * clean it answers "nothing uncommitted here". A worktree with no repo above it
 * has nothing to walk up to, so git fails there and the script already refuses.
 * `precious.txt` is the uncommitted work that exists nowhere else.
 */
function nestedWorktree(t, branch = "fix/9-nested") {
  const c = repo(t);
  writeFileSync(join(c.w, ".gitignore"), ".worktrees/\n");
  git(c.w, "add", ".gitignore");
  git(c.w, "commit", "-q", "-m", "ignore the nested worktree");
  git(c.w, "push", "-q", "origin", c.branch);
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
  git(sibling, "push", "-q", "-u", "origin", "fix/8-sibling");
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
const audit = ({ w, branch }, env = ENV) => {
  const r = spawnSync("sh", [SCRIPT, w, branch], { cwd: w, env, encoding: "utf8" });
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
const stashLine = (r) => r.stderr.split("\n").find((l) => l.includes("stash entries (repo-global"));

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
  // `git stash drop` two lines later. Removing the gate must remove the
  // instruction, or the contradiction outlives the bug.
  assert.doesNotMatch(r.stderr, /stash-list-clear/);
  // `git stash`, not `git stash drop`: stashing to clear a dirty worktree now
  // leaves `clean` true, so this line is the only thing in the repo forbidding
  // a maneuver nothing detects. Narrowing it back to `drop` reads like a
  // consistency fix and silently reopens the hole.
  assert.match(r.stderr, /`git stash` to make a rebase start/);
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
});

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
});

// A stash object that is CORRUPT rather than missing reaches the same branch —
// list empty at rc 0, show-ref rc 0 — but git answers in SEVEN lines there, and
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
  const atColumn0 = r.stderr.split("\n").filter((l) => /^\S/.test(l) && /loose object|unable to unpack|inflate/.test(l));
  assert.deepEqual(atColumn0, [], "git's diagnostic belongs folded into the audit's own indented line, never at column 0");
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
// input any of the three jstr copies can receive as more than one line. It is
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
// Their copies of the slurp are unreachable rather than unpinned; #119 owns
// the three-copies question.
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
  assert.ok(existsSync(join(c.w, ".git")), "fixture must leave the linkage intact");
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
  // itself resolves relative gitdir: lines against. Both ends have to be
  // canonical (git's own, via --show-toplevel) or the /private/var symlink
  // macOS's tmpdir sits under makes `relative` count the wrong number of
  // `../` segments — a mismatch `git` itself never has, since it resolves
  // both sides the same way before comparing.
  const wCanonical = git(c.w, "rev-parse", "--show-toplevel");
  const relPath = relative(wCanonical, c.siblingAdmin);
  writeFileSync(join(c.w, ".git"), `gitdir: ${relPath}\n`);
  assert.equal(git(c.w, "rev-parse", "--git-dir"), c.siblingAdmin, "fixture: git must resolve the relative spoof to the sibling admin dir, or this pins nothing new");

  const r = audit(c);
  assert.equal(r.status, 2, `must be unanswerable, not clean; got ${r.status} ${r.stdout}`);
  assert.equal(r.stdout, "");
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
  const admin = join(c.parent, ".git", "worktrees", "9-x");
  rmSync(join(admin, "gitdir"));

  const r = audit(c);
  assert.equal(r.status, 2, `must be unanswerable, not clean; got ${r.status} ${r.stdout}`);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /gitdir is missing or unreadable/);
});

test("an admin dir whose own gitdir back-pointer file is unreadable is unanswerable, never clean", (t) => {
  const c = nestedWorktree(t);
  const admin = join(c.parent, ".git", "worktrees", "9-x");
  // No restore: the outer temp-dir cleanup (registered by `repo()`, and so
  // ahead of this test's own `t.after`) force-removes the whole tree first,
  // and deleting a file needs write access to its DIRECTORY, never to the
  // file itself — same reasoning the existing stash-reflog fixtures above
  // already rely on without restoring their own chmods.
  chmodSync(join(admin, "gitdir"), 0o000);

  const r = audit(c);
  assert.equal(r.status, 2, `must be unanswerable, not clean; got ${r.status} ${r.stdout}`);
  assert.equal(r.stdout, "");
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
  const admin = join(c.parent, ".git", "worktrees", "9-x");
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
    fileURLToPath(new URL("../../../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
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
