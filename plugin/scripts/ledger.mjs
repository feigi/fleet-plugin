#!/usr/bin/env node
// The run ledger. A controller's context is the least durable thing in a fleet
// run: it compacts, and a controller that has lost the pool or the dispatch map
// redoes finished work. Two duplicate tickets shipped in one run from exactly
// that.
//
// Rows are rewritten in place, one per ticket: `row` replaces a whole line
// and `token` appends tokens to one. `filed` and `ruled` are
// append-only, because their whole purpose is to outlive the reasoning that
// produced them; `filed` appends at most one row per issue.
//
// `dispatch`, `settle`, `review` and `drain` exist so a reader can derive
// every liveness count from this file alone, rather than from row text a
// controller typed by hand: `dispatch` writes a member's live token onto its
// row and appends it to `## Dispatched` with `brief=<hash>`, the brief it
// refuses to dispatch without, `settle` rewrites that token to
// `<member>=<outcome>` in both places (an implementer's settle to `PR#M` also
// folds the PR's own `#M` row into its ticket's) — with `--from-report`, the
// outcome derived from the member's report file and checked against git and
// GitHub first, see runSettleFromReport() — `review` appends a PR's
// `review=`/`reviewed=` tokens to the PR's row, and `drain` writes the
// one marker that stops supply. The token grammar is
// ledger-grammar.mjs's. Within a run `## Dispatched` gains an entry per
// dispatch and never loses or reorders one — settling annotates an entry in
// place — which is what lets `merge-bot-<n>` be numbered from it; a rotate
// that carries a run's live entries forward carries a settled one only for a
// member a carried row names, and retires every other settled name — and a
// name whose outcome is outside its family's vocabulary — into
// `## Retired`, where `dispatch` and that numbering still read it.
//
// Writer policy: the controller owns run state
// (`row`/`token`/`settle`/`dispatch`/`review`/`drain`/`ruled`/`rotate`); filers append
// filings with `filed`; all writes are serialized by `<file>.lock`. Every
// write subcommand except `rotate` — which moves the file whole and never
// loads it, see runRotate() — rewrites the WHOLE file from what it loaded,
// so two unlocked writers are last-writer-wins — measured, 8 concurrent
// `filed` kept 2-5 of 8 rows — and the lock is what lets a second kind of
// writer exist at all. The reasoning for each part of the lock lives at
// acquireLock() below.
//
// Every write subcommand also stamps `acted` in the heartbeat file beside the
// ledger whenever its call ends without a refusal — rotate in the same write
// as its controller record. A run's ledger writes are its densest sign of
// life, so the stall readers judge a busy run by them (fleet-state.mjs has
// the rule).

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync, linkSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, execFileSync } from "node:child_process";
import { makeDie, isFlagLike, hasEqualsForm, isDigits, writeAll } from "./arg.mjs";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";
import { parseMember, parseToken, memberTokens, nextMergeBot, nextRetry, liveOnLedger, retiredOnLedger, retiredName, readRetired, agentDefinition, CELL, tierValues, rowPr, rowWriteRefusal, isReviewToken, addedReviewToken, newSplitRow, splitRowClause, added, premisesOf, MEMBER_FAMILIES, HALT_CAUSES, ROWS, DISPATCHED, FILED, RULED, DRAIN, RETIRED, RECEIPT, archiveStamp, receiptArchiveName, CLOSEOUT_RECEIPT, closeoutArchiveName, BRIEFS, briefsArchiveName, memberRole, parseDispatchedEntry, dispatchedEntry, headerRe, escapeText, unescapeText, nextReviewerName } from "./ledger-grammar.mjs";
import { deriveRun, LedgerError, labelOffMember, HELD, CONFLICT_HOLD } from "./fleet-tick.mjs";
import { stateFileIn, readState, writeState, assessBeat, stallsAt } from "./fleet-state.mjs";
import { processSource, ancestry, controllerOf, judgeController, ProcUnreadable } from "./proc.mjs";
import { attemptLock, releaseLockFile, reapPathOf } from "./pid-lock.mjs";
import { readReportIn, reportsDir, reportFamily, defaultScratch } from "./report-files.mjs";

const NAME = "ledger";
// The plugin's own agent definitions — the directory tier-check.mjs reads
// with its default `--repo`, so the two agree on which definitions exist.
const AGENTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");

// die() shared with the other fleet scripts (writeSync-based, pipe-safe —
// see arg.mjs for the rationale). arg()/has() themselves are
// NOT shared here: this file splices its flags out of argv and refuses in its
// own wording, where arg() refuses under a message generated from the
// flag name.
//
// Their RULES are shared, which is a different thing. isFlagLike() and
// hasEqualsForm() are arg.mjs's refusal rules as exported predicates; the
// three guards below call them and supply their own die() text. This file
// used to restate the expressions instead, and nothing failed when a
// restatement drifted from the original — a test over the shared source is
// what fails now, and it reds even on a re-inlined copy that changes no behaviour
// at all, which is the only kind a behavioural test cannot see.
const die = makeDie(NAME);

// The cause of a failed child process, for `check`'s repository probe and its
// tracker query — each captures the child's stderr instead of forwarding it, so
// what the child printed reaches no terminal and this string is the only copy
// of it.
//
// Trim BEFORE choosing, not after. A whitespace-only stderr is truthy, so it
// wins a choice made on the raw values and then trims away to nothing, leaving
// the reader an empty parenthesis where the reason belongs; choosing on the
// trimmed text falls through to the next candidate instead. `?? ""` per
// candidate, so a field that is absent contributes nothing — where the same
// choice made with `||` around a `String()` hands back the text `undefined` as
// the cause when no candidate is set at all (measured).
//
// Keep the END when it overruns, and say so. A CLI prints its warnings ahead of
// the error that killed it, so keeping the first bytes discards the cause and
// hands back a string cut mid-word that reads as the whole of what was printed
// — the marker is what stops it reading that way. Capped either way, marker
// included: every caller ships this inside a machine-parsed payload on stdout,
// where a megabyte of child stderr is a problem however the cause was chosen.
const CAUSE_MAX = 500;
function cause(...candidates) {
  const raw = candidates.map((c) => String(c ?? "").trim()).find(Boolean);
  if (!raw) return "";
  return raw.length > CAUSE_MAX ? `…${raw.slice(-(CAUSE_MAX - 1))}` : raw;
}

// The budget every `git` child in this file gets, in milliseconds.
//
// Both git probes ran UNBOUNDED before they were bounded, while the `gh` query between
// them carried 20 s. That asymmetry was the defect: measured with a `git` that
// answers and then never returns, `check` — the fleet's pre-filing duplicate
// guard — was still running at 60 s having written nothing at all to stdout,
// where the same shape on the `gh` side degrades at its own bound and still
// prints a payload. The author bounded `gh` precisely because a child can
// stall; the two `git` children were left with no bound to reach.
//
// 10 s, and the number is chosen against the FALSE FAILURE rather than against
// the stall — net_fetch_budget's rule in net.sh, applied to a local call.
// These are `rev-parse` probes, not fetches: measured across five concurrent
// copies of the whole suite (the fleet's own normal condition), both stayed at
// p50 11-15 ms and max 24.7 ms, so this is ~400x the worst latency observed
// under load. Generous on purpose, because a probe killed while HEALTHY does
// not fail loudly here — defaultLedgerPath() degrades to a cwd-relative
// ledger and only warns (a fallback that predates this budget, not
// something the budget introduces). It also stays under the `gh` bound beside it —
// though "dominant" overstates that relationship: a normal invocation
// without `--file` can pay this same budget TWICE in sequence, once here and
// once more in repoCheck() below, before ever reaching `gh` at all — and
// THREE times in layouts whose common git dir is not named `.git` (the
// `.bare` layout, a bare repository, a submodule, a `--separate-git-dir`
// clone), where fleetFile() runs a second probe with its own full budget:
// fleetFile()'s bound is per git child, not per call. At default settings
// two stalled probes TIE `gh`'s own 20 s bound and three exceed it, and even
// one stall can EXCEED it — up to GIT_TIMEOUT_MS + 20 s — when `gh` still
// runs (measured). `check`'s worst case is the sum of whichever of its
// children actually stall, not a single fixed term. That is three children
// normally; in those layouts it is three git children and `gh` is a fourth.
// Where the ledger's repository has no work tree (the `.bare` layout, a bare
// repository, a `--separate-git-dir` clone; not a submodule) repoCheck()'s
// `--show-toplevel` is refused and it asks the same directory for
// `--git-common-dir` to bind `gh` to, so there it is four git children and
// `gh` a fifth. `gh` runs in every one of those layouts. With `--file` the
// fleetFile() children drop out: two children normally, three where the
// repository has no work tree.
//
// `LEDGER_GIT_TIMEOUT` is this script's OWN override, in seconds, and it can
// only ever SHORTEN. The rule and the reasons for it are net_budget's, in
// net.sh: a knob that could lengthen the bound is one more way for
// configuration to remove it, and each script keeping its own variable is why
// that helper takes the override's value rather than its name. A value that is
// not a positive whole number below the default is not an error and not a
// bound either — the default stands, in silence. isDigits() is arg.mjs's own
// predicate, so the accepted spelling is the shell rule's `*[!0-9]*` and not a
// second reading of it; net_budget's extra six-digit clause guards a shell
// integer overflow that has no counterpart here, and the `<` below already
// rejects every value that clause would have.
function gitBudget(defaultSeconds, override) {
  const seconds = isDigits(String(override)) ? Number(override) : 0;
  return (seconds > 0 && seconds < defaultSeconds ? seconds : defaultSeconds) * 1000;
}
const GIT_TIMEOUT_MS = gitBudget(10, process.env.LEDGER_GIT_TIMEOUT);

// What `git rev-parse --show-toplevel` says (exit 128, under LC_ALL=C) in a
// repository that has no work tree to name. NOT fleet-dir.mjs's
// NOT_A_WORK_TREE, which also matches "not a git repository": that one is
// "there is nothing here", this one is "there is a repository, and it has no
// work tree", and only the second leaves a repository for `gh` to bind to.
const NO_WORK_TREE = /must be run in a work tree/;

// There is ONE ledger per run, and it lives in the main checkout. Members run
// from their own worktrees, where a cwd-relative `.fleet/ledger.md` does not
// exist — `check` then warns and reports every subject as safe to file, which
// is precisely the duplicate-filing guard failing open. fleet-dir.mjs's
// fleetFile() resolves it against the git COMMON dir (shared by every
// worktree) instead, with GIT_DIR/GIT_WORK_TREE scrubbed so an ambient one
// cannot put the run's ledger under another repository; only the bound, the
// warning and the fallback below are this caller's own. No canonicalisation
// is asked for: that is board-server.mjs's opt-in, and taking it here would change
// the path `check` prints without changing which file it names.
function defaultLedgerPath() {
  try {
    return fleetFile("ledger.md", { timeoutMs: GIT_TIMEOUT_MS });
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    // Could not resolve the shared git dir → fall back to a cwd-relative path.
    // That re-opens the worktree fail-open this resolution exists to close (a
    // member reads a cwd-local ledger, not the run's), so say so rather than
    // degrading the duplicate-filing guard in silence. The message names the
    // cause, so an ETIMEDOUT stall does not read like an instant "not a
    // repository" failure.
    console.error(`${NAME}: WARNING ${e.message}; using cwd-relative .fleet/ledger.md (duplicate-filing guard may be degraded)`);
    return ".fleet/ledger.md";
  }
}

// What `row` and `token` say of a `label-off=` naming no finisher this run has.
const LABEL_OFF_UNKNOWN = "names no finisher-pr member this run has dispatched or recorded — label-off=<finisher-pr-M[-x]>, the latest finisher attempt, before taking ready-to-merge off PR M";

const argv = process.argv.slice(2);
// Both flags are read by EXACT token below (`indexOf`), so the `--flag=value`
// spelling matches neither — and an unmatched token is not refused, it lands
// in `rest`, where `check`'s `rest.join(" ")` folds it into the SUBJECT. That
// loses the path AND corrupts the text being checked: measured, `check
// --file=<other-ledger> "<subject that ledger has already filed>"` exits 0
// "safe to file" where the space-separated form exits 1 ALREADY FILED, and
// `--file <missing> check --require-file=true dup` exits 0 where the bare flag
// exits 2. It failed loudly only where the token happened to land in the
// SUBCOMMAND slot — argv[0] once the splices below have run, which a leading
// `--file=x` does — and `unknown subcommand` is not the same refusal. That one
// sample is why the `=` form read as already covered. So scan the whole argv
// — which is why the sliced `argv` is passed rather than left to default to
// process.argv, and why the scan is not anchored to a position.
//
// The same refusals arg.mjs gives the scripts that route through its arg() and
// has(), in this reader's own wording — and that parity is
// the shared hasEqualsForm() predicate itself rather than a claim about two
// expressions that were free to drift apart.
// Flag names lived here AND in OWN_FLAGS below with no shared source — a
// future flag added to the indexOf() calls without a matching OWN_FLAGS
// entry would parse normally but never be refused in a `check` subject
// (measured: added `--another-file` the same way, `check -another-file …`
// silently accepted at exit 0). One name each, declared once, reused by
// the indexOf() calls and OWN_FLAGS below. Not by the hasEqualsForm() calls
// right below, which keep their own literal text on purpose —
// a test pins that pair's source verbatim against arg.mjs's
// rule, so interpolating them here would fail that pin without
// fixing anything it exists to catch.
const FILE_FLAG_NAME = "file";
const REQUIRE_FILE_FLAG_NAME = "require-file";
if (hasEqualsForm("file", argv)) die("--file needs a space-separated value, not --file=");
if (hasEqualsForm("require-file", argv)) die("--require-file is a boolean flag, not --require-file=");
const fileIdx = argv.indexOf(`--${FILE_FLAG_NAME}`);
const file = fileIdx === -1 ? defaultLedgerPath() : argv[fileIdx + 1];
// `--file` took whatever token followed it, so `--file --require-file`
// made the FLAG the path and the splice below then ate it — `--require-file`,
// the flag whose entire job is to turn a missing ledger into a hard failure,
// silently absent, and the duplicate-filing check answering "safe to file" at
// exit 0 where the correct invocation exits 2 (measured). A caller gating on
// that exit code files the duplicate. `if (!file)` below only ever caught a
// truly trailing `--file` — it still does, in its own wording; this guard is
// additive.
//
// Refusing a `--`-prefixed value forfeits a path that legitimately begins
// with `--`. That is not a local choice: isFlagLike() below IS arg.mjs's rule,
// so this reader forfeits exactly what every script routing through arg()
// forfeits, no more and no less — the set of them being whatever `grep -lE
// '^const arg = makeArg|^import .*defineFlags' scripts/*.mjs | grep -v test`
// reports: a makeArg binding, or a defineFlags() table whose arg()/numArg()
// are built on it. Anchored on the binding and the import, because the
// unanchored `grep -l makeArg` matched this comment and so listed ledger.mjs,
// the one script this paragraph says does NOT route through arg(). A single
// leading `-`, or a `--` anywhere but the front, is still a path.
//
// The `file &&` term is load-bearing and must not fold into isFlagLike(),
// which answers TRUE for an absent value: without it a truly trailing `--file`
// would land on this clause's wording instead of the pre-existing "given with
// no path" one below, which is the existing behaviour for a truly trailing
// `--file` and which the ledger test pins.
if (fileIdx !== -1 && file && isFlagLike(file)) die("--file needs a path");
if (fileIdx !== -1) argv.splice(fileIdx, 2);
if (!file) die("--file given with no path");
const requireFileIdx = argv.indexOf(`--${REQUIRE_FILE_FLAG_NAME}`);
const requireFile = requireFileIdx !== -1;
if (requireFileIdx !== -1) argv.splice(requireFileIdx, 1);

const [cmd, ...rest] = argv;
if (!cmd) die("usage: ledger.mjs [--file <path>] [--require-file] row|token|filed|ruled|check|read|dispatch|settle|review|drain|undrain|rotate [args]");

