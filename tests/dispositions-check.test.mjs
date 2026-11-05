// dispositions-check.mjs: the judgement of a review fix-applier's disposition
// record against the review file and the PR's diff — the pure core, the
// standalone CLI (`--no-ledger --review <path>`, the exit status the whole
// verdict, no ledger touched) and its refusals of whatever is the ledger
// verb's. The verb's own cases, with the verdict written onto the ledger, are
// ledger-dispositions.test.mjs's.
//
// Every CLI case runs against a real git repository built in a temp dir —
// `origin/main` a ref, the PR head one commit past it — so the touched lines
// are git's own answer, not a fixture's restatement of one. The tracker is a
// `gh` stub first on PATH, answering `issue view` and `pr view` from JSON files the
// fixture writes: no case reaches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync, chmodSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  touchedLines, checkDispositions, withVerdict, repoPath, formatViolation, formatEscalation, failedBefore, verdictProblem, recordTitle, FILING_ROWS,
} from "../plugin/scripts/dispositions-check.mjs";
import { rendering } from "./support/rendered-brief.mjs";
import { seedLabelMap } from "./support/label-map-seed.mjs";
import {
  LEDGER, IDENTITY, REMAP, cleanEnv, git, fixture, mismatch, okVerdict, H40, coreRun, core, applied, escalated, deferOutside, withSeverity,
} from "./support/dispositions-fixture.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/dispositions-check.mjs", import.meta.url));

test("a mismatch from a later suffix, an ok, or another PR's fix-applier is not an earlier failure", () => {
  const H = "run-abc1234r";
  const row = (...tokens) => `#10 impl-10=PR#40 → PR#40 · reviewed=abc1234:1/0/0:${H} · ${tokens.join(" · ")}`;
  const b = { retry: "b" };
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-40:${H}`)], 40, b, H), true);
  assert.equal(failedBefore([row(`dispositions-escalate=fix-pr-40:${H}`)], 40, b, H), true);
  assert.equal(failedBefore([row(`dispositions-ok=fix-pr-40:${H}`)], 40, b, H), false, "an ok is no failure");
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-40-c:${H}`)], 40, b, H), false, "a later suffix is not earlier");
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-40-b:${H}`)], 40, b, H), false, "the member itself is not earlier");
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-40:${H}`)], 40, { retry: null }, H), false, "nor is the first fix-applier's own re-run");
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-40:run-fedcba9r`)], 40, b, H), false, "another review's run");
  assert.equal(failedBefore([row(`dispositions-mismatch=fix-pr-41:${H}`)], 40, b, H), false, "another PR's fix-applier");
  // A split row: the earlier verdict sits on another row that resolves to PR 40.
  assert.equal(failedBefore(["#11 impl-11=PR#40 → PR#40 · dispositions-mismatch=fix-pr-40:run-abc1234r", "#12 impl-12=PR#41 → PR#41"], 40, b, H), true);
  // A copy of PR 40's verdict on PR 41's row is a stray: that row does not resolve to PR 40.
  assert.equal(failedBefore(["#12 impl-12=PR#41 → PR#41 · dispositions-mismatch=fix-pr-40:run-abc1234r"], 40, b, H), false);
  // A verdict in the shape before it named a run answers no review.
  assert.equal(failedBefore([row("dispositions-mismatch=fix-pr-40:abc1234")], 40, b, H), false);
});

// A standalone `/review-and-fix` has no controller and so no ledger: the run
// is from the worktree, `--ledger` is not given, and `.fleet/ledger.md` does
// not exist under its git common dir.
function standalone(f, ...extra) {
  const r = spawnSync(process.execPath, [SCRIPT, "--member", "fix-pr-40", "--scratch", f.scratch, ...extra],
    { encoding: "utf8", env: f.env(), cwd: f.repo });
  return { ...r, json: r.status === 0 || r.status === 1 ? JSON.parse(r.stdout) : null };
}

test("with no ledger the exit status is the verdict, and nothing is written to any ledger", (t) => {
  const f = fixture(t);
  const ledgerBefore = readFileSync(join(f.dir, "ledger.md"), "utf8");

  f.writeRecord(f.baseEntries());
  let r = standalone(f, "--review", f.reviewPath);
  okVerdict(r);
  assert.equal(r.json.token, null);
  assert.deepEqual(r.json.violations, []);
  assert.equal(r.stderr, "", "no --ledger and no default ledger is a standalone run that prints nothing");

  const bad = f.baseEntries();
  bad[0] = f.entry("survived", 0, { disposition: "defer" });
  f.writeRecord(bad);
  r = standalone(f, "--review", f.reviewPath);
  mismatch(r, /^fix-pr-40: survived\[0\]: an in-scope survived finding deferred with no reason/m);
  assert.equal(r.json.token, null);
  assert.deepEqual(r.json.violations.map((v) => [v.bucket, v.index]), [["survived", 0]]);

  rmSync(f.recordPath());
  mismatch(standalone(f, "--review", f.reviewPath), /record: no disposition record at .*dispositions-fix-pr-40\.json/);

  assert.deepEqual(readdirSync(join(f.repo, ".fleet")), ["labels.json"], "no ledger was created beside the seeded Label map");
  assert.equal(readFileSync(join(f.dir, "ledger.md"), "utf8"), ledgerBefore, "a ledger elsewhere is not this run's and is not touched");
});

// The verb and the standalone check share one judgement, and the verb is the
// only one that writes a ledger. So this script refuses what is the verb's:
// `--ledger`, `--uphold` and `--send-back` at once, and any ledger it finds
// outside `--no-ledger`. Each refusal is exit 2, names `ledger.mjs
// dispositions <member> --scratch <dir>`, and touches nothing.
const VERB_NAMED = /ledger\.mjs dispositions fix-pr-40 --scratch \S+/;

