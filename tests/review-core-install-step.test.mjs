// #3188. The review snapshot is a `git archive` extraction, which holds no
// ignored files and so none of the consumer's installed dependencies. The
// snapshot agent now runs the Recipe's Install step in it (executed against
// fixtures in snapshot-repo.test.mjs); this file pins what the CALLER does with
// the answer, and how every agent sent to work in its own copy of the snapshot
// is told to make that copy.
//
// An Install step that exits non-zero in the snapshot is the PR's defect, not a
// crash: the shared test run is skipped, the review's suite verdict is not
// usable with the install's exit and log as the reason, and the review files one
// finding naming it. One the Recipe cache cannot supply is not usable too,
// but files nothing — that is the Recipe's state, not the PR's. Neither makes a
// dimension unrun: every specialist still returns. And the accept
// case: an install that exited 0 runs the shared test run exactly as before.
//
// Zero deps: `node --test tests/review-core-install-step.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { copyRule, installFinding, installReason, runReview, sharedRunNote } from "../plugin/scripts/review-core.mjs";
import { ARGS, SNAP, finding, parallel, pipeline, review, scriptedHost, vote } from "./support/review-host-fixture.mjs";
import { Pin } from "./support/prose-pin.mjs";

const PLUGIN = join(import.meta.dirname, "..", "plugin");
const FAILED = { ...SNAP, installExit: 3 };
const UNREAD = { ...SNAP, installCmd: undefined, installExit: undefined, installError: "derive-testcmd.sh: no Recipe cache at /repo/.fleet/recipe.json" };

async function reviewOf(snap, dims = ["correctness", "tests"]) {
  const run = scriptedHost({
    snapshot: [snap],
    "review:correctness": [review([finding("critical")])],
    "review:tests": [review([])],
    "verify:correctness": [vote(false)],
  });
  const result = await runReview({ ...run.host, pipeline, parallel }, { ...ARGS, dimensions: dims });
  return { ...run, result };
}

test("installReason passes only an Install step that exited 0, and names the exit and the log otherwise", () => {
  assert.equal(installReason(SNAP), null, "an Install step that exited 0 is refused");
  const failed = installReason(FAILED);
  assert.match(failed, /the Install step `sh \.\/install\.sh` exited 3 in the snapshot/, "a failed install's reason does not name the command and its exit");
  assert.match(failed, /\(log \/scr\/pr7\/run-ab12\/install\.log\)/, "a failed install's reason does not name the log its output went to");
  assert.match(installReason(UNREAD), /did not run in the snapshot — derive-testcmd\.sh: no Recipe cache/, "an unread install's reason does not carry the refusal");
  // An omitted exit is never a success: the snapshot agent dropped the line,
  // and a snapshot nothing was installed into measures nothing about the tree.
  assert.equal(typeof installReason({ ...SNAP, installExit: undefined }), "string", "an Install step with no reported exit reads as a success");
});

test("installFinding files one critical finding for a non-zero exit, and nothing for an unread or a passing install", () => {
  const f = installFinding(FAILED);
  assert.equal(f.severity, "critical");
  assert.equal(f.verdict, "survived", "the install finding is not an apply candidate — a fix-applier reads `survived` for those");
  assert.equal(f.dimension, "install");
  assert.match(f.claim, /exited 3 .*`sh \.\/install\.sh`/, "the finding does not name the failing command and its exit");
  assert.match(f.evidence, /\/scr\/pr7\/run-ab12\/install\.log/, "the finding's evidence does not name the install log");
  assert.equal(installFinding(UNREAD), null, "an Install step the Recipe cache could not supply is filed on the PR");
  assert.equal(installFinding(SNAP), null, "a passing Install step is filed on the PR");
});

// The finding claims what was measured — the tree it ran on and the exit — and
// says the cause is not established: a deleted script exits 127 and a kill
// exits 137, so a status alone never names the PR as the cause. It is still
// filed for every non-zero exit: exempting 127 would drop a PR that deleted
// its own install script.
test("installFinding claims the exit it measured and says why it exited is not established, for every non-zero exit", () => {
  for (const exit of [1, 124, 127, 137]) {
    const f = installFinding({ ...FAILED, installExit: exit });
    assert.ok(f, `an install that exited ${exit} files nothing`);
    assert.match(f.claim, new RegExp(`exited ${exit} on this PR's tree`), `exit ${exit}: the finding does not name the exit`);
    assert.match(f.claim, /did not establish why it exited/, `exit ${exit}: the finding names the PR's tree as the cause of a status that may be the host's`);
  }
});

