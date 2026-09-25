// Regression gate for merge-gate.mjs (#1800), the merge bot's pre-merge
// conjunction — spec docs/specs/2026-09-24-slot-based-fleet-loop-design.md
// § 5, whose exit-vocabulary table every row below is named after.
//
// Zero deps: `node --test plugin/scripts/merge-gate.test.mjs`.
//
// `gh` is stubbed on PATH. ci-state.mjs and instruments.sh are resolved beside
// merge-gate.mjs itself (its SCRIPT_DIR), so each fixture runs a COPY of the
// gate out of a stub scripts directory holding stub siblings — the pattern
// fleet-tick.test.mjs uses for candidates.mjs — with every module the gate
// imports copied alongside. All three stubs append to one call log, which is
// how the "ci-state runs on every call, with --declare-no-ci" and "read-only"
// assertions are made. The cwd is a real `git init`-ed repository, because
// the gate derives instruments.sh's `--repo` from `git rev-parse
// --git-common-dir`.
//
// Each row gets a case that proves it blocks ON ITS OWN, the discipline
// drop-merged-label.test.mjs states: every input except the one under test is
// held at the mergeable baseline, so deleting a check fails the case named
// after it, not merely some case somewhere.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./merge-gate.mjs", import.meta.url));
// Every non-builtin module the copied gate imports. An unlisted one is a
// module-not-found at startup — Node's exit 1, which is this gate's
// "blocked". Add a row whenever merge-gate.mjs gains an import.
const SIBLING_MODULES = ["arg.mjs", "git-env.mjs"].map((m) => [m, fileURLToPath(new URL(`./${m}`, import.meta.url))]);

const PRE = "a".repeat(40);
const POST = "b".repeat(40);
const THIRD = "c".repeat(40);
const DIGEST = "d".repeat(64);

const PR_VIEW = { labels: [{ name: "patch" }, { name: "ready-to-merge" }], reviewDecision: "APPROVED", headRefOid: PRE };

// Shaped like ci-state.mjs's own payload (its `payload` literal, plus
// `jobs`/`missing` outside --quiet), green at exit 0.
const CI_GREEN = {
  pr: 42,
  branch: "fix/42",
  prHead: PRE,
  runId: 7,
  attempt: 1,
  runHeadSha: PRE,
  status: "completed",
  conclusion: "success",
  behind: 0,
  verdict: "green",
  reasons: [],
  jobs: [{ name: "check", status: "completed", conclusion: "success" }],
  missing: [],
};
const ci = (patch) => JSON.stringify({ ...CI_GREEN, ...patch });

const CI_STATE_STUB = `import { appendFileSync, readFileSync } from "node:fs";
appendFileSync(process.env.CALL_LOG, "ci-state.mjs " + process.argv.slice(2).join(" ") + "\\n");
process.stderr.write(process.env.CI_STDERR ?? "");
process.stdout.write(readFileSync(process.env.CI_STDOUT_FILE));
process.exitCode = Number(process.env.CI_EXIT);
`;

const INSTRUMENTS_STUB = `printf 'instruments.sh %s\\n' "$*" >> "$CALL_LOG"
[ -z "$INSTR_STDOUT" ] || printf '%s\\n' "$INSTR_STDOUT"
exit "$INSTR_EXIT"
`;

const GH_STUB = `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$CALL_LOG"
case "$1 $2" in
  "pr view") cat "$PR_VIEW_FILE"; exit "$PR_VIEW_EXIT" ;;
  *) echo "gh: unstubbed call: $*" >&2; exit 1 ;;
esac
`;