// A `--`-prefixed token in `check`'s free-text tail used to fold
// straight into the duplicate-filing subject, so a misspelled flag searched
// for a DIFFERENT subject and read "safe to file" where the correct spelling
// answers ALREADY FILED at exit 1. A `--` token can legitimately BE that data
// (arg.mjs's refuseUnknown() comment names why sweep() stays out of this file),
// so what separates a stray flag from data is length: `check`'s documented
// calling convention hands the subject as ONE argument, so an unquoted stray
// reveals itself by making the tail longer than that one argument allows.
// `check --requre-file "widget guard missing"` is a two-element tail; `check
// "--require-file silently absent when value missing"` is one. A one-element
// tail is accepted unchanged, whatever it starts with; a multi-element tail
// carrying a `--`-prefixed element is refused by name. Structural, not a
// distance threshold.
//
// `check`'s tail ALONE — narrower than the first pass, which called this
// from `filed`, `row` and `ruled` too. The length rule is only sound where
// the documented convention IS one quoted argument, and `check` is the only
// subcommand where it is: every caller that instructs running it spells it
// `ledger.mjs check "<subject>"` (the finisher's deferred-finding filing duty,
// review-and-fix's filing step), while run-team/SKILL.md's ledger section
// spells the other three `filed <issue> <subject>`, `row <ticket> <text>` and
// `ruled <pr> <decision>` — a bare multi-word tail, as did this file's own
// usage strings for them. Applied there, the rule refused what the docs
// prescribe: measured on the tree ahead of this narrowing, `filed 999 the
// --basee flag is unread`, `row 42 the --basee flag is unread` and `ruled 77
// the --basee flag is unread` each exited 2, where the tree before this guard
// existed answered all three at exit 0. The guard was ruled back to
// `check` rather than respelling three conventions SKILL.md carries, two
// other tickets holding that file open.
//
// Stated here and nowhere else. This paragraph is the one copy of why
// the rule is `check`'s alone; arg.mjs's refuseUnknown() comment and
// the ledger test's two stray-tail blocks each used to carry their own, and
// now point here instead. Anything that reads on the docs or the
// measurement belongs in this paragraph, not beside a caller.
//
// Narrowing it does not keep the original guard's signature whole on those three: only the
// ID-slot vector survives — a stray flag one token to the LEFT is still
// refused by refuseStrayInId() below. The tail-slot vector does not: a
// stray `--` word inside filed/row/ruled's tail is now accepted as data (no
// rule can tell it apart from the subject a caller typed), so `filed 999
// --typo-flag some new subject` exits 0 and writes a row a later `check
// "some new subject"` cannot exact-match — a near-miss at best, the same
// wrong-subject shape the guard closed, reopened here on the tail. That is the
// cost of narrowing the guard rather than requoting the docs; it is why it is the
// DOCUMENTED convention, not the hazard, that decides where the length rule
// may be read at all.
//
// The cost `check` keeps is real, so it is
// stated rather than denied: a legitimate subject carrying a `--` word
// anywhere, given unquoted, was accepted before this guard and is refused by
// it — `check the --basee flag is unread` answered at exit 0 before and exits
// 2 now. Quoting the subject accepts it unchanged. The trade taken
// is that this refusal is loud and recoverable where the wrong-subject
// answer it replaces was silent. One residual of that trade is not this
// file's to close: SKILL.md's ledger section spells `check <subject>`
// unquoted inside the same entry that spells `filed <issue> <subject>`, where
// the instructions that tell a caller to RUN it quote the subject.
//
// Narrowed on `check` too, not closed: a lone stray with no subject beside it
// is a one-element tail, so it is still taken as the subject and answered at
// exit 0. Harmless because it then searches for a string nothing matches, and
// the ledger test's degenerate-subject case pins it so it stays deliberate.
//
// One dash short is the same slip, and the `--` test let it through —
// `check -require-file widget guard missing` scored "-require-file widget
// guard missing" and answered exit 0 where the correctly-spelled call answers
// ALREADY FILED at exit 1. That test cannot simply lose a dash: single-dash
// words are ordinary free text in this repo's subjects — another tool's short
// flag (`grep -q`, `git branch -D`), a lone `-` standing in for a dash, a
// negative number. Measured when this was written, 23 of the repo's 1068
// issue titles carry one as a whitespace-split word, 20 of them letter-led,
// so neither the prefix nor a `-<letter>` shape tells the slip apart. A NAME
// does, the way arg.mjs's stray() tells a stray from a value: a
// single-dash word is refused only when one more dash, ahead of any `=value`,
// makes it a flag this script reads — OWN_FLAGS, the two spliced out of argv
// above. None of those titles carries one. It sits behind the same length
// gate, so a one-argument subject is still accepted whatever it opens with.
//
// Left open, deliberately: a second slip on top of the missing dash
// (`-requre-file`), and a short form this script never defined (`-f`).
// Reaching either takes a shape or distance rule rather than a name, and
// `-f` is exactly the other-tool short flag above; both still fold into the
// subject.
const OWN_FLAGS = [`--${FILE_FLAG_NAME}`, `--${REQUIRE_FILE_FLAG_NAME}`].map((f) => f.toLowerCase());
// The one-dash name clause below once matched only a's FIRST
// whitespace-split word (ahead of any `=value`), not the whole element: a
// quoted multi-word tail element (`check "-require-file widget" guard
// missing`, one argv element) reconstructed to "--require-file widget"
// under a whole-token match, which is not in OWN_FLAGS, so it fell through
// to exit 0 — the same verdict flip the one-dash clause exists to refuse, just via a
// quoted shape rather than a bare token. Splitting first mirrored the `--`
// clause above it, which already matches on startsWith rather than
// requiring the whole element. The split now checks EVERY word of the
// element, not only the first — see the paragraph on the four missed shapes
// for why the first-word version stopped being enough.
//
// That first-word, exact-case split still missed four shapes of the
// same name, each confirmed by direct probe against the shipped script: a
// case-variant spelling (`-REQUIRE-FILE`), whitespace ahead of the dash —
// including U+00A0, which `\s` already matches, but the FIRST-word split
// still lost the real word to the empty token that whitespace leaves at
// index 0 — and the flag name landing anywhere but first in a quoted
// multi-word element (`"widget -require-file"`, the mirror of the shape
// just above, where the one-dash fix only checked the front). None of the four
// changes the rule itself — still a NAME match against OWN_FLAGS, never a
// prefix or shape test — only how a word is pulled out of the element:
// every whitespace-split word, lower-cased, before the OWN_FLAGS lookup —
// OWN_FLAGS itself is lower-cased once at declaration above, so this clause
// stays correct even if FILE_FLAG_NAME/REQUIRE_FILE_FLAG_NAME ever gain a
// capital letter.
//
// The per-word test above only ever builds the ONE-dash-PREPENDED
// form of a word (`-${word...}`), so it matches a word already spelled with
// one dash but never a word already spelled with this script's own TWO-dash
// flag name — that spelling comes out of the split as `--require-file`,
// prepending one more dash makes `---require-file`, and OWN_FLAGS only holds
// `--require-file`. The outer `startsWith("--")` clause above only reaches a
// two-dash name when it leads the WHOLE tail element; the same name landing
// anywhere else in a quoted multi-word element — trailing, in the middle, or
// alone behind leading whitespace — was invisible to both clauses and folded
// back into the subject: the identical verdict flip the one-dash clauses exist to
// refuse, one dash count over. Reproducible before the widened split too;
// the split only made it visible by contrast, once the one-dash mirror shape
// started being refused. Fixed the same way the one-dash case is
// — a NAME match, never a prefix or shape test — by also checking a
// word's own AS-SPELLED form against OWN_FLAGS, alongside the
// one-dash-prepended form already there.
//
// A Unicode format character (general category Cf — U+200B zero-width
// space, U+2060 word joiner, U+00AD soft hyphen, the bidi controls, …) is
// invisible and sits outside `\s`, so the split above never cut on it and it
// rode along inside the word: `\u200B-require-file` reads as `-require-file`
// yet never equalled an own-flag spelling, and scored as subject text. Each
// word now has every Cf code point stripped before either lookup, so it is
// looked up as the word a reader sees — wherever the character sits, ahead of
// the dash, inside the name, or behind it. Stripped, not split on: a word
// any OTHER Cf character sits inside of stays one word (`pre\u200B-file` is
// `pre-file`, not a `-file`). And stripped AFTER the `\s` split, not before:
// U+FEFF is the one code point in both Cf and `\s` — the one exception to
// the sentence just above, since it keeps splitting a word in two there the
// way it always did — and a strip ahead of the split would join
// `widget\uFEFF-require-file` into one word and stop refusing it. Own names
// are ASCII, so only a word that is an own-flag spelling plus Cf characters
// is newly refused.
// Cf also holds a few VISIBLE marks (the Arabic number signs U+0600–0605,
// among others); stripping them costs a refusal only of such a mark glued to
// an own-flag name, which no subject carries.
//
// Invisible characters OUTSIDE Cf — U+3164 and the other Hangul
// fillers (letters), U+034F and the variation selectors (combining marks) —
// are text rather than format controls, so the Cf strip above let them ride
// inside the word exactly as a zero-width space rode before it. The strip is
// now the union of Cf and Default_Ignorable_Code_Point, the property Unicode
// itself keeps for code points a renderer shows nothing for: one property
// rather than a hand-curated block list, which would miss the members no
// ticket named (U+17B4, the Mongolian selectors U+180B–180F, …). A union,
// not DICP alone: DICP leaves out the visible Cf marks just above, so
// swapping it in would drop cases the Cf strip already refuses. Same site and the
// same after-the-split order as the Cf strip; U+FEFF stays the one code point in
// both the strip and `\s`, no DICP member adding another. An emoji's own
// presentation selector (U+FE0F) is stripped too, which costs nothing: only
// a word that is an own-flag spelling once stripped is refused.
//
// Left open, deliberately: blank-rendering code points outside both
// properties (U+2800 braille blank, among others), which Unicode classes as
// ordinary visible symbols; and a Cf character ahead of a NON-own `--word`
// leading a tail element, which the outer `startsWith("--")` clause misses
// exactly as it misses ordinary whitespace there.
function refuseStrayInCheckTail(tail) {
  if (tail.length <= 1) return;
  const stray = tail.find(
    (a) =>
      a.startsWith("--") ||
      a.split(/\s+/).some((word) => {
        const name = word.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "").split("=")[0].toLowerCase();
        return OWN_FLAGS.includes(name) || OWN_FLAGS.includes(`-${name}`);
      }),
  );
  if (stray) die(`unknown flag ${stray} in subject — quote the subject as one argument`);
}

// The id slot ahead of `filed`/`row`/`ruled`'s tail is a hazard of its own,
// and the only one of the three a rule can act on. refuseStrayInCheckTail()
// above is not read on those subcommands at all, and would not
// catch this shape if it were: a stray flag one token earlier lands in
// `issue`/`ticket`/`pr`, and the tail left behind carries no `--` element to
// find. Nor could that helper be read over the whole of `rest` instead —
// that refuses `filed <issue> "--flag-like subject"` too, a two-element
// tail with a `--` element, pinned here as must-keep-working. A legitimate
// id is bare digits, optionally `#`-prefixed, and never carries a leading
// dash at all — single or double — so this slot refuses ANY leading dash,
// not only a double one. The free-text tail cannot take that same
// test: a subject can legitimately open with a double-dash-leading word —
// exactly what `--flag-like subject text` above and check's own
// dash-leading-subject pin exist to keep working. A single-dash-leading word
// is ordinary subject text too, which is why check's tail refuses one only
// by name (see refuseStrayInCheckTail() above). So only the id slot
// can take the bare prefix test at all, for the same no-free-text reason
// given above.
function refuseStrayInId(value, what) {
  if (value.startsWith("-")) die(`unknown flag ${value} — expected ${what}`);
}

// Set by load(), the only function that reads the file, so `ledger.ok` can
// report what the parse saw rather than what a later stat() guesses.
let ledgerParsed = false;

// A section's entries, unescaped, in file order — none when the header is
// absent. Lenient by design: it refuses nothing, so rotate reads a ledger
// load() refuses through the same slicing.
function sectionOf(text, name) {
  const m = headerRe(name).exec(text);
  if (!m) return [];
  const start = m.index + m[1].length + name.length;
  const after = text.slice(start);
  const end = after.search(/\n## /);
  return (end === -1 ? after : after.slice(0, end))
    .split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "))
    .map((l) => unescapeText(l.slice(2)));
}

function load() {
  if (!existsSync(file)) return { rows: [], filed: [], ruled: [], dispatched: [], briefs: {}, drain: null, retired: [] };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    die(`cannot read ${file}: ${e.message}`);
  }
  const section = (name) => sectionOf(text, name);
  // Set here, past the read and the early return, so it can only be true of a
  // file this function actually opened and recognised as a ledger.
  ledgerParsed = headerRe(FILED).test(text);
  // A ledger written before `dispatch` and `drain` existed has neither
  // `## Dispatched` nor `## Drain`,
  // which reads as nothing dispatched through `dispatch` and no drain — the
  // truth about that file, not a default standing in for it.
  const drainEntries = section(DRAIN);
  // One marker per run: the `drain` command's own `created` guard refuses a
  // second call rather than overwrite the standing reason. A second entry
  // reaching this file some other way (hand edit, merge, an older writer) is
  // the same invariant broken on disk, and narrowing to `[0]` here would
  // drop it with no warning at all — the read-side half of that guard.
  if (drainEntries.length > 1) {
    die(`${file} has ${drainEntries.length} \`## Drain\` entries — one marker per run`);
  }
  return {
    rows: section(ROWS), filed: section(FILED), ruled: section(RULED),
    ...dispatchedOf(section(DISPATCHED)), drain: drainEntries[0] ?? null,
    retired: section(RETIRED),
  };
}

// `## Dispatched` held as its tokens, which is what every reader of `read`
// parses, and `briefs`, each member's `brief=` hash by name: one token per
// member name for the session, so a settle that rewrites the token keeps the
// name its brief is filed under. save() joins them back.
function dispatchedOf(entries) {
  const parsed = entries.map(parseDispatchedEntry);
  return {
    dispatched: parsed.map((p) => p.token),
    briefs: Object.fromEntries(parsed.filter((p) => p.brief !== null).map((p) => [parseToken(p.token).name, p.brief])),
  };
}

// `## Drain` is written only once there is a marker to hold: an empty section
// under that name would read, to anyone scanning the file by eye, as a run
// that is draining. `## Retired` likewise: only an `ancestor` rotate writes
// it (runRotate()), as the bare names of the members this omp session has
// already run and the new ledger does not carry, so a ledger without it is
// a session's first run.
function save(d) {
  const list = (entries) => entries.map((r) => `- ${escapeText(r)}`).join("\n");
  const out =
    `# Fleet run ledger\n\n${ROWS}\n\n` + list(d.rows) +
    `\n\n${DISPATCHED}\n\n` + list(d.dispatched.map((t) => dispatchedEntry(t, d.briefs[parseToken(t)?.name] ?? null))) +
    `\n\n${FILED}\n\n` + list(d.filed) +
    `\n\n${RULED}\n\n` + list(d.ruled) +
    (d.drain === null ? "" : `\n\n${DRAIN}\n\n` + list([d.drain])) +
    (d.retired.length === 0 ? "" : `\n\n${RETIRED}\n\n` + list(d.retired)) + "\n";
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Write to a sibling temp file and rename over the target. rename is
    // atomic on a POSIX filesystem — a crash mid-write leaves the temp file
    // corrupt but never truncates the durability file itself. The temp name
    // carries the pid: a shared `${file}.tmp` let one writer rename another's
    // temp file out from under it, and the loser died on ENOENT.
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, out);
    renameSync(tmp, file);
  } catch (e) {
    die(`cannot write ${file}: ${e.message}`);
  }
  console.error(`    wrote ${file}`);
}

// ── The write lock ───────────────────────────────────────────────────────────
//
// Held from before load() through save() on every write subcommand, because
// save() rewrites the whole document from what load() read: without it two
// writers each load, append and save, and whichever renames last silently
// discards the other's row. Reads (`check`, `read`) take no lock — the rename
// already hands them either the old file or the new one, never a torn one.
//
// `<file>.lock` is a pid-stamped lock and `<file>.lock.reap` its takeover
// lock; pid-lock.mjs owns the protocol — the O_EXCL create, what an empty or
// partial lock and a leftover reap lock mean, the dead-holder takeover and
// why it is ordered the way it is, the zombie case. What stays here is the
// ledger's own policy: how long to wait, and what to say on expiry. A holder
// that died without releasing is taken over, and only a normal exit and the
// three catchable signals below run the `exit` event that releases the lock —
// SIGKILL always, and any signal this file leaves unhandled (SIGQUIT,
// SIGABRT, a segfault), leave it for the takeover.
//
// The wait is bounded — 10 s by default — and the timeout is die(), exit 2,
// having written nothing. `LEDGER_LOCK_TIMEOUT_MS` overrides it and, like
// `LEDGER_GIT_TIMEOUT` above, can only ever SHORTEN it.
//
// What the lock does NOT cover: `check` -> `gh issue create` -> `filed` is
// three commands, and each takes the lock (or not) alone, so two filers can
// both read `clean` before either records. Accepted: the measured
// same-run accidental duplicate was filed minutes apart, and a
// claim/reserve subcommand closing that window was ruled out.
const LOCK = `${file}.lock`;
const REAP = reapPathOf(LOCK);
const LOCK_WAIT_MS = (() => {
  const v = process.env.LEDGER_LOCK_TIMEOUT_MS;
  const ms = isDigits(String(v)) ? Number(v) : 0;
  return ms > 0 && ms < 10_000 ? ms : 10_000;
})();
let lockHeld = false;

function releaseLock() {
  if (!lockHeld) return;
  lockHeld = false;
  releaseLockFile(LOCK);
}

async function acquireLock() {
  try {
    mkdirSync(dirname(file), { recursive: true });
  } catch (e) {
    die(`cannot write ${file}: ${e.message}`);
  }
  process.on("exit", releaseLock);
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(sig, () => process.exit(2));
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const attempt = attemptLock(LOCK, die);
    if (attempt.state === "taken") {
      lockHeld = true;
      return;
    }
    if (attempt.state === "vanished") {
      // Ordinarily transient — released between our failed create above and
      // this read — so retrying the create at once beats sleeping first.
      // But that same shape recurs FOREVER if reading it fails for a reason
      // this read can never clear: a `.lock` path that is a dangling
      // symlink reports EEXIST to the create (the dirent exists) and ENOENT
      // to every read (its target does not). Bounding it here is what keeps
      // that case inside the 10 s wait this lock promises rather than
      // spinning past it at 100% CPU.
      if (Date.now() >= deadline) die(`cannot lock ${file} — ${LOCK} exists but cannot be read`);
      continue;
    }
    if (attempt.state === "reaped") continue;
    const { holder, pid, dead } = attempt;
    if (Date.now() >= deadline) {
      // `dead` here but still not taken over means this call's own reap
      // attempt found `${REAP}` already there right now — the same instant a
      // reaper SIGKILLed between its own create and unlink leaves behind
      // forever (see pid-lock.mjs's header comment), and
      // indistinguishable at this instant from a live reaper mid-takeover.
      // Naming the pid alone points an operator at a process that no longer
      // exists; naming `${REAP}` is what lets them find the file
      // `run-team/SKILL.md`'s runbook tells them to remove by hand, once
      // nothing is writing.
      if (dead) {
        die(`cannot lock ${file} — held by pid ${pid}, which is dead; ${REAP} is blocking its takeover — if nothing is currently writing, remove it by hand`);
      }
      // No pid at all is the other permanent wedge pid-lock.mjs's header describes: an
      // empty or partial `${LOCK}` whose writer died before writing its pid,
      // read as live forever by design. There is no process to point at, so
      // name `${LOCK}` itself — the file the same runbook says to remove.
      if (pid === null) {
        die(`cannot lock ${file} — ${LOCK} holds ${JSON.stringify(holder)}, not a pid, so it is never taken over — if nothing is currently writing, remove it by hand`);
      }
      die(`cannot lock ${file} — held by pid ${pid}`);
    }
    // A timer, not a blocking sleep: a waiter holds no lock, so a SIGTERM
    // that arrives while it waits should end it now, and the handlers above
    // only run when the event loop is free to run them.
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 15));
  }
}

