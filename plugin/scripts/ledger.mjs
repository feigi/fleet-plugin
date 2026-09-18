#!/usr/bin/env node
// The run ledger. A controller's context is the least durable thing in a fleet
// run: it compacts, and a controller that has lost the pool or the dispatch map
// redoes finished work. Two duplicate tickets shipped in one run from exactly
// that.
//
// Rows are rewritten in place, one per ticket. `filed` and `ruled` are
// append-only, because their whole purpose is to outlive the reasoning that
// produced them.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { makeDie, isFlagLike, hasEqualsForm, isDigits } from "./arg.mjs";

const NAME = "ledger";

// die() shared with the other fleet scripts (writeSync-based, pipe-safe —
// see arg.mjs for the #176/#328/#363 rationale). arg()/has() themselves are
// NOT shared here: this file splices its flags out of argv and refuses in its
// own wording (#362), where arg() refuses under a message generated from the
// flag name.
//
// Their RULES are shared, which is a different thing (#567). isFlagLike() and
// hasEqualsForm() are arg.mjs's refusal rules as exported predicates; the
// three guards below call them and supply their own die() text. This file
// used to restate the expressions instead, and nothing failed when a
// restatement drifted from the original — shared-refusal.test.mjs is what
// fails now, and it reds even on a re-inlined copy that changes no behaviour
// at all, which is the only kind a behavioural test cannot see.
const die = makeDie(NAME);

// The cause of a failed child process, for `check`'s repository probe and its
// tracker query — each captures the child's stderr instead of forwarding it, so
// what the child printed reaches no terminal and this string is the only copy
// of it (#638).
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
// Both git probes ran UNBOUNDED before #1199, while the `gh` query between
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
// ledger, which is the #155 worktree fail-open, and only warns. It also stays
// under the `gh` bound beside it, so the tracker query remains the dominant
// term in `check`'s worst case and that contract does not move.
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
  const seconds = isDigits(String(override ?? "")) ? Number(override) : 0;
  return (seconds > 0 && seconds < defaultSeconds ? seconds : defaultSeconds) * 1000;
}
const GIT_TIMEOUT_MS = gitBudget(10, process.env.LEDGER_GIT_TIMEOUT);

