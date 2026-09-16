// Regression gate for #169: a flag given with no value must die, by name,
// rather than being read as absent or silently consumed as the following
// flag's own value.
//
// `--a`/`--b` given trailing were already caught by pr-overlap.mjs's own
// `if (!a || !b) die(...)` guard — `undefined` is falsy — so it was never a
// silent-widening site the way ci-state.mjs's `--base`/`--workflow` were (see
// feigi's PR #167 review comment). What was NOT caught: `--a` given `--b` as
// its "value" (`pr-overlap.mjs --a --b 5`) — `a` becomes the string "--b",
// passes the falsy check, and only failed later as a confusing `gh pr diff
// --b` error instead of a clear refusal naming the flag.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./pr-overlap.mjs", import.meta.url));

test("CLI: trailing --a (no value) dies (exit 2) naming the flag", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--a"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--a needs a value/);
});

test("CLI: --a followed by --b is rejected by name, not run through gh as a PR ref", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--a", "--b", "5"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--a needs a value/);
});

test("CLI: --a=5 form dies by name, not silently read as absent", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--a=5", "--b", "6"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--a needs a space-separated value/);
});

// `value.trim() === ""` was the one clause of the guard no test reached in any
// of the five scripts that then carried their own copy of it — board,
// candidates, ci-state, diff-stats, pr-overlap — so it could be deleted from
// all five at once, green. #367 has since folded those copies into arg.mjs's
// single one, which every one of the five still routes through.
test("CLI: --a given a whitespace-only value dies naming the flag", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--a", "   ", "--b", "6"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--a needs a value/);
});

