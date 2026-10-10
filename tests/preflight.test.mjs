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
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { CHECKS, MARKER_FILE, checkSetHash, runPreflight } from "../plugin/scripts/preflight.mjs";
import { gitEnv } from "../plugin/scripts/git-env.mjs";

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

  const env = gitEnv({ PATH: `${bin}:${process.env.PATH}`, HOME: home }, process.env);
  return { ws, env, log, marker: join(ws, ".fleet", MARKER_FILE) };
}

const cli = (f, cwd = f.ws, args = []) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env: f.env, encoding: "utf8" });
const ghCalls = (f) => (existsSync(f.log) ? readFileSync(f.log, "utf8").split("\n").filter(Boolean).length : 0);

test("a repo every check passes against exits 0, names each check, and writes the marker for this check set", () => {
  const f = fixture();
  const r = cli(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const lines = r.stdout.split("\n");
  for (const { name } of CHECKS) assert.ok(lines.includes(`ok ${name}`), `ok ${name}`);
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

test("any argument is refused with exit 2 before any check runs", () => {
  const f = fixture();
  const r = cli(f, f.ws, ["--bogus"]);
  assert.equal(r.status, 2);
  assert.equal(ghCalls(f), 0);
});

test("a marker that cannot be written exits 2 naming the path, after printing every row and leaving no temp file", () => {
  const f = fixture({ ci: null });
  mkdirSync(f.marker, { recursive: true });
  writeFileSync(join(f.marker, "occupied"), "");
  const r = cli(f);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /cannot write .*preflight\.json/);
  assert.match(r.stdout, /^ok binary:node$/m);
  assert.match(r.stdout, /^WARN ci-workflow: /m);
  assert.doesNotMatch(r.stdout, /^PREFLIGHT OK/m);
  assert.deepEqual(readdirSync(join(f.ws, ".fleet")).filter((n) => n.endsWith(".tmp")), []);
});

test("a ~/ argv element with HOME unset is reported as not run, never resolved against the repository", () => {
  const f = fixture();
  const checks = [{ name: "resolver", argv: ["~/.fleet/bin/fleet-run", "--root"] }];
  assert.deepEqual(runPreflight({ cwd: f.ws, env: f.env, checks }).failed, [], "control: with HOME set the row passes");

  // A second repository, so the control's marker does not skip this run. It
  // holds an executable at the path a `~` expanded to "" would name.
  const g = fixture();
  const { HOME, ...noHome } = g.env;
  mkdirSync(join(g.ws, ".fleet", "bin"), { recursive: true });
  writeExecStub(join(g.ws, ".fleet", "bin", "fleet-run"), "#!/bin/sh\nexit 0\n");
  const r = runPreflight({ cwd: g.ws, env: noHome, checks });
  assert.deepEqual(r.failed, ["resolver"]);
  assert.match(r.results[0].why, /HOME is not set/);
});

test("the ci-workflow row reads a workflow's name the way ci-state does", () => {
  const row = CHECKS.filter((c) => c.name === "ci-workflow");
  const okOf = (ci) => {
    const f = fixture({ ci });
    return runPreflight({ cwd: f.ws, env: f.env, checks: row }).results[0].ok;
  };
  for (const ci of ["name: CI\n", 'name: "CI"\n', "name: 'CI'\n", "name: CI # main pipeline\n", "name:CI\n"]) {
    assert.equal(okOf(ci), true, JSON.stringify(ci));
  }
  for (const ci of ["name: Build\n", "name: CI Build\n", "name: CI#1\n", null]) {
    assert.equal(okOf(ci), false, JSON.stringify(ci));
  }
});

test("a value is matched whole after trimming, and the probe's environment carries no ambient git variables", () => {
  const row = (want) => [{ name: "v", argv: ["gh", "api", "repos/{owner}/{repo}", "--jq", ".allow_merge_commit"], want }];
  const run = (allowMerge, want, env) => {
    const f = fixture({ allowMerge });
    return runPreflight({ cwd: f.ws, env: env?.(f) ?? f.env, checks: row(want) });
  };
  assert.deepEqual(run("xtrue", "true").failed, ["v"], "a substring is not a line");
  assert.deepEqual(run("  true  ", "true").failed, [], "padding is trimmed");

  const f = fixture();
  const probe = [{ name: "git-dir", argv: ["sh", "-c", 'echo "${GIT_DIR:-unset}"'], want: "unset" }];
  assert.deepEqual(runPreflight({ cwd: f.ws, env: { ...f.env, GIT_DIR: join(f.ws, ".git") }, checks: probe }).failed, []);
});

test("a changed name or want changes the hash", () => {
  const base = [{ name: "c", argv: ["true"], want: "x" }];
  assert.notEqual(checkSetHash(base), checkSetHash([{ name: "d", argv: ["true"], want: "x" }]));
  assert.notEqual(checkSetHash(base), checkSetHash([{ name: "c", argv: ["true"], want: "y" }]));
  assert.notEqual(checkSetHash(base), checkSetHash([{ name: "c", argv: ["true"] }]));
});

test("run from a linked worktree, every probe's cwd is the main checkout", () => {
  const f = fixture();
  const wt = join(f.ws, ".worktrees", "1-x");
  git(f.ws, "worktree", "add", "-q", "-b", "x", wt);
  const r = runPreflight({ cwd: wt, env: f.env, checks: [{ name: "cwd", argv: ["pwd"], want: f.ws }] });
  assert.deepEqual(r.failed, [], JSON.stringify(r.results));
});

test("a binary that is not installed is reported as not run; a probe that hangs as timed out", () => {
  const f = fixture();
  const run = (checks, extra = {}) => runPreflight({ cwd: f.ws, env: f.env, checks, ...extra });

  const gone = run([{ name: "gone", argv: ["no-such-binary-for-preflight"] }]);
  assert.deepEqual(gone.failed, ["gone"]);
  assert.match(gone.results[0].why, /did not run: ENOENT/);

  const hung = run([{ name: "hung", argv: ["sleep", "5"] }], { timeoutMs: 300 });
  assert.deepEqual(hung.failed, ["hung"]);
  assert.match(hung.results[0].why, /timed out after 300ms/);
  assert.doesNotMatch(hung.results[0].why, /did not run/);
});
