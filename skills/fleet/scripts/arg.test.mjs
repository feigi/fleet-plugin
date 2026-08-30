import { test } from "node:test";
import assert from "node:assert";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
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

// ── #299/#328: the guard around die()'s own writeSync, EXECUTED ───────────
//
// makeDie()'s try/catch exists because fd 2 goes non-blocking once enough
// forwarded child stderr is queued on a pipe: writeSync then throws EAGAIN,
// and uncaught that throw skips process.exit(2), leaving Node's default exit
// 1. For ci-state.mjs the inversion is not a confusing failure but a WRONG
// ANSWER — its own vocabulary spends 1 on "gate not satisfied", so a tool that
// could not read reads as a legitimate verdict the fleet then gates on.
//
// candidates.test.mjs already pins the guard's source SHAPE, and that pin is
// deterministic — but it is a text pin, and it stops at `try { writeSync(2,`.
// It says nothing about what the catch does or whether the exit below still
// runs: `catch { process.exit(1); }` satisfies it (measured, green) and is the
// whole defect back. Nothing in this repo EXECUTED the catch until here.
//
// Two tests, because neither covers the other and only one of them works on
// every platform — see each for its own measurements.

test("die() keeps exit 2 when its own writeSync throws — the guard executed, not lifted", () => {
  // The write is made to fail deterministically instead of by racing a pipe:
  // fd 2 is closed, so writeSync throws EBADF. A different errno from the
  // EAGAIN in the field, the same and only thing die() promises about it — the
  // message may be lost, the exit code may not.
  //
  // Measured on darwin: guarded, exit 2; with the try/catch reverted, exit 1.
  // That is the #299 inversion itself, reproduced without the race, so this is
  // the assertion that discriminates on a machine where EAGAIN never fires.
  const dir = mkdtempSync(join(tmpdir(), "arg-die-throw-"));
  writeFileSync(join(dir, "arg.mjs"), readFileSync(ARG_MODULE));
  writeFileSync(join(dir, "run.mjs"), [
    'import { closeSync } from "node:fs";',
    'import { makeDie } from "./arg.mjs";',
    "closeSync(2);",
    'makeDie("probe")("refused");',
    "",
  ].join("\n"));

  const r = spawnSync(process.execPath, [join(dir, "run.mjs")], { encoding: "utf8" });
  // No stderr to quote in the message — the fd this process would report on is
  // the one the test closed.
  assert.equal(r.status, 2, `exit ${r.status}: die()'s writeSync threw and took the exit code with it`);
});

// The three scripts #328 names plus fleet-tick, end to end. Each forwards gh's
// own stderr (execFileSync with no `stdio`, so Node re-emits it through the
// ASYNC process.stderr) and only then refuses through die() — so the flood has
// to come from gh, not from the test, or fd 2 is never the one under pressure.
// That FORWARDS-then-refuses shape is the entry rule for this table, not
// "reaches die()", which every consumer does.
//
// Spelled out rather than derived from CONSUMERS above, because each consumer
// that is absent is absent for its own reason and none of them is "has no
// gh-failure path": candidates carries its own copy of this row already
// (candidates.test.mjs, at the JQ_OVERRIDE that motivated the fix); ledger
// CAPTURES gh's stderr (`stdio: ["ignore", "pipe", "pipe"]`, ledger.mjs:441)
// instead of forwarding it, so fd 2 is never the fd under pressure; board LOGS
// a failed gh and returns null (tryRun, board.mjs:76-79) rather than refusing, so
// it has no exit 2 to invert in the first place. fleet-tick is here because it
// does forward and does refuse (fleet-tick.mjs:177-184) — measured at 65,613 B
// forwarded and exit 2 — it only needs a wordier argv to reach gh, which is a
// reason to spell the argv out, not a reason to leave the path ungated.
// A consumer added later belongs here deliberately.
const GH_FLOOD = [
  { script: "ci-state", argv: ["--pr", "42"] },
  { script: "diff-stats", argv: ["--pr", "42"] },
  { script: "pr-overlap", argv: ["--a", "5", "--b", "6"] },
  { script: "fleet-tick", argv: ["--implementers", "1", "--reviewers", "1", "--merge-bots", "1", "--pool", "1"] },
];

