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
import { writeSync } from "node:fs";
import { relative, resolve } from "node:path";
import { makeDie, makeArg, makeSweep, makeStray } from "./arg.mjs";

const NAME = "staleness";

const die = makeDie(NAME);
const arg = makeArg(die);
const sweep = makeSweep(die);
const stray = makeStray(die);

// #818: a needle QUOTED OUT OF A TICKET can legitimately start with `--`
// (#240's is `--label ready-for-agent`), and arg()'s value guard refuses
// that spelling outright (#61/#169 — see arg.mjs's isFlagLike for why the
// refusal itself stays). An end-of-options separator opts `--gone`/
// `--present` into the literal reading: `--gone -- '--value'` is the POSIX
// convention, explicit at the call site, no second input channel.
//
// Given bare, with no `--` immediately after the flag, a flag defers to arg()
// unchanged — a `--`-prefixed value still dies "needs a value" exactly as
// before #818; that refusal is what keeps a flag from swallowing the next
// flag as its own value, and it is not weakened here. The three tokens
// (flag, separator, value) are spliced out of process.argv once read, so
// sweep()/stray() below never see the swallowed `--` or a needle shaped like
// a flag — either would otherwise die on it as unrecognized.
//
// ONE left-to-right pass over argv, both names in it together and every
// separator triple consumed before arg() reads anything. Position decides
// which flag owns a token, never the order the reads are written in —
// because the values #818 exists to carry are FLAG-SHAPED, so a
// separator-quoted needle can spell this script's own flag names, and a
// scan for one name over the whole argv matches the sibling's already-quoted
// data. Measured against a `needleArg("gone")`-then-`needleArg("present")`
// version, with `--path` read ahead of both: `--present -- --gone` died
// `--gone needs a value` and `--present -- --gone extra` died `--gone and
// --present are opposite questions`, each naming a flag the caller never
// typed; `--gone -- --path --path src.mjs` died `--path needs a value`.
// Every one of those is a needle that IS a flag spelling — the class this
// feature exists for — and all three answer now.
function separatedNeedles() {
  const found = {};
  for (let i = 2; i < process.argv.length; ) {
    const name = /^--(gone|present)$/.exec(process.argv[i])?.[1];
    // A repeated `--gone -- x` is left where it sits rather than silently
    // overwriting the first: its stranded `--` is then a token no name
    // owns, and sweep() below refuses it as `unknown flag --` (measured).
    if (!name || found[name] !== undefined || process.argv[i + 1] !== "--") {
      i++;
      continue;
    }
    const value = process.argv[i + 2];
    if (value === undefined || value.trim() === "") die(`--${name} needs a value`);
    found[name] = value;
    process.argv.splice(i, 3);
  }
  return found;
}

const separated = separatedNeedles();
const path = arg("path");
const gone = separated.gone ?? arg("gone");
const present = separated.present ?? arg("present");
// `--gone`/`--present` are the two shapes a ticket's asked-for change takes,
// and the caller has to say which — the direction is not inferable from the
// string. `--gone` is a defect the fix must REMOVE (the wording a ticket
// quotes as wrong); `--present` is something the fix must ADD (the assertion a
// pin ticket asks for). Refusing both-or-neither rather than defaulting: a
// default here would pick a direction on the caller's behalf and then report
// the opposite verdict with full confidence.
//
// Checked against the resolved values, not a raw `--gone`/`--present` token
// scan: separatedNeedles() above splices a separator-form flag's own token
// out of process.argv once consumed, so a presence scan would read it as
// absent — measured, with `--gone -- a --present -- b` answering under
// `--gone` alone at exit 0 while the caller asked two opposite questions.
if (gone && present) die("--gone and --present are opposite questions; give one");
if (!gone && !present) die("give --gone <string> (the fix removes it) or --present <string> (the fix adds it)");
if (!path) die("--path <path> is required");

// Below the value guards, the way candidates.mjs places its parseArgs: where
// both would refuse, the more specific wording wins, and nothing above here
// has run a git call.
//
// One consequence the caller has to be told about, so run-team/SKILL.md says
// it too: a needle that starts with `--`, given BARE, never reaches this
// script's question — `arg()` refuses it as a missing value, at exit 2, which
// is the verdict that keeps the ticket in the queue. `--gone -- '<value>'`
// (separatedNeedles() above) is the opt-in past that, one flag at a time.
sweep(["path", "gone", "present"]);

// #463: the sweep above only ever refuses a `--`-prefixed token, so a bare
// or single-dash stray rode through in silence here too — measured, `--path
// README.md --present needle JUNKTOKEN` returned a payload byte-identical to
// the same invocation without it. This script takes no positional of its
// own and all three of its flags take a value, so any leftover token is a
// stray.
//
// The shape that makes it worse here than elsewhere is an unquoted needle:
// `--present two words` takes `two` and discards `words` (measured), then
// answers with full confidence about a needle the caller never asked about.
// This verdict feeds ticket selection, where a wrong `fixed`/`live` retires
// live supply or claims dead work.
stray(["path", "gone", "present"]);

const mode = gone ? "gone" : "present";
const needle = gone ?? present;

