// Regression gate for the no-CI portability fix (#111): a repo with no
// workflow file must get its own `no-ci` verdict rather than sharing exit 2
// with "the question could not be answered", the workflow file must be
// discovered by the workflow's `name:` rather than assumed to be
// `.github/workflows/ci.yml`, and absence must never silently pass — only
// `--declare-no-ci` flips the gate.
//
// `gh` is stubbed on PATH and logs every call it receives, so a test can
// assert `run list`/`run view` were never reached under no-ci — the point of
// skipping them (#262's REST budget) is unverifiable without that log. `git`
// is real, and the repo fixture IS `git init`-ed: discovery anchors itself to
// `git rev-parse --show-toplevel`, so a non-repo fixture would exit 2 before
// reaching any of this. No `origin` is added, so `git remote get-url origin`
// still fails on its own and the behind-count block degrades to `null`,
// exactly the path it already has a contract for.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, statSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments.mjs";

const SCRIPT = fileURLToPath(new URL("./ci-state.mjs", import.meta.url));

// A `gh` failure carries a MESSAGE, not just an exit code, and the cause a
// caller can act on lives only in that message. `$GH_FAIL_MSG` is how a test
// picks which cause this stub refuses with; empty — the default every fixture
// above already relies on — keeps the bare `exit 1` with a silent stderr.
const GH_STUB = `#!/bin/sh
echo "$*" >> "$GH_LOG"
fail() { [ -n "$GH_FAIL_MSG" ] && echo "$GH_FAIL_MSG" >&2; exit 1; }
case "$1 $2" in
  "pr view") [ -f "$PR_VIEW_FILE" ] && cat "$PR_VIEW_FILE" || fail ;;
  "run list") [ -f "$RUN_LIST_FILE" ] && cat "$RUN_LIST_FILE" || fail ;;
  "run view") [ -f "$RUN_VIEW_FILE" ] && cat "$RUN_VIEW_FILE" || fail ;;
  *) fail ;;
esac
`;

const PR_HEAD = "abc123def";
const BRANCH = "fix/1";
const PR_VIEW = JSON.stringify({
  headRefName: BRANCH,
  headRefOid: PR_HEAD,
  state: "OPEN",
  mergeStateStatus: "CLEAN",
});
const RUN_LIST = JSON.stringify([
  { databaseId: 1, headSha: PR_HEAD, status: "completed", conclusion: "success", event: "pull_request", createdAt: "2026-01-01T00:00:00Z" },
]);
const RUN_VIEW = JSON.stringify({
  jobs: [{ name: "check", status: "completed", conclusion: "success" }],
  attempt: 1,
  status: "completed",
  conclusion: "success",
  headSha: PR_HEAD,
});

// repoFiles: { "relative/path": "content" }, written under a fresh cwd.
// unreadable: repo-relative files OR directories chmod'ed 0o000 for the run and
// restored after, so a permission probe cannot leave an undeletable tmpdir.
// cwd: repo-relative directory to run from, for the repo-root anchoring test.
// pr: the `--pr` value, defaulting to the digits every other fixture wants;
// `null` omits the flag entirely, for the tests that probe how the argument
// itself is refused rather than what it selects.
// gh responses default to the green fixtures above; pass `null` to make that gh
// subcommand fail (exit 1) if reached, so an unexpected call surfaces as a
// crash rather than silently serving the wrong fixture.
function run(args, { repoFiles = {}, unreadable = [], cwd = ".", pr = "42", prView = PR_VIEW, runList = RUN_LIST, runView = RUN_VIEW, ghFailMsg = "", tolerateUnparsedStdout = false, readOnlyStdout = false } = {}) {
  const repoDir = mkdtempSync(join(tmpdir(), "ci-state-repo-"));
  // Discovery resolves `.github/workflows` off `git rev-parse --show-toplevel`,
  // never the cwd, so the fixture has to be a real repo. No remote is added:
  // the behind-count block still degrades to null as before.
  spawnSync("git", ["init", "-q", repoDir], { stdio: "ignore" });
  const binDir = mkdtempSync(join(tmpdir(), "ci-state-bin-"));
  for (const [rel, content] of Object.entries(repoFiles)) {
    const full = join(repoDir, rel);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
  mkdirSync(join(repoDir, cwd), { recursive: true });
  const gh = join(binDir, "gh");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  const ghLog = join(binDir, "gh.log");
  writeFileSync(ghLog, "");

  const fixtureFile = (name, content) => {
    if (content === null) return "";
    const p = join(binDir, name);
    writeFileSync(p, content);
    return p;
  };
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    GH_LOG: ghLog,
    GH_FAIL_MSG: ghFailMsg,
    PR_VIEW_FILE: fixtureFile("pr-view.json", prView),
    RUN_LIST_FILE: fixtureFile("run-list.json", runList),
    RUN_VIEW_FILE: fixtureFile("run-view.json", runView),
  };
  const restore = [];
  for (const rel of unreadable) {
    const full = join(repoDir, rel);
    restore.push([full, statSync(full).mode & 0o777]);
    chmodSync(full, 0o000);
  }
  // readOnlyStdout: hand the child a stdout it cannot write to, so its first
  // write fails with EBADF rather than by racing a reader. CLOSING fd 1 does
  // not do it — libuv reopens a closed standard fd onto /dev/null and the write
  // then succeeds (measured), which is why this opens /dev/null read-only and
  // passes that fd instead. spawnSync then reports no stdout for the child at
  // all, so the eager parse below has nothing to read and skips.
  const roStdout = readOnlyStdout ? openSync("/dev/null", "r") : null;
  let r;
  try {
    r = spawnSync(process.execPath, [SCRIPT, ...(pr === null ? [] : ["--pr", pr]), ...args], {
      cwd: join(repoDir, cwd),
      encoding: "utf8",
      env,
      ...(roStdout === null ? {} : { stdio: ["ignore", roStdout, "pipe"] }),
    });
  } finally {
    if (roStdout !== null) closeSync(roStdout);
    for (const [full, mode] of restore.reverse()) chmodSync(full, mode);
  }
  const log = readFileSync(ghLog, "utf8");
  // Parsing eagerly is what lets every other test assert straight off `payload`,
  // and a parse failure throwing here is the right default: it names a malformed
  // payload at the test that produced it. The pipe-survival tests are the one
  // exception — unparsed stdout is precisely their subject, so they opt out and
  // assert on the raw bytes themselves.
  let payload = null;
  if (r.stdout && r.stdout.trim()) {
    try {
      payload = JSON.parse(r.stdout.trim().split("\n").pop());
    } catch (e) {
      if (!tolerateUnparsedStdout) throw e;
    }
  }
  rmSync(repoDir, { recursive: true, force: true });
  rmSync(binDir, { recursive: true, force: true });
  return { ...r, payload, log };
}