function mktemp(t, prefix) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: cleanEnv() });
  assert.equal(r.status, 0, `fixture: git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

// The runner's own ambient GIT_DIR/GIT_WORK_TREE must not reach a fixture;
// the one case that wants one sets it explicitly.
function cleanEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return env;
}

/**
 * Runs a copy of the gate against stubbed readings. Every option defaults to
 * the mergeable baseline, so a case names only the one reading it changes.
 */
function gate(
  t,
  {
    argv = ["--pr", "42", "--pre", PRE],
    prView = JSON.stringify(PR_VIEW),
    prViewExit = 0,
    ciOut = JSON.stringify(CI_GREEN),
    ciExit = 0,
    ciStderr = "",
    instrOut = DIGEST,
    instrExit = 0,
    cwd = null,
    env = {},
  } = {},
) {
  const root = mktemp(t, "merge-gate-");
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  mkdirSync(scripts);
  mkdirSync(bin);
  const script = join(scripts, "merge-gate.mjs");
  writeFileSync(script, readFileSync(SCRIPT));
  for (const [name, path] of SIBLING_MODULES) writeFileSync(join(scripts, name), readFileSync(path));
  writeFileSync(join(scripts, "ci-state.mjs"), CI_STATE_STUB);
  writeFileSync(join(scripts, "instruments.sh"), INSTRUMENTS_STUB);
  writeFileSync(join(bin, "gh"), GH_STUB, { mode: 0o755 });
  const log = join(root, "calls.log");
  writeFileSync(log, "");
  writeFileSync(join(root, "pr-view.json"), prView);
  writeFileSync(join(root, "ci.out"), ciOut);

  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");

  const res = spawnSync(process.execPath, [script, ...argv], {
    cwd: cwd ?? repo,
    encoding: "utf8",
    env: {
      ...cleanEnv(),
      PATH: `${bin}:${process.env.PATH}`,
      CALL_LOG: log,
      PR_VIEW_FILE: join(root, "pr-view.json"),
      PR_VIEW_EXIT: String(prViewExit),
      CI_STDOUT_FILE: join(root, "ci.out"),
      CI_EXIT: String(ciExit),
      CI_STDERR: ciStderr,
      INSTR_STDOUT: instrOut,
      INSTR_EXIT: String(instrExit),
      ...env,
    },
  });
  return {
    code: res.status,
    stdout: res.stdout,
    stderr: res.stderr,
    json: res.stdout.trim() ? JSON.parse(res.stdout) : null,
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    root,
    repo,
  };
}

const CI_CALL = "ci-state.mjs --pr 42 --declare-no-ci";

// Exit code, verdict, reason — and ci-state called exactly once, with
// --declare-no-ci, which the AC requires on every call whatever the verdict.
function assertRow(r, code, verdict, reason) {
  assert.equal(r.code, code, `exit ${r.code}, expected ${code}\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  assert.equal(r.json.verdict, verdict);
  assert.equal(r.json.reason, reason);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("ci-state.mjs")), [CI_CALL], "ci-state must run once per call, with --declare-no-ci");
}

// --- exit 0 ----------------------------------------------------------------

test("every check holds → 0 mergeable, one JSON line with every field, three read-only calls in spec order", (t) => {
  const r = gate(t);
  assertRow(r, 0, "mergeable", null);
  assert.equal(r.stdout.split("\n").length, 2, "stdout must be exactly one line");
  assert.deepEqual(r.json, {
    pr: 42,
    verdict: "mergeable",
    reason: null,
    head: PRE,
    pre: PRE,
    post: null,
    behind: 0,
    instruments: DIGEST,
    ci: CI_GREEN,
  });
  // The whole call log: nothing merges, labels or rebases, and the three
  // reads run in the order the spec names.
  assert.deepEqual(r.calls, [
    `instruments.sh --repo ${r.repo}`,
    "gh pr view 42 --json labels,reviewDecision,headRefOid",
    CI_CALL,
  ]);
});

test("the rebased path: head and ci-state both on --post → 0", (t) => {
  const r = gate(t, {
    argv: ["--pr", "42", "--pre", PRE, "--post", POST],
    prView: JSON.stringify({ ...PR_VIEW, headRefOid: POST }),
    ciOut: ci({ prHead: POST, runHeadSha: POST }),
  });
  assertRow(r, 0, "mergeable", null);
  assert.equal(r.json.post, POST);
  assert.equal(r.json.head, POST);
});

test("the no-rebase path: --post equal to --pre → 0", (t) => {
  const r = gate(t, { argv: ["--pr", "42", "--pre", PRE, "--post", PRE] });
  assertRow(r, 0, "mergeable", null);
});

test("no-ci verdict with the label present → 0, the arm that cleared visible in ci.verdict", (t) => {
  const r = gate(t, {
    ciOut: JSON.stringify({
      pr: 42,
      branch: "fix/42",
      prHead: PRE,
      runId: null,
      attempt: null,
      runHeadSha: null,
      status: null,
      conclusion: null,
      behind: 0,
      verdict: "no-ci",
      reasons: ["no workflows configured under .github/workflows/ — --declare-no-ci passed, gating on the caller's verified suite run instead"],
    }),
  });
  assertRow(r, 0, "mergeable", null);
  assert.equal(r.json.ci.verdict, "no-ci");
});