// Read ahead of the dispatch, not inside one branch of it. This guard used to
// live in runCheck(), so `check` refused a missing ledger under the flag and
// the other four subcommands ignored it entirely: `read --require-file` on an
// absent file printed the empty payload at exit 0, byte-identical to a real
// empty ledger on both streams, and `row --require-file` CREATED the very file
// whose absence the flag exists to refuse. One flag read in one place is
// what makes it hold on every subcommand, not only `check`.
//
// Ahead of load() rather than after it: load() answers "absent" and "present
// but unparseable" with the same empty lists, which is the ambiguity this flag
// exists to break, so the answer must not be taken from it. `check`'s own
// wording and exit code are unchanged — it reached this same die() first
// either way, before its stray-tail and usage guards — and the WARNING left
// behind in runCheck() is now unreachable under the flag by construction
// rather than by an `if` that repeats the condition.
//
// Also ahead of "unknown subcommand" validation: `--require-file` against a
// missing file with a bogus subcommand reports the require-file refusal, not
// a usage error. Deliberate/accepted, not reordered — both refusals exit 2,
// so a caller gating on the exit code reads the same failure either way.
if (requireFile && !existsSync(file)) die(`--require-file given but ledger file does not exist: ${file}`);

const WRITE_COMMANDS = new Set(["row", "token", "filed", "ruled", "dispatch", "settle", "review", "drain", "undrain", "rotate"]);
// `settle --from-report` takes the lock itself, once its checks have run —
// see runSettleFromReport().
const FROM_REPORT = cmd === "settle" && rest.includes("--from-report");
if (WRITE_COMMANDS.has(cmd) && !FROM_REPORT) await acquireLock();
// `rotate` never load()s: a ledger load() would refuse is still the previous
// run's record, and it is archived as-is — and read line by line when it
// carries live members forward, see carryOf().
let data = cmd === "rotate" ? null : load();