const CI_WORKFLOW = `name: CI
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;
const OTHER_WORKFLOW = `name: Refresh rebase-check
on: [push]
jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

test("no .github/workflows directory: no-ci verdict, exit 1, never reads run list/view", () => {
  const r = run([]);
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "no-ci");
  assert.equal(r.payload.reasons.length, 1);
  assert.match(r.payload.reasons[0], /declare-no-ci/);
  assert.doesNotMatch(r.log, /run list/);
  assert.doesNotMatch(r.log, /run view/);
});

test("no CI + --declare-no-ci: still no-ci verdict, but gate satisfied — exit 0", () => {
  const r = run(["--declare-no-ci"]);
  assert.equal(r.status, 0);
  assert.equal(r.payload.verdict, "no-ci");
  assert.match(r.payload.reasons[0], /gating on the caller's verified suite run/);
});

test("workflow file discovered by name, not the hard-coded ci.yml path — repo behaviour unchanged", () => {
  const r = run([], {
    repoFiles: {
      ".github/workflows/pipeline.yml": CI_WORKFLOW, // not named ci.yml
      ".github/workflows/rebase-check-refresh.yml": OTHER_WORKFLOW, // sibling, different name — must not confuse discovery
    },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
  assert.deepEqual(r.payload.reasons, []);
});

test("two workflow files share the target name: ambiguous, dies (exit 2) rather than guessing", () => {
  const r = run([], {
    repoFiles: {
      ".github/workflows/a.yml": CI_WORKFLOW,
      ".github/workflows/b.yml": CI_WORKFLOW,
    },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /pass --workflow-file to pick one/);
});

// Both routes to an unreadable workflow file refuse with exit 2, and they
// refuse at different depths: discovery opens each candidate as it scans, while
// an explicit --workflow-file target is not read until expectedJobs(). Kept as
// two cases because that difference is the point — a fix that closes only the
// scan leaves the explicit route reading the file as absent, and absent is the
// one shape that can be declared away as no-ci.
for (const [route, args] of [
  ["the discovery scan", []],
  ["an explicit --workflow-file", ["--workflow-file", ".github/workflows/ci.yml"]],
]) {
  test(`an unreadable workflow file reached through ${route}: exit 2, never no-ci`, (t) => {
    if (process.getuid?.() === 0) return t.skip("root reads every file");
    const r = run(args, {
      repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
      unreadable: [".github/workflows/ci.yml"],
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot read/);
  });
}

// --- Error policy (#111): only a genuinely absent workflow set is `no-ci` ---
// The verdict must be reachable one way only: `.github/workflows/` absent, or
// present and holding no workflow files. Every other outcome — the directory
// unreadable, the target unreadable, files present under other names — is exit
// 2, "the question could not be answered", and `--declare-no-ci` must not
// convert any of them to exit 0. The four tests below pin one branch each,
// because the first review of this file reached merge with two of them wrong.

const CI_WORKFLOW_COMMENTED = CI_WORKFLOW.replace("name: CI", `name: "CI"  # main pipeline`);

test("unreadable .github/workflows directory: exit 2, never no-ci — --declare-no-ci cannot wave it through", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every directory");
  for (const args of [[], ["--declare-no-ci"]]) {
    // Same repo, same real CI: only the directory's mode differs. Reading this
    // as no-ci reported "no CI configured" for a repo whose run was `failure`.
    const r = run(args, {
      repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
      unreadable: [".github/workflows"],
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /cannot read/);
    assert.equal(r.payload, null);
  }
});

test("workflow name with a trailing YAML comment (and quotes) still matches — a configured repo never reads as no-ci", () => {
  const r = run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW_COMMENTED } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
});

test("workflow files present but none named CI: exit 2 naming them, never a declarable no-ci", () => {
  for (const args of [[], ["--declare-no-ci"]]) {
    const r = run(args, {
      repoFiles: {
        ".github/workflows/rebase-check-refresh.yml": OTHER_WORKFLOW,
        ".github/workflows/release.yml": OTHER_WORKFLOW.replace("Refresh rebase-check", "Release"),
      },
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /none named 'CI'/);
    assert.match(r.stderr, /rebase-check-refresh\.yml/);
    // The false statement this replaced: "no workflows configured under
    // .github/workflows/" said of a directory full of workflows.
    assert.doesNotMatch(r.stderr, /no workflows configured/);
  }
});

test("an unreadable irrelevant sibling does not blind discovery to a readable target", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every file");
  const r = run([], {
    repoFiles: {
      ".github/workflows/ci.yml": CI_WORKFLOW,
      ".github/workflows/zz-other.yml": OTHER_WORKFLOW,
    },
    unreadable: [".github/workflows/zz-other.yml"],
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
});

test("discovery is anchored to the repo root, not the cwd — a subdirectory answers the same", () => {
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    cwd: "skills/fleet/scripts",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
});

// expectedJobs() refuses on the assumption its derivation rests on, and that
// refusal has to land before the run query — the answer it would otherwise
// spend a REST read on is one it has already decided it cannot give. Nothing
// else in this file reaches the derivation's die() at all, so the gh log is
// what pins the order rather than the refusal alone.
const CI_WORKFLOW_NAMED_JOB = CI_WORKFLOW.replace("  check:\n", "  check:\n    name: Check\n");

test("an invalid job derivation refuses before the run list is ever requested", () => {
  const r = run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW_NAMED_JOB } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /derivation invalid/);
  assert.doesNotMatch(r.log, /run list/, `the derivation must refuse before the query, and gh was asked: ${r.log}`);
});

// --- The not-green detectors, one negative case each ------------------------
// Every fixture above is green, so the four `reasons.push` branches this PR
// relocated into the `else` arm were never entered: deleting any one of them
// left the whole suite passing, and each deletion is a silent false green
// reaching board.mjs's mapCi() and the merge bot's gate. The relocation itself
// was covered; the detectors' true branches were not.

const TWO_JOB_WORKFLOW = `name: CI
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
  integration:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

const notGreen = (overrides, repoFiles = { ".github/workflows/ci.yml": CI_WORKFLOW }) =>
  run([], { repoFiles, runView: JSON.stringify({ ...JSON.parse(RUN_VIEW), ...overrides }) });

test("run bound to another commit: not-green, exit 1 — the cancelled-run-on-a-superseded-SHA case", () => {
  const r = notGreen({ headSha: "0000000" });
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "not-green");
  assert.match(r.payload.reasons.join("; "), /run headSha 0000000 != PR head abc123def/);
});

test("run still in progress: not-green, exit 1 — an incomplete run is not a pass", () => {
  const r = notGreen({ status: "in_progress" });
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "not-green");
  assert.match(r.payload.reasons.join("; "), /run status is in_progress, not completed/);
});

test("expected job absent from the run: not-green, exit 1 — an absent job reads as pending, never as green", () => {
  const r = notGreen({}, { ".github/workflows/ci.yml": TWO_JOB_WORKFLOW });
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "not-green");
  assert.match(r.payload.reasons.join("; "), /expected jobs absent from the run: integration/);
});

test("`skipped` is not `passed`: a skipped job is not-green, exit 1", () => {
  const r = notGreen({ jobs: [{ name: "check", status: "completed", conclusion: "skipped" }] });
  assert.equal(r.status, 1);
  assert.equal(r.payload.verdict, "not-green");
  assert.match(r.payload.reasons.join("; "), /job check is skipped, not success/);
});

// --- #169: a flag given with no value must die, never read as absent -------
// `base`/`workflow`/`workflow-file` all read via `arg(name) || default`, so a
// trailing flag previously fell straight through to the DEFAULT — the caller
// asked to gate on a specific base/workflow and silently got a real verdict
// against the wrong one instead of a refusal. Pinned as the priority site
// (feigi's PR #167 review comment): `ci-state.mjs --pr 5 --base` used to
// compare against `main` with no signal anything was wrong.

test("trailing --base (no value) dies (exit 2) rather than silently comparing against the default base", () => {
  const r = run(["--base"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--base needs a value/);
  assert.doesNotMatch(r.log, /pr view/, "must die before ever asking gh anything");
});

test("--workflow=CI form dies by name, not silently read as absent (indexOf cannot see it)", () => {
  const r = run(["--workflow=CI"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--workflow needs a space-separated value/);
});

// #364: has() used exact argv.includes, so a boolean flag written --name=value
// (in ANY form the value takes) silently read as absent — dropping the
// caller's declared no-CI opt-out with no signal. The wording has to say
// "boolean flag", distinct from arg()'s "needs a space-separated value" above:
// a boolean has no value to give in the first place.
for (const flag of ["declare-no-ci", "quiet"]) {
  for (const v of ["=true", "=false", "="]) {
    test(`--${flag}${v} dies as a boolean flag, never silently read as absent`, () => {
      const r = run([`--${flag}${v}`]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, new RegExp(`--${flag} is a boolean flag, not --${flag}=`));
      assert.doesNotMatch(r.log, /pr view/, "must die before ever asking gh anything");
    });
  }
}

// Position, not just spelling — and run()'s fixed `--pr 42` prepend does NOT
// supply it: a fixed prepend gives a FIXED offset, so all six cases in the
// loop above land their flag at process.argv[4] and a guard narrowed to that
// one index passes every one of them. Robustness needs the flag at DIFFERENT offsets across
// cases (#462 review); this is the only case that supplies one. --declare-no-ci
// is the flag worth spending it on: read as absent, it drops the caller's
// opt-out and the gate answers on a suite nobody ran.
test("--declare-no-ci=true dies behind another flag too, not only at the front of argv", () => {
  const r = run(["--quiet", "--declare-no-ci=true"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--declare-no-ci is a boolean flag, not --declare-no-ci=/);
  assert.doesNotMatch(r.log, /pr view/, "must die before ever asking gh anything");
});

// The control: the new `=` guard must not touch the bare spelling. --quiet's
// STDERR effect is what pins it here (--declare-no-ci's bare form is already
// pinned above, by its effect on verdict/exit code): vlog's command echoes
// vanish from stderr, though the same gh calls still ran (r.log is written by
// the stub itself, unconditionally). Its PAYLOAD effect is the next test's.
test("--quiet still reads as present in its bare spelling — the = refusal is not a blanket one", () => {
  const loud = run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW } });
  assert.equal(loud.status, 0, loud.stdout + loud.stderr);
  assert.match(loud.stderr, /\$ gh pr view/);

  const quiet = run(["--quiet"], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW } });
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  assert.doesNotMatch(quiet.stderr, /\$ gh pr view/);
  assert.match(quiet.log, /pr view/, "gh still ran despite the quieter stderr");
});

// #677. The other half of what `--quiet` does, and the half the flag exists for:
// `jobs` and `missing` leave the JSON payload with it and are present without
// it. Same fixture both ways, so the flag is the only difference. The field
// names are spelled out rather than derived from ci-state.mjs — deriving them
// from the assignment under test would make this pass vacuously if that
// assignment changed, which is the one thing it must not do. The deriving is
// `quiet-payload-prose.test.mjs`'s job, over the prose that has to agree.
test("--quiet drops `jobs` and `missing` from the payload; without it they are there", () => {
  const opts = { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW } };
  const loud = run([], opts);
  const quiet = run(["--quiet"], opts);
  assert.equal(loud.status, 0, loud.stdout + loud.stderr);
  assert.equal(quiet.status, 0, quiet.stdout + quiet.stderr);
  for (const field of ["jobs", "missing"]) {
    assert.ok(field in loud.payload, `without --quiet the payload must carry \`${field}\`, and it reads ${JSON.stringify(loud.payload)}`);
    assert.ok(!(field in quiet.payload), `--quiet must drop \`${field}\` from the payload, and it reads ${JSON.stringify(quiet.payload)}`);
  }
});