test("ci-state's stderr noise never reaches the parse, and is passed through", (t) => {
  const noise = '$ gh run view 7\n{"verdict":"not-green"}\nci-state: verdict=green\n';
  const r = gate(t, { ciStderr: noise });
  assertRow(r, 0, "mergeable", null);
  assert.ok(r.stderr.includes(noise), "the child's diagnostics must reach the gate's stderr");
});

// --- exit 1: blocked ---------------------------------------------------------

test("ready-to-merge absent → 1 label-pulled", (t) => {
  const r = gate(t, { prView: JSON.stringify({ ...PR_VIEW, labels: [{ name: "patch" }] }) });
  assertRow(r, 1, "blocked", "label-pulled");
});

test("reviewDecision CHANGES_REQUESTED → 1 changes-requested", (t) => {
  const r = gate(t, { prView: JSON.stringify({ ...PR_VIEW, reviewDecision: "CHANGES_REQUESTED" }) });
  assertRow(r, 1, "blocked", "changes-requested");
});

// The two gh-read cases hold ci-state's own head read on --pre, so the gh
// read's check is the only one that can block them; the ci-state read's check
// has its own case below.
test("headRefOid outside {pre, post} → 1 head-moved-after-label", (t) => {
  const r = gate(t, {
    argv: ["--pr", "42", "--pre", PRE, "--post", POST],
    prView: JSON.stringify({ ...PR_VIEW, headRefOid: THIRD }),
  });
  assertRow(r, 1, "blocked", "head-moved-after-label");
  assert.equal(r.json.head, THIRD);
});

test("--post omitted: a head that moved off --pre is not excused by any other SHA → 1 head-moved-after-label", (t) => {
  const r = gate(t, { prView: JSON.stringify({ ...PR_VIEW, headRefOid: POST }) });
  assertRow(r, 1, "blocked", "head-moved-after-label");
});

test("ci-state's own head read outside {pre, post} → 1 head-moved-after-label, even with gh's read on --pre", (t) => {
  // A push between the gate's gh pr view and ci-state's own head read: its
  // CI would be judged while the label's audit belongs to the tree before it.
  const r = gate(t, { ciOut: ci({ prHead: THIRD, runHeadSha: THIRD }) });
  assertRow(r, 1, "blocked", "head-moved-after-label");
});

test("ci-state exit 1 (in progress, no conclusion) → 1 ci:<first reason>, runId and status carried for the wait", (t) => {
  const reasons = ["run status is in_progress, not completed", "job check is in_progress, not success"];
  const r = gate(t, {
    ciOut: ci({ status: "in_progress", conclusion: null, verdict: "not-green", reasons }),
    ciExit: 1,
  });
  assertRow(r, 1, "blocked", `ci:${reasons[0]}`);
  assert.equal(r.json.ci.status, "in_progress");
  assert.equal(r.json.ci.runId, 7);
});

test("green with behind 3 → 1 behind:3", (t) => {
  const r = gate(t, { ciOut: ci({ behind: 3 }) });
  assertRow(r, 1, "blocked", "behind:3");
  assert.equal(r.json.behind, 3);
});

// --- exit 2: could not evaluate -----------------------------------------------

test("ci-state rate-limited payload → 2 rate-limited", (t) => {
  const r = gate(t, {
    ciOut: JSON.stringify({ pr: 42, verdict: "rate-limited", reasons: ["gh run list was refused by the GitHub API rate limit — no CI state was read."] }),
    ciExit: 2,
  });
  assertRow(r, 2, "unknown", "rate-limited");
  assert.equal(r.json.ci.verdict, "rate-limited");
  assert.equal(r.json.behind, null);
});

test("ci-state {} payload → 2 ci-unreadable", (t) => {
  const r = gate(t, { ciOut: "{}\n", ciExit: 2 });
  assertRow(r, 2, "unknown", "ci-unreadable");
});

test("ci-state zero-byte payload → 2 ci-unreadable", (t) => {
  const r = gate(t, { ciOut: "", ciExit: 2 });
  assertRow(r, 2, "unknown", "ci-unreadable");
  assert.equal(r.json.ci, null);
});

