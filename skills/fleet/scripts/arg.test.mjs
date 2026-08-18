import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripComments } from "./strip-comments.mjs";

const ARG_MODULE = fileURLToPath(new URL("./arg.mjs", import.meta.url));

// #367 replaced seven private copies of die() with arg.mjs's makeDie(), and
// that migration is the load-bearing half of the change: board.mjs and
// ledger.mjs were still on the async console.error shape #176/#328/#363 exist
// to kill, and the other five on writeSync variants that had drifted apart.
// Nothing pinned the wiring. Reverting board.mjs and ledger.mjs to their
// pre-#367 console.error die() left the whole suite green at 640/640
// (measured), so the bug this refactor closes could walk straight back in on
// the next edit or merge resolution.
//
// THREE assertions per consumer, because each alone is vacuous:
//   - the WIRING line alone pins a NAME, not a module. candidates.mjs can
//     declare its own local console.error makeDie(), keep the wiring line
//     byte-identical, and the suite stays green at 640/640 (measured).
//   - the IMPORT alone leaves a script free to import makeDie and then bind
//     die to something else entirely.
//   - both together still miss a wrong NAME CONSTANT: `const NAME =
//     "wrongname"` makes every refusal claim to come from another script, and
//     the full suite stays green for six of the seven (measured — only
//     candidates is covered, by its own `/^candidates: …/m` assertions).
//
// The SHAPE makeDie() itself must have (try/catch around writeSync) is pinned
// in candidates.test.mjs, next to the EAGAIN race that motivates it. This file
// pins that every consumer actually reaches it — a source text-lift pin tests
// a COPY, so the call site is what makes the lifted shape load-bearing.
//
// Line-anchored under /m where an anchor helps, but deliberately WITHOUT `$`
// terminators: a trailing comment on a pinned line is a legitimate edit and
// must not turn these red (measured).
//
// The list is spelled out rather than discovered by globbing for files that
// import arg.mjs: a discovered set silently SHRINKS when a consumer drops the
// import, which is precisely the regression being pinned. A consumer added
// later has to be added here deliberately.
const CONSUMERS = ["board", "candidates", "ci-state", "diff-stats", "fleet-tick", "ledger", "pr-overlap"];

test("every fleet script wires die() to arg.mjs's makeDie under its own NAME — the #367 migration, pinned", () => {
  for (const name of CONSUMERS) {
    const src = stripComments(readFileSync(fileURLToPath(new URL(`./${name}.mjs`, import.meta.url)), "utf8"));
    assert.match(
      src,
      /^import \{[^}]*\bmakeDie\b[^}]*\} from "\.\/arg\.mjs";/m,
      `${name}.mjs must import makeDie from ./arg.mjs, not define its own die()`,
    );
    assert.match(
      src,
      /^const die = makeDie\(NAME\);/m,
      `${name}.mjs must bind die to makeDie(NAME) at module scope`,
    );
    assert.match(
      src,
      new RegExp(`const NAME = "${name}";`),
      `${name}.mjs's NAME must be its own script name, or its refusals misidentify themselves`,
    );
  }
});

// The leading newline in makeDie()'s writeSync is documented there as
// "load-bearing, not formatting", and nothing pinned it: dropping it left all
// 640 tests green (measured). Every existing refusal assertion matches
// line-anchored against stderr that carries no concurrently-draining child
// output — which is the exact condition the newline exists for, so none of
// them can see it.
//
// Pinned behaviourally rather than as another source regex: the harm is a
// runtime property (the refusal landing mid-line behind a partial line already
// on fd 2), and a regex over the template literal would pin the spelling while
// still proving nothing about what reaches the fd.
test("die()'s refusal starts its own line even when a partial line is already on fd 2", () => {
  const dir = mkdtempSync(join(tmpdir(), "arg-die-"));
  writeFileSync(join(dir, "arg.mjs"), readFileSync(ARG_MODULE));
  writeFileSync(join(dir, "run.mjs"), [
    'import { writeSync } from "node:fs";',
    'import { makeDie } from "./arg.mjs";',
    'writeSync(2, "forwarded child stderr with no trailing newline");',
    'makeDie("probe")("refused");',
    "",
  ].join("\n"));

  const r = spawnSync(process.execPath, [join(dir, "run.mjs")], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^probe: refused$/m);
});

// ── #365: a flag name no script reads ────────────────────────────────────────
//
// The guards above answer "was this flag given well?". Nothing answered "was a
// flag given that nothing reads?" — a misspelled name is never looked for, so
// `ci-state.mjs --pr 5 --basee main` compared against the DEFAULT base and
// returned a real, wrong verdict at exit 0/1. The fleet gates PR-green on that
// verdict.
//
// Driven per script rather than only against makeSweep, because the unit
// contract below passes just as well with the call site missing: what has to
// hold is that each script REACHES it, with a set that contains the name it
// misspelled. The matrix is spelled out for the same reason CONSUMERS above is
// — a discovered set shrinks silently when a caller drops the call.
//
// candidates.mjs is in the matrix but is NOT a sweep() caller: it refuses
// through its own parseArgs (#173), which additionally rejects a bare
// positional the shared sweep must accept (board.mjs's subcommands are that
// shape). Pinned on the OUTCOME both mechanisms owe — exit 2, the stray named,
// no query — so the row stays honest either way.
const STRAYS = [
  { script: "board", argv: ["build", "--ledgerr", "x"], stray: "--ledgerr" },
  { script: "candidates", argv: ["--require-labell", "x"], stray: "--require-labell" },
  { script: "ci-state", argv: ["--pr", "42", "--basee", "main"], stray: "--basee" },
  { script: "diff-stats", argv: ["--pr", "42", "--basee", "main"], stray: "--basee" },
  { script: "pr-overlap", argv: ["--a", "5", "--b", "6", "--basee", "main"], stray: "--basee" },
];

