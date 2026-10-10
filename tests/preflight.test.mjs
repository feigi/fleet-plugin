// Regression gate for preflight.mjs, the consumer-repo pre-flight run-team
// runs at the start of Phase 0. Zero deps:
//   node --test tests/preflight.test.mjs
//
// Every case runs against a real temporary repository with real git, because
// what the git checks answer depends on git's own reading of the remote and
// the gitignore. `gh`, `jq`, `python3` and `shasum` are stubs on PATH, and the
// Resolver is a stub under a temporary HOME, so no case touches the network or
// the box's own install.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { CHECKS, MARKER_FILE, checkSetHash, runPreflight } from "../plugin/scripts/preflight.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/preflight.mjs", import.meta.url));
const LABELS = ["ready-for-agent", "in-progress", "ready-to-merge"];

const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

// A repository every check passes against: an `origin` with an `origin/main`,
// `.worktrees/` and `.fleet/` ignored, and a workflow named CI.
function fixture({ labels = LABELS, allowMerge = "true", rulesets = ["main"], ci = "name: CI\n" } = {}) {
  const root = realpathSync(tempDir("preflight-"));
  const ws = join(root, "ws");
  mkdirSync(ws);
  git(ws, "init", "-q");
  writeFileSync(join(ws, ".gitignore"), ".worktrees/\n.fleet/\n");
  if (ci !== null) {
    mkdirSync(join(ws, ".github", "workflows"), { recursive: true });
    writeFileSync(join(ws, ".github", "workflows", "ci.yml"), ci);
  }
  git(ws, "add", "-A");
  git(ws, "commit", "-qm", "init");
  git(ws, "remote", "add", "origin", join(root, "origin.git"));
  git(ws, "update-ref", "refs/remotes/origin/main", "HEAD");

  const bin = join(root, "bin");
  mkdirSync(bin);
  const log = join(root, "gh.log");
  const lines = (xs) => (xs.length ? xs.map((x) => `echo '${x}'`).join("; ") : ":");
  writeExecStub(join(bin, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
auth|--version) exit 0 ;;
label) { ${lines(labels)}; } | grep -x -- "$4"; exit 0 ;;
api) case "$2" in
  */rulesets) ${lines(rulesets)} ;;
  *) echo '${allowMerge}' ;;
  esac ;;
*) exit 9 ;;
esac
`);
  for (const name of ["jq", "python3", "shasum"]) writeExecStub(join(bin, name), "#!/bin/sh\nexit 0\n");

  const home = join(root, "home");
  mkdirSync(join(home, ".fleet", "bin"), { recursive: true });
  writeExecStub(join(home, ".fleet", "bin", "fleet-run"), "#!/bin/sh\n[ \"$1\" = --root ] && echo /install/root\n");

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: home };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  return { ws, env, log, marker: join(ws, ".fleet", MARKER_FILE) };
}

const cli = (f, cwd = f.ws, args = []) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: f.env, encoding: "utf8" });
const ghCalls = (f) => (existsSync(f.log) ? readFileSync(f.log, "utf8").split("\n").filter(Boolean).length : 0);

test("a repo every check passes against exits 0, names each check, and writes the marker for this check set", () => {
  const f = fixture();
  const r = cli(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  for (const { name } of CHECKS) assert.match(r.stdout, new RegExp(`^ok ${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  assert.match(r.stdout, /^PREFLIGHT OK/m);
  assert.equal(JSON.parse(readFileSync(f.marker, "utf8")).checks, checkSetHash(CHECKS));
});

test("a second run with the check set unchanged skips every check and calls gh not at all", () => {
  const f = fixture();
  assert.equal(cli(f).status, 0);
  const before = ghCalls(f);
  assert.ok(before > 0, "the first run reached the gh stub");
  const r = cli(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PREFLIGHT SKIPPED/m);
  assert.doesNotMatch(r.stdout, /^ok /m);
  assert.equal(ghCalls(f), before);
});

