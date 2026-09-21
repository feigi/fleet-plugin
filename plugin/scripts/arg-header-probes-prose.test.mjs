// #1227. `arg.mjs`'s header names the second edit sites for the refusal
// contract and quotes five commands it presents as settling: a `die()` grep,
// two `from "./arg.mjs"` greps, and two `candidates.mjs` invocations. Each was
// correct when it was written and none was executed by anything, which is the
// defect that same header argues for #563/#567 — a requirement recorded where
// nothing runs it. Measured before this file existed (#712, deferred out of
// #1223): deleting the whole `candidates.mjs` paragraph left `arg.test.mjs`,
// `shared-refusal.test.mjs`, `candidates.test.mjs` and
// `line-distance-prose.test.mjs` green.
//
// Two halves, the two sizes #1227 files together.
//
// THE PROBES. The header's commands are EXTRACTED from its comment run and RUN
// in a shell, from the directory they are written against — never restated. Two
// assertions, and both are needed. The extracted list is compared against
// `PROBES` below, so a paragraph deleted from the header reds here instead of
// quietly shrinking the set the test happens to check; that is the vacuous
// direction a derive-everything pin takes, and it is the direction #1227
// measured. What each command must ANSWER is asserted separately, so a command
// still spelled the way the header spells it, now reporting something else,
// reds too.
//
// Every expected answer is DERIVED by calling the generator that produces it —
// `makeSweep`, `makeArg`, `node:util`'s own `parseArgs` — never typed out here.
// Rewording a refusal in `arg.mjs` moves this pin with it; rewording it in one
// place only does not.
//
// THE ROSTER. Not a list of filenames: the scripts are read off the header's
// own anchored grep, and each is then RUN with a flag nothing accepts. The
// header's mechanism claim — a row binding `makeSweep` has delegated the
// unknown-flag refusal, so the grep minus `makeSweep` leaves the rows that hold
// their own — is the two containments asserted below: no row the grep leaves
// answers in `sweep()`'s generated wording, and no row it removes answers in
// anything else. A script renamed keeps the pin.
//
// CEILING, and it is the header's own. The header does not claim to NAME every
// row its grep returns — `fleet-heartbeat.mjs` and `tier-check.mjs` are both in
// that output and neither is named, and the header says the scripts it names
// "exemplify a way of qualifying, and were never the whole of it". So nothing
// here demands a paragraph per row; the roster is the grep's output, and the
// paragraphs are pinned only through the commands they carry.
//
// One row falls outside the mechanism in the other direction, and is pinned as
// the exception it is rather than hidden by a weaker assertion: `tier-check.mjs`
// neither delegates nor holds an unknown-flag refusal, so the grep over-reports
// it (#1669). Naming it is not the filename-listing #1227 rules out — the
// expected SET is still derived — it is a counted, cited exception whose whole
// job is to red when #1669 lands or when a second such row appears.
//
// `workflows/review-pr.js` is the site this grep cannot see at all, by the
// header's own argument, and its copy of the digits rule is already executed by
// `shared-refusal.test.mjs`. Left there rather than re-pinned here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { anchorAt, stripSlashGutter } from "./prose-pin.mjs";
import { makeArg, makeSweep } from "./arg.mjs";

// The header's commands are written against the plugin root (`scripts/*.mjs`),
// so that is where they run. Running them from anywhere else would test a
// different command than the one a reader would type.
const ROOT = join(import.meta.dirname, "..");
const ARG = readFileSync(join(import.meta.dirname, "arg.mjs"), "utf8");

// The header block, bounded by CODE at both ends: the start of the file and the
// first import. `runAbove` is the shared bound for a comment run above a
// declaration and does not fit — it requires the run to sit flush against its
// anchor, and a blank line separates this header from that import. The bound is
// asserted rather than assumed, in `HEADER IS THE WHOLE LEADING COMMENT RUN`
// below, so a code line landing inside it cannot pass unnoticed.
const HEADER = ARG.slice(0, anchorAt(ARG, 'import { writeSync } from "node:fs"', "arg.mjs header"));

