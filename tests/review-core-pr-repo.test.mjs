// #3494. The review snapshot cuts its tree from `worktree` but used to read the
// PR through `gh` commands that take their repository from the inherited working
// directory. A snapshot agent starts in the CONTROLLER's checkout, so a review
// of a PR in repository A dispatched from repository B's checkout read whichever
// PR in B shared the number: `pr.diff`, `diffStats` and the `refHead` branch
// lookup described another PR, and nothing in the payload said so. `refHead`
// went empty, which `snapshotMissing` reads as "head check SKIPPED".
//
// Six call sites read the PR: `gh pr diff`, the four `gh pr view` reads (three
// fields, then the body and commits), and `diff-stats.mjs --pr`. Each has to name the worktree's own repository, so
// each is pinned on its own below — a pin on the first `gh pr diff` line alone
// would stay green while any of the other five reverted.
//
// Two halves, for the reason snapshot-repo.test.mjs gives: the source-text pins
// name the six sites; the executed cases run the block's own lines, lifted from
// review-core.mjs, from a working directory that is a DIFFERENT repository from
// the worktree's, against a `gh` that answers for the cwd's repository whenever
// it is not told otherwise. The lagging-`prHead` admission (#1513) is not touched
// here — review-core-snapshot-path.test.mjs still owns it.
//
// Zero deps: `node --test tests/review-core-pr-repo.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripComments } from "./support/strip-comments.mjs";
import { Pin } from "./support/prose-pin.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { ARGS, SNAP, parallel, pipeline, review, scriptedHost } from "./support/review-host-fixture.mjs";
import { runReview, SNAPSHOT_SCHEMA } from "../plugin/scripts/review-core.mjs";

const SOURCE = readFileSync(join(import.meta.dirname, "..", "plugin", "scripts", "review-core.mjs"), "utf8");
const CODE = stripComments(SOURCE);
const SNAPSHOT = Pin.of(CODE, "CODE").between("const snap = await agent(", "if (snap) {", "review-core.mjs").text;

const ENV = {
  ...process.env,
  GIT_DIR: undefined,
  GIT_WORK_TREE: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_TEMPLATE_DIR: undefined,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { env: ENV, encoding: "utf8" }).trim();

