#!/usr/bin/env node
// Is a shortlisted ticket's defect still there? (#238)
//
// A backlog ticket is a claim about a tree that has since moved. Nothing
// reconciles the two, so a ticket fixed as a side effect of an unrelated
// commit stays open and `ready-for-agent` — the worked case is #199, closed
// by `b243b4e` while that commit was solving something else, and nobody
// noticed. Phase 0 then counts it as supply and an implementer can claim it,
// take the label, build a worktree and burn a slot before finding there is
// nothing to do.
//
// This does the MECHANICAL half of the check and nothing else. Deciding WHICH
// string settles a ticket needs the ticket read, which phase 0 step 4 already
// does; this takes that string and answers what the tree says about it, with
// the evidence a close would have to cite.
//
// Exit-code contract — the whole interface for a caller that reads no stderr:
//
//   0  live     the defect still reproduces      → offer the ticket
//   1  fixed    provably fixed, evidence in the  → do not offer; close citing
//               payload                            the named commit
//   2  unknown  the question could not be        → offer the ticket, SAYING
//               answered                           the probe could not check
//
// THREE values, deliberately. Two is the defect this file exists to avoid: a
// probe that could not look answers exactly like a probe that looked and found
// nothing (measured across four fleet tools in one run), so collapsing
// `unknown` into either neighbour either drops live supply on a guess or
// reports a defect as live on a spelling the tree stopped using. Same shape as
// `inflight.sh`, and the same code for it.
//
// Exit 2 is also `arg.mjs`'s `die()` code, which is why every guard below can
// simply die: a malformed invocation, a git call that failed, a path that
// cannot be read all land on the verdict that keeps the ticket in the queue.
// The one code that must never be reached by accident is 1 — see the catch at
// the foot of this file.
//
// What it deliberately does NOT do: run a reproduction. #230's check needed a
// purpose-built fixture plus a positive and a negative control, and a
// reproduction run without both misattributes causes rather than merely
// missing defects. That is the general backlog oracle #238 rules out; this
// probe informs supply, and a human or a triage pass closes.

import { execFileSync } from "node:child_process";
import { makeDie, makeArg, makeHas, makeSweep } from "./arg.mjs";

const NAME = "staleness";

const die = makeDie(NAME);
const arg = makeArg(die);
const has = makeHas(die);
const sweep = makeSweep(die);

// Below the value guards, the way candidates.mjs places its parseArgs: where
// both would refuse, the more specific wording wins, and nothing above here
// has run a git call.
sweep(["path", "gone", "present"]);

const path = arg("path");
const gone = arg("gone");
const present = arg("present");
// `--gone`/`--present` are the two shapes a ticket's asked-for change takes,
// and the caller has to say which — the direction is not inferable from the
// string. `--gone` is a defect the fix must REMOVE (the wording a ticket
// quotes as wrong); `--present` is something the fix must ADD (the assertion a
// pin ticket asks for). Refusing both-or-neither rather than defaulting: a
// default here would pick a direction on the caller's behalf and then report
// the opposite verdict with full confidence.
if (has("gone") && has("present")) die("--gone and --present are opposite questions; give one");
if (!gone && !present) die("give --gone <string> (the fix removes it) or --present <string> (the fix adds it)");
if (!path) die("--path <path> is required");

const mode = gone ? "gone" : "present";
const needle = gone ?? present;

// stdio: git's own stderr is forwarded (execFileSync does that precisely
// because `stdio` is absent here), so the diagnostics below name the cause and
// never re-print git's text — the duplication candidates.mjs measured at
// 7,700 B → 15,454 B applies identically.
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function verdict(v, extra) {
  console.log(JSON.stringify({ verdict: v, path, mode, needle, ...extra }));
  process.exitCode = { live: 0, fixed: 1, unknown: 2 }[v];
}

// "Could not check" is a first-class ANSWER, not a failure: it prints the same
// payload shape as the other two so a caller reading only stdout can say
// "offered, could not check" instead of dropping the row.
const unknown = (why, extra = {}) => verdict("unknown", { why, ...extra });

