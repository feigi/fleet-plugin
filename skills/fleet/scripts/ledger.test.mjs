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
import { mkdtempSync, rmSync, writeFileSync, chmodSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./ledger.mjs", import.meta.url));

// `printf '%s\n' "$@"` before any early exit: the argv record has to survive the
// failure paths too, or the "what query did gh receive" assertions can only run
// on the success path.
const GH_STUB = `#!/bin/sh
printf '%s\\n' "$@" > "$GH_ARGS_FILE"
if [ -n "$GH_FAIL" ]; then
  echo "gh: could not authenticate to github.com (HTTP 401)" >&2
  exit 1
fi
cat "$GH_FIXTURE"
`;

// filed rows go in verbatim; the script's own escaping is exercised by the
// `filed` subcommand, which this file does not touch.
function ledgerText(filed) {
  return `# Fleet run ledger\n\n## Rows\n\n\n## Filed\n\n${filed.map((f) => `- ${f}`).join("\n")}\n\n## Ruled\n\n`;
}

// `hits` is what the gh stub prints; `gh: false` removes gh from PATH entirely
// (the "gh not installed" case, which throws ENOENT rather than exiting non-zero
// — a different code path from an auth failure and worth its own coverage).
function run(subject, { filed = [], hits = [], ghFails = false, gh = true, args = [] } = {}) {
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
    spawnSync("mkdir", ["-p", bin]);
    if (gh) {
      const ghPath = join(bin, "gh");
      writeFileSync(ghPath, GH_STUB);
      chmodSync(ghPath, 0o755);
    }
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
  ];
  const r = run("merge loop exit 2 behaviour undocumented in run-merge-bot.md", { filed });
  assert.equal(r.status, 0);
  assert.equal(r.json.near.length, 3, "top-3 cap");
  assert.match(r.json.near[0].row, /^#4 /, "the closest row must rank first");
  const scores = r.json.near.map((n) => n.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), "scores must be descending");
});

test("a subject sharing no content words with any filed row reports no near-misses", () => {
  const r = run("postgres connection pooling exhausted under load", { filed: [FILED_114, FILED_131] });
  assert.equal(r.status, 0);
  assert.deepEqual(r.json.near, []);
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
