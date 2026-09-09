// Regression gate for #730's own structural gap, named as unverified finding 4
// in this PR's own review: every known site got hand-patched, but nothing
// would catch an EIGHTH one added tomorrow without the flag. The class:
// `status.showUntrackedFiles = no` makes `git status --porcelain` exit 0 with
// EMPTY output over a worktree holding untracked work, so any probe whose
// EMPTY answer licenses a keep/reap/release/rebase decision has to pin an
// explicit untracked-files mode (`-uall`/`-unormal`/`-uno`) on the command
// line — the config cannot be trusted to leave it at the default. reap.sh's
// branch sweep states the class in full; this file is the enforcement that
// does not depend on remembering to re-derive it by hand next time.
//
// So the pin is not "the seven known sites carry the flag" — that is exactly
// the fix that ships without closing its own gap. It is the property: no
// fleet shell script runs `git status --porcelain` (directly, or through
// reap.sh's `git_probe` wrapper, which only forwards to `git`) without an
// explicit untracked-files mode, except the one named, deliberate exception.
//
// instruments.sh's bare `--porcelain` is the sole allowed exception: it
// prints to stderr to say WHAT changed, after a digest over `git ls-files`
// (tracked files only) has already refused — a report, not a gate, so the
// silenced mode cannot hide the thing being reported.
//
// Zero deps: `node --test scripts/git-status-untracked-mode-sweep.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, skipWithoutRepo, trackedShellScripts } from "./repo-root.mjs";

const DIR = fileURLToPath(new URL(".", import.meta.url));

// Needs an ambient git working tree — same precondition, same reason, as the
// other sweeps in this directory (repo-root.mjs's own header). Where there is
// none (a `git archive` extraction) the tests below DECLINE with a reason
// rather than running, per #1149.
const ROOT = repoRoot(DIR);
const SKIP_WITHOUT_REPO = skipWithoutRepo(ROOT, "this sweep over what ships");

/**
 * Every tracked `*.sh` in the repo, so a new script cannot join unnoticed.
 *
 * Empty ONLY because the root lookup could not answer, in which case every
 * test below is skipped. A root that answers and lists nothing is a
 * different condition and must reach the non-vacuity test below and fail
 * there.
 */
const SHELL_SCRIPTS = ROOT === null ? [] : trackedShellScripts(ROOT);

/**
 * Drop a trailing `#` comment. Quote-aware: a `#` inside a `die` message or a
 * printed banner is text, not a comment marker — stripping at it would cut a
 * real command in half. Same shape as muted-git-guard-sweep.test.mjs's
 * `stripComment`, independently kept here rather than shared: the two files
 * police different commands and a shared helper would couple them for no
 * reason either needs.
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
 * One logical shell statement per element (with its starting line number),
 * comments already gone, trailing-backslash continuations joined.
 *
 * None of the seven pinned sites in this repo actually span lines, but a
 * scanner that only sees physical lines pins one way of typing the command
 * rather than the command — see worktree-listing-sweep.test.mjs's identical
 * reasoning for `git worktree list \` + newline continuation.
 */
function statements(text) {
  const out = [];
  const phys = text.split("\n").map(stripComment);
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
    if (joined.trim() !== "") out.push([start, joined]);
    buf = "";
  }
  if (buf.trim() !== "") out.push([start, buf]);
  return out;
}

/**
 * Is the character at `idx` inside an open quote? Same shape as
 * worktree-listing-sweep.test.mjs's `quoted` — a banner
 * (`printf '$ git … status --porcelain -uall\n'`) NAMES the command inside a
 * quote rather than running it, and must not be scanned as an invocation.
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

// `git` or `git_probe` (reap.sh's own wrapper, which only forwards its args
// to `git "$@"` — grep confirms it is the sole definition and reap.sh the
// sole file that defines or calls it, but the sweep matches the spelling
// rather than trusting that to stay true) followed, anywhere later on the
// same logical statement, by `status` and then `--porcelain`. Requiring
// `status` in between is what keeps `git worktree list --porcelain` (a
// different subcommand, no untracked-files mode to speak of) out of this
// sweep without a file-by-file exclusion list.
const INVOCATION = /\b(?:git|git_probe)\b[^\n]*?\bstatus\b[^\n]*?--porcelain\b/;

/** Logical statements of `src` that INVOKE `status --porcelain`, not merely name it in a quote. */
function invocations(src) {
  return statements(src)
    .map(([n, line]) => [n, line, INVOCATION.exec(line)])
    .filter(([, , m]) => m !== null)
    .filter(([, line, m]) => !quoted(line, m.index))
    .map(([n, line]) => [n, line]);
}