function scratch(t, prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// --- source-text pins: one per call site -----------------------------------

const lineOf = (re) => {
  const hits = SNAPSHOT.split("\n").filter((l) => re.test(l));
  assert.equal(hits.length, 1, `expected exactly one snapshot-prompt line matching ${re}, found ${hits.length}`);
  return hits[0];
};

const NAMED = /-R "\$REPO"/;

for (const [name, re] of [
  ["gh pr diff", /gh pr diff \$\{pr\}/],
  ["gh pr view isCrossRepository", /gh pr view \$\{pr\}.*--json isCrossRepository/],
  ["gh pr view headRefName", /gh pr view \$\{pr\}.*--json headRefName/],
  ["gh pr view headRefOid", /gh pr view \$\{pr\}.*--json headRefOid/],
  ["gh pr view body,commits", /gh pr view \$\{pr\}.*--json body,commits/],
]) {
  test(`snapshot prompt: \`${name}\` names the worktree's repository, not the cwd's`, () => {
    assert.match(lineOf(re), NAMED, `\`${name}\` carries no -R "$REPO" — it reads the PR from the controller's cwd repository (#3494)`);
  });
}

test("snapshot prompt: the sizing script is told the worktree's repository", () => {
  assert.match(
    lineOf(/fleet-run diff-stats\.mjs --pr \$\{pr\}/),
    /--repo "\$REPO"/,
    'diff-stats.mjs is invoked with no --repo "$REPO" — it sizes the cwd repository\'s PR of the same number (#3494)',
  );
});

test("snapshot prompt: every line of the snapshot prompt that opens a `gh` call is one of the five PR reads pinned above", () => {
  const ghLines = SNAPSHOT.split("\n").filter((l) => /^\s*(?:\w+=\$\()?gh /.test(l));
  assert.equal(ghLines.length, 5, `a new unpinned \`gh\` read joined the snapshot block:\n${ghLines.join("\n")}`);
  for (const l of ghLines) assert.match(l, NAMED, `an unanchored gh read: ${l}`);
});

// #3510 review: the raw `git remote get-url origin` URL was the first shape
// here, and `-R` does not run it through gh's ssh-config alias translation —
// measured, `gh pr view 3510 -R git@gh-alias:feigi/fleet-plugin.git` fails
// with `error connecting to gh-alias`, while `gh repo view` run inside a
// checkout with that origin answers `https://github.com/feigi/fleet-plugin`.
// So REPO is gh's own answer from inside the worktree, which also leaves out
// any credentials the remote URL carries.
test("snapshot prompt: the repository is the one gh resolves inside the worktree, never the cwd", () => {
  const derivations = SNAPSHOT.split("\n").filter((l) => /REPO=\$\(/.test(l));
  assert.ok(derivations.length >= 2, "the capture block and the sizing block each derive $REPO themselves — the sizing step is a separate shell command");
  for (const l of derivations) {
    assert.match(l, /^\s*REPO=\$\((?: \{ )?cd \$\{worktree\} && gh repo view --json url -q \.url[; ]/, `REPO is not gh's answer from inside the worktree: ${l}`);
  }
});

// #3510 review: the executed cases below prove the blocks PRINT the marker;
// nothing proved the agent is told what the marker means, and deleting either
// instruction stayed green. An agent that is not told to omit the fields the
// skipped reads would have filled is free to fill them some other way.
test("snapshot prompt: SNAPSHOT_REPO_UNRESOLVED tells the agent to omit every field the skipped reads fill", () => {
  const B = "\\\\?`";
  const f = (name) => `${B}${name}${B}`;
  assert.match(
    SNAPSHOT,
    new RegExp(`If\\s+the\\s+block\\s+printed\\s+SNAPSHOT_REPO_UNRESOLVED[^]*?Omit\\s+${f("diffPath")},\\s+${f("diffLines")},\\s+${f("messagesPath")},\\s+${f("refHead")}\\s+and\\s+${f("prHead")}`),
    "the capture block's marker no longer tells the agent to omit the diff fields",
  );
  assert.match(SNAPSHOT, new RegExp(`If\\s+that\\s+printed\\s+SNAPSHOT_REPO_UNRESOLVED,\\s+omit\\s+${f("diffStats")}`), "the sizing block's marker no longer tells the agent to omit diffStats");
});

// --- executed cases ---------------------------------------------------------

/** The lines from `from` up to and including the line matching `to`, as the shell would see them. */
function lift(from, to) {
  const start = CODE.search(from);
  assert.ok(start !== -1, `${from} is gone from review-core.mjs — the block was reshaped past what this test lifts`);
  const rest = CODE.slice(start);
  const end = rest.search(to);
  assert.ok(end !== -1, `${to} no longer closes the block that starts at ${from}`);
  return rest.slice(0, rest.indexOf("\n", end));
}

const render = (block, worktree, pr) => new Function("worktree", "pr", "return `" + block + "`")(worktree, pr);

// A `gh` that answers for the CWD's repository unless it is told a repository
// with `-R`, the resolution rule the real one has (measured: `gh pr view 1
// -R <git@host:o/r.git>` reads that repository; with no -R it reads the cwd's).
// `gh repo view` answers from the cwd's own origin, as the real one resolves a
// checkout's remotes, behind a `resolved:` prefix so a value that never went
// through it — the raw remote URL — cannot pass for one that did; with no
// remote it fails the way the real one does. `bodyFails` makes the body read
// fail the way a rate-limited one does: an error on stderr, nothing on stdout,
// exit 1. Every call is logged, one line of args per call, so "no gh ran" is a
// count.
function ghStub(t, { bodyFails = false } = {}) {
  const dir = scratch(t, "pr-repo-bin-");
  const log = join(dir, "gh.log");
  const body = `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(log)}
named=
prev=
for a in "$@"; do
  [ "$prev" = "-R" ] && named="$a"
  prev="$a"
done
if [ -n "$named" ]; then who=RIGHT; else who=WRONG; fi
case "$*" in
  "repo view"*)
    url=$(git remote get-url origin 2>/dev/null) || { echo "no git remotes found" >&2; exit 1; }
    echo "resolved:$url" ;;
  "pr diff"*) printf 'diff --git a/%s.txt b/%s.txt\\n' "$who" "$who" ;;
  *isCrossRepository*) echo false ;;
  *body,commits*) ${bodyFails ? "echo 'rate limited' >&2; exit 1" : `printf 'body-%s\\n' "$who"`} ;;
  *headRefName*) echo "branch-$who" ;;
  *headRefOid*) echo "oid-$who" ;;
  *) exit 9 ;;
esac
`;
  writeExecStub(join(dir, "gh"), body);
  return { dir, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

/** A worktree whose origin is a local bare repo carrying `refs/heads/branch-RIGHT`, plus an unrelated repository to stand in as cwd. */
function fixture(t, { withOrigin = true } = {}) {
  const origin = scratch(t, "pr-repo-origin-");
  git(origin, "init", "-q", "--bare");
  const worktree = scratch(t, "pr-repo-wt-");
  git(worktree, "init", "-q");
  writeFileSync(join(worktree, "a.txt"), "a\n");
  git(worktree, "add", "-A");
  git(worktree, "-c", "user.name=f", "-c", "user.email=f@invalid", "commit", "-q", "-m", "fixture");
  const sha = git(worktree, "rev-parse", "HEAD");
  if (withOrigin) {
    git(worktree, "remote", "add", "origin", origin);
    git(worktree, "push", "-q", "origin", "HEAD:refs/heads/branch-RIGHT");
  }
  const cwd = scratch(t, "pr-repo-cwd-");
  git(cwd, "init", "-q");
  git(cwd, "remote", "add", "origin", "https://other.example.com/unrelated/repo.git");
  const run = scratch(t, "pr-repo-run-");
  return { origin, worktree, sha, cwd, run };
}

const PR = 1270;
// Anchored on the `REPO=$(` line whatever it runs, so a block whose derivation
// regressed is still lifted and executed, and fails a named test below rather
// than this file's lift.
const CAPTURE = lift(/^ *REPO=\$\(.*\n *if \[ -n "\$REPO" \]; then\n *gh pr diff/m, /^ *fi$/m);
const SIZING = lift(/^ *REPO=\$\(.*\n *if \[ -n "\$REPO" \]; then ~\/\.fleet\/bin\/fleet-run diff-stats/m, /; fi$/m);
const prCalls = (gh) => gh.calls().filter((c) => c.startsWith("pr "));

function runBlock(block, { worktree, run, cwd, bin, home }) {
  const r = spawnSync("sh", ["-c", `RUN=${JSON.stringify(run)}\n${render(block, worktree, PR)}`], {
    cwd,
    env: { ...ENV, HOME: home ?? ENV.HOME, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
  return { out: r.stdout.trim().split("\n").map((l) => l.trim()), err: r.stderr, status: r.status };
}

test("capture block: dispatched from an unrelated repository, every PR read names the worktree's repository and reads the right PR", (t) => {
  const f = fixture(t);
  const gh = ghStub(t);
  const r = runBlock(CAPTURE, { ...f, bin: gh.dir });
  assert.equal(r.status, 0, r.err);
  // ref (from the branch the RIGHT pr named), then headRefOid, then wc -l.
  assert.deepEqual(r.out, [f.sha, "oid-RIGHT", "1"], r.err);
  assert.match(readFileSync(join(f.run, "pr.diff"), "utf8"), /RIGHT\.txt/);
  const calls = prCalls(gh);
  assert.equal(calls.length, 5, `diff + body/commits + three field reads: ${calls.join(" | ")}`);
  for (const c of calls) assert.ok(c.includes(`-R resolved:${f.origin}`), `a gh call did not name the repository gh resolved inside the worktree: ${c}`);
});

test("capture block: with no origin remote nothing runs against the cwd's repository and the block says why", (t) => {
  const f = fixture(t, { withOrigin: false });
  const gh = ghStub(t);
  const r = runBlock(CAPTURE, { ...f, bin: gh.dir });
  assert.deepEqual(r.out, ["SNAPSHOT_REPO_UNRESOLVED", "no git remotes found"], r.err);
  assert.deepEqual(prCalls(gh), [], "a gh pr read ran with no repository to name — it read the cwd's");
  assert.equal(existsSync(join(f.run, "pr.diff")), false, "a diff file exists for a capture that never ran");
  assert.equal(existsSync(join(f.run, "pr-messages.md")), false, "a messages file exists for a capture that never ran");
});

// The bodies are read ONCE, in the block that writes `pr.diff`, so an edit made
// after the review began cannot reach what the review read: the file is the
// only copy, and the block neither re-reads nor rewrites it.
test("capture block: the PR body and commit messages are saved once, beside the diff, from the right PR", (t) => {
  const f = fixture(t);
  const gh = ghStub(t);
  const r = runBlock(CAPTURE, { ...f, bin: gh.dir });
  assert.equal(r.status, 0, r.err);
  const reads = () => gh.calls().filter((c) => c.includes("--json body,commits"));
  assert.equal(reads().length, 1, `the bodies were read more than once: ${reads().join(" | ")}`);
  assert.equal(readFileSync(join(f.run, "pr-messages.md"), "utf8"), "body-RIGHT\n");
});

// A redirect creates its file before the command runs, so a failed body read
// would leave an empty pr-messages.md — a clean body to the comments dimension —
// and the block's own output and exit status are the same as a success's. The
// block removes the file and prints a marker instead, so the failure shows.
test("capture block: a failed body read leaves no messages file and prints SNAPSHOT_MESSAGES_FAILED", (t) => {
  const f = fixture(t);
  const gh = ghStub(t, { bodyFails: true });
  const r = runBlock(CAPTURE, { ...f, bin: gh.dir });
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.out, ["SNAPSHOT_MESSAGES_FAILED", f.sha, "oid-RIGHT", "1"], r.err);
  assert.equal(existsSync(join(f.run, "pr-messages.md")), false, "a failed body read left a messages file behind");
  assert.match(readFileSync(join(f.run, "pr.diff"), "utf8"), /RIGHT\.txt/, "the diff read was lost with the body read");
});

test("snapshot prompt: SNAPSHOT_MESSAGES_FAILED tells the agent to omit messagesPath", () => {
  assert.match(SNAPSHOT, /Report\s+\\?`messagesPath\\?`\s+=\s+the\s+SNAPSHOT_RUN_ROOT\s+value\s+with\s+'\/pr-messages\.md'\s+appended,\s+ONLY\s+if\s+the\s+block\s+printed\s+no\s+SNAPSHOT_MESSAGES_FAILED\s+line/);
});

test("capture block: the jq expression renders the PR body, then each commit's sha, headline and body", (t) => {
  const f = fixture(t);
  const rendered = render(CAPTURE, f.worktree, PR);
  const expr = /--json body,commits -q '([^']*)' > "\$RUN"\/pr-messages\.md/.exec(rendered)?.[1];
  assert.ok(expr, "the body read's -q expression is gone or no longer single-quoted on one line");
  assert.ok(!expr.includes("\n"), "a real newline inside the expression: the shell would hand jq a broken program");
  const input = {
    body: "line one\nline two",
    commits: [
      { oid: "a".repeat(40), messageHeadline: "feat: first", messageBody: "first body" },
      { oid: "b".repeat(40), messageHeadline: "fix: second", messageBody: "" },
    ],
  };
  const r = spawnSync("jq", ["-r", expr], { input: JSON.stringify(input), encoding: "utf8" });
  if (r.error?.code === "ENOENT") return t.skip("jq is not installed");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(
    r.stdout,
    ["=== PR body ===", "line one", "line two", `=== commit ${"a".repeat(40)} ===`, "feat: first", "first body", `=== commit ${"b".repeat(40)} ===`, "fix: second", "", "", ""].join("\n"),
  );
  // A PR with no body and no commit body must not turn `null` into text.
  const empty = spawnSync("jq", ["-r", expr], { input: JSON.stringify({ body: null, commits: [] }), encoding: "utf8" });
  assert.equal(empty.stdout, "=== PR body ===\n\n\n");
});

test("sizing block: dispatched from an unrelated repository, diff-stats is handed the worktree's repository", (t) => {
  const f = fixture(t);
  const home = scratch(t, "pr-repo-home-");
  mkdirSync(join(home, ".fleet", "bin"), { recursive: true });
  const log = join(home, "fleet-run.log");
  writeExecStub(join(home, ".fleet", "bin", "fleet-run"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 3\n`);
  const gh = ghStub(t);
  const r = runBlock(SIZING, { ...f, bin: gh.dir, home });
  assert.equal(r.status, 3, "the sizing script's own exit status must survive the block — fail-closed");
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n"), [`diff-stats.mjs --pr ${PR} --repo resolved:${f.origin}`]);
});

test("sizing block: with no origin remote the script is never run and the block says so", (t) => {
  const f = fixture(t, { withOrigin: false });
  const home = scratch(t, "pr-repo-home-");
  mkdirSync(join(home, ".fleet", "bin"), { recursive: true });
  const log = join(home, "fleet-run.log");
  writeExecStub(join(home, ".fleet", "bin", "fleet-run"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\n`);
  const r = runBlock(SIZING, { ...f, bin: ghStub(t).dir, home });
  assert.deepEqual(r.out, ["SNAPSHOT_REPO_UNRESOLVED"], r.err);
  assert.equal(existsSync(log), false, "diff-stats ran with no repository to name — it would read the cwd's");
});

// #3510 review: an unresolvable repository used to leave the review running
// with no diff and no sizing while the controller's `no diff` line named no
// cause. The block now prints gh's reason after the marker, the agent reports
// it as `repoUnresolved`, and the controller logs it on that line.
test("an unresolved repository's reason is a declared optional field and reaches the controller's no-diff log line", async () => {
  assert.deepEqual(SNAPSHOT_SCHEMA.properties.repoUnresolved, { type: "string" }, "repoUnresolved is not declared — additionalProperties:false drops it");
  assert.ok(!SNAPSHOT_SCHEMA.required.includes("repoUnresolved"), "repoUnresolved is required — a resolved repository has nothing to report there");
  assert.match(SNAPSHOT, /Report\s+\\?`repoUnresolved\\?`\s*=\s*every\s+line\s+the\s+block\s+printed\s+after\s+SNAPSHOT_REPO_UNRESOLVED/);
  const why = "none of the git remotes configured for this repository point to a known GitHub host";
  const run = scriptedHost({ snapshot: [{ ...SNAP, repoUnresolved: `${why}\n` }], "review:correctness": [review([])] });
  const lines = [];
  await runReview({ ...run.host, log: (m) => lines.push(m), pipeline, parallel }, { ...ARGS, dimensions: ["correctness"] });
  const noDiff = lines.filter((l) => l.startsWith("no diff"));
  assert.equal(noDiff.length, 1, lines.join("\n"));
  assert.ok(noDiff[0].includes(`repository unresolved: ${why} —`), noDiff[0]);
});