// A `gh` that records the fact of being called and then fails. Two jobs: it
// keeps a regressed sweep off this repo's live GitHub data, and its receipt
// file is what pins "before any gh call" — assert.doesNotMatch on stderr would
// pass just as well for a script that queried and stayed quiet about it.
function stubGhBin() {
  const dir = mkdtempSync(join(tmpdir(), "arg-sweep-"));
  const receipt = join(dir, "gh-was-called");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$@" >> ${receipt}\nexit 1\n`);
  chmodSync(join(dir, "gh"), 0o755);
  return { dir, receipt };
}

for (const { script, argv, stray } of STRAYS) {
  test(`${script}.mjs refuses the unknown flag ${stray} by name, before any query`, () => {
    const { dir, receipt } = stubGhBin();
    const r = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(`./${script}.mjs`, import.meta.url)), ...argv],
      { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
    );
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
    assert.ok(
      r.stderr.includes(stray),
      `${script}.mjs refused without naming ${stray} — a caller cannot fix a typo it is not shown: ${r.stderr}`,
    );
    // `if` rather than assert.ok(!existsSync(...), msg): a template message is
    // built eagerly, so reading the receipt inline throws ENOENT on the PASSING
    // path — the failure this file hit on its first run.
    if (existsSync(receipt)) assert.fail(`${script}.mjs reached gh before refusing ${stray}: ${readFileSync(receipt, "utf8")}`);
  });
}

// The other half, and the one the ticket calls worse than the bug: a sweep
// that refuses a working invocation. Each script's own suite drives its full
// known set through its own stub rig (ci-state.test.mjs, board-cli.test.mjs);
// what belongs HERE is the shape rule those sets are read by, because getting
// it wrong refuses every caller of every script at once.
//
// Written against a throwaway consumer rather than a real script so the four
// cases are visible in one place — the real call sites are pinned by the
// matrix above and by their own suites' accept tests.
//
// The probe calls sweep BEFORE arg(), which is the reverse of what the call
// sites do, and deliberately: with arg() first it dies on `--base=main` on its
// own, so the `=` case below asserts arg()'s behaviour and pins nothing about
// the sweep — measured, it stayed green with the `=` split deleted. Sweep-first
// is also the real ordering wherever the flag's own arg() runs later, which is
// every board.mjs flag and ci-state's --workflow-file.
//
// The below-the-guards ordering the call sites use is not pinned here but
// behaviourally, by diff-stats.test.mjs's `--pr --json` case: measured, hoisting
// diff-stats.mjs's sweep above its `if (!pr)` guard turns that red.
function runSweep(argv) {
  const dir = mkdtempSync(join(tmpdir(), "arg-sweep-unit-"));
  writeFileSync(join(dir, "arg.mjs"), readFileSync(ARG_MODULE));
  writeFileSync(join(dir, "run.mjs"), [
    'import { makeDie, makeArg, makeSweep } from "./arg.mjs";',
    'const die = makeDie("probe");',
    'makeSweep(die)(["base", "quiet"]);',
    'const value = makeArg(die)("base");',
    'console.log(`ok base=${value}`);',
    "",
  ].join("\n"));
  return spawnSync(process.execPath, [join(dir, "run.mjs"), ...argv], { encoding: "utf8" });
}

test("sweep accepts a subcommand, a value and every known flag — the invocations it must not break", () => {
  // board.mjs's `build`/`serve` are argv[2] positionals and `main` is a value
  // that would read as a flag name if the sweep looked past the `--` prefix.
  // One case each, plus a boolean known flag, so a sweep narrowed to any one
  // of the three goes red here.
  const r = runSweep(["build", "--base", "main", "--quiet"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok base=main$/m);
});

test("sweep refuses a stray flag even when every required flag is well-formed", () => {
  // The live shape: nothing else is wrong, so no other guard fires and the
  // script would otherwise run to a confident verdict on its defaults.
  const r = runSweep(["--base", "main", "--bogus", "x"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /^probe: unknown flag --bogus — accepted: --base, --quiet$/m);
});

test("sweep leaves --known=value to arg()'s wording and still catches --unknown=value", () => {
  // Looked up by NAME, so `--base=main` falls through to the #169/#364 guards
  // that have the specific thing to say about it. Reversing that would replace
  // "needs a space-separated value" with a generic unknown-flag line, and the
  // caller would go hunting a typo that is not there.
  const known = runSweep(["--base=main"]);
  assert.equal(known.status, 2, known.stderr);
  assert.match(known.stderr, /--base needs a space-separated value/);

  // The same form on a name nothing reads is still the sweep's, and it echoes
  // the token as typed rather than the parsed name.
  const unknown = runSweep(["--base", "main", "--basee=x"]);
  assert.equal(unknown.status, 2, unknown.stderr);
  assert.match(unknown.stderr, /unknown flag --basee=x/);
});

test("sweep refuses a stray that arrives BEFORE the good flags, not only after them", () => {
  // Position must not decide it. A loop that stopped at the first known flag,
  // or one anchored at a fixed argv index, passes the case above and fails
  // this one — the shape #462 caught in has().
  const r = runSweep(["--bogus", "--base", "main"]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unknown flag --bogus/);
});