/** An explicit untracked-files mode, short or long form. Absence is the defect. */
const HAS_MODE = /(?:^|\s)(?:-u(?:no|normal|all)?|--untracked-files(?:=|\s))/;

/**
 * The one deliberate exception, named exactly rather than by file: a report
 * line run AFTER a digest over tracked files (`git ls-files`) has already
 * refused, so the silenced mode cannot hide what it prints (reap.sh's
 * comment states this in full). Matched on file AND a fragment of the actual
 * command, not the file alone — a second, real gate added later to
 * instruments.sh must not inherit this exemption for free.
 */
const ALLOWED = [
  { file: "plugin/scripts/instruments.sh", fragment: 'status --porcelain -- $set' },
];

function isAllowed(file, line) {
  return ALLOWED.some((a) => a.file === file && line.includes(a.fragment));
}

// A guard on the guard: a bad glob, a moved directory, or a `git ls-files`
// that answers nothing turns the sweep below into a vacuous pass over an
// empty list — green, and blind. Named sites, because those are exactly the
// ones this ticket's own review found undercounted once by hand.
test("the sweep sees the scripts it is supposed to police", { skip: SKIP_WITHOUT_REPO }, () => {
  for (const f of [
    "plugin/scripts/reap.sh",
    "plugin/scripts/release-ticket.sh",
    "plugin/scripts/worktree-audit.sh",
    "plugin/scripts/no-undo-audit.sh",
    "plugin/scripts/claim-ticket.sh",
    "plugin/scripts/instruments.sh",
  ]) {
    assert.ok(
      SHELL_SCRIPTS.includes(f),
      `${f} is not in the tracked-script list — the glob or the root above is broken, not the script`,
    );
  }
});

test("every git status --porcelain invocation pins an explicit untracked-files mode", { skip: SKIP_WITHOUT_REPO }, () => {
  const offenders = SHELL_SCRIPTS
    .flatMap((f) => invocations(readFileSync(join(ROOT, f), "utf8")).map(([n, l]) => [f, n, l]))
    .filter(([f, , l]) => !HAS_MODE.test(l) && !isAllowed(f, l))
    .map(([f, n, l]) => `${f}:${n}: ${l.trim()}`);
  assert.deepEqual(
    offenders,
    [],
    "a probe whose EMPTY answer licenses an action must pin an explicit -u mode — "
      + "status.showUntrackedFiles=no silences a bare --porcelain at rc 0 (#730)",
  );
});

// The other direction. Without it the assertion above passes just as happily
// over a tree where NOTHING invokes `status --porcelain` at all — every
// caller renamed to a different subcommand, or the flag check itself broken
// so it matches nothing — and the gate would be pinning the absence of a
// population rather than the shape of one.
test("the sweep really is seeing status --porcelain invocations, not matching nothing", { skip: SKIP_WITHOUT_REPO }, () => {
  const total = SHELL_SCRIPTS.flatMap((f) => invocations(readFileSync(join(ROOT, f), "utf8")));
  assert.ok(total.length >= 7, `expected at least the seven #730 sites, found ${total.length}`);
});

// The allowlist itself has to still name a real, current exception — an
// `instruments.sh` rewrite that drops the report line would leave `ALLOWED`
// pointing at nothing, and the sweep above would read as "nothing to
// exempt" rather than "the exemption stopped applying".
test("the allowed exception is a real line in the file it names", { skip: SKIP_WITHOUT_REPO }, () => {
  for (const { file, fragment } of ALLOWED) {
    const src = readFileSync(join(ROOT, file), "utf8");
    assert.ok(
      src.includes(fragment),
      `${file} no longer contains ${JSON.stringify(fragment)} — update or drop the allowlist entry`,
    );
  }
});