test("trailing --pr (no value, the entry flag itself) still dies naming the flag", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--pr"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--pr needs a value/);
});

// The other two branches of the same guard: a flag eating the NEXT FLAG as its
// value, and an explicit whitespace-only value. Deleting either clause from
// arg() left this suite 18/18 green before these two existed.
test("--base followed by another flag is rejected, not read as the string \"--workflow\"", () => {
  const r = run(["--base", "--workflow", "CI"]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--base needs a value/);
  assert.doesNotMatch(r.log, /pr view/, "must die before ever asking gh anything");
});

test("--base given a whitespace-only value dies rather than comparing against the default base", () => {
  const r = run(["--base", "   "]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--base needs a value/);
});

// --- #269: parsing a gh reply is not the same as it being the right shape --
// A reply that parses cleanly but is the wrong shape (an error object where
// an array is expected, a run view missing its jobs) previously flowed on
// unchecked until the first dereference threw — and an uncaught throw exits
// 1, this script's code for "not bound-green". Each case below pins the
// class: exit 2, naming the query and the field, before the crash site is
// ever reached. #232's caution is why the row-level cases exist too — a
// guard that checks the array but not its elements is itself a partial
// guard, and jobs/runs rows are read (`j.name`, `r.headSha`) unguarded.

test("PR info missing headRefOid: exit 2 naming the field, never a silent \"undefined\" verdict later", () => {
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    prView: JSON.stringify({ headRefName: BRANCH, state: "OPEN", mergeStateStatus: "CLEAN" }),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /pr view/);
  assert.match(r.stderr, /headRefOid/);
  assert.doesNotMatch(r.log, /run list/, "must die before ever asking gh for runs");
});