test("--ledger, --uphold and --send-back are the verb's: refused at exit 2 naming it, with nothing judged and no ledger touched", (t) => {
  const f = fixture(t);
  const own = seedOwnLedger(f);
  const ownBefore = readFileSync(own, "utf8");
  const ledgerBefore = readFileSync(join(f.dir, "ledger.md"), "utf8");
  const absent = join(f.dir, "absent", "ledger.md");
  f.writeRecord(f.baseEntries());
  for (const extra of [
    ["--ledger", own], ["--ledger", absent], ["--ledger", join(f.dir, "ledger.md"), "--no-ledger"],
    ["--uphold", "survived[0]"], ["--send-back", "survived[0]"],
    ["--no-ledger", "--review", f.reviewPath, "--uphold", "survived[0]"], ["--no-ledger", "--review", f.reviewPath, "--send-back", "survived[0]"],
  ]) {
    const r = standalone(f, ...extra);
    assert.equal(r.status, 2, `${extra.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, VERB_NAMED, extra.join(" "));
    assert.equal(r.stdout, "", `${extra.join(" ")}: nothing was judged`);
  }
  assert.equal(readFileSync(own, "utf8"), ownBefore);
  assert.equal(readFileSync(join(f.dir, "ledger.md"), "utf8"), ledgerBefore);
  assert.equal(existsSync(join(f.dir, "absent")), false, "nothing was created for the ledger a flag named");
});

// Writes `f.repo`'s own `.fleet/ledger.md` with the member's row, as a fleet
// run's `ledger.mjs dispatch` leaves it, and returns its path.
function seedOwnLedger(f) {
  const ledger = join(f.repo, ".fleet", "ledger.md");
  const run = rendering(dirname(ledger), (...args) => {
    const r = spawnSync(process.execPath, [LEDGER, "--file", ledger, ...args], { encoding: "utf8", env: cleanEnv() });
    assert.equal(r.status, 0, r.stderr);
  });
  run("row", "10", "impl-10=PR#40 → PR#40");
  run("review", "40", "review=member:review-pr-40", `reviewed=${f.head}:2/1/1:${f.run}`);
  run("dispatch", "40", "fix-pr-40");
  run("settle", "fix-pr-40", `applied:${f.head.slice(0, 7)}`);
  return ledger;
}

test("a ledger at the default path is refused without --no-ledger, --review or not: nothing is judged, and the refusal names the verb and --no-ledger --review", (t) => {
  const f = fixture(t);
  const ledger = seedOwnLedger(f);
  const before = readFileSync(ledger, "utf8");
  f.writeRecord(f.baseEntries());
  for (const extra of [[], ["--review", f.reviewPath]]) {
    const r = standalone(f, ...extra);
    assert.equal(r.status, 2, `${extra.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, VERB_NAMED);
    assert.match(r.stderr, /--no-ledger --review <path>/);
    assert.ok(r.stderr.includes(ledger), "the refusal names the ledger it found");
    assert.equal(r.stdout, "");
  }
  assert.equal(readFileSync(ledger, "utf8"), before, "no verdict was written");
});

test("a ledger that exists is never skipped: one with no row for the member is refused as any other, not read as a standalone run", (t) => {
  const f = fixture(t);
  const stale = join(f.repo, ".fleet", "ledger.md");
  const made = spawnSync(process.execPath, [LEDGER, "--file", stale, "row", "11", "impl-11=PR#41 → PR#41"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(made.status, 0, made.stderr);
  const before = readFileSync(stale, "utf8");
  f.writeRecord(f.baseEntries());
  const r = standalone(f, "--review", f.reviewPath);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, VERB_NAMED);
  assert.equal(readFileSync(stale, "utf8"), before);
});

// A repository's `.fleet/ledger.md` outlives the fleet run that wrote it, and
// every worktree of the repository finds it through the git common dir.
function linkedWorktree(f) {
  const wt = join(f.dir, "wt");
  git(f.repo, "worktree", "add", "-q", "--detach", wt, f.head);
  return wt;
}

test("from a linked worktree the default ledger is the main checkout's, found through the git common dir, and is refused all the same", (t) => {
  const f = fixture(t);
  const wt = linkedWorktree(f);
  const ledger = seedOwnLedger(f);
  const before = readFileSync(ledger, "utf8");
  f.writeRecord(f.baseEntries());
  const r = standalone(f, "--repo", wt);
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.stderr.includes(ledger), r.stderr);
  assert.match(r.stderr, VERB_NAMED);
  assert.equal(readFileSync(ledger, "utf8"), before);
  assert.equal(existsSync(join(wt, ".fleet")), false, "the worktree holds no ledger of its own");
});

test("--no-ledger is a standalone run whatever ledger the repository holds: a stale one is not a fault, and none is written", (t) => {
  const f = fixture(t);
  const wt = linkedWorktree(f);
  const stale = join(f.repo, ".fleet", "ledger.md");
  mkdirSync(join(f.repo, ".fleet"), { recursive: true });
  const made = spawnSync(process.execPath, [LEDGER, "--file", stale, "row", "11", "impl-11=PR#41 → PR#41"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(made.status, 0, made.stderr);
  const before = readFileSync(stale, "utf8");
  f.writeRecord(f.baseEntries());

  const fault = standalone(f, "--repo", wt, "--review", f.reviewPath);
  assert.equal(fault.status, 2, fault.stderr);
  assert.match(fault.stderr, /--no-ledger --review <path>/);

  const r = standalone(f, "--repo", wt, "--no-ledger", "--review", f.reviewPath);
  okVerdict(r);
  assert.equal(r.json.token, null);
  assert.equal(r.stderr, "", "--no-ledger is a chosen standalone run and prints nothing");
  assert.equal(readFileSync(stale, "utf8"), before);

  const bad = f.baseEntries();
  bad[0] = f.entry("survived", 0, { disposition: "defer" });
  f.writeRecord(bad);
  mismatch(standalone(f, "--repo", wt, "--no-ledger", "--review", f.reviewPath), /^fix-pr-40: survived\[0\]/m);
});

test("--no-ledger leaves a ledger that holds the member's row unwritten", (t) => {
  const f = fixture(t);
  const ledger = seedOwnLedger(f);
  const before = readFileSync(ledger, "utf8");
  f.writeRecord(f.baseEntries());
  const r = standalone(f, "--no-ledger", "--review", f.reviewPath);
  okVerdict(r);
  assert.equal(r.json.token, null);
  assert.equal(r.stderr, "");
  assert.equal(readFileSync(ledger, "utf8"), before);
});

// #2886: without a ledger nothing names the review the record answers, so
// `--review` must.
test("with no ledger --review is required", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());
  for (const extra of [["--no-ledger"], []]) {
    const r = standalone(f, ...extra);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /no ledger names PR #40's review — pass --review <path>/, extra.join(" "));
  }
});

// A missing `--review` is a usage error, told before the Label map is read: a
// run with neither is sent to `--review`, not to `label-map.mjs ensure` first.
test("a missing --review is told before a missing Label map", (t) => {
  const f = fixture(t, { labelMap: null });
  f.writeRecord(f.baseEntries());
  const r = standalone(f, "--no-ledger");
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /no ledger names PR #40's review — pass --review <path>/);
});

test("a ledger path that cannot be looked up is a fault, never a standalone run", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());

  // `.fleet` is a regular file, so `.fleet/ledger.md` fails ENOTDIR, not ENOENT.
  rmSync(join(f.repo, ".fleet"), { recursive: true });
  writeFileSync(join(f.repo, ".fleet"), "");
  let r = standalone(f, "--review", f.reviewPath);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /could not look for the ledger .*ledger\.md/);
  rmSync(join(f.repo, ".fleet"));

  // A dangling symlink is a ledger that cannot be read, not an absent one. The
  // Label map went with the `.fleet` file above, so it is seeded again.
  mkdirSync(join(f.repo, ".fleet"), { recursive: true });
  seedLabelMap(f.repo);
  symlinkSync(join(f.dir, "nowhere.md"), join(f.repo, ".fleet", "ledger.md"));
  r = standalone(f, "--review", f.reviewPath);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, VERB_NAMED);
  assert.equal(existsSync(join(f.dir, "nowhere.md")), false, "nothing was created through the link");
});

// The default ledger is looked up through fleet-dir.mjs's fleetFile(), and a
// failure of that lookup refuses at exit 2 with ITS message: what failed and
// git's reason. The repository is a real one (the merge-base probes before it
// answer), so the shim refuses only the `--git-common-dir` question.
test("a default ledger whose location cannot be resolved is a fault naming the failed resolution and its reason", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries());
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const shimDir = join(f.dir, "git-shim");
  mkdirSync(shimDir);
  writeFileSync(join(shimDir, "git"),
    `#!/bin/sh\ncase " $* " in *" --git-common-dir "*) echo "shim-refusal" >&2; exit 1 ;; esac\nexec '${real}' "$@"\n`);
  chmodSync(join(shimDir, "git"), 0o755);
  const r = spawnSync(process.execPath, [SCRIPT, "--member", "fix-pr-40", "--scratch", f.scratch, "--repo", f.repo, "--review", f.reviewPath],
    { encoding: "utf8", env: f.env({ ...cleanEnv(), PATH: `${shimDir}:${process.env.PATH}` }), cwd: f.dir });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /dispositions-check: could not resolve --git-common-dir: shim-refusal/);
});

test("an ambient GIT_DIR naming another repository does not change which ledger is found", (t) => {
  const f = fixture(t);
  const ledger = seedOwnLedger(f);
  const before = readFileSync(ledger, "utf8");
  const other = join(f.dir, "other");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  f.writeRecord(f.baseEntries());
  const r = spawnSync(process.execPath, [SCRIPT, "--member", "fix-pr-40", "--scratch", f.scratch, "--repo", f.repo],
    { encoding: "utf8", env: f.env({ ...cleanEnv(), GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other }), cwd: f.dir });
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.stderr.includes(ledger), `the refusal names the repository's own ledger, not the ambient repository's: ${r.stderr}`);
  assert.equal(readFileSync(ledger, "utf8"), before);
});

test("touchedLines reads new-side lines; pure deletions and deleted files touch none", () => {
  const diff = [
    "diff --git a/x b/x", "--- a/x", "+++ b/x",
    "@@ -3 +3 @@", "-o", "+n",
    "@@ -10,0 +11,2 @@", "+p", "+q",
    "@@ -20,2 +21,0 @@", "-r", "-s",
    "diff --git a/gone b/gone", "--- a/gone", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-t", "-u",
  ].join("\n");
  const t = touchedLines(diff);
  assert.deepEqual([...t.get("x")], [3, 11, 12]);
  assert.equal(t.has("gone"), false);
});

