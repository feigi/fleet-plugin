// #567 and #878: the cross-file sync requirement, EXECUTED.
//
// arg.mjs states the CLI refusal rules; ledger.mjs and member-outcomes.mjs
// cannot route through arg()/has() — each hand-rolls its own argv reader so it
// can word its refusals for --file and --require-file — and so each used to
// carry its own copy of those rules. The requirement that the copies stay in
// step was asserted only in PROSE, in two file headers. Measured on the
// post-#563 tree: the copies could be edited independently and the suite
// stayed green, because each file's tests pin only its own wording. That is
// the same class of defect #563 itself fixed — a requirement documented where
// nothing executes it. This file is what executes it.
//
// #878 added a second rule on the same terms — the digits rule isDigits(),
// whose out-of-reach consumers are fleet-tick.mjs (its own parseArgs),
// review-core.js (a workflow argument, not argv) and workflows/review-pr.js,
// which cannot `import` at all (#538) and so is the only file in the tree
// that holds a real COPY rather than a call. Its wiring pin rides in test 1
// below, beside #567's; two further tests sit at the bottom of this file —
// the differential against review-pr.js's lifted copy, and one idea this
// file did not need before: a DERIVED sweep asserting the rule is spelled
// nowhere else, because a fourth copy is behaviour-identical and no
// behavioural test in this repo can see one.
//
// THREE tests for #567's two predicates, because none of them covers another:
//
//   1. The WIRING pin. A copy re-inlined byte-for-byte behaviour-identically
//      changes no observable behaviour at all, so no behavioural test in this
//      repo can see it — only a source assertion can. Measured: replacing
//      ledger.mjs's `isFlagLike(file)` with `(file.startsWith("--") ||
//      file.trim() === "")` reds this test and nothing else.
//   2. The DIFFERENTIAL. The wiring pin is a text-lift, and a text pin proves
//      a spelling, never a behaviour: it stays green if the predicate itself
//      is gutted, and it is blind to a regression ABOVE the pinned line that
//      corrupts the value before it arrives. This one runs all three readers
//      over the same values and requires the same verdict, so a copy that
//      reappears DRIFTED reds here even if it is spelled to satisfy test 1.
//   3. The must-ACCEPT pin. Every case in 1 and 2 is input the rule must
//      REFUSE, and a rule that refused everything would satisfy both. The
//      predicates are fed input they must accept, including the neighbours the
//      `--`-prefix rule deliberately does not cost: a single leading `-`, a
//      `--` anywhere but the front, and a longer flag name that merely shares
//      a prefix with the one being asked about.
//
// KNOWN CEILING on test 1, the presence-pin ceiling member-prompt-prose.test.mjs
// records: it asserts each refusal LINE routes through a predicate. It cannot
// prove some other line further down does not re-refuse on a hand-written
// rule of its own. Test 2 is the backstop for exactly that, on the values it
// samples. (Not strip-comments.mjs's ceiling, which is about trailing `code;
// // note` surviving the strip — measured, closing that one closes a
// different escape and leaves this one open.)
//
// SECOND CEILING, disclosed rather than fixed: these are text pins, so they
// answer a spelling. The `^` anchors mean re-indenting a pinned line reds
// them though nothing executable changed. Import ORDER and import LAYOUT are
// deliberately not pinned — each imported name is matched on its own, and
// `[^}]*` spans newlines — so a reflow or a reorder is free.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { lift } from "./lift.mjs";
import { isFlagLike, hasEqualsForm, isDigits } from "./arg.mjs";

