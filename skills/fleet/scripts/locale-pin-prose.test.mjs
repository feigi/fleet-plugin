// #582. Six scripts carry `export LC_ALL=C`, and this is the only assertion
// about it that CI can actually run.
//
// The behavioural gate lives in no-undo-audit.test.mjs: a conflicting path
// holding an invalid UTF-8 byte must still name every conflict. That test is
// correct on both platforms, but it only FAILS on one. BSD `tr` exits 1 on the
// byte; GNU `tr` is byte-oriented and passes it through, as are GNU `sed`,
// `paste` and `awk` — measured with coreutils 9.11, gnu-sed 4.10 and gawk 5.4.1
// ahead of PATH, the whole of no-undo-audit.test.mjs stays green with
// `export LC_ALL=C` deleted. `ci.yml` runs the suite on ubuntu-latest. So on the
// one platform CI uses, deleting the pin from any of the six is invisible, and
// the obvious cleanup — "a redundant export, drop it" — ships green.
//
// Hence a source assertion, which this repo already uses for exactly this shape
// (no-undo-audit.test.mjs pins a phrase in its own script's comment, and
// derive-testcmd.test.mjs pins that two regex literals stay byte-identical).
//
// What it pins and what it does not. PRESENCE: `\b` after `LC_ALL=C`, not `$`,
// so `export LC_ALL=C LANG=C` — strictly stronger — does not read as a
// regression; measured, the `$` form false-alarms on it. PLACEMENT: only that
// the pin sits in the file's prologue, ahead of the first line that does any
// work. That is the mutant presence alone misses — the pin moved below its own
// pipelines is genuinely broken and a presence check stays green on it. It does
// NOT pin per-script behaviour: four of the six have no regression fixture at
// all, which is deliberate and recorded on the PR rather than hidden.
//
// Not a list of every script that COULD carry the pin. claim-ticket.sh,
// prove-merge.sh, drop-merged-label.sh and verify-sha.sh do not have it; whether
// claim-ticket.sh's generated runner needs one is #600's question, not this
// file's. Adding a script here is a decision, which is why the list is written
// out rather than globbed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PINNED = [
  "derive-testcmd.sh",
  "inflight.sh",
  "no-undo-audit.sh",
  "reap.sh",
  "release-ticket.sh",
  "worktree-audit.sh",
];

const read = (f) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");

// The prologue: everything a script may do before pinning the locale. A blank
// line, a comment, the shebang, and `set -eu` — none of them runs a
// byte-sensitive tool, so none of them can be caught out by the ambient locale.
const PROLOGUE = /^(#.*|set -[eux]+|\s*)$/;

for (const f of PINNED) {
  test(`${f} pins the locale, in its prologue`, () => {
    const lines = read(f).split("\n");
    const at = lines.findIndex((l) => /^export LC_ALL=C\b/.test(l));
    assert.notEqual(at, -1,
      `${f} lost \`export LC_ALL=C\`. On Linux — the only platform CI runs — every byte-sensitive tool in it goes back to accepting whatever the operator's LANG says, and no behavioural test in this suite can tell.`);

    const early = lines.slice(0, at).findIndex((l) => !PROLOGUE.test(l));
    assert.equal(early, -1,
      `${f} pins the locale at line ${at + 1}, but line ${early + 1} already does work above it: ${JSON.stringify(lines[early])}. An export below the pipelines it protects is not a pin.`);
  });
}

// #612. Everything above guards the pin. What it does not guard is the
// PRECONDITION that makes a file-global pin safe, which five of the six state
// as prose and nothing checked: "nothing in this script sorts, folds case, or
// uses a `[a-z]` range or a POSIX class". That sentence shipped FALSE.
// `no-undo-audit.sh` held `${back%"${back##*[![:space:]]}"}` — a POSIX class,
// and locale-sensitive (measured: a trailing NBSP is stripped under
// `en_US.UTF-8` and kept under `C`) — in the worktree-linkage check, far out
// of sight of the paragraph denying any class existed and never read beside
// it. PR #599 corrected that one paragraph by hand. Nothing stopped
// the next drift, and a `sort` or a `grep -i` added to any of the six would
// keep every assertion above green.
//
// So scan each pinned script's CODE for the constructs the prose denies and
// require the result to equal a list written out here. A newly added one fails;
// a listed one that DISAPPEARS fails too, so the inventory can only move in
// both directions at once and a script cannot quietly become stricter than its
// own comment claims. That list is also the escape hatch — a legitimate
// `sort -u` over ASCII-only data belongs in it — and adding an entry is the
// moment the script's comment gets fixed, since the entry exists for no other
// reason.
//
// Why not shellcheck (#612's second option): it has no rule for this class and
// no plugin mechanism to add one, so that route is a fork of shellcheck.
// Why not simply delete the claim (#612's third): re-verified on this commit,
// the claim is TRUE in all five, and `no-undo-audit.sh`'s narrower "one,
// unreachable" is true in the sixth. Deleting a true justification to avoid
// having to check it is the trade that produced the shipped-false sentence.
//
// Behaviour, not just prose, is what these patterns track: each is a construct
// whose RESULT `LC_ALL=C` changes — collation order for `sort` and a `[a-z]`
// range, the case map for `-i`/`toupper`, class membership for `[:space:]`.
const SENSITIVE = [
  [/\[:[a-z]+:\]/, "POSIX character class"],
  [/\[[^\]]*[A-Za-z0-9]-[A-Za-z0-9][^\]]*\]/, "collation range"],
  [/\bsort\b/, "sort"],
  [/\btr\b[^|;&]*[A-Za-z0-9]-[A-Za-z0-9]/, "tr range"],
  [/\bgrep\b(\s+-\S+)*\s+(-[A-Za-z]*i[A-Za-z]*|--ignore-case)\b/, "case-insensitive grep"],
  [/\b(toupper|tolower)\s*\(/, "case folding"],
  [/\$\{[A-Za-z_]\w*[\^,]/, "shell case conversion"],
];

// ponytail: whole-line `#` comments only, the same ceiling as
// strip-comments.mjs. A trailing `cmd  # mentions [a-z]` false-alarms into the
// list below; a construct hidden in one is impossible, which is the direction
// that matters here.
export function localeSensitive(source) {
  const hits = [];
  source.split("\n").forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const found = SENSITIVE.find(([re]) => re.test(line));
    if (found) hits.push({ line: i + 1, what: found[1], text: line.trim() });
  });
  return hits;
}