test("repoPath reads an absolute finding path relative to the snapshot or the repository", () => {
  assert.equal(repoPath("/snap/src/a.js", ["/snap", "/repo"]), "src/a.js");
  assert.equal(repoPath("/repo/src/a.js", ["/snap", "/repo"]), "src/a.js");
  assert.equal(repoPath("./src/a.js"), "src/a.js");
  assert.equal(repoPath("/elsewhere/a.js", ["/snap"]), "/elsewhere/a.js");
});

test("checkDispositions reads an absolute snapshot path onto the diff's touched lines", () => {
  const review = { head: "abc1234", survived: [{ file: "/snap/src/a.js", line: 5 }], unverified: [], refuted: [] };
  const record = { head: "abc1234", entries: [{ bucket: "survived", index: 0, scope: "out", claimKind: "behavior", disposition: "defer", issue: 9 }] };
  const touched = new Map([["src/a.js", new Set([5])]]);
  const filing = { pr: 40, roles: IDENTITY, issue: () => ({ state: "OPEN", title: "a deferred finding", labels: ["ready-for-agent"] }) };
  assert.equal(checkDispositions({ review, record, touched, roots: ["/snap"], filing }).violations.length, 1);
  assert.equal(checkDispositions({ review, record, touched: new Map(), roots: ["/snap"], filing }).violations.length, 0);
});

test("withVerdict replaces only the same member's verdict for the same review run", () => {
  const H = "run-Rv40Aa01";
  const ok = `dispositions-ok=fix-pr-40:${H}`;
  const bad = `dispositions-mismatch=fix-pr-40:${H}`;
  const other = `dispositions-ok=fix-pr-40-b:${H}`;
  const older = "dispositions-mismatch=fix-pr-40:run-def5678r";
  assert.equal(withVerdict(`impl-10=PR#40 · ${bad}`, ok), `impl-10=PR#40 · ${ok}`);
  assert.equal(withVerdict(`impl-10=PR#40 · ${ok}`, ok), `impl-10=PR#40 · ${ok}`);
  assert.equal(withVerdict(`${bad} · impl-10=PR#40`, ok), `impl-10=PR#40 · ${ok}`);
  assert.equal(withVerdict(`impl-10=PR#40 · ${other} · ${older}`, ok), `impl-10=PR#40 · ${other} · ${older} · ${ok}`);
});

const finding = (file, line) => ({ severity: "important", file, line, claim: "c", evidence: "e" });

test("run through a symlinked path, the check still judges, and a bare run still prints its usage", (t) => {
  const f = fixture(t);
  const link = join(f.dir, "dispositions-check-link.mjs");
  symlinkSync(SCRIPT, link);
  f.writeRecord(f.baseEntries());
  const r = spawnSync(process.execPath, [link, "--member", "fix-pr-40", "--scratch", f.scratch, "--no-ledger", "--review", f.reviewPath],
    { encoding: "utf8", env: f.env(), cwd: f.repo });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).verdict, "ok", "judged, not skipped as a module that was merely imported");
  const bare = spawnSync(process.execPath, [link], { encoding: "utf8", env: cleanEnv() });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /usage: dispositions-check\.mjs/);
});

test("a record entry that is no object, names no position, or a record with no entries is a mismatch, never a crash", () => {
  assert.deepEqual(core([applied, { ...applied, index: -1 }]), ["survived[-1]: entries[1] names no finding — survived holds 1"]);
  assert.deepEqual(core([applied, null]), ["record: entries[1] is not an object"]);
  assert.deepEqual(core([applied, ["survived", 0]]), ["record: entries[1] is not an object"]);
  assert.deepEqual(core(null, { record: { head: H40 } }), [
    "record: the record is not {head, entries: [...]}", "survived[0]: no entry — a finding with no entry is a dropped finding",
  ]);
});

test("every optional field is held to its type, and a well-typed one passes", () => {
  const malformed = (more, msg) => assert.deepEqual(core([{ ...applied, ...more }]), [`survived[0]: malformed entry — ${msg}`]);
  malformed({ issue: 0 }, "issue is not an issue number");
  malformed({ issue: "7" }, "issue is not an issue number");
  malformed({ issue: 1.5 }, "issue is not an issue number");
  malformed({ reason: 5 }, "reason is not a string");
  malformed({ verdictPath: 1 }, "verdictPath is not a string");
  malformed({ remedyFiles: [1] }, "remedyFiles is not an array of paths");
  malformed({ remedyFiles: "src/a.js" }, "remedyFiles is not an array of paths");
  malformed({ claimKind: "both" }, 'claimKind "both" is not one of behavior|shape');
  malformed({ disposition: undefined }, "disposition null is not one of apply|defer");
  assert.deepEqual(core([{ ...applied, issue: 1, reason: "", verdictPath: "", remedyFiles: [] }]), []);
});

test("the record's head answers the review's as a prefix in either direction, never below seven hex", () => {
  assert.deepEqual(core([applied], { head: H40.slice(0, 7) }), []);
  assert.deepEqual(core([applied], { head: H40.toUpperCase() }), []);
  assert.deepEqual(core([applied], { reviewHead: H40.slice(0, 10) }), []);
  const stale = (head) => [`record: the record answers head ${JSON.stringify(head)}, not the review's ${H40}`];
  assert.deepEqual(core([applied], { head: "abc" }), stale("abc"));
  assert.deepEqual(core([applied], { head: "abc1235" }), stale("abc1235"));
});

test("a finding with a line and no file is in scope; a reversed refutation's whitespace reason names no evidence", () => {
  const out = { ...applied, scope: "out", disposition: "defer", issue: 9 };
  assert.match(core([out], { survived: [{ line: 5 }] })[0], /^survived\[0\]: .* it has no file, so it is in scope/);
  assert.deepEqual(core([applied, { ...applied, bucket: "refuted", reason: " \t" }]),
    ["refuted[0]: a reversed refutation names its evidence in reason, and this one names none"]);
});

