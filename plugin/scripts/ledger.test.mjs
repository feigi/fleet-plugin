// Regression gate for `ledger.mjs check` — the duplicate-filing guard.
//
// Every test stubs `gh` onto PATH. A test without a stub would put the real
// tracker in the assertion path: the suite would then pass or fail on this
// repo's live issue list and on whether the machine has network and auth, and
// the offline-degradation tests would be asserting the very thing they stub.
//
// The stub is also how the "never queried" claims are proved: it records its
// argv to a sentinel file, so a test can assert that `gh` was NOT run at all
// rather than assuming it from the exit code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./ledger.mjs", import.meta.url));

// #155's fix resolves the ledger's own repository with a real `git`
// subprocess (both here in test setup and inside ledger.mjs itself), so PATH
// cannot simply be reduced to the stub's directory the way `gh` alone used
// to allow — `git` has to stay reachable too. Resolved once, symlinked into
// every fixture's `bin/` below, which keeps `gh` exactly as isolated as
// before (real PATH never reaches it) while `git` still resolves.
const REAL_GIT = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
if (!REAL_GIT) throw new Error("ledger.test.mjs setup: could not locate a `git` binary on PATH");

// `printf '%s\n' "$@"` before any early exit: the argv record has to survive the
// failure paths too, or the "what query did gh receive" assertions can only run
// on the success path.
//
// Shell builtins only — no `cat`. PATH is reduced to the stub's own directory
// (see run()), so an external binary here fails with 127 and the stub then
// looks exactly like a broken `gh`: every "tracker returned hits" test would
// silently assert the offline path instead. The `|| [ -n "$line" ]` guard emits
// the last line of a fixture written without a trailing newline, which is what
// JSON.stringify produces.
const GH_STUB = `#!/bin/sh
printf '%s\\n' "$@" > "$GH_ARGS_FILE"
pwd -P > "$GH_CWD_FILE"
printf 'GIT_DIR=%s\\nGH_REPO=%s\\n' "\${GIT_DIR-}" "\${GH_REPO-}" > "$GH_ENV_FILE"
if [ -n "$GH_FAIL" ]; then
  echo "gh: could not authenticate to github.com (HTTP 401)" >&2
  exit 1
fi
# GH_FAIL's one tidy line is the shape that hides #638: it neither overruns the
# cap nor trims away. This escape emits its value on stderr verbatim — no
# trailing newline added — so a test can drive the stderr shapes that do:
# warnings ahead of the real error, and whitespace with no cause in it at all.
if [ -n "$GH_STDERR" ]; then
  printf '%s' "$GH_STDERR" >&2
  exit 1
fi
# A gh that prints and then HANGS past the script's own 20 s timeout. \`exec\`,
# and an absolute path: PATH is the stub's own directory (see run()), which
# holds only \`gh\` and \`git\`, so a bare \`sleep\` would exit 127 and this
# would test a broken gh instead of a hanging one. \`exec\` puts the sleep in
# the shell's own process so execFileSync's SIGTERM lands on it directly
# rather than orphaning it to outlive the test.
if [ -n "$GH_HANG" ]; then
  printf '%s' "$GH_HANG" >&2
  exec /bin/sleep 25
fi
if [ -n "$GH_GARBAGE" ]; then
  echo "Welcome to gh! Run gh auth login to get started."
  exit 0
fi
while IFS= read -r line || [ -n "$line" ]; do printf '%s\\n' "$line"; done < "$GH_FIXTURE"
`;

// filed rows go in verbatim; the script's own escaping is exercised by the
// `filed` subcommand, which this file does not touch.
function ledgerText(filed) {
  return `# Fleet run ledger\n\n## Rows\n\n\n## Filed\n\n${filed.map((f) => `- ${f}`).join("\n")}\n\n## Ruled\n\n`;
}