// The payload subcommands end by falling out of this chain, never by calling
// process.exit(). On a pipe, process.stdout.write is async and process.exit()
// discards whatever is still queued, so a payload past the buffer arrives cut
// — at exit 0, which types a corrupt read as a successful one.
// candidates.mjs states the same reason at its own exit line; this was the
// second script on that shape. The consumer that made it visible is board-gather.mjs,
// which reads `read` through execFileSync — a pipe — and accepts its ledger
// only as a path, so nothing on the caller's side could work around it: a
// grown ledger served a cockpit whose board was empty at HTTP 200.
//
// The chain is `else if` so that not exiting does not send a good subcommand
// on into the unknown-subcommand die() below it.
//
// `check` reaches both of its exits that way too, though only one of them
// could be an assignment where it stood. Its terminal exit was the last
// statement of its branch and became one directly. Its already-filed exit sits
// mid-branch, where falling through would run the near-miss ranking and the
// tracker search that exit exists to skip — so `check`'s branch is a function
// now (runCheck, below the chain), and a `return` is what skips them.
//
// What that leaves is a property of every payload this file emits rather than
// of whichever branches a sweep happened to reach: none of them reaches
// process.exit(), and none of their exit codes moved in getting there. A
// `check` arm is the one to re-read this against, because its payload is
// bounded by the LEDGER rather than by argv — `match` is a row read straight
// out of `data.filed`, and `near` is sliced from it — so both arms reach the
// cut on a ledger no caller can bound, which is why they are the arms the
// suite drives through a pipe.
if (cmd === "read") {
  console.log(JSON.stringify(data));
} else if (cmd === "row") {
  const [ticket, ...textParts] = rest;
  if (!ticket || textParts.length === 0) die("usage: ledger.mjs row <ticket> <text>");
  // A stray flag here becomes the row KEY, which is what the rewrite-in-place
  // lookup below matches on — so the real ticket's next `row` call finds no
  // match and appends a second row instead of rewriting the first.
  refuseStrayInId(ticket, "a ticket number");
  const key = ticket.startsWith("#") ? ticket : `#${ticket}`;
  const line = `${key} ${textParts.join(" ")}`;
  // Every reader parses member tokens anywhere in a row's text, so a token
  // with an outcome outside its family's vocabulary would land as a permanent
  // settle — `settle merge-bot-1 done` then refuses as "already settled as
  // dispatched". Refused before anything is written, new row or
  // rewrite alike; a well-formed token, live or settled, still goes through.
  const malformed = memberTokens(line).find((t) => t.error !== null);
  if (malformed) die(`row ${key}: malformed member token '${malformed.name}=${malformed.outcome}' — ${malformed.error}`);
  // `tier=` names the implementer cell an exploration Pull dispatched, so its
  // value must be a cell token: a retired or misspelt tier written here would
  // only be refused later, by `dispatch`, after the claim.
  const badTier = tierValues(line).find((v) => !CELL.test(v));
  if (badTier !== undefined) die(`row ${key}: 'tier=${badTier}' is not tier=<cell> — a cell is <slow|task|smol>-<level>`);
  // `label-off=<attempt>` tells the tick a missing `ready-to-merge` is
  // the controller's own removal, not a finisher's miss — so one naming no
  // finisher-pr member this run has would mask a real miss behind a record of
  // nothing; see badLabelOff().
  const badOff = badLabelOff(line.split(/\s+/));
  if (badOff !== undefined) {
    die(`row ${key}: '${badOff}' ${LABEL_OFF_UNKNOWN}`);
  }
  const i = data.rows.findIndex((r) => r.split(/\s/)[0] === key);
  const created = i === -1;
  const oldRow = created ? null : data.rows[i];
  const after = created ? [...data.rows, line] : data.rows.with(i, line);
  // Every review token is `review`'s to write, onto the PR's row in write
  // order, so `row` adds none; one the row already holds is carried.
  const reviewToken = addedReviewToken(oldRow, line);
  if (reviewToken !== undefined) {
    die(`row ${key}: adds review token '${reviewToken}' — review tokens are written only with \`ledger.mjs review <pr> <token>…\`, which puts them on the PR's row`);
  }
  // Every token about a PR lives on the PR's row, so a write that makes a PR
  // map to a second row splits its history across two rows the tick reads in
  // row order, not write order. Added only: a split already on disk is
  // carried.
  const split = newSplitRow(data.rows, after);
  if (split !== null) {
    die(`row ${key}: ${splitRowClause(split)}; rewrite that row instead`);
  }
  // A PR's review record is read off its rows — every row mapping to it, in
  // ledger order — so a write that drops an open launch makes the tick lose
  // a review. Refused here, with a member named twice on one line, before
  // anything is written; what the ledger already held is carried, never
  // re-judged. Local only.
  const refusal = rowWriteRefusal(data.rows, after, oldRow, line);
  if (refusal !== null) die(`row ${key}: ${refusal}`);
  data.rows = after;
  // Logged only after save() returns — a failed write must not claim a row
  // was recorded when it never made it to disk.
  save(data);
  // A rewrite loses every token the new text does not repeat, so the ones it
  // lost are named: the controller learns of a dropped `ports=` or `→ PR#`
  // here and not from a later reader that finds it missing.
  if (created) {
    console.error(`    new row ${key}`);
  } else {
    const dropped = droppedTokens(oldRow, line);
    console.error(`    rewrote row ${key}${dropped.length === 0 ? "" : `; dropped: ${dropped.join(" ")}`}`);
  }
  console.log(JSON.stringify({ ticket: key, line, created }));
} else if (cmd === "filed") {
  const [issue, ...subjectParts] = rest;
  if (!issue || subjectParts.length === 0) die("usage: ledger.mjs filed <issue> <subject>");
  // A stray flag here shifts the issue number into the subject, so the row it
  // writes no longer answers the subject a later `check` asks about — that
  // check reports not-filed at exit 0 where the correctly-spelled filing makes
  // it report already-filed at exit 1.
  refuseStrayInId(issue, "an issue number");
  const subject = subjectParts.join(" ");
  const id = issue.replace(/^#/, "");
  // isDigits() gates id the same way runDispatch's `keyNum` check gates the
  // ticket/PR key: left unvalidated, a non-digit id becomes a `#<id> ` prefix
  // subjectOf()'s digits-only regex cannot strip, so a near-duplicate
  // `check` against that row silently degrades from the hard "already
  // filed" block to a soft near-miss suggestion instead.
  if (!isDigits(id)) die(`'${issue}' is not an issue number`);
  const { row, alreadyRecorded } = recordFiled(id, subject);
  if (alreadyRecorded) {
    console.error(`    already recorded: ${row}`);
    console.log(JSON.stringify({ issue, subject, total: data.filed.length, alreadyRecorded: true, row }));
  } else {
    save(data);
    console.log(JSON.stringify({ issue, subject, total: data.filed.length }));
  }
} else if (cmd === "ruled") {
  const [pr, ...decisionParts] = rest;
  if (!pr || decisionParts.length === 0) die("usage: ledger.mjs ruled <pr> <decision>");
  // Nothing reads this section back — save() is its only consumer — so the
  // harm here is the narrowest of the three: a permanently wrong decision
  // record in an append-only file, with no verdict riding on it. Guarded
  // anyway, because that record is what the subcommand exists to write.
  refuseStrayInId(pr, "a PR number");
  const decision = decisionParts.join(" ");
  data.ruled.push(`#${pr.replace(/^#/, "")} ${decision}`);
  save(data);
  console.log(JSON.stringify({ pr, decision, total: data.ruled.length }));
} else if (cmd === "check") {
  runCheck();
} else if (cmd === "dispatch") {
  runDispatch();
} else if (cmd === "settle") {
  if (FROM_REPORT) await runSettleFromReport();
  else runSettle();
} else if (cmd === "token") {
  runToken();
} else if (cmd === "review") {
  runReview();
} else if (cmd === "drain") {
  // One marker per run. A second `drain` — a replacement controller that
  // cannot tell whether its predecessor got this far — is answered with the
  // standing marker at exit 0, not by overwriting the reason it records.
  // Trimmed because load() trims every entry it reads back.
  const reason = rest.join(" ").trim();
  if (!reason) die('usage: ledger.mjs drain "<reason>"');
  const created = data.drain === null;
  if (created) {
    data.drain = reason;
    save(data);
  } else {
    console.error(`    already draining: ${data.drain}`);
  }
  console.log(JSON.stringify({ drain: data.drain, created }));
} else if (cmd === "undrain") {
  // Clears the standing marker a drain wrote. Refused when none is set: an
  // undrain with nothing to clear is reported, not answered as success.
  const reason = rest.join(" ").trim();
  if (!reason) die('usage: ledger.mjs undrain "<reason>"');
  if (data.drain === null) die("no drain marker is set — nothing to undrain");
  const undrained = data.drain;
  data.drain = null;
  save(data);
  console.log(JSON.stringify({ undrained, reason }));
} else if (cmd === "rotate") {
  // It moves the file, so a stray word — an imagined `--dry-run` — is
  // refused rather than read as permission to move it.
  if (rest.length) die("usage: ledger.mjs rotate");
  runRotate();
} else {
  die(`unknown subcommand '${cmd}' — expected row, token, filed, ruled, check, read, dispatch, settle, review, drain, undrain or rotate`);
}

// Reached only by an arm that did not die, so every write subcommand that did
// not refuse is stamped — one that found nothing to change (a repeat `drain`,
// a duplicate `filed`) is still the controller acting. Still under the write
// lock, so two ledger calls never race on the key. A heartbeat file that
// exists and cannot be read is left as it is for the readers that refuse on
// it; readState() has already said why.
if (WRITE_COMMANDS.has(cmd) && cmd !== "rotate") {
  const beatFile = stateFileIn(dirname(file));
  const state = readState(beatFile, NAME);
  if (!state.degraded) writeState(beatFile, NAME, state, { acted: { at: Date.now() } });
}

// `check` alone of the subcommands leaves its arm early: the already-filed
// answer is complete before the near-miss ranking and the tracker query below
// it, whose results that answer would only discard. A function is what makes
// leaving early expressible — `process.exitCode` and a `return`, reaching the
// same exit by the same path every other subcommand takes, where an arm of the
// chain had only `process.exit()` and the payload it abandoned.
// Hoisted, so the dispatch chain above stays the file's spine.
function runCheck() {
  // The first check of a run legitimately has no file yet, so absence alone
  // cannot be an error — but a silent "safe to file" for every check when
  // the path is simply wrong (typo'd --file) is a fail-open that no caller
  // would notice. Warn loudly by default; --require-file makes absence a
  // hard failure for callers that know the file must already exist — and that
  // refusal is read ahead of the dispatch now, not here, because four other
  // subcommands needed the same one. Reaching this line at all means
  // the flag was absent.
  //
  // `ledger.ok` is the parse's answer, not this stat()'s: load() sets it only
  // for a file it opened and found a `## Filed` header in, so a --file landing
  // on some other existing file reports `ok:false` rather than a positive
  // machine-readable claim that the ledger was read. The warning below stays
  // on existence because that is the question it answers, and --require-file's
  // contract is absence rather than shape — so the two are two observations
  // now, each true of its own question, where before they were one that was
  // true of neither. Narrower, not airtight: a ledger truncated AFTER the
  // header still parses, with the rows below it lost.
  const ledger = { ok: ledgerParsed };
  if (!existsSync(file)) {
    console.error(
      `${NAME}: WARNING — ledger file not found: ${file}. Every check will read "safe to file" until it exists.`,
    );
  } else if (!ledger.ok) {
    // The existence probe above is silent once `file` exists, so a
    // `--file` landing on a real-but-wrong path — a typo'd neighbour, a
    // corrupted "## Filed" header, a 0-byte file — got the SAME silence as a
    // clean read. `ledger.ok` (above) already tells the machine-readable half
    // apart; this is that same "opened it, it did not parse" fact stated on
    // stderr, in wording that does not borrow "file not found" — the file
    // demonstrably exists, so claiming otherwise would be a fresh version of
    // the defect already removed from the JSON half.
    console.error(
      `${NAME}: WARNING — ${file} exists but does not look like a ledger (no "${FILED}" header found). Every check will read "safe to file" until it is fixed.`,
    );
  }
  refuseStrayInCheckTail(rest);
  const subject = rest.join(" ");
  // Quoted here, unlike the three usage strings above, because
  // refuseStrayInCheckTail() is the reason: `check` is the subcommand whose tail
  // must arrive as ONE argument, and this is the only spelling of its call
  // inside the script. The other three take their tail as the words a
  // caller typed.
  if (!subject) die("usage: ledger.mjs check \"<subject>\"");
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const tokenSet = (s) => new Set(norm(s).split(/\s+/).filter(Boolean));
  const target = tokenSet(subject);
  if (target.size === 0) die(`normalised subject is empty — '${subject}' has no alphanumeric tokens to check`);
  // Substring matching collides both ways: a short generic subject ("line")
  // matches everything (false "already filed" silently loses a finding),
  // while an all-punctuation subject normalises to "" and matches anything
  // too. Token-set matching fixes both, with a deliberate asymmetric bias —
  // a false "already filed" is invisible and bad, a false "not filed" just
  // creates a duplicate someone closes — so equal sets OR a >=4-token subset
  // both count as a match, catching real near-duplicate rewordings without
  // matching short generic overlaps.
  const isMatch = (filedTokens) => {
    const [small, big] = filedTokens.size <= target.size ? [filedTokens, target] : [target, filedTokens];
    // Both acceptance rules are size tests, so they gate the subset walk
    // instead of following it: a pair qualifying under neither is refused
    // without walking the smaller set, one qualifying under either is walked
    // once. Testing set equality as a separate walk, as this did, re-walked a
    // same-size near-miss that cleared the subset floor for an answer the
    // first walk had already produced — equal sizes are exactly the case
    // where the two walks are the same walk.
    // Not `small.isSubsetOf(big)`: that's Node v22.0.0+, above this repo's
    // declared >=20.11.0 floor (a test reds it).
    return (small.size === big.size || small.size >= 4) && [...small].every((t) => big.has(t));
  };
  // Strip the leading `#NNN ` issue number: it is metadata, not part of the
  // finding's subject. Left in, it becomes a stray token the checked subject
  // never carries, so a filed row can never be a subset of a longer check
  // subject — the >=4-token rule silently never fires and duplicates get filed.
  const subjectOf = (filedRow) => filedRow.replace(/^#\d+\s+/, "");
  const match = data.filed.find((f) => isMatch(tokenSet(subjectOf(f))));
  if (match) {
    console.error(`${NAME}: ALREADY FILED — ${match}`);
    // `ledger` rides on this arm too, where it can only be true. A consumer
    // testing `!payload.ledger.ok` otherwise reads the field's absence as
    // falsy — "never read" — on the one answer that proves it was read.
    console.log(JSON.stringify({ subject, found: true, match, ledger, verdict: "already-filed" }));
    // Exit 1 means "do not file this again" — the strong signal. Exit 3 is also
    // non-zero but weaker: tracker rows to review, not a ruling. A caller that
    // checks only the exit status stops on both, which errs toward not
    // duplicating.
    //
    // exitCode + return, not exit(): the payload above is `match`, a row read
    // straight out of the ledger, and `filed` caps neither the subject it
    // stores nor the ledger it stores it into — so this is the branch whose
    // payload is bounded by the LEDGER rather than by argv, and measured, an
    // ordinary four-word check against one wide filed row arrived cut at the
    // pipe buffer. The code it arrived under was already this 1, so what the
    // exit lost was the payload alone, the `verdict` field parsing consumers
    // read included. The `return` is what keeps the ranking and the
    // tracker query below unreached; nothing after it assigns exitCode on
    // this path, so 1 is what the process leaves with.
    process.exitCode = 1;
    return;
  }

  // Near-miss reporting. The subset match above answers exactly one question —
  // "was this near-verbatim wording already filed" — and answers it well. It
  // says nothing about the same finding described in DIFFERENT words, which is
  // how a second discoverer actually words it: one measured run rediscovered
  // one issue five times, each in its own phrasing, and the check caught none of
  // them. Rank the filed list by token overlap and hand the top rows back with
  // a score, instead of collapsing all of that into `found: false`.
  //
  // Scored on its own token set, deliberately not the exact path's. Stopwords
  // and the singular fold only sharpen a ranking, but folding them into
  // isMatch() would widen what counts as ALREADY FILED — the one behaviour
  // here that callers gate on and that must not move.
  // Widened to cover modals, negations and temporals ("should", "never",
  // "still"...) are noise words that are never the subject's distinctive
  // term, yet the old, shorter list let them survive to outrank one — "the
  // guard should never fail open on a fork" picked "should guard never" over
  // content words a reader would actually search for. Measured zero fallout:
  // this file's suite is unchanged by the widening (see the "term selection"
  // tests). Two adjacent ideas were considered and rejected, not attempted
  // here: preferring identifier-shaped tokens (`CI`, `gh`) over long ordinary
  // words — but norm() below has already stripped the punctuation that would
  // mark a token as an identifier, so that needs a different pipeline, not a
  // different stoplist — and real frequency weighting, which stays the named
  // upgrade path until something measured demands it. Neither would be
  // reachable by widening a stoplist anyway.
  const STOP = new Set((
    "the a an of to in is it its and or for on with that this from at by " +
    "should would could can may might must will shall ought " +
    "not never cannot nor " +
    "still already now then soon yet always once again when while before after until since"
  ).split(" "));
  // One pipeline, two callers. The scoring path and the query path filter on the
  // same floor and the same stoplist, and writing that expression out twice is
  // what let them drift — the coupling test below pins that they agree, and a
  // single definition is what makes the pin structural rather than hopeful.
  // It is also the only place the `>= 3` floor exists, so one mutation reaches
  // both consumers.
  const contentWords = (s) => norm(s).split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t));
  const scoreTokens = (s) => new Set(contentWords(s).map((t) => t.replace(/s$/, "")));
  // Overlap coefficient (shared / smaller set), not Jaccard. A filed row carries
  // a source tag like `(review-pr-108)` and other metadata the checked subject
  // can never contain, so the union is dominated by tokens with no chance of
  // matching: Jaccard drives every row to a similar small number and the
  // ranking stops discriminating. Dividing by the smaller set also keeps the
  // score indifferent to which side is more verbose.
  const overlap = (a, b) => {
    if (a.size === 0 || b.size === 0) return 0;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    return shared / Math.min(a.size, b.size);
  };
  const round2 = (n) => Math.round(n * 100) / 100;
  const scored = scoreTokens(subject);
  // No floor was tuned here: the measured rewording shares exactly one
  // content word, and a threshold picked to look tidy would drop the very case
  // this exists for. The top-3 cap, not the floor, is what keeps the output
  // short. `rankedNear`'s filter still imposes one, because it tests the
  // ROUNDED score: a raw overlap below 0.005 rounds to 0.00, so a row that
  // DOES share a content word is dropped from both `near` and `nearTotal`,
  // with no line reporting it. That cutoff is not a chosen number — it sits
  // wherever round2's two decimals land and moves only if that precision does.
  // Filtering on the raw score instead is not the free fix it looks like: it
  // admits such a row at a display score of `0.00` (measured), so honest
  // output would need a wider precision, not just a different filter.
  const NEAR_SHOWN = 3;
  // The floor at which a near-miss stops being decoration and becomes the
  // verdict's own answer — `soft-hit` rather than `clean`. A tuning
  // value, deliberately named and deliberately here beside the display cap
  // rather than inlined in the verdict below.
  //
  // Chosen from measured rows: the near-misses a reader went on to
  // confirm as the genuinely adjacent issue scored from 0.20 up to 0.45, so a
  // floor at 0.20 admits them. The same measurement includes an adjacent row at 0.09, which
  // this floor does not reach — the floor buys a short answer, never
  // completeness, and the rows themselves stay printed and stay in the payload
  // at every verdict for exactly that reason. Raise it and adjacent rows fall
  // back to `clean`; lower it and every check reporting a soft hit is what
  // gives.
  const NEAR_SOFT_HIT = 0.2;
  const rankedNear = data.filed
    .map((row) => ({ row, score: round2(overlap(scored, scoreTokens(subjectOf(row)))) }))
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score);
  const near = rankedNear.slice(0, NEAR_SHOWN);
  // The cap is a display budget, and it says nothing about the rows it drops:
  // scores tie across it routinely — measured, five rows at 1.00 with the
  // caller shown three — so the cut is arbitrary among equals. A bare
  // three-row list is then indistinguishable from a complete one, which is
  // the "no silent caps" rule `candidates.mjs`'s `refuseIfCapped` legislates one script over.
  // It enforces that rule by refusing outright; refusing is wrong
  // here — these rows are advisory context for a decision, not the work queue,
  // and a single tracker hit already forces exit 3. Report the COUNT withheld
  // and the best score among them, never the rows: printing the rows would
  // give back the length the cap exists to take away, while the count and the
  // top withheld score are what tell a caller whether the cut cost it
  // anything.
  const withheld = rankedNear.slice(NEAR_SHOWN);

  // The ledger can only see what THIS run recorded. An issue that already
  // exists on the tracker but never reached this `filed` list — filed by an
  // earlier run, by the maintainer, by hand — is structurally invisible to
  // every match above, and that is the measured failure: one issue was rediscovered
  // five times in one run and `check` reported it safe to file every time. Ask
  // the tracker.
  //
  // gh ANDs the search terms, so every extra term can only narrow the result —
  // keep the query SHORT: three of the subject's most distinctive words.
  // Measured against the live tracker, "candidates opposite states" returns
  // that issue. Whether a fourth term helps or hurts turns on whether it
  // happens to occur in the target issue's text — gh searches bodies, not just titles —
  // which the subject cannot know: "code" leaves it in, "open" drops it. So
  // three is a recall-preserving floor, not a measured optimum. Longest-first is a crude stand-in for distinctiveness (no
  // corpus to weigh terms against) and the >= 3 filter erases short but
  // distinctive identifiers like `CI` or `gh`; upgrade to a real frequency
  // weighting if the query starts missing.
  //
  // STOP was widened (above) to stop modals/negations/temporals from
  // outranking real content words, and stops there — this is a pin, not a
  // retune. Two things it deliberately leaves broken: longest-first still
  // prefers a long ordinary word over a short distinctive one ("postgres"
  // still loses to "exhausted"/"sustained"; "cap" still loses to
  // "silently"/"surfaced"), because fixing that is the frequency-weighting
  // upgrade above, not a stoplist edit; and the >= 3 filter still erases `CI`
  // and `PR` outright, because norm() has already destroyed the punctuation
  // that would mark them as identifiers worth keeping short — a different
  // pipeline, not a different stoplist or a lower floor (lowering it
  // interacts with every one of these and had no test of its own until this
  // issue added one). A tracker search that returns nothing is reported
  // below as "no matches for this query", not as "no related issues" — a
  // three-term heuristic query coming up empty establishes that the query
  // found nothing, not that the tracker has nothing.
  //
  // norm() has already stripped punctuation, which is also what keeps a subject
  // containing `is:open` or `file.mjs:164` from smuggling a qualifier into the
  // search and silently changing what was searched for.
  const terms = [...new Set(contentWords(subject))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);
  const query = terms.join(" ");
  // How many tracker rows the caller is shown. gh is asked for one MORE than
  // this (below): its list arrives with no total, so a full page and a
  // truncated one are byte-identical, and the extra row's presence is the only
  // truncation signal available. Cheap: one row, one query, and it is
  // ranked alongside the rest rather than discarded.
  const TRACKER_SHOWN = 5;
  let tracker;
  if (terms.length === 0) {
    // An empty --search matches every issue in the repo, which would report
    // every subject as a tracker hit. Not searching is the honest answer.
    // `hits` is omitted, not `[]` — the tracker was never read, so an empty
    // list here would be a claim of cleanliness this branch never earned
    // (a consumer testing `.length` must not read this as clean).
    tracker = { ok: false, query: null, error: "subject has no distinctive terms to search for" };
  } else {
    // gh resolves "the repository" from the child process's cwd, which
    // defaults to THIS process's cwd — the caller's, not the ledger's. The
    // ledger itself is resolved from --file or defaultLedgerPath()'s
    // --git-common-dir above; in the documented flow (no --file, run from
    // the repo) the two agree, but an explicit --file naming a ledger
    // outside the caller's repo diverges silently: the query searches the
    // wrong tracker and reports a confident, empty result. Bind gh's
    // cwd to the ledger's OWN repository instead of leaving it implicit —
    // its work tree's root, or its common git dir where it has no work tree
    // (see the probe below). No --repo flag needed — gh's remote-based
    // resolution does the rest once it is pointed at the right directory,
    // and a worktree ledger (shared .git, own working tree) still resolves
    // to the same repo either way.
    //
    // cwd is not the whole story: inherited git vars outrank it, so an
    // ambient GIT_DIR/GIT_WORK_TREE retargets BOTH the probe below and gh's
    // own remote resolution at the other repository, and the same
    // confident-empty result comes straight back with `ok: true` on it.
    // Plausible here: a git hook, `rebase --exec`, `bisect run`. Scrub them
    // off both children — the fleet's own fixtures already do exactly this.
    //
    // GH_REPO is the same hazard one layer up, and worse: gh reads it BEFORE
    // it ever consults git, so no amount of git-var hygiene covers it and the
    // bound cwd is simply ignored. Measured against a live tracker with the
    // cwd binding in place: `GH_REPO=<some other real repo>` searched that
    // repo and returned `{"ok":true,"hits":[],"verdict":"clean"}` — the
    // same wrong-tracker answer, in the documented flow, no --file divergence needed. Not
    // hypothetical here either: this repo's own
    // .github/workflows/release-label.yml exports GH_REPO to every step that
    // shells out to gh.
    // Empty string is the documented fall-back-to-cwd value (measured — unset
    // and "" behave alike), so this composes with cwd rather than fighting it.
    //
    // With all three off, the ledger and the queried tracker cannot disagree.
    const queryEnv = { ...process.env, GH_REPO: "" };
    delete queryEnv.GIT_DIR;
    delete queryEnv.GIT_WORK_TREE;
    let ledgerDir = dirname(resolve(file));
    // `check` runs before the run's FIRST ledger write, and `.fleet/` is
    // gitignored and created lazily by save()'s mkdirSync — so on a fresh
    // clone or worktree the ledger's own directory does not exist yet, while
    // `git -C` requires one that does (exit 128, "cannot change to ...").
    // Climb to the nearest existing ancestor: same repository, and probing
    // the missing directory instead reported every first `check` as not being
    // in a repository and dropped the tracker query outright.
    while (!existsSync(ledgerDir) && dirname(ledgerDir) !== ledgerDir) ledgerDir = dirname(ledgerDir);
    // LC_ALL=C on this probe alone: the no-work-tree refusal below is told
    // apart from every other failure by git's own wording, which a translated
    // git would otherwise spell differently. gh keeps `queryEnv` untouched.
    const probeEnv = { ...queryEnv, LC_ALL: "C" };
    let repoCheck = spawnSync("git", ["-C", ledgerDir, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: probeEnv, timeout: GIT_TIMEOUT_MS });
    // A repository with no work tree — the `.bare` layout and its linked
    // worktrees, a bare repository, a `--separate-git-dir` clone — is where
    // fleetFile() puts the ledger INSIDE the git dir or beside it, and git
    // refuses `--show-toplevel` there ("must be run in a work tree", exit
    // 128). That is not "no repository": the same directory answers
    // `--git-common-dir`, and `gh` resolves its remote from a git dir just as
    // it does from a checkout (measured on a bare repository with a remote).
    // Bind to the common git dir — the very repository fleetFile() resolved
    // the ledger against — never to this process's cwd. ONLY that refusal
    // gets this: "not a git repository", git missing, a dubious-ownership
    // refusal, an unreadable gitfile and a probe killed at its bound all stay
    // on the failure branch below, and so does a second probe that fails.
    const noWorkTree = repoCheck.status === 128 && NO_WORK_TREE.test(repoCheck.stderr);
    if (noWorkTree) {
      repoCheck = spawnSync("git", ["-C", ledgerDir, "rev-parse", "--git-common-dir"], { encoding: "utf8", env: probeEnv, timeout: GIT_TIMEOUT_MS });
    }
    if (repoCheck.status !== 0) {
      // More than one cause lands here: a ledger path genuinely outside any
      // repository, but also git missing entirely (spawn ENOENT, so `status`
      // is null and `null !== 0`), a dubious-ownership refusal, an unreadable
      // `.git` gitfile, and a probe that overran GIT_TIMEOUT_MS —
      // spawnSync reports that the same way ENOENT arrives, `status` null with
      // the reason in `error.message`, so it needs no arm of its own and
      // cause() names it (`spawnSync git ETIMEDOUT`) without this branch
      // having to. Do not name one of them — carry git's own reason,
      // because this call leaves stdio at the default pipe, so git's stderr
      // reaches no terminal and this string is the only place the cause is
      // ever seen (the same call the gh catch below makes). The CAUSE is
      // capped for the same reason: it ships on stdout inside `tracker.error`
      // — see cause(), which owns both that cap and the choice between the
      // fields a failed git can put a reason in. Empty here is a tolerable
      // answer where it is not for the gh catch below: the message this
      // interpolates into still names the probe that failed and the path it
      // failed on.
      //
      // That cap covers the cause and NOTHING else. `tracker.error` as a whole
      // is deliberately unbounded here, because the directory interpolates
      // raw: the field measured 1100 characters from a 557-character
      // directory, a cause already cut to 500, and 43 of fixed text.
      // Capping the directory would buy the payload no ceiling — `subject`
      // and `tracker.query` ride in the same JSON uncapped: as JSON fields
      // from a 3000-character subject word they measure 3012 and 3010
      // characters respectively (the 2-char gap is `query` being a shorter
      // key than `subject`, not a difference in the values) — and it would
      // cut the path the probe actually failed on, which is what this
      // message is for.
      // cause() is the wrong instrument for it twice over: it keeps the END,
      // so on a path it drops the root and returns a `…`-prefixed string that
      // reads like a path and is not one, and what it exists to contain is a
      // child's stderr, which nothing bounds, where the climb above leaves
      // this a path that exists.
      //
      // Either way there is no repository for the query to bind to — the same
      // state as this process's own cwd not being a repo, which already
      // degrades via the generic `!tracker.ok` branch below. Reuse that: no
      // gh invocation, no separate "unchecked" shape.
      const why = cause(repoCheck.error && repoCheck.error.message, repoCheck.stderr);
      tracker = { ok: false, query, error: `cannot resolve the ledger's repository (${ledgerDir})${why ? `: ${why}` : ""}` };
    } else {
      // The work tree's root, or the common git dir where the repository has
      // no work tree. `--git-common-dir` may answer relative to the directory
      // it ran in (`.` when that is the git dir itself) or absolute, and
      // resolve() takes either. Read only past the status check above: a
      // probe that never spawned (git missing) leaves `stdout` undefined.
      const probed = repoCheck.stdout.trim();
      const ghCwd = noWorkTree ? resolve(ledgerDir, probed) : probed;
      try {
        const out = execFileSync(
          "gh",
          ["issue", "list", "--search", query, "--state", "all", "--limit", String(TRACKER_SHOWN + 1),
            "--json", "number,title,state,url"],
          { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"], cwd: ghCwd, env: queryEnv },
        );
        // Parsing inside the try on purpose: gh can exit 0 and still print
        // something that is not the JSON asked for. A parse failure is a failed
        // tracker read, not a clean tracker.
        const parsed = JSON.parse(out);
        // Parseable is not the same as the shape asked for. Without this, a gh
        // printing a JSON array that is not an issue list escalates to exit 3 and
        // prints "TRACKER HIT — #undefined" — a confident hit blocking a filing
        // that is in fact unverified. Throw into the catch below: an unreadable
        // answer is a failed tracker read, exactly like unparseable output.
        //
        // Validated: exactly those fields the hit line below interpolates that
        // have no defined absent-value. `title` is deliberately not among them —
        // the row builder substitutes `h.title || ""` for it, in the row and in
        // the score alike, so a row that OMITS `title` and carries every other
        // field still describes itself truthfully. Validating `title` here would
        // degrade that row to `unverified` over the one field the hit line does
        // not need, which is the opposite of what a guard against undescribable
        // hits is for.
        //
        // Absence is the whole of that claim, deliberately: a `title` that is
        // PRESENT and not a string is not handled here or anywhere below —
        // `h.title || ""` keeps a truthy non-string, and scoreTokens then calls
        // `.toLowerCase()` on it, so the read degrades to `unverified` reporting
        // a TypeError where a tracker reason belongs. That is a question of field TYPE; this
        // guard rules on field PRESENCE.
        if (!Array.isArray(parsed) || parsed.some((h) => !h || typeof h.number !== "number"
          || typeof h.state !== "string" || typeof h.url !== "string")) {
          throw new Error("gh returned JSON that is not an issue list");
        }
        // Every row gh returned is validated above, the probe row included: a
        // malformed row anywhere means the read is untrustworthy, and this
        // degrades to `unverified`, which never turns a hit into a clean bill.
        //
        // Rank the whole fetched window, THEN cut. Ranking only the first five
        // would hand back gh's own window order wearing a score order's
        // clothes, and the probe row was fetched to be ranked, not just
        // counted. What the cut cannot repair is that gh chose the window at
        // all — six rows are still a window, and re-sorting one does not widen
        // it — so `truncated` REPORTS that rather than pretending otherwise.
        const rankedHits = parsed
          .map((h) => ({
            number: h.number, title: h.title || "", state: h.state, url: h.url,
            score: round2(overlap(scored, scoreTokens(h.title || ""))),
          }))
          .sort((a, b) => b.score - a.score);
        tracker = { ok: true, query, hits: rankedHits.slice(0, TRACKER_SHOWN), truncated: rankedHits.length > TRACKER_SHOWN };
      } catch (e) {
        // Every gh failure lands here — no network, no auth, rate limit, gh not
        // installed (ENOENT), a timeout, unparseable output. None of them may
        // produce a bare "safe to file": that is the same fail-open class the
        // --git-common-dir resolution above already closed once. Degrade to the
        // ledger-only answer and say so.
        // Capped, and deliberately still carrying the stderr — the opposite call
        // from the fleet's other gh catches. Those omit it because
        // execFileSync forwarded the child's bytes to our stderr already, so
        // interpolating emits them twice; this call sets `stdio`, which turns
        // that forwarding OFF, so this string is the only place the cause is
        // ever seen. What it must not be is unbounded: it lands in
        // `tracker.error`, which ships on stdout as part of a machine-parsed
        // contract, and a megabyte of gh stderr inside a JSON field is a payload
        // problem wherever the forwarding argument lands. cause() owns both that
        // cap and which end of an overrunning stderr survives it.
        //
        // stderr first, then the message: on a non-zero exit Node builds the
        // message out of the same bytes prefixed by the command, so it is the
        // LONGER copy of the cause, not a smaller fallback (measured). The
        // message earns its place wherever stderr holds no
        // cause — and stderr holds none in three shapes, only one of which is
        // the field being absent: no `stderr` property at all on the output
        // this file refused to parse or refused the shape of, the property
        // present but `undefined` on a spawn Node never started, and present
        // but EMPTY on a child killed before it printed. Measured on Node
        // v26.7.0 — "carries no stderr field at all" covered the first shape
        // only. It also earns its place on a stderr with no cause in it, where
        // it still names the command that failed.
        //
        // Except where Node aborted the child, and there the order flips.
        // `e.code` carries the abort — ETIMEDOUT, ENOENT, EACCES — and Node
        // does not set it on an ordinary non-zero exit, so it separates the
        // failures gh explained for itself from the ones only Node can
        // explain. A timeout is named in `e.code` and `e.message` and NOWHERE
        // in `e.stderr`, which on a timeout holds whatever gh printed before
        // the kill: measured end to end, a gh that warned about cached
        // credentials and then hung reported that warning as the cause of a
        // 20-second stall and named the timeout nowhere. The flip moves
        // exactly one failure, the timeout that printed something — the other
        // aborts leave `e.stderr` undefined, so the message already won there.
        // A Node that did set `e.code` on a plain non-zero exit would degrade
        // to "Command failed" plus those same bytes, the longer copy; the
        // accept-unchanged test below pins that string exactly, so it would
        // say so loudly rather than this arm drifting in silence.
        //
        // Nothing this arm can currently throw reaches the literal last resort:
        // every failure that lands here carries a message. It stays because an
        // empty `tracker.error` is precisely what makes the warning below name
        // no reason, which is the defect this arm was filed for.
        //
        // `hits` omitted here too, same reason as the no-terms branch above:
        // the search never ran, so there is no empty result to report.
        tracker = { ok: false, query, error: (e.code ? cause(e.message, e.stderr) : cause(e.stderr, e.message)) || "gh failed without saying why" };
      }
    }
  }

  // The best score each half of the answer carries, read once off the same
  // sorted head the report below prints from and the verdict under it uses —
  // one derivation, so stderr and the payload cannot disagree about what was
  // found.
  //
  // Both lists are sorted best-first before they are cut, so the leading row
  // carries the best score of everything fetched: a 0 at the head of `hits`
  // means every row gh returned scored 0, and the withheld near-misses can only
  // score at or below `rankedNear`'s head. `rankedNear`, not the displayed
  // slice — the display cap must not be able to move a verdict.
  const bestHit = tracker.ok && tracker.hits.length ? tracker.hits[0].score : 0;
  const bestNear = rankedNear.length ? rankedNear[0].score : 0;

  for (const n of near) console.error(`${NAME}: near-miss ${n.score.toFixed(2)} — ${n.row}`);
  if (withheld.length) {
    console.error(`${NAME}: ${withheld.length} further near-miss${withheld.length === 1 ? "" : "es"} not shown — highest withheld ${withheld[0].score.toFixed(2)}; the cap dropped them, not the score`);
  }
  if (!tracker.ok) {
    console.error(`${NAME}: WARNING — TRACKER NOT CHECKED (${tracker.error}). An issue that exists on the tracker but was never recorded in this run is invisible to the answer below.`);
    console.error(`${NAME}: not previously filed in this run's ledger — ledger-only answer, tracker unchecked`);
  } else if (tracker.hits.length) {
    // Inside the branch that has already established `hits` is present, so no
    // `?? []` guard is needed. The loop stays FIRST: every hit is listed before
    // the summary that counts them, and a test pins that order.
    //
    // The score reaches the row, and the row's own word follows it. `TRACKER
    // HIT` is imperative, blocking language, and a row the scorer rates 0.00
    // rendered in it was indistinguishable from a genuine duplicate — measured,
    // and recovered from only by readers who went and searched the tracker by
    // hand. Under this heading stderr and the verdict now say the same
    // thing: a set with a scoring row is a hit, a set without one is rows to
    // read.
    const heading = bestHit > 0 ? "TRACKER HIT" : "TRACKER ROW";
    for (const h of tracker.hits) {
      console.error(`${NAME}: ${heading} — #${h.number} (${h.state}, score ${h.score.toFixed(2)}) ${h.title} — ${h.url}`);
    }
    // `more than N`, never `N`: with the probe row back, the exact count is
    // precisely what is not known, and printing `5` for it is the silent cap
    // restated as a number.
    console.error(bestHit > 0
      ? `${NAME}: not in this run's filed list, but ${tracker.truncated ? `more than ${TRACKER_SHOWN}` : tracker.hits.length} tracker issue(s) match '${query}' — review before filing`
      : `${NAME}: not in this run's filed list; the tracker rows matching '${query}' all score 0.00 against this subject — gh matched something the title-based score cannot see, so read them, but they are not a finding of duplication`);
    if (tracker.truncated) {
      console.error(`${NAME}: the list above is CAPPED at ${TRACKER_SHOWN} — gh returned more and reports no total, so these are the best-scoring of a window gh chose, not of the tracker.`);
    }
  } else {
    // Not "found no related issues" — that asserts the tracker has nothing,
    // when all that is actually established is that a ${terms.length}-term
    // heuristic query came back empty. A query built from a few
    // longest-surviving words can miss the very issue it should have found
    // (see the STOP comment above); "no matches for this query" says what was
    // established and leaves the rest unclaimed.
    console.error(`${NAME}: not previously filed; tracker search '${query}' (${terms.length} term${terms.length === 1 ? "" : "s"}) returned no matches — not a certification the tracker has nothing on this`);
  }
  // Named explicitly so a consumer does not have to reconstruct it from
  // `tracker.ok` plus `tracker.hits`.
  //
  // The scores decide, not the presence of rows. Both halves of the
  // answer were measured reporting the opposite of what their own numbers said:
  // `tracker-hit` over rows this file rates 0.00, and `clean` printed directly
  // above near-miss rows that named the right issue. Nothing new is computed
  // here — the scores were already in the payload and already on stderr; the
  // verdict simply stopped ignoring them.
  //
  // `soft-hit` is the answer for signal that is not a duplicate finding: rows
  // worth reading, at an exit code that does not claim the filing is settled.
  // It covers each of those, because they leave the caller in the same
  // position — a tracker set with no scoring row, or a filed row at or above
  // the near-miss floor.
  //
  // Order matters. `!tracker.ok` short-circuits before `tracker.hits` is read,
  // which is required: hits is absent, not `[]`, on that branch. `unverified`
  // stays ahead of the near-miss floor too — a tracker nobody read is the
  // weaker answer of the two and may not be dressed up as the stronger one.
  const verdict = !tracker.ok
    ? "unverified"
    : bestHit > 0
      ? "tracker-hit"
      : tracker.hits.length || bestNear >= NEAR_SOFT_HIT
        ? "soft-hit"
        : "clean";
  // Exit 0 is what a `check "$s" && gh issue create` chain reads as safe, and
  // `soft-hit` is precisely the answer that is not — so it is named on stderr
  // as well as in the payload, in the voice of the decision it asks for.
  if (verdict === "soft-hit") {
    console.error(`${NAME}: SOFT HIT — related rows above, none of them established as a duplicate. Read them and decide; do not read this exit code as safe to file.`);
  }
  // `nearTotal` alongside `near`, and `tracker.truncated` alongside `hits`:
  // both lists are capped and neither cap was previously visible from the
  // payload a consumer parses. They differ in what is knowable —
  // the ledger is fully in hand, so the near-miss total is exact, while gh
  // reports no total, so the tracker can only say that more exist.
  // `ledger.ok` beside `tracker.ok`, and deliberately NOT inside `verdict`:
  // the two halves each report their own readability, which is what makes an
  // unread ledger distinguishable from one read and found empty — those
  // payloads were otherwise identical in every field. Folding it into
  // the verdict instead would answer `unverified` for the run's FIRST check
  // on any fresh clone, where `.fleet/` does not exist until save() creates
  // it — see the comment on the repository probe above.
  console.log(JSON.stringify({ subject, found: false, match: null, near, nearTotal: rankedNear.length, ledger, tracker, verdict }));
  // Exit 3 — a new code — for "the ledger is clean but the tracker is not".
  // 1 would mean ALREADY FILED in this run, which a tracker hit does not
  // establish; 2 is taken by die(). Near-misses stay exit 0: they are a ranked
  // suggestion, not a finding of duplication. Exit 0 covers "clean",
  // "unverified" and "soft-hit" alike, which `verdict` names explicitly and the
  // exit code deliberately still does not: minting a code for unverified would
  // break `check "$s" && gh issue create` on every offline run, and a soft hit
  // is the same kind of answer — advisory rows, no established duplicate — so
  // it inherits that decision rather than reopening it. The exit code is a
  // pure function of `verdict`; only `tracker-hit` blocks, so a verdict added
  // later leaves 3 alone unless it says so here.
  //
  // A hit set scoring 0.00 no longer forces 3. gh can match an issue
  // body the title-based score cannot see, which is why those rows are still
  // printed and still shipped in the payload — but the instruction the callers
  // carry makes exit 3 binding, and measurement shows what that costs: every
  // recorded case of a hard stop over rows this file rates zero was survived
  // only by a reader who overrode it and searched the tracker by hand, and
  // obeying it would have dropped a real deferral.
  //
  // exitCode, not exit(): this is the last statement of the branch, so
  // assigning and falling out reaches the same codes by the same path every
  // other subcommand now takes, and stops abandoning the payload at the pipe
  // buffer. `near` is sliced from `data.filed`, so this payload is
  // ledger-bounded and did reach the cut — measured, four filed rows of
  // ~230 KB against a four-word argv arrived cut at exit 0, the "clean, safe
  // to file" signal.
  process.exitCode = verdict === "tracker-hit" ? 3 : 0;
}

