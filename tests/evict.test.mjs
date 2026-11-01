// `evict.mjs`: the claim trees' Evict, and its `--restore`. Every case runs
// the real script against a throwaway repository: real linked worktrees under
// its `.worktrees/`, a fixture ledger in its `.fleet/`, and, for a restore, a
// Recipe cache whose Install step is a tracked script the case steers through
// its environment. A tree's idle time is its HEAD reflog's: the worktree is
// added under a backdated GIT_COMMITTER_DATE, which is the time git writes
// into that reflog's entry.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { IDLE_MS, REDERIVE, isIdle, liveHolds, rowTickets } from "../plugin/scripts/evict.mjs";
import { EVICTED, RESTORED, restoreCommand } from "../plugin/scripts/evict-mark.mjs";

const SCRIPT = fileURLToPath(new URL("../plugin/scripts/evict.mjs", import.meta.url));
const CLAIM = fileURLToPath(new URL("../plugin/scripts/claim-ticket.sh", import.meta.url));
const DAY = 24 * 60 * 60 * 1000;

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
delete ENV.GIT_DIR;
delete ENV.GIT_WORK_TREE;

const git = (cwd, args, env = {}) =>
  execFileSync("git", ["-c", "maintenance.auto=false", ...args], { cwd, env: { ...ENV, ...env }, encoding: "utf8" }).trim();
const ago = (days) => new Date(Date.now() - days * DAY).toISOString();

// The Install step the Recipe cache names: it logs what `CI` read as, puts the
// dependencies back, and fails or dirties the tree when the case says so.
const INSTALL = `#!/bin/sh
[ -n "\${INSTALL_LOG:-}" ] && printf '%s\\n' "\${CI-unset}" > "$INSTALL_LOG"
mkdir -p node_modules/pkg && echo restored > node_modules/pkg/index.js
[ -n "\${INSTALL_DIRTY:-}" ] && echo dirty >> tracked.txt
exit "\${INSTALL_EXIT:-0}"
`;

function unlock(dir) {
  spawnSync("sh", ["-c", 'chmod -R u+rwx "$1" 2>/dev/null; :', "sh", dir]);
}

// `reftable` makes the repository keep its refs, reflogs included, in git's
// reftable backend rather than in files.
function fixture(t, { reftable = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "evict-")));
  t.after(() => {
    unlock(dir);
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = join(dir, "repo");
  git(dir, ["-c", "init.defaultBranch=main", "init", "-q", ...(reftable ? ["--ref-format=reftable"] : []), repo]);
  writeFileSync(join(repo, ".gitignore"), "node_modules/\ndist/\n*.log\n.fleet/\n");
  writeFileSync(join(repo, "tracked.txt"), "t\n");
  writeFileSync(join(repo, "install.sh"), INSTALL);
  mkdirSync(join(repo, "pkg"));
  writeFileSync(join(repo, "pkg", "keep.txt"), "k\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "root"], { GIT_COMMITTER_DATE: ago(30), GIT_AUTHOR_DATE: ago(30) });
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  // claim-ticket.sh keeps the runner out of every tree's status this way.
  writeFileSync(join(repo, ".git", "info", "exclude"), "agent-test\n");
  mkdirSync(join(repo, ".fleet"));
  const ledgerPath = join(repo, ".fleet", "ledger.md");

  const f = {
    dir, repo, ledgerPath,
    // A claim tree for ticket `n`, its HEAD last moved `days` ago, holding the
    // runner and, with `deps`, what an install leaves.
    claim(n, { days = 8, suffix = "", branch = null, name = null, deps = true } = {}) {
      const slug = `impl-${n}${suffix ? `-${suffix}` : ""}`;
      const wt = join(repo, ".worktrees", name ?? `${n}-${slug}`);
      git(repo, ["worktree", "add", "-q", "-b", branch ?? `implementer/${n}-${slug}`, wt, "main"], { GIT_COMMITTER_DATE: ago(days) });
      writeFileSync(join(wt, "agent-test"), "#!/bin/sh\n");
      if (deps) {
        mkdirSync(join(wt, "node_modules", "pkg"), { recursive: true });
        writeFileSync(join(wt, "node_modules", "pkg", "index.js"), "x");
        mkdirSync(join(wt, "dist"));
        writeFileSync(join(wt, "dist", "out.js"), "x");
        writeFileSync(join(wt, "build.log"), "x");
        mkdirSync(join(wt, "pkg", "node_modules"));
        writeFileSync(join(wt, "pkg", "node_modules", "dep.js"), "x");
      }
      return wt;
    },
    admin: (wt) => git(wt, ["rev-parse", "--absolute-git-dir"]),
    mark: (wt) => join(f.admin(wt), EVICTED),
    ledger(rows = [], dispatched = []) {
      writeFileSync(ledgerPath, [
        "# Fleet run ledger", "", "## Rows", "", ...rows.map((r) => `- ${r}`),
        "", "## Dispatched", "", ...dispatched.map((d) => `- ${d}`),
        "", "## Filed", "", "", "## Ruled", "", "",
      ].join("\n"));
    },
    recipe() {
      writeFileSync(join(repo, ".fleet", "recipe.json"), JSON.stringify({
        install: "sh install.sh", test: "true", check: true, derivedAt: git(repo, ["rev-parse", "HEAD"]),
        installClean: true, testCount: 1, uncovered: [],
      }));
    },
    run(args, { cwd = repo, env = {} } = {}) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...ENV, ...env } });
      let json = null;
      if (r.status === 0) json = JSON.parse(r.stdout);
      return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
    },
  };
  return f;
}