const src = (name) => stripComments(readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8"));

test("every refusal that shares arg.mjs's rules calls a predicate instead of restating one", () => {
  const arg = src("arg.mjs");
  // The rules themselves, stated once. Anchored at the export, so moving the
  // expression back inside a factory reds here rather than quietly leaving two
  // statements of the same rule in one file.
  assert.match(arg, /^export function isFlagLike\(value\) \{$/m, "arg.mjs no longer exports isFlagLike");
  assert.match(arg, /^export function hasEqualsForm\(name, argv = process\.argv\) \{$/m, "arg.mjs no longer exports hasEqualsForm");
  // arg.mjs's own guards are consumers too. Without these, the rule could be
  // exported for ledger.mjs while arg() kept a second copy — which is the
  // ticket's defect with the two files swapped.
  assert.match(arg, /if \(isFlagLike\(value\)\) die\(`--\$\{name\} needs a value`\);/, "arg()'s value guard restates the rule instead of calling isFlagLike");
  assert.match(arg, /if \(hasEqualsForm\(name\)\) die\(`--\$\{name\} needs a space-separated value/, "arg()'s `=` guard restates the rule instead of calling hasEqualsForm");
  assert.match(arg, /if \(hasEqualsForm\(name\)\) die\(`--\$\{name\} is a boolean flag/, "has()'s `=` guard restates the rule instead of calling hasEqualsForm");

  const ledger = src("ledger.mjs");
  // Each name on its own, because what must hold is that it comes from
  // arg.mjs — not the order, and not the layout. `[^}]*` DOES span newlines
  // (measured), here and in arg.test.mjs's #367 wiring pin, so a reflow of
  // either import unpins nothing.
  for (const fn of ["isFlagLike", "hasEqualsForm"]) {
    assert.match(ledger, new RegExp(String.raw`^import \{[^}]*\b${fn}\b[^}]*\} from "\./arg\.mjs";`, "m"), `ledger.mjs no longer imports ${fn} from arg.mjs`);
  }
  // Each assertion pins the predicate call AND the wording beside it: the
  // wording is deliberately ledger.mjs's own, not generated from a flag name,
  // and a fix that unified the messages would be the other half of #567's AC
  // going the wrong way.
  // No `$`: stripComments blanks whole-line comments only, so a trailing
  // `// note` survives the strip and would red an end-anchored pin over a
  // line whose code did not change.
  assert.match(ledger, /^if \(hasEqualsForm\("file", argv\)\) die\("--file needs a space-separated value, not --file="\);/m, "ledger.mjs's --file= guard drifted from arg.mjs's rule or lost its own wording");
  assert.match(ledger, /^if \(hasEqualsForm\("require-file", argv\)\) die\("--require-file is a boolean flag, not --require-file="\);/m, "ledger.mjs's --require-file= guard drifted from arg.mjs's rule or lost its own wording");
  assert.match(ledger, /if \(fileIdx !== -1 && file && isFlagLike\(file\)\) die\("--file needs a path"\);/, "ledger.mjs's --file value guard drifted from arg.mjs's rule or lost its own wording");

  const memberOutcomes = src("member-outcomes.mjs");
  assert.match(memberOutcomes, /^import \{[^}]*\bisFlagLike\b[^}]*\} from "\.\/arg\.mjs";/m, "member-outcomes.mjs no longer imports isFlagLike from arg.mjs");
  assert.match(memberOutcomes, /if \(isFlagLike\(file\)\) die\("--file needs a path"\);/, "member-outcomes.mjs's --file guard drifted from arg.mjs's rule or lost its own wording");

  // The blank spelling is the one a hand-written copy has historically dropped
  // — member-outcomes.mjs's copy was `!file || file.startsWith("--")`, the rule
  // with that clause missing, and `--file "   "` was accepted for it. Nothing
  // outside arg.mjs's own predicate should spell it again.
  for (const [name, text] of [["ledger.mjs", ledger], ["member-outcomes.mjs", memberOutcomes]]) {
    assert.doesNotMatch(text, /trim\(\) === ""/, `${name} hand-writes the blank-value rule again instead of calling isFlagLike`);
  }

  // #878's rule, on the same terms. Anchored at the export for the same
  // reason the two above are, and paired with arg.mjs's OWN consumer —
  // numArg() — because exporting the rule while arg.mjs kept a second copy of
  // it is this ticket's defect with the files swapped.
  assert.match(arg, /^export function isDigits\(value\) \{$/m, "arg.mjs no longer exports isDigits");
  assert.match(arg, /if \(!isDigits\(raw\)\) die\(`--\$\{name\} needs a number, got \$\{raw\}`\);/, "numArg() restates the digits rule instead of calling isDigits");

  // The two consumers that cannot route through numArg(): fleet-tick.mjs
  // reads its flags with node:util's parseArgs, and review-core.js takes its
  // `pr` as a workflow argument rather than from argv. Each keeps its own
  // wording — "must be a non-negative integer" and "must be a PR number" —
  // and neither may keep its own spelling of the rule.
  const fleetTick = src("fleet-tick.mjs");
  assert.match(fleetTick, /^import \{[^}]*\bisDigits\b[^}]*\} from "\.\/arg\.mjs";/m, "fleet-tick.mjs no longer imports isDigits from arg.mjs");
  assert.match(fleetTick, /if \(!isDigits\(String\(raw\)\.trim\(\)\)\) die\(`--\$\{name\} must be a non-negative integer, got '\$\{raw\}'`\);/, "fleet-tick.mjs's integer guard drifted from arg.mjs's rule or lost its own wording");

  const reviewCore = src("review-core.js");
  assert.match(reviewCore, /^import \{[^}]*\bisDigits\b[^}]*\} from "\.\/arg\.mjs";/m, "review-core.js no longer imports isDigits from arg.mjs");
  assert.match(reviewCore, /if \(!isDigits\(pr\)\) throw new Error\(/, "review-core.js's numeric-pr guard drifted from arg.mjs's rule");

  // workflows/review-pr.js holds the one COPY (#538: a Workflow body cannot
  // import), so what is pinned here is that the copy is CALLED and where.
  // Position is the only observable: the file runs a top-level `await
  // pipeline(...)` and cannot be imported, and the snapshot directory is
  // `mkdir -p`'d inside the snapshot agent's own bash, so "refused before an
  // agent is dispatched" and "before a directory exists" are one ordering
  // fact — the same argument select-dimensions.test.mjs makes for #275's
  // override guard, which this refusal sits directly above.
  const reviewPr = src("../workflows/review-pr.js");
  const callAt = reviewPr.indexOf("if (!isDigits(pr)) throw new Error(");
  const requiredAt = reviewPr.indexOf('if (!pr || !worktree) throw new Error("review-pr: args.pr and args.worktree are required");');
  const snapshotAt = reviewPr.indexOf("const snap = await agent(");
  assert.notEqual(callAt, -1, "review-pr.js no longer calls its isDigits copy on `pr` — the workflow is back to a truthiness check");
  assert.notEqual(requiredAt, -1, "review-pr.js's required-args throw moved — update this test");
  assert.notEqual(snapshotAt, -1, "review-pr.js's snapshot dispatch moved — update this test");
  assert.ok(requiredAt < callAt, "the digits refusal was hoisted above the required-args throw — an absent `pr` is now told about digits instead of being told it is required");
  assert.ok(callAt < snapshotAt, "the digits refusal moved below the snapshot dispatch — a branch name now buys an agent and a run root before being refused");
});

