// Regression gate for finisher-label.mjs, the finisher's labelling duty as one
// command. Zero deps: `node --test tests/finisher-label.test.mjs`.
//
// `gh` is stubbed on PATH and every invocation is appended to one call log, so
// "nothing past the failing step ran" is read off the log, not inferred from
// the exit code. The stub answers from files in its own directory, keyed by
// call: `pr-view-N.out` is the Nth `gh pr view`, and `<key>.fail` makes that
// call print its text on stderr and exit 1. A call with no file answers an
// empty success.
//
// Each case holds every input at the baseline except the one under test, so
// removing a check reds the case named after it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeExecStub } from "./support/exec-stub.mjs";
import { tempDir } from "./support/temp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/finisher-label.mjs", import.meta.url));
const PIN = "a".repeat(40);
const OTHER = "b".repeat(40);

const STUB = `#!/bin/sh
d="\${0%/*}"
printf '%s\\n' "$*" >> "$d/calls.log"
pwd >> "$d/cwd.log"
env | grep -E '^(GIT_DIR|GIT_WORK_TREE)=' >> "$d/env.log"
case "$1 $2" in
"pr view") key="pr-view-$(grep -c '^pr view' "$d/calls.log")" ;;
"pr comment") key=pr-comment ;;
"pr edit") key=pr-edit ;;
"label list") key=label-list ;;
*) echo "stub gh: unexpected $*" >&2; exit 99 ;;
esac
if [ -f "$d/$key.fail" ]; then cat "$d/$key.fail" >&2; exit 1; fi
if [ -f "$d/$key.out" ]; then cat "$d/$key.out"; fi
exit 0
`;

const names = (...n) => n.map((name) => ({ name }));
const view = (labels, comments = []) => JSON.stringify({ labels: names(...labels), comments });
const record = (sha, createdAt) => ({ body: `ready-to-merge-head: ${sha}`, createdAt });

// A rig for one case: a fresh stub directory. `outs` and `fails` are keyed by
// the stub's call keys. The baseline is a PR with one release label and a
// read-back that carries the label.
function rig({ outs = {}, fails = {} } = {}) {
  const dir = tempDir("finisher-label-");
  mkdirSync(join(dir, "bin"));
  const bin = join(dir, "bin");
  writeExecStub(join(bin, "gh"), STUB);
  const all = {
    "pr-view-1": view(["patch", "bug"]),
    "pr-view-2": view(["patch", "bug", "ready-to-merge"]),
    "label-list": JSON.stringify(names("patch", "minor", "major", "bug")),
    ...outs,
  };
  for (const [k, v] of Object.entries(all)) writeFileSync(join(bin, `${k}.out`), v);
  for (const [k, v] of Object.entries(fails)) writeFileSync(join(bin, `${k}.fail`), v);
  const calls = () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8").trim().split("\n") : []);
  const log = (name) => (existsSync(join(bin, name)) ? readFileSync(join(bin, name), "utf8") : "");
  const run = (args = ["--pr", "42", "--pin", PIN], { env = {}, cwd } = {}) => {
    const r = spawnSync(process.execPath, [SCRIPT, ...args], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ...env },
    });
    let out = null;
    try {
      out = JSON.parse(r.stdout);
    } catch {
      // a refusal before any gh call prints no receipt
    }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, out };
  };
  return { dir, bin, calls, log, run };
}

const VIEW = "pr view 42 --json labels,comments";
const BACK = "pr view 42 --json labels";
const COMMENT = `pr comment 42 --body ready-to-merge-head: ${PIN}`;
const EDIT = "pr edit 42 --add-label ready-to-merge";

test("exit 0: one release label, the head recorded, the label added and read back", () => {
  const t = rig();
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  // The order is the contract: record before label, read-back last.
  assert.deepEqual(t.calls(), [VIEW, COMMENT, EDIT, BACK]);
  assert.deepEqual(r.out, {
    pr: 42,
    pin: PIN,
    releaseLabels: ["patch"],
    commented: true,
    added: true,
    readBack: ["patch", "bug", "ready-to-merge"],
    exit: 0,
    firstRead: ["patch", "bug"],
  });
});

test("exit 0: a pin in capitals is recorded in the lowercase the merge bot reads", () => {
  const t = rig();
  const r = t.run(["--pr", "42", "--pin", PIN.toUpperCase()]);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.calls().includes(COMMENT), t.calls().join("\n"));
  assert.equal(r.out.pin, PIN);
});