// A command quoted in a comment block wraps twice: at the `//` gutter, and at a
// shell continuation backslash the header uses to keep a long grep readable.
// Strip the gutter first, then fold the continuation, then collapse the
// remaining whitespace — so a REWRAP of the header, which changes every one of
// those break points and nothing else, leaves the extracted command identical.
// That is the change this pin must not catch.
const FLAT = stripSlashGutter(HEADER).replace(/\\\n/g, " ").replace(/\s+/g, " ").trim();

// Code spans that are commands, not the other things this header code-quotes
// (symbol names, flag names, message fragments, `gh pr diff`). A command here
// is one a reader is meant to run from the plugin root, and both kinds the
// header carries start with their binary.
const quoted = [...FLAT.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
const commands = quoted.filter((s) => /^(?:grep|node) /.test(s));

// The pin. Deleting a header paragraph deletes its commands from `commands`,
// and this is what notices.
const PROBES = [
  `grep -ln '^function die(' scripts/*.mjs`,
  `grep -n 'from "./arg.mjs"' scripts/*.mjs | grep -v test`,
  `grep -n '^import .* from "./arg.mjs"' scripts/*.mjs | grep -v test | grep -v makeSweep`,
  "node scripts/candidates.mjs --limit",
  "node scripts/candidates.mjs --bogus",
];
const [DIE_GREP, IMPORT_GREP, ROSTER_GREP, LIMIT_PROBE, BOGUS_PROBE] = PROBES;

const sh = (cmd) => spawnSync("sh", ["-c", cmd], { cwd: ROOT, encoding: "utf8" });

// A flag no script accepts, and no prefix of one: `sweep()` and `parseArgs`
// both match a flag NAME exactly, so a token nothing declares is refused by
// whichever guard the script actually has — which is the thing being measured.
const STRAY = "--zz-no-such-flag-1227";

// What `sweep()` says, asked at run time rather than transcribed. A row whose
// refusal is this string delegated to the shared sweep; a row whose refusal is
// anything else did not.
const sweepWordingFor = (known) => {
  const saved = process.argv;
  process.argv = ["node", "probe", STRAY];
  try {
    makeSweep((m) => {
      throw new Error(m);
    })(known);
  } catch (e) {
    return e.message;
  } finally {
    process.argv = saved;
  }
  assert.fail("sweep() accepted a flag nothing declares — arg.test.mjs owns that contract, and it just changed");
};

// The wording minus the accepted-flag tail, which is per-script. The boundary
// between them is DIFFED rather than cut at the literal " — accepted:" text:
// two runs with accepted-lists that diverge at their first character share a
// prefix exactly up to wherever `sweep()` starts writing the list, whatever
// words carry it. Cutting at a hardcoded separator instead degrades silently
// on a reword — `indexOf` returns -1, `slice(0, -1)` keeps nearly the whole
// message, and a delegator answering in ITS OWN wording (which still shares
// that near-whole prefix by coincidence of the run-time only) reads as
// sweep()'s: a false accusation against an unrelated script, not a report
// that the pin needs to move.
const sweepA = sweepWordingFor(["aaa-boundary-probe"]);
const sweepB = sweepWordingFor(["zzz-boundary-probe"]);
let sharedLength = 0;
while (sharedLength < sweepA.length && sharedLength < sweepB.length && sweepA[sharedLength] === sweepB[sharedLength]) sharedLength++;
assert.ok(
  sharedLength > 0 && sharedLength < sweepA.length,
  "sweep()'s wording no longer varies with the accepted list the way this derivation needs — two different one-item lists produced identical (or entirely different) messages",
);
const SWEEP_PREFIX = sweepA.slice(0, sharedLength);

// What `arg()` says for a valued flag given no value, asked the same way.
const argWording = (() => {
  const saved = process.argv;
  process.argv = ["node", "probe", "--limit"];
  try {
    makeArg((m) => {
      throw new Error(m);
    })("limit");
  } catch (e) {
    return e.message;
  } finally {
    process.argv = saved;
  }
  assert.fail("arg() accepted --limit with no value — arg.test.mjs owns that contract, and it just changed");
})();

// What `node:util`'s `parseArgs` says, so "refuses under its OWN parseArgs" is
// checked against the parser rather than against a copy of its message.
const parseArgsWording = (() => {
  try {
    parseArgs({ args: ["--bogus"], options: {}, strict: true });
  } catch (e) {
    return e.message;
  }
  assert.fail("node:util parseArgs no longer refuses an undeclared flag in strict mode");
})();

// `file:line:text` rows, as both greps emit them.
const rows = (out) =>
  out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = /^([^:]+):(\d+):(.*)$/.exec(l);
      assert.ok(m, `unparsable grep row: ${l}`);
      return { file: m[1], text: m[3] };
    });

