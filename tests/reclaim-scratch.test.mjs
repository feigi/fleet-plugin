// `reclaim-scratch.mjs`: the scratch root's steady-state reclaim. Every case
// runs the real script against a fixture root, a fixture ledger in a
// throwaway repository's `.fleet/`, and a `gh` stub on PATH that answers the
// GraphQL batch from a per-case table and logs every call. No case names a
// real scratch root: `--root` is always the fixture's own directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync,
  symlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeExecStub } from "./support/exec-stub.mjs";
import { freshUnder } from "../plugin/scripts/reclaim-scratch.mjs";
import { scratchRoot } from "../plugin/scripts/fleet-dir.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/reclaim-scratch.mjs", import.meta.url));
const DAY = 24 * 60 * 60 * 1000;
const DARWIN = process.platform === "darwin";

// Answers every `n<N>:issueOrPullRequest` alias in the query from GH_STATES
// (number -> node, null for a number that names nothing, or `{error}` for a
// lookup GitHub failed), the way GitHub and gh do: every requested alias
// present, a null alias carrying a NOT_FOUND error at its path, and gh
// exiting 1 with the whole body whenever there is an error. GH_ERRORS adds
// errors of its own, GH_RAW replaces the body outright.
const GH_STUB = `#!${process.execPath}
const fs = require("fs");
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.env.GH_ENV_LOG) fs.appendFileSync(process.env.GH_ENV_LOG, "GH_REPO=" + (process.env.GH_REPO ?? "<unset>") + "\\n");
if (process.env.GH_FAIL) { process.stderr.write("gh: could not reach api.github.com\\n"); process.exit(1); }
if (process.env.GH_RAW) { process.stdout.write(process.env.GH_RAW); process.exit(0); }
const q = process.argv.find((a) => a.startsWith("query="));
const states = JSON.parse(fs.readFileSync(process.env.GH_STATES, "utf8"));
const repo = {};
const errors = [];
for (const [, n] of q.matchAll(/n(\\d+):issueOrPullRequest/g)) {
  const v = states[n] ?? null;
  repo["n" + n] = v && v.error ? null : v;
  if (v === null) errors.push({ type: "NOT_FOUND", path: ["repository", "n" + n], message: "Could not resolve to an issue or pull request with the number of " + n + "." });
  else if (v.error) errors.push({ path: ["repository", "n" + n], ...v.error });
}
if (process.env.GH_ERRORS) errors.push(...JSON.parse(process.env.GH_ERRORS));
process.stdout.write(JSON.stringify(errors.length ? { data: { repository: repo }, errors } : { data: { repository: repo } }));
if (errors.length) { process.stderr.write("gh: " + errors[0].message + "\\n"); process.exit(1); }
`;

// A `chmod` with GNU's reach: a symlink given as an operand is dereferenced
// even under -R, as coreutils does and darwin's does not. Put ahead of the
// real one on PATH, it lets a darwin run see what a Linux run would.
const GNU_CHMOD = `#!/bin/sh
mode=
for a in "$@"; do
  case $a in
    -*) ;;
    *) if [ -z "$mode" ]; then mode=$a; elif [ -L "$a" ]; then /bin/chmod "$mode" "$a"; fi ;;
  esac
done
exec /bin/chmod "$@"
`;

const GIT_ENV = { ...process.env };
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;

const PR = (state) => ({ __typename: "PullRequest", state });
const ISSUE = (state) => ({ __typename: "Issue", state });

// Owner rwx and darwin's user flags back on everything under `dir`, so the
// teardown can remove what a case left locked.
function unlock(dir) {
  spawnSync("sh", ["-c", 'chmod -R u+rwx "$1" 2>/dev/null; if command -v chflags >/dev/null; then find "$1" -type d -exec chflags nouchg,nouappnd {} ";" -exec chmod u+rwx {} ";" 2>/dev/null; chflags -R nouchg,nouappnd "$1" 2>/dev/null; fi; :', "sh", dir]);
}

function fixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reclaim-scratch-")));
  t.after(() => {
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = join(dir, "repo");
  mkdirSync(join(repo, ".fleet"), { recursive: true });
  const g = spawnSync("git", ["init", "-q", repo], { env: GIT_ENV, encoding: "utf8" });
  assert.equal(g.status, 0, g.stderr);
  const root = join(dir, "root");
  mkdirSync(root);
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeExecStub(join(bin, "gh"), GH_STUB);
  const ghLog = join(dir, "gh.log");
  const statesFile = join(dir, "gh-states.json");
  writeFileSync(ghLog, "");
  writeFileSync(statesFile, "{}");
  const ledgerPath = join(repo, ".fleet", "ledger.md");

  const f = {
    base: dir, repo, root, ledgerPath,
    states(table) {
      writeFileSync(statesFile, JSON.stringify(table));
    },
    // A ledger whose live tokens are `rows` (row lines, `- ` added) and
    // `dispatched` (`## Dispatched` entries).
    ledger(rows = [], dispatched = []) {
      writeFileSync(ledgerPath, [
        "# Fleet run ledger", "", "## Rows", "", ...rows.map((r) => `- ${r}`),
        "", "## Dispatched", "", ...dispatched.map((d) => `- ${d}`),
        "", "## Filed", "", "", "## Ruled", "", "",
      ].join("\n"));
    },
    // A file at `rel` under the root (directories made), aged `days`.
    file(rel, days = 0) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "x");
      return f.age(p, days);
    },
    dir(rel, days = 0) {
      const p = join(root, rel);
      mkdirSync(p, { recursive: true });
      return f.age(p, days);
    },
    // Every node under `p`, and `p` itself, aged `days`.
    age(p, days) {
      const when = (Date.now() - days * DAY) / 1000;
      const walk = (q) => {
        if (lstatSync(q).isDirectory()) for (const n of readdirSync(q)) walk(join(q, n));
        utimesSync(q, when, when);
      };
      walk(p);
      return p;
    },
    run(args, { env = {} } = {}) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: repo, encoding: "utf8",
        env: { ...GIT_ENV, PATH: `${bin}:${process.env.PATH}`, GH_LOG: ghLog, GH_STATES: statesFile, ...env },
      });
      r.gh = readFileSync(ghLog, "utf8").split("\n").filter(Boolean);
      r.out = r.status === 0 && r.stdout.trim() ? JSON.parse(r.stdout) : null;
      return r;
    },
  };
  return f;
}

const paths = (list) => list.map((e) => e.path).sort();
const reasonOf = (list, path) => list.find((e) => e.path === path)?.reason;