// The three readers, run for real over the same values. `arg()` is exercised
// through a throwaway script rather than in-process because it reads the live
// process.argv and exits the process on refusal — both of which a test runner
// cannot host.
function probeFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "shared-refusal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "arg.mjs"), readFileSync(fileURLToPath(new URL("./arg.mjs", import.meta.url))));
  writeFileSync(join(dir, "probe.mjs"), [
    'import { makeDie, makeArg } from "./arg.mjs";',
    'const arg = makeArg(makeDie("probe"));',
    'console.log(arg("file") ?? "<absent>");',
    "",
  ].join("\n"));

  // The same isolation ledger.test.mjs's own CLI fixture uses: the real `gh`
  // must be unreachable, or an ACCEPTED value would carry these assertions on
  // to this repo's live issue list. `git` is reachable only so that anything
  // reaching defaultLedgerPath() fails on its own terms.
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  assert.ok(realGit, "shared-refusal.test.mjs setup: could not locate a `git` binary on PATH");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  symlinkSync(realGit, join(bin, "git"));
  const env = { ...process.env, PATH: bin };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;

  // member-outcomes.mjs takes a session dir positional and refuses before it
  // reaches the --file rule if that dir has no readable `subagents`, so the
  // probe would otherwise measure the wrong guard.
  mkdirSync(join(dir, "session", "subagents"), { recursive: true });

  const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env, cwd: dir });
  const LEDGER = fileURLToPath(new URL("./ledger.mjs", import.meta.url));
  const MEMBER_OUTCOMES = fileURLToPath(new URL("./member-outcomes.mjs", import.meta.url));
  return {
    // "Refused BY THIS RULE", never merely "exited non-zero": an accepted odd
    // path sends ledger.mjs on to a missing file and a tracker it cannot
    // reach, which is a non-zero exit that says nothing about the guard.
    viaArg: (value) => {
      const r = run(join(dir, "probe.mjs"), ["--file", value]);
      return r.status === 2 && /--file needs a value|--file needs a space-separated value/.test(r.stderr);
    },
    viaLedger: (value) => {
      const r = run(LEDGER, ["--file", value, "check", "some subject"]);
      return r.status === 2 && /--file needs a path|--file needs a space-separated value/.test(r.stderr);
    },
    // The third copy site. Pinned by SOURCE TEXT alone until #1128, which is
    // a spelling and not a behaviour: the mutation that reds nothing is one
    // ABOVE the `if (isFlagLike(file))` line, corrupting `file` before it
    // arrives — measured, `const file = (raw ?? "").trim() || <default>` left
    // every member-outcomes test green while `--file "   "` wrote the
    // production metrics path at exit 0. Only a spawn sees that.
    viaMemberOutcomes: (value) => {
      const r = run(MEMBER_OUTCOMES, [join(dir, "session"), "--file", value]);
      return r.status === 2 && /--file needs a path/.test(r.stderr);
    },
    viaArgRaw: (args) => run(join(dir, "probe.mjs"), args),
    viaLedgerRaw: (args) => run(LEDGER, args),
  };
}

