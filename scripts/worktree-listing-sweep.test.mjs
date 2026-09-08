// Regression gate for #551, and the durable half of its enumeration.
//
// A worktree path may legally contain a newline (APFS and ext4 both allow it),
// and `git worktree list --porcelain` terminates every attribute with one — so
// one record becomes two, `substr($0,10)` truncates the path at the newline, and
// every consumer downstream is handed a path that is not on disk. #185 fixed
// that in inflight.sh. #551 is the observation that three sibling scripts
// carried the same shape — and the ticket named ONE parse site per script while
// reap.sh and release-ticket.sh each read the listing at several, including the
// post-removal registry re-read and the fresh listing a halted release is judged
// from, neither of which any ticket mentions.
//
// So the pin is not "the three named sites were fixed" — that is exactly the
// fix that ships without closing its own ticket. It is the property: no fleet
// shell script reads the worktree listing raw. A read added tomorrow, at a site
// nobody has thought of yet, fails here rather than silently truncating.
//
// The two files allowed their own `git worktree list`, each with its reason:
//
//   worktree.sh   IS the reader — `wt_listing`, `--porcelain -z` into a temp
//                 file, then `tr '\n\000' '\001\n'`.
//   inflight.sh   carries its own copy of that shape, landed by #185 and named
//                 by #551 as the reference implementation and out of scope.
//                 Its read is `-z` already, so it is not the defect; folding it
//                 into worktree.sh is a separate change with its own risk, and
//                 this gate would notice if someone did fold it.
//
// Zero deps: `node --test scripts/worktree-listing-sweep.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, skipWithoutRepo, trackedShellScripts } from "./repo-root.mjs";

const DIR = fileURLToPath(new URL(".", import.meta.url));

// Needs an ambient git working tree: this gate asks git what ships rather than
// walking the directory. `repoRoot` answers `null` where there is none — a `git
// archive` extraction, which is how review specialists measure the suite
// (#1056) — and the tests below then DECLINE with a reason instead of running,
// because the tree they would police is not reachable from here. Until #1149
// this threw at module load and node could only report it as one synthetic
// failing test at line 1.
const ROOT = repoRoot(DIR);
const SKIP_WITHOUT_REPO = skipWithoutRepo(ROOT, "this sweep over what ships");

/**
 * Every tracked `*.sh` in the repo, so a new script cannot join unnoticed.
 *
 * Empty ONLY because the root lookup could not answer, in which case every test
 * below is skipped. A root that answers and lists nothing is a different
 * condition — the wrong repository, or a broken glob — and it must reach the
 * non-vacuity test below and fail there.
 */
const SHELL_SCRIPTS = ROOT === null ? [] : trackedShellScripts(ROOT);

/**
 * `src` as LOGICAL lines: a trailing backslash folds the next physical line in,
 * and the pair keeps the number of the line the statement STARTED on.
 *
 * A gate that scans physical lines pins one way of typing the defect rather than
 * the defect. Measured: `git worktree \` + `  list --porcelain` is valid POSIX
 * sh, reads the listing exactly as rawly as the one-line spelling, and walked
 * through this whole file green — the three words simply never appeared on one
 * line for the scan to see.
 */
function logicalLines(src) {
  const out = [];
  const phys = src.split("\n");
  let buf = "";
  let start = 0;
  for (let i = 0; i < phys.length; i++) {
    if (buf === "") start = i + 1;
    const line = buf === "" ? phys[i] : phys[i].replace(/^\s+/, "");
    const joined = buf === "" ? line : `${buf} ${line}`;
    if (/\\$/.test(line)) {
      buf = joined.slice(0, -1);
      continue;
    }
    out.push([start, joined]);
    buf = "";
  }
  if (buf !== "") out.push([start, buf]);
  return out;
}

/**
 * Is the character at `idx` inside a quoted string?
 *
 * A scan rather than "is there a quote before the phrase", which is what this
 * asked and is a different question with the same answer only by luck. Measured:
 * `raw=$(cd "$HOME" && git worktree list --porcelain)` is a raw read, and the
 * quotes around `$HOME` — closed long before `git` — excluded it. Every real
 * invocation here expands or redirects through a quote somewhere, so any test
 * that keys on a quote's mere presence ahead of the phrase excludes the very
 * population being scanned for. Parity is what separates the two: an OPEN quote
 * at the phrase means the phrase is text, a closed one means it is code.
 */
function quoted(line, idx) {
  let q = null;
  for (let i = 0; i < idx; i++) {
    const c = line[i];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") {
      q = c;
    }
  }
  return q !== null;
}

/** `git` with any options between it and the subcommand — `git -C "$d" worktree list`. */
const INVOCATION = /\bgit\b.*?\bworktree\s+list\b/;