test("(1) MERGED pr<M> and its dispositions files are removed, OPEN kept, CLOSED-unmerged removed — in one gh call", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 5: PR("MERGED"), 6: PR("OPEN"), 7: PR("CLOSED") });
  const merged = f.dir("pr5/run-abcdefgh");
  const mergedDisp = [f.file("dispositions-fix-pr-5.json"), f.file("dispositions-fix-pr-5-b.json")];
  f.dir("pr6/run-bcdefghi");
  const openDisp = f.file("dispositions-fix-pr-6.json");
  f.dir("pr7");

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.applied, true);
  assert.equal(r.out.ledger, f.ledgerPath);
  assert.deepEqual(paths(r.out.removed), [...mergedDisp, join(f.root, "pr5"), join(f.root, "pr7")].sort());
  assert.ok(!existsSync(dirname(merged)), "a MERGED PR's pr<M>/ survived");
  for (const p of mergedDisp) assert.ok(!existsSync(p), `${p} survived its PR's merge`);
  assert.ok(!existsSync(join(f.root, "pr7")), "a CLOSED PR's pr<M>/ survived");
  assert.ok(existsSync(join(f.root, "pr6", "run-bcdefghi")), "an OPEN PR's pr<M>/ was removed");
  assert.ok(existsSync(openDisp), "an OPEN PR's dispositions file was removed");
  assert.equal(reasonOf(r.out.kept, join(f.root, "pr6")), "PR #6 is OPEN");
  assert.deepEqual(r.out.failed, []);
  assert.equal(r.gh.length, 1, `expected one gh call for every number, got ${r.gh.length}`);
});

test("(1) more than 100 keyed numbers are asked of GitHub in batches of at most 100", (t) => {
  const f = fixture(t);
  f.ledger();
  const states = {};
  for (let n = 1; n <= 101; n++) {
    states[n] = PR("MERGED");
    f.dir(`pr${n}`);
  }
  f.states(states);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.removed.length, 101, "a number in the second batch was left unanswered");
  assert.deepEqual(r.out.failed, []);
  assert.equal(r.gh.length, 2, `101 numbers are two gh calls, got ${r.gh.length}`);
  const sizes = r.gh.map((line) => JSON.parse(line).find((a) => a.startsWith("query=")).match(/issueOrPullRequest\(/g).length);
  assert.deepEqual(sizes, [100, 1]);
});

test("(1) an OPEN PR keeps pr<M>/ whole except run-* roots idle past 7 days", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 6: PR("OPEN") });
  const stale = f.dir("pr6/run-staleaaa");
  const sibling = f.dir("pr6/merge-bot-1");
  f.age(join(f.root, "pr6"), 8);
  const fresh = f.dir("pr6/run-freshbbb", 1);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [stale]);
  assert.ok(!existsSync(stale));
  assert.ok(existsSync(fresh), "a run root modified a day ago was removed");
  assert.ok(existsSync(sibling), "an OPEN PR's non-run-* entry was removed");
});

test("(2) a live fix-pr-<M>, finisher-pr-<M> or review-pr-<M> keeps a MERGED pr<M>/; a settled one does not", (t) => {
  const f = fixture(t);
  f.ledger(
    [
      "#10 impl-10=PR#11 → PR#11 · fix-pr-11",
      "#12 impl-12=PR#13 → PR#13 · finisher-pr-13",
      "#14 impl-14=PR#15 → PR#15 · review=member:review-pr-15",
      "#16 impl-16=PR#17 → PR#17 · fix-pr-17=no-op",
    ],
    ["impl-10=PR#11", "fix-pr-11", "impl-12=PR#13", "finisher-pr-13", "impl-14=PR#15", "impl-16=PR#17", "fix-pr-17=no-op"],
  );
  f.states({ 11: PR("MERGED"), 13: PR("MERGED"), 15: PR("CLOSED"), 17: PR("MERGED") });
  for (const n of [11, 13, 15, 17]) f.dir(`pr${n}`);
  const disp = f.file("dispositions-fix-pr-11.json");

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.match(reasonOf(r.out.kept, join(f.root, "pr11")), /live fix-pr-11/);
  assert.match(reasonOf(r.out.kept, join(f.root, "pr13")), /live finisher-pr-13/);
  assert.match(reasonOf(r.out.kept, join(f.root, "pr15")), /live review-pr-15/);
  assert.match(reasonOf(r.out.kept, disp), /live fix-pr-11/);
  for (const n of [11, 13, 15]) assert.ok(existsSync(join(f.root, `pr${n}`)), `pr${n} was removed under a live member`);
  assert.deepEqual(paths(r.out.removed), [join(f.root, "pr17")]);
});

test("(2) a live merge-bot-<n> keeps every pr<N>, merged or closed, and their dispositions files", (t) => {
  const f = fixture(t);
  f.ledger([], ["merge-bot-2"]);
  f.states({ 5: PR("MERGED"), 7: PR("CLOSED"), 8: ISSUE("CLOSED") });
  f.dir("pr5");
  f.dir("pr7");
  f.file("dispositions-fix-pr-5.json");
  const impl = f.dir("impl-8");

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  for (const p of ["pr5", "pr7", "dispositions-fix-pr-5.json"]) {
    assert.equal(reasonOf(r.out.kept, join(f.root, p)), "live merge-bot-2 holds every pr<N>");
    assert.ok(existsSync(join(f.root, p)), `${p} was removed while a merge bot is live`);
  }
  assert.deepEqual(paths(r.out.removed), [impl], "a live merge bot holds pr<N> reclamation only");
});

test("(3) impl-<N>: CLOSED removed; OPEN + live token kept; OPEN, no token, idle 8 d removed; idle 1 d kept", (t) => {
  const f = fixture(t);
  f.ledger(["#21 impl-21-b"], ["impl-21-b"]);
  f.states({ 20: ISSUE("CLOSED"), 21: ISSUE("OPEN"), 22: ISSUE("OPEN"), 23: ISSUE("OPEN") });
  const closed = f.dir("impl-20/work", 0);
  const held = f.dir("impl-21", 8);
  const idle = f.file("impl-22/deep/note.txt", 8);
  f.age(join(f.root, "impl-22"), 8);
  const young = f.dir("impl-23", 1);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [join(f.root, "impl-20"), join(f.root, "impl-22")]);
  assert.ok(!existsSync(dirname(closed)) && !existsSync(idle));
  assert.match(reasonOf(r.out.kept, held), /live impl-21-b/);
  assert.match(reasonOf(r.out.kept, young), /issue #23 is OPEN; modified within 7 days/);
  assert.ok(existsSync(held) && existsSync(young));
});

