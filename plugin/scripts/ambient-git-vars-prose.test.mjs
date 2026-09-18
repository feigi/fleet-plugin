// #1020. Seven scripts carry `unset GIT_DIR GIT_WORK_TREE`, and for four of
// them one HALF of that line has no behavioural detector at all.
//
// That is the gap this file exists for, and it is measured, not assumed.
// GIT_DIR and GIT_WORK_TREE break a script through different call sites, so
// whether a given script can SHOW the damage depends on which calls it makes:
//
//   inflight.sh, derive-testcmd.sh  — GIT_WORK_TREE is inert. Their git calls
//     read refs and the object database (`for-each-ref`, `ls-remote`,
//     `worktree list`, `ls-tree`, `show`); none consults a work tree, so no
//     ambient value changes a byte of output.
//   instruments.sh                  — GIT_DIR is inert. `ls-files` only names
//     paths, and both the digest and the baseline are read from files on
//     disk.
//   release-ticket.sh               — GIT_DIR does not misdirect its `-C`
//     calls (recorded in release-ticket.test.mjs's own #427 pair).
//
// A behavioural fixture for an inert half can only be vacuous, which is the
// exact failure PR #1015 measured and this ticket was filed to avoid. So the
// halves that CAN be measured are pinned behaviourally, in each script's own
// test file, one fixture per variable; and the line itself is pinned here, as
// source, so the inert half cannot be quietly dropped by an editor who tries
// deleting it and finds the suite still green. Same instrument, same reason,
// as locale-pin-prose.test.mjs: some corrections have no behavioural shadow on
// the platform CI runs, and a source assertion is what is left.
//
// What this file does NOT pin: per-script behaviour. That lives in
// claim-ticket.test.mjs, derive-testcmd.test.mjs, inflight.test.mjs,
// instruments.test.mjs, no-undo-audit.test.mjs, reap.test.mjs,
// release-ticket.test.mjs and worktree-audit.test.mjs, and eleven fixtures
// across them go red when the corresponding half is deleted.
//
// Also not pinned, and stated rather than left to be noticed: the `.mjs`
// scripts in this directory. The scan below is `.sh`-only and the detector is a
// shell line, so a Node caller's hazard and its remedy — an env object built
// for the child, since there is no shell to `unset` in — are both invisible
// here, and "a NEW script cannot join the exposed set in silence" holds for
// shell only. #1599 carries that census, with `ledger.mjs`'s default ledger
// path measured as an exposed site; `fleet-state.mjs`'s own
// `rev-parse --git-common-dir` call scrubs both variables and has a
// behavioural fixture in fleet-heartbeat.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const DIR = fileURLToPath(new URL(".", import.meta.url));
const read = (f) => readFileSync(join(DIR, f), "utf8");

const LINE = "unset GIT_DIR GIT_WORK_TREE";

// The scripts that carry the line. Written out rather than globbed, for the
// reason locale-pin-prose.test.mjs writes its own list out: adding a script
// here is a decision, and a glob would make it an accident.
const COVERED = [
  "claim-ticket.sh",
  "derive-testcmd.sh",
  "inflight.sh",
  "instruments.sh",
  "no-undo-audit.sh",
  "reap.sh",
  "release-ticket.sh",
  "worktree-audit.sh",
];

// The scripts that invoke git and deliberately do NOT carry it, each with the
// measurement or the reason that settled it. This is the census #1020 asked to
// be re-derived, written down so the next person does not have to re-derive it
// from scratch — and so a NEW script cannot join the exposed set in silence,
// which is exactly how the prose numbers on that ticket had drifted.
const EXEMPT = {
  "net.sh":
    "a library, sourced into someone else's shell — `unset` there would reach back into the caller's environment for every later command in it, which is the caller's decision to make. Every entrypoint that sources it (reap.sh, inflight.sh) unsets on its own account.",
  "worktree.sh":
    "a library, for the same reason as net.sh. All four of its callers — claim-ticket.sh, reap.sh, worktree-audit.sh, release-ticket.sh — carry the line.",
  "prove-merge.sh":
    "measured (#1020): with an ambient GIT_DIR naming an unrelated repository, `git cat-file -e \"${obj}^{commit}\"` cannot resolve the argument and the run REFUSES at exit 2 in its own voice. Never a wrong verdict, which is the whole class. GIT_WORK_TREE is inert — every call is an object-database read.",
  "verify-sha.sh":
    "measured (#1020): same shape as prove-merge.sh — an ambient GIT_DIR naming an unrelated repository refuses at exit 2 (`cannot resolve <sha> to a commit`) rather than certifying anything. GIT_WORK_TREE is inert for the same reason.",
};

/**
 * A `git` invocation in shell code: line start, or immediately after a shell
 * operator, a command substitution, or a compound-command keyword.
 *
 * Not a bare `/git /`: this file's whole job is locating the FIRST real call,
 * and the scripts echo their own commands for the operator (`echo "$ git
 * fetch --prune origin"`, `printf '    would: git worktree add …'`). A bare
 * match lands on one of those, several lines above the code, and the
 * ordering assertion below would then be pinning a string in a message.
 */
