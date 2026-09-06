// #55. `./agent-test` existed only inside a worktree `claim-ticket.sh` had
// freshly claimed; anywhere else it answered `no such file or directory`, which
// is not a red but is shaped like one, and it arrives exactly when someone is
// deciding whether a diff is broken. The repo now tracks a bootstrap at its
// root that materializes the CURRENT runner from the one emitter and execs it,
// rather than carrying a 24 KB copy that would freeze at the commit adding it.
//
// Four properties, each pinning a failure the change would otherwise buy:
// generate-only must not claim, it must emit the claim path's own bytes, the
// claim path must not overwrite the tracked bootstrap, and the bootstrap must
// read its isolation issue from the worktree it stands in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "claim-ticket.sh");
const BOOTSTRAP = join(import.meta.dirname, "..", "..", "..", "agent-test");

function repo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bootstrap-"));
  const git = (...a) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(join(dir, "t.test.mjs"), "");
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  git("add", "-A");
  git("commit", "-qm", "x");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { dir, git };
}

// `--apply` labels the issue, so `gh` is stubbed; the worktree, the install and
// the runner are the real thing.
function ghStub() {
  const bin = mkdtempSync(join(tmpdir(), "bootstrap-bin-"));
  writeFileSync(join(bin, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { ...process.env, PATH: `${bin}:${process.env.PATH}` };
}

test("--write-runner emits a runner and claims nothing", () => {
  // The bootstrap runs this on every single `./agent-test` invocation. If it
  // reached any part of the claim, a test run would label an issue, cut a
  // branch and add a worktree — and print a claim receipt into the shape the
  // ledger reads, reporting a claim that never happened.
  const { dir, git } = repo();
  const dest = join(dir, ".agent-test.sh");
  const r = spawnSync("sh", [SCRIPT, "--write-runner", dest, "42"], { cwd: dir, encoding: "utf8" });

  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.stdout, "", "a claim receipt was printed for a run that claimed nothing");
  assert.match(readFileSync(dest, "utf8"), /^#!\/bin\/sh\n/);
  assert.equal(existsSync(join(dir, ".worktrees")), false, "a worktree was created");
  // The positional rewrite hands the claim path a slug, so the branch it would
  // have cut has a name — that name is what must not exist.
  assert.equal(git("branch", "--list", "fix/42-write-runner").toString().trim(), "", "a branch was created");
  // The claim path's own runner-write adds `agent-test` to `.git/info/exclude`
  // — but only when it wrote the runner itself. `--write-runner`'s $dest is
  // its own artifact, not a claim mutation, so that line must not appear.
  const exclude = join(dir, ".git", "info", "exclude");
  assert.equal(
    existsSync(exclude) && readFileSync(exclude, "utf8").includes("agent-test"),
    false,
    ".git/info/exclude was mutated by a generate-only run",
  );
});

test("--write-runner emits the claim path's own runner, byte for byte", () => {
  // The whole argument for tracking a bootstrap instead of a copy is that
  // there is ONE emitter. A generate-only mode that produced its own variant
  // would be the second copy again, just further from where anyone would look
  // for it. Same issue number on both sides, so even the isolation triple has
  // to agree.
  const claimed = repo();
  spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], { cwd: claimed.dir, encoding: "utf8", env: ghStub() });
  const generated = repo();
  const dest = join(generated.dir, ".agent-test.sh");
  spawnSync("sh", [SCRIPT, "--write-runner", dest, "42"], { cwd: generated.dir, encoding: "utf8" });

  assert.equal(
    readFileSync(dest, "utf8"),
    readFileSync(join(claimed.dir, ".worktrees", "42-slug", "agent-test"), "utf8"),
  );
});

test("a claim leaves a runner the checkout already tracks alone", () => {
  // The strand guard. A tracked `agent-test` is checked out into every
  // worktree `git worktree add` creates, so a claim that overwrote it would
  // leave a MODIFIED TRACKED path — and `reap.sh` calls `git worktree remove`
  // without `--force`, which refuses on exactly that. Every release of every
  // claim would strand on a file the claim script wrote itself.
  const committed = "#!/bin/sh\n# tracked bootstrap\nexit 7\n";
  const { dir } = repo({ "agent-test": committed });
  const r = spawnSync("sh", [SCRIPT, "42", "slug", "fix", "--apply"], { cwd: dir, encoding: "utf8", env: ghStub() });
  assert.equal(r.status, 0, r.stdout + r.stderr);

  const wt = join(dir, ".worktrees", "42-slug");
  assert.equal(readFileSync(join(wt, "agent-test"), "utf8"), committed);
  assert.equal(
    execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" }).trim(),
    "",
    "the claim left the worktree dirty — `git worktree remove` will refuse it and the release strands",
  );
});

test("the bootstrap reads its isolation issue from the worktree it stands in", () => {
  // Ports derive from the issue number so that concurrent claims cannot
  // collide, and the tracked bootstrap cannot carry one baked in — being
  // identical in every worktree is the whole reason it is not a modified
  // tracked path. The worktree's own directory name is where that number
  // already lives. Anything else is 0: the main checkout and any clone, which
  // share a stack with no claim.
  // The emitter is stubbed to record its arguments — this pins the derivation,
  // not the emission, which the tests above already cover.
  for (const [dirname, expected] of [["77-some-slug", "77"], ["claude", "0"], ["0755-slug", "0"]]) {
    const home = mkdtempSync(join(tmpdir(), "bootstrap-wt-"));
    const root = join(home, dirname);
    mkdirSync(join(root, "skills", "fleet", "scripts"), { recursive: true });
    writeFileSync(
      join(root, "skills", "fleet", "scripts", "claim-ticket.sh"),
      '#!/bin/sh\nprintf "#!/bin/sh\\nprintf %%s %s\\n" "$3" > "$2"\nchmod +x "$2"\n',
      { mode: 0o755 },
    );
    writeFileSync(join(root, "agent-test"), readFileSync(BOOTSTRAP, "utf8"), { mode: 0o755 });

    const r = spawnSync(join(root, "agent-test"), [], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, expected, `${dirname} derived the wrong issue`);
  }
});
