// Regression gate for `gone()`, the established-absent predicate three fleet
// scripts each carry a byte-identical copy of. Zero deps:
// `node --test skills/fleet/scripts/gone-walk.test.mjs`.
//
// The four CALLERS are covered in their own suites (release-ticket.test.mjs
// twice, reap.test.mjs, worktree-audit.test.mjs), and each of them can only
// reach the predicate through `git worktree list`, which never yields an empty
// path and never yields a relative one. This suite exists for the inputs that
// route leaves unreachable — `gone ""` above all, the case the rejected form of
// the #178 fix (`[ -n "$look" ] || look=/` placed AFTER the loop) flips from 1
// to 0 while every caller-level test stays green.
//
// It reads the function out of the scripts rather than restating it, so the
// matrix below cannot drift away from the code it claims to pin.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Spelled out rather than discovered by globbing for `^gone() {`: a discovered
// set silently SHRINKS when a script drops its copy, which is precisely the
// regression being pinned. A fourth copy has to be added here deliberately —
// same trade-off, same reason as arg.test.mjs's own CONSUMERS list.
const SCRIPTS = ["reap.sh", "release-ticket.sh", "worktree-audit.sh"];

/** The `gone()` definition, verbatim, as it appears in a script's source. */
function extract(name) {
  const src = readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
  // Global, and pinned to exactly ONE match: /bin/sh runs whichever definition
  // was read last, while this lift takes the first, so a second `gone()` further
  // down would leave both tests below green against a predicate the scripts
  // never execute. Zero matches fails the same assert — `undefined !== 1`.
  const all = src.match(/^gone\(\) \{\n[\s\S]*?^\}$/gm);
  assert.equal(all?.length, 1, `${name} must define gone() exactly once, at column 0`);
  return all[0];
}

// One copy per script and no shared file to change: the three drift unless
// something compares them. #466 landed the second and third copies, and #178
// exists because a fix to one is a fix to none.
test("all three copies of gone() are still byte-identical", () => {
  const [first, ...rest] = SCRIPTS.map(extract);
  for (const [i, body] of rest.entries()) {
    assert.equal(body, first, `${SCRIPTS[i + 1]} has drifted from ${SCRIPTS[0]}`);
  }
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
  ]
    // Root reads every directory, so the unsearchable prefix the `noperm` row
    // needs cannot be fixtured under uid 0. Drop that ONE row there, never the
    // matrix: the other eight need no permission fixture, and `gone ""` among
    // them is the only case that separates this fix from the rejected
    // after-the-loop form — skipping the whole test hands uid 0 a green suite
    // against the very placement it was written to reject.
    .filter(([p]) => process.getuid?.() !== 0 || !p.startsWith(join(root, "noperm")));

  const answers = probe(extract("release-ticket.sh"), cases.map(([p]) => p));
  for (const [i, [p, want, why]] of cases.entries()) {
    assert.equal(answers[i], want, `gone "${p}" must be ${want}: ${why}`);
  }
});