const paths = (list) => list.map((e) => e.path).sort();
const reasonOf = (list, path) => list.find((e) => e.path === path)?.reason;

// Every path under `dir`, relative to it, but a `.git` file.
function files(dir) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, n.name);
      if (n.name === ".git") continue;
      out.push(relative(dir, p));
      if (n.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

test("IDLE_MS is seven days", () => {
  assert.equal(IDLE_MS, 7 * DAY);
});

test("dry run: an idle clean claim tree is evicted and nothing on disk changes; every other case is kept with its reason", (t) => {
  const f = fixture(t);
  const idle = f.claim(10);
  const fresh = f.claim(11, { days: 1 });
  const dirty = f.claim(12);
  writeFileSync(join(dirty, "tracked.txt"), "changed\n");
  const rebase = f.claim(13);
  mkdirSync(join(f.admin(rebase), "rebase-merge"));
  writeFileSync(join(f.admin(rebase), "rebase-merge", "head-name"), "refs/heads/implementer/13-impl-13\n");
  const cwd = f.claim(14);
  const impl = f.claim(21);
  const review = f.claim(22);
  const fix = f.claim(23);
  const finisher = f.claim(24);
  const retry = f.claim(25);
  const marked = f.claim(15);
  writeFileSync(f.mark(marked), "then\n");
  const bare = f.claim(16, { deps: false });
  const otherBranch = f.claim(17, { branch: "feature/seventeen" });
  const otherName = f.claim(18, { name: "review-18" });
  f.ledger([
    "#21 impl-21",
    "#22 impl-22=PR#122 review=member:review-pr-122",
    "#23 impl-23=PR#123 fix-pr-123",
    "#24 impl-24=PR#124 finisher-pr-124",
    "#25 impl-25=PR#125 fix-pr-125=applied:abcdef1 fix-pr-125-b",
  ], ["impl-21", "impl-22=PR#122", "impl-23=PR#123", "impl-24=PR#124", "impl-25=PR#125"]);
  const before = files(idle);

  const r = f.run([], { cwd });

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.applied, false);
  assert.equal(r.json.ledger, f.ledgerPath);
  assert.deepEqual(paths(r.json.evicted), [idle]);
  assert.deepEqual(r.json.evicted[0].ignored, ["build.log", "dist/", "node_modules/", "pkg/node_modules/"]);
  assert.match(r.json.evicted[0].reason, /^HEAD last moved .*, over 7 days ago$/);
  assert.deepEqual(files(idle), before, "a dry run changed the tree");
  assert.equal(existsSync(f.mark(idle)), false, "a dry run wrote the mark");
  assert.deepEqual(r.json.failed, []);

  const kept = r.json.kept;
  assert.match(reasonOf(kept, fresh), /^HEAD last moved .*, within 7 days$/);
  assert.match(reasonOf(kept, dirty), /^git status is not clean \(first:  M tracked\.txt\)$/);
  assert.match(reasonOf(kept, rebase), /^a git operation is in progress in it \(rebase-merge\)$/);
  assert.equal(reasonOf(kept, cwd), "this script's own cwd is inside it");
  assert.equal(reasonOf(kept, impl), "held by the live impl-21");
  assert.equal(reasonOf(kept, review), "held by the live review-pr-122 on row #22");
  assert.equal(reasonOf(kept, fix), "held by the live fix-pr-123 on row #23");
  assert.equal(reasonOf(kept, finisher), "held by the live finisher-pr-124 on row #24");
  assert.equal(reasonOf(kept, retry), "held by the live fix-pr-125-b on row #25");
  assert.match(reasonOf(kept, marked), /^already evicted: .*fleet-evicted is there$/);
  assert.equal(reasonOf(kept, bare), "it ignores nothing but agent-test");
  assert.equal(reasonOf(kept, otherBranch), "not a claim tree: it is on feature/seventeen, not implementer/17-impl-17");
  assert.equal(reasonOf(kept, otherName), "not a claim tree: its directory is not named <N>-impl-<N>[-x]");
  assert.deepEqual(paths(kept), [fresh, dirty, rebase, cwd, marked, bare, otherBranch, otherName, impl, review, fix, finisher, retry].sort());
});