// ── rotate ───────────────────────────────────────────────────────────────────
//
// One ledger per run. Phase 0 of every run moves the previous run's file aside
// before anything reads it, so no exclusion, filing, ruling or drain marker
// outlives the run that wrote it. The archive is the file itself —
// hard-linked to its stamped name, then unlinked or, when a successor is
// carried, replaced by it — so its bytes are untouched, and the link refuses
// atomically when that name is already taken rather than overwriting an older
// archive. The two receipts beside the ledger, `phase0.json` and
// `closeout.json`, belong to the same run, so each is archived as
// `<name>.<stamp>.json` under the ledger archive's own stamp, and the
// `briefs` directory beside them as `briefs.<stamp>` — a warning-only
// move after the ledger move, refused up front only when a name is taken.
//
// What follows depends on the verdict below. After a `dead` or `none` one
// nothing is carried: the next write subcommand finds no file and starts the
// empty skeleton, exactly as on a first run. After an `ancestor` one — this
// session's own earlier run, whose members run inside the omp process that
// is still this run's — rotate writes a new ledger holding what is still
// live in the archive: every row of a stream that holds an unsettled member
// token or an open review launch, whole, and every unsettled `## Dispatched`
// entry plus the settled ones naming a carried member (see carryOf()). The
// members those name may still be running, and dropping their tokens would
// let the next tick dispatch onto their work and leave their
// results nothing to settle. Phase 0 then reconciles each carried token
// against the session's job list; rotate cannot, since that list is the
// controller's to read and no script's.
//
// An `ancestor` rotate also writes `## Retired`: the bare name of every
// member the archive settled, or gave an outcome outside its family's
// vocabulary, and the new ledger does not carry, of every
// reviewer runner its rows launched and the new ledger does not carry, and
// every name the archive's own `## Retired` held. The omp process those
// members ran in is still this run's, and it answers a second task under a
// name it has used with `<name>-2` while `hub send <name>` keeps reaching the
// first — so a settled name stays taken for the session, not the run:
// `dispatch` and `review` refuse it (a replacement takes its own suffix) and
// `nextMergeBot` numbers past it. Measured before this: a session's second
// run restarted at `merge-bot-1`. A `dead` or `none` rotate retires nothing,
// since the process that held those names is gone.
//
// Under the write lock like every other write subcommand, so a concurrent
// writer either lands before the move (in the archive, whole) or after it (in
// the fresh skeleton) — never half in each.
//
// The liveness guard reads `controller` in the heartbeat file beside the
// ledger, the record the previous run's rotate left: the omp process that
// owned that run and its start time. It is judged once, before anything is
// written. A recorded controller that is alive, still the process it was
// (same start time), and not an ancestor of this call owns this file —
// whatever its heartbeat mark says, because a controller can stop beating
// and keep dispatching — and rotating under it would split its run across
// two ledgers. A dead one, a reused pid, or this session's own earlier run
// allows the rotation. With no record the guard falls back to the mark, read
// through fleet-state.mjs's own reader and verdict: still beating — a beat
// inside its window, or past it with a tick or ledger write inside
// theirs — refuses, and so does a tick or ledger write inside its window
// with no beat at all; a stalled mark, a recorded stop, or no mark at all
// allows the rotation, and that fallback proves "not beating", never "dead".
//
// A heartbeat file that exists but cannot be used — unreadable, not JSON, not
// a JSON object, or holding a `controller` key that cannot be judged — gets
// neither verdict: a record it may hold cannot be known, so rotate refuses
// rather than read the fault as "no record".
//
// Its last act, whether or not there was a ledger to move, replaces the
// record with this run's own, carrying the verdict as `prior` — the next
// step reads `prior`, because the new record always names this run's own
// live ancestor — and the time of this write as `at`, so a reader can tell a
// mark the previous run left from one written since. The same write stamps
// `acted` at that time, as every ledger write does. No omp ancestor removes
// the key: an older run's record left in place would be judged again, as
// dead, by a run that cannot know whether the run after it is still live.
// This run's own record is computed before anything moves too, so a process
// table that cannot be read refuses with nothing moved rather than after the
// move.
function runRotate() {
  const beatFile = stateFileIn(dirname(file));
  const state = readState(beatFile, NAME);
  const { beat, ticked, acted, controller } = state;
  // A file that exists and could not be used holds no record we can know of:
  // reading it as "no record" would let a live controller's ledger be moved
  // by exactly the fault that hid its record.
  if (state.degraded) {
    die(`refusing to rotate ${file}: ${beatFile} ${state.degraded} — repair it so its controller record is intact. Removing it makes this rotate judge none: if the previous run was this omp session's, its live members and retired names are not carried forward, so this run can dispatch onto their work and reuse their names.`);
  }
  let prior, ours;
  try {
    const source = processSource();
    const chain = ancestry(source);
    prior = judgeController(controller, source, chain);
    ours = controllerOf(source, chain);
  } catch (e) {
    if (!(e instanceof ProcUnreadable)) throw e;
    die(`refusing to rotate ${file}: ${e.message} — ${controller === null ? "this run's own controller cannot be determined" : `the controller recorded in ${beatFile} cannot be judged`}`);
  }
  if (prior === "alive") {
    die(`refusing to rotate ${file}: the controller that owns it is alive — controller pid ${controller.pid} (started ${controller.lstart}) recorded in ${beatFile} is alive and not an ancestor of this run, whatever its heartbeat mark says; one controller per checkout — end that omp session, or start the run from inside it`);
  }
  // The fallback guards a ledger, as it always has: with none to move there
  // is nothing for a beating mark to protect. A ledger write is the
  // controller acting, and counts the way a beat does. Refuse when the beat
  // is beating, and also — the one state assessBeat reads as `none`, because
  // the cockpit shows no panel without a record — when there is no beat at
  // all and a tick or ledger write is still inside its window: a record lost
  // to a removed file leaves exactly that. A recorded stop reads `stopped`
  // through assessBeat, so it lets the rotation through.
  const exists = existsSync(file);
  const judgedAt = Date.now();
  const markWindowEnd = beat === null ? stallsAt({ ticked, acted }) : null;
  const actingWithoutBeat = markWindowEnd !== null && judgedAt <= markWindowEnd;
  if (prior === "none" && exists && (actingWithoutBeat || assessBeat({ beat, ticked, acted, now: judgedAt }).kind === "beating")) {
    const [what, mark] = [["beat", beat], ["tick", ticked], ["ledger write", acted]]
      .filter(([, m]) => m !== null)
      .reduce((a, b) => (b[1].at > a[1].at ? b : a));
    die(`refusing to rotate ${file}: the controller that owns it is still beating or acting — last ${what} ${new Date(mark.at).toISOString()} in ${beatFile}; it counts as stalled after ${new Date(stallsAt({ beat, ticked, acted })).toISOString()}`);
  }
  // Read before anything moves: a ledger whose live tokens cannot be read is
  // refused with nothing moved, never archived with those tokens dropped.
  let carry = { rows: [], dispatched: [], briefs: {}, retired: [], skipped: [] };
  if (prior === "ancestor" && exists) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (e) {
      die(`refusing to rotate ${file}: cannot read it to carry this session's live members forward: ${e.message}`);
    }
    carry = carryOf(text);
  }
  const carrying = carry.rows.length > 0 || carry.dispatched.length > 0 || carry.retired.length > 0;
  // The receipts beside the ledger belong to the run being rotated away, so
  // each takes the archive's own stamp: `phase0.<stamp>.json` and
  // `closeout.<stamp>.json` next to `ledger.<stamp>.md`, and the briefs
  // directory `briefs.<stamp>`, so no brief of that run is found under a
  // name the next run dispatches. A name already taken refuses before
  // anything moves, as the ledger's own does.
  const stamp = archiveStamp();
  const receipts = [[RECEIPT, receiptArchiveName], [CLOSEOUT_RECEIPT, closeoutArchiveName], [BRIEFS, briefsArchiveName]]
    .map(([name, archiveName]) => ({ from: join(dirname(file), name), to: join(dirname(file), archiveName(stamp)) }))
    .filter(({ from }) => existsSync(from));
  for (const { to } of receipts) {
    if (existsSync(to)) die(`refusing to rotate ${file}: ${to} already exists`);
  }
  let archive = null;
  if (exists) {
    archive = join(dirname(file), `${basename(file, ".md")}.${stamp}.md`);
    try {
      linkSync(file, archive);
    } catch (e) {
      die(e.code === "EEXIST" ? `refusing to rotate ${file}: ${archive} already exists` : `cannot rotate ${file} to ${archive}: ${e.message}`);
    }
    // Carrying, the new ledger is renamed over the old file by save(), so the
    // file is never absent while its live tokens exist only in memory: a write
    // that fails leaves the ledger where it was, the archive a second name for
    // the same bytes, and a retry carries from the unmoved file. Carrying
    // nothing, the file has no successor to wait for.
    if (!carrying) {
      try {
        unlinkSync(file);
      } catch (e) {
        die(`archived ${file} as ${archive} but could not remove it: ${e.message} — remove it by hand before the next write`);
      }
    }
  } else {
    console.error(`    nothing to rotate: ${file} does not exist`);
  }
  // After the ledger has moved, and a warning rather than a refusal: the
  // ledger is already archived, and a receipt left where it is is read as a
  // previous run's by the next phase 0, which moves it aside itself.
  for (const { from, to } of receipts) {
    try {
      renameSync(from, to);
      console.error(`    archived ${from} -> ${to}`);
    } catch (e) {
      console.error(`    could not archive ${from} -> ${to}: ${e.message}`);
    }
  }
  // Nothing to carry writes nothing, so the next write starts the skeleton
  // exactly as after any other verdict.
  if (carrying) {
    save({ rows: carry.rows, dispatched: carry.dispatched, briefs: carry.briefs, filed: [], ruled: [], drain: null, retired: carry.retired });
  }
  if (archive !== null) console.error(`    rotated ${file} -> ${archive}`);
  for (const { line, why } of carry.skipped) {
    console.error(`    skipped unparseable line '${line}' — not carried: ${why}`);
  }
  if (carrying) {
    console.error(`    carried ${carry.rows.length} row(s) and ${carry.dispatched.length} ## Dispatched entr${carry.dispatched.length === 1 ? "y" : "ies"} from ${archive}`);
    console.error(`    retired ${carry.retired.length} name(s) from ${archive}`);
  }
  // Re-read rather than reuse the read above: the heartbeat file has other
  // writers, and a patch built from an older view would undo what they wrote
  // since.
  const now = Date.now();
  const record = ours === null ? undefined : { ...ours, prior, at: now };
  if (!writeState(beatFile, NAME, readState(beatFile, NAME), { controller: record, acted: { at: now } })) {
    die(`${archive === null ? "found no ledger" : `rotated ${file} -> ${archive}`} but could not record this run's controller in ${beatFile} — the next run judges whatever record that file still holds, and none if it cannot be read`);
  }
  console.log(JSON.stringify({
    rotated: archive !== null, archive,
    carried: { rows: carry.rows, dispatched: carry.dispatched },
    retired: carry.retired,
    skipped: carry.skipped.map((s) => s.line),
  }));
}

