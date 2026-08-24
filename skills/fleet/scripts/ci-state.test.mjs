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
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
// gh responses default to the green fixtures above; pass `null` to make that gh
// subcommand fail (exit 1) if reached, so an unexpected call surfaces as a
// crash rather than silently serving the wrong fixture.
function run(args, { repoFiles = {}, unreadable = [], cwd = ".", prView = PR_VIEW, runList = RUN_LIST, runView = RUN_VIEW, ghFailMsg = "" } = {}) {
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
  let r;
  try {
    r = spawnSync(process.execPath, [SCRIPT, "--pr", "42", ...args], { cwd: join(repoDir, cwd), encoding: "utf8", env });
  } finally {
    for (const [full, mode] of restore.reverse()) chmodSync(full, mode);
  }
  const log = readFileSync(ghLog, "utf8");
  const payload = r.stdout.trim() ? JSON.parse(r.stdout.trim().split("\n").pop()) : null;
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

test("explicit --workflow-file bypasses discovery; an unreadable target still dies with exit 2 (unchanged)", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every file");
  const repoDir = mkdtempSync(join(tmpdir(), "ci-state-repo-"));
  const binDir = mkdtempSync(join(tmpdir(), "ci-state-bin-"));
  const wfDir = join(repoDir, ".github", "workflows");
  mkdirSync(wfDir, { recursive: true });
  const wf = join(wfDir, "ci.yml");
  writeFileSync(wf, CI_WORKFLOW);
  chmodSync(wf, 0o000);
  const gh = join(binDir, "gh");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  const ghLog = join(binDir, "gh.log");
  writeFileSync(ghLog, "");
  const prViewFile = join(binDir, "pr-view.json");
  writeFileSync(prViewFile, PR_VIEW);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    GH_LOG: ghLog,
    PR_VIEW_FILE: prViewFile,
    RUN_LIST_FILE: "",
    RUN_VIEW_FILE: "",
  };
  try {
    const r = spawnSync(process.execPath, [SCRIPT, "--pr", "42", "--workflow-file", wf], { cwd: repoDir, encoding: "utf8", env });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read/);
  } finally {
    chmodSync(wf, 0o644);
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

test("discovery-time unreadable candidate fails closed (exit 2) instead of reading as no-ci", (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads every file");
  const repoDir = mkdtempSync(join(tmpdir(), "ci-state-repo-"));
  spawnSync("git", ["init", "-q", repoDir], { stdio: "ignore" }); // discovery anchors on the repo root
  const binDir = mkdtempSync(join(tmpdir(), "ci-state-bin-"));
  const wfDir = join(repoDir, ".github", "workflows");
  mkdirSync(wfDir, { recursive: true });
  const wf = join(wfDir, "ci.yml"); // matches the default --workflow "CI" by name, if readable
  writeFileSync(wf, CI_WORKFLOW);
  chmodSync(wf, 0o000);
  const gh = join(binDir, "gh");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  const ghLog = join(binDir, "gh.log");
  writeFileSync(ghLog, "");
  const prViewFile = join(binDir, "pr-view.json");
  writeFileSync(prViewFile, PR_VIEW);
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    GH_LOG: ghLog,
    PR_VIEW_FILE: prViewFile,
    RUN_LIST_FILE: "",
    RUN_VIEW_FILE: "",
  };
  try {
    // No --workflow-file: discovery must scan the directory, hit the
    // unreadable candidate, and die rather than silently reporting no-ci.
    const r = spawnSync(process.execPath, [SCRIPT, "--pr", "42"], { cwd: repoDir, encoding: "utf8", env });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read/);
  } finally {
    chmodSync(wf, 0o644);
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(binDir, { recursive: true, force: true });
  }
});

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
// The stub also keeps a regressed guard off this repo's live GitHub data, the
// second job arg.test.mjs's own stubGhBin() gives for the same shape.
function runWithGhReceipt(args) {
  const dir = mkdtempSync(join(tmpdir(), "ci-state-pr-guard-"));
  const ghLog = join(dir, "gh.log");
  writeFileSync(ghLog, "");
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "$@" >> ${ghLog}\nexit 1\n`, { mode: 0o755 });
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
  });
  const log = readFileSync(ghLog, "utf8");
  rmSync(dir, { recursive: true, force: true });
  return { ...r, log };
}

test("a non-numeric --pr refuses before any query, rather than reporting `pr: null`", () => {
  const r = runWithGhReceipt(["--pr", "abc"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--pr needs a number/);
  assert.equal(r.stdout.trim(), "", `a refusal ships no payload, and stdout reads ${r.stdout}`);
  assert.equal(r.log, "", `the refusal must land before the first gh read, and gh was asked: ${r.log}`);
});

// The direction a new guard gets wrong on its own: what it wrongly REFUSES. A
// suite that only feeds it invalid input pins nothing about the callers it must
// keep working. board.mjs's runCiState() sends `String(pr)` off a numeric board
// record, which is exactly the digits this harness prepends — so a guard
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
  const r = runWithGhReceipt([]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /usage: ci-state\.mjs --pr <number>/);
  assert.doesNotMatch(r.stderr, /needs a number/, "an omitted --pr is a different mistake from a malformed one");
  assert.equal(r.log, "", `a usage refusal must also precede any gh read, and gh was asked: ${r.log}`);
});