// Each identifying field is guarded on its type AND on its emptiness, and
// neither clause is reachable through the other: an empty string satisfies the
// type check, a number satisfies the emptiness check. The sibling above feeds
// an ABSENT field, which both clauses refuse at once — so it pins neither.
// What a lost clause costs is the field flowing on: `branch` becomes the empty
// string or a number and `gh run list --branch` asks for the wrong branch,
// while `prHead` becomes a value no run's headSha can equal, which reads as
// the superseded-SHA case rather than as a reply that could not be trusted.
for (const [what, field, headRefName, headRefOid] of [
  ["an empty branch name", "headRefName", "", PR_HEAD],
  ["a non-string branch name", "headRefName", 42, PR_HEAD],
  ["an empty head sha", "headRefOid", BRANCH, ""],
  ["a non-string head sha", "headRefOid", BRANCH, 42],
]) {
  test(`PR info carrying ${what}: exit 2 naming the field, never a verdict built on it`, () => {
    const r = run([], {
      repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
      prView: JSON.stringify({ headRefName, headRefOid, state: "OPEN", mergeStateStatus: "CLEAN" }),
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /pr view/);
    assert.match(r.stderr, new RegExp(field));
    assert.doesNotMatch(r.log, /run list/, "must die before ever asking gh for runs");
  });
}

test("run list returns an error object, not an array: exit 2, never the crash from runs.filter", () => {
  // The ticket's own reproduction: gh exits 0 printing an error body where
  // --json databaseId,headSha,... normally produces an array.
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify({ error: "rate limited" }),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /run list/);
  assert.match(r.stderr, /expected an array of runs/);
});

test("run list row is null: exit 2, never the crash reading r.headSha off null", () => {
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify([null]),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /run list row 0 is not an object/);
});

test("run view missing jobs array: exit 2 naming the field, never silently read as zero jobs", () => {
  // No `jobs` key at all — the shape an error-ish or partial run view takes.
  // This guard is now the only thing between that and `view.jobs.map(...)`:
  // drop it and the read throws, and an uncaught throw exits 1 — "could not
  // be read" rendered as a CI verdict, the whole #269 class.
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runView: JSON.stringify({ attempt: 1, status: "completed", conclusion: "success", headSha: PR_HEAD }),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /run view/);
  assert.match(r.stderr, /missing jobs array/);
});

test("a job entry in the run view is null: exit 2, never the crash reading j.name off null", () => {
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runView: JSON.stringify({ jobs: [null], attempt: 1, status: "completed", conclusion: "success", headSha: PR_HEAD }),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /job entry 0 is not an object/);
});

// The refusal names a POSITION, and a fixture whose malformed element sits
// first is satisfied by a guard that only answers "is one of them bad". Each
// site carries a well-formed element ahead of the bad one so the reported
// index has to be derived rather than guessed. Nothing reads the index today;
// it is the diagnostic a human gets for a reply gh really sent, so being wrong
// about which element was malformed sends them to the wrong one.
test("a run list row after a well-formed one is malformed: the refusal names that row's position", () => {
  const [current] = JSON.parse(RUN_LIST);
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify([current, null]),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /run list row 1 is not an object/);
});

test("a job entry after a well-formed one is malformed: the refusal names that entry's position", () => {
  const view = JSON.parse(RUN_VIEW);
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runView: JSON.stringify({ ...view, jobs: [...view.jobs, null] }),
  });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /job entry 1 is not an object/);
});

// The direction these guards get wrong on their own: what they wrongly REFUSE.
// Every fixture above is malformed by construction, so none of them can show
// that a well-formed reply carrying more than one row still reaches a verdict
// — and more than one row is the shape gh returns for any branch with a run
// history, the normal case rather than an edge one. A guard tightened past it
// refuses a working invocation, which costs more than the diagnostic above.
test("a run list whose rows are all well-formed still reaches a verdict, superseded rows included", () => {
  const [current] = JSON.parse(RUN_LIST);
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runList: JSON.stringify([
      { ...current, databaseId: 2, headSha: "0000000", createdAt: "2025-12-31T00:00:00Z" },
      current,
    ]),
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
});

// isObject is the whole refusal at the row and job level, so each of its
// clauses is load-bearing alone. Every malformed row and job fixture elsewhere
// in this file is `null`, which the null clause already refuses on its own —
// an array and a scalar are what separate the other two from decoration. Both
// degrade quietly rather than crashing, which is why they need pinning: an
// array job yields `undefined` for every field read off it, and a scalar the
// same, so the run reports jobs it never saw instead of refusing the reply.
for (const [what, entry] of [
  ["an array", []],
  ["a scalar", "check"],
]) {
  test(`a job entry that is ${what}: exit 2, never read as a job with no fields`, () => {
    const r = run([], {
      repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
      runView: JSON.stringify({ jobs: [entry], attempt: 1, status: "completed", conclusion: "success", headSha: PR_HEAD }),
    });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /job entry 0 is not an object/);
  });
}

