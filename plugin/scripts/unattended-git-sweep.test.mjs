// Regression gate for #347, and the ticket's own recorded enumeration.
//
// #92 named the hazard for one call: an unattended `git` network call with no
// prompt suppression and no bound can sit on a credential or host-key prompt
// nobody will answer, or on a transport that connects and then goes quiet, and
// either way it holds a fleet slot until something outside kills it. #346 built
// the mechanism that closes it. #347 is the observation that inflight.sh's
// probe 2 was the only call routed through it.
//
// The enumeration this file records, so the next reader does not re-derive it —
// every raw `git` network call in the fleet's shell scripts at the time, from
// the Brief's own command, `git ls-files '*.sh' | xargs grep -nE 'git
// (ls-remote|push|fetch|clone)|gh (issue|pr|api)'`:
//
//   inflight.sh        ls-remote --heads origin              already bounded (#346)
//   release-ticket.sh  ls-remote --heads origin refs/heads/… routed here
//   prove-merge.sh     fetch --quiet origin                  routed here
//   reap.sh            fetch --prune --quiet origin          routed here
//   verify-sha.sh      fetch --quiet origin <branch>         routed here
//
// DELIBERATELY LEFT, both with their reason:
//
//   - Every `gh` call (claim-ticket.sh, drop-merged-label.sh, inflight.sh,
//     release-ticket.sh, .github/scripts/apply-ruleset.sh). `gh` bounds
//     itself: measured during the PR #332 review, `gh issue view` against a
//     silent listener failed on its own at 10.0s with `net/http: TLS handshake
//     timeout`. Wrapping it would buy a second bound over the first.
//   - `.github/workflows/ci.yml`'s `git fetch`. Not a `*.sh` and not a fleet
//     member: it runs under `actions/checkout`'s credentials on a runner that
//     is torn down, so there is no fleet slot to hold and no prompt to answer.
//
// The sweep below is the durable half. The list above rots; a scan does not,
// and it is what catches the sibling nobody thought of — the failure mode #347
// exists to report, where a fix landed on the one call a ticket named and every
// call beside it stayed broken.
//
// Zero deps: `node --test plugin/scripts/unattended-git-sweep.test.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { repoRoot, skipWithoutRepo, trackedShellScripts } from "./repo-root.mjs";

// This file needs an ambient git WORKING TREE, not just the sources: it asks git
// what ships rather than walking the directory, so both calls below want a
// `.git` at or above them. A checkout and a worktree both have one; a `git
// archive` extraction does not, and this file's tests DECLINE there with a
// reason instead of running — the tree they would police is not reachable from
// an extraction. That is the extraction missing a repo, not a defect in the tree
// under it, and a review or CI step that unpacks an archive should run this one
// against a checkout. Until #1149 the same condition threw at module load and
// node could only report it as one synthetic failing test at line 1.
const ROOT = repoRoot(fileURLToPath(new URL(".", import.meta.url)));
const SKIP_WITHOUT_REPO = skipWithoutRepo(ROOT, "this sweep over what ships");

// Tracked `*.sh` only, and from git rather than a directory walk: an untracked
// scratch script is not what ships, and a fleet script that moves out of this
// directory must not fall out of the sweep with it.
//
// Empty ONLY because the root lookup could not answer, in which case both tests
// are skipped. A root that answers and lists nothing is a different condition —
// the wrong repository, or a broken glob — and it must reach the non-vacuity
// test below and fail there.
const SHELL_SCRIPTS = ROOT === null ? [] : trackedShellScripts(ROOT);