const GIT_CALL = /(?:^|[;&|(]\s*|\$\(\s*|!\s+|\b(?:if|elif|then|else|do|while|until)\s+)git\s/;

/** Code lines only — comments and blanks cannot invoke anything. */
const codeLines = (src) =>
  src.split("\n")
    .map((l, i) => ({ n: i + 1, l }))
    .filter(({ l }) => l.trim() !== "" && !/^\s*#/.test(l));

const firstGitCall = (src) => codeLines(src).find(({ l }) => GIT_CALL.test(l)) ?? null;

for (const f of COVERED) {
  test(`${f} unsets both ambient git variables, ahead of every git call`, () => {
    const src = read(f);
    const lines = src.split("\n");

    // BOTH names on ONE line, and exactly one such line. Spelled as an
    // equality against the whole line rather than a `/unset GIT_DIR/` match,
    // because the failure this guards is `unset GIT_DIR` alone surviving a
    // cleanup — which every substring match on either name still passes.
    const at = lines.indexOf(LINE);
    assert.notEqual(at, -1,
      `${f} lost \`${LINE}\`. Whichever half is inert in this script today has no behavioural test that can tell, and the other half's fixtures pass on a line that unsets only one of the two.`);
    assert.equal(lines.filter((l) => l === LINE).length, 1,
      `${f} carries \`${LINE}\` more than once — one of them is unreachable or redundant, and a reader cannot tell which is the live one`);

    // The property that actually matters. An unset BELOW the calls it protects
    // is not a fix, exactly as a locale pin below its own pipelines is not a
    // pin — and presence alone stays green on that mutant.
    const git = firstGitCall(src);
    assert.ok(git,
      `${f} appears to invoke no git at all, so this assertion would hold vacuously. Either the script stopped using git — in which case it belongs in EXEMPT, not COVERED — or GIT_CALL no longer recognises the spelling it uses.`);
    assert.ok(at + 1 < git.n,
      `${f} unsets the ambient git variables at line ${at + 1}, but line ${git.n} already runs git above it: ${JSON.stringify(git.l)}`);
  });
}

// #1020's remedy names a placement, not just a presence, and the placement is
// forced from both sides. Below, because locale-pin-prose.test.mjs's PROLOGUE
// regex admits only comments, blanks and `set -[eux]+` above the locale pin
// and would refuse an `unset` there. DIRECTLY below, because anything else
// that crept between the two would be work running under neither correction
// — the same argument the locale pin makes for itself, applied to the `unset`
// it now shelters.
//
// claim-ticket.sh and instruments.sh are absent here and that is not an
// oversight: neither carries a locale pin (both are deliberately off
// locale-pin-prose.test.mjs's own PINNED list), so there is nothing for their
// line to sit under and the ordering assertion above is the whole constraint.
const PINNED_TOO = COVERED.filter((f) => !["claim-ticket.sh", "instruments.sh"].includes(f));

for (const f of PINNED_TOO) {
  test(`${f} unsets directly below its locale pin, with nothing working in between`, () => {
    const lines = read(f).split("\n");
    const pin = lines.findIndex((l) => /^export LC_ALL=C\b/.test(l));
    assert.notEqual(pin, -1,
      `${f} lost its locale pin, so this file's placement claim no longer has an anchor; locale-pin-prose.test.mjs owns that failure`);

    const next = lines.slice(pin + 1).find((l) => l.trim() !== "" && !/^\s*#/.test(l));
    assert.equal(next, LINE,
      `${f}'s first working line below \`export LC_ALL=C\` is ${JSON.stringify(next)}, not \`${LINE}\`. Anything inserted between the two runs under neither correction.`);
  });
}

// The census, and the reason it is a test rather than a paragraph: #1020's own
// prose numbers had drifted by the time anyone acted on them, because nothing
// re-derived them. A new script that shells out to git now has to make a
// decision — carry the line, or record why not — instead of inheriting the
// exposure by default.
test("every script that invokes git either unsets the ambient variables or is exempt on the record", () => {
  const scripts = readdirSync(DIR).filter((n) => n.endsWith(".sh")).sort();
  assert.ok(scripts.length > 0, "fixture: no .sh files found, so this scan would pass over nothing");

  const usesGit = scripts.filter((f) => firstGitCall(read(f)) !== null);
  const uncovered = usesGit.filter((f) => !COVERED.includes(f));

  assert.deepEqual(uncovered.sort(), Object.keys(EXEMPT).sort(),
    `a script that invokes git is neither in COVERED nor in EXEMPT. Add \`${LINE}\` below its locale pin (or below \`set -eu\` if it has none) and a behavioural fixture for each half that reproduces; or, if an ambient variable measurably cannot make it answer wrongly, add it to EXEMPT with that measurement. Do not simply widen this list.`);

  // The other direction, so a script cannot be listed as exempt after it has
  // stopped using git — a stale entry reads as a considered exemption and is
  // really just a name nobody removed.
  for (const f of Object.keys(EXEMPT)) {
    assert.ok(usesGit.includes(f),
      `${f} is recorded as exempt from \`${LINE}\` but no longer invokes git — delete the entry rather than leaving a justification for a hazard that is gone`);
    assert.ok(EXEMPT[f].length > 40,
      `${f}'s exemption must carry the measurement or the reason that settled it, not a placeholder`);
  }

  // Every COVERED script must really be in the scanned set, or a rename would
  // leave its entry pinning a file that no longer exists while every
  // assertion above skipped it.
  for (const f of COVERED) {
    assert.ok(scripts.includes(f), `${f} is listed in COVERED but is not a .sh file in this directory`);
  }
});