// What an `ancestor` rotate carries out of the archived text, read line by
// line so one bad line costs only itself: the whole point is to keep live
// members' tokens, and a ledger load() refuses (a second drain marker, say)
// still holds them. A row is read the way the tick reads it — a row the tick
// would refuse is skipped rather than carried into a ledger the next tick
// refuses whole — and a `## Dispatched` entry must be a well-formed member
// token. Every skipped line is returned with its reason; a skipped row's
// member can still be carried by its `## Dispatched` entry, which keeps its
// name taken. Of what parses, liveOnLedger() picks what travels: every row
// of a stream that holds a live token, whole, so a carried row's settled
// tokens, `reviewed=` and every other record on it come along, and its
// siblings' with them, and the tick's per-PR reading of the PR is unchanged;
// and the `## Dispatched` entries, settled ones among them, that keep a
// carried member from reading live again. retiredOnLedger() names the rest:
// every member neither travels that a line gives an outcome — a settled one,
// or one whose outcome is outside its family's vocabulary, which skips the
// line but not the name — and every reviewer runner a row launched, read off
// the parsed rows, the skipped ones and every `## Dispatched` entry alike — a
// line the tick refuses still names members this session ran — and the names
// the archive's own `## Retired` lines hold.
function carryOf(text) {
  const skipped = [];
  const skippedRows = [];
  const rows = sectionOf(text, ROWS).filter((r) => {
    try {
      deriveRun({ rows: [r], dispatched: [], drain: null }, []);
      return true;
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      skipped.push({ line: r, why: e.message });
      skippedRows.push(r);
      return false;
    }
  });
  // An entry's `brief=` travels with it: save() writes a brief only beside
  // the token it writes, so a carried member's record still names the brief
  // it was dispatched with and a dropped member's does not.
  const { dispatched: allDispatched, briefs: allBriefs } = dispatchedOf(sectionOf(text, DISPATCHED));
  const dispatched = allDispatched.filter((e) => {
    const t = parseToken(e);
    if (t !== null && t.error === null) return true;
    skipped.push({ line: e, why: t === null ? "not a member token" : `${t.name}: ${t.error}` });
    return false;
  });
  // A `## Retired` line is read through retiredName(), as every reader reads
  // it: one that carries an outcome is skipped — the new ledger holds names
  // bare — but its name retires, and one naming no member or reviewer is
  // skipped and retires nothing.
  const archivedRetired = [];
  for (const line of sectionOf(text, RETIRED)) {
    const name = retiredName(line);
    if (name === null) skipped.push({ line, why: "names no member or reviewer" });
    else {
      if (name !== line) skipped.push({ line, why: `${name} is retired bare` });
      archivedRetired.push(name);
    }
  }
  const live = liveOnLedger(rows, dispatched);
  const carried = { rows: live.rows.map((i) => rows[i]), dispatched: live.dispatched };
  const retired = retiredOnLedger([...rows, ...skippedRows], allDispatched, archivedRetired, carried);
  return { ...carried, briefs: allBriefs, retired, skipped };
}

// ── dispatch / settle ────────────────────────────────────────────────────────
//
// Hoisted beside runCheck() for the same reason: each has several refusals
// ahead of its one write, and the chain above stays the file's spine. Every
// helper below is a function declaration, not a `const`, because the chain
// calls into them before execution ever reaches this line.

// A row's key is its first word, `#<ticket>` — the same lookup `row` rewrites by.
function rowKey(r) {
  return r.split(/\s/)[0];
}

// Whether a row carries the member's token — live only, settled only, or
// either when `live` is not given.
function carries(row, name, live) {
  return memberTokens(row).some((t) => t.name === name && (live === undefined || (t.outcome === null) === live));
}

// The PR's row: the row whose PR is `pr` — ledger-grammar.mjs's rowPr(), the
// reading the tick folds that PR's state by — else one keyed by that PR's own
// number (a PR this run's implementers did not open, or have not settled to
// yet). -1 when there is none yet. Every token about the PR belongs there.
function prRowIndex(pr) {
  const i = data.rows.findIndex((r) => rowPr(r) === pr);
  return i !== -1 ? i : data.rows.findIndex((r) => rowKey(r) === `#${pr}`);
}

// The row a member's token belongs on: an implementer's is its ticket's row; a
// PR-bound member's is its PR's row. -1 when there is none yet. A merge bot
// works no ticket and never has one.
function memberRowIndex(member) {
  if (member.bound === null) return -1;
  if (member.bound === "pr") return prRowIndex(member.number);
  return data.rows.findIndex((r) => rowKey(r) === `#${member.number}`);
}

function unknownMember(name) {
  return `unknown member '${name}' — expected impl-<N>, fix-pr-<M> or finisher-pr-<M> (a -b replacement suffix allowed), or merge-bot-<n>`;
}

// `## Dispatched` gains an entry per dispatch and never loses or reorders one
// (this file's header comment states the invariant `settle` and `nextMergeBot`
// both rely on). The exact-name lookups in runDispatch() and runSettle() below
// used to key off `parseToken(e)?.name`, which reads a token this grammar
// cannot parse the same as "no match" — silently treating a corrupted entry as
// an absent member and letting a dispatch or settle proceed as though nothing
// were there (measured: a malformed row let a duplicate dispatch through).
// Refuse loudly, naming the entry, before either lookup runs.
function refuseMalformedDispatched() {
  const bad = data.dispatched.find((e) => parseToken(e) === null);
  if (bad !== undefined) {
    die(`## Dispatched has an entry '${bad}' this grammar cannot parse — fix the ledger by hand before dispatch or settle can trust it`);
  }
}

// The names `## Retired` holds, for `cmd` (dispatch or review) to refuse a
// repeat from: each line's name read through readRetired(), the grammar's
// one reading of the section, so a line that carries an outcome still holds
// its name. A line naming no member or reviewer would release the name it
// was meant to hold; refuse it, naming it, as refuseMalformedDispatched()
// refuses an entry.
function retiredNames(cmd) {
  const { names, malformed } = readRetired(data.retired);
  if (malformed.length > 0) {
    die(`## Retired has a line '${malformed[0]}' that names no member or reviewer — fix the ledger by hand before ${cmd} can trust it`);
  }
  return names;
}

// Why a finisher on PR `pr` may not be recorded yet, or null when it may.
// `review` is the tick fold's `reviewed` entry for the PR, undefined when the
// PR has no returned review.
function dispositionsRefusal(pr, review) {
  if (review === undefined) return null;
  if (review.fixLive.length > 0) {
    return `${review.fixLive.join(", ")} still live on PR #${pr} — a fix-applier answering review ${review.run} has not settled, `
      + "so no dispositions verdict answers its work yet; settle it, run dispositions-check.mjs for it, then dispatch the finisher again";
  }
  if (review.survived === 0 && review.unverified === 0) return null;
  const v = review.dispositions;
  if (v === null) {
    return `dispositions unchecked — no dispositions-ok=/dispositions-mismatch=/dispositions-escalate=/dispositions-unchecked= token answers PR #${pr}'s latest review, `
      + `${review.run} at ${review.head}; run dispositions-check.mjs --member fix-pr-${pr}[-<x>] --scratch <scratch> for the fix-applier `
      + "that answered that review, then dispatch the finisher again";
  }
  if (v.verdict === "unchecked") {
    return `dispositions unchecked — ${v.member}'s check of review ${review.run} could not read where a deferral was filed (gh unreachable, `
      + "or an issue unreadable — an issue that does not exist is unreadable too, and no re-run answers that one: the check's stderr names "
      + `it, and the record's issue number needs correcting); run dispositions-check.mjs --member ${v.member} --scratch <scratch> again once gh answers, `
      + "then dispatch the finisher again";
  }
  if (v.verdict === "mismatch") {
    return `dispositions mismatch — ${v.member}'s disposition record fails the check against review ${review.run}; `
      + `dispositions-check.mjs --member ${v.member} --scratch <scratch> names each violating entry by bucket, index and rule`;
  }
  if (v.verdict === "escalate") {
    return `dispositions escalate — ${v.member} deferred a finding above suggestion severity because its remedy lies outside the PR's diff, `
      + "or its record drew a second mismatch on this review; either needs a human's ruling: "
      + `review ${review.run} gets no finisher and no retry; dispositions-check.mjs --member ${v.member} `
      + "--scratch <scratch> names each escalated finding or violating entry by bucket and index, for the PR comment that hands it to a human";
  }
  return null;
}

