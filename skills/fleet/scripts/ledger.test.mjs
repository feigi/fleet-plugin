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