test("a live fix-pr-<M> on a fold-in row closing #N keeps tree N alone", (t) => {
  const f = fixture(t);
  const held = f.claim(31);
  const free = f.claim(32);
  f.ledger(["#130 PR#130 · inherited (closes #31) fix-pr-130"], ["fix-pr-130"]);

  const r = f.run([]);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(reasonOf(r.json.kept, held), "held by the live fix-pr-130 on row #130");
  assert.deepEqual(paths(r.json.evicted), [free]);
});

test("a live token on a row that closes no issue, or only issues with no claim tree here, keeps every candidate", (t) => {
  for (const row of ["#140 PR#140 · inherited (closes no issue) review=member:review-pr-140", "#150 PR#150 · inherited (closes #999) fix-pr-150"]) {
    const f = fixture(t);
    const a = f.claim(41);
    const b = f.claim(42);
    f.ledger([row]);

    const r = f.run([]);

    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.json.evicted, [], row);
    for (const wt of [a, b]) assert.match(reasonOf(r.json.kept, wt), /names no ticket with a claim tree here, so the tree its member works in cannot be told$/, row);
  }
});

test("a live merge bot, a settled member and a workflow review hold no claim tree", (t) => {
  const f = fixture(t);
  const wt = f.claim(43);
  f.ledger(["#43 impl-43=PR#143 review=wf:run123 fix-pr-143=no-op"], ["merge-bot-3", "impl-43=PR#143"]);

  const r = f.run([]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.json.evicted), [wt], JSON.stringify(r.json.kept));
});

test("rowTickets and liveHolds: a ticket row, a fold-in row, and a token on no row", () => {
  assert.deepEqual(rowTickets("#12 impl-12=PR#40 fix-pr-40"), [12]);
  assert.deepEqual(rowTickets("#40 PR#40 · inherited (closes #12, #13) fix-pr-40"), [12, 13]);
  assert.deepEqual(rowTickets("#40 PR#40 · inherited (closes no issue)"), []);
  const holds = liveHolds(["#40 PR#40 · inherited (closes #12, #13) fix-pr-40"], [], new Set([12, 13]));
  assert.equal(holds.all, null);
  assert.deepEqual([...holds.byTicket.keys()], [12, 13]);
  const nowhere = liveHolds([], ["finisher-pr-50"], new Set([12]));
  assert.match(nowhere.all, /^held by the live finisher-pr-50, which is on no row/);
  const own = liveHolds([], ["impl-12-b"], new Set());
  assert.equal(own.all, null, "an implementer's own tree is told by its name");
  assert.equal(own.byTicket.get(12), "held by the live impl-12-b");
});

