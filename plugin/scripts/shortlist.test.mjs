// Regression gate for shortlist.mjs — the Shortlist as a script (ADR 0013 §1,
// §3): candidates.mjs's oldest-first rows, minus open blockers, minus live
// Exclusions, minus whatever inflight.sh reports taken or cannot answer,
// written to `.fleet/shortlist.json` under the git common dir.
//
// What is real and what is stubbed, and why:
//
//   - candidates.mjs and ledger.mjs are the REAL scripts, copied beside the
//     script under test. candidates.mjs is what orders the rows and extracts
//     `d` from a body, so a stub there would pin a sort and a dependency scan
//     this file never ran; ledger.mjs is the only writer of the `excluded ·`
//     rows the exclusion rule reads, so every row below is written by it
//     rather than hand-spelled in a format that could drift from the real one.
//   - `gh` is a PATH stub. `issue list` applies the jq expression gh was
//     handed to a fixture (the fleet-tick.test.mjs pattern), and answers `[]`
//     unless the search carries `label:"ready-for-agent"` — so every case that
//     expects rows back also proves the label was asked for. `issue view` and
//     `pr view` answer `{"state": …}` from a per-case state table, and fail the
//     way real gh does for a number or branch the table does not name.
//   - inflight.sh is a stub, because the real one needs a remote, a PR list and
//     python3 to say anything; its own suite is inflight.test.mjs. The stub
//     keeps the real exit contract: 0 free, 1 taken, 2 could not answer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, existsSync, rmSync, realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "./git-env.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// Every file the copied shortlist.mjs reaches at run time: its own imports,
// and the two sibling scripts it spawns for real. A missing import is a
// MODULE_NOT_FOUND at startup, so add a row whenever any of these gains one.
const COPIED = ["shortlist.mjs", "candidates.mjs", "ledger.mjs", "arg.mjs", "git-env.mjs"];

const GH_STUB = `#!/bin/sh
case " $* " in *" --fleet-warm "*) exit 0 ;; esac
case "$1 $2" in
  "issue list")
    [ -n "$ISSUE_LIST_FAIL" ] && { echo "gh: HTTP 502" >&2; exit 1; }
    expr=""
    search=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --jq) shift; expr="$1" ;;
        --search) shift; search="$1" ;;
      esac
      shift
    done
    case "$search" in
      *'label:"ready-for-agent"'*) exec jq -c "$expr" "$FIXTURE_ISSUES" ;;
      *) echo '[]' ;;
    esac ;;
  "issue view"|"pr view")
    state=$(jq -r --arg k "$1" --arg id "$3" '.[$k][$id] // ""' "$FIXTURE_STATES")
    case "$state" in
      "") echo "GraphQL: Could not resolve to an issue or pull request with the number of $3." >&2; exit 1 ;;
      FAIL) echo "gh: HTTP 502 Bad Gateway" >&2; exit 1 ;;
    esac
    printf '{"state":"%s"}\\n' "$state" ;;
  *) echo "unexpected gh $*" >&2; exit 1 ;;
esac
`;

const INFLIGHT_STUB = `#!/bin/sh
for t in $INFLIGHT_SLOW; do [ "$t" = "$1" ] && sleep 1; done
for t in $INFLIGHT_TAKEN; do
  [ "$t" = "$1" ] && { printf '{"issue":%s,"taken":true,"hits":["pr"],"unknown":[]}\\n' "$1"; exit 1; }
done
for t in $INFLIGHT_UNKNOWN; do
  [ "$t" = "$1" ] && { printf '{"issue":%s,"taken":false,"hits":[],"unknown":["gh pr list failed"]}\\n' "$1"; exit 2; }
done
printf '{"issue":%s,"taken":false,"hits":[],"unknown":[]}\\n' "$1"
`;

const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: gitEnv() });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