test("ci-state unparseable payload → 2 ci-unreadable", (t) => {
  const r = gate(t, { ciOut: '{"pr":42,"verdict":"gre', ciExit: 2 });
  assertRow(r, 2, "unknown", "ci-unreadable");
  assert.equal(r.json.ci, null);
});

test("an exit code its payload does not back → 2 ci-unreadable, never a verdict", (t) => {
  // Exit 0 with nothing to gate on is the vacuous pass; exit 1 with no
  // payload is Node's own crash code, not ci-state's not-green; and a code
  // contradicting the verdict it printed has answered nothing.
  const shapes = [
    ["exit 0, {}", "{}\n", 0],
    ["exit 0, zero bytes", "", 0],
    ["exit 1, zero bytes (a crashed ci-state)", "", 1],
    ["exit 0, not-green verdict", ci({ verdict: "not-green", reasons: ["run status is queued, not completed"] }), 0],
    ["exit 1, green verdict", ci({}), 1],
    ["exit 0, green verdict with no behind field", JSON.stringify({ ...CI_GREEN, behind: undefined }), 0],
    ["exit 0, green verdict with no prHead", JSON.stringify({ ...CI_GREEN, prHead: undefined }), 0],
  ];
  for (const [what, ciOut, ciExit] of shapes) {
    const r = gate(t, { ciOut, ciExit });
    assert.equal(r.code, 2, `${what}: exit ${r.code}\n${r.stdout}`);
    assert.equal(r.json.reason, "ci-unreadable", what);
  }
});

test("green with behind null → 2 behind-unknown", (t) => {
  const r = gate(t, { ciOut: ci({ behind: null }) });
  assertRow(r, 2, "unknown", "behind-unknown");
});

test("instruments.sh exit 1 → 2 instrument-set-changed, the digest it printed carried", (t) => {
  const changed = "e".repeat(64);
  const r = gate(t, { instrOut: changed, instrExit: 1 });
  assertRow(r, 2, "unknown", "instrument-set-changed");
  assert.equal(r.json.instruments, changed);
});

test("instruments.sh exit 2 → 2 instruments-unanswerable", (t) => {
  const r = gate(t, { instrOut: "", instrExit: 2 });
  assertRow(r, 2, "unknown", "instruments-unanswerable");
  assert.equal(r.json.instruments, null);
});

test("instruments.sh exit 0 that printed no digest → 2 instruments-unanswerable", (t) => {
  const r = gate(t, { instrOut: "", instrExit: 0 });
  assertRow(r, 2, "unknown", "instruments-unanswerable");
});

test("no git checkout to name the instrument set from → 2 instruments-unanswerable, instruments.sh never run", (t) => {
  const outside = mktemp(t, "merge-gate-nogit-");
  const r = gate(t, { cwd: outside, env: { GIT_CEILING_DIRECTORIES: outside } });
  assertRow(r, 2, "unknown", "instruments-unanswerable");
  assert.equal(r.calls.filter((c) => c.startsWith("instruments.sh")).length, 0);
});

test("gh pr view exits non-zero → 2 pr-unreadable", (t) => {
  const r = gate(t, { prView: "", prViewExit: 1 });
  assertRow(r, 2, "unknown", "pr-unreadable");
  assert.equal(r.json.head, null);
});

test("gh pr view misparses → 2 pr-unreadable", (t) => {
  const shapes = [
    ["non-JSON body at exit 0", "<html>502 Bad Gateway</html>"],
    ["labels missing", JSON.stringify({ reviewDecision: "APPROVED", headRefOid: PRE })],
    ["headRefOid empty", JSON.stringify({ ...PR_VIEW, headRefOid: "" })],
    ["reviewDecision missing", JSON.stringify({ labels: PR_VIEW.labels, headRefOid: PRE })],
  ];
  for (const [what, prView] of shapes) {
    const r = gate(t, { prView });
    assert.equal(r.code, 2, `${what}: exit ${r.code}\n${r.stdout}`);
    assert.equal(r.json.reason, "pr-unreadable", what);
  }
});

test("only CHANGES_REQUESTED blocks: reviewDecision \"\" (no review required), null and REVIEW_REQUIRED → 0", (t) => {
  for (const reviewDecision of ["", null, "REVIEW_REQUIRED"]) {
    const r = gate(t, { prView: JSON.stringify({ ...PR_VIEW, reviewDecision }) });
    assert.equal(r.code, 0, `${JSON.stringify(reviewDecision)}: ${r.stdout}`);
  }
});