// There is ONE ledger per run, and it lives in the main checkout. Members run
// from their own worktrees, where a cwd-relative `.fleet/ledger.md` does not
// exist — `check` then warns and reports every subject as safe to file, which
// is precisely the duplicate-filing guard failing open. Resolve against the
// git COMMON dir (shared by every worktree) rather than the cwd.
function defaultLedgerPath() {
  const r = spawnSync("git", ["rev-parse", "--git-common-dir"], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  if (r.status !== 0 || !r.stdout.trim()) {
    // Could not resolve the shared git dir → fall back to a cwd-relative path.
    // That re-opens the worktree fail-open this resolution exists to close (a
    // member reads a cwd-local ledger, not the run's), so say so rather than
    // degrading the duplicate-filing guard in silence.
    console.error(`${NAME}: WARNING could not resolve --git-common-dir; using cwd-relative .fleet/ledger.md (duplicate-filing guard may be degraded)`);
    return ".fleet/ledger.md";
  }
  return join(dirname(resolve(r.stdout.trim())), ".fleet", "ledger.md");
}

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
// has(), in this reader's own wording (#362) — and since #567 that parity is
// the shared hasEqualsForm() predicate itself rather than a claim about two
// expressions that were free to drift apart.
if (hasEqualsForm("file", argv)) die("--file needs a space-separated value, not --file=");
if (hasEqualsForm("require-file", argv)) die("--require-file is a boolean flag, not --require-file=");
const fileIdx = argv.indexOf("--file");
const file = fileIdx === -1 ? defaultLedgerPath() : argv[fileIdx + 1];
// #362: `--file` took whatever token followed it, so `--file --require-file`
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
// forfeits, no more and no less — the set of them being whatever `grep -l
// '^const arg = makeArg' scripts/*.mjs` reports. Anchored on the
// binding, because the unanchored `grep -l makeArg` matched this comment and
// so listed ledger.mjs, the one script this paragraph says does NOT route
// through arg(). A single leading `-`, or a `--` anywhere but the front, is
// still a path.
//
// The `file &&` term is load-bearing and must not fold into isFlagLike(),
// which answers TRUE for an absent value: without it a truly trailing `--file`
// would land on this clause's wording instead of the pre-existing "given with
// no path" one below, which is the behaviour #362's own Measured block records
// as already correct and which ledger.test.mjs pins.
if (fileIdx !== -1 && file && isFlagLike(file)) die("--file needs a path");
if (fileIdx !== -1) argv.splice(fileIdx, 2);
if (!file) die("--file given with no path");
const requireFileIdx = argv.indexOf("--require-file");
const requireFile = requireFileIdx !== -1;
if (requireFileIdx !== -1) argv.splice(requireFileIdx, 1);

const [cmd, ...rest] = argv;
if (!cmd) die("usage: ledger.mjs [--file <path>] [--require-file] row|filed|ruled|check|read [args]");

const ROWS = "## Rows";
const FILED = "## Filed";
const RULED = "## Ruled";

// What a section header looks like on disk, defined once because a second
// copy drifts: the parser slices sections with it, and the readability flag
// below is set from it. Anchored to a real line start (or string start), not
// a bare substring search — otherwise an escaped entry that merely CONTAINS
// the text "## Filed" (never a physical line, just a run of characters inside
// a one-line entry) is found by indexOf() before the genuine header and the
// whole section is sliced from the wrong offset.
const headerRe = (name) => new RegExp(`(^|\\n)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\n|$)`);

// One entry is always exactly one physical line on disk. Escape backslash
// first, then newline, so a `\` in entry text can never be mistaken for the
// start of an escape sequence introduced by this encoding. Without this, an
// entry containing a real newline — or a line that happens to look like
// `## Filed` or `- #999 ...` — gets misparsed on reload: real records
// silently drop, or phantom ones get injected.
function escapeText(s) {
  return s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");
}
function unescapeText(s) {
  return s.replace(/\\(\\|n)/g, (_, c) => (c === "n" ? "\n" : "\\"));
}

// #584: a `--`-prefixed token in `check`'s free-text tail used to fold
// straight into the duplicate-filing subject, so a misspelled flag searched
// for a DIFFERENT subject and read "safe to file" where the correct spelling
// answers ALREADY FILED at exit 1. A `--` token can legitimately BE that data
// (arg.mjs's makeSweep() comment names why sweep() stays out of this file),
// so what separates a stray flag from data is length: `check`'s documented
// calling convention hands the subject as ONE argument, so an unquoted stray
// reveals itself by making the tail longer than that one argument allows.
// `check --requre-file "widget guard missing"` is a two-element tail; `check
// "--require-file silently absent when value missing"` is one. A one-element
// tail is accepted unchanged, whatever it starts with; a multi-element tail
// carrying a `--`-prefixed element is refused by name. Structural, not a
// distance threshold.
//
// `check`'s tail ALONE — narrower than #584's first pass, which called this
// from `filed`, `row` and `ruled` too. The length rule is only sound where
// the documented convention IS one quoted argument, and `check` is the only
// subcommand where it is: both places that instruct a caller to run it spell
// it `ledger.mjs check "<subject>"` (run-team/SKILL.md's finisher step,
// review-and-fix.md's filing step), while run-team/SKILL.md's ledger section
// spells the other three `filed <issue> <subject>`, `row <ticket> <text>` and
// `ruled <pr> <decision>` — a bare multi-word tail, as did this file's own
// usage strings for them. Applied there, the rule refused what the docs
// prescribe: measured on the tree ahead of this narrowing, `filed 999 the
// --basee flag is unread`, `row 42 the --basee flag is unread` and `ruled 77
// the --basee flag is unread` each exited 2, where the tree before #584
// (07dc927) answered all three at exit 0. #1161 ruled the guard back to
// `check` rather than respelling three conventions SKILL.md carries, two
// other tickets holding that file open.
//
// Narrowing it does not keep #584's signature whole on those three: only the
// ID-slot vector survives — a stray flag one token to the LEFT is still
// refused by refuseStrayInId() below. The tail-slot vector does not: a
// stray `--` word inside filed/row/ruled's tail is now accepted as data (no
// rule can tell it apart from the subject a caller typed), so `filed 999
// --typo-flag some new subject` exits 0 and writes a row a later `check
// "some new subject"` cannot exact-match — a near-miss at best, the same
// wrong-subject shape #584 closed, reopened here on the tail. That is the
// cost of taking the ticket's option 2 (narrow the guard rather than
// requote the docs, #1161) instead of option 1; it is why it is the
// DOCUMENTED convention, not the hazard, that decides where the length rule
// may be read at all.
//
// The cost `check` keeps is real and is what #365's AC prices, so it is
// stated rather than denied: a legitimate subject carrying a `--` word
// anywhere, given unquoted, was accepted before this guard and is refused by
// it — `check the --basee flag is unread` answered at exit 0 before and exits
// 2 now. Quoting the subject accepts it unchanged. The trade the ticket ruled
// for is that this refusal is loud and recoverable where the wrong-subject
// answer it replaces was silent. One residual of that trade is not this
// file's to close: SKILL.md's ledger section spells `check <subject>`
// unquoted inside the same entry that spells `filed <issue> <subject>`, where
// the two instructions that tell a caller to RUN it quote the subject.
//
// Narrowed on `check` too, not closed: a lone stray with no subject beside it
// is a one-element tail, so it is still taken as the subject and answered at
// exit 0. Harmless because it then searches for a string nothing matches, and
// ledger.test.mjs's degenerate-subject case pins it so it stays deliberate.
function refuseStrayInCheckTail(tail) {
  if (tail.length <= 1) return;
  const stray = tail.find((a) => a.startsWith("--"));
  if (stray) die(`unknown flag ${stray} in subject — quote the subject as one argument`);
}

// The id slot ahead of `filed`/`row`/`ruled`'s tail is a hazard of its own,
// and the only one of the three a rule can act on. refuseStrayInCheckTail()
// above is not read on those subcommands at all (#1161), and would not
// catch this shape if it were: a stray flag one token earlier lands in
// `issue`/`ticket`/`pr`, and the tail left behind carries no `--` element to
// find. Nor could that helper be read over the whole of `rest` instead —
// that refuses `filed <issue> "--flag-like subject"` too, a two-element
// tail with a `--` element, pinned here as must-keep-working. An id is
// never legitimately `--`-prefixed, so this slot takes the bare prefix
// test a free-text tail cannot have.
function refuseStrayInId(value, what) {
  if (value.startsWith("--")) die(`unknown flag ${value} — expected ${what}`);
}

// Set by load(), the only function that reads the file, so `ledger.ok` can
// report what the parse saw rather than what a later stat() guesses (#231).
let ledgerParsed = false;

function load() {
  if (!existsSync(file)) return { rows: [], filed: [], ruled: [] };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    die(`cannot read ${file}: ${e.message}`);
  }
  const section = (name) => {
    const m = headerRe(name).exec(text);
    if (!m) return [];
    const start = m.index + m[1].length + name.length;
    const after = text.slice(start);
    const end = after.search(/\n## /);
    return (end === -1 ? after : after.slice(0, end))
      .split("\n").map((l) => l.trim()).filter((l) => l.startsWith("- "))
      .map((l) => unescapeText(l.slice(2)));
  };
  // Set here, past the read and the early return, so it can only be true of a
  // file this function actually opened and recognised as a ledger.
  ledgerParsed = headerRe(FILED).test(text);
  return { rows: section(ROWS), filed: section(FILED), ruled: section(RULED) };
}

function save(d) {
  const out =
    `# Fleet run ledger\n\n${ROWS}\n\n` + d.rows.map((r) => `- ${escapeText(r)}`).join("\n") +
    `\n\n${FILED}\n\n` + d.filed.map((r) => `- ${escapeText(r)}`).join("\n") +
    `\n\n${RULED}\n\n` + d.ruled.map((r) => `- ${escapeText(r)}`).join("\n") + "\n";
  try {
    mkdirSync(dirname(file), { recursive: true });
    // Write to a sibling temp file and rename over the target. rename is
    // atomic on a POSIX filesystem — a crash mid-write leaves the temp file
    // corrupt but never truncates the durability file itself.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, out);
    renameSync(tmp, file);
  } catch (e) {
    die(`cannot write ${file}: ${e.message}`);
  }
  console.error(`    wrote ${file}`);
}

// Read ahead of the dispatch, not inside one branch of it. This guard used to
// live in runCheck(), so `check` refused a missing ledger under the flag and
// the other four subcommands ignored it entirely: `read --require-file` on an
// absent file printed the empty payload at exit 0, byte-identical to a real
// empty ledger on both streams, and `row --require-file` CREATED the very file
// whose absence the flag exists to refuse (#816). One flag read in one place is
// also what docs/specs/2026-07-23-fleet-plugin-design.md's `ledger.mjs` row
// already documents
// — "Exit 2 on any subcommand — ... `--require-file` with no ledger file" — so
// the implementation is what had drifted, not the contract.
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
// a usage error. Deliberate/accepted, not reordered — the doc line above
// bundles both under one undifferentiated exit 2, with no ordering between them.
if (requireFile && !existsSync(file)) die(`--require-file given but ledger file does not exist: ${file}`);

const data = load();

// The payload subcommands end by falling out of this chain, never by calling
// process.exit(). On a pipe, process.stdout.write is async and process.exit()
// discards whatever is still queued, so a payload past the buffer arrives cut
// — at exit 0, which types a corrupt read as a successful one (#246).
// candidates.mjs states the same reason at its own exit line; this was the
// second script on that shape. The consumer that made it visible is board.mjs,
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
// now (runCheck, below the chain), and a `return` is what skips them (#808).
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
  const i = data.rows.findIndex((r) => r.split(/\s/)[0] === key);
  const created = i === -1;
  if (created) {
    data.rows.push(line);
  } else {
    data.rows[i] = line;
  }
  // Logged only after save() returns — a failed write must not claim a row
  // was recorded when it never made it to disk.
  save(data);
  console.error(created ? `    new row ${key}` : `    rewrote row ${key}`);
  console.log(JSON.stringify({ ticket: key, line, created }));
} else if (cmd === "filed") {
  const [issue, ...subjectParts] = rest;
  if (!issue || subjectParts.length === 0) die("usage: ledger.mjs filed <issue> <subject>");
  // This slot is where #584's own signature reaches `filed`, and the only
  // place on this subcommand a rule can meet it: a stray flag here shifts the
  // issue number into the subject, and the row it writes no longer answers the
  // subject a later `check` asks about — that check reports not-filed at exit
  // 0 where the correctly-spelled filing makes it report already-filed at
  // exit 1. The tail behind this slot is documented unquoted and so takes no
  // length rule (#1161); the id is not, and takes this one.
  refuseStrayInId(issue, "an issue number");
  const subject = subjectParts.join(" ");
  data.filed.push(`#${issue.replace(/^#/, "")} ${subject}`);
  save(data);
  console.log(JSON.stringify({ issue, subject, total: data.filed.length }));
} else if (cmd === "ruled") {
  const [pr, ...decisionParts] = rest;
  if (!pr || decisionParts.length === 0) die("usage: ledger.mjs ruled <pr> <decision>");
  // Nothing reads this section back — save() is its only consumer — so the
  // harm here is the narrowest of the three: a permanently wrong decision
  // record in an append-only file, with no verdict riding on it. The id slot
  // is guarded anyway because the shape is identical and the record is the
  // point.
  refuseStrayInId(pr, "a PR number");
  const decision = decisionParts.join(" ");
  data.ruled.push(`#${pr.replace(/^#/, "")} ${decision}`);
  save(data);
  console.log(JSON.stringify({ pr, decision, total: data.ruled.length }));
} else if (cmd === "check") {
  runCheck();
} else {
  die(`unknown subcommand '${cmd}' — expected row, filed, ruled, check or read`);
}