// The false-positive class the guard must NOT create: an in-progress job's
// `conclusion` is legitimately `null`, not a missing/wrong-shaped field. If
// the shape check validated field types instead of just object-ness, this
// well-formed reply would itself start being refused.
test("in-progress job with conclusion:null is accepted — not refused as malformed shape", () => {
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
    runView: JSON.stringify({
      jobs: [{ name: "check", status: "in_progress", conclusion: null }],
      attempt: 1,
      status: "in_progress",
      conclusion: null,
      headSha: PR_HEAD,
    }),
  });
  assert.equal(r.status, 1, r.stdout + r.stderr); // not-green (still running) — never exit 2
  assert.equal(r.payload.verdict, "not-green");
  assert.doesNotMatch(r.stderr, /not the expected shape/);
});

// #365's other half. The sweep refuses any `--` token not in this script's
// known set, so a name missing from that set refuses an invocation this script
// accepts — "worse than the bug" by the ticket's own words. Measured, dropping
// `base` or `workflow` reddens THIS test and nothing else; the other four names
// also redden tests above, which happen to pass them.
//
// So: every flag ci-state.mjs accepts, in ONE green run. --workflow-file is the
// one that would not otherwise be here, because its arg() call sits far below
// the sweep, next to discoverWorkflowFile — the sweep needs the NAME, and a set
// built by reading down to the first gh call would miss it.
//
// Relative to cwd on purpose: run() builds its repo in a fresh tmpdir this
// scope cannot name, and the script resolves an explicit --workflow-file
// against cwd, which run() sets to that repo.
test("every flag ci-state.mjs accepts survives the unknown-flag sweep in one invocation", () => {
  const r = run(["--base", "main", "--workflow", "CI", "--workflow-file", ".github/workflows/ci.yml", "--declare-no-ci", "--quiet"], {
    repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW },
  });
  assert.equal(r.status, 0, `a working invocation was refused: ${r.stderr}`);
  // Live, not subsumed by the status assertion above: the behind-count block
  // TOLERATES its children — tryRun() swallows the failure and returns null
  // while execFileSync has already forwarded the child's stderr — so a child
  // refusing a flag lands here at exit 0 with `behind` silently null. Matches
  // git's "unknown option" as well as the fleet's own "unknown flag", because
  // the tolerated children are git's: measured, a bogus flag on the `git
  // remote get-url` call is otherwise 35/35 green.
  assert.doesNotMatch(r.stderr, /unknown (flag|option)/);
  assert.equal(r.payload.verdict, "green");
});

// --- #262: a quota refusal is a distinguishable cause, not a generic failure -
// Every `gh` read failure landed on one arm that reported the exit code and
// nothing a caller could act on — an exhausted REST quota, a repo that cannot
// be resolved and a revoked token were one undifferentiated cause. The correct
// responses differ: a quota refusal recovers on its own and is worth re-probing
// shortly, the others need someone to look, so the cause is named in the
// PAYLOAD. That is where the fleet's gates read this script — `run-team`'s
// SKILL.md directs a merge bot to gate on the payload's own fields and warns
// that an empty payload, which is all this arm produced, "reads as a block, not
// a pass — the safe direction, but still a false one".
//
// No test reached this arm before: every other exit-2 case here dies in
// workflow discovery or in a shape check, never in the subprocess failure path.
// `$GH_FAIL_MSG` is what makes the two causes drivable, and the pair below is
// the point — either test alone passes a script that ignores the cause entirely.

// The quota refusal as `gh` actually words it, wrapping the REST body.
const RATE_LIMIT_STDERR =
  "couldn't fetch workflows for feigi/claude-config: HTTP 403: API rate limit exceeded for user ID 1234.";
// A failure that is NOT a quota refusal and never recovers by waiting.
const MISSING_REPO_STDERR = "could not resolve to a Repository with the name 'feigi/nope'";

const ghFailure = (ghFailMsg) =>
  run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW }, runList: null, ghFailMsg });

test("a rate-limited gh read names the quota as its cause in the payload, at the unchanged exit 2", () => {
  const r = ghFailure(RATE_LIMIT_STDERR);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.payload, "a quota refusal must emit a payload — the cause is unreadable to a gate that only sees stderr");
  assert.equal(r.payload.verdict, "rate-limited");
  assert.match(r.payload.reasons.join("; "), /rate limit/i);
  // `pr` is the payload's only identifying field, and the fleet polls this
  // script for several PRs at once — an outage attributed to the wrong one, or
  // carrying a string where every other payload here carries a number, is
  // indistinguishable from a correct report at the point a caller reads it.
  // assert/strict, so this pins the type as well as the value.
  assert.equal(r.payload.pr, 42);
  // The refused query, not merely that a quota was mentioned: `pr view` is
  // GraphQL and `run list`/`run view` are REST, so which one was refused is
  // what separates an exhausted REST quota from a token or repo problem. The
  // fixture refuses `run list` — keep this literal in step with it.
  assert.match(r.payload.reasons.join("; "), /gh run list/);
});

// GitHub's older spelling of the same self-clearing secondary limit, still
// emitted by a GHE Server predating the rename. Without this the alternation in
// RATE_LIMITED is unpinned: dropping it leaves every test above green, because
// they all drive the current wording.
const LEGACY_ABUSE_STDERR =
  "HTTP 403: You have triggered an abuse detection mechanism. Please wait a few minutes before you try again.";

test("the pre-rename secondary-limit wording is read as a quota refusal too", () => {
  const r = ghFailure(LEGACY_ABUSE_STDERR);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.ok(r.payload, "the abuse-detection spelling is the same self-clearing limit under its old name");
  assert.equal(r.payload.verdict, "rate-limited");
});

// The bound on that alternation: `abuse` alone appears in refusals no wait
// clears, so matching the short form would tell a caller to re-probe a
// repository that has been disabled outright.
const DISABLED_REPO_STDERR =
  "HTTP 403: Repository access blocked. This repository has been disabled for abuse of GitHub's terms of service.";

test("a repository disabled for abuse is NOT a quota refusal", () => {
  const r = ghFailure(DISABLED_REPO_STDERR);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.payload, null, "a permanent block must not be reported as an outage that clears on its own");
});

test("a gh read failing for any other reason reports exactly as it did before: exit 2, no payload", () => {
  const r = ghFailure(MISSING_REPO_STDERR);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.payload, null, "only a quota refusal earns a payload; every other cause is unchanged");
  assert.match(r.stderr, /gh failed/);
});