test("exit 0: other labels beside the one release label do not trip the count", () => {
  const t = rig({ outs: { "pr-view-1": view(["bug", "minor", "needs-docs", "ready-for-agent"]) } });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.releaseLabels, ["minor"]);
});

test("exit 3: a PR with no release label is refused and nothing is written", () => {
  const t = rig({ outs: { "pr-view-1": view(["bug"]) } });
  const r = t.run();
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, "label list --json name --limit 1000"]);
  assert.deepEqual(r.out.releaseLabels, []);
  assert.deepEqual(r.out.firstRead, ["bug"]);
  assert.equal(r.out.commented, false);
  assert.equal(r.out.added, false);
  assert.equal(r.out.readBack, null);
  assert.equal(r.out.exit, 3);
});

test("exit 3: a PR with two release labels is refused, names both, and posts no comment", () => {
  const t = rig({ outs: { "pr-view-1": view(["patch", "major", "bug"]) } });
  const r = t.run();
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(t.calls(), [VIEW]);
  assert.deepEqual(r.out.releaseLabels, ["patch", "major"]);
  assert.equal(r.out.commented, false);
  assert.equal(r.out.added, false);
});

test("exit 3: a repo that defines only some of the release labels still gates on a PR with none", () => {
  const t = rig({ outs: { "pr-view-1": view(["bug"]), "label-list": JSON.stringify(names("patch", "bug")) } });
  const r = t.run();
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, "label list --json name --limit 1000"]);
});

test("a repo whose label list defines none of the release labels skips the count", () => {
  const t = rig({
    outs: {
      "pr-view-1": view(["bug"]),
      "pr-view-2": view(["bug", "ready-to-merge"]),
      "label-list": JSON.stringify(names("bug", "ready-to-merge")),
    },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.releaseLabels, "undefined-in-repo");
  assert.deepEqual(t.calls(), [VIEW, "label list --json name --limit 1000", COMMENT, EDIT, BACK]);
});

test("exit 4: a read-back without the label fails even though gh pr edit returned 0", () => {
  const t = rig({ outs: { "pr-view-2": view(["patch", "bug"]) } });
  const r = t.run();
  assert.equal(r.status, 4, r.stderr);
  // Every write ran and succeeded; only the read-back says otherwise.
  assert.deepEqual(t.calls(), [VIEW, COMMENT, EDIT, BACK]);
  assert.equal(r.out.exit, 4);
  assert.equal(r.out.added, true);
  assert.deepEqual(r.out.firstRead, ["patch", "bug"]);
  assert.deepEqual(r.out.readBack, ["patch", "bug"]);
});

// Exit 2, once per gh call: the step that failed is the last call in the log.
const STEPS = [
  { key: "pr-view-1", step: "read-labels", calls: [VIEW], baseline: {} },
  { key: "label-list", step: "list-labels", calls: [VIEW, "label list --json name --limit 1000"], baseline: { "pr-view-1": view(["bug"]) } },
  { key: "pr-comment", step: "comment", calls: [VIEW, COMMENT], baseline: {} },
  { key: "pr-edit", step: "add-label", calls: [VIEW, COMMENT, EDIT], baseline: {} },
  { key: "pr-view-2", step: "read-back", calls: [VIEW, COMMENT, EDIT, BACK], baseline: {} },
];
for (const { key, step, calls, baseline } of STEPS) {
  test(`exit 2: a gh failure at ${step} carries its stderr and no later step runs`, () => {
    const t = rig({ outs: baseline, fails: { [key]: `boom at ${step}\n` } });
    const r = t.run();
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(t.calls(), calls);
    assert.equal(r.out.exit, 2);
    assert.equal(r.out.step, step);
    assert.equal(r.out.error, `boom at ${step}`);
    assert.match(r.stderr, new RegExp(`boom at ${step}`));
  });
}

test("exit 2: a failed comment leaves the label unwritten and the receipt says so", () => {
  const t = rig({ fails: { "pr-comment": "nope" } });
  const r = t.run();
  assert.equal(r.status, 2);
  assert.equal(r.out.commented, false);
  assert.equal(r.out.added, false);
  assert.equal(r.out.readBack, null);
});

test("exit 2: a failed label write after the comment reports the comment as posted", () => {
  const t = rig({ fails: { "pr-edit": "nope" } });
  const r = t.run();
  assert.equal(r.status, 2);
  assert.equal(r.out.commented, true);
  assert.equal(r.out.added, false);
});

test("exit 2: gh printing something other than the labels is a failure, not a pass", () => {
  const t = rig({ outs: { "pr-view-1": "not json" } });
  const r = t.run();
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual(t.calls(), [VIEW]);
});

for (const pin of ["a".repeat(39), "a".repeat(41), "g".repeat(40), "abc1234", "main"]) {
  test(`exit 2: --pin ${pin} is not a full SHA, and no gh call is made`, () => {
    const t = rig();
    const r = t.run(["--pr", "42", "--pin", pin]);
    assert.equal(r.status, 2, r.stderr);
    assert.deepEqual(t.calls(), []);
    assert.equal(r.out.exit, 2);
    assert.match(r.out.error, /full 40-character commit SHA/);
  });
}

test("a missing flag, an unknown flag and a non-numeric --pr are refused before any gh call", () => {
  const t = rig();
  for (const args of [["--pin", PIN], ["--pr", "42"], ["--pr", "abc", "--pin", PIN], ["--pr", "42", "--pin", PIN, "--bogus", "x"]]) {
    const r = t.run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.deepEqual(t.calls(), []);
  }
});

test("idempotent: a PR already labelled with this pin's record exits 0 and writes nothing", () => {
  const t = rig({
    outs: {
      "pr-view-1": view(["patch", "ready-to-merge"], [record(PIN, "2026-01-02T00:00:00Z")]),
      "pr-view-2": view(["patch", "ready-to-merge"]),
    },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, BACK]);
  assert.equal(r.out.added, false);
  assert.equal(r.out.commented, false);
  assert.deepEqual(r.out.readBack, ["patch", "ready-to-merge"]);
});

test("idempotent: a record is not another comment's body quoted — only a whole-body record counts", () => {
  const t = rig({
    outs: { "pr-view-1": view(["patch", "ready-to-merge"], [{ body: `see ready-to-merge-head: ${PIN} above`, createdAt: "2026-01-02T00:00:00Z" }]) },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.calls().includes(COMMENT), t.calls().join("\n"));
});

test("not idempotent: a label with no record for this pin gets the record and the label write", () => {
  const t = rig({ outs: { "pr-view-1": view(["patch", "ready-to-merge"], [record(OTHER, "2026-01-02T00:00:00Z")]) } });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, COMMENT, EDIT, BACK]);
  assert.equal(r.out.added, true);
});

