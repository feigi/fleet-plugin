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