// The outage payload must not be mistaken for a reading. A quota refusal is a
// probe that could not look, so it reports no CI state at all. Emitting these
// as nulls or empty arrays would let unobserved state read as observed: an
// empty `missing` says "nothing is missing", which is a reading, where an
// absent one refuses the `jq` gate run-team/SKILL.md sends a merge bot to write
// over "the payload's own fields — `verdict`, `behind`, `missing`, the per-job
// conclusions, and `prHead == runHeadSha`". That doc names the shape of the
// risk itself: "An empty payload reads as a block, not a pass."
test("the outage payload reports no CI state it could not observe", () => {
  const r = ghFailure(RATE_LIMIT_STDERR);
  for (const field of ["status", "conclusion", "jobs", "missing", "runId"]) {
    assert.ok(
      !(field in r.payload),
      `a probe that never read CI must not report \`${field}\`, and the payload reads ${JSON.stringify(r.payload)}`,
    );
  }
});

// #890: the same one-line/one-terminator contract the verdict payload is held to
// below, at the other call site that writes a payload to stdout. emit() appends
// no newline of its own, so each site supplies its own: supplying none runs this
// payload together with whatever the caller polling a rate-limited PR prints
// next, and supplying two ends the output early for a reader that treats a blank
// line as the end of it. Both were green here before this assertion — the
// quota-refusal tests above all read `payload`, and the harness parses that from
// a TRIMMED stdout, so every one of them is blind to the terminator by
// construction.
//
// Compared against a re-serialisation of the payload this very run emitted
// rather than against a literal copy of it, which is what keeps the assertion
// about the terminator alone: rewording a reason, or adding a field, changes
// both sides together and stays green, while any change to the trailing bytes
// reds. A literal would instead have to be re-typed every time the refusal text
// moved, and would red for the wrong reason when it was.
test("the rate-limited payload is emitted byte for byte too: one line, one trailing newline", () => {
  const r = ghFailure(RATE_LIMIT_STDERR);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.equal(r.stdout, `${JSON.stringify(r.payload)}\n`);
});

// --- #840: a non-numeric --pr must refuse, never ship an unnamed payload -----
// `--pr` was validated for truthiness alone, so `--pr abc` reached both payload
// sites. Each builds `pr: Number(pr)`, and `JSON.stringify(NaN)` is `null` — the
// normal path shipped a payload with no identifying field at exit 0 under
// `verdict: "green"`, the verdict the fleet gates on.
//
// The gh receipt below is the load-bearing assertion, not decoration. Exit 2, an
// empty stdout and a matching stderr line are each reproducible by a LATER
// guard: downgrade this one to a warning and the script runs on, gh fails, and
// die() reproduces all three while the warning still sits in stderr. Only a
// refusal reached BEFORE the first query can show gh was never asked, so the
// receipt is what pins fatality and the other three merely describe the refusal.
//
// `prView: null` is what keeps that argument true, and is not tidiness. Under
// the green fixture the downgraded guard reaches a gh that ANSWERS, so the run
// gets further than the refusal it is being compared against and diverges on
// its exit code first — the assertion that reds is the status one, and the
// receipt is never what caught it. A gh that fails when reached is what makes
// exit 2, an empty stdout and a matching stderr line reproducible by the later
// guard too, leaving the receipt as the only assertion that separates them.
//
// The stub also keeps a regressed guard off this repo's live GitHub data —
// arg.test.mjs's own stubGhBin() gives the same two jobs, for the same shape of
// guard.
test("a non-numeric --pr refuses before any query, rather than reporting `pr: null`", () => {
  const r = run([], { pr: "abc", prView: null });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--pr needs a number/);
  assert.equal(r.stdout.trim(), "", `a refusal ships no payload, and stdout reads ${r.stdout}`);
  assert.equal(r.log, "", `the refusal must land before the first gh read, and gh was asked: ${r.log}`);
});

// Both anchors, separately. A guard that loses `$` still matches "42x" on its
// digit prefix, and one that loses `^` still matches "x42" on its digit suffix,
// so each value refuses only while its own anchor is present and neither mutant
// survives the pair. What a surviving mutant lets through is this block's whole
// defect back: Number("42x") is NaN, the payload's only identifying field
// serializes to null, and `gh pr view 42x` resolves the value as a BRANCH — the
// ambiguity the digits-only shape is chosen to forfeit against. Every other
// --pr this suite feeds the guard is all digits or none, and both mutants agree
// with the real guard on those.
for (const pr of ["42x", "x42"]) {
  test(`a --pr mixing digits with non-digits refuses as \`abc\` does: ${pr}`, () => {
    const r = run([], { pr, prView: null });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /--pr needs a number/);
    assert.equal(r.stdout.trim(), "", `a refusal ships no payload, and stdout reads ${r.stdout}`);
    assert.equal(r.log, "", `the refusal must land before the first gh read, and gh was asked: ${r.log}`);
  });
}

// The direction a new guard gets wrong on its own: what it wrongly REFUSES. A
// suite that only feeds it invalid input pins nothing about the callers it must
// keep working. board.mjs's runCiState() sends `String(pr)` off a numeric board
// record, which is exactly the digits this harness defaults to — so a guard
// tightened past them refuses a working invocation, the outcome #365's own AC
// calls worse than the bug being fixed.
//
// assert/strict pins the TYPE as well as the value: `pr` reading back as the
// string "42" would satisfy a loose check while breaking every consumer that
// keys on a number, and reading back as `null` is the defect itself. Nothing
// else covers the normal-path payload's `pr` — the sibling assertion in the
// quota section covers the outage payload's.
test("the numeric shape board.mjs sends is accepted, and the payload names its PR", () => {
  const r = run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.payload.verdict, "green");
  assert.equal(r.payload.pr, 42);
});

// What the new guard's PLACEMENT could newly break. It sits below the usage die
// on purpose: RegExp.test coerces a null argument to the string "null", so a
// guard merged into that die — or hoisted above it — answers an omitted --pr
// with a complaint about a number and never prints the usage line at all. Both
// spellings exit 2, so the exit code cannot tell them apart.
test("--pr omitted still answers with the usage line, not the numeric complaint", () => {
  const r = run([], { pr: null, prView: null });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /usage: ci-state\.mjs --pr <number>/);
  assert.doesNotMatch(r.stderr, /needs a number/, "an omitted --pr is a different mistake from a malformed one");
  assert.equal(r.log, "", `a usage refusal must also precede any gh read, and gh was asked: ${r.log}`);
});