// `blockedBy` becomes a `## Blocked by` list in the body — the shape
// to-tickets publishes — so the real candidates.mjs extracts `d` from it.
const issue = (number, blockedBy = []) => ({
  number,
  title: `t${number}`,
  labels: [{ name: "ready-for-agent" }],
  body: blockedBy.length ? `## Blocked by\n\n${blockedBy.map((b) => `- #${b}`).join("\n")}\n` : "",
});

// One throwaway workspace: a git repository (the run's workspace), a
// directory of scripts (shortlist.mjs and what it reaches), and a bin/ holding
// the gh stub. realpath, because on macOS tmpdir() sits behind a symlink and
// git answers --git-common-dir with the resolved path.
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "shortlist-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
  const scripts = join(root, "scripts");
  mkdirSync(scripts);
  for (const f of COPIED) copyFileSync(join(HERE, f), join(scripts, f));
  writeFileSync(join(scripts, "inflight.sh"), INFLIGHT_STUB);
  const bin = join(root, "bin");
  mkdirSync(bin);
  const gh = join(bin, "gh");
  writeFileSync(gh, GH_STUB);
  chmodSync(gh, 0o755);
  // The first exec of a freshly written executable pays an OS scan that
  // ledger.test.mjs measured at seconds under fleet load (#1199); pay it here,
  // outside the bound shortlist.mjs puts on each gh probe.
  spawnSync(gh, ["--fleet-warm"], { timeout: 30_000 });
  const issuesFile = join(root, "issues.json");
  const statesFile = join(root, "states.json");
  const shortlistFile = join(repo, ".fleet", "shortlist.json");

  return {
    root, repo, shortlistFile,
    run({ issues = [], states = {}, env = {}, cwd = repo, args = [] } = {}) {
      writeFileSync(issuesFile, JSON.stringify(issues));
      writeFileSync(statesFile, JSON.stringify({ issue: {}, pr: {}, ...states }));
      const r = spawnSync(process.execPath, [join(scripts, "shortlist.mjs"), ...args], {
        cwd, encoding: "utf8",
        env: {
          ...gitEnv(), PATH: `${bin}:${process.env.PATH}`,
          FIXTURE_ISSUES: issuesFile, FIXTURE_STATES: statesFile, ...env,
        },
      });
      return r;
    },
    // Written by the real ledger.mjs, into the real default ledger the
    // workspace resolves — the same file shortlist.mjs has to find.
    row(ticket, text) {
      const r = spawnSync(process.execPath, [join(scripts, "ledger.mjs"), "row", String(ticket), text], {
        cwd: repo, encoding: "utf8", env: gitEnv(),
      });
      assert.equal(r.status, 0, `ledger.mjs row ${ticket}: ${r.stderr}`);
    },
    written() {
      return JSON.parse(readFileSync(shortlistFile, "utf8"));
    },
  };
}

const numbers = (payload) => payload.shortlist.map((e) => e.n);
const ok = (r) => assert.equal(r.status, 0, `exit ${r.status}\n${r.stderr}`);

test("writes the oldest-first survivors and the scanned count to .fleet/shortlist.json", (t) => {
  const f = fixture(t);
  const r = f.run({ issues: [issue(1720), issue(1701), issue(1710)] });
  ok(r);
  assert.deepEqual(f.written(), {
    scanned: 3,
    shortlist: [{ n: 1701, t: "t1701" }, { n: 1710, t: "t1710" }, { n: 1720, t: "t1720" }],
  });
  // stdout is the same payload, plus where it was written.
  assert.deepEqual(JSON.parse(r.stdout), { file: f.shortlistFile, ...f.written() });
});

test("a linked worktree writes the workspace's one shortlist, not a copy of its own", (t) => {
  const f = fixture(t);
  const wt = join(f.repo, ".worktrees", "1701-x");
  git(f.repo, "worktree", "add", "-q", "-b", "x", wt);
  const r = f.run({ issues: [issue(1701)], cwd: wt });
  ok(r);
  assert.deepEqual(numbers(f.written()), [1701]);
  assert.equal(existsSync(join(wt, ".fleet", "shortlist.json")), false, "the worktree grew its own shortlist");
});