// The other half of arg()'s guard: every case above is a value it must
// REFUSE. Nothing above ever hands the script a well-formed pair, so #367's
// shared arg() could return `undefined` for every accepted input and this
// file would stay green. `--a 1 --b 2` must reach gh and report a verdict.
test("CLI: well-formed --a/--b values are accepted and the CLI reports a verdict", () => {
  const bin = mkdtempSync(join(tmpdir(), "pr-overlap-bin-"));
  const gh = join(bin, "gh");
  const log = join(bin, "calls");
  // `$3` is the PR number pr-overlap.mjs passes as `gh pr diff <pr> --name-only`.
  writeFileSync(
    gh,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${log}\ncase "$3" in\n  1) echo src/shared.ts ;;\n  2) echo src/shared.ts ;;\nesac\n`,
  );
  chmodSync(gh, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, "--a", "1", "--b", "2"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const calls = readFileSync(log, "utf8").trim().split("\n");
  rmSync(bin, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.deepEqual(payload, {
    a: 1,
    b: 2,
    files: ["src/shared.ts"],
    modules: ["shared"],
    dirs: ["src"],
    prose: [],
    proseUnrun: null,
    signal: "files",
  });
  // #705's signal costs nothing on a pair with no data file on either side,
  // which is nearly every pair. An unconditional full-diff read would double
  // this tool's `gh` traffic and hand its ENOBUFS cliff to every caller, so
  // the two `--name-only` calls are the whole bill here.
  assert.deepEqual(calls, ["pr diff 1 --name-only", "pr diff 2 --name-only"]);
});

// ---------------------------------------------------------------------------
// #705: the prose-citation signal.
//
// A fixture is one throwaway directory holding a fake `gh` on PATH, a
// `<pr>.names` and `<pr>.diff` per PR, and a real git repo the script runs
// inside — the last one because the basename-ambiguity guard counts with
// `git ls-files`, so a test that cannot control the tree cannot reach the
// branch where a basename is dropped. An ABSENT `<pr>.diff` makes the fake
// `gh` exit non-zero, which is how the degradation case below is driven.
function fixture({ prs, tracked = [] }) {
  const root = mkdtempSync(join(tmpdir(), "pr-overlap-prose-"));
  const bin = join(root, "bin");
  const data = join(root, "data");
  const repo = join(root, "repo");
  for (const d of [bin, data, repo]) mkdirSync(d);
  for (const [pr, { names, diff }] of Object.entries(prs)) {
    writeFileSync(join(data, `${pr}.names`), `${names.join("\n")}\n`);
    if (diff !== undefined) writeFileSync(join(data, `${pr}.diff`), diff);
  }
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    "#!/bin/sh\n" +
      `case "$4" in\n` +
      `  --name-only) cat ${data}/"$3".names ;;\n` +
      `  *) cat ${data}/"$3".diff ;;\n` +
      "esac\n",
  );
  chmodSync(gh, 0o755);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const f of tracked) {
    mkdirSync(join(repo, dirname(f)), { recursive: true });
    writeFileSync(join(repo, f), "x\n");
  }
  if (tracked.length) execFileSync("git", ["add", "--", ...tracked], { cwd: repo });
  return { root, bin, repo };
}

function run({ prs, tracked }, a, b) {
  const fx = fixture({ prs, tracked });
  const r = spawnSync(process.execPath, [SCRIPT, "--a", String(a), "--b", String(b)], {
    encoding: "utf8",
    cwd: fx.repo,
    env: { ...process.env, PATH: `${fx.bin}:${process.env.PATH}` },
  });
  rmSync(fx.root, { recursive: true, force: true });
  return r;
}

// A unified diff body for one file. Only hunk lines matter to the scan; the
// `+++`/`---` headers are present because they are what the parser has to
// skip — they carry the path itself, so a parser that reads them finds every
// data file "cited" by the PR that changed it.
const hunk = (file, lines) =>
  `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1,3 +1,3 @@\n${lines.map((l) => l + "\n").join("")}`;

const TSV = "docs/metrics/tier-outcomes.tsv";

// The defect itself. #704 appended rows to the TSV, #703 held the prose that
// reads it, and the two share no path, no module and no directory — so the
// three original signals answered `none`, which is the strongest clear this
// tool has and the one that licenses a merge.
test("prose: a data file named in the other PR's diff fires signal=prose", () => {
  const r = run(
    {
      prs: {
        1: { names: [TSV], diff: hunk(TSV, ["+1490\timpl-1490\tclass=routine"]) },
        2: {
          names: ["plugin/skills/run-team/SKILL.md"],
          diff: hunk("plugin/skills/run-team/SKILL.md", [
            " **Recount before citing any of this.**",
            `+grep -vc '^#' ${TSV}`,
          ]),
        },
      },
    },
    1,
    2,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.signal, "prose");
  assert.deepEqual(payload.files, []);
  assert.deepEqual(payload.dirs, []);
  assert.equal(payload.proseUnrun, null);
  assert.deepEqual(payload.prose, [
    { data: TSV, citedBy: "plugin/skills/run-team/SKILL.md", token: TSV, line: `+grep -vc '^#' ${TSV}` },
  ]);
  // The witness is the whole value of a weak signal: one read disproves it.
  assert.match(r.stderr, /cited by plugin\/skills\/run-team\/SKILL\.md/);
});

// Which PR holds the rows and which holds the prose is not knowable from the
// flags, so both directions are scanned. A one-directional wiring passes the
// test above and misses half the pairs.
test("prose: fires when the data file is on --b and the prose on --a", () => {
  const r = run(
    {
      prs: {
        1: {
          names: ["plugin/commands/run-merge-bot.md"],
          diff: hunk("plugin/commands/run-merge-bot.md", [`+read ${TSV} before ruling`]),
        },
        2: { names: [TSV], diff: hunk(TSV, ["+1490\timpl-1490"]) },
      },
    },
    1,
    2,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.signal, "prose");
  assert.deepEqual(payload.prose.map((h) => h.citedBy), ["plugin/commands/run-merge-bot.md"]);
});

// A diff's `+++`/`--- ` lines carry the path and begin with the same
// characters a hunk line does, so a scan that reads them attributes a
// citation to the patch's own plumbing. Reachable whenever a text file's path
// CONTAINS a data file's — `docs/x.json.md` documenting `a/x.json` is the
// ordinary spelling of that — and the witness it produces is a diff header,
// which is the confident nonsense `moduleOf` above refuses to emit.
test("prose: a diff's own file headers are not read as citations", () => {
  const r = run(
    {
      prs: {
        1: { names: ["a/x.json"], diff: hunk("a/x.json", ['+{"x":1}']) },
        2: {
          names: ["docs/x.json.md"],
          diff: hunk("docs/x.json.md", ["+unrelated prose that names no file"]),
        },
      },
      tracked: ["a/x.json", "docs/x.json.md"],
    },
    1,
    2,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.deepEqual(payload.prose, []);
  assert.equal(payload.signal, "none");
});

// The other half, and the one that decides whether this signal is usable:
// #703 DID touch `run-team/SKILL.md`, the very file whose tier-guard
// paragraph reads the TSV, and was still correctly unrelated — its hunks
// never reach that paragraph. A whole-FILE read fires here, permanently,
// because SKILL.md names the TSV in nine places; reading the DIFF is what
// reproduces merge-bot-9's hand-run clearing grep. Re-measured live on
// #703 vs #704: `signal=none prose=0`, `proseUnrun: null`.
test("prose: a citing file edited AWAY from its citation does not fire", () => {
  const r = run(
    {
      prs: {
        1: { names: [TSV], diff: hunk(TSV, ["+1490\timpl-1490"]) },
        2: {
          names: ["plugin/skills/run-team/SKILL.md"],
          diff: hunk("plugin/skills/run-team/SKILL.md", [
            " Its four duties are a checklist — audit the worktree,",
            "+report, and the merge gate downstream still catches it.",
          ]),
        },
      },
    },
    1,
    2,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.signal, "none");
  assert.deepEqual(payload.prose, []);
  // An empty result is only a clear when the scan actually covered the diff.
  assert.equal(payload.proseUnrun, null);
});

// A bare stem with no extension is a word, not a reference. Every one of
// run-team/SKILL.md's nine references to this file is written with the
// extension — `docs/metrics/tier-outcomes.tsv` ×7, `tier-outcomes.tsv` ×2
// (measured) — so matching the stem buys no coverage and is where the false
// positives the ticket warned about would come from.
test("prose: a bare stem with no extension is never matched", () => {
  const r = run(
    {
      prs: {
        1: { names: [TSV], diff: hunk(TSV, ["+1490\timpl-1490"]) },
        2: {
          names: ["docs/notes.md"],
          diff: hunk("docs/notes.md", ["+the tier-outcomes corpus is confounded with calendar date"]),
        },
      },
    },
    1,
    2,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).prose, []);
});

// `moduleOf`'s measurement, one file type over: a shared basename is not a
// shared file. Two `config.json` in unrelated subtrees, and the citing PR
// names the OTHER one — the full paths differ, so the only thing that could
// fire is the basename, and the tree says that basename is ambiguous.
// Derived from `git ls-files` rather than a deny-list, so it needs no
// upkeep; delete the count and this reds.
test("prose: an ambiguous basename is dropped, and the full path still decides", () => {
  const tracked = ["a/config.json", "b/config.json"];
  const base = {
    prs: {
      1: { names: ["a/config.json"], diff: hunk("a/config.json", ['+{"x":1}']) },
      2: { names: ["docs/notes.md"], diff: hunk("docs/notes.md", ["+see b/config.json for the other one"]) },
    },
    tracked,
  };
  assert.deepEqual(JSON.parse(run(base, 1, 2).stdout).prose, []);

  // Positive control for the same tree: the ambiguity guard drops basenames,
  // never paths, so naming the changed file BY PATH still fires. Without
  // this, a guard that dropped the data file entirely would pass above.
  const byPath = {
    ...base,
    prs: {
      ...base.prs,
      2: { names: ["docs/notes.md"], diff: hunk("docs/notes.md", ["+see a/config.json for the one that moved"]) },
    },
  };
  const payload = JSON.parse(run(byPath, 1, 2).stdout);
  assert.equal(payload.signal, "prose");
  assert.deepEqual(payload.prose.map((h) => h.token), ["a/config.json"]);
});

// Ranked below `dirs` so it can only ever turn a `none` into something. A
// ladder that put it first would relabel every existing verdict, and the
// count on the summary line is what keeps the evidence visible underneath a
// stronger one.
test("prose: a prose hit never masks a stronger signal, and is still reported", () => {
  const r = run(
    {
      prs: {
        1: { names: [TSV, "docs/notes.md"], diff: hunk(TSV, ["+1490\timpl-1490"]) },
        2: { names: ["docs/notes.md"], diff: hunk("docs/notes.md", [`+cites ${TSV} here`]) },
      },
    },
    1,
    2,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.signal, "files");
  assert.deepEqual(payload.files, ["docs/notes.md"]);
  assert.equal(payload.prose.length, 1);
  assert.match(r.stderr, /prose=1/);
  // The caveat block is keyed on the COUNT, not on `signal`: under a `files`
  // verdict the ladder hides the stronger evidence, and the witness is what
  // the caller disproves the pair with. Key it on `signal` and this reds.
  assert.match(r.stderr, /prose citation/);
  assert.match(r.stderr, new RegExp(`${TSV} cited by docs/notes\\.md`));
});

// Context lines are searched along with added and removed ones, deliberately:
// the hazard is prose being rewritten NEXT TO a citation, not only a citation
// being typed, and merge-bot-9's own clearing grep on #703 counted context
// too. A scan narrowed to `+`/`-` lines misses the whole rewrite-in-place
// case, which is the shape #705 describes — a paragraph edited underneath
// rows landing beneath it.
test("prose: a citation on a context line counts", () => {
  const r = run(
    {
      prs: {
        1: { names: [TSV], diff: hunk(TSV, ["+1490\timpl-1490"]) },
        2: {
          names: ["plugin/skills/run-team/SKILL.md"],
          diff: hunk("plugin/skills/run-team/SKILL.md", [
            `  grep -vc '^#' ${TSV}`,
            "+recount before citing any of this",
          ]),
        },
      },
    },
    1,
    2,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.equal(payload.signal, "prose");
  assert.deepEqual(payload.prose.map((h) => h.token), [TSV]);
});

// The degradation, and the reason it is a field rather than a `die()`. A
// run-artifact PR appends thousands of rows, so the full-patch read is the
// one call here with a real ENOBUFS cliff — and this signal is ranked last,
// so it must never be the reason the three above become unavailable. An
// empty `prose[]` with no reason beside it would be byte-identical to a
// clean scan, which is #705's own failure mode one level in.
test("prose: a full-diff read that fails names itself and leaves the other three answerable", () => {
  const r = run(
    {
      prs: {
        1: { names: [TSV], diff: hunk(TSV, ["+1490\timpl-1490"]) },
        2: { names: ["plugin/skills/run-team/SKILL.md"] }, // no .diff: the fake gh exits non-zero
      },
    },
    1,
    2,
  );
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const payload = JSON.parse(r.stdout);
  assert.deepEqual(payload.prose, []);
  assert.match(payload.proseUnrun, /gh pr diff 2 failed/);
  assert.equal(payload.signal, "none");
  assert.match(r.stderr, /prose scan INCOMPLETE/);
  assert.match(r.stderr, /does not clear the same-section case/);
});

// #878: `--a 0`/`--b 0` is the row the `=== null` absence check exists for,
// and the one a later "simplification" back to `!a || !b` silently breaks:
// numArg() returns a NUMBER, so `!a` is true for a zero the caller plainly
// GAVE, and the usage die above would then answer it as though `--a` were
// never given at all. Companion to arg.test.mjs's identical row for
// diff-stats.mjs and ci-state.test.mjs's own for `--pr` — #878's own comment
// names all three callers as sharing this contract, and only diff-stats.mjs
// had this row before.
//
// `strictEqual` on both fields, same reason as the well-formed test above: a
// payload reading `a`/`b` back as the string "0" would satisfy a loose check
// while breaking every consumer that keys on a number.
test("#878: --a 0/--b 0 reach gh rather than drawing the usage line for an absent flag", () => {
  const bin = mkdtempSync(join(tmpdir(), "pr-overlap-bin-"));
  const gh = join(bin, "gh");
  writeFileSync(gh, '#!/bin/sh\ncase "$3" in\n  0) echo src/shared.ts ;;\nesac\n');
  chmodSync(gh, 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, "--a", "0", "--b", "0"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  rmSync(bin, { recursive: true, force: true });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stderr, /usage:/, `--a 0/--b 0 was answered as an absent flag: ${r.stderr}`);
  const payload = JSON.parse(r.stdout);
  assert.strictEqual(payload.a, 0, `a zero --a must survive to the payload as 0: ${r.stdout}`);
  assert.strictEqual(payload.b, 0, `a zero --b must survive to the payload as 0: ${r.stdout}`);
});