test("--apply removes every ignored path but the runner, leaves tracked files, HEAD, the branch and the registration, and writes the mark", (t) => {
  const f = fixture(t);
  const wt = f.claim(50);
  mkdirSync(join(wt, "node_modules", "pkg", "locked"));
  writeFileSync(join(wt, "node_modules", "pkg", "locked", "f"), "x");
  chmodSync(join(wt, "node_modules", "pkg", "locked"), 0o000);
  f.ledger([]);
  const head = git(wt, ["rev-parse", "HEAD"]);
  const branch = git(wt, ["symbolic-ref", "HEAD"]);
  const status = git(wt, ["status", "--porcelain", "-uall"]);

  const r = f.run(["--apply"]);

  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.applied, true);
  assert.deepEqual(paths(r.json.evicted), [wt]);
  assert.deepEqual(r.json.failed, []);
  assert.deepEqual(files(wt), [".gitignore", "agent-test", "install.sh", "pkg", "pkg/keep.txt", "tracked.txt"]);
  assert.equal(git(wt, ["rev-parse", "HEAD"]), head);
  assert.equal(git(wt, ["symbolic-ref", "HEAD"]), branch);
  assert.equal(git(wt, ["status", "--porcelain", "-uall"]), status);
  assert.ok(git(f.repo, ["worktree", "list", "--porcelain"]).includes(`worktree ${wt}`), "the registration went");
  assert.ok(existsSync(f.mark(wt)), "no mark");

  const again = f.run(["--apply"]);
  assert.match(reasonOf(again.json.kept, wt), /^already evicted/);
});

test("--apply: a tree a path of which cannot be removed is named in failed and keeps its mark", (t) => {
  const f = fixture(t);
  const wt = f.claim(51);
  f.ledger([]);
  chmodSync(wt, 0o555);

  const r = f.run(["--apply"]);
  chmodSync(wt, 0o755);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json.evicted, []);
  assert.deepEqual(paths(r.json.failed), [wt]);
  assert.match(r.json.failed[0].error, /^could not remove /);
  assert.ok(existsSync(f.mark(wt)));
});

test("a missing ledger refuses without --after-rotate and reads as no live token with it", (t) => {
  const f = fixture(t);
  const wt = f.claim(52);

  const refused = f.run(["--apply"]);
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /no \.fleet\/ledger\.md — .*nothing is evicted; pass --after-rotate only straight after `ledger\.mjs rotate`/);
  assert.ok(existsSync(join(wt, "node_modules")), "a refusal removed something");

  const r = f.run(["--after-rotate"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json.ledger, null);
  assert.deepEqual(paths(r.json.evicted), [wt]);
});

test("a ledger that is there but cannot be read refuses, even under --after-rotate", (t) => {
  const f = fixture(t);
  f.claim(53);
  mkdirSync(f.ledgerPath);

  const r = f.run(["--after-rotate"]);

  assert.equal(r.status, 2);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /nothing is evicted/);
});

test("an ambient GIT_DIR and GIT_WORK_TREE naming another repository do not change what is judged or removed", (t) => {
  const f = fixture(t);
  const wt = f.claim(54);
  f.ledger([]);
  const other = join(f.dir, "other");
  git(f.dir, ["init", "-q", other]);

  const r = f.run(["--apply"], { env: { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other } });

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.json.evicted), [wt]);
  assert.equal(existsSync(join(wt, "node_modules")), false);
  assert.ok(existsSync(f.mark(wt)));
});

test("the sweep takes no stray argument and no unknown flag", (t) => {
  const f = fixture(t);
  f.ledger([]);
  assert.equal(f.run(["extra"]).status, 2);
  assert.equal(f.run(["--bogus"]).status, 2);
});

// --- restore -----------------------------------------------------------------

function evicted(t) {
  const f = fixture(t);
  f.recipe();
  const wt = f.claim(60);
  f.ledger([]);
  const r = f.run(["--apply"]);
  assert.deepEqual(paths(r.json.evicted), [wt], r.stderr);
  return { f, wt, log: join(f.dir, "install.log") };
}

test("--restore --apply runs the Install step with CI unset, clears the mark and records the restore time", (t) => {
  const { f, wt, log } = evicted(t);

  const r = f.run(["--restore", wt, "--apply"], { env: { CI: "1", INSTALL_LOG: log } });

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json, { applied: true, worktree: wt, install: "sh install.sh" });
  assert.equal(readFileSync(log, "utf8"), "unset\n");
  assert.equal(readFileSync(join(wt, "node_modules", "pkg", "index.js"), "utf8"), "restored\n");
  assert.equal(existsSync(f.mark(wt)), false);
  const at = Date.parse(readFileSync(join(f.admin(wt), RESTORED), "utf8").trim());
  assert.ok(Date.now() - at < 60_000, "no fresh restore time");
});

test("--restore without --apply runs nothing and names the command", (t) => {
  const { f, wt, log } = evicted(t);

  const r = f.run(["--restore", wt], { env: { INSTALL_LOG: log } });

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.json, { applied: false, worktree: wt, install: "sh install.sh" });
  assert.equal(existsSync(log), false);
  assert.ok(existsSync(f.mark(wt)));
});