// A `gh` that writes exactly `bytes` to stderr and then fails, so the script
// under test takes its execFileSync catch. The payload is a file the stub
// `cat`s rather than shell-generated, to keep the byte count exact.
function runWithFloodingGh(script, argv, bytes) {
  const dir = mkdtempSync(join(tmpdir(), "arg-die-flood-"));
  writeFileSync(join(dir, "flood"), "z".repeat(bytes));
  writeFileSync(join(dir, "gh"), `#!/bin/sh\ncat "${join(dir, "flood")}" >&2\nexit 1\n`, { mode: 0o755 });
  return spawnSync(
    process.execPath,
    [fileURLToPath(new URL(`./${script}.mjs`, import.meta.url)), ...argv],
    { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
  );
}

for (const { script, argv } of GH_FLOOD) {
  test(`${script}.mjs still exits 2 when gh fails behind a stderr larger than the pipe buffer`, () => {
    // The row the guard must NOT change. A catch around the write could just as
    // easily swallow the refusal on the ordinary path, or return before the
    // exit — so the small case pins both halves: the line lands, the code is 2.
    // Anchored on the script's own NAME prefix only, not the wording after it,
    // so rephrasing a refusal is not this test's business.
    const ordinary = runWithFloodingGh(script, argv, 64);
    assert.equal(ordinary.status, 2, `expected exit 2 on the ordinary path, got ${ordinary.status}: ${ordinary.stderr}`);
    assert.match(ordinary.stderr, new RegExp(`^${script}: `, "m"), `${script}.mjs refused without saying so: ${ordinary.stderr}`);

    // The row that inverted. Platform-bound and therefore a CI gate, not a
    // local one: measured on darwin, all four of these still exit 2 with the
    // try/catch reverted (4/4) — EAGAIN never fires there, which is why the
    // deterministic test above exists.
    //
    // The Linux rates are #328's, read off that issue's body rather than
    // measured here: the #322 review recorded the unfixed inversion per script
    // at 5/10, 6/10, 7/10; a second pass at 4/10, 3/10, 0/10 and then 6/10,
    // 4/10; a third harness at 1/40, 0/40, 0/40 against a self-validating 32/40
    // control. So the unfixed span is 0/10 to 7/10 — one script read 0/10 in a
    // pass that read 4/10 and 3/10 for its siblings — and the guard drops all
    // three to 0/10 in the passes that measured it. #328's own conclusion is
    // that the RATE is machine-dependent and only the MECHANISM is confirmed,
    // so a single green Linux run is not evidence the guard is present; the
    // deterministic test above is what pins that, on every platform.
    //
    // candidates.test.mjs's 7/15 unfixed / 0/20 fixed is a DIFFERENT
    // experiment — candidates.mjs under JQ_OVERRIDE (#299) — not these scripts
    // under a gh stub. The two are not one series; neither figure carries over.
    const flooded = runWithFloodingGh(script, argv, 200_000);
    assert.ok(
      flooded.stderr.length > 60_000,
      `gh's forwarded stderr must exceed the pipe buffer or this pins nothing, got ${flooded.stderr.length}`,
    );
    assert.equal(flooded.status, 2, `expected exit 2 behind ${flooded.stderr.length} B of forwarded stderr, got ${flooded.status}`);
  });
}

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
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$@" >> ${receipt}\nexit 1\n`, { mode: 0o755 });
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

// ── #463: a bare or single-dash token nothing reads ──────────────────────
//
// The matrix above pins sweep()'s bound: it only ever refuses a
// `--`-prefixed token, by design (its own comment, and #365's triage ruling
// that board.mjs's `build`/`serve` must stay out of reach). A bare word or a
// single dash — the likelier typo, since the caller plainly meant a flag —
// rode through in total silence: `ci-state.mjs --pr 42 basee main` computed
// a real, wrong verdict at exit 0/1 against the default base, the same
// fail-open harm as #365 reached from the positional side. makeStray()
// closes it because it knows which names take a value, so `-1` on
// `--spend-since` is not mistaken for one of these.
//
// board.mjs is the one row here with a positional of its own, so its case
// pairs a valid subcommand with an EXTRA stray, rather than replacing the
// subcommand — an unrecognised subcommand on its own (`board.mjs junk`) is
// the pre-existing "usage: board.mjs build|serve" die and not this fix's
// business, per board.mjs's own comment on where stray() is called from.
const STRAY_POSITIONALS = [
  { script: "board", argv: ["build", "--ledger", "x", "junk"], stray: "junk" },
  { script: "ci-state", argv: ["--pr", "42", "basee", "main"], stray: "basee" },
  { script: "ci-state", argv: ["--pr", "42", "-basee", "main"], stray: "-basee" },
  { script: "diff-stats", argv: ["--pr", "42", "stray"], stray: "stray" },
  { script: "pr-overlap", argv: ["--a", "5", "--b", "6", "stray"], stray: "stray" },
];

for (const { script, argv, stray } of STRAY_POSITIONALS) {
  test(`${script}.mjs refuses the stray positional '${stray}' by name, before any query`, () => {
    const { dir, receipt } = stubGhBin();
    const r = spawnSync(
      process.execPath,
      [fileURLToPath(new URL(`./${script}.mjs`, import.meta.url)), ...argv],
      { cwd: dir, encoding: "utf8", env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } },
    );
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}: ${r.stderr}`);
    assert.ok(
      r.stderr.includes(stray),
      `${script}.mjs refused without naming ${stray}: ${r.stderr}`,
    );
    if (existsSync(receipt)) assert.fail(`${script}.mjs reached gh before refusing ${stray}: ${readFileSync(receipt, "utf8")}`);
  });
}

// The unit-level rules stray() itself must hold, driven against a throwaway
// consumer the same way runSweep() above drives sweep() — the real call
// sites are pinned by the matrix above and by board.test.mjs's serve-side
// sibling ("CLI: serve refuses a stray positional the same way build does").
function runStray(argv, valueFlags, positionals) {
  const dir = mkdtempSync(join(tmpdir(), "arg-stray-unit-"));
  writeFileSync(join(dir, "arg.mjs"), readFileSync(ARG_MODULE));
  writeFileSync(join(dir, "run.mjs"), [
    'import { makeDie, makeStray } from "./arg.mjs";',
    'const die = makeDie("probe");',
    `makeStray(die)(${JSON.stringify(valueFlags)}, ${JSON.stringify(positionals)});`,
    'console.log("ok");',
    "",
  ].join("\n"));
  return spawnSync(process.execPath, [join(dir, "run.mjs"), ...argv], { encoding: "utf8" });
}

// The pin the naive widenings both fail, named in #463's own AC: a value that
// looks like a flag (`startsWith("-")` would refuse it) on a name stray()
// was TOLD takes one.
test("stray() accepts a negative value on a declared value flag", () => {
  const r = runStray(["--spend-since", "-1"], ["spend-since"], []);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ok$/m);
});

test("stray() accepts the one declared positional and refuses a second", () => {
  const ok = runStray(["build"], [], ["build", "serve"]);
  assert.equal(ok.status, 0, ok.stderr);
  const extra = runStray(["build", "junk"], [], ["build", "serve"]);
  assert.equal(extra.status, 2, extra.stderr);
  assert.match(extra.stderr, /unexpected argument 'junk'/);
});

test("stray() refuses a bare positional on a script that declares none", () => {
  const r = runStray(["junk"], [], []);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unexpected argument 'junk'/);
});

test("stray() refuses a single-dash token the same way as a bare word", () => {
  const r = runStray(["-basee"], [], []);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unexpected argument '-basee'/);
});

test("stray() refuses a stray that arrives BEFORE a known value flag, not only after", () => {
  const r = runStray(["junk", "--pr", "42"], ["pr"], []);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /unexpected argument 'junk'/);
});

// `--`-prefixed tokens are never this guard's business, known or not — that
// is sweep()'s bound, unchanged (#463's own comment on makeStray). Run
// without sweep() ahead of it, same as runSweep()'s own probe convention, so
// this proves stray()'s OWN bound rather than sweep() having caught it first.
test("stray() leaves a `--`-prefixed token alone, even an unknown one", () => {
  const r = runStray(["--bogus"], [], []);
  assert.equal(r.status, 0, r.stderr);
});

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