test("installFinding files nothing for a snapshot that is not the reviewed tree, though its Install step exited non-zero", async () => {
  const mismatch = { ...FAILED, repoVerified: false, repoError: "SNAPSHOT_TREE_MISMATCH=snapshot aaa vs commit bbb" };
  assert.equal(installFinding(mismatch), null, "an exit measured on a different tree is filed on the PR");
  assert.equal(installFinding({ ...FAILED, repoVerified: undefined }), null, "an omitted repoVerified reads as a verified tree");
  const { calls, result } = await reviewOf(mismatch);
  assert.equal(calls["test-run"], undefined, "the shared test run was dispatched into a snapshot the Install step failed in");
  assert.deepEqual(result.dimensionsUnrun, [], "a skipped shared run made a dimension unrun");
  assert.equal(result.suiteVerdict.usable, false, "the suite verdict is usable though the shared run was skipped");
  assert.equal(result.survived.filter((f) => f.dimension === "install").length, 0, "the review filed an install finding off a snapshot it says is not the reviewed tree");
});

test("an Install step that fails in the snapshot skips the shared run, makes the suite verdict not usable naming it, and files one finding", async () => {
  const { calls, prompts, result } = await reviewOf(FAILED);
  assert.equal(calls["test-run"], undefined, "the shared test run was dispatched into a snapshot the Install step failed in");
  assert.deepEqual(result.dimensionsUnrun, [], "the skipped run made a dimension unrun");
  assert.equal(result.suiteVerdict.usable, false);
  assert.match(result.suiteVerdict.reason, /Install step `sh \.\/install\.sh` exited 3 .*install\.log/, "the suite verdict's reason does not name the install");
  const filed = result.survived.filter((f) => f.dimension === "install");
  assert.equal(filed.length, 1, "the review did not file exactly one finding naming the install failure");
  assert.equal(result.counts.survived, result.survived.length, "the install finding is not counted with the survivors it sits among");
  assert.match(prompts["review:correctness"][0], Pin.phrase("Tests: this review did NOT run its test command: the Install step"), "a specialist is not told the shared run was skipped for the install");
});

test("an Install step the Recipe cache cannot supply skips the shared run and makes the suite verdict not usable, filing nothing", async () => {
  const { calls, result } = await reviewOf(UNREAD);
  assert.equal(calls["test-run"], undefined, "the shared test run was dispatched into a snapshot nothing was installed into");
  assert.equal(result.suiteVerdict.usable, false);
  assert.match(result.suiteVerdict.reason, /no Recipe cache/, "the suite verdict's reason does not carry the refusal");
  assert.deepEqual(result.dimensionsUnrun, [], "the skipped run made a dimension unrun");
  assert.equal(result.survived.filter((f) => f.dimension === "install").length, 0, "an unreadable Recipe was filed on the PR");
});

// The accept case: what this change must NOT refuse. An Install step that
// exited 0 leaves the shared run, and the payload, exactly as before.
test("an Install step that exited 0 runs the shared test run once and files nothing about the install", async () => {
  const { calls, result } = await reviewOf(SNAP);
  assert.equal(calls["test-run"], 1, "the shared test run did not run after a passing Install step");
  assert.deepEqual(result.dimensionsUnrun, [], "a passing Install step left a dimension unrun");
  assert.deepEqual(result.suiteVerdict, { usable: true, reason: null }, "a passing Install step left the suite verdict not usable");
  assert.equal(result.survived.filter((f) => f.dimension === "install").length, 0, "a passing Install step was filed on the PR");
});

test("the skipped run's note tells a specialist not to replace the run and not to file the install", () => {
  const note = sharedRunNote({ command: "node --test", logPath: "/r/test-run.log", unprovisioned: installReason(FAILED) }, "correctness", "tests");
  assert.match(note, Pin.phrase("The review reports its suite verdict not usable for it — do not run the full command yourself to replace it, and file nothing about the install: the review reports it itself."));
  assert.doesNotMatch(note, /ran its test command ONCE/, "the skipped run is described as a run that happened");
});

// --- your own copy of the snapshot ---------------------------------------