// A linked worktree at `.worktrees/<rel>` of the fixture repository, on a
// branch of its own. The repository has no commit until this makes one.
function worktree(f, rel, branch) {
  const env = { ...GIT_ENV, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  if (spawnSync("git", ["-C", f.repo, "rev-parse", "--verify", "-q", "HEAD"], { env }).status !== 0) {
    const c = spawnSync("git", ["-C", f.repo, "commit", "-q", "--allow-empty", "-m", "init"], { env, encoding: "utf8" });
    assert.equal(c.status, 0, c.stderr);
  }
  const p = join(f.repo, ".worktrees", rel);
  const w = spawnSync("git", ["-C", f.repo, "worktree", "add", "-q", "-b", branch, p], { env, encoding: "utf8" });
  assert.equal(w.status, 0, w.stderr);
  return p;
}

test("(3b) OPEN impl-<N>/ idle 8 d is kept while .worktrees/<N>-impl-<N> stands, and removed once that directory is gone", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 22: ISSUE("OPEN"), 23: ISSUE("OPEN") });
  worktree(f, "22-impl-22", "implementer/22-impl-22");
  const gone = worktree(f, "23-impl-23", "implementer/23-impl-23");
  rmSync(gone, { recursive: true, force: true });
  const standing = f.dir("impl-22", 8);
  const absent = f.dir("impl-23", 8);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [join(f.root, "impl-23")]);
  assert.match(reasonOf(r.out.removed, absent), /issue #23 is OPEN, no live impl-23 token, idle past 7 days/);
  assert.equal(reasonOf(r.out.kept, standing), "claim worktree stands");
  assert.ok(existsSync(standing) && !existsSync(absent));
});

test("(3c) CLOSED impl-<N>/ is removed with its claim worktree standing; OPEN with a live token is kept with the token's reason", (t) => {
  const f = fixture(t);
  f.ledger(["#25 impl-25"], ["impl-25"]);
  f.states({ 24: ISSUE("CLOSED"), 25: ISSUE("OPEN") });
  worktree(f, "24-impl-24", "implementer/24-impl-24");
  worktree(f, "25-impl-25", "implementer/25-impl-25");
  const closed = f.dir("impl-24", 0);
  const held = f.dir("impl-25", 8);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [join(f.root, "impl-24")]);
  assert.match(reasonOf(r.out.removed, closed), /issue #24 is CLOSED/);
  assert.match(reasonOf(r.out.kept, held), /live impl-25/);
  assert.ok(existsSync(held) && !existsSync(closed));
});

test("(3d) a worktree for another issue does not keep impl-<N>/: .worktrees/129-impl-129 leaves impl-12 idle and removable", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 12: ISSUE("OPEN") });
  worktree(f, "129-impl-129", "implementer/129-impl-129");
  const idle = f.dir("impl-12", 8);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [join(f.root, "impl-12")]);
  assert.match(reasonOf(r.out.removed, idle), /issue #12 is OPEN, no live impl-12 token, idle past 7 days/);
  assert.ok(!existsSync(idle));
});

test("(3e) an undeterminable .worktrees/ keeps an idle OPEN impl-<N>/ with the reason it could not be checked", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 13: ISSUE("OPEN") });
  worktree(f, "13-impl-13", "implementer/13-impl-13");
  const idle = f.dir("impl-13", 8);
  chmodSync(join(f.repo, ".worktrees"), 0o000);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), []);
  assert.match(reasonOf(r.out.kept, idle), /its claim worktree cannot be checked: cannot tell whether .*13-impl-13 exists/);
  assert.ok(existsSync(idle));
});

test("(3f) an ambient GIT_DIR naming another repository does not change which claim worktree stands for impl-<N>/", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 26: ISSUE("OPEN") });
  worktree(f, "26-impl-26", "implementer/26-impl-26");
  const standing = f.dir("impl-26", 8);
  const other = join(f.repo, "elsewhere");
  mkdirSync(other);
  const init = spawnSync("git", ["init", "-q", other], { env: GIT_ENV, encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);

  const r = f.run(["--root", f.root, "--apply"], { env: { GIT_DIR: join(other, ".git") } });

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), []);
  assert.equal(reasonOf(r.out.kept, standing), "claim worktree stands");
  assert.ok(existsSync(standing));
});

test("(4) an unkeyed entry idle 8 d is removed; one fresh file nested three levels down keeps it", (t) => {
  const f = fixture(t);
  f.ledger();
  const idle = f.file("derive-recipe/a/b/c.txt", 8);
  f.age(join(f.root, "derive-recipe"), 8);
  const loose = f.file("controller-notes.md", 8);
  const fresh = f.file("review-pr-40/a/b/fresh.txt", 0);
  f.age(join(f.root, "review-pr-40"), 8);
  utimesSync(fresh, new Date(), new Date());
  const young = f.file("scratch-today.json", 1);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [join(f.root, "controller-notes.md"), join(f.root, "derive-recipe")]);
  assert.ok(!existsSync(dirname(dirname(dirname(idle)))) && !existsSync(loose));
  assert.ok(existsSync(join(f.root, "review-pr-40")), "an entry with a fresh file three levels down was removed — its top-level mtime decided");
  assert.equal(reasonOf(r.out.kept, join(f.root, "review-pr-40")), "modified within 7 days");
  assert.ok(existsSync(young));
  assert.equal(r.gh.length, 0, "no keyed entry, so gh has nothing to answer");
});

test("(4) an idle unkeyed entry whose name carries a live token's name is kept", (t) => {
  const f = fixture(t);
  f.ledger(["#30 impl-30=PR#31 → PR#31 · fix-pr-31"], ["impl-30=PR#31", "fix-pr-31"]);
  const named = f.dir("fix-pr-31", 8);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(reasonOf(r.out.kept, named), "live token fix-pr-31 appears in its name");
  assert.ok(existsSync(named));
});