function runDispatch() {
  const usage = "usage: ledger.mjs dispatch <ticket|pr> <member>, or dispatch merge-bot";
  if (rest.length === 0 || rest.length > 2) die(usage);
  const [key, name] = rest.length === 2 ? rest : [null, rest[0]];
  // The id-slot rule `row`/`filed`/`ruled` apply, on whichever slot leads.
  refuseStrayInId(key ?? name, key === null ? "a member name" : "a ticket or PR number");
  // Read ahead of every lookup below that trusts `## Dispatched` by name,
  // including `nextMergeBot()`'s own read of it.
  refuseMalformedDispatched();
  const retired = retiredNames("dispatch");

  // `merge-bot` bare is the merge-bot case of this command: the ledger names
  // the bot, 1 + the highest merge-bot name this session holds — in
  // `## Dispatched`, on a row or in `## Retired` — so the controller never
  // counts. An explicit `merge-bot-<n>` is accepted only when it is that one.
  // `sessionNames` is every name beyond `## Dispatched` the session has used.
  const sessionNames = [...data.rows.flatMap(memberTokens).map((t) => t.name), ...retired];
  const member = parseMember(name === "merge-bot" ? nextMergeBot(data.dispatched, sessionNames) : name);
  if (!member) die(unknownMember(name));
  if (member.bound === null) {
    if (key !== null) die(`merge bots work no ticket or PR — ${usage}`);
    const next = nextMergeBot(data.dispatched, sessionNames);
    if (member.name !== next) die(`${member.name} is not next — the next merge bot this session is ${next}; \`dispatch merge-bot\` names it`);
  } else if (key === null) {
    die(`${member.name} works a ticket or PR — ${usage}`);
  }
  const keyNum = key === null ? null : key.replace(/^#/, "");
  if (keyNum !== null && !isDigits(keyNum)) die(`'${key}' is not a ticket or PR number`);

  // Draining stops supply and nothing else: fix-appliers, finishers and merge
  // bots keep going until the open PRs are merged. Read from
  // the file, so a replacement controller that never saw the drain is held by
  // it all the same.
  if (member.family === "impl" && data.drain !== null) {
    die(`the run is draining (${data.drain}) — no implementer dispatch; drain stops supply`);
  }

  // One token per member for the whole omp session. A settled token on a row
  // counts too — a `row`-written record the ledger never saw dispatched — and
  // so does a name `## Retired` holds: an earlier run of this session ran it,
  // and omp still holds that peer under the name (see runRotate()). The
  // replacement's name is spelled out: one letter past the highest this
  // session has used on the number, wherever that name sits.
  const settledOnRow = data.rows.flatMap(memberTokens).find((t) => t.name === member.name && t.outcome !== null);
  const prior =
    data.dispatched.find((e) => parseToken(e).name === member.name) ??
    (settledOnRow && `${settledOnRow.name}=${settledOnRow.outcome}`) ??
    (retired.includes(member.name) ? "retired by rotate" : undefined);
  if (prior !== undefined) {
    // Never a merge bot: it is accepted only as the number past every name
    // the session holds, so none of the three places above can name it.
    const used = [...data.dispatched.map((e) => parseToken(e).name), ...sessionNames];
    const next = nextRetry(member.name, used);
    die(`${member.name} was already dispatched this session (${prior}) — a replacement takes a name of its own`
      + (next === null ? `, and ${member.name} has no retry letter left` : ` (${next})`));
  }

  // A replacement (`-b`, `-c` …) works the same ticket or PR as its
  // predecessor: two live tokens for one family+number would double-count
  // liveness, since live implementers are the unsettled impl- tokens.
  // Checked across both places a token can be live — `## Dispatched` and a
  // row `row` wrote directly — so the refusal holds regardless of which one
  // last wrote it.
  const liveSibling = [...data.dispatched.map(parseToken), ...data.rows.flatMap(memberTokens)]
    .find((t) => t.family === member.family && t.number === member.number && t.name !== member.name && t.outcome === null);
  if (liveSibling) {
    die(`${liveSibling.name} is still live — \`settle ${liveSibling.name} killed\` (or its real outcome) before dispatching ${member.name}`);
  }

  let i = -1;
  if (member.bound === "ticket") {
    if (Number(keyNum) !== member.number) die(`${member.name} works ticket #${member.number}, not #${keyNum}`);
    i = memberRowIndex(member);
  } else if (member.bound === "pr") {
    if (Number(keyNum) === member.number) {
      i = memberRowIndex(member);
    } else {
      // `<ticket|pr>`: the ticket whose row carries this PR names it as well.
      i = data.rows.findIndex((r) => rowKey(r) === `#${Number(keyNum)}`);
      if (i === -1 || rowPr(data.rows[i]) !== member.number) {
        die(`${member.name} works PR #${member.number}, and row #${keyNum} carries no PR#${member.number}`);
      }
    }
  }

  // The definition the `task` call names, printed so the controller reads it
  // off this output rather than recalling it from prose a compaction drops.
  // An implementer's comes off its row's `tier=`, the same function
  // tier-check.mjs judges it by — so a row that names no single definition,
  // or names one with no file under `agents/` (a well-formed `tier=` whose
  // definition has not shipped: a `task` call naming it cannot resolve), is
  // refused here, before the member is live, not discovered by the check
  // after the call.
  //
  // A fix-applier is `fleet-fix-applier` for every kind of work — review,
  // conflict hold, dispositions retry — so its definition reads nothing off
  // the ledger.
  //
  // The finisher's gates below turn on the tick's own verdict, not a second
  // reading of row `i`: a PR's tokens can be split across its ticket row and
  // its own `#<pr>` row, and a settle can live in `## Dispatched` alone, so
  // one row's text can read held where the tick reads cleared, and the
  // reverse. A ledger the tick refuses is refused here too, before the member
  // is live. `tickFold` reads that fold, `what` naming what could not be read
  // off a refused ledger.
  const tickFold = (what) => {
    try {
      return deriveRun({ rows: data.rows, dispatched: data.dispatched, drain: data.drain }, []);
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      die(`${e.message} — fleet-tick.mjs refuses this ledger, so ${member.name}'s ${what} cannot be read off it; fix it with \`ledger.mjs row\` before dispatching`);
    }
  };

  // A finisher labels its PR `ready-to-merge`, so it is recorded only once
  // the PR sits on no conflict hold a fix-applier has yet to clear — a PR
  // known to conflict cannot merge, and a finisher would race the fix-applier
  // rebasing it — and once its current dispositions verdict is ok — both read
  // off the tick's own per-PR fold, the verdict at the same latest `reviewed=`
  // run the tick reads — and no fix-applier on the PR is still live. A PR
  // whose latest review counts no survived and no unverified finding had
  // nothing for a fix-applier to rule on, and one never reviewed has no
  // review file: neither is gated on a verdict. Refused here, before anything
  // is written, so the check cannot be skipped by forgetting to run it.
  if (member.family === "finisher-pr") {
    const fold = tickFold("conflict hold and dispositions verdict");
    if (fold.conflictHeld.includes(member.number)) {
      die(`${member.name}: PR #${member.number} is on a conflict hold no fix-applier has cleared — dispatch fix-pr-${member.number}[-<x>] `
        + `and let it settle applied:/no-op, then dispatch the finisher again — not dispatching ${member.name}`);
    }
    const review = fold.reviewed.find((r) => r.pr === member.number);
    const refusal = dispositionsRefusal(member.number, review);
    if (refusal !== null) die(`${member.name}: ${refusal} — not dispatching ${member.name}`);
  }
  // Every error caught here carries its own cause and remedy — a row's `tier=`
  // (fix it with `ledger.mjs row`) for an implementer, a family
  // ledger-grammar.mjs has no definition case for otherwise — so this
  // refusal's tail names neither.
  let agent;
  try {
    agent = agentDefinition(member, i === -1 ? "" : data.rows[i]);
    if (member.family === "impl" && !existsSync(join(AGENTS_DIR, `${agent}.agent.md`))) {
      throw new Error(`row #${member.number}'s tier= names ${agent}, which has no agents/${agent}.agent.md — fix the row with \`ledger.mjs row\``);
    }
  } catch (e) {
    die(`${member.name}: ${e.message} — not dispatching ${member.name}`);
  }

  // Last, so every refusal above still names its own cause first, and before
  // anything is written.
  const brief = renderedBrief(member.name, memberRole(member.family));

  let line = null;
  const created = member.bound !== null && i === -1;
  if (created) {
    line = `#${member.number} ${member.name}`;
    data.rows.push(line);
  } else if (i !== -1) {
    // A row `row` already wrote the live token into (SKILL.md's phase 2
    // does) keeps it as it is rather than gaining a second copy.
    const row = data.rows[i];
    line = carries(row, member.name, true) ? row : `${row} · ${member.name}`;
    data.rows[i] = line;
  }
  data.dispatched.push(member.name);
  data.briefs[member.name] = brief.sha256.slice(0, 8);
  save(data);
  console.error(`    dispatched ${member.name}`);
  console.log(JSON.stringify({
    member: member.name, agent, ticket: line === null ? null : rowKey(line), line, created, total: data.dispatched.length, brief,
  }));
}

// The brief `name` is dispatched with, as dispatch-prompt.mjs `render
// --member <name>` left it in the briefs directory beside the ledger: the
// sidecar `<name>.json` must exist, name `role` — the template of the
// member's family — and carry the brief's sha256, and the brief file beside
// it, `<name>.md`, must exist and hash to it. `{path, sha256}` comes back,
// `path` that file, so the controller hands the `task` call its content from
// the path printed. Refused, nothing is written.
function renderedBrief(name, role) {
  const dir = resolve(dirname(file), BRIEFS);
  const sidecar = join(dir, `${name}.json`);
  const render = `run \`dispatch-prompt.mjs render ${role} --member ${name} …\` with the ${role} template's arguments, then dispatch again`;
  let text;
  try {
    text = readFileSync(sidecar, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") die(`no rendered brief for ${name} — ${render} (${sidecar} does not exist)`);
    die(`cannot read ${sidecar}: ${e.message} — not dispatching ${name}`);
  }
  let s;
  try {
    s = JSON.parse(text);
  } catch (e) {
    die(`${sidecar} is not JSON (${e.message}) — ${render}`);
  }
  if (s === null || typeof s !== "object" || Array.isArray(s)) die(`${sidecar} is not a JSON object — ${render}`);
  if (s.role !== role) {
    die(`${sidecar} is a brief for role ${JSON.stringify(s.role ?? null)}, but ${name} is dispatched as ${role} — ${render}`);
  }
  if (typeof s.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(s.sha256)) {
    die(`${sidecar} carries no sha256 of 64 lowercase hex (${JSON.stringify(s.sha256 ?? null)}) — ${render}`);
  }
  const path = join(dir, `${name}.md`);
  let brief;
  try {
    brief = readFileSync(path);
  } catch (e) {
    if (e.code === "ENOENT") die(`no rendered brief for ${name} — ${render} (${path} does not exist)`);
    die(`cannot read ${path}: ${e.message} — not dispatching ${name}`);
  }
  const actual = createHash("sha256").update(brief).digest("hex");
  if (actual !== s.sha256) {
    die(`${path} hashes to ${actual}, but ${sidecar} carries ${s.sha256} — ${render}`);
  }
  return { path, sha256: s.sha256 };
}

// Whether `outcome` is one whose claim a member's report carries and `settle
// --from-report` checks against git or GitHub before writing. Settled with
// the bare form, the claim goes unchecked, so that form says so on stderr.
function reportedOutcome(outcome) {
  return /^(?:PR#|applied:|halted:)|^(?:bailed|no-op|labelled|done)$/.test(outcome);
}

function runSettle() {
  const usage = "usage: ledger.mjs settle <member> <outcome> | settle <member> --from-report [--reports <dir>]";
  // `--reports` names where `--from-report` reads; alone it would land here
  // as an outcome.
  if (rest.includes("--reports")) die(`--reports is read only with --from-report — ${usage}`);
  // `settle impl-<N> PR#<n>`, or the one token it writes — `settle
  // impl-<N>=PR#<n>` — which is how the spec's record-before-tick table
  // spells every settlement.
  if (!(rest.length === 2 || (rest.length === 1 && rest[0].includes("=")))) die(usage);
  refuseStrayInId(rest[0], "a member name");
  const parsed = parseToken(rest.length === 2 ? `${rest[0]}=${rest[1]}` : rest[0]);
  if (!parsed) die(unknownMember(rest[0].split("=")[0]));
  if (parsed.error) die(`${parsed.name}: ${parsed.error}`);
  const { name, outcome } = parsed;
  const token = `${name}=${outcome}`;
  const { i, changed } = settleMember(parsed);
  if (changed) {
    save(data);
    console.error(`    settled ${token}`);
  }
  if (reportedOutcome(outcome)) {
    console.error(`${NAME}: WARNING ${token} settled without --from-report — the member's claim was not checked`);
  }
  console.log(JSON.stringify({
    member: name, outcome, ticket: i === -1 ? null : rowKey(data.rows[i]), line: i === -1 ? null : data.rows[i], changed,
  }));
}

// The settle both forms share: rewrites `parsed`'s live token to
// `<member>=<outcome>` in `data`, saving nothing. `{i, changed}`: `i` the row
// the token sits on (-1 for none), `changed` false when the same outcome was
// already on record and nothing was rewritten. Every refusal is die(), exit 2,
// before anything in `data` changes.
function settleMember(parsed) {
  const { name, outcome } = parsed;
  const token = `${name}=${outcome}`;
  // Same guard as runDispatch(): a `## Dispatched` entry this grammar cannot
  // parse must refuse the lookup below, not read as "not this member" and
  // let settle proceed against a corrupted section.
  refuseMalformedDispatched();

  const di = data.dispatched.findIndex((e) => parseToken(e).name === name);
  const entry = di === -1 ? null : parseToken(data.dispatched[di]);
  const settled = [entry, ...data.rows.flatMap(memberTokens).filter((t) => t.name === name)]
    .filter((t) => t !== null && t.outcome !== null);
  const other = settled.find((t) => t.outcome !== outcome);
  if (other) die(`${name} is already settled as ${other.outcome} — a settled member stays settled; a replacement takes a name of its own`);

  const liveRows = data.rows.flatMap((r, i) => (carries(r, name, true) ? [i] : []));
  const liveEntry = entry !== null && entry.outcome === null;
  if (!liveEntry && liveRows.length === 0) {
    if (settled.length === 0) die(`no live ${name} in the ledger — \`dispatch\` it first`);
    // The same outcome again: already on record, so nothing is written.
    return { i: data.rows.findIndex((r) => carries(r, name)), changed: false };
  }

  // The rows before any write below: the fold's guard reads the row this
  // settle writes to as it stood, and the one-row-per-PR check after the
  // fold compares against them.
  const before = [...data.rows];
  // A live token `row` wrote is settled like one `dispatch` wrote; `##
  // Dispatched` only records what `dispatch` did.
  if (liveEntry) data.dispatched[di] = token;
  for (const i of liveRows) data.rows[i] = data.rows[i].split(/(\s+)/).map((w) => (w === name ? token : w)).join("");
  let i = liveRows[0] ?? -1;
  if (i === -1) {
    // Dispatched, but a later whole-line `row` rewrote the row without its
    // token: put the settled one back, so the row a human reads agrees with
    // `## Dispatched`.
    i = memberRowIndex(parsed);
    if (i !== -1 && !carries(data.rows[i], name)) data.rows[i] = `${data.rows[i]} · ${token}`;
  }
  // The tick owes an open PR a review while its implementer is still
  // live, so a PR-bound member can be dispatched before this settle names the
  // PR here — and memberRowIndex() then finds no row naming it, so
  // runDispatch() keys a row of its own to the PR. Once this row names the PR
  // too, two rows would: the cockpit draws two cards and the tick merges the
  // two rows' tokens in row order, not in the order they were written.
  // Fold that row's tokens onto this one, in order, so later PR-bound writes
  // find the one row through rowPr(). Only
  // an implementer settles to `PR#M` (ledger-grammar.mjs), and only when the
  // settling row named NO PR before this write: `rowPr()` is the tick's
  // reading of a row's PR too, so a row that
  // already named one — this PR via a hand-written `→ PR#M` arrow on a row
  // with no impl token, or a different PR from an earlier attempt's settled
  // token — would let the fold misattribute
  // its content to the wrong PR, or bury the row's own fresher
  // `review=`/`reviewed=` state under the folded row's older one (the tick
  // reads only the LAST). Any row keyed to the PR that no implementer claims
  // as its own is folded, a review-only one included: no token about the PR
  // can sit on this row before it names `PR#M`, so the folded row's tail,
  // appended after this row's tokens, keeps write order. An Exclusion row is
  // never folded: it is keyed to a TICKET number, so one keyed `#M` here is
  // an unrelated ticket's premise on a mistyped PR number, and folding it
  // would delete state a settled member can never restore.
  const prNum = outcome.startsWith("PR#") ? Number(outcome.slice("PR#".length)) : null;
  const j = prNum === null || i === -1 || rowPr(before[i]) !== null ? -1
    : data.rows.findIndex((r) => rowKey(r) === `#${prNum}` && !memberTokens(r).some((t) => t.family === "impl") && premisesOf(r) === null);
  if (j !== -1) {
    const tail = data.rows[j].slice(`#${prNum}`.length).trim();
    if (tail !== "") data.rows[i] = `${data.rows[i]} · ${tail}`;
    data.rows.splice(j, 1);
    if (j < i) i -= 1;
  }
  // A PR has one row, so a settle that makes a PR map to a second row is
  // refused, as `row` refuses one: judged on the folded ledger, so the fold's
  // own row is no split, and added only, so a split already on disk is
  // carried. The refused member settles `=bailed` or to a PR of its own.
  const split = newSplitRow(before, data.rows);
  if (split !== null) die(`settle ${token}: ${splitRowClause(split)}; settle ${name} =bailed or to a PR of its own`);
  return { i, changed: true };
}

// One filing into `## Filed`, unsaved: `{row, alreadyRecorded}`. A repeat
// filing of an issue already on file is a no-op — both callers of `filed`
// retry once on a failure they observed, and an observed failure is not
// proof the write failed (a timeout after the row landed reads as one), and
// `settle --from-report` run twice records the same report twice. Identity
// is the issue number alone, matched NUMERICALLY — so a non-canonical
// spelling (`08`) still dedupes against `8` — as the token between `#` and
// the first whitespace: never `check`'s fuzzy subject matcher, and never a
// prefix test, which would dedupe issue 8 against issue 80. The existing row
// wins, subject and all — a retry reworded is still the same filing.
function recordFiled(id, subject) {
  const existing = data.filed.find((row) => Number(row.match(/^#(\S+)/)?.[1]) === Number(id));
  if (existing !== undefined) return { row: existing, alreadyRecorded: true };
  const row = `#${id} ${subject}`;
  data.filed.push(row);
  return { row, alreadyRecorded: false };
}

// -- settle --from-report -----------------------------------------------------
//
// `settle <member> --from-report [--reports <dir>]`: the member's outcome read
// off the report file it wrote, `<dir>/<member>.json` — `<dir>` by default
// `<scratch>/reports`, `<scratch>` the root scratch-root.mjs prints — rather
// than typed by hand. The file must check against its family's schema
// (report-schema.mjs) and name this member in `member`. The token is derived
// from it, and an outcome that asserts a git or GitHub state has that state
// checked before anything is written:
//
//   impl-N=PR#M               verify-sha.sh <branch> <head> exits 0; PR M
//                             reads OPEN and its closingIssuesReferences name N
//   impl-N=bailed             bailCause is not null; the receipt names it
//   fix-pr-M=applied:<head>   origin's refs/heads/<branch> is <head>
//   fix-pr-M=no-op            origin's refs/heads/<branch> is the head PR M's
//                             latest reviewed= names, as the tick folds it
//   finisher-pr-M=labelled    PR M's labels carry ready-to-merge, and so does
//                             the report's labelsReadBack
//   finisher-pr-M=halted:<c>  cause is in the halted:<cause> vocabulary and
//                             evidence is not empty
//   merge-bot-n=done          every merged[].pr reads MERGED
//
// A `failed` report claims no state, so it settles `=failed` unchecked. A
// fix-applier's `refuted` deferral claims one more thing: that its disposition
// record gives the reversal a reason, which is the text `## Ruled` gets.
//
// Exit 3: a check failed — the member's claim and the world disagree — and
// stderr names each failed check; nothing written. Exit 2: the report is
// absent, unreadable or invalid, a check could not look (a `gh`, `git` or
// verify-sha.sh call that failed, printed what it was not asked for, or never
// finished), or a refusal the bare form makes; nothing written either.
//
// After the settle, in the same write: every `unrecorded` entry goes to `##
// Filed` the way `filed` records one, and for a fix-applier every `deferred`
// entry in the `refuted` bucket goes to `## Ruled` as `#M reversed refutation
// <index>: <reason>`. A line already there is not written again, so a second
// run of the same settle writes nothing. The receipt on stdout is `{member,
// outcome, checks: [{name, ok}], filed, ruled}`, `filed` and `ruled` the
// lines this call added.
//
// The checks run before the write lock is taken, against the ledger as read
// without it, because they are network calls and every other writer waits
// for the lock 10 s at most. The settle itself is judged again under the
// lock, on the ledger reloaded there.

// A failed check: die()'s refusal shape, on stderr with nothing on stdout,
// at exit 3.
function mismatch(msg) {
  try {
    writeAll(2, `\n${NAME}: ${msg}\n`);
  } catch {
    // The message may be lost; the exit code may not.
  }
  process.exit(3);
}

async function runSettleFromReport() {
  const usage = "usage: ledger.mjs settle <member> --from-report [--reports <dir>]";
  const verifySha = join(dirname(fileURLToPath(import.meta.url)), "verify-sha.sh");
  const ready = "ready-to-merge";
  // The bound on each child a check runs: generous, because verify-sha.sh
  // fetches, and still a bound, because the child may never answer at all.
  const checkTimeoutMs = 60_000;
  let member;
  let reports = null;
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k];
    if (a === "--from-report") continue;
    if (a === "--reports") {
      const v = rest[++k];
      if (isFlagLike(v)) die(`--reports needs a directory — ${usage}`);
      if (reports !== null) die(`--reports given twice — ${usage}`);
      reports = v;
    } else if (a.startsWith("-")) {
      die(`unknown flag '${a}' — ${usage}`);
    } else if (member === undefined) {
      member = a;
    } else {
      die(usage);
    }
  }
  if (member === undefined) die(usage);
  if (member.includes("=")) die(`settle --from-report takes a member name, not '${member}': the outcome is the report's — ${usage}`);
  const live = parseToken(member);
  if (!live) die(unknownMember(member));
  const where = `settle ${member} --from-report`;

  if (reports === null) {
    try {
      reports = reportsDir(defaultScratch());
    } catch (e) {
      if (!(e instanceof FleetDirUnresolvable)) throw e;
      die(`${where}: no --reports, and the scratch root could not be resolved — ${e.message}`);
    }
  }
  const read = readReportIn(reports, member);
  if (read.state === "absent") die(`${where}: no report at ${read.path}; nothing written`);
  if (read.state === "invalid") die(`${where}: ${read.path} is not a ${reportFamily(member)} report — ${read.violation}; nothing written`);
  const report = read.report;
  const invalid = (violation) => die(`${where}: ${read.path} is not a ${reportFamily(member)} report — ${violation}; nothing written`);
  if (report.member !== member) invalid(`$.member: ${JSON.stringify(report.member)} is not ${member}`);

  // Every child runs from the ledger's repository with runCheck()'s
  // environment, for runCheck()'s reasons: GH_REPO would point gh at another
  // tracker whatever the cwd, and GIT_DIR/GIT_WORK_TREE git at another repo.
  const env = { ...process.env, GH_REPO: "" };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  let repo = null;
  const repoDir = () => {
    if (repo !== null) return repo;
    let dir = dirname(resolve(file));
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    const r = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", env, timeout: GIT_TIMEOUT_MS });
    if (r.status !== 0) {
      const why = cause(r.error && r.error.message, r.stderr);
      die(`${where}: could not look — cannot resolve the ledger's repository (${dir})${why ? `: ${why}` : ""}; nothing written`);
    }
    repo = r.stdout.trim();
    return repo;
  };
  // A child that must answer with one of `answers`; anything else — another
  // status, a spawn failure, a timeout — could not look.
  const look = (what, cmd, args, answers = [0]) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", cwd: repoDir(), env, timeout: checkTimeoutMs, stdio: ["ignore", "pipe", "pipe"] });
    if (r.status === null || !answers.includes(r.status)) {
      const why = cause(r.error && r.error.message, r.stderr);
      die(`${where}: could not look — ${what}${r.status === null ? "" : ` exited ${r.status}`}${why ? `: ${why}` : ""}; nothing written`);
    }
    return r;
  };
  // A `gh pr view --json <fields>` answer: an object whose every requested
  // field has the type that field has. Anything else was not what was asked
  // for, so it could not look.
  const prFieldOk = { state: (v) => typeof v === "string", labels: Array.isArray, closingIssuesReferences: Array.isArray };
  const prView = (pr, fields) => {
    const what = `gh pr view ${pr} --json ${fields}`;
    const r = look(what, "gh", ["pr", "view", String(pr), "--json", fields]);
    let v = null;
    try {
      v = JSON.parse(r.stdout);
    } catch {
      // Falls through to the refusal below.
    }
    if (v === null || typeof v !== "object") {
      die(`${where}: could not look — ${what} printed no JSON object: ${cause(r.stdout)}; nothing written`);
    }
    const missing = fields.split(",").filter((f) => !prFieldOk[f](v[f]));
    if (missing.length > 0) {
      die(`${where}: could not look — ${what} answered without a usable ${missing.join(", ")}: ${cause(r.stdout)}; nothing written`);
    }
    return v;
  };
  // origin's head of `branch`, or null when origin has no such branch.
  const remoteHead = (branch) => {
    const ref = `refs/heads/${branch}`;
    const r = look(`git ls-remote origin ${ref}`, "git", ["ls-remote", "origin", ref]);
    const line = r.stdout.split("\n").find((l) => l.endsWith(`\t${ref}`));
    return line === undefined ? null : line.split("\t")[0];
  };

  const checks = [];
  const check = (name, ok) => {
    checks.push({ name, ok });
    return ok;
  };
  const ruledLines = [];
  let outcome;
  if (live.family === "impl") {
    if (report.outcome === "pr") {
      if (report.pr === null || report.pr < 1) invalid(`$.pr: ${JSON.stringify(report.pr)} is not a PR number, with outcome "pr"`);
      if (report.head === null) invalid('$.head: null, with outcome "pr"');
      outcome = `PR#${report.pr}`;
      const sha = look(`verify-sha.sh ${report.branch} ${report.head}`, "sh", [verifySha, report.branch, report.head], [0, 1]);
      check(`verify-sha.sh ${report.branch} ${report.head} exits 0`, sha.status === 0);
      const pr = prView(report.pr, "state,closingIssuesReferences");
      check(`PR #${report.pr} reads OPEN`, pr.state === "OPEN");
      check(`PR #${report.pr} closes #${live.number}`, pr.closingIssuesReferences.some((c) => c?.number === live.number));
    } else {
      outcome = "bailed";
      check(`bailCause: ${report.bailCause}`, report.bailCause !== null);
    }
  } else if (live.family === "fix-pr") {
    if (report.outcome === "applied") {
      outcome = `applied:${report.head}`;
      const head = remoteHead(report.branch);
      check(`origin refs/heads/${report.branch} is ${report.head}`, head === report.head);
    } else if (report.outcome === "no-op") {
      outcome = "no-op";
      let fold;
      try {
        fold = deriveRun({ rows: data.rows, dispatched: data.dispatched, drain: data.drain }, []);
      } catch (e) {
        if (!(e instanceof LedgerError)) throw e;
        die(`${where}: ${e.message} — fleet-tick.mjs refuses this ledger, so PR #${live.number}'s latest reviewed= cannot be read off it; nothing written`);
      }
      const reviewed = fold.reviewed.find((r) => r.pr === live.number)?.head ?? null;
      if (reviewed === null) {
        check(`PR #${live.number}'s row names a reviewed= head`, false);
      } else {
        const head = remoteHead(report.branch);
        check(`origin refs/heads/${report.branch} is ${reviewed}, the head PR #${live.number}'s latest reviewed= names`,
          head !== null && head.toLowerCase().startsWith(reviewed.toLowerCase()));
      }
    } else {
      outcome = "failed";
    }
    const refuted = report.deferred.filter((d) => d.bucket === "refuted");
    if (refuted.length > 0) {
      const path = report.dispositionsRecord;
      let record;
      try {
        record = JSON.parse(readFileSync(path, "utf8"));
      } catch (e) {
        die(`${where}: could not look — the disposition record ${path} could not be read as JSON: ${e.code ?? e.message}; nothing written`);
      }
      const entries = Array.isArray(record?.entries) ? record.entries : [];
      for (const d of refuted) {
        const entry = entries.find((e) => e?.bucket === "refuted" && e?.index === d.index);
        const reason = typeof entry?.reason === "string" ? entry.reason.trim() : "";
        if (check(`${path} gives refuted[${d.index}] a reason`, reason !== "")) {
          ruledLines.push(`#${live.number} reversed refutation ${d.index}: ${reason}`);
        }
      }
    }
  } else if (live.family === "finisher-pr") {
    if (report.outcome === "labelled") {
      outcome = "labelled";
      const pr = prView(live.number, "labels");
      check(`PR #${live.number} carries ${ready}`, pr.labels.some((l) => l?.name === ready));
      check(`labelsReadBack carries ${ready}`, report.labelsReadBack.includes(ready));
    } else if (report.outcome === "halted") {
      outcome = `halted:${report.cause}`;
      check(`cause ${report.cause} is in the halted:<cause> vocabulary`, HALT_CAUSES.includes(report.cause));
      check("evidence is not empty", (report.evidence ?? "").trim() !== "");
    } else {
      outcome = "failed";
    }
  } else {
    outcome = "done";
    for (const { pr } of report.merged) check(`PR #${pr} reads MERGED`, prView(pr, "state").state === "MERGED");
  }

  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    mismatch(`${where}: the report's claim and the world disagree — ${failed.map((c) => `failed: ${c.name}`).join("; ")}; nothing written`);
  }
  const parsed = parseToken(`${member}=${outcome}`);
  if (parsed.error) invalid(`${parsed.name}: ${parsed.error}`);

  await acquireLock();
  data = load();
  const { changed } = settleMember(parsed);
  const filed = [];
  for (const { issue, subject } of report.unrecorded ?? []) {
    const { row, alreadyRecorded } = recordFiled(String(issue), subject);
    if (!alreadyRecorded) filed.push(row);
  }
  const ruled = [];
  for (const line of ruledLines) {
    if (data.ruled.includes(line)) continue;
    data.ruled.push(line);
    ruled.push(line);
  }
  if (changed || filed.length > 0 || ruled.length > 0) save(data);
  if (changed) console.error(`    settled ${member}=${outcome}`);
  console.log(JSON.stringify({ member, outcome, checks, filed, ruled }));
}

// A ticket or PR number argument as a number: a leading `#` is allowed, a
// stray flag or anything but digits refused, saying `what` was expected.
function numberArg(arg, what, usage) {
  refuseStrayInId(arg, what);
  const digits = arg.replace(/^#/, "");
  if (!isDigits(digits)) die(`'${arg}' is not ${what} — ${usage}`);
  return Number(digits);
}

// `review <pr> <token>…`: the only writer of a PR's `review=`/`reviewed=`
// tokens. Each lands on the PR's row — the ticket row once `settle
// impl-<N>=PR#M` has run, else `#M`, created when neither exists — so the
// row's token order is write order, the order the tick folds the PR's review
// record in. `review=X=failed` for a launch the row holds open as `review=X`
// rewrites that token in place; every other token is appended as ` · <token>`.
// The whole ledger before and after is judged by rowWriteRefusal() under the
// lock, and a refusal writes nothing. The receipt's `next` is the runner name
// the PR's next launch takes as the ledger stands after the write, null with
// every letter taken.
function runReview() {
  const usage = "usage: ledger.mjs review <pr> <review=…|reviewed=…>…";
  const [pr, ...parts] = rest;
  if (!pr || parts.length === 0) die(usage);
  const prNum = numberArg(pr, "a PR number", usage);
  const tokens = parts.join(" ").split(/\s+/).filter(Boolean);
  const other = tokens.find((tok) => !isReviewToken(tok));
  if (other !== undefined) {
    die(`review #${prNum}: '${other}' is not a review token — review writes only review=… and reviewed=…; every other token goes through row, dispatch or settle`);
  }
  const retired = retiredNames("review");
  const i = prRowIndex(prNum);
  const created = i === -1;
  const oldLine = created ? null : data.rows[i];
  const words = created ? [`#${prNum}`] : oldLine.split(/(\s+)/);
  const appended = [];
  for (const tok of tokens) {
    const open = tok.endsWith("=failed") ? words.lastIndexOf(tok.slice(0, -"=failed".length)) : -1;
    if (open > 0) words[open] = tok;
    else appended.push(tok);
  }
  const head = words.join("");
  const line = appended.length === 0 ? head
    : created ? `${head} ${appended.join(" · ")}`
    : `${head} · ${appended.join(" · ")}`;
  const after = created ? [...data.rows, line] : data.rows.with(i, line);
  const refusal = rowWriteRefusal(data.rows, after, oldLine, line, retired);
  if (refusal !== null) die(`review #${prNum}: ${refusal}`);
  data.rows = after;
  save(data);
  const key = rowKey(line);
  console.error(`    review on row ${key}`);
  console.log(JSON.stringify({ pr: prNum, row: key, line, created, next: nextReviewerName(data.rows, prNum, retired) }));
}

// A row's tokens: its words after the key, bar the ` · ` separators between
// them.
function rowTokens(text) {
  return text.split(/\s+/).filter((w) => w !== "" && w !== "·").slice(1);
}

// Every token `oldRow` had that `line` lacks, duplicates counted, in the old
// row's order: what a `row` rewrite lost.
function droppedTokens(oldRow, line) {
  return added(rowTokens(line), rowTokens(oldRow));
}

// The first of `words` that is a `label-off=` naming no finisher-pr member
// this run has, else undefined. Known means in `## Dispatched` or among a
// row's member tokens as they stand before this write, the two places
// dispatch's live-sibling check reads: a token `row` or `token` wrote never
// enters `## Dispatched`, and the line being written vouches for nothing.
// Local only — never `gh`.
function badLabelOff(words) {
  const known = new Set([...data.dispatched.map(parseToken), ...data.rows.flatMap(memberTokens)]
    .filter((t) => t && t.family === "finisher-pr").map((t) => t.name));
  return words.find((tok) => {
    const m = labelOffMember(tok);
    return m === null || (m !== undefined && !known.has(m.name));
  });
}

// Why `token` may not write `tok` onto a row whose text is `rowText` (the row
// as it stands plus the call's earlier tokens), or null when it may. A token
// is one word: an empty argument, one with a space in it (prose, which would
// split into words the row's own words then dedupe against), and the row's
// ` · ` separator are no token. A member token is `dispatch`'s or `settle`'s,
// a review token `review`'s. A word shaped like a member that the grammar
// cannot parse, a `tier=` that is not a cell, a `tier=` naming a second tier
// on a row that already has one, a `held-behind` or `conflict-hold` token the
// tick cannot read, and a lone `→` — an arrow with no PR beside it points at
// nothing — are refused. Every other word is a freeform token.
function tokenRefusal(tok, rowText) {
  if (tok === "" || /\s/.test(tok)) {
    return "is not one token — pass each token as its own argument, with no space in it";
  }
  if (tok === "·") return "is the row's ` · ` separator, which `token` writes between tokens itself";
  if (parseToken(tok) !== null) {
    return "is a member token — members are written only with `ledger.mjs dispatch` and `ledger.mjs settle`";
  }
  if (isReviewToken(tok)) {
    return "is a review token — review tokens are written only with `ledger.mjs review <pr> <token>…`, which puts them on the PR's row";
  }
  const name = tok.split("=")[0];
  if (MEMBER_FAMILIES.some((family) => name.startsWith(`${family}-`))) {
    return "is shaped like a member token this grammar cannot parse — a member is impl-<N>, fix-pr-<M>, finisher-pr-<M> or merge-bot-<n>, a retry suffix allowed";
  }
  for (const [prefix, shape] of [["held-behind", HELD], ["conflict-hold", CONFLICT_HOLD]]) {
    if (tok.startsWith(prefix) && !shape.test(tok)) {
      return `is not ${prefix}:#<M> — the tick reads only ${prefix}:#<number> and would ignore this one`;
    }
  }
  const [tier] = tierValues(tok);
  if (tier !== undefined) {
    if (!CELL.test(tier)) return "is not tier=<cell> — a cell is <slow|task|smol>-<level>";
    const other = tierValues(rowText).find((v) => v !== tier);
    if (other !== undefined) {
      return `names a second tier — the row already carries tier=${other}, and a row names one; replacing it takes ledger.mjs row, which rewrites the whole line`;
    }
  }
  if (tok === "→") return "is the row's arrow, which is written with the PR it points at — ledger.mjs row writes the whole line";
  if (badLabelOff([tok]) !== undefined) return LABEL_OFF_UNKNOWN;
  return null;
}

// `token <ticket|pr> <token>…`: appends each token to the row the key maps to
// — the PR's row for a PR key, the ticket row once `settle impl-<N>=PR#M` has
// run, else `#M`, created when neither exists: `review`'s lookup — keeping
// every token already there, in order, as ` · <token>`. A token the row
// already carries is a no-op. Every refusal is judged before anything is
// written, whole call alike, under the lock.
function runToken() {
  const usage = "usage: ledger.mjs token <ticket|pr> <token>…";
  const [keyArg, ...tokens] = rest;
  if (!keyArg || tokens.length === 0) die(usage);
  const num = numberArg(keyArg, "a ticket or PR number", usage);
  const i = prRowIndex(num);
  const created = i === -1;
  const oldLine = created ? null : data.rows[i];
  let carried = oldLine ?? "";
  for (const tok of tokens) {
    const why = tokenRefusal(tok, carried);
    if (why !== null) die(`token #${num}: '${tok}' ${why}`);
    carried += ` ${tok}`;
  }
  const key = created ? `#${num}` : rowKey(oldLine);
  const have = new Set(created ? [] : rowTokens(oldLine));
  const appended = [];
  for (const tok of tokens) {
    if (have.has(tok)) {
      console.error(`    already present on row ${key}: ${tok}`);
    } else {
      have.add(tok);
      appended.push(tok);
    }
  }
  if (appended.length === 0) {
    console.log(JSON.stringify({ key, line: oldLine, added: appended }));
    return;
  }
  const line = created ? `${key} ${appended.join(" · ")}` : `${oldLine} · ${appended.join(" · ")}`;
  const after = created ? [...data.rows, line] : data.rows.with(i, line);
  // A freeform token can still move the PR a row maps to (a `PR#<n>` mention
  // on a row with no implementer), or split one PR across two rows.
  const split = newSplitRow(data.rows, after);
  if (split !== null) die(`token ${key}: ${splitRowClause(split)}`);
  // The names only: `token` adds no launch of its own, but a `PR#<n>` mention
  // can move a row that already holds one onto another PR, and that launch is
  // then judged against the retired names. A malformed `## Retired` line is
  // left to the readers that refuse it.
  const refusal = rowWriteRefusal(data.rows, after, oldLine, line, readRetired(data.retired).names);
  if (refusal !== null) die(`token ${key}: ${refusal}`);
  data.rows = after;
  save(data);
  console.error(`    appended ${appended.join(" ")} to row ${key}`);
  console.log(JSON.stringify({ key, line, added: appended }));
}