test("all three readers reach the same verdict on the shared rule — the copies cannot drift", (t) => {
  const p = probeFixture(t);

  // REFUSE on all three. The blank spellings are the ones a hand-written copy
  // has historically dropped — member-outcomes.mjs's copy was `!file ||
  // file.startsWith("--")`, and `--file "   "` wrote the production metrics
  // TSV to a whitespace-named path at exit 0.
  for (const value of ["   ", "\t"]) {
    assert.equal(p.viaArg(value), true, `arg() must refuse ${JSON.stringify(value)}`);
    assert.equal(p.viaLedger(value), true, `ledger.mjs must refuse ${JSON.stringify(value)} — its copy has drifted narrower than arg.mjs's rule`);
    assert.equal(p.viaMemberOutcomes(value), true, `member-outcomes.mjs must refuse ${JSON.stringify(value)} — its copy has drifted narrower than arg.mjs's rule`);
  }

  // `--`-prefixed values reach the shared rule in only two of the three:
  // member-outcomes.mjs refuses them one guard earlier, in its own
  // unknown-option sweep, under wording that names the sweep and not --file.
  // `--require-file` is #362's own case: the flag that used to become the path.
  for (const value of ["--require-file", "--other"]) {
    assert.equal(p.viaArg(value), true, `arg() must refuse ${JSON.stringify(value)}`);
    assert.equal(p.viaLedger(value), true, `ledger.mjs must refuse ${JSON.stringify(value)} — its copy has drifted narrower than arg.mjs's rule`);
  }

  // ACCEPT on both sides. These are the neighbours the `--`-prefix rule is
  // deliberately not allowed to cost.
  //
  // Asserted as "the value was USED as the path", never as "nothing refused
  // it": a not-refused assertion is satisfied by any unrelated failure, and by
  // a guard that swallowed the value and fell back to a default — which is the
  // fail-open shape this whole family of guards exists to close. Each value is
  // relative and names nothing in the fixture dir, so ledger.mjs quotes it
  // back in its not-found warning, and arg() echoes it on stdout.
  for (const value of ["-1", "-weird--ledger.md", "foo--bar", "plain-name.md"]) {
    assert.equal(p.viaArg(value), false, `arg() must accept ${JSON.stringify(value)}`);
    assert.equal(p.viaArgRaw(["--file", value]).stdout.trim(), value, `arg() accepted ${JSON.stringify(value)} but did not return it`);
    assert.equal(p.viaLedger(value), false, `ledger.mjs must accept ${JSON.stringify(value)} — its copy has drifted wider than arg.mjs's rule`);
    assert.match(p.viaLedgerRaw(["--file", value, "check", "s"]).stderr, new RegExp(`ledger file not found: ${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`), `ledger.mjs accepted ${JSON.stringify(value)} but did not read the ledger at it`);
  }

  // The `=` spelling, in both argv positions, on both readers. ledger.mjs's is
  // pinned positionally in ledger.test.mjs already; what is pinned here is
  // that the two readers agree, which is the property a copy breaks.
  for (const args of [["--file=/tmp/x"], ["--file=/tmp/x", "check", "s"], ["check", "--file=/tmp/x", "s"]]) {
    assert.match(p.viaLedgerRaw(args).stderr, /--file needs a space-separated value/, `ledger.mjs let \`${args.join(" ")}\` through`);
  }
  assert.match(p.viaArgRaw(["--file=/tmp/x"]).stderr, /--file needs a space-separated value/, "arg() let --file=<path> through");

  // TWO values are excluded from the table above, deliberately and not by
  // oversight: an empty string and a trailing `--file` with nothing after it.
  // isFlagLike answers TRUE for both, but ledger.mjs guards its call with
  // `file &&` so that those two land on its own pre-existing "given with no
  // path" wording instead — the behaviour #362's Measured block records as
  // already correct. Pinned here so the exclusion is a decision on the record
  // rather than a hole.
  const trailing = p.viaLedgerRaw(["--file"]);
  assert.equal(trailing.status, 2);
  assert.match(trailing.stderr, /--file given with no path/, "ledger.mjs's trailing-flag wording was absorbed into the shared rule's");
});

