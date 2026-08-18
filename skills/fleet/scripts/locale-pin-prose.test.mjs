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
