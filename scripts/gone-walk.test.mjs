// Regression gate for `gone()`, the established-absent predicate the fleet's
// worktree scripts share. Zero deps:
// `node --test scripts/gone-walk.test.mjs`.
//
// #725 moved it out of the three byte-identical copies into worktree.sh, so
// this file now pins ONE definition and the sourcing that reaches it.
//
// The CALLERS are covered in their own suites (release-ticket.test.mjs,
// reap.test.mjs, worktree-audit.test.mjs, claim-ticket.test.mjs). Three of them
// can only reach the predicate through `git worktree list`, which never yields
// an empty path and never yields a relative one. This suite exists for the
// inputs that route leaves unreachable — `gone ""` above all, the case the
// rejected form of the #178 fix (`[ -n "$look" ] || look=/` placed AFTER the
// loop) flips from 1 to 0 while every caller-level test stays green.
//
// #727 added the fourth, and it is the exception that makes the `relative/…`
// rows below reachable rather than theoretical: claim-ticket.sh CONSTRUCTS the
// path it asks about (`.worktrees/$issue-$slug`) instead of reading it back from
// git, so it is the one caller that can hand this predicate a relative path.
// Measured on that spelling, the walk stops at the unstrippable `.worktrees`
// component and answers 1 for a repo that simply has no worktrees yet — every
// first claim a refusal. It passes `$PWD/$wt` for that reason, and its own suite
// pins the accept case; the rows here are what say why the absolute form is not
// decoration.
//
// The caller inventory is DERIVED here rather than stated. The stated one was
// wrong — it credited release-ticket.sh with two call sites when that file has
// several, and #725's remedy question ("fix in the predicate, or at every call
// site?") turned on exactly that figure. A number written into a comment is
// false the moment the next commit lands; an assertion over the tree is not.
//
// It reads the function out of the script rather than restating it, so the
// matrix below cannot drift away from the code it claims to pin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The scripts that ASK the question. Spelled out rather than discovered, for
// the reason arg.test.mjs spells out its own CONSUMERS list: a discovered set
// silently shrinks when a script drops its call, which is one of the
// regressions being pinned. A fourth caller has to be added here deliberately.
const CALLERS = ["reap.sh", "release-ticket.sh", "worktree-audit.sh", "claim-ticket.sh"];

// The one file the definition is allowed to live in.
const HOME = "worktree.sh";

const read = (name) => readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");

/** The `gone()` definition, verbatim, as it appears in worktree.sh. */
function extract(name = HOME) {
  const src = read(name);
  // Global, and pinned to exactly ONE match: /bin/sh runs whichever definition
  // was read last, while this lift takes the first, so a second `gone()` further
  // down would leave both tests below green against a predicate the scripts
  // never execute. Zero matches fails the same assert — `undefined !== 1`.
  const all = src.match(/^gone\(\) \{\n[\s\S]*?^\}$/gm);
  assert.equal(all?.length, 1, `${name} must define gone() exactly once, at column 0`);
  return all[0];
}