// --- The verdict payload has to survive a pipe ------------------------------
// `console.log` + `process.exit()` loses whatever is still queued: on a pipe the
// stdout write is asynchronous, the kernel accepts one buffer's worth
// synchronously, and process.exit() discards the remainder rather than draining
// it. The payload is then cut mid-JSON while the exit code arrives intact, so a
// caller that reads the code sees a normal verdict and a caller that parses
// stdout gets nothing it can use. emitRateLimited() already writes its payload
// with writeSync for this reason; these tests hold the verdict payload to the
// same standard.
//
// The mode under test is a PIPE specifically. spawnSync's default stdio is one
// (measured: the same payload reaches a file fd whole and a pipe cut), which is
// why these can reuse run() — a harness that captured stdout to a file would
// pass whether or not the script was ever fixed.
const PIPE_BUFFER_BYTES = 65536;

// Derived rather than written as a literal number of jobs: the property that
// matters is "past one buffer", and a hardcoded count silently stops clearing
// the cliff the moment the id shape or the payload's other fields change. The
// ids are shaped the way expectedJobs() derives them, and carry no job-level
// `name:`, which that derivation refuses.
function jobsClearingPipeBuffer() {
  const ids = [];
  for (let joined = 0; joined <= PIPE_BUFFER_BYTES * 2; ) {
    const id = `generated-job-${String(ids.length).padStart(6, "0")}-padding-padding`;
    ids.push(id);
    joined += id.length + ", ".length; // how the absent-jobs reason joins them
  }
  return ids;
}

const workflowWithJobs = (ids) =>
  `name: CI\non: [pull_request]\njobs:\n${ids.map((id) => `  ${id}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n`).join("")}`;

const runViewAllSucceeded = (ids) =>
  JSON.stringify({
    jobs: ids.map((name) => ({ name, status: "completed", conclusion: "success" })),
    attempt: 1,
    status: "completed",
    conclusion: "success",
    headSha: PR_HEAD,
  });

// --quiet is the mode the controller's CI Monitor polls in, and it drops `jobs`
// and `missing` — so this also pins that the payload still outgrows the buffer
// on the hot path, through `reasons` alone, where the absent-job reason names
// every job it could not find.
test("a not-green verdict payload larger than one pipe buffer reaches the caller whole", () => {
  const ids = jobsClearingPipeBuffer();
  const r = run(["--quiet"], {
    repoFiles: { ".github/workflows/ci.yml": workflowWithJobs(ids) },
    tolerateUnparsedStdout: true,
  });
  let payload;
  try {
    payload = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`verdict payload did not survive the pipe: ${r.stdout.length} bytes, ${e.message}`);
  }
  assert.ok(
    r.stdout.length > PIPE_BUFFER_BYTES,
    `fixture no longer outgrows the pipe buffer (${r.stdout.length} bytes), so this test would pass without proving anything`,
  );
  assert.equal(payload.verdict, "not-green");
  assert.equal(r.status, 1, r.stderr);
});

// The other direction, and the one a fix for the above can newly break. writeSync
// throws where console.log swallows — on a saturated non-blocking pipe it raises
// EAGAIN — and an uncaught throw here would skip the exit call entirely, dropping
// the process to exit 1: the code this script reserves for not-green. A green PR
// would then be reported as failing CI, which is worse than the truncation being
// fixed. Green is also the only verdict that can carry a large payload without
// `reasons`, so this is what exercises the write with `jobs` doing the growing.
test("a green verdict payload larger than one pipe buffer still exits 0, gate not inverted", () => {
  const ids = jobsClearingPipeBuffer();
  const r = run([], {
    repoFiles: { ".github/workflows/ci.yml": workflowWithJobs(ids) },
    runView: runViewAllSucceeded(ids),
    tolerateUnparsedStdout: true,
  });
  let payload;
  try {
    payload = JSON.parse(r.stdout);
  } catch (e) {
    assert.fail(`verdict payload did not survive the pipe: ${r.stdout.length} bytes, ${e.message}`);
  }
  assert.ok(
    r.stdout.length > PIPE_BUFFER_BYTES,
    `fixture no longer outgrows the pipe buffer (${r.stdout.length} bytes), so this test would pass without proving anything`,
  );
  assert.equal(payload.verdict, "green");
  assert.equal(r.status, 0, r.stderr);
});

// What the write must NOT change on every payload that was never at risk. console.log
// appends exactly one newline and writeSync appends none of its own, so the
// replacement has to supply it — supplying none concatenates the payload with
// whatever a caller prints next, and supplying two breaks a reader that treats a
// blank line as end of output. Pinned as exact bytes rather than "parses", which
// all three spellings would satisfy.
test("a payload that never reaches the buffer is emitted byte for byte as before: one line, one trailing newline", () => {
  const r = run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${JSON.stringify(r.payload)}\n`);
});

// The guard emit() puts around its write is what the comment above emit() calls
// not optional, and until here nothing in this repo EXECUTED it: deleting the
// try/catch outright and running this file, and then the whole fleet suite, left
// both green (measured). The two tests above prove a SUCCESSFUL oversized write
// survives; neither makes the write fail, so the mechanism was pinned by prose
// alone. arg.test.mjs pins die()'s structurally identical guard this same way.
//
// The failure is forced deterministically rather than by racing a reader: the
// child's stdout is /dev/null opened READ-only, so the first writeSync raises
// EBADF. A different errno from the EAGAIN in the field, and the same and only
// thing emit() promises about either — the message may be lost, the exit code
// may not.
//
// Green is the discriminating verdict, and the only one that discriminates: with
// the guard, the payload is lost and exit 0 still lands; without it the EBADF
// propagates, skips the process.exit() the tail is about to make, and Node falls
// through to its default exit 1 — a green PR reported to the fleet's merge gate
// as failing CI. That is the #299/#328 inversion itself, reproduced without the
// race, so this discriminates on a machine where EAGAIN never fires. Measured
// both ways: guarded exit 0, guard removed exit 1.
test("emit() keeps the green exit code when its own write throws — the guard executed, not lifted", () => {
  const r = run([], { repoFiles: { ".github/workflows/ci.yml": CI_WORKFLOW }, readOnlyStdout: true });
  assert.equal(r.status, 0, `exit ${r.status}: emit()'s write threw and took the green verdict with it`);
});