test("copyRule names measure-copy.mjs with the PR worktree, the reviewed head, a destination in the agent's own directory and the run's scratch — never the snapshot's tracked-files-only recipe", () => {
  const rule = copyRule(SNAP, "/repo/.worktrees/7-x", "/scr/pr7/run-ab12/correctness", "/scr", 7);
  for (const clause of [
    "Make your own copy of the tree at the reviewed head with the one script that builds every measuring copy, never by hand",
    "~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run measure-copy.mjs --worktree /repo/.worktrees/7-x --pin abc123 --dest /scr/pr7/run-ab12/correctness/copy --pr 7 --scratch /scr",
    "For each further copy, give `--dest` another new directory under /scr/pr7/run-ab12/correctness/.",
    "Any other exit is no usable copy: measure nothing in it, never make one by hand, and name the exit and the receipt's `message` in what you report.",
    "Never `cp -R` or clone the snapshot, and never symlink its ignored paths",
  ]) {
    assert.match(rule, Pin.phrase(clause), `copyRule lost: ${clause}`);
  }
  assert.doesNotMatch(rule, /--worktree \/scr\/pr7\/run-ab12\/snapshot/, "the snapshot was named as the worktree");
  assert.doesNotMatch(rule, /git -C [^\n]* archive/, "the rule still spells the copy out by hand");
  assert.equal(copyRule(UNREAD, "/repo/.worktrees/7-x", "/scr/pr7/run-ab12/correctness", "/scr", 7), rule, "the rule depends on what the snapshot's Install step read — the script reads the Recipe itself");
});

test("copyRule names the scratch root and PR it is given, never ones read back off the reported run root", () => {
  const rule = copyRule({ ...SNAP, runRoot: "/elsewhere/run-ab12" }, "/repo/.worktrees/7-x", "/scr/pr7/run-ab12/correctness", "/scr", 7);
  assert.match(rule, Pin.phrase("--dest /scr/pr7/run-ab12/correctness/copy --pr 7 --scratch /scr"));
  assert.doesNotMatch(rule, /undefined/);
});

test("every dispatched prompt that sends an agent into its own copy of the snapshot carries the rule for making it, with that agent's own directory", async () => {
  const { prompts } = await reviewOf(SNAP);
  const sent = Object.entries(prompts).flatMap(([label, ps]) => ps.map((p) => [label, p]));
  const own = sent.filter(([, p]) => p.includes("own copy of the snapshot"));
  assert.deepEqual([...new Set(own.map(([label]) => label))].sort(), ["review:correctness", "review:tests", "verify:correctness"], "the prompts that send an agent into its own copy are not the ones this pin reads");
  const dirs = {
    "review:correctness": ["correctness"],
    "review:tests": ["tests"],
    "verify:correctness": ["verify-correctness/f1-l1", "verify-correctness/f1-l2"],
  };
  for (const [label, p] of own) {
    const rules = dirs[label].map((d) => copyRule(SNAP, ARGS.worktree, `${SNAP.runRoot}/${d}`, ARGS.scratch, ARGS.pr));
    assert.ok(rules.some((rule) => p.includes(rule)), `${label} sends an agent into its own copy of the snapshot without saying how to make it`);
    assert.ok(p.includes(`--worktree ${ARGS.worktree} `), `${label} names a worktree other than the PR's`);
  }
});

test("the shipped markdown that sends an agent into its own copy says how to make it", () => {
  const md = (rel) => readFileSync(join(PLUGIN, rel), "utf8");
  const reviewAndFix = Pin.of(md("commands/review-and-fix.md"), "review-and-fix.md").bullet("- **Initialize the copy before anyone measures in it", "\n- **Give specialists", "review-and-fix.md's copy bullet").text;
  assert.match(
    reviewAndFix,
    Pin.phrase("copy the tracked files only (`git -C <snapshot> archive HEAD | tar -x -C <copy>`, or a `git clone` of the snapshot repository), `git init`, `git add -A -f` and commit, then run the Install step in the copy before measuring anything in it — never `cp -R` the snapshot."),
    "review-and-fix.md no longer tells the agents it sends into a copy how to make it",
  );
  assert.match(
    md("agents/fleet-review-tests.agent.md"),
    Pin.phrase("Make that copy with the command your dispatch prompt gives for it, run exactly as written: any non-zero exit is no usable copy, so measure nothing in it. Where your dispatch prompt gives none, make that copy from the snapshot's tracked files only — `git -C <snapshot> archive HEAD | tar -x -C <copy>`, or a `git clone` of the snapshot repository — then `git init`, `git add -A -f` and commit in it, then run the Install step your dispatch prompt names from the copy's root before you measure anything there. Never `cp -R` the snapshot, and never symlink or clone its ignored paths"),
    "fleet-review-tests.agent.md no longer says how to make its own copy of the snapshot",
  );
  assert.doesNotMatch(md("commands/review-and-fix.md"), /symlink in what it produced/, "review-and-fix.md suggests symlinking installed output into a copy again");
});
