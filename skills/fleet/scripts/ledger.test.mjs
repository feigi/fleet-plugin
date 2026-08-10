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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./ledger.mjs", import.meta.url));

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
function run(subject, { filed = [], hits = [], ghFails = false, ghGarbage = false, gh = true, args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ledger-"));
  try {
    const file = join(dir, "ledger.md");
    writeFileSync(file, ledgerText(filed));
    const fixture = join(dir, "hits.json");
    writeFileSync(fixture, JSON.stringify(hits));
    const argsFile = join(dir, "gh-argv");
    const bin = join(dir, "bin");
    const env = {
      ...process.env,
      GH_FIXTURE: fixture,
      GH_ARGS_FILE: argsFile,
      // PATH is replaced, not prefixed: a prefix leaves the real `gh` reachable
      // the moment the stub's own directory lookup changes, and the ENOENT test
      // would then silently start querying the live tracker.
      PATH: bin,
    };
    if (ghFails) env.GH_FAIL = "1";
    if (ghGarbage) env.GH_GARBAGE = "1";
    mkdirSync(bin, { recursive: true });
    if (gh) {
      const ghPath = join(bin, "gh");
      writeFileSync(ghPath, GH_STUB);
      chmodSync(ghPath, 0o755);
    }
    // No `stdio` override — spawnSync's default is a real OS pipe, not a TTY,
    // and it blocks until the child's fd closes. That is what makes `r.stderr`
    // an honest check of the #152 warning: on a pipe, `console.error` is async
    // and a following `process.exit()` can truncate it before the write lands
    // (measured on candidates.mjs, PR #222/#132) — a TTY write is synchronous
    // and would hide exactly that loss. `check`'s stderr here stays far under
    // the ~64 KiB threshold that provokes it (tracker.error capped at 500
    // chars, hits capped at 5, near capped at 3), so this suite cannot trip
    // the hazard either way — but the capture path is the right one regardless.
    const r = spawnSync(process.execPath, [SCRIPT, "--file", file, "check", ...args, subject], {
      encoding: "utf8",
      env,
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
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