// stdio: git's own stderr is forwarded (execFileSync does that precisely
// because `stdio` is absent here), so the diagnostics below name the cause and
// never re-print git's text — the duplication candidates.mjs measured at
// 7,700 B → 15,454 B applies identically.
//
// maxBuffer is set because the default is 1 MB and execFileSync THROWS
// (ENOBUFS) rather than truncating: a tracked file over that size would land
// in a catch below and be reported under whatever cause that catch names,
// with no errno anywhere, since the failure is Node's and git prints nothing.
// The largest tracked file here is under 200 KB today, so this is headroom
// rather than a fix for a live case — but the growing one is a metrics TSV
// that only ever gets appended to.
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function verdict(v, extra) {
  // writeSync, not console.log, for the reason arg.mjs gives for die(): a
  // failed write to stdout is invisible through console.log, so a reader that
  // dies mid-pipe leaves `fixed` still exiting 1 — "close citing the payload's
  // commit and subject" — with no payload anywhere and nothing on stderr.
  // Measured: piped into a process that exits immediately, this exits 2 and
  // says so, where console.log exited 1 silently. A verdict nobody received is
  // a verdict nobody can act on, so a failed write is a could-not-check.
  //
  // NOT PINNED, and deliberately so: the shape that reaches this catch is a
  // reader that closed the pipe before the write, and a test for it has to win
  // a race against the child's own exit — such a pin reports on timing rather
  // than on whether the downgrade works, and a flaky pin on a safety path is
  // worse than none. The measurement above is what stands behind it. Closing
  // it properly needs a seam that makes fd 1 fail on demand, which is the same
  // testability seam #822 turns on.
  try {
    writeSync(1, `${JSON.stringify({ verdict: v, path, mode, needle, ...extra })}\n`);
  } catch {
    die("the verdict could not be written to stdout — could not check");
  }
  process.exitCode = { live: 0, fixed: 1, unknown: 2 }[v];
}

// "Could not check" is a first-class ANSWER, not a failure: it carries the
// same four identifying fields as the other two verdicts, and a `why`, so a
// caller reading only stdout can say "offered, could not check" instead of
// dropping the row. What varies across all three is the EVIDENCE, and it
// varies with how far the probe got — measured over every branch below:
// `bytes` once the file was read, `found` once the search over it ran (an
// empty file is read and never searched), `commit`/`subject` only on `fixed`,
// and `error` only where the blob read is the call that failed.
const unknown = (why, extra = {}) => verdict("unknown", { why, ...extra });

function probe() {
  // `--path` is read against the REPO ROOT, never the caller's cwd. git
  // resolves a pathspec relative to wherever the process happens to be, so an
  // unanchored probe run from a subdirectory reports a tracked file as
  // UNTRACKED — a positive claim about the tree, made by the script whose
  // whole job is answering questions about the tree, and false. Same anchoring
  // ci-state.mjs does before it answers anything, and the reason ledger.mjs
  // and release-ticket.sh reach for `git -C`.
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"]).trim();
  } catch {
    return unknown("`git rev-parse --show-toplevel` failed — with no repository root to read this path against, nothing about it is settled");
  }
  // ls-tree prints root-relative paths, so the equality check below needs the
  // argument in that same spelling: an absolute path, a `./` prefix and a
  // trailing slash all name the same file and must not read as a different
  // one. Without this the probe refuses a single literal file path while
  // telling the caller to give a single literal file path. `|| "."` is the
  // path that names the root itself — an empty pathspec is fatal to git, while
  // "." reaches the one-answer guard below, which is the refusal that case has
  // earned.
  const target = relative(root, resolve(root, path)) || ".";

  // The tracked/untracked discriminator, and it is the first thing asked about
  // the path, because both failures it separates are silent in the other
  // direction. `git show
  // origin/main:<path>` is FATAL, not empty, on a path this repo does not
  // track — while the file may sit right there in the working checkout — so
  // reading that failure as "the file is gone, the fix landed" closes a live
  // ticket. And a GENERATED artifact is untracked by construction:
  // `.agent-test.sh` is claim-ticket.sh's heredoc output, materialized beside
  // the tracked `agent-test` bootstrap on every run of it, so what is on disk
  // is whatever the last run produced. Measured 2026-08-22 on `agent-test`
  // itself, which was the generated one before #55 tracked the bootstrap:
  // `git ls-tree origin/main -- <path>` prints nothing at exit 0 and `git show
  // origin/main:<path>` exits 128, while the file sits right there in the
  // checkout. A probe that resolved it by name would
  // measure an arbitrarily old build and report the answer with full
  // confidence, so this file NEVER reads the working tree and never executes
  // what it finds — `origin/main` or `unknown`, nothing else.
  let listing;
  try {
    listing = git(["-C", root, "ls-tree", "origin/main", "--", target]);
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
  const entry = lines.length === 1 && /^\d+ \w+ ([0-9a-f]+)\t(.*)$/.exec(lines[0]);
  if (!entry || entry[2] !== target) {
    return unknown("the pathspec did not resolve to exactly this one path in origin/main — give a single literal file path");
  }

  // The object ls-tree named, read as a file. A directory or a submodule at
  // this path lands here and refuses, which is the answer: a tree read as a
  // file would put a list of FILENAMES in front of the search, and a needle
  // absent from a list of filenames reads as clean. No separate type branch
  // above — it would refuse the same inputs with the same verdict, and a guard
  // whose removal no verdict can detect is a guard nothing pins.
  let content;
  try {
    content = git(["-C", root, "cat-file", "blob", entry[1]]);
  } catch (e) {
    // The cause is NOT asserted here, because this catch cannot tell the
    // causes apart: a directory and a submodule land here, and so does a read
    // this process could not complete — a missing or corrupt object in a
    // partial clone, or a blob past the buffer above. Naming one of them would
    // hand a reader who then checks and finds an ordinary file a dead end, so
    // the error itself is carried instead.
    return unknown("what origin/main holds at this path could not be read as a file — a directory, a submodule, and a read that failed all reach here", { error: e.code ?? e.message });
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
    record = git(["-C", root, "log", "-S", needle, "-n", "1", "--format=%H%x00%s", "origin/main", "--", target]);
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