test("a missing label fails by that check's name, exits 1, and writes no marker", () => {
  const f = fixture({ labels: ["ready-for-agent", "in-progress"] });
  const r = cli(f);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^FAIL label:ready-to-merge: /m);
  assert.match(r.stdout, /^ok label:ready-for-agent$/m);
  assert.match(r.stdout, /^ok label:in-progress$/m);
  assert.match(r.stdout, /^PREFLIGHT FAILED: label:ready-to-merge$/m);
  assert.equal(existsSync(f.marker), false);
});

test("a failed run is not remembered: the next run checks again", () => {
  const f = fixture({ labels: ["ready-for-agent", "in-progress"] });
  assert.equal(cli(f).status, 1);
  const r = cli(f);
  assert.equal(r.status, 1);
  assert.doesNotMatch(r.stdout, /SKIPPED/);
});

test("merge commits turned off fails allow-merge-commit, and no ruleset fails ruleset", () => {
  const f = fixture({ allowMerge: "false", rulesets: [] });
  const r = cli(f);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^FAIL allow-merge-commit: /m);
  assert.match(r.stdout, /^FAIL ruleset: /m);
  assert.match(r.stdout, /^PREFLIGHT FAILED: allow-merge-commit, ruleset$/m);
});

test("a binary that does not answer fails by its own name", () => {
  const f = fixture();
  writeExecStub(join(f.env.PATH.split(":")[0], "jq"), "#!/bin/sh\nexit 127\n");
  const r = cli(f);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^FAIL binary:jq: /m);
  assert.match(r.stdout, /^PREFLIGHT FAILED: binary:jq$/m);
});

test("no workflow named CI warns, still passes, and still writes the marker", () => {
  for (const ci of [null, "name: Build\n"]) {
    const f = fixture({ ci });
    const r = cli(f);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^WARN ci-workflow: /m);
    assert.match(r.stdout, /^PREFLIGHT OK/m);
    assert.ok(existsSync(f.marker));
  }
});

test("run from a linked worktree, the checks run at the main checkout and the marker lands in its .fleet/", () => {
  const f = fixture();
  const wt = join(f.ws, ".worktrees", "1-x");
  git(f.ws, "worktree", "add", "-q", "-b", "x", wt);
  const r = cli(f, wt);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(f.marker));
  assert.equal(existsSync(join(wt, ".fleet")), false);
});

test("an added check runs the set again; an unchanged set is skipped", () => {
  const f = fixture();
  const one = [{ name: "first", argv: ["true"] }];
  const two = [...one, { name: "second", argv: ["true"] }];
  const opts = { cwd: f.ws, env: f.env };

  const a = runPreflight({ ...opts, checks: one });
  assert.equal(a.skipped, false);
  assert.deepEqual(a.results.map((x) => x.name), ["first"]);
  assert.equal(runPreflight({ ...opts, checks: one }).skipped, true);

  const b = runPreflight({ ...opts, checks: two });
  assert.equal(b.skipped, false);
  assert.deepEqual(b.results.map((x) => [x.name, x.ok]), [["first", true], ["second", true]]);
  assert.equal(runPreflight({ ...opts, checks: two }).skipped, true);
});

test("a check whose probe changes runs the set again", () => {
  const f = fixture();
  const opts = { cwd: f.ws, env: f.env };
  assert.equal(runPreflight({ ...opts, checks: [{ name: "c", argv: ["true"] }] }).skipped, false);
  assert.equal(runPreflight({ ...opts, checks: [{ name: "c", argv: ["true", "x"] }] }).skipped, false);
  assert.notEqual(checkSetHash([{ name: "c", argv: ["true"] }]), checkSetHash([{ name: "c", argv: ["true"], warn: true }]));
});

test("an unreadable marker is no marker: the checks run", () => {
  const f = fixture();
  mkdirSync(join(f.ws, ".fleet"));
  writeFileSync(f.marker, "not json");
  const r = cli(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PREFLIGHT OK/m);
});

test("an unknown flag is refused with exit 2 before any check runs", () => {
  const f = fixture();
  const r = cli(f, f.ws, ["--bogus"]);
  assert.equal(r.status, 2);
  assert.equal(ghCalls(f), 0);
});
