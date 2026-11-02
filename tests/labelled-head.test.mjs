// Regression gate for labelled-head.mjs, the merge bot's "labelled head" step
// as one command (#4113). Zero deps beyond `jq`: `node --test tests/labelled-head.test.mjs`.
//
// The bug it closes: merge-bot-2 printed `4a36a6dd…` as #3901's record next to
// head `79e031bf…`, read that as "no record", took the timeline fallback, saw a
// `committed` and a `head_ref_force_pushed` after the label and refused without
// ever calling merge-gate.mjs, whose carry proof would have passed. The
// routes below are the command's answer in place of that comparison: a record
// that differs from the head is `gate`, and `timeline` is reached by no record
// alone.
//
// `gh` is stubbed on PATH and every invocation is appended to one call log.
// `pr view` answers from `pr-view.out`; `api` answers by running the `-q`
// program it was handed through `jq` over `timeline.json`, the way `gh api -q`
// filters, so the shipped program is the one under test. `timeline.raw`, when
// present, is printed in place of that run, for an answer no `-q` program
// gives. `<key>.fail` makes that call print its text on stderr and exit 1.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { tempDir } from "./support/temp-dir.mjs";
import { seedLabelMap } from "./support/label-map-seed.mjs";

// Without it every timeline case would fail with a spawn error, which reads as
// a real red but proves nothing.
try {
  execFileSync("jq", ["--version"], { stdio: "ignore" });
} catch {
  throw new Error("jq is required to run the timeline program; install it before running this suite");
}

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/labelled-head.mjs", import.meta.url));

// The #3901 shape: the record names `4a36a6dd…`, the head is `79e031bf…`.
const RECORDED = "4a36a6dd" + "0".repeat(32);
const HEAD = "79e031bf" + "1".repeat(32);
const OTHER = "c".repeat(40);

const STUB = `#!/bin/sh
d="\${0%/*}"
printf '%s\\n' "$*" >> "$d/calls.log"
pwd >> "$d/cwd.log"
env | grep -E '^(GIT_DIR|GIT_WORK_TREE)=' >> "$d/env.log"
case "$1 $2" in
"pr view") key=pr-view ;;
"api repos/{owner}/{repo}/issues/42/timeline?per_page=100") key=timeline ;;
*) echo "stub gh: unexpected $*" >&2; exit 99 ;;
esac
if [ -f "$d/$key.fail" ]; then cat "$d/$key.fail" >&2; exit 1; fi
if [ "$key" = timeline ]; then
  [ "$3 $4" = "--paginate -q" ] || { echo "stub gh: unexpected $*" >&2; exit 99; }
  if [ -f "$d/timeline.raw" ]; then cat "$d/timeline.raw"; exit 0; fi
  jq -r "$5" < "$d/timeline.json"
  exit 0
fi
cat "$d/$key.out"
exit 0
`;

const record = (sha, createdAt) => ({ body: `ready-to-merge-head: ${sha}`, createdAt });
const view = (head, comments = []) => JSON.stringify({ headRefOid: head, comments });

// The timeline as the API prints it, a page per array.
const label = (name) => ({ event: "labeled", label: { name } });
const committed = (sha) => ({ event: "committed", sha });
const forcePushed = (sha) => ({ event: "head_ref_force_pushed", commit_id: sha, sha: null });

// A rig for one case: a fresh stub directory and a repository the script runs
// in, holding the Label map (`roles` merged over the identity map; null for no
// map). `pages` is the timeline, one array per page; `raw`, when given, is what
// the timeline call prints instead.
function rig({ prView, pages = [], raw = null, fails = {}, roles = {} } = {}) {
  const dir = tempDir("labelled-head-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeExecStub(join(bin, "gh"), STUB);
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".fleet"), { recursive: true });
  const init = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8", env: gitEnv() });
  assert.equal(init.status, 0, init.stderr);
  if (roles !== null) seedLabelMap(repo, { roles });
  writeFileSync(join(bin, "pr-view.out"), prView ?? view(HEAD));
  writeFileSync(join(bin, "timeline.json"), pages.map((p) => JSON.stringify(p)).join("\n"));
  if (raw !== null) writeFileSync(join(bin, "timeline.raw"), raw);
  for (const [k, v] of Object.entries(fails)) writeFileSync(join(bin, `${k}.fail`), v);
  const log = (name) => (existsSync(join(bin, name)) ? readFileSync(join(bin, name), "utf8").trim().split("\n").filter(Boolean) : []);
  const run = (args = ["--pr", "42"], { env = {}, stdout = "pipe" } = {}) => {
    const full = args.includes("--repo") ? args : [...args, "--repo", repo];
    const r = spawnSync(process.execPath, [SCRIPT, ...full], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
      stdio: ["ignore", stdout, "pipe"],
    });
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      // a refusal before any gh call prints no receipt
    }
    return { status: r.status, stderr: r.stderr, out };
  };
  return { repo, calls: () => log("calls.log"), cwds: () => log("cwd.log"), envs: () => log("env.log"), run };
}

