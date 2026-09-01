// #567: the cross-file sync requirement, EXECUTED.
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
// THREE tests, because none of them covers another:
//
//   1. The WIRING pin. A copy re-inlined byte-for-byte behaviour-identically
//      changes no observable behaviour at all, so no behavioural test in this
//      repo can see it — only a source assertion can. Measured: replacing
//      ledger.mjs's `isFlagLike(file)` with `(file.startsWith("--") ||
//      file.trim() === "")` reds this test and nothing else.
//   2. The DIFFERENTIAL. The wiring pin is a text-lift, and a text pin proves
//      a spelling, never a behaviour: it stays green if the predicate itself
//      is gutted. This one runs arg()'s reader and ledger.mjs's reader over
//      the same values and requires the same verdict, so a copy that reappears
//      DRIFTED reds here even if it is spelled to satisfy test 1.
//   3. The must-ACCEPT pin. Every case in 1 and 2 is input the rule must
//      REFUSE, and a rule that refused everything would satisfy both. The
//      predicates are fed input they must accept, including the neighbours the
//      `--`-prefix rule deliberately does not cost: a single leading `-`, a
//      `--` anywhere but the front, and a longer flag name that merely shares
//      a prefix with the one being asked about.
//
// KNOWN CEILING on test 1, the same one strip-comments.mjs's own header
// records: it asserts each refusal LINE routes through a predicate. It cannot
// prove some other line further down does not re-refuse on a hand-written
// rule of its own. Test 2 is the backstop for exactly that, on the values it
// samples.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";
import { isFlagLike, hasEqualsForm } from "./arg.mjs";

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
  // One line, because arg.test.mjs's #367 wiring pin matches the import with
  // `[^}]*` and cannot span a newline — a reflow that splits this import
  // silently unpins die()'s migration in a different file.
  assert.match(ledger, /^import \{[^}]*\bisFlagLike\b[^}]*\bhasEqualsForm\b[^}]*\} from "\.\/arg\.mjs";/m, "ledger.mjs no longer imports both predicates from arg.mjs on one line");
  // Each assertion pins the predicate call AND the wording beside it: the
  // wording is deliberately ledger.mjs's own, not generated from a flag name,
  // and a fix that unified the messages would be the other half of #567's AC
  // going the wrong way.
  assert.match(ledger, /^if \(hasEqualsForm\("file", argv\)\) die\("--file needs a space-separated value, not --file="\);$/m, "ledger.mjs's --file= guard drifted from arg.mjs's rule or lost its own wording");
  assert.match(ledger, /^if \(hasEqualsForm\("require-file", argv\)\) die\("--require-file is a boolean flag, not --require-file="\);$/m, "ledger.mjs's --require-file= guard drifted from arg.mjs's rule or lost its own wording");
  assert.match(ledger, /if \(fileIdx !== -1 && file && isFlagLike\(file\)\) die\("--file needs a path"\);/, "ledger.mjs's --file value guard drifted from arg.mjs's rule or lost its own wording");

  const memberOutcomes = src("member-outcomes.mjs");
  assert.match(memberOutcomes, /^import \{[^}]*\bisFlagLike\b[^}]*\} from "\.\/arg\.mjs";/m, "member-outcomes.mjs no longer imports isFlagLike from arg.mjs");
  assert.match(memberOutcomes, /if \(isFlagLike\(file\)\) die\("--file needs a path"\);/, "member-outcomes.mjs's --file guard drifted from arg.mjs's rule or lost its own wording");

  // The blank spelling is the one a hand-written copy has historically dropped
  // — member-outcomes.mjs's copy was `!file || file.startsWith("--")`, the rule
  // with that clause missing, and `--file "   "` was accepted for it. Nothing
  // outside arg.mjs's own predicate should spell it again.
  for (const name of ["ledger.mjs", "member-outcomes.mjs"]) {
    assert.doesNotMatch(src(name), /trim\(\) === ""/, `${name} hand-writes the blank-value rule again instead of calling isFlagLike`);
  }
});

// The two readers, run for real over the same values. `arg()` is exercised
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

  const run = (script, args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env, cwd: dir });
  const LEDGER = fileURLToPath(new URL("./ledger.mjs", import.meta.url));
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
    viaArgRaw: (args) => run(join(dir, "probe.mjs"), args),
    viaLedgerRaw: (args) => run(LEDGER, args),
  };
}

test("arg()'s reader and ledger.mjs's reader reach the same verdict — the copies cannot drift", (t) => {
  const p = probeFixture(t);

  // REFUSE on both sides. `--require-file` is #362's own case: the flag that
  // used to become the path.
  for (const value of ["--require-file", "--other", "   ", "\t"]) {
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