test("an ambient GIT_DIR naming another repository cannot move the shortlist there", (t) => {
  const f = fixture(t);
  const other = join(f.root, "other");
  mkdirSync(other);
  git(other, "init", "-q");
  const r = f.run({ issues: [issue(1701)], env: { GIT_DIR: join(other, ".git") } });
  ok(r);
  assert.deepEqual(numbers(f.written()), [1701]);
  assert.equal(existsSync(join(other, ".fleet")), false, "the shortlist followed GIT_DIR into another repository");
});

test("dependency scan: an open blocker drops the ticket; a closed or merged one does not", (t) => {
  const f = fixture(t);
  const r = f.run({
    issues: [
      issue(1701, [50]), // open issue
      issue(1702, [51]), // closed issue
      issue(1703, [52]), // merged PR — `gh issue view` answers a PR's state too
      issue(1704, [53]), // state unreadable
      issue(1705, [1707]), // blocked by another candidate, which is open by construction
      issue(1706, [1706]), // names itself: not a blocker
      issue(1707),
    ],
    states: { issue: { 50: "OPEN", 51: "CLOSED", 52: "MERGED", 53: "FAIL" } },
  });
  ok(r);
  assert.deepEqual(f.written(), {
    scanned: 7,
    shortlist: [1702, 1703, 1706, 1707].map((n) => ({ n, t: `t${n}` })),
  });
  assert.match(r.stderr, /#1701 dropped — open blocker #50\b/);
  assert.match(r.stderr, /#1704 dropped — blocker #53's state could not be read/);
  assert.match(r.stderr, /#1705 dropped — open blocker #1707\b/);
});

test("inflight.sh exit 1 (taken) and exit 2 (unanswered) drop the ticket; exit 2 is logged by number", (t) => {
  const f = fixture(t);
  const r = f.run({
    issues: [issue(1701), issue(1702), issue(1703), issue(1704), issue(1705)],
    // The probes run concurrently and 1701 and 1703 answer last, so verdicts
    // gathered in completion order rather than candidate order either hand
    // 1701's `taken` to a free ticket or put 1703 at the tail — both red.
    env: { INFLIGHT_TAKEN: "1701", INFLIGHT_UNKNOWN: "1702", INFLIGHT_SLOW: "1701 1703" },
  });
  ok(r);
  assert.deepEqual(numbers(f.written()), [1703, 1704, 1705]);
  assert.equal(f.written().scanned, 5);
  assert.match(r.stderr, /#1701 dropped — taken \(inflight\.sh exit 1/);
  assert.match(r.stderr, /#1702 dropped — in-flight check could not answer \(inflight\.sh exit 2\): gh pr list failed/);
});

test("a live exclusion drops the ticket, and it re-enters in its oldest-first slot once the premise closes", (t) => {
  const f = fixture(t);
  f.row(1702, "excluded · behind-pr:#60");
  f.row(1703, "excluded · behind-pr:#62");
  f.row(1704, "excluded · behind-issue:#61");
  const issues = [1701, 1702, 1703, 1704, 1705].map((n) => issue(n));

  const held = f.run({ issues, states: { pr: { 60: "OPEN", 62: "CLOSED" }, issue: { 61: "OPEN" } } });
  ok(held);
  // An abandoned (CLOSED, unmerged) PR lifts a behind-pr premise as surely
  // as a merge does, so #1703 is admitted from the start.
  assert.deepEqual(numbers(f.written()), [1701, 1703, 1705]);
  assert.equal(f.written().scanned, 5);
  assert.match(held.stderr, /#1702 dropped — excluded · behind-pr:#60, which is OPEN/);
  assert.match(held.stderr, /#1704 dropped — excluded · behind-issue:#61, which is OPEN/);

  const lifted = f.run({ issues, states: { pr: { 60: "MERGED", 62: "CLOSED" }, issue: { 61: "CLOSED" } } });
  ok(lifted);
  assert.deepEqual(numbers(f.written()), [1701, 1702, 1703, 1704, 1705]);
  assert.match(lifted.stderr, /#1702 lifted — behind-pr:#60 is MERGED/);
  assert.match(lifted.stderr, /#1704 lifted — behind-issue:#61 is CLOSED/);
});

// The other half of the exclusion rule: what it must ADMIT. Only a row whose
// text opens with `excluded` is an exclusion, and a premise may name the
// branch a PR is not yet open for (ADR 0013 §3), which gh resolves by name.
test("only an `excluded` row excludes; a branch premise resolves through gh pr view; an unreadable premise stands", (t) => {
  const f = fixture(t);
  f.row(1701, "impl-1701 · class=routine");
  f.row(1702, "excluded · behind-pr:#implementer/1690-slug");
  f.row(1703, "excluded · behind-pr:#implementer/1691-slug");
  f.row(1704, "excluded · collides with something, no premise recorded");
  f.row(1705, "impl-1705 · previously excluded · behind-pr:#60");
  f.row(9999, "excluded · behind-pr:#60");
  const r = f.run({
    issues: [1701, 1702, 1703, 1704, 1705, 1706].map((n) => issue(n)),
    // No entry for implementer/1691-slug: gh answers "no pull requests found",
    // which is a premise nobody could read, not one that closed.
    states: { pr: { "implementer/1690-slug": "MERGED", 60: "OPEN" } },
  });
  ok(r);
  assert.deepEqual(numbers(f.written()), [1701, 1702, 1705, 1706]);
  assert.match(r.stderr, /#1702 lifted — behind-pr:#implementer\/1690-slug is MERGED/);
  assert.match(r.stderr, /#1703 dropped — excluded · behind-pr:#implementer\/1691-slug, whose state could not be read/);
  assert.match(r.stderr, /#1704 dropped — excluded with no behind-pr:\/behind-issue: premise/);
});

test("an empty queue is an answer: exit 0, and the file says so", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.repo, ".fleet"));
  writeFileSync(f.shortlistFile, JSON.stringify({ scanned: 1, shortlist: [{ n: 1, t: "stale" }] }));
  const r = f.run({ issues: [] });
  ok(r);
  assert.deepEqual(f.written(), { scanned: 0, shortlist: [] });
});

// Every refusal leaves the previous file exactly as it was: an empty
// shortlist written in its place would read as "no work" to the tick.
test("a failed scan, an unreadable ledger or a stray argument refuses at exit 2 and leaves the file untouched", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.repo, ".fleet"));
  const before = JSON.stringify({ scanned: 1, shortlist: [{ n: 1701, t: "t1701" }] });
  writeFileSync(f.shortlistFile, before);
  const issues = [issue(1701)];

  const scan = f.run({ issues, env: { ISSUE_LIST_FAIL: "1" } });
  assert.equal(scan.status, 2, scan.stderr);
  assert.match(scan.stderr, /shortlist: candidates\.mjs exited 2/);
  assert.equal(readFileSync(f.shortlistFile, "utf8"), before);

  const stray = f.run({ issues, args: ["--bogus"] });
  assert.equal(stray.status, 2, stray.stderr);
  assert.match(stray.stderr, /shortlist: takes no arguments, got --bogus/);
  assert.equal(readFileSync(f.shortlistFile, "utf8"), before);

  if (process.getuid?.() === 0) return t.skip("root reads a mode-000 file, so the ledger refusal cannot be staged");
  f.row(1701, "excluded · behind-pr:#60");
  const ledger = join(f.repo, ".fleet", "ledger.md");
  chmodSync(ledger, 0o000);
  const unread = f.run({ issues, states: { pr: { 60: "OPEN" } } });
  assert.equal(unread.status, 2, unread.stderr);
  assert.match(unread.stderr, /shortlist: ledger\.mjs read exited 2/);
  assert.equal(readFileSync(f.shortlistFile, "utf8"), before);
});