test("an absolute path into a copy of the tree no root names is read by the touched file it ends in", () => {
  const out = { ...applied, scope: "out", disposition: "defer", issue: 9 };
  // A specialist's own copy of the snapshot, and a /tmp alias of a root.
  for (const file of ["/tmp/specialist-copy/src/a.js", "/private/snap/src/a.js"]) {
    assert.match(core([out], { survived: [{ file, line: 5 }] })[0] ?? "", /^survived\[0\]: .*src\/a\.js:5 is a line the PR's diff touched/, file);
  }
  // What it must accept: an untouched line, an untouched file, and a name
  // that only ends in a touched one mid-component.
  for (const [file, line] of [["/tmp/specialist-copy/src/a.js", 6], ["/tmp/specialist-copy/src/b.js", 5], ["/tmp/copy/notsrc/a.js", 5]]) {
    assert.deepEqual(core([out], { survived: [{ file, line }] }), [], file);
  }
  assert.equal(repoPath("/x/src/a.js", ["/snap"], ["a.js", "src/a.js"]), "src/a.js");
  assert.equal(repoPath("/x/notsrc/a.js", ["/snap"], ["src/a.js"]), "/x/notsrc/a.js");
  assert.equal(repoPath("./././src/a.js"), "src/a.js");
});

test("touchedLines reads an added `++ ` line as content and unquotes git's header names", () => {
  const diff = [
    "diff --git a/x b/x", "--- a/x", "+++ b/x",
    "@@ -2 +2 @@", "-l2", "+++ b/elsewhere",
    "@@ -25 +25 @@", "-l25", "+l25 changed",
    "diff --git a/my file b/my file", "--- a/my file\t", "+++ b/my file\t", "@@ -1 +1 @@", "-o", "+n",
    'diff --git "a/q\\"x" "b/q\\"x"', '--- "a/q\\"x"', '+++ "b/q\\"x"', "@@ -0,0 +1 @@", "+n",
    'diff --git "a/\\303\\251\\tt" "b/\\303\\251\\tt"', "--- /dev/null", '+++ "b/\\303\\251\\tt"', "@@ -0,0 +1 @@", "+n",
  ].join("\n");
  const t = touchedLines(diff);
  assert.deepEqual([...t.keys()], ["x", "my file", 'q"x', "é\tt"]);
  assert.deepEqual([...t.get("x")], [2, 25]);
});

test("withVerdict leaves a row already carrying only the token unchanged, folds an emptied row, and refuses a non-verdict token", () => {
  const ok = "dispositions-ok=fix-pr-40:run-Rv40Aa01";
  assert.equal(withVerdict(ok, ok), ok);
  // Already the row's only verdict for that member and run: left where it sits.
  assert.equal(withVerdict(`${ok} · impl-10=PR#40`, ok), `${ok} · impl-10=PR#40`);
  assert.equal(withVerdict("dispositions-mismatch=fix-pr-40:run-Rv40Aa01", ok), ok);
  assert.equal(withVerdict("· dispositions-mismatch=fix-pr-40:run-Rv40Aa01 ·", ok), ok);
  assert.throws(() => withVerdict(`impl-10=PR#40 · ${ok}`, "garbage"), /'garbage' is not a dispositions-ok=\/dispositions-mismatch=\/dispositions-escalate=\/dispositions-unchecked= token/);
});

// ---------------------------------------------------------------------------
// remedy-outside-diff: a deferral whose remedy lies in a file the PR's diff
// does not name. In the fixture src/a.js is in the PR's diff and src/b.js is
// not.
// ---------------------------------------------------------------------------

test("checkDispositions: escalation is every severity but suggestion, a missing severity included; diffFiles is required when a deferral needs it", () => {
  const entry = { bucket: "survived", index: 0, scope: "in", claimKind: "behavior", disposition: "defer", reason: "remedy-outside-diff", remedyFiles: ["src/b.js"], issue: 81 };
  for (const [severity, expected] of [["critical", 1], ["important", 1], [undefined, 1], ["suggestion", 0]]) {
    const r = coreRun([entry], { survived: [{ file: "src/a.js", line: 5, severity }] });
    assert.deepEqual(r.violations, [], String(severity));
    assert.equal(r.escalations.length, expected, String(severity));
  }
  assert.deepEqual(coreRun([entry], { survived: [{ file: "src/a.js", line: 5, severity: "important" }] }).escalations,
    [{ bucket: "survived", index: 0, severity: "important", files: ["src/b.js"] }]);
  assert.throws(() => coreRun([entry], { diffFiles: null }), /no diffFiles was given/);
  // A remedy the other reasons never read: no diffFiles needed.
  assert.deepEqual(coreRun([{ ...entry, reason: "remedy-worse" }], { diffFiles: null }).violations, []);
});

test("withVerdict replaces an escalation with the same member's later verdict for the review, and an escalation for an ok", () => {
  const esc = "dispositions-escalate=fix-pr-40:run-Rv40Aa01";
  const ok = "dispositions-ok=fix-pr-40:run-Rv40Aa01";
  assert.equal(withVerdict(`impl-10=PR#40 · ${esc}`, ok), `impl-10=PR#40 · ${ok}`);
  assert.equal(withVerdict(`impl-10=PR#40 · ${ok}`, esc), `impl-10=PR#40 · ${esc}`);
});

// ---------------------------------------------------------------------------
// The maintainer's escalation answers, as the pure core reads them: `answers`
// maps a finding's address, `<bucket>[<index>]`, to `upheld` or `sent-back`.
// ---------------------------------------------------------------------------

// survived[0], deferred remedy-outside-diff with its remedy in a file the diff lacks.
const outsideDiff = { bucket: "survived", index: 0, scope: "in", claimKind: "behavior", disposition: "defer", reason: "remedy-outside-diff", remedyFiles: ["src/b.js"], issue: 81 };
const SENT_BACK = /^survived\[0\]: .*sent back to be applied in this PR/;
const answered = (...pairs) => new Map(pairs);

test("formatEscalation names the finding, its severity and its remedy files, and ends with the maintainer answering", () => {
  assert.equal(formatEscalation({ bucket: "survived", index: 0, severity: "critical", files: ["src/b.js", "src/c.js"] }),
    "survived[0]: a critical finding deferred remedy-outside-diff, its remedy in src/b.js, src/c.js — the maintainer answers");
  assert.equal(formatEscalation({ bucket: "unverified", index: 2, severity: null, files: ["src/b.js"] }),
    "unverified[2]: a severity-less finding deferred remedy-outside-diff, its remedy in src/b.js — the maintainer answers");
});

test("checkDispositions: an upheld finding is no escalation, and an answer to another finding leaves this one escalated", () => {
  const survived = [{ file: "src/a.js", line: 5, severity: "important" }, { file: "src/a.js", line: 30, severity: "critical" }];
  const second = { ...outsideDiff, index: 1 };
  const unanswered = coreRun([outsideDiff, second], { survived });
  assert.deepEqual(unanswered.escalations.map((x) => `${x.bucket}[${x.index}]`), ["survived[0]", "survived[1]"], "control: unanswered, both escalate");
  const one = coreRun([outsideDiff, second], { survived, answers: answered(["survived[0]", "upheld"]) });
  assert.deepEqual(one.violations, []);
  assert.deepEqual(one.escalations, [{ bucket: "survived", index: 1, severity: "critical", files: ["src/b.js"] }]);
  const both = coreRun([outsideDiff, second], { survived, answers: answered(["survived[0]", "upheld"], ["survived[1]", "upheld"]) });
  assert.deepEqual([both.violations, both.escalations, both.unchecked], [[], [], []]);
});

test("checkDispositions: an unverified finding's escalation is answered by its own address", () => {
  const entry = { ...outsideDiff, bucket: "unverified", verdictPath: "/scratch/pr40/fix-Ab12Cd34/1/verdict.json" };
  const opts = { survived: [], unverified: [{ file: "src/a.js", line: 5, severity: "important" }], verdicts: { [entry.verdictPath]: { refuted: false } } };
  assert.deepEqual(coreRun([entry], opts).escalations.map((x) => `${x.bucket}[${x.index}]`), ["unverified[0]"], "control");
  assert.equal(coreRun([entry], { ...opts, answers: answered(["survived[0]", "upheld"]) }).escalations.length, 1, "another bucket's address answers nothing");
  const upheld = coreRun([entry], { ...opts, answers: answered(["unverified[0]", "upheld"]) });
  assert.deepEqual([upheld.violations, upheld.escalations], [[], []]);
  const back = coreRun([entry], { ...opts, answers: answered(["unverified[0]", "sent-back"]) });
  assert.equal(back.violations.length, 1);
  assert.match(formatViolation(back.violations[0]), /^unverified\[0\]: .*sent back to be applied in this PR/);
  assert.deepEqual(back.escalations, []);
});

test("checkDispositions: an entry that defers a sent-back finding is one violation whatever its reason, and escalates nothing", () => {
  const sentBack = answered(["survived[0]", "sent-back"]);
  for (const more of [
    {},
    { remedyFiles: ["src/a.js"] },
    { remedyFiles: [] },
    { issue: undefined },
    { reason: "mutual-exclusion" },
    { reason: "remedy-worse" },
    { reason: "false-rationale" },
    { reason: "outside-ticket-files" },
    { reason: "" },
    { reason: undefined },
    { scope: "out" },
  ]) {
    const r = coreRun([{ ...outsideDiff, ...more }], { answers: sentBack });
    const said = JSON.stringify(more);
    assert.equal(r.violations.length, 1, `${said}: ${r.violations.map(formatViolation).join(" | ")}`);
    assert.match(formatViolation(r.violations[0]), SENT_BACK, said);
    assert.deepEqual(r.escalations, [], said);
  }
});

test("checkDispositions: a sent-back finding the entry applies passes, and an answer excuses no other rule", () => {
  const sentBack = answered(["survived[0]", "sent-back"]);
  const upheld = answered(["survived[0]", "upheld"]);
  assert.deepEqual(core([{ ...outsideDiff, disposition: "apply" }], { answers: sentBack }), [], "applied: the maintainer's answer is met");
  assert.deepEqual(coreRun([{ ...outsideDiff, disposition: "apply" }], { answers: sentBack }).escalations, []);
  // An upheld deferral is still held to every rule a deferral is held to.
  assert.match(core([{ ...outsideDiff, remedyFiles: ["src/a.js"] }], { answers: upheld })[0], /^survived\[0\]: reason remedy-outside-diff needs a remedy file absent from the PR's diff/);
  assert.match(core([{ ...outsideDiff, issue: undefined }], { answers: upheld })[0], /^survived\[0\]: filing row 1 .* names none/);
  assert.match(core([{ ...outsideDiff, reason: "outside-ticket-files" }], { answers: upheld })[0], /^survived\[0\]: an in-scope survived finding deferred with reason "outside-ticket-files"/);
  // And an answer to a finding the record applies, or answers no deferral of, changes nothing.
  assert.deepEqual(core([{ ...outsideDiff, disposition: "apply" }], { answers: upheld }), []);
  assert.deepEqual(core([{ ...outsideDiff, reason: "mutual-exclusion" }], { answers: upheld }), []);
  // An answer to a finding the review does not hold is read by no entry.
  assert.deepEqual(coreRun([outsideDiff], { answers: answered(["survived[7]", "sent-back"]) }).violations, []);
});

// ---------------------------------------------------------------------------
// An escalating record with no ledger. src/b.js is outside the fixture PR's
// diff and both survivors are `important`, so a deferral with its remedy there
// escalates each of them; recording the maintainer's answers is the verb's.
// ---------------------------------------------------------------------------

test("with no ledger an escalating record exits 1, prints the escalation, and writes nothing", (t) => {
  const f = fixture(t);
  const own = seedOwnLedger(f);
  const ownBefore = readFileSync(own, "utf8");
  withSeverity(f, "critical");
  deferOutside(f, ["src/b.js"]);
  const r = standalone(f, "--no-ledger", "--review", f.reviewPath);
  escalated(r);
  assert.equal(r.json.token, null);
  assert.match(r.stderr, /^fix-pr-40: survived\[0\]: a critical finding deferred remedy-outside-diff, its remedy in src\/b\.js — the maintainer answers$/m);
  assert.equal(readFileSync(own, "utf8"), ownBefore);
});

// The core's review for the table: survived[0] on touched src/a.js:5;
// survived[1] a critical finding on untouched src/a.js:30; unverified[0] a
// finding whose refuters crashed; unverified[1] a suggestion on touched
// src/a.js:5, so in scope; unverified[2] a suggestion on an untouched line;
// refuted[0] the core's refuted finding.
const TABLE_SURVIVED = [{ file: "src/a.js", line: 5 }, { file: "src/a.js", line: 30, severity: "critical" }];
const TABLE_UNVERIFIED = [
  { file: "src/a.js", line: 9, severity: "important", refutersDispatched: 2 },
  { file: "src/a.js", line: 5, severity: "suggestion", refutersDispatched: 0 },
  { file: "src/a.js", line: 30, severity: "suggestion", refutersDispatched: 0 },
];
const REFUTED_V = "/scratch/pr40/fix-Ab12Cd34/2/verdict.json";
const STOOD_V = "/scratch/pr40/fix-Ab12Cd34/3/verdict.json";
// unverified[2]'s refuter verdicts: refuted, let survive, and one that
// decided nothing — a refuter that crashed before writing, or abstained.
const OUT_REFUTED_V = "/scratch/pr40/fix-Ab12Cd34/4/verdict.json";
const OUT_STOOD_V = "/scratch/pr40/fix-Ab12Cd34/5/verdict.json";
const OUT_UNDECIDED_V = "/scratch/pr40/fix-Ab12Cd34/6/verdict.json";
const TABLE_VERDICTS = {
  [REFUTED_V]: { refuted: true }, [STOOD_V]: { refuted: false }, [OUT_REFUTED_V]: { refuted: true }, [OUT_STOOD_V]: { refuted: false },
  [OUT_UNDECIDED_V]: { problem: "names no file that exists", undecided: true },
};
const OPEN_RFA = { state: "OPEN", title: "a deferred finding", labels: ["ready-for-agent"] };
const OPEN_NT = { state: "OPEN", title: "a deferred finding", labels: ["needs-triage"] };
const RECORD = { state: "CLOSED", title: "PR #40 review: the suggestion band, checked", labels: ["wontfix"] };
const closed = (issue) => ({ ...issue, state: "CLOSED" });
// Every finding of the table's review answered without a deferral, `entry`
// standing in for the one it names.
const tableRun = (entry, issues = {}, roles = IDENTITY) => {
  const fill = [
    { bucket: "survived", index: 0, scope: "in", claimKind: "behavior", disposition: "apply" },
    { bucket: "survived", index: 1, scope: "out", claimKind: "behavior", disposition: "apply" },
    { bucket: "unverified", index: 0, scope: "in", claimKind: "behavior", disposition: "apply" },
    { bucket: "unverified", index: 1, scope: "in", claimKind: "behavior", disposition: "apply", verdictPath: STOOD_V },
    { bucket: "unverified", index: 2, scope: "out", claimKind: "behavior", disposition: "apply", verdictPath: OUT_STOOD_V },
  ];
  const answered = fill.some((e) => e.bucket === entry.bucket && e.index === entry.index);
  return coreRun(answered ? fill.map((e) => (e.bucket === entry.bucket && e.index === entry.index ? entry : e)) : [...fill, entry],
    { survived: TABLE_SURVIVED, unverified: TABLE_UNVERIFIED, issues, verdicts: TABLE_VERDICTS, roles });
};
const tableCore = (entry, issues, roles) => tableRun(entry, issues, roles).violations.map(formatViolation);
const deferred = (bucket, index, more = {}) => ({ bucket, index, scope: "in", claimKind: "behavior", disposition: "defer", issue: 9, ...more });

test("filing row 7 outranks every row but row 4: a shape claim's deferral is filed to the closed record whatever its state", () => {
  for (const entry of [deferred("survived", 0, { claimKind: "shape", reason: "false-rationale" }), deferred("unverified", 0, { claimKind: "shape" }),
    deferred("unverified", 1, { claimKind: "shape", verdictPath: STOOD_V }), deferred("unverified", 2, { scope: "out", claimKind: "shape" }),
    deferred("survived", 1, { scope: "out", claimKind: "shape" }), deferred("survived", 1, { scope: "out", claimKind: "shape", reason: "false-rationale" }),
    deferred("refuted", 0, { scope: "out", claimKind: "shape", reason: "re-ran the probe" }),
    // Below the claim bar an out-of-scope suggestion gets no refuter, so a verdict it names anyway is never read.
    deferred("unverified", 2, { scope: "out", claimKind: "shape", verdictPath: OUT_REFUTED_V }),
    deferred("unverified", 2, { scope: "out", claimKind: "shape", verdictPath: "/elsewhere/verdict.json" })]) {
    assert.deepEqual(tableCore(entry, { 9: RECORD }), [], JSON.stringify(entry));
    assert.match(tableCore(entry, { 9: OPEN_NT })[0], /: filing row 7 \(/, JSON.stringify(entry));
    assert.match(tableCore(entry, { 9: OPEN_RFA })[0], /: filing row 7 \(/, JSON.stringify(entry));
  }
  // A refuted suggestion is row 4 whatever its claimKind; the home is the same.
  assert.match(tableCore(deferred("unverified", 1, { claimKind: "shape", verdictPath: REFUTED_V }), { 9: OPEN_NT })[0], /: filing row 4 \(/);
});

test("filing row 3 outranks row 6b: a crashed unverified finding is named row 3 though it is out of scope", () => {
  const entry = deferred("unverified", 0, { scope: "out" });
  assert.deepEqual(tableCore(entry, { 9: OPEN_NT }), []);
  assert.match(tableCore(entry, { 9: closed(OPEN_NT) })[0], /^unverified\[0\]: filing row 3 \(/);
  assert.match(tableCore(entry, { 9: RECORD })[0], /^unverified\[0\]: filing row 3 \(/);
});

test("an out-of-scope survivor is filed open needs-triage whatever its reason, and escalates nothing at any severity", () => {
  for (const reason of [undefined, "", "false-rationale", "mutual-exclusion", "remedy-worse", "remedy-outside-diff", "outside-ticket-files"]) {
    const r = tableRun(deferred("survived", 1, { scope: "out", reason }), { 9: OPEN_NT });
    assert.deepEqual([r.violations, r.escalations, r.unchecked], [[], [], []], String(reason));
  }
  // survived[1] is critical, and its remedy sits outside the diff: still no escalation.
  const r = tableRun(deferred("survived", 1, { scope: "out", reason: "remedy-outside-diff", remedyFiles: ["src/b.js"] }), { 9: OPEN_NT });
  assert.deepEqual([r.violations, r.escalations], [[], []]);
  // Declared out on a touched line it is in scope, so false-rationale is row 2's, not row 8's.
  assert.match(tableCore(deferred("survived", 0, { scope: "out", reason: "false-rationale" }), { 9: OPEN_NT })[0], /^survived\[0\]: filing row 2 \(/);
});

test("every open filing row is a needs-triage row: needs-triage or a triage-promoted ready-for-agent answers it, no triage label never does", () => {
  // No open row requires ready-for-agent: only triage sets it.
  assert.deepEqual(Object.keys(FILING_ROWS).filter((n) => FILING_ROWS[n].open && FILING_ROWS[n].open !== "needs-triage"), []);
  for (const entry of [deferred("survived", 0, { reason: "mutual-exclusion" }), deferred("unverified", 0),
    deferred("unverified", 1, { verdictPath: STOOD_V, reason: "remedy-worse" }),
    deferred("unverified", 2, { scope: "out", verdictPath: OUT_STOOD_V }),
    deferred("unverified", 2, { scope: "out", verdictPath: OUT_UNDECIDED_V }), deferred("survived", 1, { scope: "out" })]) {
    assert.deepEqual(tableCore(entry, { 9: OPEN_NT }), [], JSON.stringify(entry));
    assert.deepEqual(tableCore(entry, { 9: OPEN_RFA }), [], JSON.stringify(entry));
    assert.match(tableCore(entry, { 9: { ...OPEN_NT, labels: [] } })[0] ?? "",
      /: filing row (?:[1358]|6b) \(.*\): it belongs in an open issue labelled needs-triage or ready-for-agent, and #9 is open, titled "a deferred finding", labelled nothing$/, JSON.stringify(entry));
  }
});

test("a deferral no filing-table row holds is a mismatch naming no filing-table row, never a pass", () => {
  const reversed = deferred("refuted", 0, { scope: "out", reason: "re-ran the probe" });
  const rule = "refuted[0]: no filing-table row holds a deferred refuted finding, scope out, claimKind behavior — the table names no home for it";
  for (const home of [OPEN_RFA, OPEN_NT, RECORD]) assert.deepEqual(tableCore(reversed, { 9: home }), [rule], JSON.stringify(home));
  const { issue: _, ...unfiled } = reversed;
  assert.deepEqual(tableCore(unfiled), [rule]);
  // Applied, a reversed refutation is never filed, so no row is asked for.
  assert.deepEqual(tableCore({ ...reversed, disposition: "apply" }, { 9: closed(OPEN_NT) }), []);
});

test("a deferral that names no issue is a mismatch naming its row and home", () => {
  const { issue: _, ...entry } = deferred("unverified", 2, { scope: "out", verdictPath: OUT_STOOD_V });
  assert.deepEqual(tableCore(entry), [
    `unverified[2]: filing row 6b (${FILING_ROWS["6b"].finding}): a deferral names the issue it was filed to, and this entry names none — it belongs in an open issue labelled needs-triage or ready-for-agent`,
  ]);
});

test("an in-scope suggestion its refuter let survive defers only as row 1, for a reason other than false-rationale", () => {
  for (const reason of [undefined, "", "false-rationale", "outside-ticket-files"]) {
    const v = tableCore(deferred("unverified", 1, { verdictPath: STOOD_V, reason }), { 9: OPEN_RFA });
    assert.equal(v.length, 1, String(reason));
    assert.match(v[0], /^unverified\[1\]: filing row 5 \(an in-scope suggestion its refuter let survive\): deferred with .* — it is applied, or deferred as row 1, for mutual-exclusion, remedy-worse, remedy-outside-diff$/);
  }
  // remedy-outside-diff holds it to the remedy rule, and a suggestion escalates nothing.
  const r = tableRun(deferred("unverified", 1, { verdictPath: STOOD_V, reason: "remedy-outside-diff", remedyFiles: ["src/b.js"] }), { 9: OPEN_RFA });
  assert.deepEqual([r.violations, r.escalations], [[], []]);
  assert.match(tableCore(deferred("unverified", 1, { verdictPath: STOOD_V, reason: "remedy-outside-diff", remedyFiles: ["src/a.js"] }), { 9: OPEN_RFA })[0],
    /^unverified\[1\]: reason remedy-outside-diff needs a remedy file absent from the PR's diff/);
});

test("an in-scope suggestion needs refuter evidence whether applied or deferred; refuted, applying it breaks row 4", () => {
  for (const disposition of ["apply", "defer"]) {
    const { verdictPath: _, ...bare } = deferred("unverified", 1, { disposition });
    assert.deepEqual(tableCore(bare, { 9: RECORD }),
      ["unverified[1]: an in-scope suggestion carries no refuter evidence — its entry names no verdictPath; src/a.js:5 is a line the PR's diff touched, so it is in scope whatever its entry declares"]);
    assert.deepEqual(tableCore({ ...bare, verdictPath: "/scratch/pr40/fix-Ab12Cd34/9/nothing.json" }, { 9: RECORD }),
      ['unverified[1]: an in-scope suggestion carries no refuter evidence — verdictPath "/scratch/pr40/fix-Ab12Cd34/9/nothing.json" names no file that exists']);
  }
  // In scope by its entry alone: an untouched line declared in.
  assert.match(tableCore(deferred("unverified", 2), { 9: OPEN_NT })[0], /^unverified\[2\]: an in-scope suggestion carries no refuter evidence — its entry names no verdictPath; its entry declares scope in$/);
  // A finding with no refutersDispatched at all is a suggestion too.
  const r = coreRun([{ bucket: "survived", index: 0, scope: "in", claimKind: "behavior", disposition: "apply" }, deferred("unverified", 0)],
    { unverified: [{ file: "src/a.js", line: 5, severity: "suggestion" }] });
  assert.match(r.violations.map(formatViolation)[0], /^unverified\[0\]: an in-scope suggestion carries no refuter evidence/);
  assert.deepEqual(tableCore(deferred("unverified", 1, { disposition: "apply", verdictPath: REFUTED_V })), [
    `unverified[1]: filing row 4 (${FILING_ROWS[4].finding}): applied, though its verdict is refuted: true — it belongs in the closed "PR #40 review: the suggestion band, checked" issue, labelled wontfix`,
  ]);
  assert.deepEqual(tableCore(deferred("unverified", 1, { disposition: "apply", verdictPath: STOOD_V })), [], "row 5: applied");
});

test("an out-of-scope suggestion above the claim bar needs refuter evidence whether applied or deferred; applied, only one its refuter let survive passes", () => {
  const noEvidence = "unverified[2]: an out-of-scope suggestion alleging wrong behavior carries no refuter evidence — ";
  for (const disposition of ["apply", "defer"]) {
    const bare = deferred("unverified", 2, { scope: "out", disposition });
    assert.deepEqual(tableCore(bare, { 9: OPEN_NT }), [`${noEvidence}its entry names no verdictPath; claimKind behavior puts it above the claim bar`]);
    // A path that is no refuter's location is no evidence either, unlike a location whose refuter decided nothing.
    assert.deepEqual(tableCore({ ...bare, verdictPath: "/elsewhere/verdict.json" }, { 9: OPEN_NT }),
      [`${noEvidence}verdictPath "/elsewhere/verdict.json" names no file that exists`]);
  }
  assert.deepEqual(tableCore(deferred("unverified", 2, { scope: "out", disposition: "apply", verdictPath: OUT_REFUTED_V })), [
    `unverified[2]: filing row 6a (${FILING_ROWS["6a"].finding}): applied, though its verdict is refuted: true — it belongs in the closed "PR #40 review: the suggestion band, checked" issue, labelled wontfix`,
  ]);
  assert.deepEqual(tableCore(deferred("unverified", 2, { scope: "out", disposition: "apply", verdictPath: OUT_UNDECIDED_V })), [
    `unverified[2]: filing row 6b (${FILING_ROWS["6b"].finding}): applied, though its refuter decided nothing — verdictPath "${OUT_UNDECIDED_V}" names no file that exists; it belongs in an open issue labelled needs-triage or ready-for-agent`,
  ]);
  assert.deepEqual(tableCore(deferred("unverified", 2, { scope: "out", disposition: "apply", verdictPath: OUT_STOOD_V })), [], "applied, its refuter let it survive");
  // Out of scope it defers for any reason: row 1's reasons hold an in-scope suggestion only.
  for (const reason of [undefined, "", "false-rationale", "outside-ticket-files"]) {
    for (const verdictPath of [OUT_STOOD_V, OUT_UNDECIDED_V]) {
      assert.deepEqual(tableCore(deferred("unverified", 2, { scope: "out", verdictPath, reason }), { 9: OPEN_NT }), [], `${reason} ${verdictPath}`);
    }
  }
  // Declared out on a touched line it is in scope, and held to the in-scope rule.
  assert.match(tableCore(deferred("unverified", 1, { scope: "out" }), { 9: OPEN_NT })[0], /^unverified\[1\]: an in-scope suggestion carries no refuter evidence/);
});

test("what the filing check never reads: an applied finding, a crashed finding or an out-of-scope suggestion below the claim bar applied, a reversed refutation applied", () => {
  const filing = { pr: 40, roles: IDENTITY, issue: () => assert.fail("the tracker was read"), verdict: () => assert.fail("a verdict was read") };
  const entries = [
    { bucket: "survived", index: 0, scope: "in", claimKind: "behavior", disposition: "apply", issue: 9 },
    { bucket: "survived", index: 1, scope: "out", claimKind: "behavior", disposition: "apply", issue: 9 },
    { bucket: "unverified", index: 0, scope: "in", claimKind: "behavior", disposition: "apply", issue: 9 },
    { bucket: "unverified", index: 1, scope: "out", claimKind: "shape", disposition: "apply", issue: 9 },
    { bucket: "refuted", index: 0, scope: "out", claimKind: "behavior", disposition: "apply", reason: "re-ran the probe", issue: 9 },
  ];
  const r = checkDispositions({
    review: { head: H40, survived: [{ file: "src/a.js", line: 5 }, { file: "src/a.js", line: 30 }], refuted: [{ file: "src/b.js", line: 1 }],
      unverified: [TABLE_UNVERIFIED[0], TABLE_UNVERIFIED[2]] },
    record: { head: H40, entries }, touched: new Map([["src/a.js", new Set([5])]]), diffFiles: ["src/a.js"], roots: [], filing,
  });
  assert.deepEqual([r.violations, r.escalations, r.unchecked], [[], [], []]);
});

test("remapped, a home labelled triage is accepted for a needs-triage row, and the role names refused", () => {
  const open = deferred("survived", 0, { reason: "mutual-exclusion" });
  const band = deferred("survived", 0, { reason: "false-rationale" });
  assert.equal(FILING_ROWS[1].open, "needs-triage", "the table keeps the role");
  const home = (...labels) => ({ state: "OPEN", title: "a deferred finding", labels });
  assert.deepEqual(tableCore(open, { 9: home("triage") }, REMAP), []);
  // A stronger label answers the row too, in its mapped spelling.
  assert.deepEqual(tableCore(open, { 9: home("agent-ready") }, REMAP), []);
  // What the map does not name is not a triage label, whatever the role is called.
  assert.match(tableCore(open, { 9: home("needs-triage") }, REMAP)[0],
    /: it belongs in an open issue labelled triage or agent-ready, and #9 is open, titled "a deferred finding", labelled needs-triage$/);
  assert.match(tableCore(open, { 9: home("ready-for-agent") }, REMAP)[0], /labelled ready-for-agent$/);
  assert.deepEqual(tableCore(band, { 9: { ...RECORD, labels: ["wont-fix"] } }, REMAP), []);
  assert.match(tableCore(band, { 9: RECORD }, REMAP)[0],
    /: it belongs in the closed "PR #40 review: the suggestion band, checked" issue, labelled wont-fix, and #9 is closed, titled .*, labelled wontfix$/);
});

test("remapped, an applied suggestion its refuter refuted, or decided nothing about, names its home in the mapped strings", () => {
  assert.deepEqual(tableCore(deferred("unverified", 1, { disposition: "apply", verdictPath: REFUTED_V }), {}, REMAP), [
    `unverified[1]: filing row 4 (${FILING_ROWS[4].finding}): applied, though its verdict is refuted: true — it belongs in the closed "PR #40 review: the suggestion band, checked" issue, labelled wont-fix`,
  ]);
  assert.deepEqual(tableCore(deferred("unverified", 2, { scope: "out", disposition: "apply", verdictPath: OUT_UNDECIDED_V }), {}, REMAP), [
    `unverified[2]: filing row 6b (${FILING_ROWS["6b"].finding}): applied, though its refuter decided nothing — verdictPath "${OUT_UNDECIDED_V}" names no file that exists; it belongs in an open issue labelled triage or agent-ready`,
  ]);
  // Applied, a suggestion its refuter let survive is no violation under the map either.
  assert.deepEqual(tableCore(deferred("unverified", 1, { disposition: "apply", verdictPath: STOOD_V }), {}, REMAP), []);
});

test("remapped, a deferral that names no issue names its home in the mapped strings", () => {
  const { issue: _open, ...open } = deferred("unverified", 2, { scope: "out", verdictPath: OUT_STOOD_V });
  assert.deepEqual(tableCore(open, {}, REMAP), [
    `unverified[2]: filing row 6b (${FILING_ROWS["6b"].finding}): a deferral names the issue it was filed to, and this entry names none — it belongs in an open issue labelled triage or agent-ready`,
  ]);
  const { issue: _record, ...record } = deferred("survived", 0, { reason: "false-rationale" });
  assert.deepEqual(tableCore(record, {}, REMAP), [
    `survived[0]: filing row 2 (${FILING_ROWS[2].finding}): a deferral names the issue it was filed to, and this entry names none — it belongs in the closed "PR #40 review: the suggestion band, checked" issue, labelled wont-fix`,
  ]);
});

test("run as a CLI with no Label map, nothing is judged or written, and the refusal names ensure", (t) => {
  const f = fixture(t, { labelMap: null });
  f.writeRecord(f.baseEntries());
  const log = join(f.dir, "gh.log");
  const r = spawnSync(process.execPath, [SCRIPT, "--member", "fix-pr-40", "--scratch", f.scratch, "--no-ledger", "--review", f.reviewPath],
    { encoding: "utf8", env: f.env(cleanEnv(), { FAKE_GH_LOG: log }), cwd: f.repo });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /dispositions-check: .*Label map.*label-map\.mjs ensure/);
  assert.equal(r.stdout, "");
  assert.equal(existsSync(log), false, "the tracker was never asked");
});

test("an issue the tracker cannot answer leaves that filing unchecked, never a violation", () => {
  const r = tableRun(deferred("unverified", 2, { scope: "out", verdictPath: OUT_STOOD_V }), { 9: { problem: "error connecting to api.github.com" } });
  assert.deepEqual(r.violations, []);
  assert.deepEqual(r.unchecked, [{ bucket: "unverified", index: 2, issue: 9, problem: "error connecting to api.github.com" }]);
});

test("verdictProblem holds a refuter verdict to its schema", () => {
  assert.equal(verdictProblem({ refuted: true, reason: "r" }), null);
  assert.equal(verdictProblem({ refuted: false, reason: "", counter_evidence: "ran x" }), null);
  for (const [value, problem] of [
    [null, "is not a JSON object"], [[], "is not a JSON object"], ["refuted", "is not a JSON object"],
    [{ reason: "r" }, "has no refuted"], [{ refuted: true }, "has no reason"],
    [{ refuted: "true", reason: "r" }, "has a refuted that is not a boolean"], [{ refuted: true, reason: 1 }, "has a reason that is not a string"],
    [{ refuted: true, reason: "r", verdict: "survived" }, "carries verdict, which a refuter verdict does not"],
  ]) assert.equal(verdictProblem(value), problem, JSON.stringify(value));
});

// #2881 gave the review's refuter an abstain flag in the shared schema. The
// fix-applier's suggestion refuter has no abstain channel in the
// disposition record, so a verdict file that abstains is no evidence a
// refuter decided the finding — refused, as an unknown key was before the flag
// existed — while one that says `inconclusive: false` decided it as usual.
test("a suggestion's verdict file that abstains is no refuter evidence; one that decided still is", () => {
  assert.equal(verdictProblem({ refuted: false, reason: "r", inconclusive: false }), null);
  assert.equal(
    verdictProblem({ refuted: false, reason: "r", inconclusive: true }),
    "is inconclusive — its refuter abstained, so it decided nothing about the finding",
  );
  assert.equal(verdictProblem({ refuted: false, reason: "r", inconclusive: "yes" }), "has a inconclusive that is not a boolean");
});

// The CLI against the stubbed tracker.

test("with no ledger an issue gh cannot read is unchecked, a broken rule outranks it, and the exit status says so", (t) => {
  const f = fixture(t);
  const entries = f.baseEntries();
  entries[2] = { ...entries[2], issue: 404 };
  f.writeRecord(entries);
  const r = standalone(f, "--no-ledger", "--review", f.reviewPath);
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.json.verdict, "unchecked", r.stderr);
  assert.equal(r.json.token, null);
  assert.match(r.stderr, /unverified\[0\]: where it was filed is unchecked — #404 could not be read through gh: GraphQL: Could not resolve to an issue/);

  entries[0] = f.entry("survived", 0, { disposition: "defer" });
  f.writeRecord(entries);
  const broken = spawnSync(process.execPath, [SCRIPT, "--member", "fix-pr-40", "--scratch", f.scratch, "--no-ledger", "--review", f.reviewPath],
    { encoding: "utf8", env: f.env(cleanEnv(), { FAKE_GH_DOWN: "1" }), cwd: f.repo });
  assert.equal(broken.status, 1, broken.stderr);
  assert.equal(JSON.parse(broken.stdout).verdict, "mismatch");
  assert.match(broken.stderr, /^fix-pr-40: survived\[0\]: an in-scope survived finding deferred with no reason/m);
  assert.match(broken.stderr, /unverified\[0\]: where it was filed is unchecked/);

  f.writeRecord(f.baseEntries());
  const alone = spawnSync(process.execPath, [SCRIPT, "--member", "fix-pr-40", "--scratch", f.scratch, "--no-ledger", "--review", f.reviewPath],
    { encoding: "utf8", env: f.env(cleanEnv(), { FAKE_GH_DOWN: "1" }), cwd: f.repo });
  assert.equal(alone.status, 1, alone.stderr);
  assert.deepEqual([JSON.parse(alone.stdout).verdict, JSON.parse(alone.stdout).token], ["unchecked", null]);
});

const uncharged = ({ charge: _c, chargeReason: _r, ...rest }) => rest;
const BAND = { state: "CLOSED", title: recordTitle(40), labels: ["wontfix"] };
const TRIAGE = { state: "OPEN", title: "a deferred finding", labels: ["needs-triage"] };
const REVERSED = { bucket: "refuted", index: 0, scope: "in", claimKind: "behavior", disposition: "apply", reason: "re-ran the probe; it reproduces" };
const NONE = { charge: "none", chargeReason: "defect-outside-acceptance" };
// survived[0] on touched src/a.js:5; survived[1] on untouched src/a.js:12.
const TWO = [{ file: "src/a.js", line: 5 }, { file: "src/a.js", line: 12 }];
const outOfScope = (more) => ({ bucket: "survived", index: 1, scope: "out", claimKind: "behavior", disposition: "defer", issue: 81, ...more });
const charged = (entries, opts = {}) => core(entries, { survived: TWO, issues: { 81: TRIAGE }, charges: true, ...opts });

test("on the first review's record a survived entry with no Charge is a mismatch naming it; each Charge passes it", () => {
  assert.deepEqual(charged([applied, outOfScope(NONE)]), [
    "survived[0]: a finding that stands on the PR's first review carries a Charge, and this entry carries none — charge it false-claim, unmet, both, or none with a chargeReason",
  ]);
  for (const charge of ["false-claim", "unmet", "both"]) assert.deepEqual(charged([{ ...applied, charge }, outOfScope(NONE)]), [], charge);
  for (const chargeReason of ["defect-outside-acceptance", "not-the-implementers-text", "claim-about-untouched-code"]) {
    assert.deepEqual(charged([{ ...applied, charge: "none", chargeReason }, outOfScope(NONE)]), [], chargeReason);
  }
});

test("a survived entry deferred false-rationale, and an unverified entry, need no Charge", () => {
  const rationale = { ...applied, disposition: "defer", reason: "false-rationale", issue: 13 };
  const crashed = { bucket: "unverified", index: 0, scope: "in", claimKind: "behavior", disposition: "defer", issue: 81 };
  assert.deepEqual(core([rationale, crashed], {
    unverified: [{ file: "src/a.js", line: 5, refutersDispatched: 2 }], issues: { 13: BAND, 81: TRIAGE }, charges: true,
  }), []);
});

test("a survived entry applied, though its reason says false-rationale, still stands and needs a Charge", () => {
  assert.deepEqual(charged([{ ...applied, reason: "false-rationale" }, outOfScope(NONE)]), [
    "survived[0]: a finding that stands on the PR's first review carries a Charge, and this entry carries none — charge it false-claim, unmet, both, or none with a chargeReason",
  ]);
  assert.deepEqual(charged([{ ...applied, ...NONE, reason: "false-rationale" }, outOfScope(NONE)]), []);
});

test("a refuted entry, a reversal, with no Charge is refused; charged, it passes", () => {
  assert.deepEqual(core([{ ...applied, ...NONE }, REVERSED], { charges: true }), [
    "refuted[0]: a finding that stands on the PR's first review carries a Charge, and this entry carries none — charge it false-claim, unmet, both, or none with a chargeReason",
  ]);
  assert.deepEqual(core([{ ...applied, ...NONE }, { ...REVERSED, charge: "false-claim" }], { charges: true }), []);
});

test("an entry scoped out is charged none: false-claim, unmet or both is refused, none with a reason passes", () => {
  for (const charge of ["false-claim", "unmet", "both"]) {
    assert.deepEqual(charged([{ ...applied, ...NONE }, outOfScope({ charge })]), [
      `survived[1]: an out-of-scope finding counts for nothing, so it is charged none, and this one is charged ${charge}`,
    ], charge);
  }
  assert.deepEqual(charged([{ ...applied, ...NONE }, outOfScope({ charge: "none", chargeReason: "claim-about-untouched-code" })]), []);
  // Declared out on a line the diff touched, it is in scope, so a Charge of its own is no refusal.
  assert.deepEqual(charged([{ ...applied, scope: "out", charge: "false-claim" }, outOfScope(NONE)]), []);
});

test("a Charge of none with no reason, a reason outside the three, an unknown Charge, or a chargeReason with no Charge is refused", () => {
  assert.deepEqual(charged([{ ...applied, charge: "none" }, outOfScope(NONE)]), [
    "survived[0]: a Charge of none names its chargeReason, one of defect-outside-acceptance, not-the-implementers-text, claim-about-untouched-code, and this one names none",
  ]);
  assert.deepEqual(charged([{ ...applied, charge: "none", chargeReason: "fixed" }, outOfScope(NONE)]), [
    'survived[0]: malformed entry — chargeReason "fixed" is not one of defect-outside-acceptance|not-the-implementers-text|claim-about-untouched-code',
  ]);
  assert.deepEqual(charged([{ ...applied, charge: "answered" }, outOfScope(NONE)]), [
    'survived[0]: malformed entry — charge "answered" is not one of false-claim|unmet|both|none',
  ]);
  assert.deepEqual(charged([{ ...applied, charge: "unmet", chargeReason: "defect-outside-acceptance" }, outOfScope(NONE)]), [
    "survived[0]: chargeReason gives the reason for a Charge of none, and this entry is charged unmet",
  ]);
  assert.deepEqual(charged([{ ...applied, chargeReason: "defect-outside-acceptance" }, outOfScope(NONE)]), [
    "survived[0]: chargeReason gives the reason for a Charge of none, and this entry carries no charge",
  ]);
});

test("off the first review's record no Charge is required, and one that is carried is still judged", () => {
  assert.deepEqual(charged([applied, outOfScope({})], { charges: false }), []);
  assert.deepEqual(charged([{ ...applied, charge: "none" }, outOfScope({})], { charges: false }), [
    "survived[0]: a Charge of none names its chargeReason, one of defect-outside-acceptance, not-the-implementers-text, claim-about-untouched-code, and this one names none",
  ]);
  assert.deepEqual(charged([{ ...applied, chargeReason: "defect-outside-acceptance" }, outOfScope({})], { charges: false }), [
    "survived[0]: chargeReason gives the reason for a Charge of none, and this entry carries no charge",
  ]);
});

test("a record checked with no ledger needs no Charge", (t) => {
  const f = fixture(t);
  f.writeRecord(f.baseEntries().map(uncharged));
  okVerdict(standalone(f, "--no-ledger", "--review", f.reviewPath));
});