// The verdict SUMMARY goes to fd 2, and fd 2 is the fd vlog's console.error has
// already initialised a stream for — which is what puts it in O_NONBLOCK. A
// non-blocking write to a full pipe SHORT-WRITES: it returns the count it
// managed and throws nothing, so the catch above never fires and nothing is
// logged. Measured against this same fixture before emit() consumed that return
// value: the line arrived cut at one buffer with its trailing newline gone, in
// this quiet mode and in the verbose one, while stdout and the exit code came
// through untouched — the one channel the tests above cannot speak for.
//
// Completeness is asserted by CONTENT, before the size guard rather than after.
// The absent-job reason ends with the last id it joined, so a cut line simply
// does not end with it; a truncated line is also exactly one buffer long, which
// would fail a `> PIPE_BUFFER_BYTES` guard and blame the fixture for a defect in
// the script. Ordered this way each failure names its own cause.
test("the verdict line on stderr survives past one pipe buffer, its reasons whole", () => {
  const ids = jobsClearingPipeBuffer();
  const r = run(["--quiet"], {
    repoFiles: { ".github/workflows/ci.yml": workflowWithJobs(ids) },
    tolerateUnparsedStdout: true,
  });
  const line = r.stderr.split("\n").find((l) => l.includes("verdict="));
  assert.ok(line, `no verdict line on stderr at all, in ${r.stderr.length} bytes`);
  assert.ok(
    line.endsWith(ids[ids.length - 1]),
    `verdict line cut mid-reason at ${Buffer.byteLength(line)} bytes: it does not reach the last job it names`,
  );
  assert.ok(
    Buffer.byteLength(line) > PIPE_BUFFER_BYTES,
    `fixture no longer outgrows the pipe buffer on stderr (${Buffer.byteLength(line)} bytes), so this test would pass without proving anything`,
  );
  assert.equal(r.status, 1, "the exit code must survive the write it follows");
});

// #901: the verdict summary is the emit() call site on fd 2, and the terminator
// contract already held at the payload sites on stdout was never pinned here.
// emit() appends no newline of its own, so each call site supplies its own:
// supplying none runs this line together with whatever the caller prints next,
// and supplying an extra ends the output early for a reader that treats a blank
// line as the end of it.
//
// The completeness assertion covering this same line cannot stand in for that.
// It locates the line by splitting stderr on "\n", and splitting on the
// terminator is what discards it — every segment that yields is the content
// BETWEEN newlines, so no wording of an assertion over that segment can see
// whether the line was terminated at all. Measured before this test existed:
// dropping the trailing newline left this file green.
//
// fd 2 also carries the vlog trace stream and gh's own forwarded stderr, so it
// has no single expected byte string and the whole-stream equality the stdout
// pins use has no equivalent here. This isolates the line instead — it locates
// the summary by the verdict and reasons THIS run reported, then reads the
// bytes on either side of it. Deriving the expected text from the emitted
// payload rather than from a literal copy is what keeps the assertions about
// the newlines alone: rewording a reason or adding a payload field moves both
// sides together and stays green, as does rewording any trace.
//
// The LEADING newline is insurance for forwarded child stderr still draining
// through the async stream without having ended its line — arg.mjs's die()
// documents the same shape for the same reason. That RACE is what does not
// reproduce here: the text before the summary has already ended its own line,
// in this fixture a vlog trace and under --quiet git's forwarded `error: No
// such remote 'origin'`. The BYTE is another matter — against already-ended
// text the leading newline leaves a blank line and dropping it leaves none —
// so it is pinned below, doubled as well as missing. What that leaves
// untested is the mid-line landing the newline exists to prevent, not the
// newline itself.
test("the verdict summary on stderr carries exactly one newline of its own on each side", () => {
  const r = run([]);
  assert.ok(
    r.payload.reasons.length,
    "fixture no longer produces a reason, so the summary derived below would carry an em dash the script omits when reasons is empty, and this test would fail on the lookup rather than on the terminator",
  );
  const summary = `ci-state: verdict=${r.payload.verdict} — ${r.payload.reasons.join("; ")}`;
  const at = r.stderr.indexOf(summary);
  assert.ok(at >= 0, `the verdict summary is not on stderr as emitted, in ${JSON.stringify(r.stderr)}`);
  const before = r.stderr.slice(0, at);
  assert.equal(
    before.match(/\n*$/)[0].length,
    2,
    `the summary's own leading newline must leave exactly one blank line after the already-ended text before it, which runs ${JSON.stringify(before.slice(-40))}`,
  );
  const after = r.stderr.slice(at + summary.length);
  assert.ok(
    after.startsWith("\n"),
    `the verdict summary is unterminated: it runs straight into ${JSON.stringify(after.slice(0, 40))}`,
  );
  assert.ok(
    !after.startsWith("\n\n"),
    "the verdict summary's terminator is doubled, ending the stream early for a reader that stops at a blank line",
  );
});

// The shape pin. The test above executes the catch, and this one pins the LOOP
// the catch sits inside — the two are independent: a body that catches
// faithfully and still calls writeSync once satisfies the behavioural test and
// reintroduces the short write, because a short write never throws.
//
// Derived through stripComments() rather than matched against raw source, and
// deliberately not with a cleverer anchor: a `/m` regex over raw source is
// satisfied by the correct shape sitting in a block comment, and `^(?!\s*//)`
// closes neither escape (both measured, and strip-comments.mjs's own header
// records them). Each fragment is anchored at a line start and joined with
// `\s*^\s*` so a comment line added inside emit() does not redden this, and no
// fragment is terminated with `$`, which over-fires on a trailing comment.
//
// The count assertion is what names the FILE when emit() is renamed or deleted:
// the regex alone would then fail as an opaque match-against-undefined, and this
// says which source to go and look at. It is deliberately not defending against
// a shadowing second declaration — measured, a duplicate `function emit` at this
// file's top level is a SyntaxError ("Identifier 'emit' has already been
// declared") and the module system refuses it before any test runs, so the
// lift-takes-first/JS-runs-last hazard does not reach this shape.
test("emit() still consumes writeSync's return value — the loop, not just the catch", () => {
  const source = stripComments(readFileSync(SCRIPT, "utf8"));
  assert.equal(
    source.match(/^\s*function emit\(/gm)?.length,
    1,
    "ci-state.mjs declares emit() more than once, or not at all — the pin below reads the first and the script runs the last",
  );
  assert.match(
    source,
    /^\s*function emit\(fd, text\) \{\s*^\s*let buf = Buffer\.from\(text\);\s*^\s*while \(buf\.length\) \{\s*^\s*try \{\s*^\s*buf = buf\.subarray\(writeSync\(fd, buf\)\);/m,
  );
});