const VIEW = "pr view 42 --json comments,headRefOid";
const TIMELINE_CALL = (c) => c.startsWith("api repos/{owner}/{repo}/issues/42/timeline?per_page=100 --paginate -q ");

test("current: a record that names the current head proceeds, with no timeline read and no Label map read", () => {
  const t = rig({ prView: view(HEAD, [record(HEAD, "2026-10-01T00:00:00Z")]), roles: null });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, { pr: 42, record: HEAD, head: HEAD, route: "current", timeline: null, exit: 0 });
  assert.deepEqual(t.calls(), [VIEW]);
});

test("gate: the #3901 shape — a record that differs from the head, and commits after the label — is `gate`, never `timeline`", () => {
  const t = rig({
    prView: view(HEAD, [record(RECORDED, "2026-10-01T00:00:00Z")]),
    pages: [[label("ready-to-merge"), committed(OTHER), forcePushed(HEAD)]],
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, { pr: 42, record: RECORDED, head: HEAD, route: "gate", timeline: null, exit: 0 });
  // Nothing was refused on sight: the timeline that would have refused was never read.
  assert.deepEqual(t.calls(), [VIEW]);
});

test("gate: the Label map is not needed to route a recorded head", () => {
  const t = rig({ prView: view(HEAD, [record(RECORDED, "2026-10-01T00:00:00Z")]), roles: null });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.route, "gate");
});

test("the newest record decides, by createdAt and not by array position", () => {
  // The older record names the head and the newer one another commit: gate.
  const newerOther = rig({ prView: view(HEAD, [record(OTHER, "2026-10-02T00:00:00Z"), record(HEAD, "2026-10-01T00:00:00Z")]) });
  assert.deepEqual([newerOther.run().out.route, newerOther.run().out.record], ["gate", OTHER]);
  // The older record names another commit and the newer one the head: current.
  const newerHead = rig({ prView: view(HEAD, [record(HEAD, "2026-10-02T00:00:00Z"), record(OTHER, "2026-10-01T00:00:00Z")]) });
  assert.deepEqual([newerHead.run().out.route, newerHead.run().out.record], ["current", HEAD]);
});

test("timeline: no record at all is `timeline`, the verdict `moved` for a commit and a force-push after the last label line", () => {
  const t = rig({ pages: [[committed(OTHER), label("ready-to-merge"), committed(RECORDED)], [forcePushed(HEAD)]] });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, {
    pr: 42,
    record: null,
    head: HEAD,
    route: "timeline",
    timeline: { label: "ready-to-merge", verdict: "moved", after: [`committed ${RECORDED}`, `head_ref_force_pushed ${HEAD}`] },
    exit: 0,
  });
  assert.equal(t.calls().length, 2);
  assert.equal(t.calls()[0], VIEW);
  assert.ok(TIMELINE_CALL(t.calls()[1]), t.calls()[1]);
});

test("timeline: commits only before the last label line are `clean`, the normal case", () => {
  const t = rig({ pages: [[committed(OTHER), forcePushed(RECORDED), label("ready-to-merge")], [{ event: "commented" }]] });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.route, "timeline");
  assert.deepEqual(r.out.timeline, { label: "ready-to-merge", verdict: "clean", after: [] });
});

test("timeline: a comment that quotes a record, or names the head with other text, is no record", () => {
  const t = rig({
    prView: view(HEAD, [
      { body: `the bot read ready-to-merge-head: ${HEAD}`, createdAt: "2026-10-01T00:00:00Z" },
      { body: `ready-to-merge-head: ${HEAD}\nand more`, createdAt: "2026-10-01T00:00:01Z" },
    ]),
    pages: [[label("ready-to-merge")]],
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.route, "timeline");
  assert.equal(r.out.record, null);
});

test("timeline: a remapped label is the one the verdict keys on, and a string holding an apostrophe reaches it whole", () => {
  // `queue's ok` holds the character that would end a single-quoted program;
  // the label is matched here, not spliced into one.
  const t = rig({
    roles: { "ready-to-merge": "queue's ok" },
    pages: [[label("queue's ok"), label("ready-to-merge"), committed(OTHER)]],
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.timeline, { label: "queue's ok", verdict: "moved", after: [`committed ${OTHER}`] });
  // A commit before the label's line is clean however many other labels follow.
  const before = rig({ pages: [[committed(OTHER), label("ready-to-merge"), label("other")]] });
  assert.equal(before.run().out.timeline.verdict, "clean");
});

test("timeline: another label after a commit is not the label line, so the commit still moved the head", () => {
  const t = rig({ pages: [[label("ready-to-merge"), committed(OTHER), label("other")]] });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.timeline, { label: "ready-to-merge", verdict: "moved", after: [`committed ${OTHER}`] });
});

test("timeline: the label applied again after a commit is the line the verdict keys on", () => {
  const t = rig({ pages: [[label("ready-to-merge"), committed(OTHER), label("ready-to-merge")]] });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.timeline, { label: "ready-to-merge", verdict: "clean", after: [] });
});