// #466 landed the second and third copies and #178 exists because a fix to one
// was a fix to none — then #725 found the third failure of the same shape, a
// dangling symlink read as established-absent in two of three copies while the
// third compensated at a call site. So the pin is no longer "the copies agree";
// it is "there are no copies".
// `\s*\{` and no end anchor, where this required the opening line to be
// byte-for-byte `gone() {`. One syntactic form is not the class: measured, the
// pre-PR body reintroduced under `gone() { # local override` walked straight
// through and left all four tests here green. A redefinition arrives WITH a
// comment excusing it far more plausibly than without one, so the one spelling
// the anchor missed is the likely one.
test("gone() is defined once in the tree, in worktree.sh", () => {
  extract(HOME);
  for (const name of CALLERS) {
    assert.doesNotMatch(
      read(name),
      /^gone\(\)\s*\{/m,
      `${name} must source ${HOME}, never redefine gone() — a second definition is what #725 found`,
    );
  }
});

// The sourcing is what makes the single definition reachable, and a caller that
// lost it fails on `gone: not found` at run time — late, and in a delete script.
test("every caller of gone() sources worktree.sh", () => {
  for (const name of CALLERS) {
    const src = read(name);
    assert.match(src, /\. "\$wt_lib" \|\| die/, `${name} must source ${HOME}`);
    assert.ok(
      src.includes('gone "'),
      `${name} is listed as a caller but never calls gone — drop it from CALLERS or restore the call`,
    );
  }
});

// The inventory #725's remedy question turned on, derived rather than stated.
// The comment this file used to carry named a figure for release-ticket.sh that
// its own source contradicted, so "fix at every call site" was sized against a
// number nothing checked.
test("the caller inventory matches the tree", () => {
  const counts = Object.fromEntries(
    CALLERS.map((name) => [name, (read(name).match(/(?:^|[^\w-])gone "/g) ?? []).length]),
  );
  for (const [name, n] of Object.entries(counts)) {
    assert.ok(n > 0, `${name} must call gone() at least once`);
  }
  // release-ticket.sh is the file the old stated inventory undercounted, and the
  // reason it did is that its call sites are spread across four guards rather
  // than gathered. Pinned against the OTHER two so the assertion says something
  // about shape rather than restating a number: it is the file that asks the
  // question most often, and a change that levels that out is worth a look.
  assert.ok(
    counts["release-ticket.sh"] > counts["reap.sh"],
    "release-ticket.sh asks gone() more often than reap.sh — the asymmetry the old inventory flattened",
  );
  assert.ok(
    counts["release-ticket.sh"] > counts["worktree-audit.sh"],
    "release-ticket.sh asks gone() more often than worktree-audit.sh",
  );
});

/**
 * Run `gone` over `inputs` in a fresh /bin/sh and return one exit status each.
 *
 * `timeout`, not a bare run: the loop's termination is a property under test
 * here (`${p%/*}` returns p unchanged on a path with no slash, which is what
 * the `!=` guard is for), and a spin would otherwise hang the suite rather
 * than fail it.
 */
function probe(body, inputs) {
  const script = `${body}\nfor p in "$@"; do if gone "$p"; then echo 0; else echo 1; fi; done\n`;
  const r = spawnSync("/bin/sh", ["-c", script, "sh", ...inputs], { encoding: "utf8", timeout: 30_000 });
  assert.equal(r.signal, null, `gone() must terminate on every input: ${r.signal}`);
  assert.equal(r.status, 0, `harness itself must not fail: ${r.stderr}`);
  const out = r.stdout.trim().split("\n");
  assert.equal(out.length, inputs.length, "one answer per input");
  return out;
}

test("gone() answers the full input matrix, 0 only for established absence", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gone-walk-")));
  t.after(() => {
    // try: the hook is registered before the fixture exists, so on a setup
    // failure `noperm` is not there to restore — and a throwing chmod would
    // take the rmSync below with it and leak the temp dir.
    try {
      chmodSync(join(root, "noperm"), 0o755);
    } catch {
      // Never built; nothing to restore. The rmSync is the part that matters.
    }
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, "exists"));
  mkdirSync(join(root, "noperm", "inner"), { recursive: true });
  chmodSync(join(root, "noperm"), 0o000);
  // #725's fixtures. `dangling` is the defect itself; `live` is the control that
  // stops the fix becoming a blanket refusal of every symlink; `danganc/link` is
  // the sibling the loop-condition placement answers for free — a dangling link
  // standing in for an ANCESTOR rather than for the path itself.
  symlinkSync(join(root, "nowhere"), join(root, "dangling"));
  symlinkSync(join(root, "exists"), join(root, "live"));
  mkdirSync(join(root, "danganc"));
  symlinkSync(join(root, "nowhere"), join(root, "danganc", "link"));

  // `/nonexistent-top-level-178` is never created and needs no fixture: what
  // makes it the shape #178 is about is that its FIRST component is missing,
  // so the walk runs out of ancestors below `/` and has only the root left to
  // test. Reachable in production through a hand-added worktree outside the
  // checkout whose ancestor chain was removed (`git worktree add /scratch/wt`,
  // then `rm -rf /scratch`) — the population release-ticket.sh's stray guard
  // exists to handle.
  const cases = [
    ["", "1", "no path is not an absent path — the after-the-loop form of this fix flips exactly this one"],
    ["/nonexistent-top-level-178", "0", "first component missing, root searchable: established absent (#178)"],
    ["/nonexistent-top-level-178/child", "0", "same, one level down (#178)"],
    ["/", "1", "the root exists, so it is not an absence — and it is where the walk now stops"],
    [join(root, "exists"), "1", "a path that is there is not an absence"],
    [join(root, "exists", "absent"), "0", "surviving ancestor below / — the case that already worked"],
    [join(root, "noperm", "inner"), "1", "unsearchable prefix stays unknown, never absent"],
    ["relative-no-slash", "1", "no slash: the walk cannot climb, so it cannot establish anything"],
    ["relative/with/slash", "1", "relative prefix is not searchable from here either"],
    // #725. `-e` STATS, so it is false through a dangling link while `-L` is
    // true: the path is occupied as far as `git worktree add` is concerned, and
    // calling it established-absent is what let reap.sh predict a removal and
    // worktree-audit.sh report `MISSING on disk` over a live claim. A dangling
    // worktree link arrives BOTH as rc-0 residue and as release-ticket.sh's
    // rc-255 halt path with the branch and the label still alive, so "not
    // established-absent" is the only answer true of both (#728).
    [join(root, "dangling"), "1", "a dangling symlink is occupied, never an absence (#725)"],
    [join(root, "danganc", "link", "child"), "1", "a dangling symlink ANCESTOR is not an absence either (#725)"],
    // The accept side. Without it the matrix pins that the fix refuses, not that
    // it discriminates: a `gone` hard-wired to 1 passes every reject row above.
    [join(root, "live"), "1", "a symlink to a real directory is present, as it always was"],
    [join(root, "nowhere"), "0", "the dangling links point HERE, and it is still an ordinary absence"],
  ]
    // Root reads every directory, so the unsearchable prefix the `noperm` row
    // needs cannot be fixtured under uid 0. Drop that ONE row there, never the
    // matrix: the other eight need no permission fixture, and `gone ""` among
    // them is the only case that separates this fix from the rejected
    // after-the-loop form — skipping the whole test hands uid 0 a green suite
    // against the very placement it was written to reject.
    .filter(([p]) => process.getuid?.() !== 0 || !p.startsWith(join(root, "noperm")));

  const answers = probe(extract(), cases.map(([p]) => p));
  for (const [i, [p, want, why]] of cases.entries()) {
    assert.equal(answers[i], want, `gone "${p}" must be ${want}: ${why}`);
  }
});