test("a restore whose install fails, does not run, or dirties the tree refuses with the claim's words and leaves the mark", (t) => {
  const cases = [
    [{ INSTALL_EXIT: "1" }, (wt) => `install failed in ${wt} (exit 1)`],
    [{ INSTALL_EXIT: "127" }, (wt) => `the Install step 'sh install.sh' did not run in ${wt} (exit 127: not executable or not found) — ${REDERIVE}`],
    [{ INSTALL_EXIT: "126" }, (wt) => `the Install step 'sh install.sh' did not run in ${wt} (exit 126: not executable or not found) — ${REDERIVE}`],
    [{ INSTALL_DIRTY: "1" }, (wt) => `the Install step 'sh install.sh' changed the tree in ${wt} (first:  M tracked.txt) — ${REDERIVE}`],
  ];
  for (const [env, said] of cases) {
    const { f, wt } = evicted(t);

    const r = f.run(["--restore", wt, "--apply"], { env });

    assert.equal(r.status, 2, JSON.stringify(env));
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `\nevict: ${said(wt)}\n`);
    assert.ok(existsSync(f.mark(wt)), `${JSON.stringify(env)} took the mark`);
    assert.equal(existsSync(join(f.admin(wt), RESTORED)), false);
  }
});

test("a restore of a tree already dirty before it refuses before the Install step runs, blaming no Recipe", (t) => {
  const { f, wt, log } = evicted(t);
  writeFileSync(join(wt, "tracked.txt"), "changed\n");

  for (const args of [["--restore", wt, "--apply"], ["--restore", wt]]) {
    const r = f.run(args, { env: { INSTALL_LOG: log } });

    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.equal(r.stderr, `\nevict: ${wt} is not clean before the restore (first:  M tracked.txt) — the Install step did not run; clear that change, then restore again\n`);
    assert.equal(existsSync(log), false, "the Install step ran");
    assert.ok(existsSync(f.mark(wt)), `${args.join(" ")} took the mark`);
    assert.equal(existsSync(join(f.admin(wt), RESTORED)), false);
  }
});

test("a restore whose mark cannot be removed says the restore time was recorded and the mark stays", (t) => {
  const { f, wt } = evicted(t);
  rmSync(f.mark(wt));
  mkdirSync(f.mark(wt));

  const r = f.run(["--restore", wt, "--apply"]);

  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stdout, "");
  const restored = join(f.admin(wt), RESTORED);
  assert.ok(r.stderr.startsWith(`\nevict: installed in ${wt} and recorded the restore in ${restored}, but could not remove the mark ${f.mark(wt)} (`), r.stderr);
  assert.match(r.stderr, /\) — the mark stays\n$/);
  assert.ok(existsSync(restored), "no restore time");
  assert.ok(existsSync(f.mark(wt)));
});

test("REDERIVE is claim-ticket.sh's own refusal, word for word", () => {
  const line = readFileSync(CLAIM, "utf8").split("\n").find((l) => l.startsWith("rederive="));
  assert.equal(line, `rederive="${REDERIVE}"`);
});

test("the restore command keeps a tree path with a space or a quote in it one word", () => {
  for (const tree of ["/Users/x/My Projects/repo/.worktrees/7-impl-7", "/tmp/it's/.worktrees/8-impl-8", "/tmp/plain/.worktrees/9-impl-9"]) {
    const cmd = restoreCommand(tree).replace("~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run", "printf '[%s]\\n'");
    assert.equal(execFileSync("sh", ["-c", cmd], { encoding: "utf8" }), `[evict.mjs]\n[--restore]\n[${tree}]\n[--apply]\n`, cmd);
  }
  assert.equal(restoreCommand("/tmp/plain/.worktrees/9-impl-9"), "~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run evict.mjs --restore /tmp/plain/.worktrees/9-impl-9 --apply");
});