test("timeline: events other than labeled, committed and head_ref_force_pushed are ignored", () => {
  const t = rig({ pages: [[label("ready-to-merge"), { event: "commented" }, { event: "reviewed" }, { event: "assigned" }]] });
  assert.equal(t.run().out.timeline.verdict, "clean");
});

test("exit 2: a timeline with no labeled event for the string is a failed read, never `clean`", () => {
  // The label is on the PR, so a timeline that never shows it applied is a
  // read that came back empty or wrong, whatever else it holds.
  for (const pages of [[], [[]], [[label("other"), committed(OTHER)]]]) {
    const r = rig({ pages }).run();
    assert.equal(r.status, 2, JSON.stringify(pages));
    assert.equal(r.out.route, null);
    assert.equal(r.out.timeline, null);
    assert.equal(r.out.step, "read-timeline");
    assert.match(r.out.error, /no labeled event for ready-to-merge/);
  }
});

test("exit 2: a timeline line that is not an event object is refused rather than read", () => {
  const r = rig({ raw: `${JSON.stringify(label("ready-to-merge"))}\nnull\n` }).run();
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.out.step, "read-timeline");
  assert.match(r.out.error, /unexpected shape/);
});

// The receipt is the only carrier of the route: a decided route whose receipt
// never reached stdout must not exit 0.
test("exit 2: a receipt that cannot be written to stdout is never a decided route", () => {
  const t = rig({ pages: [[label("ready-to-merge")]] });
  assert.equal(t.run().status, 0, "control: the same run writes its receipt and exits 0");
  const readOnly = openSync("/dev/null", "r");
  try {
    const r = t.run(["--pr", "42"], { stdout: readOnly });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /labelled-head: the receipt could not be written to stdout/);
  } finally {
    closeSync(readOnly);
  }
});

test("exit 2: a failed PR read is a receipt naming the step, and nothing else was read", () => {
  const t = rig({ fails: { "pr-view": "GraphQL: Could not resolve to a PullRequest" } });
  const r = t.run();
  assert.equal(r.status, 2);
  assert.equal(r.out.route, null);
  assert.equal(r.out.step, "read-pr");
  assert.match(r.out.error, /Could not resolve to a PullRequest/);
  assert.deepEqual(t.calls(), [VIEW]);
});

test("exit 2: a PR read that is not the expected shape is refused rather than routed", () => {
  for (const bad of ["not json", JSON.stringify({ headRefOid: "abc", comments: [] }), JSON.stringify({ headRefOid: HEAD }), JSON.stringify({ headRefOid: HEAD, comments: [{ body: 1 }] })]) {
    const r = rig({ prView: bad }).run();
    assert.equal(r.status, 2, bad);
    assert.equal(r.out.step, "read-pr");
  }
});

test("exit 2: a failed timeline read is a receipt naming the step", () => {
  const t = rig({ fails: { timeline: "HTTP 502" } });
  const r = t.run();
  assert.equal(r.status, 2);
  assert.equal(r.out.step, "read-timeline");
  assert.equal(r.out.route, null, "a read that failed decides no route");
  assert.match(r.out.error, /HTTP 502/);
});

test("exit 2: the timeline route with no Label map names the step", () => {
  const t = rig({ roles: null });
  const r = t.run();
  assert.equal(r.status, 2);
  assert.equal(r.out.step, "label-map");
  assert.deepEqual(t.calls(), [VIEW], "the timeline was not read without the label to key it on");
});

test("gh runs in --repo, with no ambient GIT_DIR or GIT_WORK_TREE", () => {
  const t = rig({ pages: [[label("ready-to-merge")]] });
  const r = t.run(["--pr", "42"], { env: { GIT_DIR: "/nonexistent/.git", GIT_WORK_TREE: "/nonexistent" } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.cwds().every((c) => c.endsWith("/repo")), t.cwds().join(","));
  assert.deepEqual(t.envs(), []);
});

test("usage: a missing --pr, an unknown flag and a --repo that is not a readable directory are refused", () => {
  const t = rig();
  const missing = t.run(["--repo", t.repo]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /usage: labelled-head\.mjs --pr <N>/);
  const unknown = t.run(["--pr", "42", "--bogus", "x"]);
  assert.notEqual(unknown.status, 0);
  const notDir = t.run(["--pr", "42", "--repo", join(t.repo, "nope")]);
  assert.equal(notDir.status, 2);
  assert.equal(notDir.out.step, "read-pr");
  assert.deepEqual(t.calls(), [], "none of these reached gh");
  // A path stat cannot read (here a symlink loop, ELOOP) takes the same
  // receipt, not a stack trace.
  const loop = join(t.repo, "loop");
  symlinkSync(loop, loop);
  const unreadable = t.run(["--pr", "42", "--repo", loop]);
  assert.equal(unreadable.status, 2, unreadable.stderr);
  assert.equal(unreadable.out.step, "read-pr");
  assert.match(unreadable.out.error, /--repo cannot be read: .*ELOOP/);
});