test("(4) a keyed name of the wrong type, or naming nothing, is judged by age with the mismatch as its kept reason", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 50: ISSUE("CLOSED"), 51: PR("MERGED"), 52: null, 53: ISSUE("OPEN") });
  const issueAsPr = f.dir("pr50", 1);
  const prAsImpl = f.dir("impl-51", 1);
  const nothing = f.dir("pr52", 8);
  const oldIssueAsPr = f.dir("pr53", 8);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(reasonOf(r.out.kept, issueAsPr), "#50 is a Issue, not a pull request; modified within 7 days");
  assert.equal(reasonOf(r.out.kept, prAsImpl), "#51 is a PullRequest, not an issue; modified within 7 days");
  assert.deepEqual(paths(r.out.removed), [nothing, oldIssueAsPr]);
  assert.ok(existsSync(issueAsPr) && existsSync(prAsImpl));
});

test("(4) a PR whose state GitHub did not give as MERGED or CLOSED is kept, never removed", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 5: { __typename: "PullRequest" }, 7: PR("OPENISH"), 9: PR("MERGED") });
  const noState = f.dir("pr5", 8);
  const odd = f.dir("pr7", 8);
  const merged = f.dir("pr9", 8);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(noState) && existsSync(odd), "a PR with an unrecognised state was removed");
  assert.match(reasonOf(r.out.kept, noState), /unrecognised state/);
  assert.match(reasonOf(r.out.kept, odd), /unrecognised state/);
  assert.deepEqual(paths(r.out.removed), [merged]);
});

test("(5) gh failing keeps every keyed entry with the reason; unkeyed entries are still swept", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 5: PR("MERGED"), 20: ISSUE("CLOSED") });
  const keyed = [f.dir("pr5", 8), f.dir("impl-20", 8), f.file("dispositions-fix-pr-5.json", 8)];
  const loose = f.dir("stray", 8);

  const r = f.run(["--root", f.root, "--apply"], { env: { GH_FAIL: "1" } });

  assert.equal(r.status, 0, r.stderr);
  for (const p of keyed) {
    assert.match(reasonOf(r.out.kept, p) ?? "", /^gh api graphql gave no answer for #\d+ \(exit 1: gh: could not reach api\.github\.com\)$/, `${p} was not kept with gh's failure`);
    assert.ok(existsSync(p), `${p} was removed with gh unreachable`);
  }
  assert.deepEqual(paths(r.out.removed), [loose]);
});

test("(5) gh is asked with GH_REPO empty however the parent's environment names a repository", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 5: PR("OPEN") });
  f.dir("pr5", 8);
  const envLog = join(f.base, "gh-env.log");

  const r = f.run(["--root", f.root], { env: { GH_REPO: "someone/else", GH_ENV_LOG: envLog } });

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readFileSync(envLog, "utf8").split("\n").filter(Boolean), ["GH_REPO="], "gh inherited the parent's GH_REPO, which outranks the repository the cwd is bound to");
});

test("freshUnder: an entry modified exactly at the cutoff is fresh, one a millisecond older is not", (t) => {
  const f = fixture(t);
  const p = f.file("edge.txt", 8);
  const mtime = lstatSync(p).mtimeMs;

  assert.equal(freshUnder(p, mtime), p, "an mtime equal to the cutoff counted as idle");
  assert.equal(freshUnder(p, mtime + 1), null);
});

test("(5) a lookup GitHub failed for one number keeps that entry; its batch-mates are still judged", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 5: { error: { type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement" } }, 6: PR("OPEN"), 7: PR("MERGED") });
  const refused = f.dir("pr5", 10);
  const open = f.dir("pr6", 10);
  const merged = f.dir("pr7", 10);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.match(reasonOf(r.out.kept, refused) ?? "", /^gh api graphql gave no answer for #5 \(FORBIDDEN: Resource protected by organization SAML enforcement\)$/);
  assert.ok(existsSync(refused), "a pr<N> GitHub errored on was removed on its age");
  assert.ok(existsSync(open));
  assert.deepEqual(paths(r.out.removed), [merged]);
  assert.deepEqual(r.out.failed, []);
});

test("(5) an error naming no alias keeps every keyed entry in its batch; unkeyed entries are still swept", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 5: PR("MERGED"), 20: ISSUE("CLOSED") });
  const keyed = [f.dir("pr5", 10), f.dir("impl-20", 10)];
  const loose = f.dir("stray", 10);

  const r = f.run(["--root", f.root, "--apply"], { env: { GH_ERRORS: JSON.stringify([{ type: "RATE_LIMITED", message: "API rate limit exceeded" }]) } });

  assert.equal(r.status, 0, r.stderr);
  for (const p of keyed) {
    assert.match(reasonOf(r.out.kept, p) ?? "", /^gh api graphql gave no answer for #\d+ \(RATE_LIMITED: API rate limit exceeded\)$/);
    assert.ok(existsSync(p), `${p} was removed under a batch-wide error`);
  }
  assert.deepEqual(paths(r.out.removed), [loose]);
});

for (const [shape, body] of [
  ["no error at all", { data: { repository: { n5: null } } }],
  ["a NOT_FOUND error naming a field inside the alias, not the alias", { data: { repository: { n5: null } }, errors: [{ type: "NOT_FOUND", path: ["repository", "n5", "state"], message: "no such field" }] }],
]) {
  test(`(5) a null alias with ${shape} is no answer, not 'names nothing'`, (t) => {
    const f = fixture(t);
    f.ledger();
    const aged = f.dir("pr5", 10);

    const r = f.run(["--root", f.root, "--apply"], { env: { GH_RAW: JSON.stringify(body) } });

    assert.equal(r.status, 0, r.stderr);
    assert.match(reasonOf(r.out.kept, aged) ?? "", /^gh api graphql gave no answer for #5 \((null with no NOT_FOUND error|NOT_FOUND: no such field)\)$/);
    assert.ok(existsSync(aged));
    assert.deepEqual(r.out.removed, []);
  });
}

test("(5) a body gh exited 0 with that is not JSON keeps the entry, and the reason says the body was unparseable", (t) => {
  const f = fixture(t);
  f.ledger();
  const aged = f.dir("pr5", 10);

  const r = f.run(["--root", f.root, "--apply"], { env: { GH_RAW: "<html>proxy login</html>" } });

  assert.equal(r.status, 0, r.stderr);
  assert.match(reasonOf(r.out.kept, aged) ?? "", /^gh api graphql gave no answer for #5 \(exit 0: unparseable body: .+\)$/);
  assert.ok(existsSync(aged));
  assert.deepEqual(r.out.removed, []);
});

test("(4) a directory that can be listed but not searched counts its own mtime and does not stop the sweep", { skip: process.getuid?.() === 0 && "root searches any directory" }, (t) => {
  const f = fixture(t);
  f.ledger();
  const unsearchable = f.dir("stray/sub", 10);
  writeFileSync(join(unsearchable, "file.txt"), "x");
  f.age(join(f.root, "stray"), 10);
  const other = f.dir("other-old", 10);
  chmodSync(unsearchable, 0o600);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [other, join(f.root, "stray")].sort());
  assert.ok(!existsSync(join(f.root, "stray")) && !existsSync(other));
});

test("(6) a chmod 000 directory and a flagged file inside a removable entry do not wedge its removal", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 5: PR("MERGED") });
  const locked = f.dir("pr5/run-lockedaa/locked/deeper");
  writeFileSync(join(locked, "inner.txt"), "x");
  const flagged = f.file("pr5/run-lockedaa/flagged.txt");
  if (DARWIN) spawnSync("chflags", ["uchg", flagged]);
  chmodSync(locked, 0);
  chmodSync(dirname(locked), 0);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.failed, []);
  assert.deepEqual(paths(r.out.removed), [join(f.root, "pr5")]);
  assert.ok(!existsSync(join(f.root, "pr5")), "a chmod 000 directory or a uchg file wedged the removal");
});

