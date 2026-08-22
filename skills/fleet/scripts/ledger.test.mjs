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
function run(subject, { filed = [], hits = [], ghFails = false, ghGarbage = false, gh = true, args = [], gitRepo = true, noFile = false, procCwd = null, ledgerDirExists = true, spawnEnv = {} } = {}) {
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
    if (ledgerDirExists) writeFileSync(file, ledgerText(filed));
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
    mkdirSync(bin, { recursive: true });
    symlinkSync(REAL_GIT, join(bin, "git"));
    if (gh) {
      const ghPath = join(bin, "gh");
      writeFileSync(ghPath, GH_STUB);
      chmodSync(ghPath, 0o755);
    }
    // No `stdio` override on purpose: the default pipe is what makes `r.stderr`
    // readable at all, and `check`'s stderr stays far under the ~64 KiB pipe
    // buffer where `console.error` + `process.exit()` starts dropping writes
    // (measured on candidates.mjs, issue #132) — so these assertions are honest.
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

test("a subject with no alphanumeric tokens is a usage failure, exit 2", () => {
  const r = run("— — —", { filed: [FILED_114] });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /normalised subject is empty/);
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
    // Five rows must score above the floor, or "capped at three" passes on the
    // filter and never exercises the cap: raising .slice(0, 3) to .slice(0, 10)
    // then reds nothing.
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
  assert.equal(r.json.verdict, "clean", "the near-miss report is advisory and must not touch the verdict");
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
  const r = run("candidates.mjs row states the opposite of its code", { filed: [], hits: [HIT_114] });
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
const filler = (n) => ({
  number: n,
  title: "postgres connection pooling exhausted under sustained load",
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

test("a tracker row missing only its title is still a tracker hit", () => {
  // The other half of the guard above, and the reason it stops where it does.
  // `title` is the one interpolated field with a defined absent-value — the row
  // builder substitutes `h.title || ""` for it in the row and in the score alike
  // — so this row is fully describable and blocking on it would trade a real hit
  // for a non-answer. Without this pin a later "tighten the guard" pass adds
  // `title` to the predicate and nothing goes red (#232).
  const { title: _title, ...noTitle } = HIT_114;
  const r = run("Non-zero column audit 11 rows", { filed: [], hits: [noTitle] });
  assert.equal(r.status, 3, "a describable row still blocks the filing");
  assert.equal(r.json.tracker.ok, true);
  assert.equal(r.json.verdict, "tracker-hit");
  assert.equal(r.json.tracker.hits[0].number, 114);
  assert.equal(r.json.tracker.hits[0].title, "", "the absent title reaches the row as the builder's substitute");
  assert.equal(r.json.tracker.hits[0].state, "OPEN");
  assert.equal(r.json.tracker.hits[0].score, 0, "no title is no tokens to score, which the overlap treats as no overlap");
  assert.match(r.stderr, /TRACKER HIT/);
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
// drifts from the script exactly the way the table did. Both other copies of
// the list — the row and the usage line — are measured against that dispatch.
test("the design spec's script-surface row admits exactly the subcommands ledger.mjs accepts", () => {
  // Read off the dispatch, not the usage line. The usage line is itself a
  // hand-typed list, so deriving the "real" set from it compares one doc-string
  // against another: a branch added to the dispatch without a usage edit left
  // this pin green while the script accepted a subcommand neither the usage line
  // nor the row named (measured). The dispatch is the only thing that decides
  // what the script actually accepts.
  const real = [...new Set([...readFileSync(SCRIPT, "utf8").matchAll(/cmd === "([^"]+)"/g)].map((m) => m[1]))].sort();
  assert.ok(real.length, "ledger.mjs must still dispatch on `cmd === \"...\"`");

  const spec = readFileSync(
    fileURLToPath(new URL("../../../docs/specs/2026-07-23-fleet-plugin-design.md", import.meta.url)),
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

  // The usage line is the other hand-typed copy of this list — the one a caller
  // sees on a bad invocation — so it gets pinned to the same dispatch rather
  // than being the thing everything else is measured against.
  const usage = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" }).stderr;
  const alternation = usage.match(/([a-z]+(?:\|[a-z]+)+)/)?.[1];
  assert.ok(alternation, `ledger.mjs's usage line must still name its subcommands; got: ${usage}`);
  assert.deepEqual(alternation.split("|").sort(), real, `the usage line and ledger.mjs's dispatch disagree on the subcommand set`);
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

// ── The payload subcommands on a pipe (#246) ─────────────────────────────────
//
// `console.log(payload)` followed by `process.exit()` truncates on a pipe.
// process.exit() abandons the queued async write, so the consumer receives
// whatever the kernel had already accepted — at exit 0, which types a corrupt
// payload as a successful one. Measured on this script before the fix: `read`
// of an oversized ledger handed a prefix that JSON.parse rejects to a
// spawnSync consumer at status 0, while the identical command redirected to a
// file delivered all of it and parsed. `board.mjs` is that spawnSync consumer
// and has no flag that would let it read the ledger any other way, so it
// served a cockpit with an empty board.
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
// subcommands can only be fed an oversized payload through argv, which has its
// own ceiling.
//
// Asserted in BYTES. String.length counts UTF-16 units, and the `·` these rows
// carry (as real ones do) makes the two disagree, which is how one measured
// 65536-byte prefix reads as 64456 characters and invites the false conclusion
// that the cut is fuzzy.
const OVERSIZED = 200_000;

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
    assert.fail(`${what} payload did not parse — the pipe truncated it at ${Buffer.byteLength(r.stdout)} bytes, exit ${r.status}: ${e.message}`);
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

  // The tail, named specifically. The payload serialises rows, then filed,
  // then ruled, so ruled's last entry is the furthest thing from the start of
  // the write and the first thing an abandoned write loses — and a consumer
  // that greps still finds the earlier keys, which is what made this look
  // milder than it is. A parsing consumer loses every key, the survivors
  // included, because the object is unterminated.
  assert.equal(payload.ruled.at(-1), ruled.at(-1), "the end of the payload did not arrive");
  assert.deepEqual(payload.rows, rows);
  assert.deepEqual(payload.filed, filed);
  assert.deepEqual(payload.ruled, ruled);
});

// The same mechanism in the three siblings. Their payloads echo the free-text
// tail they were given, which is the only unbounded thing in them, so that is
// what an oversized case has to be built from. Swept with `read` rather than
// after it: fixing only the subcommand a report happens to name is the failure
// this repo keeps re-recording, and all four ended `console.log` + exit 0.
for (const cmd of ["row", "filed", "ruled"]) {
  test(`${cmd} hands a pipe its whole payload, at its unchanged exit code (#246)`, (t) => {
    const { dir, cli } = cliFixture(t);
    const file = join(dir, "ledger.md");
    writeFileSync(file, ledgerText([]));
    const text = "alpha bravo charlie delta ".repeat(8000);
    assert.ok(Buffer.byteLength(text) > OVERSIZED, `tail must be far past the pipe buffer, got ${Buffer.byteLength(text)} bytes`);

    const r = cli(["--file", file, cmd, "4242", text]);
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