/**
 * Logical lines of `src` that INVOKE `git worktree list`, as opposed to naming
 * it.
 *
 * Two exclusions, both load-bearing, and both for lines that NAME the command
 * without running it. A comment describes git's output shape, and these scripts
 * do that constantly — including in the comments this fix wrote — so a scan that
 * counts them reports every file. The other is the phrase sitting inside an open
 * quote: that is a banner `echo "\$ git worktree list …"` printing the command
 * for an operator, or a diagnostic string naming what failed. Both are inert
 * text, and worktree.sh and worktree-audit.sh each carry one.
 *
 * The match itself allows options between `git` and its subcommand. `git -C
 * "$dir" worktree list` is a raw read by any measure and the literal three-word
 * phrase does not occur in it — and `git -C` is the dominant git spelling in
 * these scripts, so it is the form the next person reaches for.
 */
function invocations(src) {
  return logicalLines(src)
    .filter(([, line]) => !/^\s*#/.test(line))
    .map(([n, line]) => [n, line, INVOCATION.exec(line)])
    .filter(([, , m]) => m !== null)
    .filter(([, line, m]) => !quoted(line, m.index))
    .map(([n, line]) => [n, line]);
}

const ALLOWED = ["scripts/worktree.sh", "scripts/inflight.sh"];

// A guard on the guard, and the half the skip above leans on: a bad glob, a
// moved directory or a `git ls-files` that answers nothing turns the two
// sweeping tests below into vacuous passes over an empty list — green, and
// blind. The skip is allowed to empty that list for ONE reason (no working
// tree); every other reason has to land here as a failure. The allowed readers
// are the named subjects, so they are what this asserts is present.
test("the sweep sees the scripts it is supposed to police", { skip: SKIP_WITHOUT_REPO }, () => {
  for (const f of ALLOWED) {
    assert.ok(
      SHELL_SCRIPTS.includes(f),
      `${f} is not in the tracked-script list — the glob or the root above is broken, not the script`,
    );
  }
});

test("only worktree.sh and inflight.sh read the worktree listing directly", { skip: SKIP_WITHOUT_REPO }, () => {
  const offenders = SHELL_SCRIPTS
    .filter((f) => !ALLOWED.includes(f))
    .flatMap((f) => invocations(readFileSync(join(ROOT, f), "utf8")).map(([n, l]) => `${f}:${n}: ${l.trim()}`));
  assert.deepEqual(
    offenders,
    [],
    "every other script must read through wt_listing — a raw read truncates a path holding a newline (#551)",
  );
});

// The other direction. Without it the assertion above passes just as happily
// over a tree where NOTHING reads the listing at all — a `wt_listing` deleted,
// or an `ALLOWED` entry that has stopped being a reader — and the gate would be
// pinning the absence of a feature rather than the shape of one.
test("the two allowed readers really do read it, and both read it -z", { skip: SKIP_WITHOUT_REPO }, () => {
  for (const f of ALLOWED) {
    const src = readFileSync(join(ROOT, f), "utf8");
    const calls = invocations(src);
    assert.ok(calls.length > 0, `${f} is listed as a reader but invokes nothing`);
    for (const [n, line] of calls) {
      assert.match(
        line,
        /--porcelain -z/,
        `${f}:${n} must read NUL-terminated — the plain porcelain ends a record on a newline inside a path`,
      );
    }
  }
});

// `awk -v RS='\0'` is the form #185 proposed and measurement rejected: macOS
// BWK awk 20200816 stops at the first NUL and reports ONE record for a listing
// of any length, in all three spellings — which would have made inflight.sh
// refuse every ticket. It reads like the obvious way to consume `-z` output, so
// the next person to touch either reader will reach for it.
//
// Any `RS=` at all, not only one spelled with a literal `\0`. The separator has
// no other use in this tree — no script sets `RS` for any reason today — so the
// blunt scan costs nothing and the narrow one measurably missed the defect:
// `sep=$(printf '\0'); awk -v RS="$sep"` reintroduces the identical one-record
// read (measured on BWK awk 20200816: NR=1, against 3 for the same file through
// `tr`), and the literal-`\0` pattern never saw it. A legitimate `RS=` arriving
// later fails here loudly and is answered by naming it, which is the direction
// worth erring in for a scan whose whole job is catching what nobody expected.
test("no script consumes the -z listing with awk's record separator", { skip: SKIP_WITHOUT_REPO }, () => {
  for (const f of SHELL_SCRIPTS) {
    const src = readFileSync(join(ROOT, f), "utf8");
    for (const [n, line] of logicalLines(src)) {
      if (/^\s*#/.test(line)) continue;
      assert.doesNotMatch(
        line,
        /\bRS\s*=/,
        `${f}:${n}: BWK awk reports one record for the whole listing — swap the separators with tr instead`,
      );
    }
  }
});