for (const [shape, setup] of [
  ["a directory that is both uchg and chmod 000", (d) => { chmodSync(d, 0); spawnSync("chflags", ["uchg", d]); }],
  ["an uappnd file whose own mode leaves chmod nothing to change", (d) => { const p = join(d, "log"); writeFileSync(p, ""); chmodSync(p, 0o700); spawnSync("chflags", ["uappnd", p]); }],
  ["its own uchg over a chmod 000 directory", (d) => { chmodSync(d, 0); spawnSync("chflags", ["uchg", dirname(d)]); }],
]) {
  test(`(6) on darwin a removable entry with ${shape} is removed`, { skip: !DARWIN && "chflags/uchg/uappnd are darwin's" }, (t) => {
    const f = fixture(t);
    f.ledger();
    f.states({ 20: ISSUE("CLOSED") });
    const d = f.dir("impl-20/locked");
    writeFileSync(join(d, "inner.txt"), "x");
    setup(d);

    const r = f.run(["--root", f.root, "--apply"]);

    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.out.failed, []);
    assert.ok(!existsSync(join(f.root, "impl-20")), `${shape} wedged the removal`);
  });
}

test("(6) a symlink entry is unlinked and its target left alone", (t) => {
  const f = fixture(t);
  f.ledger();
  const target = join(f.base, "outside");
  mkdirSync(target);
  chmodSync(target, 0o500);
  const link = join(f.root, "linked");
  symlinkSync(target, link);
  f.age(target, 8);
  writeExecStub(join(f.base, "bin", "chmod"), GNU_CHMOD);
  spawnSync("touch", ["-h", "-t", "200001010000", link]);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [link]);
  assert.ok(!existsSync(link) && existsSync(target), "the symlink's target was removed");
  assert.equal(spawnSync("stat", DARWIN ? ["-f", "%Lp", target] : ["-c", "%a", target], { encoding: "utf8" }).stdout.trim(), "500", "the removal changed the target's mode through the link");
});

test("(6) on darwin a symlink entry's target keeps its flags", { skip: !DARWIN && "chflags/uchg are darwin's" }, (t) => {
  const f = fixture(t);
  f.ledger();
  const target = join(f.base, "outside");
  mkdirSync(target);
  const link = join(f.root, "linked");
  symlinkSync(target, link);
  f.age(target, 8);
  spawnSync("chflags", ["uchg", target]);
  spawnSync("touch", ["-h", "-t", "200001010000", link]);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [link]);
  assert.ok(!existsSync(link) && existsSync(target), "the symlink's target was removed");
  assert.equal(spawnSync("stat", ["-f", "%Sf", target], { encoding: "utf8" }).stdout.trim(), "uchg", "the removal cleared the target's flags through the link");
});

test("(6) a fresh target behind a symlink inside an idle entry does not keep it", (t) => {
  const f = fixture(t);
  f.ledger();
  const freshFile = join(f.base, "outside-file");
  writeFileSync(freshFile, "x");
  const freshDir = join(f.base, "outside-dir");
  mkdirSync(freshDir);
  writeFileSync(join(freshDir, "inner"), "x");
  const entry = join(f.root, "derive-linked");
  mkdirSync(entry);
  const toFile = join(entry, "to-file");
  const toDir = join(entry, "to-dir");
  symlinkSync(freshFile, toFile);
  symlinkSync(freshDir, toDir);
  for (const l of [toFile, toDir]) spawnSync("touch", ["-h", "-t", "200001010000", l]);
  f.age(entry, 8);
  for (const l of [toFile, toDir]) spawnSync("touch", ["-h", "-t", "200001010000", l]);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [entry], "a symlink's fresh target kept the entry — freshUnder followed the link");
  assert.ok(!existsSync(entry) && existsSync(freshFile) && existsSync(join(freshDir, "inner")), "the removal reached a link's target");
});

test("(7) a dry run touches nothing and prints the receipt --apply then acts on, with \"applied\":false", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 5: PR("MERGED"), 6: PR("OPEN") });
  const all = [f.dir("pr5", 8), f.dir("pr6", 8), f.dir("stray", 8), f.file("young.txt", 0)];

  const dry = f.run(["--root", f.root]);

  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.out.applied, false);
  for (const p of all) assert.ok(existsSync(p), `the dry run removed ${p}`);
  const wet = f.run(["--root", f.root, "--apply"]);
  assert.equal(wet.status, 0, wet.stderr);
  assert.deepEqual({ ...dry.out, applied: true }, wet.out);
  assert.deepEqual(paths(dry.out.removed), [all[0], all[2]]);
});