test("the shared rules accept what they must — the false-positive half", () => {
  // A rule that refused everything would satisfy every assertion above.
  for (const value of ["-1", "-weird--ledger.md", "foo--bar", "/tmp/x", "check", "0", "-"]) {
    assert.equal(isFlagLike(value), false, `isFlagLike must accept ${JSON.stringify(value)}`);
  }
  for (const value of [undefined, "", "   ", "\t\n", "--file", "--"]) {
    assert.equal(isFlagLike(value), true, `isFlagLike must refuse ${JSON.stringify(value)}`);
  }

  // hasEqualsForm matches on `--name=`, so a longer name that merely shares
  // the prefix is NOT its business — it is a flag nothing reads, which is
  // sweep()'s to refuse in sweep()'s own wording. A rule that answered true
  // here would turn ledger.mjs's --file guard into a refusal of --filename.
  assert.equal(hasEqualsForm("file", ["--filename=x"]), false, "hasEqualsForm claimed a longer flag name sharing the prefix");
  assert.equal(hasEqualsForm("file", ["--file", "x"]), false, "hasEqualsForm claimed a well-formed space-separated value");
  assert.equal(hasEqualsForm("file", ["check", "a=b"]), false, "hasEqualsForm claimed a positional containing an `=`");
  assert.equal(hasEqualsForm("file", ["--file=x"]), true, "hasEqualsForm missed the `=` spelling");
  assert.equal(hasEqualsForm("file", ["check", "s", "--file=x"]), true, "hasEqualsForm scans only the front of argv");
  // The empty value after `=`, which is the spelling most likely to read as
  // "the flag is absent" on both sides.
  assert.equal(hasEqualsForm("file", ["--file="]), true, "hasEqualsForm missed a bare `--file=`");
});