// `check` alone of the subcommands leaves its arm early: the already-filed
// answer is complete before the near-miss ranking and the tracker query below
// it, whose results that answer would only discard. A function is what makes
// leaving early expressible — `process.exitCode` and a `return`, reaching the
// same exit by the same path every other subcommand takes, where an arm of the
// chain had only `process.exit()` and the payload it abandoned (#808).
// Hoisted, so the dispatch chain above stays the file's spine.
function runCheck() {
  // The first check of a run legitimately has no file yet, so absence alone
  // cannot be an error — but a silent "safe to file" for every check when
  // the path is simply wrong (typo'd --file) is a fail-open that no caller
  // would notice. Warn loudly by default; --require-file makes absence a
  // hard failure for callers that know the file must already exist — and that
  // refusal is read ahead of the dispatch now, not here, because four other
  // subcommands needed the same one (#816). Reaching this line at all means
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
  // header still parses, with the rows below it lost (#231).
  const ledger = { ok: ledgerParsed };
  if (!existsSync(file)) {
    console.error(
      `${NAME}: WARNING — ledger file not found: ${file}. Every check will read "safe to file" until it exists.`,
    );
  } else if (!ledger.ok) {
    // #817: the existence probe above is silent once `file` exists, so a
    // `--file` landing on a real-but-wrong path — a typo'd neighbour, a
    // corrupted "## Filed" header, a 0-byte file — got the SAME silence as a
    // clean read. `ledger.ok` (above) already tells the machine-readable half
    // apart; this is that same "opened it, it did not parse" fact stated on
    // stderr, in wording that does not borrow "file not found" — the file
    // demonstrably exists, so claiming otherwise would be a fresh version of
    // the defect #231 removed from the JSON half.
    console.error(
      `${NAME}: WARNING — ${file} exists but does not look like a ledger (no "${FILED}" header found). Every check will read "safe to file" until it is fixed.`,
    );
  }
  refuseStrayInCheckTail(rest);
  const subject = rest.join(" ");
  // Quoted here, unlike the three usage strings above, because
  // refuseStrayInCheckTail() is the reason: `check` is the subcommand whose tail
  // must arrive as ONE argument, and this is the only spelling of its call
  // inside the script (#1161). The other three take their tail as the words a
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
    return (small.size === big.size || small.size >= 4) && small.isSubsetOf(big);
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
    // read included (#808). The `return` is what keeps the ranking and the
    // tracker query below unreached; nothing after it assigns exitCode on
    // this path, so 1 is what the process leaves with.
    process.exitCode = 1;
    return;
  }

  // Near-miss reporting. The subset match above answers exactly one question —
  // "was this near-verbatim wording already filed" — and answers it well. It
  // says nothing about the same finding described in DIFFERENT words, which is
  // how a second discoverer actually words it: one measured run rediscovered
  // #114 five times, each in its own phrasing, and the check caught none of
  // them. Rank the filed list by token overlap and hand the top rows back with
  // a score, instead of collapsing all of that into `found: false`.
  //
  // Scored on its own token set, deliberately not the exact path's. Stopwords
  // and the singular fold only sharpen a ranking, but folding them into
  // isMatch() would widen what counts as ALREADY FILED — the one behaviour
  // here that callers gate on and that must not move.
  // Widened for #153: modals, negations and temporals ("should", "never",
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
  // No floor was tuned here: the measured #114 rewording shares exactly one
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
  // verdict's own answer — `soft-hit` rather than `clean` (#388). A tuning
  // value, deliberately named and deliberately here beside the display cap
  // rather than inlined in the verdict below.
  //
  // Chosen from the rows #388 measured: the near-misses a reader went on to
  // confirm as the genuinely adjacent issue scored from 0.20 up to 0.45, so a
  // floor at 0.20 admits them. #388 also records an adjacent row at 0.09, which
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
  // the "no silent caps" rule `candidates.mjs`'s `refuseIfCapped` legislates one script over
  // (#154). It enforces that rule by refusing outright; refusing is wrong
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
  // every match above, and that is the measured failure: #114 was rediscovered
  // five times in one run and `check` reported it safe to file every time. Ask
  // the tracker.
  //
  // gh ANDs the search terms, so every extra term can only narrow the result —
  // keep the query SHORT: three of the subject's most distinctive words.
  // Measured against the live tracker, "candidates opposite states" returns
  // #114. Whether a fourth term helps or hurts turns on whether it happens to
  // occur in the target issue's text — gh searches bodies, not just titles —
  // which the subject cannot know: "code" leaves #114 in, "open" drops it. So
  // three is a recall-preserving floor, not a measured optimum. Longest-first is a crude stand-in for distinctiveness (no
  // corpus to weigh terms against) and the >= 3 filter erases short but
  // distinctive identifiers like `CI` or `gh`; upgrade to a real frequency
  // weighting if the query starts missing.
  //
  // #153 widened STOP (above) to stop modals/negations/temporals from
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
  // truncation signal available — #154. Cheap: one row, one query, and it is
  // ranked alongside the rest rather than discarded.
  const TRACKER_SHOWN = 5;
  let tracker;
  if (terms.length === 0) {
    // An empty --search matches every issue in the repo, which would report
    // every subject as a tracker hit. Not searching is the honest answer.
    // `hits` is omitted, not `[]` — the tracker was never read, so an empty
    // list here would be a claim of cleanliness this branch never earned
    // (issue #152: a consumer testing `.length` must not read this as clean).
    tracker = { ok: false, query: null, error: "subject has no distinctive terms to search for" };
  } else {
    // gh resolves "the repository" from the child process's cwd, which
    // defaults to THIS process's cwd — the caller's, not the ledger's. The
    // ledger itself is resolved from --file or defaultLedgerPath()'s
    // --git-common-dir above; in the documented flow (no --file, run from
    // the repo) the two agree, but an explicit --file naming a ledger
    // outside the caller's repo diverges silently: the query searches the
    // wrong tracker and reports a confident, empty result (#155). Bind gh's
    // cwd to the ledger's OWN repository instead of leaving it implicit. No
    // --repo flag needed — gh's remote-based resolution does the rest once it
    // is pointed at the right directory, and a worktree ledger (shared .git,
    // own working tree) still resolves to the same repo either way.
    //
    // cwd is not the whole story: inherited git vars outrank it, so an
    // ambient GIT_DIR/GIT_WORK_TREE retargets BOTH the probe below and gh's
    // own remote resolution at the other repository, and the #155
    // confident-empty result comes straight back with `ok: true` on it.
    // Plausible here: a git hook, `rebase --exec`, `bisect run`. Scrub them
    // off both children — the fleet's own fixtures already do exactly this
    // (inflight.test.mjs).
    //
    // GH_REPO is the same hazard one layer up, and worse: gh reads it BEFORE
    // it ever consults git, so no amount of git-var hygiene covers it and the
    // bound cwd is simply ignored. Measured against a live tracker with the
    // cwd binding in place: `GH_REPO=<some other real repo>` searched that
    // repo and returned `{"ok":true,"hits":[],"verdict":"clean"}` — #155
    // verbatim, in the documented flow, no --file divergence needed. Not
    // hypothetical here either: this repo's own
    // .github/workflows/release-label.yml exports GH_REPO to every step that
    // shells out to gh.
    // Empty string is the documented fall-back-to-cwd value (measured — unset
    // and "" behave alike), so this composes with cwd rather than fighting it.
    //
    // With all three off, the ledger and the queried tracker cannot disagree.
    const gitEnv = { ...process.env, GH_REPO: "" };
    delete gitEnv.GIT_DIR;
    delete gitEnv.GIT_WORK_TREE;
    let ledgerDir = dirname(resolve(file));
    // `check` runs before the run's FIRST ledger write, and `.fleet/` is
    // gitignored and created lazily by save()'s mkdirSync — so on a fresh
    // clone or worktree the ledger's own directory does not exist yet, while
    // `git -C` requires one that does (exit 128, "cannot change to ...").
    // Climb to the nearest existing ancestor: same repository, and probing
    // the missing directory instead reported every first `check` as not being
    // in a repository and dropped the tracker query outright.
    while (!existsSync(ledgerDir) && dirname(ledgerDir) !== ledgerDir) ledgerDir = dirname(ledgerDir);
    const repoCheck = spawnSync("git", ["-C", ledgerDir, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: gitEnv, timeout: GIT_TIMEOUT_MS });
    if (repoCheck.status !== 0) {
      // More than one cause lands here: a ledger path genuinely outside any
      // repository, but also git missing entirely (spawn ENOENT, so `status`
      // is null and `null !== 0`), a dubious-ownership refusal, an unreadable
      // `.git` gitfile, and since #1199 a probe that overran GIT_TIMEOUT_MS —
      // spawnSync reports that the same way ENOENT arrives, `status` null with
      // the reason in `error.message`, so it needs no arm of its own and
      // cause() names it (`spawnSync git ETIMEDOUT`) without this branch
      // having to. Do not name one of them — carry git's own reason,
      // because this call leaves stdio at the default pipe, so git's stderr
      // reaches no terminal and this string is the only place the cause is
      // ever seen (the same call the gh catch below makes, #176). The CAUSE is
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
      // directory, a cause already cut to 500, and 43 of fixed text (#940).
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
      const ghCwd = repoCheck.stdout.trim();
      try {
        const out = execFileSync(
          "gh",
          ["issue", "list", "--search", query, "--state", "all", "--limit", String(TRACKER_SHOWN + 1),
            "--json", "number,title,state,url"],
          { encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"], cwd: ghCwd, env: gitEnv },
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
        // hits is for (#232).
        //
        // Absence is the whole of that claim, deliberately: a `title` that is
        // PRESENT and not a string is not handled here or anywhere below —
        // `h.title || ""` keeps a truthy non-string, and scoreTokens then calls
        // `.toLowerCase()` on it, so the read degrades to `unverified` reporting
        // a TypeError where a tracker reason belongs. That is #643's, which
        // rules on field TYPE where this guard rules on field PRESENCE.
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
        // from the fleet's other gh catches (#176). Those omit it because
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
        // LONGER copy of the cause, not a smaller fallback (#176, measured
        // again here). The message earns its place wherever stderr holds no
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
        // 20-second stall and named the timeout nowhere (#638). The flip moves
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
    // hand (#388). Under this heading stderr and the verdict now say the same
    // thing: a set with a scoring row is a hit, a set without one is rows to
    // read.
    const heading = bestHit > 0 ? "TRACKER HIT" : "TRACKER ROW";
    for (const h of tracker.hits) {
      console.error(`${NAME}: ${heading} — #${h.number} (${h.state}, score ${h.score.toFixed(2)}) ${h.title} — ${h.url}`);
    }
    // `more than N`, never `N`: with the probe row back, the exact count is
    // precisely what is not known, and printing `5` for it is the silent cap
    // restated as a number (#154).
    console.error(bestHit > 0
      ? `${NAME}: not in this run's filed list, but ${tracker.truncated ? `more than ${TRACKER_SHOWN}` : tracker.hits.length} tracker issue(s) match '${query}' — review before filing`
      : `${NAME}: not in this run's filed list; the tracker rows matching '${query}' all score 0.00 against this subject — gh matched something the title-based score cannot see, so read them, but they are not a finding of duplication`);
    if (tracker.truncated) {
      console.error(`${NAME}: the list above is CAPPED at ${TRACKER_SHOWN} — gh returned more and reports no total, so these are the best-scoring of a window gh chose, not of the tracker.`);
    }
  } else {
    // Not "found no related issues" — that asserts the tracker has nothing,
    // when all that is actually established is that a ${terms.length}-term
    // heuristic query came back empty (#153). A query built from a few
    // longest-surviving words can miss the very issue it should have found
    // (see the STOP comment above); "no matches for this query" says what was
    // established and leaves the rest unclaimed.
    console.error(`${NAME}: not previously filed; tracker search '${query}' (${terms.length} term${terms.length === 1 ? "" : "s"}) returned no matches — not a certification the tracker has nothing on this`);
  }
  // Named explicitly so a consumer does not have to reconstruct it from
  // `tracker.ok` plus `tracker.hits` — issue #152.
  //
  // The scores decide, not the presence of rows (#388). Both halves of the
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
  // payload a consumer parses (#154). They differ in what is knowable —
  // the ledger is fully in hand, so the near-miss total is exact, while gh
  // reports no total, so the tracker can only say that more exist.
  // `ledger.ok` beside `tracker.ok`, and deliberately NOT inside `verdict`:
  // the two halves each report their own readability, which is what makes an
  // unread ledger distinguishable from one read and found empty — those
  // payloads were otherwise identical in every field (#231). Folding it into
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
  // break `check "$s" && gh issue create` on every offline run (ruled against
  // in #152), and a soft hit is the same kind of answer — advisory rows, no
  // established duplicate — so it inherits that ruling rather than reopening
  // it. The exit code is a pure function of `verdict`; only `tracker-hit`
  // blocks, so a verdict added later leaves 3 alone unless it says so here.
  //
  // A hit set scoring 0.00 no longer forces 3 (#388). gh can match an issue
  // body the title-based score cannot see, which is why those rows are still
  // printed and still shipped in the payload — but the instruction the callers
  // carry makes exit 3 binding, and #388 measured what that costs: every
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