function probe() {
  // The tracked/untracked discriminator, and it runs FIRST because both
  // failures it separates are silent in the other direction. `git show
  // origin/main:<path>` is FATAL, not empty, on a path this repo does not
  // track — while the file may sit right there in the working checkout — so
  // reading that failure as "the file is gone, the fix landed" closes a live
  // ticket. And a GENERATED artifact is untracked by construction: `agent-test`
  // is emitted into a claimed worktree by claim-ticket.sh's heredoc, so every
  // copy under `.worktrees/` is frozen at whenever that worktree was claimed.
  // Measured 2026-08-22: `git ls-tree origin/main -- agent-test` prints nothing
  // at exit 0, `git show origin/main:agent-test` exits 128, and the file is on
  // disk in every claimed worktree. A probe that resolved it by name would
  // measure an arbitrarily old build and report the answer with full
  // confidence, so this file NEVER reads the working tree and never executes
  // what it finds — `origin/main` or `unknown`, nothing else.
  let listing;
  try {
    listing = git(["ls-tree", "origin/main", "--", path]);
  } catch {
    return unknown("`git ls-tree origin/main` failed — the tree could not be read, so nothing about this path is settled");
  }
  if (listing.trim() === "") {
    return unknown(
      "untracked in origin/main — either generated (claim-time heredoc output, whose on-disk copy is a snapshot, not the current form) or absent. Not tracked is not the same fact as does not exist",
      { tracked: false },
    );
  }
  // One entry, and the entry git printed is the path that was asked for. A
  // pathspec matching several entries, or matching something other than what
  // was typed, is a question with more than one answer — which is not an
  // answer. Without this a `--path 'skills/**/*.mjs'` would be read against
  // whatever git listed first.
  const lines = listing.split("\n").filter((l) => l !== "");
  const entry = lines.length === 1 && /^\d+ (\w+) ([0-9a-f]+)\t(.*)$/.exec(lines[0]);
  if (!entry || entry[3] !== path) {
    return unknown("the pathspec did not resolve to exactly this one path in origin/main — give a single literal file path");
  }
  const [, type, blob] = entry;
  // A tree read as a file greps a list of FILENAMES, which is how a probe
  // reports a directory as clean.
  if (type !== "blob") return unknown(`origin/main names a ${type} at this path, not a file`);

  let content;
  try {
    content = git(["cat-file", "blob", blob]);
  } catch {
    return unknown("the blob origin/main names at this path could not be read");
  }
  // The probe's own positive control for the state check: a search over no
  // bytes finds nothing, and "found nothing" is the answer BOTH verdicts below
  // are read off. An empty tracked file is a probe that could not look.
  if (content === "") return unknown("the file is empty in origin/main — a search over no bytes settles nothing", { bytes: 0 });

  const found = content.includes(needle);
  const bytes = Buffer.byteLength(content);

  // The two directions, and which one of them is a verdict on its own.
  //
  // `--present` + found, and `--gone` + not found, both mean the asked-for
  // change is in the tree — but only ONE of them is safe to report off the
  // state alone, and neither is reported off the state alone here, because a
  // wrong `fixed` silently removes real supply from the queue. Both go through
  // the history check below for the commit a close has to cite.
  //
  // The other two are `live`, and `live` is the safe direction: the ticket
  // stays offered. It still carries its bound in `why` — a fix that landed as
  // an EQUIVALENT REWORDING satisfies the ticket while failing a literal
  // string test, measured on #206, whose defect `0dc39ef` had already fixed in
  // wording that appears nowhere in the ticket. So `live` means "this literal
  // string still says the defect is here", never "no fix landed".
  if (mode === "present" && !found) {
    return verdict("live", {
      found: false,
      bytes,
      why: "the asked-for string is absent from the current file — the change has not landed under this spelling. An equivalent rewording would read the same way, so this is a reason to offer the ticket, not a proof nothing landed",
    });
  }
  if (mode === "gone" && found) {
    return verdict("live", {
      found: true,
      bytes,
      why: "the string the ticket quotes as the defect is still in the current file",
    });
  }

  // The evidence bar, and the positive control in one call. `-S` names the
  // commit that last CHANGED this string's count at this path — the one that
  // removed it in `--gone`, the one that introduced it in `--present`.
  //
  // Empty output here is never `fixed`. In `--gone` it is the whole positive
  // control: the string absent from the current file AND never present at this
  // path in this history means the probe was pointed at the wrong spelling or
  // the wrong file, and reading that as "the fix landed" is how a probe with no
  // control closes a live ticket. In `--present` it is a history that cannot
  // account for a string that is right there — a shallow clone, a graft — and
  // an answer nobody should cite.
  //
  // `origin/main` is the walk's starting point, so the commit it names is
  // reachable from `origin/main` BY CONSTRUCTION and needs no
  // `merge-base --is-ancestor` after the fact. That check belongs to the other
  // shape — a sha quoted in a ticket, which can be a pre-rebase orphan that
  // `git show` resolves happily. Measured on #199: `git log -S 'decodeArgs'
  // origin/main -- workflows/review-pr.js` names `b243b4e`, and
  // `git merge-base --is-ancestor b243b4e origin/main` is true, as it is for
  // every commit this walk can reach.
  //
  // Newest-first with `-n 1`, never `--reverse`: the oldest count-changing
  // commit is the file's last rename whenever the string predates one, and a
  // refactor clears an ancestry gate exactly as well as the real fix.
  // (Measured on #206's old wording, `--reverse` names a move commit and
  // newest-first names the commit that actually did it.)
  let record;
  try {
    record = git(["log", "-S", needle, "-n", "1", "--format=%H%x00%s", "origin/main", "--", path]);
  } catch {
    return unknown("`git log -S` failed — the commit that changed this string could not be located, and a close needs it");
  }
  const [commit, subject] = record.trim().split("\0");
  if (!commit) {
    return unknown(
      mode === "gone"
        ? "the string is absent from the current file AND never changed count at this path on origin/main — the probe could not see anything, which is not the same as the defect being gone"
        : "the string is in the current file but no commit on origin/main accounts for it — this history cannot be cited",
      { found, bytes },
    );
  }
  return verdict("fixed", {
    found,
    bytes,
    commit,
    subject,
    why: "read the subject before citing it — `-S` names the commit that changed this string's count, which is the fix only if that commit's subject is about this",
  });
}

// The one code this file must never reach by accident is 1. Node exits 1 on an
// uncaught throw, and 1 here means "provably fixed" — so a bug in the probe
// would silently retire a live ticket, the exact harm #238's evidence
// criterion exists to prevent. `arg.mjs` records the same inversion from the
// other side (#299/#328). Nothing above is allowed to escape: every failure is
// an `unknown`, this one included.
try {
  probe();
} catch (e) {
  die(`probe failed: ${e.code ?? e.message} — could not check`);
}