// Whole-line `#` comments only, blanked rather than deleted so line numbers
// survive for the diagnostic. A trailing `code  # note` keeps its comment, and
// a `#` inside a string is left alone — blanking either would delete real code,
// and neither can hide a command from this scan, which is what it is for.
const stripHashComments = (source) =>
  source.split("\n").map((l) => (/^\s*#/.test(l) ? "" : l)).join("\n");

// The verbs that reach the network. `pull` and `clone` appear in no fleet
// script today and are swept anyway: the point of a sweep is the call that has
// not been written yet.
const RAW_NETWORK_GIT = /\bgit\s+(?:-[^\s]+\s+|-c\s+\S+\s+|-C\s+\S+\s+)*(ls-remote|fetch|push|clone|pull)\b/g;

// A `git fetch` inside a QUOTED STRING is not a call, and both of the fleet's
// conventions put one there: the trace line every script prints before it acts
// (`echo "\$ git fetch …" >&2`), and the refusal every script prints when the
// call fails (`die "git fetch did not finish within …"`). Measured — without
// this, the sweep reports seven offenders across four scripts on a tree where
// every one of those calls is routed, which is worse than a useless assertion:
// the obvious way to quiet it is to delete it.
//
// Odd quote count before the match means it opened a string and did not close
// it. Backslash escapes are dropped first so `\"` inside one does not read as a
// closing quote. Known ceiling: a heredoc body, and a string that opens on one
// line and closes on another, are judged per line — no fleet script writes a
// git call in either, and the failure direction is a false OFFENDER, which is
// read and dismissed, never a call let through.
const insideString = (prefix) => {
  const bare = prefix.replace(/\\./g, "");
  return (bare.split('"').length - 1) % 2 === 1 || (bare.split("'").length - 1) % 2 === 1;
};

// A guard on the guard, and the half the skip above leans on: a bad glob, a
// moved directory or a `git ls-files` that answers nothing turns every
// assertion below into a vacuous pass over an empty list — green, and blind.
// The skip is allowed to make that list empty for ONE reason (no working tree);
// every other reason has to land here as a failure. Named scripts, because
// those are the ones this file exists to police.
test("the sweep sees the scripts it is supposed to police", { skip: SKIP_WITHOUT_REPO }, () => {
  for (const s of ["inflight.sh", "release-ticket.sh", "prove-merge.sh", "reap.sh", "verify-sha.sh"]) {
    assert.ok(
      SHELL_SCRIPTS.some((f) => f.endsWith(`/${s}`)),
      `${s} is not in the tracked-script list — the glob or the root above is broken, not the script`,
    );
  }
});

test("no fleet shell script makes a raw git network call — they all route through net.sh (#347)", { skip: SKIP_WITHOUT_REPO }, () => {
  const offenders = [];
  for (const f of SHELL_SCRIPTS) {
    const code = stripHashComments(readFileSync(join(ROOT, f), "utf8"));
    for (const line of code.split("\n")) {
      for (const m of line.matchAll(RAW_NETWORK_GIT)) {
        if (insideString(line.slice(0, m.index))) continue;
        offenders.push(`${f}: ${m[0].trim()}  in  ${line.trim()}`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    "an unattended `git` network call is running raw. It can prompt for a credential or a host key with nobody there to answer, or stall on a transport that connects and goes quiet, and either holds a fleet slot indefinitely (#92). Route it through net.sh's `net_git` — which takes the subcommand as arguments, so its own dispatch carries no verb and this sweep does not see it — rather than copying transport flags to the call site, which does not bound the connect phase in any case since git exposes no knob for it (#346, #347).");
});

// The other direction. The sweep above is an absence, and an absence is also
// what a tree with the calls DELETED would show — so on its own it cannot tell
// "routed" from "gone". These are the five call sites the enumeration names;
// each must still source the lib and still reach it.
test("every script that made one of those calls still sources net.sh and reaches net_git (#347)", { skip: SKIP_WITHOUT_REPO }, () => {
  for (const f of ["inflight.sh", "release-ticket.sh", "prove-merge.sh", "reap.sh", "verify-sha.sh"]) {
    const code = stripHashComments(readFileSync(join(ROOT, "plugin", "scripts", f), "utf8"));
    assert.match(code, /\.\s+"\$net_lib"/,
      `${f} no longer sources net.sh, so whatever network call it makes is unbounded again`);
    assert.match(code, /\bnet_git\s+"/,
      `${f} sources net.sh but calls nothing in it — the sweep above would stay green on a call that was deleted rather than routed`);
  }
});