test("not idempotent: the newest record decides, so an older matching one does not count", () => {
  const t = rig({
    outs: {
      "pr-view-1": view(["patch", "ready-to-merge"], [record(OTHER, "2026-01-03T00:00:00Z"), record(PIN, "2026-01-02T00:00:00Z")]),
    },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.ok(t.calls().includes(COMMENT), t.calls().join("\n"));
});

test("a newest record naming this pin is honoured wherever it sits in the comment list", () => {
  const t = rig({
    outs: {
      "pr-view-1": view(["patch", "ready-to-merge"], [record(PIN, "2026-01-03T00:00:00Z"), record(OTHER, "2026-01-02T00:00:00Z")]),
    },
  });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, BACK]);
});

test("a record for this pin with the label still missing posts no second comment but writes the label", () => {
  const t = rig({ outs: { "pr-view-1": view(["patch"], [record(PIN, "2026-01-02T00:00:00Z")]) } });
  const r = t.run();
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, EDIT, BACK]);
  assert.equal(r.out.commented, false);
  assert.equal(r.out.added, true);
});

test("an already-labelled PR with no release label is still refused", () => {
  const t = rig({ outs: { "pr-view-1": view(["ready-to-merge"], [record(PIN, "2026-01-02T00:00:00Z")]) } });
  const r = t.run();
  assert.equal(r.status, 3, r.stderr);
  assert.deepEqual(t.calls(), [VIEW, "label list --json name --limit 1000"]);
});

test("--repo is the directory gh runs in", () => {
  const t = rig();
  const repo = join(t.dir, "checkout");
  mkdirSync(repo);
  const r = t.run(["--pr", "42", "--pin", PIN, "--repo", repo]);
  assert.equal(r.status, 0, r.stderr);
  const cwds = t.log("cwd.log").trim().split("\n");
  assert.equal(cwds.length, 4);
  for (const c of cwds) assert.equal(realpathSync(c), realpathSync(repo));
});

test("an ambient GIT_DIR or GIT_WORK_TREE does not reach gh", () => {
  const t = rig();
  const r = t.run(undefined, { env: { GIT_DIR: join(t.dir, "elsewhere"), GIT_WORK_TREE: t.dir } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(t.log("env.log"), "");
});