// ── #878: the digits rule, and the one copy the sandbox forces ────────────
//
// BOTH historical spellings, because the drift came back as either one:
// ci-state.mjs wrote `/^[0-9]+$/` and fleet-tick.mjs's int() wrote `/^\d+$/`,
// and a sweep that banned only the first stays green while the second is
// re-inlined (measured — reverting int() to its own regex reds the wiring pin
// and nothing here).
//
// Anchored exactly, so a DIFFERENT rule that happens to use the digit class
// is not caught: candidates.mjs's `Number.isInteger(limit) && limit >= 1` is
// a bounded positive-integer rule over a DEFAULTED value — not a copy of this
// one, and #878 left it where it is.
//
// Composed, never written contiguously, so this file's own source cannot
// satisfy the check it performs — the same reason
// scripts-path-citation-sweep.test.mjs gives for its stale citation.
const DIGITS_RULE = new RegExp([
  ["\\^\\[0-9\\]", "\\+\\$"].join(""),
  ["\\^\\\\d", "\\+\\$"].join(""),
].join("|"));

// DERIVED, never a hand list, and the direction is what makes that safe: this
// asserts an ABSENCE across the tree, so a set discovered by reading the two
// script directories can only GROW as files arrive. That is the opposite of
// arg.test.mjs's CONSUMERS/STRAYS matrices, which assert a PRESENCE per file
// and so must be spelled out — a discovered set there shrinks silently when a
// caller drops the call. review-pr-reads.test.mjs records the same choice for
// the same reason.
//
// Test files are excluded. A test may legitimately quote the rule to pin it,
// and a pin is not a fourth implementation of it — the same `grep -v test`
// scoping every sweep in arg.mjs's header uses.
const RULE_SITES = () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const dirs = [here, join(here, "..", "workflows")];
  const sites = [];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!/\.(mjs|js)$/.test(name) || name.endsWith(".test.mjs")) continue;
      if (DIGITS_RULE.test(stripComments(readFileSync(join(dir, name), "utf8")))) sites.push(name);
    }
  }
  return sites.sort();
};

// The ticket's own words: "adding a fourth copy is the drift, not the fix".
// Before #878 the invariant had three spellings — ci-state.mjs's `/^[0-9]+$/`,
// fleet-tick.mjs's `/^\d+$/`, and candidates.mjs's Number.isInteger (which
// stays, being a bounded positive-integer rule over a defaulted value rather
// than this one) — and the fix is only a fix while the count stays at the two
// below. A behavioural test cannot see a fourth copy at all: pasted back into
// diff-stats.mjs it would refuse exactly what numArg() refuses and the whole
// suite would stay green, which is how three spellings accumulated.
test("#878: the digits rule is spelled in arg.mjs and in the one file that cannot import it", () => {
  assert.deepEqual(
    RULE_SITES(),
    ["arg.mjs", "review-pr.js"],
    "a copy of the digits rule appeared outside arg.mjs, or review-pr.js's sandbox copy went missing — arg.mjs's header says which files may hold one and why",
  );
});