test("--restore refuses a tree that is not evicted, a relative path, and --after-rotate", (t) => {
  const f = fixture(t);
  f.recipe();
  const wt = f.claim(61);
  const unmarked = f.run(["--restore", wt, "--apply"]);
  assert.equal(unmarked.status, 2);
  assert.match(unmarked.stderr, /is not evicted .* nothing to restore/);
  assert.equal(f.run(["--restore", "relative/tree"]).status, 2);
  assert.match(f.run(["--restore", wt, "--after-rotate"]).stderr, /--after-rotate is the sweep's/);
});

test("a restored tree whose HEAD last moved 8 days ago is kept until 7 days after its restore", (t) => {
  const { f, wt } = evicted(t);
  assert.equal(f.run(["--restore", wt, "--apply"]).status, 0);

  const kept = f.run([]);
  assert.match(reasonOf(kept.json.kept, wt), /^restored .*, within 7 days$/);

  writeFileSync(join(f.admin(wt), RESTORED), `${ago(8)}\n`);
  const due = f.run([]);
  assert.deepEqual(paths(due.json.evicted), [wt]);
  assert.match(due.json.evicted[0].reason, /^(restored|HEAD last moved) .*, over 7 days ago$/);
});

test("a tree whose HEAD reflog is empty is judged by HEAD's commit date", (t) => {
  const f = fixture(t);
  const old = f.claim(63, { days: 1 });
  const young = f.claim(64, { days: 1 });
  git(young, ["commit", "-q", "--allow-empty", "-m", "young"], { GIT_COMMITTER_DATE: ago(2) });
  for (const wt of [old, young]) writeFileSync(join(f.admin(wt), "logs", "HEAD"), "");
  f.ledger([]);

  const r = f.run([]);

  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths(r.json.evicted), [old], "the root commit is 30 days old");
  assert.match(reasonOf(r.json.kept, young), /^HEAD last moved .*, within 7 days$/);
});

test("in a reftable repository a tree is judged by its HEAD reflog too, not by HEAD's commit date", (t) => {
  const probe = mkdtempSync(join(tmpdir(), "evict-reftable-"));
  t.after(() => rmSync(probe, { recursive: true, force: true }));
  const can = spawnSync("git", ["init", "-q", "--ref-format=reftable", probe], { env: ENV });
  if (can.status !== 0) {
    t.skip(`this git makes no reftable repository: ${String(can.stderr).trim()}`);
    return;
  }
  const f = fixture(t, { reftable: true });
  const fresh = f.claim(65, { days: 1 });
  const idle = f.claim(66, { days: 8 });
  f.ledger([]);
  assert.equal(existsSync(join(f.admin(fresh), "logs", "HEAD")), false, "the fixture keeps a files reflog");

  const r = f.run([]);

  assert.equal(r.status, 0, r.stderr);
  assert.match(reasonOf(r.json.kept, fresh), /^HEAD last moved .*, within 7 days$/, "the root commit is 30 days old");
  assert.deepEqual(paths(r.json.evicted), [idle]);
  const at = Date.parse(/^HEAD last moved (\S+), over 7 days ago$/.exec(r.json.evicted[0].reason)[1]);
  assert.ok(Math.abs(at - (Date.now() - 8 * DAY)) < 60 * 60 * 1000, `judged by ${new Date(at).toISOString()}, not by the reflog's 8 days`);
});

test("a restore at the very second HEAD last moved is named a restore", (t) => {
  const f = fixture(t);
  const wt = f.claim(67);
  f.ledger([]);
  const newest = readFileSync(join(f.admin(wt), "logs", "HEAD"), "utf8").trim().split("\n").at(-1);
  const sec = Number(/ ([0-9]+) [+-][0-9]{4}\t/.exec(newest)[1]);
  writeFileSync(join(f.admin(wt), RESTORED), `${new Date(sec * 1000).toISOString()}\n`);

  const r = f.run([]);

  assert.deepEqual(paths(r.json.evicted), [wt], r.stderr);
  assert.equal(r.json.evicted[0].reason, `restored ${new Date(sec * 1000).toISOString()}, over 7 days ago`);
});

test("a tree is idle once exactly IDLE_MS have passed, and not a millisecond before", () => {
  const now = Date.now();
  assert.equal(isIdle(now, now - IDLE_MS), true);
  assert.equal(isIdle(now, now - IDLE_MS + 1), false);
});

test("a restore time that cannot be read keeps the tree", (t) => {
  const f = fixture(t);
  const wt = f.claim(62);
  f.ledger([]);
  writeFileSync(join(f.admin(wt), RESTORED), "not a time\n");

  const r = f.run([]);

  assert.match(reasonOf(r.json.kept, wt), /fleet-restored holds no time/);
});