test("(8) --pr <N> with no ledger: run-* idle 8 d removed, fresh kept, non-run-* siblings untouched, gh never asked", (t) => {
  const f = fixture(t);
  const stale = f.file("pr7/run-staleaaa/snapshot-abc/file.txt", 8);
  f.age(join(f.root, "pr7", "run-staleaaa"), 8);
  const fresh = f.dir("pr7/run-freshbbb", 0);
  const young = f.dir("pr7/run-youngccc", 1);
  const siblings = [f.dir("pr7/snap-ro1", 30), f.dir("pr7/fix-abcdefgh", 30), f.file("pr7/run-notadir", 30), f.dir("pr7/merge-bot-1", 30)];
  const nested = f.dir("pr7/pr7/run-nestedcc", 30);
  const other = f.dir("pr8/run-otherddd", 30);

  const r = f.run(["--pr", "7", "--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.ledger, null);
  assert.deepEqual(paths(r.out.removed), [join(f.root, "pr7", "run-staleaaa")]);
  assert.ok(!existsSync(dirname(dirname(stale))));
  assert.deepEqual(paths(r.out.kept), [fresh, young].sort());
  for (const p of [fresh, young, ...siblings, nested, other]) assert.ok(existsSync(p), `--pr 7 removed ${p}`);
  assert.deepEqual(r.gh, []);
});

test("(8) --pr <N> on a PR with no pr<N>/ yet answers an empty receipt", (t) => {
  const f = fixture(t);
  const r = f.run(["--pr", "9", "--root", f.root, "--apply"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out, { applied: true, ledger: null, removed: [], kept: [], failed: [] });
});

test("(9) every refused invocation exits 2 and touches nothing", (t) => {
  const f = fixture(t);
  f.states({ 5: PR("MERGED") });
  const entry = f.dir("pr5", 8);
  const notDir = f.file("plain", 0);
  for (const [args, re] of [
    [["--apply"], /--root is required/],
    [["--root", "relative/root", "--apply"], /--root must be an absolute path/],
    [["--root", notDir, "--apply"], /is not a directory/],
    [["--root", join(f.base, "missing"), "--apply"], /is not a directory/],
    [["--root", f.root, "--pr", "x7", "--apply"], /--pr must be a PR number/],
    [["--root", f.root, "--pr", "7", "--after-rotate", "--apply"], /--after-rotate is the root sweep's/],
    [["--root", f.root, "--apply"], /no \.fleet\/ledger\.md/],
  ]) {
    const r = f.run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, re);
    assert.equal(r.stdout, "", "a refusal printed a receipt");
    assert.ok(existsSync(entry), `${args.join(" ")} removed an entry`);
  }
  assert.deepEqual(f.run(["--root", f.root, "--apply"]).gh, [], "a refused root sweep asked gh");
});

test("(9) a ledger that exists but cannot be read refuses under --after-rotate too", (t) => {
  const f = fixture(t);
  f.states({ 5: PR("MERGED") });
  const entry = f.dir("pr5");
  mkdirSync(f.ledgerPath);
  for (const args of [["--root", f.root, "--apply"], ["--root", f.root, "--after-rotate", "--apply"]]) {
    const r = f.run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /ledger\.mjs read .* failed/);
    assert.ok(existsSync(entry));
  }
});

test("(9) --after-rotate with no ledger judges keyed entries with no live token, receipt \"ledger\":null", (t) => {
  const f = fixture(t);
  f.states({ 5: PR("MERGED"), 6: PR("OPEN") });
  const merged = f.dir("pr5");
  const open = f.dir("pr6");

  const r = f.run(["--root", f.root, "--after-rotate", "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.ledger, null);
  assert.deepEqual(paths(r.out.removed), [merged]);
  assert.ok(!existsSync(merged) && existsSync(open));
});

test("(9) --after-rotate with a ledger holding a live merge-bot-<n> keeps every pr<N> and names the ledger", (t) => {
  const f = fixture(t);
  f.ledger([], ["merge-bot-3"]);
  f.states({ 5: PR("MERGED"), 7: PR("CLOSED") });
  const prs = [f.dir("pr5"), f.dir("pr7")];

  const r = f.run(["--root", f.root, "--after-rotate", "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.ledger, f.ledgerPath);
  assert.deepEqual(r.out.removed, []);
  for (const p of prs) assert.ok(existsSync(p), `${p} was removed under a carried merge bot`);
});

test("(9) a removal that fails lands in failed[], the sweep continues, and the receipt still reaches stdout at exit 0", { skip: process.getuid?.() === 0 && "root ignores the read-only parent" }, (t) => {
  const f = fixture(t);
  f.states({ 7: PR("OPEN") });
  const wedged = f.dir("pr7/run-wedgedaa", 8);
  f.dir("pr7/run-otherbbb", 8);
  chmodSync(join(f.root, "pr7"), 0o555);

  const r = f.run(["--pr", "7", "--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.out, `no receipt on stdout: ${r.stdout}`);
  assert.deepEqual(paths(r.out.failed), [join(f.root, "pr7", "run-otherbbb"), wedged].sort());
  assert.ok(r.out.failed.every((e) => typeof e.error === "string" && e.error.length > 0));
  assert.deepEqual(r.out.removed, []);
  assert.ok(existsSync(wedged));
});

// ---------------------------------------------------------------------------
// reports/<member>.json goes with the entry its member belongs to
// ---------------------------------------------------------------------------

test("(10) each report family goes with its anchor: PR reports with pr<M>/, impl reports with impl-<N>/, a bot's after 7 idle days", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 5: PR("MERGED"), 6: PR("OPEN"), 7: PR("CLOSED"), 30: ISSUE("CLOSED"), 31: ISSUE("OPEN"), 32: ISSUE("OPEN") });
  const rep = (name, days = 1) => f.file(`reports/${name}`, days);
  const gone = [
    rep("fix-pr-5.json"), rep("fix-pr-5-b.json"), rep("finisher-pr-5.json"), rep("review-pr-5.json"),
    rep("finisher-pr-7.json"),
    rep("impl-30.json"), rep("impl-30-b.json"),
    rep("impl-32.json", 8),
    rep("merge-bot-9.json", 8),
    rep("notes.txt", 8),
  ];
  const stays = [
    rep("fix-pr-6.json", 8), // PR #6 is OPEN, however old the file is
    rep("impl-31.json"), // issue #31 is OPEN and the file is young
    rep("merge-bot-10.json", 1),
    rep("scratch-today.txt", 1),
  ];

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [...gone].sort());
  for (const p of gone) assert.ok(!existsSync(p), `${p} survived`);
  for (const p of stays) assert.ok(existsSync(p), `${p} was removed`);
  assert.ok(existsSync(join(f.root, "reports")), "reports/ itself was removed");
  assert.equal(reasonOf(r.out.removed, join(f.root, "reports", "fix-pr-5.json")), "PR #5 is MERGED");
  assert.equal(reasonOf(r.out.removed, join(f.root, "reports", "impl-30.json")), "issue #30 is CLOSED");
  assert.match(reasonOf(r.out.kept, join(f.root, "reports", "fix-pr-6.json")), /PR #6 is OPEN/);
  assert.match(reasonOf(r.out.kept, join(f.root, "reports", "impl-31.json")), /issue #31 is OPEN; modified within 7 days/);
  assert.match(reasonOf(r.out.kept, join(f.root, "reports", "merge-bot-10.json")), /modified within 7 days/);
});

test("(10) a report goes with its anchor although no pr<M>/ or impl-<N>/ directory exists, and a dry run removes nothing", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 5: PR("MERGED"), 30: ISSUE("CLOSED") });
  const pr = f.file("reports/fix-pr-5.json");
  const impl = f.file("reports/impl-30.json");

  const dry = f.run(["--root", f.root]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.out.applied, false);
  assert.deepEqual(paths(dry.out.removed), [impl, pr].sort());
  assert.ok(existsSync(pr) && existsSync(impl), "a dry run removed a report");

  const r = f.run(["--root", f.root, "--apply"]);
  assert.deepEqual(paths(r.out.removed), [impl, pr].sort());
  assert.ok(!existsSync(pr) && !existsSync(impl));
});

test("(10) a live token keeps its member's report: a PR's and an OPEN ticket's", (t) => {
  const f = fixture(t);
  f.ledger(
    ["#40 impl-40=PR#41 → PR#41 · fix-pr-41", "#50 impl-50-b", "#60 impl-60=PR#61 → PR#61 · review=member:review-pr-61"],
    ["impl-40=PR#41", "fix-pr-41", "impl-50-b", "impl-60=PR#61"],
  );
  f.states({ 41: PR("MERGED"), 51: PR("MERGED"), 61: PR("CLOSED"), 50: ISSUE("OPEN"), 70: ISSUE("OPEN") });
  const held = {
    "fix-pr-41.json": /live fix-pr-41/,
    "review-pr-61.json": /live review-pr-61/,
    "impl-50.json": /issue #50 is OPEN and live impl-50-b/,
    "impl-50-b.json": /issue #50 is OPEN and live impl-50-b/,
  };
  for (const name of Object.keys(held)) f.file(`reports/${name}`, 8);
  // The same files with no live member: gone, so the holds above are what kept them.
  const idleBot = f.file("reports/merge-bot-8.json", 8);
  const idleImpl = f.file("reports/impl-70.json", 8);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  for (const [name, why] of Object.entries(held)) {
    const p = join(f.root, "reports", name);
    assert.ok(existsSync(p), `${name} was removed while its member is live`);
    assert.match(reasonOf(r.out.kept, p), why);
  }
  assert.deepEqual(paths(r.out.removed), [idleBot, idleImpl].sort());
});

test("(10) a live merge-bot holds every PR-bound report, as it holds every pr<N>", (t) => {
  const f = fixture(t);
  f.ledger([], ["merge-bot-2"]);
  f.states({ 5: PR("MERGED"), 30: ISSUE("CLOSED") });
  const pr = f.file("reports/fix-pr-5.json");
  const impl = f.file("reports/impl-30.json");

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(reasonOf(r.out.kept, pr), "live merge-bot-2 holds every pr<N>");
  assert.ok(existsSync(pr));
  assert.deepEqual(paths(r.out.removed), [impl], "a live merge bot holds pr<N> reclamation only");
});

test("(10) reports/ is never aged out whole: an idle directory holding a live bot's report keeps it", (t) => {
  const f = fixture(t);
  f.ledger([], ["merge-bot-9"]);
  f.states({});
  const bot = f.file("reports/merge-bot-9.json", 8);
  f.age(join(f.root, "reports"), 8);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(bot), "the live bot's report went with its idle reports/ directory");
  assert.match(reasonOf(r.out.kept, bot), /live token merge-bot-9 appears in its name/);
  assert.deepEqual(r.out.removed, []);
});

test("(10) a lookup GitHub could not answer keeps the reports that name that number", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({ 5: { error: { message: "boom" } } });
  const pr = f.file("reports/fix-pr-5.json", 8);
  const unkeyed = f.file("reports/notes.txt", 8);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(pr), "a report was removed on a lookup that gave no answer");
  assert.deepEqual(paths(r.out.removed), [unkeyed], "the age rule still runs on an unkeyed file");
});