// The DIFFERENTIAL, which is what the text pins above cannot be: a spelling
// proves nothing about a verdict, and review-pr.js's copy is reachable by no
// import at all (#538 — a Workflow script's body compiles inside the harness
// VM, where `import()` is refused before the specifier resolves). So it is
// lifted out of the source text and run, the technique every other
// review-pr.js test file uses, against the real rule over one value list.
//
// Both halves in one list on purpose. Every value above this line is input the
// rule must REFUSE, and a rule that refused everything satisfies all of them —
// `42`/`"42"`/`"0"` are the must-ACCEPT half, and `42` as a NUMBER is not
// decoration: review-pr.js's caller is the fleet, which holds a PR number as a
// number, so a copy that lost RegExp.test's coercion would refuse every real
// invocation while still refusing every bad one.
//
// `null`/`undefined` answer FALSE here, which both call sites depend on: each
// reads absence first and owes "required" rather than a complaint about
// digits. A copy "fixed" to accept them would silently merge the two refusals.
test("#878: review-pr.js's copy of the digits rule reaches the same verdict as arg.mjs's", () => {
  const prIsDigits = lift(src("../workflows/review-pr.js"), "isDigits", "value");
  const values = [
    "abc", "42x", "x42", "", "   ", "4 2", " 42", "42 ", "1e3", "0x2a", "-1", "+42", "4.0", "4,2",
    "42\n", "my-branch", "null", null, undefined, NaN,
    "42", 42, "0", 0, "007",
  ];
  // `JSON.stringify` alone renders NaN and null identically, and the string
  // "42" and the number 42 nearly so — both distinctions are the point here.
  const show = (v) => `${JSON.stringify(v)} (${typeof v})`;
  for (const v of values) {
    assert.equal(
      prIsDigits(v),
      isDigits(v),
      `review-pr.js's copy and arg.mjs disagree on ${show(v)} — the copies have drifted`,
    );
  }
  // The verdicts themselves, so a pair that drifted TOGETHER still reds.
  for (const v of ["42", 42, "0", 0, "007"]) assert.equal(isDigits(v), true, `must accept ${show(v)}`);
  for (const v of ["abc", "42x", "x42", "", " 42", "1e3", "-1", "+42", "4.0", "my-branch", null, undefined]) {
    assert.equal(isDigits(v), false, `must refuse ${show(v)}`);
  }
});

// #878's numArg() returns `number | null`, and that shape is only safe while
// every caller tests absence as `=== null` — `!x` is true for a zero the
// caller plainly GAVE, which is the exact fail-open #878 closed, just moved
// from the digits rule to the caller's own absence check. Nothing in
// numArg()'s construction stops a future or careless caller from writing
// `if (!numArg(...))`; this sweep is the structural backstop the review
// comment on this ticket asked for, in the one place a discovered set is the
// right shape rather than a spelled-out one (contrast CONSUMERS/RULE_SITES
// above): the risk here IS a future file adding a numArg() import, and a
// spelled-out list would need editing at the exact moment the regression
// landed to catch it — which, by definition, it never would.
//
// Two independent checks per consumer file, because a caller can reintroduce
// the bug two ways: testing the bound variable (`if (!pr)`) or testing the
// call inline (`if (!numArg("pr"))`) before ever binding one.
test("#878: every numArg() consumer tests absence with === null, never a bare falsy check", () => {
  const dir = fileURLToPath(new URL(".", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs") && f !== "arg.mjs");
  const consumers = [];
  for (const file of files) {
    const text = src(file);
    if (!/^import\s*\{[^}]*\bmakeNumArg\b[^}]*\}\s*from\s*"\.\/arg\.mjs";/m.test(text)) continue;
    consumers.push(file);
    assert.doesNotMatch(text, /!\s*numArg\(/, `${file} tests a numArg() call inline with a bare falsy check instead of === null`);
    for (const [, name] of text.matchAll(/const\s+(\w+)\s*=\s*numArg\(/g)) {
      assert.doesNotMatch(
        text,
        new RegExp(String.raw`![\s]*\b${name}\b`),
        `${file} tests numArg()'s "${name}" result with a bare falsy check instead of === null — a zero the caller gave would read as absent`,
      );
    }
  }
  // A vacuousness guard: if the import scan above ever finds nothing, every
  // assertion in the loop is skipped and this test passes for the wrong
  // reason. Pinned against the known set (#878's routed three, plus
  // merge-gate.mjs's `--pr`, #1800), not just a non-empty check, so the scan
  // itself breaking (a reformat of the import line, say) reds here instead of
  // silently stopping coverage.
  assert.deepEqual(consumers.sort(), ["ci-state.mjs", "diff-stats.mjs", "merge-gate.mjs", "pr-overlap.mjs"], "the numArg() consumer sweep found a different set than #878 routed — update this list deliberately for a new caller");
});
