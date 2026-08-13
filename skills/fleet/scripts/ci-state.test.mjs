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

const GH_STUB = `#!/bin/sh
echo "$*" >> "$GH_LOG"
case "$1 $2" in
  "pr view") [ -f "$PR_VIEW_FILE" ] && cat "$PR_VIEW_FILE" || exit 1 ;;
  "run list") [ -f "$RUN_LIST_FILE" ] && cat "$RUN_LIST_FILE" || exit 1 ;;
  "run view") [ -f "$RUN_VIEW_FILE" ] && cat "$RUN_VIEW_FILE" || exit 1 ;;
  *) exit 1 ;;
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
function run(args, { repoFiles = {}, unreadable = [], cwd = ".", prView = PR_VIEW, runList = RUN_LIST, runView = RUN_VIEW } = {}) {
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