test("(10) a `reports` that is a file, not a directory, is judged as any other entry", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({});
  const lone = f.file("reports", 8);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [lone]);
});

test("(10) a `reports` that is a link is unlinked as any other entry, never read through into its target", (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({});
  const target = join(f.base, "outside");
  mkdirSync(target);
  const inside = join(target, "merge-bot-9.json");
  writeFileSync(inside, "x");
  const link = join(f.root, "reports");
  symlinkSync(target, link);
  f.age(target, 8);
  spawnSync("touch", ["-h", "-t", "200001010000", link]);

  const r = f.run(["--root", f.root, "--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [link]);
  assert.ok(!existsSync(link) && existsSync(inside), "a report under the link's target was reached through the link");
});

test("(10) a `reports` whose type cannot be read is kept, never aged out whole", { skip: process.getuid?.() === 0 && "root ignores the unsearchable root" }, (t) => {
  const f = fixture(t);
  f.ledger();
  f.states({});
  const bot = f.file("reports/merge-bot-9.json", 8);
  f.age(join(f.root, "reports"), 8);
  // Listable but not searchable: the names read, an lstat of any of them fails EACCES.
  chmodSync(f.root, 0o444);
  let r;
  try {
    r = f.run(["--root", f.root, "--apply"]);
  } finally {
    chmodSync(f.root, 0o755);
  }

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.removed, []);
  assert.match(reasonOf(r.out.kept, join(f.root, "reports")), /its type cannot be read: EACCES/);
  assert.ok(existsSync(bot));
});

// The sibling pass: `--root` names the live key, which must be the fixture
// repository's own scratch root under the fixture's HOME. Returns the live key,
// aged 8 d, plus the scratch parent and the env for the run.
function siblingFixture(t) {
  const f = fixture(t);
  const home = join(f.base, "home");
  const live = scratchRoot({ cwd: f.repo, home });
  const parent = dirname(live);
  mkdirSync(live, { recursive: true });
  f.age(live, 8);
  return { ...f, parent, live, env: { HOME: home } };
}

test("(11) a sibling key idle 8 d is removed whole; a sibling with a fresh file three levels down is kept; non-key entries and the live key are untouched", (t) => {
  const f = siblingFixture(t);
  const stale = join(f.parent, "impl-tool-aaaaaaaa");
  mkdirSync(join(stale, "a", "b"), { recursive: true });
  writeFileSync(join(stale, "a", "b", "c.txt"), "x");
  f.age(stale, 8);
  const fresh = join(f.parent, "other-repo-bbbbbbbb");
  mkdirSync(join(fresh, "a", "b"), { recursive: true });
  writeFileSync(join(fresh, "a", "b", "c.txt"), "x");
  f.age(fresh, 8);
  utimesSync(join(fresh, "a", "b", "c.txt"), new Date(), new Date());
  const legacy = join(f.parent, "pr1234");
  mkdirSync(legacy);
  f.age(legacy, 8);
  const loose = join(f.parent, "loose.json");
  writeFileSync(loose, "x");
  f.age(loose, 8);
  const liveFile = join(f.live, "pr40", "run-1", "review.json");
  mkdirSync(dirname(liveFile), { recursive: true });
  writeFileSync(liveFile, "x");
  f.age(f.live, 8);

  const dry = f.run(["--siblings", "--root", f.live], { env: f.env });

  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.out.applied, false);
  assert.equal(dry.out.ledger, null, "the sibling pass reads no ledger");
  assert.deepEqual(paths(dry.out.removed), [stale]);
  assert.equal(reasonOf(dry.out.removed, stale), "sibling key idle past 7 days");
  assert.deepEqual(paths(dry.out.kept), [fresh]);
  assert.equal(reasonOf(dry.out.kept, fresh), "sibling key modified within 7 days");
  assert.ok(existsSync(stale), "a dry run removed");

  const r = f.run(["--siblings", "--root", f.live, "--apply"], { env: f.env });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.out.applied, true);
  assert.deepEqual(paths(r.out.removed), [stale]);
  assert.deepEqual(r.out.failed, []);
  assert.ok(!existsSync(stale), "the idle sibling key survived --apply");
  assert.ok(existsSync(fresh), "a sibling with a fresh file was removed");
  assert.ok(existsSync(legacy) && existsSync(loose), "a non-key entry under the scratch parent was touched");
  assert.ok(existsSync(liveFile), "the live key was touched by the sibling pass");
  assert.equal(r.gh.length, 0, "the sibling pass asks GitHub nothing");
});