// Keyed by script, values are the exact source lines. Absent means the
// comment's "none" is the whole inventory.
//
// The two `*[!0-9]*` entries are what this guard found on its first run: both
// scripts' comments said they used a `[a-z]` range NOWHERE while each held a
// digit range in its issue-number guard — the shipped-false shape again, live
// on `main`, in two more scripts than #612 knew about. Measured inert and the
// comments corrected to say so, rather than deleted: under `C`, `en_US.UTF-8`,
// `de_DE.UTF-8` and `tr_TR.UTF-8` the range matches the ASCII digits and
// nothing else — superscript `²`, Arabic-Indic digits and `½` are excluded in
// all four, so no locale reachable here reads the guard differently.
const ALLOWED = {
  "inflight.sh": [
    `case "$n" in ''|*[!0-9]*|0?*) die "issue must be a number, got '$n'";; esac`,
  ],
  "no-undo-audit.sh": ['back=${back%"${back##*[![:space:]]}"}'],
  "release-ticket.sh": [
    `case "$issue" in ''|*[!0-9]*|0?*) die "issue must be a number, got '$issue'";; esac`,
  ],
};

for (const f of PINNED) {
  test(`${f}'s locale precondition holds in code, not only in prose`, () => {
    const hits = localeSensitive(read(f));
    assert.deepEqual(hits.map((h) => h.text), ALLOWED[f] ?? [],
      `${f}'s locale-sensitive inventory no longer matches the one recorded in locale-pin-prose.test.mjs. Found: ${JSON.stringify(hits)}. Either the construct is new — in which case the script's \`export LC_ALL=C\` comment claiming it has none is now false, exactly the way it shipped false in no-undo-audit.sh — or it went away and the entry is stale. Fix the comment and this list together.`);
  });
}

// The mutation the guard exists for: the historical shape, a POSIX class in a
// script whose paragraph denies one. `reap.sh` is long and clean, and the
// mutant is appended at its end — nowhere a reader of the pin comment looks,
// which is the whole reason the real one survived review.
test("the scan catches a construct planted far below the comment denying it", () => {
  const source = read("reap.sh");
  assert.deepEqual(localeSensitive(source), []);
  const lines = source.split("\n");

  for (const [mutant, what] of [
    ['back=${back%"${back##*[![:space:]]}"}', "POSIX character class"],
    ["names=$(printf '%s\\n' \"$x\" | sort)", "sort"],
    ["case $b in [a-z]*) : ;; esac", "collation range"],
    ["upper=$(printf '%s' \"$b\" | tr a-z A-Z)", "tr range"],
    ['printf %s "$b" | grep -qi fix', "case-insensitive grep"],
    ["printf '%s' \"$b\" | awk '{print toupper($0)}'", "case folding"],
    ["x=${x^}", "shell case conversion"],
  ]) {
    const hits = localeSensitive([...lines, mutant].join("\n"));
    assert.deepEqual(hits.map((h) => h.what), [what], `${mutant} went unseen`);
  }
});