const scriptsOf = (out) => [...new Set(rows(out).map((r) => r.file))];

// Runs a script the way a stray flag reaches it, and reports what it
// answered. `extra` supplies argv ahead of the stray flag — needed to clear a
// delegator's own required-arg guard so a probe can reach sweep() for real,
// rather than dying earlier for an unrelated reason.
const probeArgv = (file, extra = []) => {
  const r = spawnSync("node", [file, ...extra, STRAY], { cwd: ROOT, encoding: "utf8" });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
};
const probeStray = (file) => probeArgv(file);

test("arg.mjs's header is one leading comment run, so the slice above holds prose and no code", () => {
  const code = HEADER.split("\n").filter((l) => l.trim() && !l.startsWith("//"));
  assert.deepEqual(code, [], "a non-comment line sits inside arg.mjs's header slice — re-anchor this test, never widen it");
  assert.ok(HEADER.length > 2000, "arg.mjs's header collapsed to almost nothing — the slice anchor moved");
});

test("arg.mjs's header quotes exactly the commands this file executes", () => {
  assert.deepEqual(
    commands,
    PROBES,
    "arg.mjs's header no longer quotes exactly these commands. A paragraph naming a second edit site was deleted, added, or its command reworded — update PROBES and the assertion for it, never drop the difference",
  );
});

test("the die() grep the header quotes reports none, and reports arg.mjs without its anchor", () => {
  const got = sh(DIE_GREP);
  assert.equal(got.stdout, "", `${DIE_GREP} named a script: a private module-scope die() is back`);
  assert.equal(got.status, 1, "grep reported an error rather than a clean no-match");

  // The header's reason for the `^`, executed: unanchored, the command answers
  // with the file that asserts it settles nothing. Derived from the header's
  // own command by dropping the anchor, not retyped.
  const loose = DIE_GREP.replace("'^function die('", "'function die('");
  assert.notEqual(loose, DIE_GREP, "the die() grep no longer carries the ^ anchor this test strips to make the header's point executable");
  assert.match(
    sh(loose).stdout,
    /scripts\/arg\.mjs/,
    "unanchored, the die() grep no longer reports arg.mjs — the header's reason for anchoring it has gone stale",
  );
});