test("(11) a key-shaped file or a symlink under the scratch parent is never removed by the sibling pass", (t) => {
  const f = siblingFixture(t);
  const file = join(f.parent, "dump-deadbeef");
  writeFileSync(file, "x");
  f.age(file, 8);
  const target = join(f.base, "elsewhere");
  mkdirSync(target);
  f.age(target, 8);
  const link = join(f.parent, "link-cafebabe");
  symlinkSync(target, link);
  // Aged too, so a pass that admitted links as keys would find nothing fresh and remove it.
  spawnSync("touch", ["-h", "-t", "200001010000", link]);

  const r = f.run(["--siblings", "--root", f.live, "--apply"], { env: f.env });

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.removed, []);
  assert.ok(existsSync(file) && existsSync(link) && existsSync(target), "a non-directory or a link was judged as a key");
});

test("(11) the sibling pass refuses a root that is not this workspace's own scratch root", (t) => {
  const f = siblingFixture(t);
  const stale = join(f.parent, "impl-tool-aaaaaaaa");
  mkdirSync(stale);
  f.age(stale, 8);
  const notKey = join(f.parent, "not-a-key");
  mkdirSync(notKey);
  const outside = join(f.base, "outside-abcdef12");
  mkdirSync(outside);
  f.age(outside, 8);

  const bad = [
    ["--siblings", "--root", notKey],
    ["--siblings", "--root", outside],
    ["--siblings", "--root", f.root],
    // Another key under the same parent: accepted, it would judge the live key.
    ["--siblings", "--root", stale, "--apply"],
    ["--siblings", "--pr", "5", "--root", f.live],
    ["--siblings", "--after-rotate", "--root", f.live],
  ];
  for (const args of bad) {
    const r = f.run(args, { env: f.env });
    assert.equal(r.status, 2, `${args.join(" ")} was accepted: ${r.stdout}`);
  }
  assert.ok(existsSync(stale) && existsSync(outside) && existsSync(f.live), "a refused invocation removed something");
});

test("(11) a sibling key with nothing modified in 7 days is removed, one modified 6 days ago is kept — the boundary is the retention", (t) => {
  const f = siblingFixture(t);
  const old = join(f.parent, "old-11111111");
  mkdirSync(old);
  f.age(old, 8);
  const young = join(f.parent, "young-22222222");
  mkdirSync(young);
  f.age(young, 6);

  const r = f.run(["--siblings", "--root", f.live, "--apply"], { env: f.env });

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [old]);
  assert.deepEqual(paths(r.out.kept), [young]);
  assert.ok(existsSync(young), "a key modified 6 days ago was removed");
});

test("(11) a sibling key written to while an earlier key is being removed is judged again and kept", (t) => {
  const f = siblingFixture(t);
  const first = join(f.parent, "aaa-11111111");
  mkdirSync(first);
  f.age(first, 8);
  const second = join(f.parent, "zzz-22222222");
  mkdirSync(second);
  f.age(second, 8);
  // An `rm` that, removing the first key, has another run write into the second.
  writeExecStub(join(f.base, "bin", "rm"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = "$RACE_ON" ] && : > "$RACE_WRITE"; done\nexec /bin/rm "$@"\n`);
  const written = join(second, "fresh.txt");

  const r = f.run(["--siblings", "--root", f.live, "--apply"], { env: { ...f.env, RACE_ON: first, RACE_WRITE: written } });

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.out.removed), [first]);
  assert.deepEqual(paths(r.out.kept), [second]);
  assert.equal(reasonOf(r.out.kept, second), "sibling key modified within 7 days");
  assert.ok(existsSync(written), "a key written to after it was judged was removed");
});

test("(11) a sibling key with a part that cannot be read is kept whole, with that part named", { skip: process.getuid?.() === 0 && "root reads the locked directory" }, (t) => {
  const f = siblingFixture(t);
  const key = join(f.parent, "locked-33333333");
  const locked = join(key, "locked");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "fresh.txt"), "x");
  f.age(key, 8);
  chmodSync(locked, 0o000);

  const r = f.run(["--siblings", "--root", f.live, "--apply"], { env: f.env });

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.out.removed, []);
  assert.deepEqual(paths(r.out.kept), [key]);
  assert.equal(reasonOf(r.out.kept, key), `sibling key could not be read whole (${locked}: EACCES)`);
  assert.ok(existsSync(key), "a key with an unreadable part was removed");
});