// --- precedence ----------------------------------------------------------------

test("the first failing row is the reason, and the JSON still carries every reading", (t) => {
  const notGreen = ci({ status: "in_progress", verdict: "not-green", reasons: ["run status is in_progress, not completed"] });
  const r = gate(t, {
    prView: JSON.stringify({ ...PR_VIEW, labels: [] }),
    ciOut: notGreen,
    ciExit: 1,
    instrOut: "e".repeat(64),
    instrExit: 1,
  });
  assertRow(r, 1, "blocked", "label-pulled");
  assert.equal(r.json.instruments, "e".repeat(64));
  assert.deepEqual(r.json.ci, JSON.parse(notGreen));
  assert.equal(r.json.head, PRE);
});

// --- --repo: the main checkout, whatever the cwd or the environment says ------

test("from a linked worktree, instruments.sh audits the main checkout (--git-common-dir), not the worktree", (t) => {
  // The run's baseline lives in the main checkout's .fleet/, which a
  // worktree does not carry: --show-toplevel there would exit 2 forever.
  const probe = gate(t);
  const main = probe.repo;
  git(main, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
  const wt = join(probe.root, "wt");
  git(main, "worktree", "add", "-q", wt);
  const r = gate(t, { cwd: wt });
  assertRow(r, 0, "mergeable", null);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("instruments.sh")), [`instruments.sh --repo ${main}`]);
});

test("an ambient GIT_DIR cannot move the audited instrument set into another repository", (t) => {
  const other = mktemp(t, "merge-gate-other-");
  git(other, "init", "-q");
  const r = gate(t, { env: { GIT_DIR: join(other, ".git") } });
  assertRow(r, 0, "mergeable", null);
  assert.deepEqual(r.calls.filter((c) => c.startsWith("instruments.sh")), [`instruments.sh --repo ${r.repo}`]);
});

// --- interface ------------------------------------------------------------------

test("--declare-no-ci is not on the gate's surface: refused by name, nothing run", (t) => {
  const r = gate(t, { argv: ["--pr", "42", "--pre", PRE, "--declare-no-ci"] });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown flag --declare-no-ci/);
  assert.equal(r.stdout, "");
  assert.deepEqual(r.calls, []);
});

test("usage: --pr and --pre are both required, refused before any read", (t) => {
  for (const argv of [["--pre", PRE], ["--pr", "42"], []]) {
    const r = gate(t, { argv });
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, /usage: merge-gate\.mjs --pr <n> --pre <sha>/);
    assert.deepEqual(r.calls, []);
  }
});

test("usage: an abbreviated SHA is refused, a full uppercase one is accepted", (t) => {
  // Abbreviated can never equal gh's full headRefOid, so accepting it would
  // skip every PR as head-moved-after-label.
  for (const argv of [["--pr", "42", "--pre", PRE.slice(0, 7)], ["--pr", "42", "--pre", PRE, "--post", "HEAD"]]) {
    const r = gate(t, { argv });
    assert.equal(r.code, 2, argv.join(" "));
    assert.match(r.stderr, /needs a full 40-character commit SHA/);
    assert.deepEqual(r.calls, []);
  }
  const upper = gate(t, { argv: ["--pr", "42", "--pre", PRE.toUpperCase()] });
  assertRow(upper, 0, "mergeable", null);
  assert.equal(upper.json.pre, PRE);
});

test("--out writes the same line, creating missing directories, whatever the verdict", (t) => {
  for (const [label, code] of [["ready-to-merge", 0], ["patch", 1]]) {
    const dir = mktemp(t, "merge-gate-out-");
    const out = join(dir, "pr42", "merge-bot-3", "ci.json");
    const r = gate(t, {
      argv: ["--pr", "42", "--pre", PRE, "--out", out],
      prView: JSON.stringify({ ...PR_VIEW, labels: [{ name: label }] }),
    });
    assert.equal(r.code, code, r.stderr);
    assert.equal(readFileSync(out, "utf8"), r.stdout);
  }
});

test("--out that cannot be written → 2, and no verdict on stdout the file does not carry", (t) => {
  const dir = mktemp(t, "merge-gate-out-");
  writeFileSync(join(dir, "file"), "");
  const r = gate(t, { argv: ["--pr", "42", "--pre", PRE, "--out", join(dir, "file", "ci.json")] });
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /cannot write --out/);
});