test("arg.mjs has no module-scope die() declaration under any spelling, not only the header's anchored grep", () => {
  // Independent of DIE_GREP's exact anchor text: that command only proves
  // TODAY's pinned `^function die(` finds nothing, and would miss a
  // realistic reintroduction in a syntactically different form just as
  // silently as it would miss one restated in prose. Reasoned separately —
  // over ARG's own lines rather than a shell grep — so the two probes cannot
  // share a blind spot: a module-scope `die` binding starts at column zero
  // (an unindented top-level statement, optionally `export`/`async`), which
  // is what distinguishes it from the many functions in this file that take
  // or return something named `die` as a LOCAL — `makeDie`'s own returned
  // `function die(msg)` is indented and does not match.
  const dieDecl = /^(export\s+)?(default\s+)?(async\s+)?(function\*?\s+die\s*\(|const\s+die\s*=|let\s+die\s*=|var\s+die\s*=)/;
  const found = ARG.split("\n").filter((line) => dieDecl.test(line));
  assert.deepEqual(
    found,
    [],
    "arg.mjs declares a module-scope die() under a spelling the header's anchored grep would not catch — a private die() is back in a different shape",
  );
});

test("the unanchored import grep matches arg.mjs's own comment; the anchored one does not", () => {
  const loose = sh(IMPORT_GREP);
  assert.equal(loose.status, 0, `${IMPORT_GREP} matched nothing`);
  const selfRows = rows(loose.stdout).filter((r) => r.file.endsWith("arg.mjs"));
  assert.ok(
    selfRows.length > 0 && selfRows.every((r) => !r.text.trimStart().startsWith("import ")),
    "the unanchored import grep no longer reports arg.mjs's own comment rows — the header's reason for anchoring on ^import has gone stale",
  );

  const strict = sh(ROSTER_GREP);
  assert.equal(strict.status, 0, `${ROSTER_GREP} matched nothing`);
  assert.deepEqual(
    rows(strict.stdout).filter((r) => r.file.endsWith("arg.mjs")),
    [],
    "the anchored roster grep now reports arg.mjs itself — the anchor stopped doing the work the header credits it with",
  );
  assert.ok(
    rows(strict.stdout).every((r) => r.text.trimStart().startsWith("import ")),
    "the roster grep returned a row that is not an import",
  );
});

test("every script the roster grep returns refuses a stray flag in its own wording, not sweep()'s", () => {
  const roster = scriptsOf(sh(ROSTER_GREP).stdout);
  assert.ok(roster.length >= 4, `the roster grep returned only ${roster.length} rows — it has stopped finding the edit sites`);
  for (const file of roster) {
    const { status, out } = probeStray(file);
    assert.equal(status, 2, `${file} ${STRAY} exited ${status}, not 2 — a stray flag reached real work`);
    assert.ok(
      !out.includes(SWEEP_PREFIX),
      `${file} answers a stray flag in sweep()'s generated wording, yet the roster grep returns it: it has delegated the unknown-flag refusal and is no longer a second edit site`,
    );
  }
});

// Delegators whose own required-arg guard runs BEFORE sweep(): a probe
// carrying only the stray flag never reaches sweep() for these, so it never
// learns whether they hold a refusal of their own. Each entry is the minimal
// real argv (not a placeholder that would itself be refused — staleness.mjs
// treats --gone and --present as mutually exclusive, so only one is given)
// that clears exactly that script's OWN required-arg check, derived from
// reading its guard, so the stray flag can reach sweep() and this test can
// assert on what sweep() answers instead of silently skipping the script.
const GUARD_FIRST_FIXTURE = {
  "scripts/ci-state.mjs": ["--pr", "1"],
  "scripts/diff-stats.mjs": ["--pr", "1"],
  "scripts/pr-overlap.mjs": ["--a", "1", "--b", "1"],
  "scripts/staleness.mjs": ["--path", "1", "--gone", "1"],
};

test("no script the roster grep removes holds an unknown-flag refusal of its own", () => {
  // The removed rows, derived the way the grep removes them: importers that
  // bind makeSweep.
  const delegators = [
    ...new Set(
      rows(sh(IMPORT_GREP).stdout)
        .filter((r) => r.text.trimStart().startsWith("import ") && r.text.includes("makeSweep"))
        .map((r) => r.file),
    ),
  ];
  assert.ok(delegators.length >= 3, `only ${delegators.length} importers bind makeSweep — the grep's -v makeSweep arm has nothing left to remove`);

  // A guard above the sweep can answer first — a required flag the stray-only
  // probe does not supply — and such a run never names the stray. Only a
  // refusal that NAMES it is one this probe alone can credit to the script.
  const guardFirst = [];
  for (const file of delegators) {
    const { status, out } = probeStray(file);
    assert.equal(status, 2, `${file} ${STRAY} exited ${status}, not 2 — a stray flag reached real work`);
    if (out.includes(STRAY)) {
      assert.ok(
        out.includes(SWEEP_PREFIX),
        `${file} binds makeSweep, so the roster grep removes it, yet it refuses ${STRAY} in wording of its own: it is a second edit site the header's grep hides`,
      );
    } else {
      guardFirst.push(file);
    }
  }

  // Pinned, not silently skipped: a delegator falling out of this set (its
  // guard stopped intercepting) or a new one falling into it (a fresh guard
  // grew ahead of sweep()) reds here instead of quietly changing which
  // delegators the loop above actually checks — the gap #1227's review found.
  assert.deepEqual(
    [...guardFirst].sort(),
    Object.keys(GUARD_FIRST_FIXTURE).sort(),
    "the set of delegators whose required-arg guard intercepts a stray-only probe changed — update GUARD_FIRST_FIXTURE and this list together, never drop the difference",
  );

  // Clear each one's own guard for real and probe again: this is what makes a
  // GENERIC-wording unknown-flag guard visible even though it never names the
  // stray flag itself — the #365 second-edit-site shape this test guards
  // against, invisible to the NAMES-the-flag check above.
  for (const file of guardFirst) {
    const { status, out } = probeArgv(file, GUARD_FIRST_FIXTURE[file]);
    assert.equal(
      status,
      2,
      `${file} ${GUARD_FIRST_FIXTURE[file].join(" ")} ${STRAY} exited ${status}, not 2 — its own required-arg guard was not actually cleared`,
    );
    assert.ok(
      out.includes(SWEEP_PREFIX),
      `${file} binds makeSweep, so the roster grep removes it, yet — once its own required-arg guard is satisfied — it refuses ${STRAY} outside sweep()'s wording: it is a second edit site the header's grep hides`,
    );
  }
});

test("exactly one row the roster grep returns has no unknown-flag refusal at all", () => {
  const silent = scriptsOf(sh(ROSTER_GREP).stdout).filter((file) => !probeStray(file).out.includes(STRAY));
  assert.deepEqual(
    silent,
    ["scripts/tier-check.mjs"],
    "the set of roster rows that never name a stray flag changed. tier-check.mjs is the one the header's grep over-reports (#1669); if that is fixed, delete this test rather than re-point it — the assertion above already covers every row. If a NEW row appears here, a script gained an arg.mjs import without gaining a refusal, which is #365's fail-open reached from a third side",
  );
});

test("candidates.mjs refuses --limit under arg()'s generated wording", () => {
  const got = sh(LIMIT_PROBE);
  assert.equal(got.status, 2, `${LIMIT_PROBE} exited ${got.status}, not 2`);
  assert.ok(
    got.stderr.includes(argWording),
    `${LIMIT_PROBE} no longer answers with arg()'s generated "${argWording}" — the header's claim that arg()'s refusals DO reach candidates.mjs has gone stale`,
  );
});

test("candidates.mjs refuses --bogus under its own parseArgs", () => {
  const got = sh(BOGUS_PROBE);
  assert.equal(got.status, 2, `${BOGUS_PROBE} exited ${got.status}, not 2`);
  assert.ok(
    got.stderr.includes(parseArgsWording),
    `${BOGUS_PROBE} no longer answers with node:util parseArgs' own "${parseArgsWording}" — the second edit site the header names at candidates.mjs is not where it says it is`,
  );
  assert.ok(
    !got.stderr.includes(SWEEP_PREFIX),
    `${BOGUS_PROBE} now answers in sweep()'s wording — candidates.mjs routes through the shared sweep after all, and the header argues at makeSweep() that it deliberately does not`,
  );
});