// `hits` is what the gh stub prints; `gh: false` removes gh from PATH entirely
// (the "gh not installed" case, which throws ENOENT rather than exiting non-zero
// — a different code path from an auth failure and worth its own coverage).
//
// `gitRepo` defaults true because that is what every real ledger location is
// (`--file` inside a checkout, or defaultLedgerPath()'s own --git-common-dir
// derivation) — #155 makes the tracker query bind to that repo, so a fixture
// that is not one no longer reaches gh at all. `gitRepo: false` is its own
// case — an explicit --file naming a path outside any repository, or a
// `noFile` run whose fixture dir is never consulted because `procCwd` points
// the ledger resolution somewhere else entirely — and `noFile`
// / `procCwd` exist to drive the no-`--file` documented flow, which resolves
// its own ledger location from the spawned process's cwd rather than `--file`.
//
// `ledgerDirExists: false` withholds the setup `mkdirSync` (and the ledger
// file with it) to reproduce the state every fresh clone and worktree is in
// before the run's first write: `.fleet/` is gitignored and created lazily by
// save(), so the DEFAULT `true` here is a fixture that pre-creates something
// production never has yet — and it is what hid a #155 regression from the
// accept-pin below.
function run(subject, { filed = [], hits = [], ghFails = false, ghGarbage = false, ghStderr = null, ghHang = null, gh = true, args = [], gitRepo = true, noFile = false, procCwd = null, ledgerDirExists = true, ledgerBody = null, spawnEnv = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  try {
    // Inherited git vars outrank both cwd and `-C`, and they reach here from
    // whatever ran the suite — a git hook, `rebase --exec`, `bisect run`.
    // Under an ambient GIT_DIR the `git init` below exits 0 and creates
    // NOTHING in `dir`: it re-inits the directory GIT_DIR names instead, so
    // the fixture is silently not a repository and the status assert cannot
    // see it. Scrub them off the whole fixture, as the fleet's other
    // fixtures already do (inflight.test.mjs), so these tests measure the
    // code under test rather than the environment that started them.
    // `spawnEnv` puts one back deliberately, for the test that pins the
    // scrub ledger.mjs itself performs.
    const baseEnv = { ...process.env };
    delete baseEnv.GIT_DIR;
    delete baseEnv.GIT_WORK_TREE;
    if (gitRepo) {
      const init = spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore", env: baseEnv });
      assert.equal(init.status, 0, "test setup: git init must succeed");
      // `git init` exiting 0 is not the same as this directory being a repo
      // (see above) — assert the thing the fixtures actually depend on.
      assert.ok(existsSync(join(dir, ".git")), "test setup: git init must have created a repository HERE");
    }
    const ledgerDir = noFile ? join(dir, ".fleet") : dir;
    if (noFile && ledgerDirExists) mkdirSync(ledgerDir, { recursive: true });
    const file = join(ledgerDir, "ledger.md");
    // No directory means no ledger file either — writing one would be the very
    // state `ledgerDirExists: false` exists to withhold.
    // `ledgerBody` writes the file's bytes directly: the states worth testing
    // below are ones ledgerText() structurally cannot produce — a file that is
    // not a ledger, and a ledger whose header is corrupt.
    if (ledgerDirExists) writeFileSync(file, ledgerBody ?? ledgerText(filed));
    const fixture = join(dir, "hits.json");
    writeFileSync(fixture, JSON.stringify(hits));
    const argsFile = join(dir, "gh-argv");
    const cwdFile = join(dir, "gh-cwd");
    const ghEnvFile = join(dir, "gh-env");
    const bin = join(dir, "bin");
    const env = {
      ...baseEnv,
      GH_FIXTURE: fixture,
      GH_ARGS_FILE: argsFile,
      GH_CWD_FILE: cwdFile,
      GH_ENV_FILE: ghEnvFile,
      // PATH is replaced, not prefixed: a prefix leaves the real `gh` reachable
      // the moment the stub's own directory lookup changes, and the ENOENT test
      // would then silently start querying the live tracker. `git` still
      // resolves — it is symlinked into this same `bin` below — so this stays
      // narrow to `gh` alone.
      PATH: bin,
      // Last, so a test can deliberately put back a var the scrub above
      // removed — that is the whole point of the GIT_DIR pin below.
      ...spawnEnv,
    };
    if (ghFails) env.GH_FAIL = "1";
    if (ghGarbage) env.GH_GARBAGE = "1";
    if (ghStderr !== null) env.GH_STDERR = ghStderr;
    if (ghHang !== null) env.GH_HANG = ghHang;
    mkdirSync(bin, { recursive: true });
    symlinkSync(REAL_GIT, join(bin, "git"));
    if (gh) {
      const ghPath = join(bin, "gh");
      writeFileSync(ghPath, GH_STUB);
      chmodSync(ghPath, 0o755);
    }
    // No `stdio` override on purpose: the default pipe is what makes `r.stderr`
    // readable at all. spawnSync drains stdout and stderr concurrently, so the
    // child never blocks on a full pipe, and no `check` arm reaches its exit
    // through process.exit(), which is what dropped queued writes past the
    // ~64 KiB pipe buffer (measured on candidates.mjs, issue #132) and
    // abandoned the payload with them (#246, #808) — so these assertions are
    // honest. The ceiling that is left is spawnSync's own maxBuffer, 1 MiB per
    // stream by default: past it the child is killed and the capture arrives
    // short under a null exit code. The #808 fixtures run well past the pipe
    // buffer and stay under that cap; widen one and that is what gives.
    const scriptArgs = noFile ? ["check", ...args, subject] : ["--file", file, "check", ...args, subject];
    const r = spawnSync(process.execPath, [SCRIPT, ...scriptArgs], {
      encoding: "utf8",
      env,
      cwd: procCwd || (noFile ? dir : undefined),
    });
    let json = null;
    try {
      json = JSON.parse(r.stdout);
    } catch {
      /* several tests assert on a non-JSON failure exit; leave json null */
    }
    return {
      status: r.status,
      stdout: r.stdout,
      stderr: r.stderr,
      json,
      ghRan: existsSync(argsFile),
      ghArgv: existsSync(argsFile) ? readFileSync(argsFile, "utf8").trim().split("\n") : [],
      ghCwd: existsSync(cwdFile) ? readFileSync(cwdFile, "utf8").trim() : null,
      // What gh saw for the two env vars that outrank the cwd it was bound to
      // — `""` for either means ledger.mjs scrubbed it, which is the whole
      // assertion. Read as strings, so a var that arrived unset and one that
      // arrived empty are indistinguishable here: both are the safe state.
      ghEnv: existsSync(ghEnvFile)
        ? Object.fromEntries(
          readFileSync(ghEnvFile, "utf8").trimEnd().split("\n").map((l) => {
            const i = l.indexOf("=");
            return [l.slice(0, i), l.slice(i + 1)];
          }),
        )
        : null,
      // Resolved before the `finally` below removes `dir` — a caller that
      // realpath()s this after run() returns hits an ENOENT, not a path.
      ledgerRepoDir: realpathSync(dir),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The term-selection tests need the exact --search string gh received, not
// just whether it ran.
function queryOf(r) {
  return r.ghArgv[r.ghArgv.indexOf("--search") + 1];
}

const FILED_114 =
  "#114 fleet-plugin-design Non-zero column written from intent — audit 11 rows (review-pr-108)";
const FILED_131 = "#131 run-merge-bot.md exit-2 documentation gap in the merge loop";

// ---------------------------------------------------------------------------
// The existing exact/subset contract. These pass against the pre-change script
// and exist so the new reporting cannot quietly move the strong signal.
// ---------------------------------------------------------------------------

test("an exactly-reworded filed subject is still ALREADY FILED, exit 1", () => {
  const r = run("fleet-plugin-design Non-zero column written from intent — audit 11 rows (review-pr-108)", {
    filed: [FILED_114],
  });
  assert.equal(r.status, 1);
  assert.equal(r.json.found, true);
  assert.match(r.json.match, /^#114 /);
  assert.equal(r.json.verdict, "already-filed");
  assert.match(r.stderr, /ALREADY FILED/);
});

test("a strict four-token subset of a filed row is still a match, exit 1", () => {
  const r = run("Non-zero column audit 11 rows", { filed: [FILED_114] });
  assert.equal(r.status, 1);
  assert.equal(r.json.found, true);
});

test("a three-token overlap is below the subset floor and is not a match", () => {
  const r = run("column audit rows", { filed: [FILED_114] });
  assert.equal(r.status, 0);
  assert.equal(r.json.found, false);
  assert.equal(r.json.match, null);
});

// ---------------------------------------------------------------------------
// The two acceptance rules at their boundaries (#888). isMatch() accepts on
// either of two rules — equal token sets at any size, or a subset from at
// least four tokens — and the equal-set acceptance below the subset floor and the
// acceptance at the subset floor are what pin those rules, each sitting where the
// other rule cannot account for the outcome. Same-size sets are where the two
// rules come apart, and the tests above reach that case only through rows
// built for other purposes.
//
// Two tests share this fence without pinning either rule. The same-size
// refusal runs four tokens against four, so both size rules pass and only the
// subset conjunct refuses it — that conjunct is what it pins, and it is the
// same-size case worth pinning. The empty-subject usage failure dies before
// isMatch is reached, so it reaches neither rule.
//
// A same-size match at or above the subset floor is deliberately NOT pinned here: it
// satisfies both rules at once, so no single-rule mutation can red it and it
// discriminates nothing. An equal set under the subset floor is an acceptance only
// one rule can explain.
// ---------------------------------------------------------------------------

test("a same-size four-token near-miss differing in one token is not a match (#888)", () => {
  const r = run("quorum drains under retry", { filed: ["#901 quorum drains under replay"] });
  assert.equal(r.status, 0);
  assert.equal(r.json.found, false);
  assert.equal(r.json.match, null);
});

test("equal token sets match below the subset floor — the subset floor gates the subset rule alone (#888)", () => {
  // The subset floor exists to stop a short generic overlap matching everything, and
  // it is a condition of the SUBSET rule only: equal sets are already as
  // specific as a match gets, so they qualify at any size. Folding the two
  // rules into one guarded expression is the edit that can silently lose
  // this, and nothing else in this file builds an equal set small enough to
  // notice.
  const r = run("pipe truncates payload", { filed: ["#902 payload truncates pipe"] });
  assert.equal(r.status, 1);
  assert.equal(r.json.found, true);
  assert.match(r.json.match, /^#902 /);
});

test("a strict subset exactly at the subset floor is a match — the subset floor is pinned from above (#899)", () => {
  // The subset floor is a lower bound, so the refusal beneath it anchors one side
  // only: raise the subset floor and matches quietly stop happening. That is the
  // direction `check` is deliberately biased toward — a duplicate someone
  // closes rather than a finding silently lost — which is exactly why a
  // raised subset floor disturbs nothing else here. Acceptance AT the subset floor is the
  // observation that notices, and it has to be a STRICT subset: an equal pair
  // qualifies under the equal-size rule as well, so the subset floor would no longer
  // be what decides and the mutation would have nothing to move.
  //
  // Plain words, no punctuation, on both sides. The subject's token count is
  // the whole subject of this pin, so it must not shift when norm() changes
  // how it folds punctuation — otherwise this reds for a reason it does not
  // name. A match also returns before the tracker query is built, so nothing
  // in term selection or the near-miss scoring can reach this either.
  const r = run("quorum lease drains retry", {
    filed: ["#903 retry budget drains the shared quorum lease"],
  });
  assert.equal(r.status, 1);
  assert.equal(r.json.found, true);
  assert.match(r.json.match, /^#903 /);
});

test("a subject with no alphanumeric tokens is a usage failure, exit 2", () => {
  const r = run("— — —", { filed: [FILED_114] });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /normalised subject is empty/);
});

// ---------------------------------------------------------------------------
// Direction normalisation (#899 review). isMatch() orders the pair by size
// before either acceptance rule reads it, so both rules always measure the
// smaller set. Hardcoding the ordering away leaves the rest of this file
// green because no other fixture reaches a match through the mirror
// orientation — not because of how their sizes happen to fall.
// ---------------------------------------------------------------------------

test("a filed row that is a strict subset of a longer subject is a match — the smaller set is what the subset floor measures", () => {
  // Dropping the ordering — hardcoding the pair as (subject, filed) so the
  // checked subject is always taken as the smaller set — leaves every other
  // fixture in this file green. This fixture is the mirror orientation, where
  // the FILED row is the smaller set. Other fixtures build that orientation
  // too, but none of them reaches a match through it, so the ordering never
  // decides their answer — this is the first fixture where it does.
  //
  // Sized clear of the subset floor deliberately. At exactly four tokens a raised
  // subset floor reds this too, and it would then be pinning the boundary a
  // neighbouring test already owns rather than the ordering. Clear of the
  // subset floor, the ordering moves it — so does disabling the `#NNN` strip, which
  // decides whether the filed row can be a subset at all, not which of the
  // two sets is the smaller one.
  //
  // Plain words on both sides, as the token counts are load-bearing and must
  // not shift when norm() changes how it folds punctuation.
  const r = run("the retry budget drains the shared quorum lease under sustained load", {
    filed: ["#904 retry budget drains quorum lease"],
  });
  assert.equal(r.status, 1);
  assert.equal(r.json.found, true);
  assert.match(r.json.match, /^#904 /);
});

// ---------------------------------------------------------------------------
// Near-miss reporting (issue #145, option 3).
// ---------------------------------------------------------------------------

test("a filed finding described in different words surfaces as a scored near-miss", () => {
  // Neither token set contains the other — "behaviour"/"undocumented" are absent
  // from the filed row, "documentation"/"gap" from the subject — so the subset
  // path correctly misses it. That miss is the whole defect #145 reports.
  const r = run("merge loop exit 2 behaviour undocumented in run-merge-bot.md", {
    filed: [FILED_131],
  });
  assert.equal(r.status, 0, "a near-miss is advisory, not a stop");
  assert.equal(r.json.found, false, "near-misses must not be reported as an exact hit");
  assert.ok(r.json.near.length >= 1, "expected the reworded row to surface");
  assert.match(r.json.near[0].row, /^#131 /);
  assert.ok(r.json.near[0].score >= 0.5, `expected a strong score, got ${r.json.near[0].score}`);
  assert.match(r.stderr, /near-miss/);
});

test("near-misses are ranked best-first and capped at three", () => {
  const filed = [
    "#1 something else entirely about postgres connection pooling",
    "#2 merge loop exit code documentation",
    "#3 unrelated worktree audit prose",
    "#4 the merge loop exit 2 gap in run-merge-bot.md documentation",
    "#5 loop merge unrelated tangent",
    // Five rows must score above zero, or "capped at three" passes on the
    // filter and never exercises the cap: raising NEAR_SHOWN in ledger.mjs
    // from 3 to 10 then reds nothing.
    "#6 merge loop tangent",
    "#7 loop exit trivia",
  ];
  const r = run("merge loop exit 2 behaviour undocumented in run-merge-bot.md", { filed });
  assert.equal(r.status, 0);
  assert.equal(r.json.near.length, 3, "top-3 cap");
  assert.ok(
    filed.filter((f) => f.match(/merge|loop|exit/)).length > 3,
    "the fixture must offer more scoring rows than the cap returns",
  );
  assert.match(r.json.near[0].row, /^#4 /, "the closest row must rank first");
  const scores = r.json.near.map((n) => n.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "scores must be descending");
});

test("a subject sharing no content words with any filed row reports no near-misses", () => {
  const r = run("postgres connection pooling exhausted under load", { filed: [FILED_114, FILED_131] });
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.near, []);
});

// ---------------------------------------------------------------------------
// The cap must SAY it capped (issue #154). `candidates.mjs` legislates the same
// rule one script over and enforces it by refusing outright; refusing is wrong
// here — these lists are advisory context for a decision, not the work queue,
// and a single tracker hit already forces exit 3 — so the remedy is to report
// what was withheld, never to drop it in silence.
// ---------------------------------------------------------------------------

// Five rows whose every content word is the subject's, so every one scores an
// identical 1.00: the tie is the point. Nothing about the SCORE separates the
// three shown from the two dropped — only the cap does — which is exactly the
// state the caller cannot infer from a three-row list.
const TIED_FIVE = [
  "#1 merge loop exit",
  "#2 loop exit code",
  "#3 merge exit code",
  "#4 run merge bot",
  "#5 merge code loop",
];
const TIED_SUBJECT = "the merge loop exit code is undocumented in run-merge-bot.md";

test("near-misses withheld by the cap are counted, not dropped in silence (#154)", () => {
  const r = run(TIED_SUBJECT, { filed: TIED_FIVE });
  assert.equal(r.status, 0, "reporting the withheld rows must not move a near-miss off exit 0");
  // The verdict half of this moved with #388: a near-miss at this score IS the
  // verdict now. What #154 pins here is the reporting of the cut, and that the
  // rows stay advisory — the exit code above, not the word.
  assert.equal(r.json.verdict, "soft-hit", "rows scoring this high are the answer, not decoration beside it");
  assert.equal(r.json.near.length, 3, "the display cap itself is unchanged");
  assert.deepEqual(r.json.near.map((n) => n.score), [1, 1, 1], "the fixture must actually tie, or this pins nothing");
  assert.equal(r.json.nearTotal, 5, "the caller must be able to tell 3-of-3 from 3-of-5 from the payload alone");
  assert.match(
    r.stderr,
    /2 further near-misses not shown/,
    "the count withheld has to reach the caller, not just the JSON",
  );
  assert.match(
    r.stderr,
    /highest withheld 1\.00/,
    "a withheld row tied with the shown ones is the case the caller most needs told about",
  );
  // The comment the notice implements says the withheld rows are reported as a
  // count and a score, "never the rows" — printing them would give back the
  // length the cap exists to take away. Read off the notice line itself rather
  // than the whole stderr, which legitimately carries `#N` on every shown
  // near-miss, and match the row MARKER rather than this fixture's row text, so
  // reordering the tied rows cannot red it while the invariant holds.
  assert.doesNotMatch(
    r.stderr.split("\n").find((l) => l.includes("further near-miss")) ?? "",
    /#\d/,
    "the notice reports the count and the top score, never a withheld row",
  );
});

// Every row shares the subject's words, but progressively fewer of them, so no
// two score alike. That is the whole point: under a tie the highest withheld
// score and the lowest are the same number, so an index that reports the wrong
// row prints the right value and no assertion can tell. Measured, a mutation
// reporting the LOWEST withheld score — and even `rankedNear[0]` — survives the
// entire suite against the tied fixture above.
const UNTIED_FIVE = [
  "#1 merge loop exit",
  "#2 merge loop pooling",
  "#3 merge loop pooling exhausted",
  "#4 merge pooling exhausted",
  "#5 merge pooling exhausted postgres",
];

test("the score reported as withheld is the HIGHEST withheld one, not the last shown or the lowest (#154)", () => {
  const r = run(TIED_SUBJECT, { filed: UNTIED_FIVE });
  assert.equal(r.status, 0);
  assert.deepEqual(
    r.json.near.map((n) => n.score),
    [1, 0.67, 0.5],
    "the fixture must NOT tie, or this pins the same nothing the tied one does",
  );
  assert.equal(r.json.nearTotal, 5);
  // One value rules out every off-by-one at once: 0.50 is the last SHOWN row,
  // 0.25 the lowest withheld, 1.00 the top of the ranking. Only the first
  // withheld row reads 0.33.
  assert.match(
    r.stderr,
    /2 further near-misses not shown — highest withheld 0\.33/,
    "the caller is told what the cut cost it, which is the top of what it did not get",
  );
});

test("exactly one withheld near-miss still fires the notice (#154)", () => {
  // The tightest boundary the notice has: one row over the cap. A guard off by
  // one goes silent precisely here and nowhere else, and the fixtures above —
  // two withheld, none withheld — both straddle it.
  const r = run(TIED_SUBJECT, { filed: TIED_FIVE.slice(0, 4) });
  assert.equal(r.status, 0);
  assert.equal(r.json.near.length, 3, "the display cap is what withholds the fourth row");
  assert.equal(r.json.nearTotal, 4);
  assert.match(r.stderr, /1 further near-miss not shown/, "one withheld row is still a withheld row, and one reads in the singular");
});

test("exactly three near-misses report no withholding — the notice must not fire on a complete list (#154)", () => {
  // Two filed rows that score ZERO sit alongside the three that tie. They are
  // what makes this a real pin rather than a restatement: a `nearTotal` counted
  // off the filed list instead of the scoring rows reads 5 here and reports two
  // rows withheld that no cap ever touched — and the tied fixture above, where
  // every filed row scores, cannot tell those two implementations apart.
  const r = run(TIED_SUBJECT, {
    filed: TIED_FIVE.slice(0, 3).concat([
      "#8 postgres connection pooling exhausted",
      "#9 unrelated worktree audit prose",
    ]),
  });
  assert.equal(r.status, 0);
  assert.equal(r.json.near.length, 3, "a full-but-not-over list still fills the cap exactly");
  assert.equal(r.json.nearTotal, 3, "nothing was withheld, and the payload must say so");
  assert.doesNotMatch(r.stderr, /further near-miss/, "claiming a withheld row that does not exist is the same lie inverted");
});

// ---------------------------------------------------------------------------
// Tracker query (issue #145, option 1) and its offline degradation.
// ---------------------------------------------------------------------------

const HIT_114 = {
  number: 114,
  title: "fleet-plugin-design: the Script surface table's Non-zero column was written from intent",
  state: "OPEN",
  url: "https://github.com/feigi/claude-config/issues/114",
};

test("an open tracker issue absent from the ledger is reported, not passed as safe", () => {
  // The subject shares content words with the hit's title on purpose: since
  // #388 the escalation to exit 3 is the scorer's call, so a subject that
  // scored 0.00 against this row would be testing the advisory arm under this
  // test's name.
  const r = run("Non-zero column audit 11 rows", { filed: [], hits: [HIT_114] });
  assert.equal(r.status, 3, "a tracker hit with a clean ledger is exit 3, not 0");
  assert.equal(r.json.found, false, "the ledger genuinely did not have it — `found` stays ledger-only");
  assert.equal(r.json.tracker.ok, true);
  assert.equal(r.json.tracker.hits[0].number, 114);
  assert.equal(r.json.tracker.hits[0].state, "OPEN");
  assert.equal(typeof r.json.tracker.hits[0].score, "number");
  assert.equal(r.json.verdict, "tracker-hit");
  assert.match(r.stderr, /TRACKER HIT/);
  // Order, not just presence: the hits are listed inside the same branch that
  // prints the count, so a careless edit can emit the summary above the rows it
  // summarises. Nothing else pins this.
  assert.match(r.stderr, /TRACKER HIT[\s\S]*tracker issue\(s\) match/, "every hit is listed before the line that counts them");
  assert.doesNotMatch(r.stderr, /ALREADY FILED/, "a tracker hit is not the same claim as a filed row");
});

// gh reports no total alongside a capped list, so 5-of-5 and 5-of-300 arrive
// byte-identical. Asking for one more row than is displayed is the whole
// mechanism: the extra row's presence IS the truncation signal (#154).
// Titled to score against the subject these fixtures are checked with, but well
// below the exact-title row below: a filler set scoring 0.00 is the advisory
// arm since #388, and would take both truncation tests off the blocking exit
// code they exist to pin.
const filler = (n) => ({
  number: n,
  title: "postgres pooling code exhausted under sustained load",
  state: "CLOSED",
  url: `https://github.com/feigi/claude-config/issues/${n}`,
});
const EXACT_TITLE = {
  number: 606,
  title: "candidates.mjs row states the opposite of its code",
  state: "OPEN",
  url: "https://github.com/feigi/claude-config/issues/606",
};

test("gh is asked for one more issue than is displayed, so a full page is distinguishable from a truncated one (#154)", () => {
  const r = run("candidates.mjs row states the opposite of its code", { filed: [], hits: [] });
  assert.equal(r.ghArgv[r.ghArgv.indexOf("--limit") + 1], "6", "5 displayed + 1 probe row");
});

test("a tracker list gh truncated says so, and the probe row still ranks (#154)", () => {
  // Six back for a five-row display. The best-scoring row is deliberately LAST
  // in gh's own order: it may only survive if the overlap sort runs across the
  // whole fetched window before the display cap, not after it.
  const hits = [1, 2, 3, 4, 5].map(filler).concat([EXACT_TITLE]);
  const r = run("candidates.mjs row states the opposite of its code", { filed: [], hits });
  assert.equal(r.status, 3, "truncation reporting must not move a tracker hit off exit 3");
  assert.equal(r.json.verdict, "tracker-hit");
  assert.equal(r.json.tracker.hits.length, 5, "the sixth row is a probe, not a row to display");
  assert.equal(r.json.tracker.truncated, true, "the payload must name the truncation, not leave it inferable");
  assert.equal(r.json.tracker.hits[0].number, 606, "the probe row participates in the ranking it was fetched into");
  assert.match(r.stderr, /but more than 5 tracker issue\(s\) match/, "a capped count must not be printed as an exact one");
  assert.match(r.stderr, /CAPPED at 5/, "and the caller is told the ranking is over gh's window, not over the tracker");
  assert.match(
    r.stderr,
    /TRACKER HIT[\s\S]*tracker issue\(s\) match/,
    "the rows still come before the line that counts them",
  );
});

test("a tracker list that exactly fills the display claims no truncation (#154)", () => {
  const hits = [1, 2, 3, 4, 5].map(filler);
  const r = run("candidates.mjs row states the opposite of its code", { filed: [], hits });
  assert.equal(r.status, 3);
  assert.equal(r.json.tracker.hits.length, 5, "five rows displayed, none dropped");
  assert.equal(r.json.tracker.truncated, false, "no probe row came back, so nothing was withheld");
  assert.match(r.stderr, /but 5 tracker issue\(s\) match/, "an exact count is what a complete list has earned");
  assert.doesNotMatch(r.stderr, /more than|CAPPED/, "over-reporting truncation would send the caller hunting rows that do not exist");
});

test("a clean ledger and a clean tracker is the only path that reads safe, exit 0", () => {
  const r = run("postgres connection pooling exhausted under load", { filed: [FILED_114], hits: [] });
  assert.equal(r.status, 0);
  assert.equal(r.json.tracker.ok, true);
  assert.deepEqual(r.json.tracker.hits, [], "a searched-and-clean tracker reports an empty list, not absent");
  assert.equal(r.json.verdict, "clean");
});

// ---------------------------------------------------------------------------
// The verdict consumes the scores the payload already carries (#388).
//
// Both halves were measured wrong in one run: `tracker-hit` over rows this
// file's own overlap rates 0.00, and `clean` printed directly above near-miss
// rows that named the right issue. The rows and the scores were computed and
// printed in both cases — only the verdict ignored them. The fixtures below
// are those measured shapes.
//
// `soft-hit` is the verdict for "signal, not a duplicate finding". It stays on
// exit 0 deliberately: exit 3's meaning ("the ledger is clean but the tracker
// has matching rows") is what callers gate on, and near-misses were already
// ruled advisory rather than blocking (#145, #152). What moves is the hit set
// the scorer rates 0.00, which used to force 3.
// ---------------------------------------------------------------------------

// The wontfix-vocabulary shape: rows that share a filing convention with each
// other and nothing with the subject. gh's ANDed query returned them; every one
// scores 0.00 here.
const REFUTED_BAND = [340, 356, 280].map((n) => ({
  number: n,
  title: `PR #${n} review: the suggestion band, checked`,
  state: "CLOSED",
  url: `https://github.com/feigi/claude-config/issues/${n}`,
}));
const KB_SUBJECT = "the KB file the skill points at is missing from the plugin bundle";

test("tracker rows the scorer rates 0.00 are advisory, not a hit (#388)", () => {
  const r = run(KB_SUBJECT, { filed: [], hits: REFUTED_BAND });
  assert.equal(r.json.tracker.ok, true, "the tracker WAS read — this is not the unverified arm");
  assert.deepEqual(r.json.tracker.hits.map((h) => h.score), [0, 0, 0], "the fixture must actually score zero, or this pins nothing");
  assert.equal(r.json.verdict, "soft-hit", "a hit set with no scoring row is not a duplicate finding");
  assert.equal(r.status, 0, "honouring it as exit 3 is what dropped a real deferral");
  assert.equal(r.json.tracker.hits.length, 3, "the rows stay in the payload — they are the caller's evidence, not noise to hide");
  assert.doesNotMatch(r.stderr, /TRACKER HIT/, "stderr is the channel read first; a hard-stop word over advisory rows is the trap itself");
  assert.match(r.stderr, /score 0\.00/, "the score the verdict was derived from has to be visible where the rows are");
  assert.match(r.stderr, /SOFT HIT/, "the verdict's own stderr line is pinned here like every neighbouring verdict's is");
});

// The measured self-check: a subject whose tracker rows all score 0.00 while a
// filed row scores well above the soft-hit floor. Reported `tracker-hit` naming the
// unrelated rows, with the genuinely adjacent one sitting in `near`.
const UNREL_HITS = [
  { number: 149, title: "run-merge-bot force-push clobbers a rebased branch", state: "OPEN", url: "https://github.com/feigi/claude-config/issues/149" },
  { number: 39, title: "cockpit concurrency limit is not honoured", state: "OPEN", url: "https://github.com/feigi/claude-config/issues/39" },
];
const NEAR_231 = "#231 ledger check emits verdict clean when the ledger file was never read";
const VERDICT_SUBJECT = "ledger check verdict ignores the near-miss rows it prints";

test("a near row above the soft-hit floor outranks a clean verdict (#388)", () => {
  const r = run(VERDICT_SUBJECT, { filed: [NEAR_231], hits: [] });
  assert.equal(r.json.found, false, "the near row is not a subset match, or the exact path answers before the verdict does");
  assert.ok(r.json.near[0].score >= 0.2, `the fixture must clear the soft-hit floor, got ${r.json.near[0].score}`);
  assert.equal(r.json.verdict, "soft-hit", "clean printed above a row naming the right issue is the defect");
  assert.equal(r.status, 0, "a near-miss stays advisory — it never became a stop");
  assert.match(r.stderr, /near-miss/);
  assert.match(r.stderr, /SOFT HIT/, "the verdict's own stderr line is pinned here like every neighbouring verdict's is");
});

test("score-0 tracker rows and a scoring near row read as one soft hit (#388)", () => {
  const r = run(VERDICT_SUBJECT, { filed: [NEAR_231], hits: UNREL_HITS });
  assert.equal(r.json.verdict, "soft-hit", "both measured directions land on the same advisory answer");
  assert.equal(r.status, 0);
  assert.equal(r.json.tracker.hits.length, 2, "the unrelated rows are still reported");
  assert.ok(r.json.near[0].score >= 0.2, "and the row that actually matched is still ranked");
});

test("a genuinely novel subject is still clean at exit 0 — the control (#388)", () => {
  // A near row BELOW the soft-hit floor, not an empty ranking: with no scoring row at
  // all the clean answer holds however the soft-hit floor moves, and the control pins
  // nothing. This one scores under the soft-hit floor and must not promote.
  const r = run("worktree reap declines a detached checkout it should have released", {
    filed: ["#901 the cockpit board renders a stale checkout of the pool"],
    hits: [],
  });
  assert.equal(r.json.verdict, "clean", "every check becoming a soft hit is the cost of getting this wrong");
  assert.equal(r.status, 0);
  assert.ok(r.json.near.length === 1 && r.json.near[0].score > 0 && r.json.near[0].score < 0.2,
    `the fixture must sit below the soft-hit floor and above zero, got ${JSON.stringify(r.json.near)}`);
});

test("a near row scoring exactly at the soft-hit floor is a soft hit (#388)", () => {
  // The control above sits below the soft-hit floor and the promoting fixture above it
  // scores 0.38, so nothing else in this file lands ON 0.2. Without this pair
  // the soft-hit floor's VALUE and its INCLUSIVITY are both free: `>=` can become `>`,
  // and 0.2 can be retuned upward, with the suite green either way.
  const r = run("quorum drains under retry backoff", {
    filed: ["#902 quorum vanishes without warning during nightly compaction"],
    hits: [],
  });
  assert.equal(r.json.found, false);
  assert.equal(r.json.near[0].score, 0.2, `the fixture must sit ON the soft-hit floor, got ${r.json.near[0].score}`);
  assert.equal(r.json.verdict, "soft-hit", "the soft-hit floor is inclusive — the docs promise 'at or above'");
  assert.equal(r.status, 0);
});

test("a tracker row that really scores still blocks at exit 3 (#388)", () => {
  const scoring = {
    number: 388,
    title: "ledger check verdict ignores near-miss rows",
    state: "OPEN",
    url: "https://github.com/feigi/claude-config/issues/388",
  };
  const r = run(VERDICT_SUBJECT, { filed: [], hits: [...UNREL_HITS, scoring] });
  assert.equal(r.json.tracker.hits[0].number, 388, "the scoring row ranks first, whatever order gh returned");
  assert.ok(r.json.tracker.hits[0].score > 0);
  assert.equal(r.json.verdict, "tracker-hit", "suppressing the zero rows must not suppress the row beside them");
  assert.equal(r.status, 3, "the blocking exit code is unchanged for a hit that scores");
  assert.match(r.stderr, /TRACKER HIT/);
});

// ── The ledger's own readability (#231) ──────────────────────────────────────
//
// `tracker.ok` reports whether the tracker half was read. The ledger half had
// no such field, so a run whose ledger file does not exist emitted a payload
// identical in every field to one that read the ledger and found nothing
// filed — `clean` on both, exit 0 on both. Only stderr told them apart, which
// a consumer parsing the payload cannot see.
//
// The verdict deliberately stays `clean` on both arms: `.fleet/` is gitignored
// and created lazily by save(), so a fresh clone's first `check` legitimately
// has no file to read, and folding that into the verdict would report the
// normal case as unverified.

const UNFILED_SUBJECT = "postgres connection pooling exhausted under load";

test("a ledger that was never read is named as such, and nothing else about the answer moves (#231)", () => {
  // One subject for both runs: `subject` and the derived `tracker.query` ride
  // in the payload, so a differing subject would defeat the comparison below.
  const unread = run(UNFILED_SUBJECT, { ledgerDirExists: false });
  const read = run(UNFILED_SUBJECT, { filed: [] });

  assert.equal(unread.json.ledger.ok, false, "a ledger file that does not exist was never read, and the payload must say so");
  assert.equal(read.json.ledger.ok, true, "a ledger that was read reports so even when it held nothing filed");

  // The whole point of the field: these two payloads were identical, so
  // anything weaker than "differs here and nowhere else" leaves the caller
  // reconstructing the answer from stderr again.
  assert.deepEqual(
    { ...unread.json, ledger: null },
    { ...read.json, ledger: null },
    "the readability flag is the ONLY difference between an unread ledger and one read empty",
  );

  // PR #225 made the exit code a pure function of `verdict`, so a field added
  // beside it is only safe once both are pinned on the arm it lands on.
  for (const r of [unread, read]) {
    assert.equal(r.json.verdict, "clean", "naming the unread ledger must not mint a new verdict");
    assert.equal(r.status, 0, "and must not move the exit code");
  }

  // The warning already stated this consequence in words; the field is what
  // makes the machine-readable half agree with it rather than contradict it.
  assert.match(unread.stderr, /WARNING — ledger file not found/);
  assert.doesNotMatch(read.stderr, /ledger file not found/);
});

test("an unread ledger still reports the tracker hit at its own exit code (#231)", () => {
  // The blocking arm, where a perturbation costs most: exit 3 comes from the
  // verdict alone, so the new field has to be shown not to reach it here.
  const r = run("Non-zero column audit 11 rows", { ledgerDirExists: false, hits: [HIT_114] });
  assert.equal(r.json.ledger.ok, false, "a tracker hit says nothing about whether the ledger was read");
  assert.equal(r.json.verdict, "tracker-hit");
  assert.equal(r.status, 3, "the blocking exit code is unchanged by the new field");
});

test("the already-filed payload names the ledger it read, and stays exit 1 (#231)", () => {
  // The other payload `check` emits. A consumer testing `!payload.ledger.ok`
  // reads a missing field as falsy — "never read" — on the one answer that
  // proves the ledger WAS read, so the field cannot be scoped to one arm.
  const r = run("Non-zero column audit 11 rows", { filed: [FILED_114] });
  assert.equal(r.status, 1, "the strong signal is unchanged");
  assert.equal(r.json.verdict, "already-filed");
  assert.equal(r.json.ledger.ok, true, "a matched row can only have come from a ledger that was read");
});

// The other half of the same question, and the half the field got wrong when
// it was first added: `--file` landing on a file that EXISTS but is not a
// ledger — a typo resolving to a real neighbouring path, or a ledger whose
// header lost a byte. An existence probe answers "read it" for both, which is
// a machine-readable claim that is simply false, and the arm it is false on is
// the one where the intact ledger says ALREADY FILED (#231).
test("a --file that exists but does not parse as a ledger is not reported as read (#231)", () => {
  const notALedger = run(UNFILED_SUBJECT, { ledgerBody: "not a ledger at all\n" });
  assert.equal(notALedger.json.ledger.ok, false, "a file that is not a ledger was never read AS one, whatever stat() says");

  // One byte. This is the fixture that separates a parse from a stat: every
  // other property of the file is intact.
  const mangled = run("Non-zero column audit 11 rows", { ledgerBody: ledgerText([FILED_114]).replace("## Filed", "##Filed") });
  assert.equal(mangled.json.ledger.ok, false, "a corrupt header means the filed rows were never read, and the payload must say so");
  assert.equal(mangled.json.found, false, "the corrupt header is WHY nothing matched — the subject is one the intact ledger answers already-filed");

  // The two halves answer different questions now, so the warning must not
  // start claiming absence for a file that is sitting right there.
  for (const r of [notALedger, mangled]) assert.doesNotMatch(r.stderr, /ledger file not found/);

  // --require-file's contract is absence, not shape. Gating it on the parse
  // would turn these runs into exit 2 — a caller-visible change #231 does not
  // authorise — so it is pinned here rather than left to drift.
  const required = run(UNFILED_SUBJECT, { ledgerBody: "not a ledger at all\n", args: ["--require-file"] });
  assert.equal(required.status, 0, "--require-file still gates on absence alone");
  assert.equal(required.json.ledger.ok, false, "and the field still reports the parse, under --require-file too");
});

// The human-readable half of the same gap (#817): the test above pins that
// stderr must NOT claim absence for two of these three shapes (`notALedger`
// and `mangled` — the empty-file case is new here), but until now it pinned
// only silence past that — no line at all told an operator watching a
// terminal that their `--file` opened something that did not parse. `ok`
// already answers false for all three; this checks the second, differently
// worded line that says so out loud and names the path.
test("--file pointing at an existing-but-unparseable file now warns on stderr, worded apart from the absent-file case (#817)", () => {
  const notALedger = run(UNFILED_SUBJECT, { ledgerBody: "not a ledger at all\n" });
  const mangled = run("Non-zero column audit 11 rows", { ledgerBody: ledgerText([FILED_114]).replace("## Filed", "##Filed") });
  // 0 bytes: `ledgerBody` bypasses ledgerText()'s always-structured output
  // (`??` only falls back on null/undefined, not on ""), so this is the one
  // fixture ledgerText() itself cannot produce.
  const empty = run(UNFILED_SUBJECT, { ledgerBody: "" });

  for (const r of [notALedger, mangled, empty]) {
    assert.equal(r.json.ledger.ok, false, "unchanged by this ticket — the machine-readable half already reported these as unread (#231)");
    assert.match(r.stderr, /WARNING/, "the human-readable half must now say something went wrong too");
    assert.match(r.stderr, /ledger\.md/, "the warning must name the path it opened");
    assert.doesNotMatch(r.stderr, /ledger file not found/, "the file exists — reusing the absent-file wording would be a fresh false claim on this half");
  }

  // The control: a real, parseable ledger must not trip the new line. Widening
  // the condition past "did not parse" — firing on every check regardless of
  // shape — would be a fresh false claim in the other direction, on a file
  // that parsed fine.
  const valid = run(UNFILED_SUBJECT, { filed: [] });
  assert.equal(valid.json.ledger.ok, true);
  assert.doesNotMatch(valid.stderr, /does not look like a ledger/, "a real, parseable ledger must not trip the new warning");
});

test("gh failing degrades to the ledger-only answer and never reads as a bare safe-to-file", () => {
  const r = run("candidates.mjs row states the opposite of its code", { filed: [], ghFails: true });
  assert.equal(r.status, 0, "offline must not block filing — it degrades, per the ledger-only answer");
  assert.equal(r.json.tracker.ok, false);
  assert.equal(r.json.tracker.hits, undefined, "hits must be absent, not [], on a failure arm — a consumer testing .length must fail loudly, not read this as clean");
  assert.equal(r.json.verdict, "unverified");
  assert.match(r.json.tracker.error, /\S/, "the failure reason must reach the caller");
  assert.match(r.stderr, /TRACKER NOT CHECKED/);
  // The exact fail-open this guards: a stderr line that reads like a clean bill
  // of health when the tracker was never consulted at all.
  assert.doesNotMatch(r.stderr, /^ledger: not previously filed$/m);
});

test("gh missing from PATH entirely degrades the same way", () => {
  const r = run("candidates.mjs row states the opposite of its code", { filed: [], gh: false });
  assert.equal(r.status, 0);
  assert.equal(r.json.tracker.ok, false);
  assert.equal(r.json.tracker.hits, undefined, "gh ENOENT is the same failure arm — hits stays absent");
  assert.equal(r.json.verdict, "unverified");
  assert.match(r.stderr, /TRACKER NOT CHECKED/);
  assert.doesNotMatch(r.stderr, /^ledger: not previously filed$/m);
});

test("gh exiting 0 with unparseable stdout is a failed read, not a clean tracker", () => {
  // gh can succeed and still print something that is not the JSON asked for — a
  // first-run banner, a deprecation notice. Parsing lives inside the try for
  // exactly this reason. Treating the parse failure as an empty hit list would
  // report a tracker that was never actually read as clean, which is the #145
  // fail-open one layer up.
  const r = run("candidates.mjs row states the opposite of its code", { filed: [], ghGarbage: true });
  assert.equal(r.status, 0, "it still degrades rather than blocking the filing");
  assert.equal(r.json.tracker.ok, false, "an unparseable payload is NOT a clean tracker");
  assert.equal(r.json.tracker.hits, undefined, "an unread tracker must not be representable as an empty result set");
  assert.equal(r.json.verdict, "unverified");
  assert.match(r.stderr, /TRACKER NOT CHECKED/);
  assert.doesNotMatch(r.stderr, /found no related issues/, "never claim the tracker was searched clean");
});

// The tests below pin what `tracker.error` CARRIES, not merely that it is
// present. `execFileSync` runs gh with an explicit `stdio` that does not
// forward the child's stderr, so this field is the only copy of the cause that
// exists anywhere — a cause dropped here is dropped for good (#638).
//
// Each asserts `verdict` and `tracker.ok` as well: this arm's contract is that
// only the diagnostic prose moves, and the dedupe guard's whole payload reads
// off those two fields.

test("a gh stderr that overruns the cap keeps the end, where the cause is, and says it was cut", () => {
  // gh prints its warnings before the error that killed it, so keeping the
  // FIRST bytes throws the cause away and hands back a string cut mid-word
  // that reads as complete.
  const noise = Array.from({ length: 40 }, (_, i) => `gh: warning line ${i + 1} ${"-".repeat(60)}`).join("\n");
  const r = run(UNFILED_SUBJECT, { filed: [], ghStderr: `${noise}\ngh: FATAL — HTTP 403 rate limit exceeded, resets at 14:02 UTC\n` });
  assert.equal(r.status, 0, "an unreadable tracker still degrades rather than blocking the filing");
  assert.equal(r.json.tracker.ok, false);
  assert.equal(r.json.verdict, "unverified");
  assert.match(r.json.tracker.error, /FATAL — HTTP 403 rate limit exceeded/, "the error gh actually died of must survive the cap");
  assert.match(r.json.tracker.error, /^…/, "a clipped string with no marker reads as the whole of what gh printed");
  // Still capped. The field ships on stdout inside a machine-parsed contract,
  // so unbounded gh stderr in it is a payload problem however the cause is
  // chosen — 500 is the ceiling the script names, marker included.
  assert.ok(r.json.tracker.error.length <= 500, `the cause must stay bounded, got ${r.json.tracker.error.length}`);
  // Astral input too. The cap is on `.length`, which counts UTF-16 code UNITS,
  // so a tail sliced by code POINTS keeps up to twice as many — measured 999
  // under the remedy proposed for the lone surrogate this cut can leave behind.
  // The ASCII fixture above cannot see that: there one code point is one code
  // unit, and the suite stays green while the payload ships 999 characters.
  const astral = run(UNFILED_SUBJECT, { filed: [], ghStderr: "\u{1F525}".repeat(400) });
  assert.ok(astral.json.tracker.error.length <= 500, `the cap counts code units, got ${astral.json.tracker.error.length}`);
});

test("a gh that fails with a whitespace-only stderr still names a cause", () => {
  // Whitespace-only stderr is truthy, so it wins a choice made before the trim
  // and then trims away to nothing — the warning line then has an empty
  // parenthesis where the reason belongs, and exit 0 carries no cause at all.
  const r = run(UNFILED_SUBJECT, { filed: [], ghStderr: "\n \n" });
  assert.equal(r.status, 0);
  assert.equal(r.json.tracker.ok, false);
  assert.equal(r.json.verdict, "unverified");
  assert.doesNotMatch(r.stderr, /TRACKER NOT CHECKED \(\)/, "the warning must never print an empty cause");
  assert.match(r.stderr, /TRACKER NOT CHECKED/);
  // Non-empty is not enough to pin the fall-through: the last-resort literal
  // satisfies that on its own, and measured, it does — with the choice made on
  // the raw values again, this test read green off that literal while the
  // reader had lost the command. Pin the thing only the thrown message can
  // supply: the argv gh was given.
  assert.match(
    r.json.tracker.error,
    /issue list --search/,
    "the cause must be the thrown message, which names the command that failed",
  );
  assert.doesNotMatch(
    r.json.tracker.error,
    /without saying why/,
    "the last resort is for a failure carrying no diagnostic anywhere, not for one whose message names the command",
  );
});

test("a gh stderr short enough to fit reaches the caller unchanged", () => {
  // The must-ACCEPT half: a marker on a string that was never cut is a fresh
  // false signal, and re-choosing the cause must not rewrite one that was
  // already fine.
  const r = run(UNFILED_SUBJECT, { filed: [], ghStderr: "gh: HTTP 403 rate limit exceeded, resets at 14:02 UTC\n" });
  assert.equal(r.json.tracker.ok, false);
  assert.equal(r.json.verdict, "unverified");
  assert.equal(
    r.json.tracker.error,
    "gh: HTTP 403 rate limit exceeded, resets at 14:02 UTC",
    "trimmed at the ends and otherwise exactly what gh printed",
  );
});

test("a gh stderr of exactly the cap reaches the caller unchanged — the cut is ABOVE CAUSE_MAX, not at it", () => {
  // The cap's own boundary, which every other fixture here misses by hundreds
  // of characters: the overrunning one is ~3400, the accept-unchanged one ~54.
  // So `>` to `>=` marks a cause as cut when nothing was cut, and measured,
  // that one-character mutation passes the entire suite.
  //
  // `printf '%s'` adds no newline and neither end of the fixture is
  // whitespace, so cause()'s trim is a no-op here and exactly CAUSE_MAX
  // characters reach the comparison. The em dash is one UTF-16 code unit, so
  // `.length` and the character count agree.
  const head = "gh: FATAL — HTTP 403 rate limit exceeded, resets at 14:02 UTC ";
  const exact = head + "-".repeat(500 - head.length - 1) + ".";
  assert.equal(exact.length, 500, "test setup: the fixture must BE the cap, or this pins nothing");
  const r = run(UNFILED_SUBJECT, { filed: [], ghStderr: exact });
  assert.equal(r.json.tracker.ok, false);
  assert.equal(r.json.verdict, "unverified");
  assert.equal(r.json.tracker.error, exact, "a cause exactly at the cap is not over it — nothing cut, nothing marked");
});

test("a gh that hangs after printing names the timeout, not whatever it last warned about", () => {
  // Costs the full 20 s the script waits, and cannot cost less: that timeout is
  // execFileSync's own, on the parent side, so no stub can shorten it. It buys
  // the one failure class where this catch's ordering is observable at all —
  // every other abort Node performs leaves `e.stderr` undefined, so the thrown
  // message wins there whichever field is asked for first.
  //
  // Measured before this pin existed: this exact shape reported
  // `tracker.error = "gh: warning: using cached credentials for github.com"`
  // and named the 20-second stall nowhere, in the payload or in the operator
  // warning (#638).
  const r = run(UNFILED_SUBJECT, { filed: [], ghHang: "gh: warning: using cached credentials for github.com\n" });
  assert.equal(r.status, 0, "a hung tracker still degrades rather than blocking the filing");
  assert.equal(r.json.tracker.ok, false);
  assert.equal(r.json.verdict, "unverified");
  assert.match(
    r.json.tracker.error,
    /ETIMEDOUT/,
    "the abort is named in the thrown message alone; a stray warning on stderr must not stand in for it",
  );
});

test("a filed row contained in a longer subject scores on the smaller set, not the union", () => {
  // Pins the overlap coefficient against Jaccard and against dividing by the
  // larger set: either would dilute a fully-contained row toward zero and the
  // ranking would stop discriminating. Swapping Math.min for Math.max here
  // otherwise reds nothing in this file.
  const r = run("the merge loop exit 2 behaviour is undocumented in run-merge-bot.md and elsewhere", {
    filed: ["#1 merge loop exit"],
  });
  assert.equal(r.json.near[0].score, 1, "a fully contained filed row scores 1.0");
});

test("gh returning JSON of the wrong shape is a failed read, not a tracker hit", () => {
  // Parsing succeeded, so the parse guard above does not fire — but the rows are
  // not issues. Reported as hits, this escalates to exit 3 and prints
  // "TRACKER HIT — #undefined", blocking a filing on an answer nobody can read.
  const r = run("candidates.mjs row states the opposite of its code", { filed: [], hits: [1, 2, 3] });
  assert.equal(r.status, 0, "an unreadable answer must not escalate to a tracker hit");
  assert.equal(r.json.tracker.ok, false);
  assert.equal(r.json.tracker.hits, undefined, "wrong-shape output is the same failure arm — hits stays absent");
  assert.equal(r.json.verdict, "unverified");
  assert.match(r.stderr, /TRACKER NOT CHECKED/);
  assert.doesNotMatch(r.stderr, /TRACKER HIT/);
  assert.doesNotMatch(r.stderr, /undefined/, "never print a hit the payload cannot describe");
});

test("a tracker row carrying only an issue number is a failed read, not a tracker hit", () => {
  // The sibling above feeds bare integers, which `!h` and the issue-number check
  // already rejected before this ticket — so it could never reach the case that
  // motivated the invariant it asserts. This one can: an object row passes both
  // of those and still cannot describe itself, because the hit line interpolates
  // the state and the url too. Left unvalidated it printed
  // "TRACKER HIT — #114 (undefined)  — undefined" at the blocking exit code (#232).
  const r = run("candidates.mjs row states the opposite of its code", { filed: [], hits: [{ number: 114 }] });
  assert.equal(r.status, 0, "a row the payload cannot describe must not escalate to a tracker hit");
  assert.equal(r.json.tracker.ok, false);
  assert.equal(r.json.tracker.hits, undefined, "a partial row is the same failure arm — hits stays absent");
  assert.equal(r.json.verdict, "unverified");
  assert.match(r.stderr, /TRACKER NOT CHECKED/);
  assert.doesNotMatch(r.stderr, /TRACKER HIT/);
  assert.doesNotMatch(r.stderr, /undefined/, "never print a hit the payload cannot describe");
});

// Both fields at once is what the sibling above feeds, and that is precisely
// what it cannot pin: either surviving half of the predicate still rejects a row
// missing both, so dropping ONE `typeof` check leaves the whole suite green
// while production prints "TRACKER HIT — #114 (undefined)" or "— undefined" at
// the blocking exit code — the #232 defect itself, back with nothing red (#232).
// One row per field is what makes each half individually mutation-killable.
for (const [missing, drop] of [["state", ({ state: _s, ...rest }) => rest], ["url", ({ url: _u, ...rest }) => rest]]) {
  test(`a tracker row missing only its ${missing} is a failed read, not a tracker hit`, () => {
    const r = run("Non-zero column audit 11 rows", { filed: [], hits: [drop(HIT_114)] });
    assert.equal(r.status, 0, `a row without ${missing} cannot describe itself and must not escalate`);
    assert.equal(r.json.tracker.ok, false);
    assert.equal(r.json.tracker.hits, undefined, "one field short is the same failure arm — hits stays absent");
    assert.equal(r.json.verdict, "unverified");
    assert.match(r.stderr, /TRACKER NOT CHECKED/);
    assert.doesNotMatch(r.stderr, /TRACKER HIT/);
    assert.doesNotMatch(r.stderr, /undefined/, "never print a hit the payload cannot describe");
  });
}

test("a tracker row missing only its title is still reported, not degraded to unverified", () => {
  // The other half of the guard above, and the reason it stops where it does.
  // `title` is the one interpolated field with a defined absent-value — the row
  // builder substitutes `h.title || ""` for it in the row and in the score alike
  // — so this row is fully describable and refusing it would trade a real
  // tracker read for a non-answer. Without this pin a later "tighten the guard"
  // pass adds `title` to the predicate and nothing goes red (#232).
  //
  // Where it lands changed with #388: no title is no tokens, so the row scores
  // 0.00 and the answer is the advisory one rather than the blocking one. The
  // row is still read, still described and still shipped — which is the whole
  // of what #232 asked for. What it must never be is `unverified`.
  const { title: _title, ...noTitle } = HIT_114;
  const r = run("Non-zero column audit 11 rows", { filed: [], hits: [noTitle] });
  assert.equal(r.status, 0, "an unscoreable row is rows to read, not a duplicate finding");
  assert.equal(r.json.tracker.ok, true);
  assert.equal(r.json.verdict, "soft-hit");
  assert.equal(r.json.tracker.hits[0].number, 114);
  assert.equal(r.json.tracker.hits[0].title, "", "the absent title reaches the row as the builder's substitute");
  assert.equal(r.json.tracker.hits[0].state, "OPEN");
  assert.equal(r.json.tracker.hits[0].score, 0, "no title is no tokens to score, which the overlap treats as no overlap");
  assert.match(r.stderr, /TRACKER ROW — #114 \(OPEN, score 0\.00\)/, "the row still reaches stderr, describing itself and its score");
  assert.doesNotMatch(r.stderr, /undefined/, "an empty title is not an undescribable one");
});

test("a ledger hit short-circuits: gh is never invoked", () => {
  const r = run("Non-zero column audit 11 rows", { filed: [FILED_114], hits: [HIT_114] });
  assert.equal(r.status, 1);
  assert.equal(r.ghRan, false, "exit 1 already stops the filing; the query cannot change the answer");
});

test("a subject with no distinctive terms is never sent as an empty search", () => {
  // `gh issue list --search ""` matches every issue in the repo, which would
  // report every such subject as a tracker hit. Not searching is the honest
  // answer, and it still may not read as safe.
  const r = run("the of it", { filed: [], hits: [HIT_114] });
  assert.equal(r.ghRan, false);
  assert.equal(r.json.tracker.ok, false);
  assert.equal(r.json.tracker.hits, undefined, "the no-distinctive-terms arm is the other construction site for `tracker` — hits stays absent there too");
  assert.equal(r.json.verdict, "unverified");
  assert.match(r.stderr, /TRACKER NOT CHECKED/);
  assert.equal(r.status, 0);
});

test("the search query carries at most three sanitised terms and no qualifiers", () => {
  // `is:open` and `candidates.mjs:164` must not reach gh as search qualifiers —
  // they would silently change what was searched for. A fourth term is dropped
  // by design: gh ANDs terms, so the least distinctive one can only subtract
  // (measured — adding it loses #114, the issue this feature exists to catch).
  const r = run("candidates.mjs:164 is:open states the opposite of its code", { filed: [] });
  const query = r.ghArgv[r.ghArgv.indexOf("--search") + 1];
  assert.doesNotMatch(query, /:/, "a colon would let a subject smuggle a search qualifier into the query");
  const terms = query.split(" ").filter(Boolean);
  assert.ok(terms.length <= 3, `expected at most 3 terms, got ${terms.length}: ${query}`);
  const subjectWords = "candidates mjs 164 is open states the opposite of its code".split(" ");
  for (const t of terms) assert.ok(subjectWords.includes(t), `term '${t}' is not from the subject`);
  assert.ok(r.ghArgv.includes("--state") && r.ghArgv.includes("all"), "closed issues are duplicates too");
});

// ---------------------------------------------------------------------------
// Term selection (issue #153). Exact-equality pins, not <=3/subset checks —
// this is the regression gate the issue says did not exist: change the
// stoplist, the >= 3 floor, the sort, or the top-3 cut and one of these must
// go red. Each subject is one of the four the issue measured, kept verbatim
// so the pin is against the reported defect, not a paraphrase of it.
// ---------------------------------------------------------------------------

test("term selection: a subject with no modal/negation/temporal noise is unchanged by the widened stoplist", () => {
  // Ceiling, stated: longest-first still prefers long ordinary words over a
  // short distinctive one. "postgres" (8) loses to "connection" (10) and its
  // near-tied neighbours regardless of the stoplist — none of the displacing
  // words are modal/negation/temporal, so widening STOP cannot reach this
  // case. Frequency weighting is the named, not-attempted upgrade path.
  const r = run("postgres connection pooling exhausted under sustained load", { filed: [] });
  assert.equal(queryOf(r), "connection exhausted sustained");
});

test("term selection: a modal and a negation no longer outrank the subject's content words", () => {
  const r = run("the guard should never fail open on a fork", { filed: [] });
  assert.equal(queryOf(r), "guard fail open", "was 'should guard never' before #153 widened STOP");
});

test("term selection: erasing CI/PR is a stated ceiling, not something this issue fixes", () => {
  // "CI" and "PR" are still dropped by the >= 3 floor — lowering it is
  // explicitly out of scope (#153: it interacts with the whole stoplist and
  // has no gate of its own). Widening STOP with a temporal ("still") is not
  // enough on its own either: "but" is ordinary generic length-3 filler, not
  // a modal/negation/temporal, so it is deliberately left unstopped and still
  // wins the third slot.
  const r = run("CI is red but the PR still merged", { filed: [] });
  assert.equal(queryOf(r), "merged red but");
});

test("term selection: the >= 3 floor itself is pinned, in both directions", () => {
  // The header above claims a floor change must red one of these. It did not:
  // the subject in the ceiling test is invariant under the floor, because `ci`
  // and `pr` lose the longest-first top-3 cut to `merged`/`red`/`but` whether
  // the floor is 3, 2 or 1 — so the whole block was vacuous for the one knob
  // #153 names ("`>= 3` -> `>= 1` currently reds no test").
  //
  // This subject is not invariant: it has exactly two content words at length
  // >= 3, so the third slot is EMPTY at the real floor and gets filled by the
  // short `gh` the moment the floor drops. Measured on the pipeline: "fails
  // cap" at 3, "fails cap gh" at both 2 and 1 — the assertion reds on any
  // loosening, and a tightening to >= 4 drops `cap` and reds it too.
  //
  // `contentWords` in ledger.mjs is the single definition of that floor, so
  // this one pin reaches the scoring path as well as the query path.
  const r = run("gh CI cap fails", { filed: [] });
  assert.equal(queryOf(r), "fails cap");
});

test("term selection: a modal is dropped, but the freed slot goes to another long generic word", () => {
  // "should" is still excluded by the widened STOP, but the freed slot goes
  // to another long generic word ("drops"), not to the short, genuinely
  // distinctive "cap" or "near"/"miss" — the same longest-first ceiling as
  // the postgres case above, left honestly unfixed.
  const r = run("the near-miss cap silently drops rows that should have surfaced", { filed: [] });
  assert.equal(queryOf(r), "silently surfaced drops", "was 'silently surfaced should' before #153 widened STOP");
});

test("term selection: near-miss scoring shares the same widened stoplist", () => {
  // scoreTokens() and the tracker query terms both filter through STOP. Two
  // subjects that use DIFFERENT modal/negation words ("should never" vs.
  // "could still") share no raw token subset — isMatch() correctly misses —
  // but must score as a full 1.0 near-miss once both sides' noise words drop
  // out, or the widened stoplist is only reaching term selection, not scoring.
  const r = run("the fix should never fail open on merge", { filed: ["#9 the fix could still fail open on merge"] });
  assert.equal(r.json.found, false, "raw token sets differ (should/never vs could/still) — not a subset match");
  assert.equal(r.json.near[0].score, 1, "'should'/'never'/'could'/'still' must not count as shared content words");
});

test("a tracker search returning zero hits reports what was established, not a clean bill", () => {
  // #153's ceiling paragraph: a searched-and-empty tracker is not the same
  // claim as "no related issues" — the query is a 3-term heuristic that can
  // itself be why nothing came back.
  const r = run("postgres connection pooling exhausted under sustained load", { filed: [], hits: [] });
  assert.equal(r.json.verdict, "clean", "the JSON contract from #152 is unchanged — only the prose changes");
  assert.match(r.stderr, /returned no matches/);
  assert.doesNotMatch(r.stderr, /found no related issues/, "must not assert the tracker itself is clean");
});

test("the measured #114 rewording surfaces, weakly — it is the tracker query that catches this class", () => {
  // Straight from the issue body: this subject describes the same defect as
  // #114 and `check` reported it safe to file. Token overlap alone barely sees
  // it (one shared content word), so the assertion is deliberately weak — it
  // pins that the row is offered to the caller at all, and documents that
  // near-miss scoring is NOT what covers the #114 class.
  const r = run("candidates.mjs row states the opposite of its code", { filed: [FILED_114] });
  assert.equal(r.json.found, false);
  assert.ok(r.json.near.length >= 1, "the filed row should still be offered for the caller to judge");
  assert.match(r.json.near[0].row, /^#114 /);
  assert.ok(r.json.near[0].score > 0);
});

// ---------------------------------------------------------------------------
// #155 — the tracker query binds to the ledger's own repository, not to
// this process's ambient cwd. `run()`'s spawned `ledger.mjs check` by default
// inherits the outer test-runner's cwd (this checkout), which is itself a
// different repository from the `git init`'d fixture directory the ledger
// lives in below — that mismatch IS the "unrelated working directory" the
// acceptance criteria call for, no second fixture repo needed.
// ---------------------------------------------------------------------------

test("an explicit ledger inside a repository targets that ledger's repository, not the caller's cwd", () => {
  const r = run("some distinctive subject words entirely", { filed: [], hits: [] });
  assert.equal(r.ghRan, true);
  assert.equal(
    r.ghCwd,
    r.ledgerRepoDir,
    "gh must run from the ledger's own repository, not from wherever ledger.mjs's own process happened to start",
  );
  assert.notEqual(
    r.ghCwd,
    realpathSync(process.cwd()),
    "sanity: the test runner's own cwd is a different repository from the fixture — otherwise this test cannot tell the fix from the bug it fixes",
  );
});

test("an explicit ledger outside any git repository reports the tracker unchecked, same shape as any other unread tracker", () => {
  const r = run("some distinctive subject words entirely", { filed: [], hits: [], gitRepo: false });
  assert.equal(r.ghRan, false, "no repository to bind to means gh is never invoked at all");
  assert.equal(r.status, 0, "an unreadable tracker must never block filing — same exit-code contract as every other degrade");
  assert.equal(r.json.tracker.ok, false);
  assert.equal(r.json.tracker.hits, undefined, "hits stays absent, not [], on this arm too");
  assert.equal(r.json.verdict, "unverified");
  assert.match(
    r.stderr,
    /WARNING — TRACKER NOT CHECKED/,
    "reuses the existing unchecked-tracker warning rather than inventing a second one",
  );
  // Pins the repository guard itself, not merely that SOMETHING degraded.
  // Without this the guard is an equivalent mutant: delete it and `ghCwd`
  // becomes "", `execFileSync` throws ENOENT on `cwd: ""` into the gh catch,
  // and every assertion above still reads green off the identical
  // `{ok:false}` shape. Measured: 29/29 passed with the guard removed.
  assert.match(
    r.json.tracker.error,
    /cannot resolve the ledger's repository/,
    "the failure must be attributed to the repository probe, not to gh",
  );
  assert.match(
    r.json.tracker.error,
    /not a git repository/,
    "and it must carry git's OWN reason — the probe pipes git's stderr, so this string is the only place the cause is ever seen",
  );
});

test("a repository probe that fails behind an overrunning git stderr keeps the end, where the cause is", () => {
  // #638's second call site, the one the ticket names alongside the gh catch.
  // This probe pipes git's stderr too, so `tracker.error` is the only copy of
  // it that exists anywhere. Real git puts the reason LAST — it echoes the
  // offending input first and the line saying what actually killed it comes
  // after — so keeping the FIRST bytes hands back the padding and drops the
  // cause.
  //
  // Driven through the REAL git the fixture symlinks, in a directory that IS a
  // repository: an oversized command-line config key. ledger.mjs scrubs
  // GIT_DIR and GIT_WORK_TREE off this probe and nothing else, so a malformed
  // ambient GIT_CONFIG_* reaches it — which is what makes the shape reachable
  // in production and not merely constructible in a fixture.
  //
  // The two matches below are git's own wording. A git that words either
  // differently reds here rather than degrading quietly, which is the
  // direction to fail in.
  const r = run(UNFILED_SUBJECT, {
    filed: [],
    spawnEnv: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "z".repeat(600), GIT_CONFIG_VALUE_0: "x" },
  });
  assert.equal(r.ghRan, false, "the probe failed, so there is no repository for the query to bind to");
  assert.equal(r.status, 0, "an unresolvable repository still degrades rather than blocking the filing");
  assert.equal(r.json.tracker.ok, false);
  assert.equal(r.json.verdict, "unverified");
  assert.match(r.json.tracker.error, /cannot resolve the ledger's repository/, "attributed to the probe, not to gh");
  assert.match(
    r.json.tracker.error,
    /unable to parse command-line config/,
    "git's own last line is the cause — keeping the first bytes drops it for the echoed input ahead of it",
  );
  assert.match(r.json.tracker.error, /: …/, "a clipped cause with no marker reads as the whole of what git printed");
  assert.doesNotMatch(r.json.tracker.error, /z{500}/, "the cause must stay bounded — 600 padding characters went in");
});

test("the documented flow — no --file, run from inside the repo — is unchanged: tracker still gets checked", () => {
  // defaultLedgerPath() resolves `.fleet/ledger.md` from --git-common-dir when
  // no --file is given; `noFile` + `procCwd` drive that path instead of
  // --file. This is the "must ACCEPT" pin: a normal invocation must not start
  // reporting the tracker as unchecked just because #155 added a repository
  // check to the diverging arm.
  const r = run("some distinctive subject words entirely", { filed: [], hits: [], noFile: true });
  assert.equal(r.ghRan, true, "the documented flow must still reach the tracker query");
  assert.equal(r.json.tracker.ok, true);
  assert.equal(r.json.verdict, "clean");
  assert.doesNotMatch(r.stderr, /TRACKER NOT CHECKED/, "a normal invocation must not degrade");
  assert.doesNotMatch(r.stderr, /cannot resolve the ledger's repository/, "the new guard must not fire on the documented flow");
});

test("the documented flow on a FRESH clone — no --file, .fleet/ not created yet — still reaches the tracker query", () => {
  // The accept-pin above pre-creates the ledger directory, so it cannot see
  // this state — and this state is the normal one: `.fleet/` is gitignored
  // (.gitignore) and created lazily by save()'s mkdirSync, so on every fresh
  // clone or worktree it is absent until the run's first write, which `check`
  // by definition precedes. `git -C <missing dir>` exits 128, so a probe
  // aimed at the ledger's own directory read "no repository" and dropped the
  // query outright — verdict clean -> unverified on the flow the fix promised
  // to leave alone. This is the pin that fixture could not be.
  const r = run("some distinctive subject words entirely", { noFile: true, ledgerDirExists: false });
  assert.equal(r.ghRan, true, "a ledger directory that does not exist YET is still inside its repository");
  assert.equal(r.json.tracker.ok, true);
  assert.equal(r.json.verdict, "clean");
  // The state the #231 ruling protects: this run legitimately has no ledger
  // to read, so the flag says so — and the verdict still does not move.
  assert.equal(r.json.ledger.ok, false, "a fresh clone's first check reports the ledger unread, not the run unverified (#231)");
  assert.doesNotMatch(r.stderr, /TRACKER NOT CHECKED/);
  assert.doesNotMatch(r.stderr, /cannot resolve the ledger's repository/);
  assert.equal(r.ghCwd, r.ledgerRepoDir, "and the query is still bound to the ledger's own repository, not the runner's cwd");
});

test("an inherited GIT_DIR or GH_REPO cannot retarget the query away from the ledger's repository", () => {
  // Binding gh's cwd does not, on its own, make the ledger and the queried
  // tracker agree — two env vars outrank the binding, from opposite sides:
  //
  //   GIT_DIR/GIT_WORK_TREE outrank cwd for git, so an ambient one (a git
  //   hook, `rebase --exec`, `bisect run`) reached both the repository probe
  //   and gh unchanged and made gh's remote resolution answer for the other
  //   repository.
  //
  //   GH_REPO is read by gh BEFORE it consults git at all, so the bound cwd
  //   is simply ignored — and this repo's own
  //   .github/workflows/rebase-check-refresh.yml exports it job-wide.
  //
  // Either way the result is `ok: true` with `hits: []` on the wrong
  // tracker — #155 straight back through its own fix. Each assertion below
  // pins one of the three scrubs, and each fails alone.
  const r = run("some distinctive subject words entirely", {
    spawnEnv: { GIT_DIR: join(tmpdir(), "ledger-no-such-git-dir"), GH_REPO: "someowner/some-other-repo" },
  });
  assert.equal(r.ghRan, true, "the probe must not inherit GIT_DIR either — it resolves the repo gh is bound to");
  assert.equal(r.ghEnv.GIT_DIR, "", "gh must see no GIT_DIR, or its remote resolution outranks the bound cwd");
  assert.equal(r.ghEnv.GH_REPO, "", "gh must see no GH_REPO, which outranks the bound cwd outright");
  assert.equal(r.ghCwd, r.ledgerRepoDir);
  assert.equal(r.json.verdict, "clean");
});

test("a working directory that is not a repository at all still degrades exactly as before (no --file)", () => {
  // defaultLedgerPath()'s own pre-existing fallback: --git-common-dir fails,
  // so it warns and returns a cwd-relative path — which #155 leaves alone
  // (out of scope: changing ledger path resolution). The tracker query then
  // finds no repository either, for the same underlying reason, and degrades
  // through the identical `!tracker.ok` branch as the outside-any-repo case.
  const dir = mkdtempSync(join(tmpdir(), "ledger-noreop-"));
  try {
    // `gitRepo: false`: `procCwd` moves ledger resolution to `dir`, so the
    // fixture's own repo and ledger are never consulted — git-initialising it
    // would only imply it were part of what this test pins.
    const r = run("some distinctive subject words entirely", { filed: [], hits: [], noFile: true, gitRepo: false, procCwd: dir });
    assert.equal(r.ghRan, false);
    assert.equal(r.status, 0);
    assert.equal(r.json.tracker.ok, false);
    assert.match(r.stderr, /could not resolve --git-common-dir/, "defaultLedgerPath()'s own existing warning still fires");
    assert.match(r.stderr, /WARNING — TRACKER NOT CHECKED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The design spec's script-surface row advertised `set/filed/ruled/read`: a
// subcommand that has never existed, and two real ones — `row` and `check` —
// left out, `check` being the entire subject of that same row's
// `Non-zero when` cell (#48). Derived from the script's own dispatch rather
// than a hand-written list, for the reason the table proves: a list typed here
// drifts from the script exactly the way the table did. The three other
// hand-typed copies of the list — the row, the usage line, and the
// unknown-subcommand die() message — are all measured against that dispatch
// below.
test("the design spec's script-surface row admits exactly the subcommands ledger.mjs accepts", () => {
  // Read off the dispatch, not the usage line. The usage line is itself a
  // hand-typed list, so deriving the "real" set from it compares one doc-string
  // against another: a branch added to the dispatch without a usage edit left
  // this pin green while the script accepted a subcommand neither the usage line
  // nor the row named (measured). The dispatch is the only thing that decides
  // which subcommand names the script actually accepts.
  const scriptSrc = readFileSync(SCRIPT, "utf8");
  const real = [...new Set([...scriptSrc.matchAll(/cmd === "([^"]+)"/g)].map((m) => m[1]))].sort();
  assert.ok(real.length, "ledger.mjs must still dispatch on `cmd === \"...\"`");

  const spec = readFileSync(
    fileURLToPath(new URL("../../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
    "utf8",
  );
  const row = spec.split("\n").find((l) => l.startsWith("| `ledger.mjs` |"));
  assert.ok(row, "the script-surface table must still carry a ledger.mjs row");

  // The In cell leads with the subcommand alternation and only then reaches the
  // optional flags, so everything before the first `[` is the claim under test.
  const advertised = row.split("|")[2].replaceAll("`", "").split("[")[0].trim().split("/").map((x) => x.trim()).sort();

  // Set equality, both directions: a phantom subcommand sends a caller to an
  // exit 2 it cannot diagnose, and a missing one hides a capability the row's
  // own neighbouring cell already documents.
  assert.deepEqual(advertised, real, `the In cell and ledger.mjs disagree on the subcommand set`);

  // The usage line is another hand-typed copy of this list — the one a caller
  // sees when no subcommand is given at all — so it gets pinned to the same
  // dispatch rather than being the thing everything else is measured against.
  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).stderr;
  const alternation = usage.match(/([a-z]+(?:\|[a-z]+)+)/)?.[1];
  assert.ok(alternation, `ledger.mjs's usage line must still name its subcommands; got: ${usage}`);
  assert.deepEqual(alternation.split("|").sort(), real, `the usage line and ledger.mjs's dispatch disagree on the subcommand set`);

  // The unknown-subcommand die() message is the third hand-typed copy of this
  // list — the one a caller sees for a misspelled subcommand rather than no
  // subcommand at all — so it gets pinned to the same dispatch too.
  const dieList = scriptSrc.match(/unknown subcommand '\$\{cmd\}' — expected ([^`]+)`/)?.[1];
  assert.ok(dieList, "ledger.mjs's unknown-subcommand die() must still name its subcommands");
  const diePin = dieList.replace(" or ", ", ").split(",").map((x) => x.trim()).filter(Boolean).sort();
  assert.deepEqual(diePin, real, "the unknown-subcommand die() message and ledger.mjs's dispatch disagree on the subcommand set");
});

// The Out cell is the other copy of the same claim, and it is the copy that
// drifted: `ledger` reached both of `check`'s payloads while the row still
// typed check as `{subject, found, match, verdict}` (#231). The pin its two
// siblings carry (no-undo-audit.test.mjs, worktree-audit.test.mjs) does not
// transfer verbatim — those cells are bare type signatures, this one documents
// five subcommands in prose, and that prose calls the ledger a ledger ("`read`
// the whole ledger as"), so a word-boundary match over the whole cell reports
// `ledger` present while no payload field is named anywhere. Two things fix
// that: slice to `check`'s own clause, and count only what the cell puts in
// backticks, since a field name is backticked in this table and prose is not.
test("the design spec's script-surface row names every field `check` emits", () => {
  // Both arms. `check` emits two shapes and the already-filed one is the
  // subset, so measuring the row against it alone would let every field the
  // wider arm adds drop out of the row unnoticed.
  const arms = [run(UNFILED_SUBJECT, { filed: [] }), run("Non-zero column audit 11 rows", { filed: [FILED_114] })];
  const keys = [...new Set(arms.flatMap((r) => Object.keys(r.json)))].sort();
  assert.ok(keys.length, "check must still emit a payload for the row to be measured against");

  const spec = readFileSync(
    fileURLToPath(new URL("../../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
    "utf8",
  );
  const row = spec.split("\n").find((l) => l.startsWith("| `ledger.mjs` |"));
  assert.ok(row, "the script-surface table must still carry a ledger.mjs row");

  // `check`'s clause runs from its own name to the next subcommand the cell
  // types. Everything after that belongs to `read` or to the per-field glosses,
  // where these same words appear without naming a field of this payload.
  const out = row.split("|")[3];
  const start = out.indexOf("`check`");
  const end = out.indexOf("`read`", start);
  assert.ok(start >= 0 && end > start, "the Out cell must still type `check`'s payload ahead of `read`'s");
  const named = (out.slice(start + "`check`".length, end).match(/`[^`]+`/g) ?? []).join(" ");

  // Word boundaries on top of the backtick scoping, so `near` cannot be
  // satisfied by the `nearTotal` standing next to it.
  const missing = keys.filter((k) => !new RegExp(`\\b${k}\\b`).test(named));
  assert.deepEqual(missing, [], `the spec row omits fields check emits: ${missing.join(", ")}`);
});

// ── The --file / --require-file parser (#362) ────────────────────────────────
//
// Nothing above this line reaches these guards: every test enters through
// run(), which always builds a well-formed `--file <path>` pair, so the whole
// suite stayed green while `--file --require-file` silently disabled the
// duplicate-filing guard at exit 0 (measured, #362). These spawn the CLI
// directly, the way pr-overlap.test.mjs pins its own `--a --b 5` case — the
// identical fail-open shape, in the hand-rolled reader arg.mjs's shared arg()
// deliberately does not reach.
function cliFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-cli-"));
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  // Same isolation rule the rest of this file follows: the real `gh` must
  // never be reachable, or these assertions would ride on this repo's live
  // issue list. `git` is symlinked in for the same reason run() does it, not
  // because anything below needs it: every test here passes `--file`, so
  // defaultLedgerPath() never shells out, and none reaches the tracker query
  // that runs the second `git`. Kept so the next test added here fails on its
  // own terms rather than silently taking defaultLedgerPath()'s cwd-relative
  // fallback.
  symlinkSync(REAL_GIT, join(bin, "git"));
  const env = { ...process.env, PATH: bin };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // `cwd` is bound here rather than threaded per call because every caller
  // wants this fixture's own dir — and one test needs it to be exactly that:
  // the accept-pin hands ledger.mjs a RELATIVE path, which begins with `-`
  // only because the spawn resolves it against `dir`.
  return { dir, cli: (args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env, cwd: dir }) };
}

test("CLI: --file followed by --require-file is refused, not taken as the path (#362)", (t) => {
  const { cli } = cliFixture(t);
  const r = cli(["--file", "--require-file", "check", "dup subject"]);
  assert.equal(r.status, 2, `--file must not swallow the next flag; got exit ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /--file needs a path/);
  // The harm, asserted directly rather than inferred from the exit code:
  // the swallowed token used to become the ledger PATH, which is how
  // --require-file — the flag whose entire job is to make a missing ledger
  // a hard failure — went missing from the run that named it.
  assert.doesNotMatch(r.stderr, /ledger file not found: --require-file/);
});

test("CLI: --file given a whitespace-only value is refused (#362)", (t) => {
  const { cli } = cliFixture(t);
  const r = cli(["--file", "   ", "check", "dup subject"]);
  assert.equal(r.status, 2, `got exit ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /--file needs a path/);
});

// #362's guard is additive: the trailing case already died, with its own
// wording, and that is the one behaviour the issue's own Measured block
// records as correct. Pinned so the new clause cannot quietly restate it.
test("CLI: a truly trailing --file still dies with its own pre-existing message (#362)", (t) => {
  const { cli } = cliFixture(t);
  const r = cli(["--file"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--file given with no path/);
});

// The other half of the guard. Every case above is input it must REFUSE, and
// a guard that refused EVERYTHING would pass all of them — `startsWith("--")`
// forfeits a path beginning with `--`, deliberately and in line with arg.mjs,
// but it must not cost the far likelier neighbours: a single leading `-`, or
// a `--` anywhere but the front.
test("CLI: a path beginning with '-' or containing '--' is accepted and actually read (#362)", (t) => {
  const { dir, cli } = cliFixture(t);
  // Passed RELATIVE, against the spawn's cwd, so the value ledger.mjs sees
  // genuinely begins with `-`. Handing it join(dir, ...) would begin with
  // `/` instead and pin only the `--`-inside half — measured: a guard
  // widened to `startsWith("-")` kept this test green until the value was
  // relative.
  const name = "-weird--ledger.md";
  writeFileSync(join(dir, name), ledgerText(["#42 some distinctive filed subject words"]));
  const r = cli(["--file", name, "check", "some distinctive filed subject words"]);
  // Exit 1 is reachable only by loading and parsing the file at that path:
  // it is the `already filed` branch, which matches against rows read from
  // it. Exit 0 would mean the path was accepted but never read; exit 2
  // would mean the guard refused it.
  assert.equal(r.status, 1, `the odd-looking path must be accepted AND read; got exit ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /ALREADY FILED/);
});

// --require-file's own exposure, which is NOT --file's: it takes no value, so
// its `splice(idx, 1)` can swallow nothing. Its one way to go missing was
// being eaten by the flag before it. This is the invocation #362 measured as
// correct — exit 2 — next to the exit 0 the swallow produced.
test("CLI: --require-file survives a well-formed --file and still hard-fails a missing ledger (#362)", (t) => {
  const { dir, cli } = cliFixture(t);
  const r = cli(["--file", join(dir, "nope", "ledger.md"), "--require-file", "check", "dup subject"]);
  assert.equal(r.status, 2, `got exit ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /--require-file given but ledger file does not exist/);
});

// The `=` spelling, which `indexOf` cannot see at all. BOTH POSITIONS, because
// the only one that ever failed was the one that happened to land in the
// SUBCOMMAND slot, where `unknown subcommand` fires — a different refusal, and
// the single sample that made the `=` form read as already-covered. Elsewhere
// it is not refused at all: it falls through
// to `rest` and `check`'s `rest.join(" ")` folds it into the SUBJECT, so the
// path is lost AND the checked text is corrupted, and the answer is exit 0
// "safe to file" for a subject this fixture's ledger has already filed. The
// exit-1 assertion below is what makes that concrete: the same subject against
// the same file, spelled with a space, is ALREADY FILED.
test("CLI: --file=<path> is refused in either position, never folded into the subject (#362)", (t) => {
  const { dir, cli } = cliFixture(t);
  const other = join(dir, "other-ledger.md");
  const subject = "some distinctive filed subject words";
  writeFileSync(other, ledgerText([`#42 ${subject}`]));
  // The control: spelled with a space, this exact invocation reads the file
  // and answers "already filed". Without it, exit 2 below would pin only
  // "something refused it", not "the fail-open it replaced was real".
  const ok = cli(["--file", other, "check", subject]);
  assert.equal(ok.status, 1, `the space-separated control must read the file; got exit ${ok.status}\n${ok.stderr}`);
  for (const args of [
    [`--file=${other}`, "check", subject],
    ["check", `--file=${other}`, subject],
  ]) {
    const r = cli(args);
    assert.equal(r.status, 2, `\`${args.join(" ")}\` must be refused; got exit ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--file needs a space-separated value/);
  }
});

// --require-file's own `=` spelling. Its wording differs from --file's on
// purpose and matches has()'s in arg.mjs: the flag takes no value, so "needs a
// space-separated value" would be a lie. Same two positions, same reason.
test("CLI: --require-file=<value> is refused in either position (#362)", (t) => {
  const { dir, cli } = cliFixture(t);
  const missing = join(dir, "nope", "ledger.md");
  for (const args of [
    ["--require-file=true", "--file", missing, "check", "dup subject"],
    ["--file", missing, "check", "--require-file=true", "dup subject"],
  ]) {
    const r = cli(args);
    assert.equal(r.status, 2, `\`${args.join(" ")}\` must be refused; got exit ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /--require-file is a boolean flag/);
  }
});

// The one thing every test above is blind to: cleanup. All seven pass, and all
// seven would still pass with the removal deleted — #569 replaced their
// hand-rolled `finally` blocks with cliFixture()'s own `t.after()`, so this is
// what reddens if that registration is ever dropped. Run as a SUBTEST, because
// a test's `after` hooks have not fired while its own body is still running;
// the parent's `await` resolves only once they have.
test("CLI: cliFixture removes its tmpdir when the test that made it ends (#569)", async (t) => {
  let dir;
  await t.test("a fixture, made and finished with", (inner) => {
    ({ dir } = cliFixture(inner));
    assert.ok(existsSync(dir), "sanity: a fixture's dir exists while its own test runs");
  });
  assert.equal(existsSync(dir), false, `cliFixture registered no cleanup on its test: ${dir} survived it`);
});

// ── A stray flag in a free-text subject tail, or the id slot ahead of it (#584) ──
//
// `--file`/`--require-file` are spliced out of argv by NAME before `cmd`/
// `rest` are ever split, so a misspelled flag is the ordinary way one reaches
// here — though not the only way: the splice is `indexOf`-based and takes one
// occurrence, so a REPEATED correctly-spelled flag survives into the tail too
// and is refused by the same rule. #362 closed the swallow at the
// `--file`/`--require-file` positions; this is the tail beyond them, where a
// stray token used to fold straight into the duplicate-filing subject.
//
// The measured defect: `check --requre-file "widget guard missing"` searched
// for subject "--requre-file widget guard missing" — a DIFFERENT subject than
// the seeded one — and answered exit 0 where the correctly-spelled invocation
// answers ALREADY FILED at exit 1.
test("CLI: a stray flag in check's tail is refused, naming it (#584)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  writeFileSync(file, ledgerText(["#123 widget guard missing"]));
  const r = cli(["--file", file, "check", "--requre-file", "widget guard missing"]);
  assert.equal(r.status, 2, `got exit ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /unknown flag --requre-file/);
  assert.equal(r.stdout, "", "a refusal must not also emit a payload");
});

// The pin a prefix test with no length gate fails: `rest.find(a =>
// a.startsWith("--"))` refuses exactly this invocation — a subject that
// legitimately begins with `--`, given as ONE argument. It must stay
// accepted, and the payload's `subject` field must carry it unchanged. That
// field, specifically: `check` normalises and reorders the subject before it
// becomes `tracker.query`, so unchanged there is not a claim about the query.
test("CLI: a subject legitimately starting with '--' is accepted unchanged, given as one argument (#584)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  writeFileSync(file, ledgerText([]));
  const subject = "--require-file silently absent when value missing";
  const r = cli(["--file", file, "check", subject]);
  assert.equal(r.status, 0, `got exit ${r.status}\n${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).subject, subject, "the payload's subject field must carry it unchanged");
});

// The guard's own false-positive class, distinct from the legitimate
// `--`-leading subject: an unquoted multi-word subject carrying NO `--` at all must stay
// accepted exactly as before — tail LENGTH alone must never be what triggers
// the refusal, only a `--`-prefixed element sharing the tail with it.
test("CLI: an unquoted multi-word subject with no stray flag is still accepted (#584)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  writeFileSync(file, ledgerText(["#1 widget guard missing"]));
  const r = cli(["--file", file, "check", "widget", "guard", "missing"]);
  assert.equal(r.status, 1, `got exit ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /ALREADY FILED/);
});

// Known residual, deliberately left open: a stray flag with no subject at all
// is a ONE-element tail, so refuseStrayInTail() never fires on it — it is
// accepted as the subject itself. Left open because closing it costs the
// legitimate one-argument `--`-leading subject, which is the case #584 exists
// to keep working, and the residual is harmless: the run searches for the
// stray's own normalised text (`--requre-file` queries `requre file`), which
// matches no real row. The exit 0 this asserts also rests on cliFixture's
// stubbed, unreachable gh — it is not a claim that a live tracker would find
// nothing, where a scoring row would exit 3. Pinned so a future change does not
// start refusing it under the belief that widening the guard closes a gap.
test("CLI: a stray flag alone, with no subject, is accepted as the degenerate subject (#584)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  writeFileSync(file, ledgerText([]));
  const r = cli(["--file", file, "check", "--requre-file"]);
  assert.equal(r.status, 0, `got exit ${r.status}\n${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).subject, "--requre-file");
});

// `filed` takes the same free-text tail, past its issue-number argument
// (`subjectParts`, not `rest` — the issue number sits ahead of it), and is
// refused by the same rule.
// Seeded with nothing on purpose: `filed` has no missing-file path of its own
// — save() writes the sections itself — so a pre-created empty ledger here
// would only hide the assertion below, that a refusal leaves no ledger at all.
test("CLI: a stray flag in filed's subject is refused, naming it (#584)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  const r = cli(["--file", file, "filed", "999", "--typo-flag", "some new subject"]);
  assert.equal(r.status, 2, `got exit ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /unknown flag --typo-flag/);
  assert.equal(r.stdout, "", "a refusal must not also emit a payload");
  assert.equal(existsSync(file), false, "a refusal must not write a ledger either");
});

// filed's own subject-legitimately-starting-with-'--' pin, the counterpart
// of check's.
test("CLI: filed accepts a subject legitimately starting with '--', given as one argument (#584)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  const subject = "--flag-like subject text";
  const r = cli(["--file", file, "filed", "888", subject]);
  assert.equal(r.status, 0, `got exit ${r.status}\n${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).subject, subject, "the subject must reach the ledger unchanged");
});

// The stray-flag refusal pins each put the flag FIRST in the tail, so they stay
// green against a guard that only ever inspects `tail[0]` — a narrowing a
// future reader could make believing the tests still cover it. These drive
// the flag into a later position instead, and across all four subcommands
// that read a free-text tail rather than only the two that read it into a
// duplicate-filing answer.
test("CLI: a stray flag is refused from a later position in the tail too, on every tail-reading subcommand (#584)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  for (const argv of [
    ["check", "widget", "guard", "--typo-flag"],
    ["filed", "999", "some new subject", "--typo-flag"],
    ["row", "42", "some state text", "--typo-flag"],
    ["ruled", "77", "merge it", "--typo-flag"],
  ]) {
    const r = cli(["--file", file, ...argv]);
    assert.equal(r.status, 2, `${argv[0]}: got exit ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /unknown flag --typo-flag/, `${argv[0]}: must name the stray`);
    assert.equal(r.stdout, "", `${argv[0]}: a refusal must not also emit a payload`);
  }
  assert.equal(existsSync(file), false, "no refusal may write a ledger");
});

// The tail guard cannot reach the slot ahead of it: a stray flag one token
// earlier becomes the id, and the tail behind it holds no `--` element to
// find. Each subcommand loses something different to that — `filed` its
// duplicate-filing answer, `row` its rewrite-in-place key, `ruled` its
// decision record — so each is driven here on its own.
test("CLI: a stray flag in the id slot ahead of the tail is refused, naming it (#584)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  for (const [cmd, expected] of [
    ["filed", /unknown flag --requre-file — expected an issue number/],
    ["row", /unknown flag --requre-file — expected a ticket number/],
    ["ruled", /unknown flag --requre-file — expected a PR number/],
  ]) {
    const r = cli(["--file", file, cmd, "--requre-file", "999", "widget guard missing"]);
    assert.equal(r.status, 2, `${cmd}: got exit ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, expected, `${cmd}: must name the stray and the slot it displaced`);
    assert.equal(r.stdout, "", `${cmd}: a refusal must not also emit a payload`);
  }
  assert.equal(existsSync(file), false, "no refusal may write a ledger");
});

// The id guard's own false-positive class: an id argument is still accepted
// with or without its `#`, and the legitimate-subject pins still hold, so the bare
// prefix test on that slot cannot be what refuses a legitimate call.
test("CLI: an ordinary id is unaffected by the id-slot guard, with or without '#' (#584)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  const r = cli(["--file", file, "filed", "#999", "widget guard missing"]);
  assert.equal(r.status, 0, `got exit ${r.status}\n${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).issue, "#999");
  const r2 = cli(["--file", file, "row", "42", "some state text"]);
  assert.equal(r2.status, 0, `got exit ${r2.status}\n${r2.stderr}`);
  assert.equal(JSON.parse(r2.stdout).ticket, "#42");
});

// ── The payload subcommands on a pipe (#246) ─────────────────────────────────
//
// `console.log(payload)` followed by `process.exit()` truncates on a pipe.
// process.exit() abandons the queued async write, so the consumer receives
// whatever the kernel had already accepted — at exit 0, which types a corrupt
// payload as a successful one. Measured on this script before the fix: `read`
// of an oversized ledger handed a prefix that JSON.parse rejects to a
// spawnSync consumer at status 0, while the identical command redirected to a
// file delivered all of it and parsed. `board.mjs` is the consumer that made
// it visible — it reads `read` through execFileSync, which pipes stdout just
// the same — and it has no flag that would let it read the ledger any other
// way, so it served a cockpit with an empty board.
//
// Every assertion below is "the payload parses" and "the tail arrived", never
// a byte count. The cut is a pipe-buffer boundary raced against the consumer's
// draining rather than a constant — the same defect has been measured
// delivering one buffer, and on a minority of runs two — so a test pinning
// either number passes only until the race goes the other way.
//
// cli() spawns through spawnSync, whose stdout is a pipe, so these run the
// defect's own path rather than a simulation of it.

// A floor, not a boundary pin: a fixture has to be too large for any observed
// drain outcome to deliver whole by accident, or a still-truncating script
// passes these tests and they pin nothing. Several times the buffer rather
// than merely past it, since two buffers have been measured getting through on
// a minority of runs — and not larger still because three of the four
// subcommands can only be fed an oversized payload through argv, which has two
// separate ceilings: a total across every argument, and a far lower one on any
// single argument. The sweep below stays under the second by splitting its
// tail across several elements, asserted there rather than assumed here.
//
// Asserted in BYTES. String.length counts UTF-16 units, and the `·` these rows
// carry (as real ones do) makes the two disagree, so a cut that is exact in
// bytes reads as a smaller and untidy character count, inviting the false
// conclusion that the cut is fuzzy. No figure is quoted for that: a character
// count belongs to the fixture that produced it, and one carried over from a
// different measurement reads as if it were this one's.
const OVERSIZED = 200_000;

// Linux caps a single argv element at MAX_ARG_STRLEN, 32 pages; darwin caps
// only the total. So a tail sent as one element passes locally and execve
// refuses it on CI — and that refusal is not a truncation: spawnSync returns
// status null, failing the exit-code assertion below and reading exactly like
// the defect these tests exist to catch.
const ARG_STRLEN_MAX = 131_072;

// Built here rather than read from the repo's own `.fleet/ledger.md`: that
// file is whatever the last run left, it has been well under the pipe buffer
// for entire days, and a fixture that small makes every assertion below
// vacuous while still passing.
function oversizedLedger() {
  const rows = [], filed = [], ruled = [];
  for (let i = 0; i < 1600; i++) {
    rows.push(`#${i} impl-${i} · class=routine · ports=81${i} · a row of the width these reach once a run has been going a while`);
    filed.push(`#${i} a filed finding subject with enough distinctive words in it to read like a real one, number ${i}`);
    ruled.push(`#${i} MERGE · the review cleared and the checks were green · entry ${i}`);
  }
  const section = (entries) => entries.map((e) => `- ${e}`).join("\n");
  const text = `# Fleet run ledger\n\n## Rows\n\n${section(rows)}\n\n## Filed\n\n${section(filed)}\n\n## Ruled\n\n${section(ruled)}\n`;
  assert.ok(
    Buffer.byteLength(text) > OVERSIZED,
    `fixture must be far past the pipe buffer or this test pins nothing, got ${Buffer.byteLength(text)} bytes`,
  );
  return { text, rows, filed, ruled };
}

function parsePayload(r, what) {
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    // Report what was observed, never the cause. Truncation is not the only
    // way to get here — an empty stdout, or one a stray line polluted, parses
    // just as badly at exit 0 — and naming the pipe would send a reader after
    // #246 for a defect that is not it. The byte count already says whether
    // the payload stopped on a buffer boundary.
    assert.fail(`${what} payload did not parse — ${Buffer.byteLength(r.stdout)} bytes on stdout at exit ${r.status}: ${e.message}`);
  }
}

test("read hands a pipe the whole ledger — a truncated payload must never read as exit 0 (#246)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  const { text, rows, filed, ruled } = oversizedLedger();
  writeFileSync(file, text);

  const r = cli(["--file", file, "read"]);
  assert.equal(r.status, 0, `read must still exit 0; got ${r.status}\n${r.stderr}`);
  const payload = parsePayload(r, "read's");

  // The whole payload, not a named tail. A truncated one never reaches this
  // line at all — it is unterminated JSON and dies in parsePayload above — so
  // a separate tail assertion discriminated nothing. That is the same thing
  // the grep-shaped reading of this defect got wrong: a consumer that greps
  // still finds the earlier keys, which made it look milder than it is, while
  // a parsing consumer loses every key, the survivors included, because the
  // object is unterminated. Comparing the whole object also catches a key the
  // payload should not carry, which the per-key assertions let through.
  assert.deepEqual(payload, { rows, filed, ruled });
});

// The same mechanism in the three siblings. Their payloads echo the free-text
// tail they were given, which is the only unbounded thing in them, so that is
// what an oversized case has to be built from. Swept with `read` rather than
// after it: fixing only the subcommand a report happens to name is the failure
// this repo keeps re-recording, and all four ended `console.log` + exit 0.
//
// The tail goes over as several argv elements, not one. All three subcommands
// join their trailing arguments with a space, so what they echo is identical
// either way — but one element this size is refused outright by execve on
// Linux, which is a spawn that never happened rather than a payload that
// arrived short.
for (const cmd of ["row", "filed", "ruled"]) {
  test(`${cmd} hands a pipe its whole payload, at its unchanged exit code (#246)`, (t) => {
    const { dir, cli } = cliFixture(t);
    const file = join(dir, "ledger.md");
    writeFileSync(file, ledgerText([]));
    const parts = Array.from({ length: 4 }, () => "alpha bravo charlie delta ".repeat(2000).trim());
    const text = parts.join(" ");
    assert.ok(Buffer.byteLength(text) > OVERSIZED, `tail must be far past the pipe buffer, got ${Buffer.byteLength(text)} bytes`);
    assert.ok(
      parts.every((p) => Buffer.byteLength(p) < ARG_STRLEN_MAX),
      `every argv element must stay under the per-argument ceiling, or execve refuses the spawn and the exit-code assertion below fails for a reason that has nothing to do with a pipe`,
    );

    const r = cli(["--file", file, cmd, "4242", ...parts]);
    assert.equal(r.status, 0, `${cmd} must still exit 0; got ${r.status}\n${r.stderr}`);
    const payload = parsePayload(r, `${cmd}'s`);
    // Each subcommand names its echoed text differently; the guarantee is the
    // same one — whatever it chose to send arrived intact.
    assert.ok(
      JSON.stringify(payload).includes(text),
      `${cmd}'s payload parsed but lost the text it echoes`,
    );
  });
}

// The other half. Everything above is a payload that must ARRIVE; these are
// the invocations that must still be refused or still succeed exactly as they
// did, because dropping a process.exit() from a branch changes where control
// goes next — a `read` branch that merely stops calling exit() runs on into
// the unknown-subcommand die() and turns a good invocation into exit 2, and a
// dispatch rearranged to prevent that can just as easily stop refusing a bad
// one. `check`'s own exit codes are pinned by the whole first half of this
// file, which is why they are not restated here.
test("an ordinary ledger still round-trips through a pipe, and an unknown subcommand still refuses (#246)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  writeFileSync(file, ledgerText([]));

  const row = cli(["--file", file, "row", "7", "impl-7 · class=routine"]);
  assert.equal(row.status, 0, `row: got ${row.status}\n${row.stderr}`);
  assert.deepEqual(parsePayload(row, "row's"), { ticket: "#7", line: "#7 impl-7 · class=routine", created: true });

  const filed = cli(["--file", file, "filed", "8", "a short filed subject"]);
  assert.equal(filed.status, 0, `filed: got ${filed.status}\n${filed.stderr}`);
  assert.deepEqual(parsePayload(filed, "filed's"), { issue: "8", subject: "a short filed subject", total: 1 });

  const ruled = cli(["--file", file, "ruled", "9", "MERGE · green"]);
  assert.equal(ruled.status, 0, `ruled: got ${ruled.status}\n${ruled.stderr}`);
  assert.deepEqual(parsePayload(ruled, "ruled's"), { pr: "9", decision: "MERGE · green", total: 1 });

  const read = cli(["--file", file, "read"]);
  assert.equal(read.status, 0, `read: got ${read.status}\n${read.stderr}`);
  assert.deepEqual(parsePayload(read, "read's"), {
    rows: ["#7 impl-7 · class=routine"],
    filed: ["#8 a short filed subject"],
    ruled: ["#9 MERGE · green"],
  });

  // Nothing in this suite spawned an unknown subcommand before, so the die()
  // every payload branch used to jump over was pinned by nothing at all.
  const unknown = cli(["--file", file, "reed"]);
  assert.equal(unknown.status, 2, `an unknown subcommand must still exit 2; got ${unknown.status}\n${unknown.stderr}`);
  assert.match(unknown.stderr, /unknown subcommand 'reed'/);
  assert.equal(unknown.stdout, "", "a refusal must not also emit a payload");
});

// ── `check` on a pipe (#808) ─────────────────────────────────────────────────
//
// The sweep above cannot reach `check`: it drives the three subcommands whose
// payload echoes an argv tail, and `check`'s does not. Its wide field is
// `match` — a row read straight back out of `data.filed` — so the fixture that
// makes it oversized is a wide LEDGER, not a wide argv, and no ceiling on an
// argv element applies. `filed` caps neither the subject it stores nor the
// ledger it stores it into, so an ordinary four-word `check` reaches the cut
// against a ledger holding one wide row.
//
// Both arms are driven, because the exit these pin is mid-branch. The
// already-filed arm leaves early, and the arm below it is everything that
// early departure exists to skip — a restructure that gets the departure
// wrong breaks one or the other, and only exercising both tells them apart.
//
// run() spawns through spawnSync, whose stdout is a pipe, so these run the
// defect's own path rather than a simulation of it. Its parse is the
// assertion: a truncated payload leaves `json` null, which is what the
// oversized cases below test for, quoting the byte count rather than naming
// the pipe — an empty or polluted stdout fails to parse just as badly.
const WIDE_FILED_ROW = `#4242 ${"alpha bravo charlie delta ".repeat(8000).trim()}`;

test("check hands a pipe its whole ALREADY FILED payload, at its unchanged exit 1 (#808)", () => {
  assert.ok(
    Buffer.byteLength(WIDE_FILED_ROW) > OVERSIZED,
    `the filed row must be far past the pipe buffer or this test pins nothing, got ${Buffer.byteLength(WIDE_FILED_ROW)} bytes`,
  );
  const r = run("alpha bravo charlie delta", { filed: [WIDE_FILED_ROW] });
  // Exit first: this is the ALREADY FILED signal callers gate on, and it is
  // the one thing the defect never moved — a fix that delivers the payload by
  // weakening the signal would trade a corrupt payload for a duplicate filing.
  assert.equal(r.status, 1, `the ALREADY FILED signal must not move; got ${r.status}\n${r.stderr.slice(0, 400)}`);
  assert.ok(
    r.json,
    `check's already-filed payload did not parse — ${Buffer.byteLength(r.stdout)} bytes on stdout at exit ${r.status}`,
  );
  assert.equal(r.json.match, WIDE_FILED_ROW, "the payload parsed but lost the filed row it exists to name");
  assert.equal(r.json.verdict, "already-filed");
});

// What the early departure exists to SKIP, asserted on the payload rather than
// on `gh` alone. The tracker query is only half of it: the near-miss ranking
// runs entirely in this process and never touches `gh`, so a run that never
// invoked it is no evidence the ranking was skipped. The key set is, and it
// also catches the opposite restructure — one that reaches the wider arm's
// fields and merges them in.
test("check's ALREADY FILED payload carries the already-filed shape alone (#808)", () => {
  const r = run("Non-zero column audit 11 rows", { filed: [FILED_114, FILED_131], hits: [HIT_114] });
  assert.equal(r.status, 1, `got ${r.status}\n${r.stderr}`);
  assert.ok(r.json, `already-filed payload did not parse — ${Buffer.byteLength(r.stdout)} bytes on stdout`);
  assert.deepEqual(
    Object.keys(r.json).sort(),
    ["found", "ledger", "match", "subject", "verdict"],
    "the already-filed arm must not pick up the fields of the arm it departs before",
  );
  assert.equal(r.ghRan, false, "the tracker search stays skipped");
  // The emission's own shape — a score follows the phrase — rather than the
  // bare word, so a filed row that happens to use it cannot trip this.
  assert.doesNotMatch(r.stderr, /near-miss \d/, "the near-miss ranking stays skipped");
});

// The other half, and the one the arm above can only be tested against: input
// this must still ACCEPT and carry all the way through. Every case above stops
// early, and a restructure that stopped early ALWAYS would pass all of them —
// so the arm past the departure gets an oversized payload of its own. `near`
// is sliced from `data.filed`, so it is ledger-bounded exactly as `match` is.
//
// The rows share content words with the subject without matching it: each
// carries a term the subject lacks and the subject carries one they lack, so
// neither token set is the other's subset and the exact path cannot fire —
// while the overlap that ranks them stays well above zero.
test("check hands a pipe its whole not-filed payload, and still reaches the tracker (#808)", () => {
  const filed = ["alpha", "bravo", "charlie"].map(
    (tag, i) => `#${800 + i} ${"delta echo foxtrot ".repeat(6000).trim()} ${tag}`,
  );
  const r = run("delta echo foxtrot zulu", { filed, hits: [] });
  assert.equal(r.status, 0, `a ledger with no exact match and a tracker that returns nothing stays exit 0; got ${r.status}\n${r.stderr.slice(0, 400)}`);
  assert.ok(
    r.json,
    `check's not-filed payload did not parse — ${Buffer.byteLength(r.stdout)} bytes on stdout at exit ${r.status}`,
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(r.json.near)) > OVERSIZED,
    `the near-miss rows must be far past the pipe buffer or this test pins nothing, got ${Buffer.byteLength(JSON.stringify(r.json.near))} bytes`,
  );
  // The peer of the already-filed arm's shape pin, and not symmetric with it:
  // that one guards against fields LEAKING in, which the design-spec row above
  // already catches on its own. This one guards against a field going missing,
  // which that row cannot see — it reads the emitted keys, so a key that stops
  // being emitted stops being checked. `subject` is the one field of this arm
  // no other test reads, so dropping it is the mutation that survives the
  // whole suite otherwise.
  assert.deepEqual(
    Object.keys(r.json).sort(),
    ["found", "ledger", "match", "near", "nearTotal", "subject", "tracker", "verdict"],
    "the not-filed arm must still carry every field it names",
  );
  assert.equal(r.json.found, false, "none of these rows is a match, or the ranking below them never runs");
  assert.deepEqual(r.json.near.map((n) => n.row), filed, "the payload parsed but lost the near-miss rows it ranked");
  assert.equal(r.ghRan, true, "the arm past the early departure must still reach the tracker query");
  // These rows share most of the subject's content words, so they sit far
  // above the soft-hit floor — the oversized payload and the verdict it
  // carries are the same statement, and the pipe test is what proves the
  // verdict travelled with it.
  assert.equal(r.json.verdict, "soft-hit");
});

// ── `--require-file` past `check` (#816) ─────────────────────────────────────
//
// An absent ledger and a real empty one produced byte-identical stdout at exit
// 0 with nothing on stderr — measured with `cmp` on both streams — and `read`
// is the subcommand board.mjs consumes, so the cockpit rendered "no ledger
// yet", "ledger read, nothing in it" and "the read did not parse" as one thing.
//
// The flag that separates them already existed. What was missing is where it
// was read: the guard sat inside runCheck(), so `check` honoured it and the
// other four subcommands did not. It is read ahead of the dispatch now, which
// is what docs/specs/2026-07-23-fleet-plugin-design.md's `ledger.mjs` row
// already documented
// ("Exit 2 on any subcommand — ... `--require-file` with no ledger file") and
// what the implementation had never matched.
//
// So the sweep below is the whole class, not the one member #816's title names:
// fixing only `read` leaves three siblings holding the same defect behind the
// same flag. `check` is the fourth and was already correct; the tests above
// pin it, and hoisting the guard leaves its message and its exit code alone.

const READ_EMPTY = { rows: [], filed: [], ruled: [] };

test("read --require-file refuses an absent ledger, naming the path, with no payload (#816)", (t) => {
  const { dir, cli } = cliFixture(t);
  const missing = join(dir, "nope.md");

  const r = cli(["--file", missing, "--require-file", "read"]);
  assert.equal(r.status, 2, `got exit ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, /--require-file given but ledger file does not exist/);
  assert.ok(r.stderr.includes(missing), `the reason must name the path that was looked for; got: ${r.stderr}`);
  // Not "the payload is not the empty shape" but "there is no payload at all".
  // board.mjs's tryParse takes whatever lands on stdout and never sees the exit
  // code, so a refusal that still printed something parseable would be this
  // defect in a new spelling rather than a fix for it.
  assert.equal(r.stdout, "", "a refusal must not also emit a payload");
});

// The pin that separates the two states, and the one that keeps this fix from
// being a new bug: before it, both of these succeeded identically, so a guard
// that refused any ledger holding nothing would satisfy the refusal test above
// and break the first read of every real run — a ledger with no rows yet is
// the normal state of a run that has just started.
test("read --require-file accepts a real EMPTY ledger, unchanged (#816)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  writeFileSync(file, ledgerText([]));

  const r = cli(["--file", file, "--require-file", "read"]);
  assert.equal(r.status, 0, `an empty ledger is still a ledger; got exit ${r.status}\n${r.stderr}`);
  assert.deepEqual(parsePayload(r, "read's"), READ_EMPTY);
  assert.equal(r.stderr, "", "an accepted read says nothing on stderr");
});

// The other half of the ruling. The flag is an opt-in, so every caller that
// does not pass it — board.mjs as it stood, and anything else spawning `read`
// — must still see today's bytes. This is #816's own `cmp`-on-both-streams
// measurement kept as an assertion rather than a paragraph.
test("read WITHOUT the flag is unchanged on both streams, absent and empty alike (#816)", (t) => {
  const { dir, cli } = cliFixture(t);
  const file = join(dir, "ledger.md");
  writeFileSync(file, ledgerText([]));

  for (const [what, path] of [["absent", join(dir, "nope.md")], ["empty", file]]) {
    const r = cli(["--file", path, "read"]);
    assert.equal(r.status, 0, `${what}: a bare read must still exit 0; got ${r.status}\n${r.stderr}`);
    assert.equal(r.stdout, `${JSON.stringify(READ_EMPTY)}\n`, `${what}: read's stdout moved`);
    assert.equal(r.stderr, "", `${what}: read's stderr moved`);
  }
});

// The siblings. These three WRITE, so a missing file is ordinarily legitimate
// — save() creates it, and that is how the first row of a run gets written.
// `--require-file` is precisely the opt-in for a caller that knows the ledger
// must already exist, and the measured behaviour was that `row` under the flag
// happily CREATED the file whose absence the flag exists to refuse. Both
// directions are driven, because a guard that refused unconditionally would
// break every run's first write.
for (const [cmd, args] of [["row", ["7", "impl-7 · class=routine"]], ["filed", ["8", "a short filed subject"]], ["ruled", ["9", "MERGE · green"]]]) {
  test(`${cmd} --require-file refuses an absent ledger and writes nothing, while a bare ${cmd} still creates it (#816)`, (t) => {
    const { dir, cli } = cliFixture(t);
    const missing = join(dir, "nope.md");

    const refused = cli(["--file", missing, "--require-file", cmd, ...args]);
    assert.equal(refused.status, 2, `got exit ${refused.status}\n${refused.stderr}`);
    assert.ok(refused.stderr.includes(missing), `the reason must name the path; got: ${refused.stderr}`);
    assert.equal(refused.stdout, "", "a refusal must not also emit a payload");
    // The harm, not just the exit code: the flag's whole job is to stop a
    // write against a ledger that is not there, and a refusal that had already
    // written would leave the path existing for every later call.
    assert.equal(existsSync(missing), false, "a refused write must not have created the ledger it refused");

    const created = cli(["--file", missing, cmd, ...args]);
    assert.equal(created.status, 0, `without the flag ${cmd} must still create the ledger; got ${created.status}\n${created.stderr}`);
    assert.equal(existsSync(missing), true, "a bare write still creates the ledger it was given");
  });
}
