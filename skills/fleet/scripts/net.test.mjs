// Regression gate for net.sh, the fleet's bounded, prompt-suppressed git
// transport: `node --test skills/fleet/scripts/net.test.mjs`.
//
// The mechanism's END-TO-END cases live in inflight.test.mjs, against probe 2 —
// the accept-then-silent listener, the slow-but-working transport that must NOT
// be killed, the `ps`-shimmed degraded kill, the mktemp-less fallback. They
// stayed there when the mechanism moved here (#347), because they exercise it
// through a caller and a caller is what they measure. This file holds what has
// no caller to reach it: the two closures that decide WHICH pids are signalled
// and WHAT budget a call gets.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "net.sh");

// net_kill_tree's awk closure has no other test at its own level: the cases
// that reach it in inflight.test.mjs do so only by letting a real fetch hang,
// which is slow and, worse, blind to the thing the `do { … } while (grew)` loop
// exists for. Measured — collapsing that loop to a single pass still kills the
// whole subtree when `ps` prints parents before children, which is what `ps -A`
// does on an ordinary machine, so every end-to-end case there stays green on the
// mutant. Only a canned table with a child row AHEAD of its parent (the shape
// pid wraparound produces) discriminates, and only this test feeds one.
//
// The function is lifted out of net.sh by its own braces rather than
// re-typed, so this cannot drift into testing a copy. `ps` is shadowed on PATH
// the way inflight.test.mjs's own fork-failure cases shadow theirs; `kill` has
// to be a shell FUNCTION instead, because it is a builtin and a file on PATH is
// never consulted. The `-9` escalation is dropped on the floor — the set is
// what is under test, and it is the same set both signals go to.
const killTreeOn = (t, table, root) => {
  const dir = mkdtempSync(join(tmpdir(), "net-killtree-"));
  t.after(() => execFileSync("rm", ["-rf", dir]));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "ps"), `#!/bin/sh\ncat '${join(dir, "table")}'\n`);
  chmodSync(join(bin, "ps"), 0o755);
  writeFileSync(join(dir, "table"), table);

  const body = readFileSync(SCRIPT, "utf8").match(/^net_kill_tree\(\) \{\n[\s\S]*?^\}$/m);
  assert.ok(body, "net_kill_tree() is no longer a top-level function in net.sh — update this test");
  writeFileSync(join(dir, "fn.sh"), body[0]);

  const r = spawnSync("sh", ["-c",
    `kill() { [ "$1" = -9 ] || printf '%s\\n' "$*"; }\n. '${join(dir, "fn.sh")}'\nnet_kill_tree ${root}`],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, `net_kill_tree exited non-zero: ${JSON.stringify(r)}`);
  return r.stdout.trim().split(/\s+/).filter(Boolean).sort((a, b) => a - b);
};

test("net_kill_tree signals the whole subtree, however the snapshot is ordered", (t) => {
  assert.deepEqual(killTreeOn(t, "100 1\n200 100\n300 200\n400 1\n", 100), ["100", "200", "300"],
    "a chain two levels deep, parents first");
  assert.deepEqual(killTreeOn(t, "300 200\n200 100\n100 1\n400 1\n", 100), ["100", "200", "300"],
    "the same chain with every child ahead of its parent — the case a single-pass walk gets wrong");
  assert.deepEqual(killTreeOn(t, "500 400\n300 100\n200 100\n100 1\n400 1\n", 100), ["100", "200", "300"],
    "branching, and an unrelated tree that must not be swept in");
  assert.deepEqual(killTreeOn(t, "100 1\n200 1\n", 100), ["100"],
    "a root with no descendants is still signalled");
  assert.deepEqual(killTreeOn(t, "200 1\n300 200\n", 999), ["999"],
    "a root absent from the snapshot falls back to itself, never to nothing");
});


// net_budget is the one piece of net.sh that every caller reaches on its
// healthy path, so a mistake in it is not a stalled-transport edge case — it
// silently changes the bound on all four fetches and the two ls-remotes. The
// three cases inflight.test.mjs drives end-to-end (a value that shortens, one
// that would lengthen, one too large for the shell's integer) are the ones a
// caller can express; the rest are only reachable here.
//
// Sourced rather than re-typed, for the same reason net_kill_tree is lifted by
// its braces: a copy of the rule would go on passing after the rule changed.
// `sh -c` with `set -eu`, because that is what every caller runs under and a
// `$1` this function forgot to default would abort there rather than here.
const budget = (dflt, override) => {
  const r = spawnSync("sh", ["-c",
    `set -eu\n. '${SCRIPT}'\nnet_budget ${dflt} '${override}'`],
    { encoding: "utf8", timeout: 10_000 });
  assert.equal(r.status, 0, `net_budget exited non-zero: ${JSON.stringify(r)}`);
  assert.equal(r.stderr, "", `net_budget wrote to stderr: ${r.stderr}`);
  return r.stdout;
};

test("net_budget takes an override only when it SHORTENS", () => {
  assert.equal(budget(30, ""), "30", "no override: the default stands");
  assert.equal(budget(30, "5"), "5", "below the default: the override is the bound");
  assert.equal(budget(30, "600"), "30",
    "above the default: refused. A knob that could lengthen the budget is one more way for configuration to remove the bound, which is the defect the ssh half of #346 reports");
  assert.equal(budget(30, "30"), "30",
    "equal to the default is not shorter, so nothing changes — and the value reported is still a real one");
});

test("net_budget treats an unusable override as no override, in silence", () => {
  assert.equal(budget(30, "0"), "30", "zero is not a bound, it is a call that may not run at all");
  assert.equal(budget(30, "-5"), "30", "a negative reaches the `*[!0-9]*` arm, never `[ -lt ]`");
  assert.equal(budget(30, "abc"), "30", "so does a word");
  assert.equal(budget(30, "5.5"), "30", "and so does a decimal — `[` reads integers only");
  assert.equal(budget(30, " 5"), "30", "and a value with a space in it, which `[` would otherwise take as 5");
  assert.equal(budget(30, "99999999999999999999"), "30",
    "a digit string too large for the shell's integer takes the `??????*` arm rather than reaching `[`, which on darwin says `integer expression expected` and on the dash that is CI's /bin/sh says `Illegal number` — the assertion on stderr above is what holds that, and it is why both platforms are named");
  assert.equal(budget(30, "029"), "029",
    "five digits or fewer still reach `[`, zero-padded ones included, so 029 IS taken as a bound — and it comes back with its zero on, since the value is echoed rather than renormalised. `sleep 029` and a reported `within 029s` are both the caller asking for 29 seconds and getting them; this pins that the padding is cosmetic, not that it is normalised away");
});

// The control, and the reason this whole mechanism is not simply "kill it
// sooner": a bound that turns a working slow fetch into exit 2 is worse than
// the hang it replaces, because exit 2 is a verdict the controller acts on.
// inflight.test.mjs holds this pair for the `ls-remote` #346 bounded; #347's
// four new callers are FETCHES, which move objects rather than refs and so are
// the ones a budget can plausibly cut short. verify-sha.sh stands in for them
// here — the smallest of the four, and the only one whose contract separates
// `no` (exit 1) from `could not answer` (exit 2), so a false failure cannot
// hide inside the verdict it would corrupt.
//
// The transport is REAL: an ssh stub that sleeps and then serves the fixture's
// own bare repo through `git upload-pack`, so refs genuinely come back. Paired
// with its sensitivity control below, and neither is worth much alone — an
// accept-only case passes just as well against a watchdog that never fires,
// which is to say against no watchdog at all.
const ENV = {
  ...process.env,
  GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_TEMPLATE_DIR: undefined, GIT_INDEX_FILE: undefined,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
};
const git = (cwd, ...args) => execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();

/** Bare origin + clone with one commit on main, reached through a 3s-slow ssh stub. */
function slowRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "net-slow-"));
  t.after(() => execFileSync("rm", ["-rf", root]));
  const origin = join(root, "origin.git");
  const w = join(root, "w");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", "--bare", origin], { env: ENV });
  execFileSync("git", ["clone", "-q", origin, w], { env: ENV });
  git(w, "commit", "-q", "--allow-empty", "-m", "root");
  git(w, "branch", "-M", "main");
  git(w, "push", "-q", "-u", "origin", "main");
  const head = git(w, "rev-parse", "HEAD");

  const stub = join(root, "slow-ssh.sh");
  writeFileSync(stub, `#!/bin/sh\nsleep 3\nexec git upload-pack '${origin}'\n`);
  chmodSync(stub, 0o755);
  // example.invalid is never resolved: GIT_SSH_COMMAND replaces ssh outright.
  // The URL only has to be ssh-SHAPED, which is what routes git to it at all.
  git(w, "remote", "set-url", "origin", "ssh://git@example.invalid/x/y.git");
  return { w, head, stub };
}

test("a fetch that is slow but WORKING keeps its ordinary verdict — the budget is not a stopwatch on success", (t) => {
  const { w, head, stub } = slowRepo(t);
  const r = spawnSync("sh", [join(import.meta.dirname, "verify-sha.sh"), "main", head], {
    cwd: w, encoding: "utf8", timeout: 60_000,
    env: { ...ENV, GIT_SSH_COMMAND: stub, FLEET_NET_TIMEOUT: "20" },
  });

  assert.equal(r.error, undefined, `the run did not come back: ${JSON.stringify(r)}`);
  assert.equal(r.status, 0,
    `the sha really is on the branch and the transport really returned it, so the verdict is `
    + `reachable — exit 2 here would be an outage invented on a link that worked: ${JSON.stringify(r)}`);
  assert.equal(JSON.parse(r.stdout).reachable, true, "and the payload is the one an unbounded fetch produced");
  assert.doesNotMatch(r.stderr, /did not finish within/,
    "and nothing claims a budget elapsed, which is the wording the failure path owns");
});

test("the budget is what spares the slow fetch, not the absence of a watchdog", (t) => {
  const { w, head, stub } = slowRepo(t);
  const r = spawnSync("sh", [join(import.meta.dirname, "verify-sha.sh"), "main", head], {
    cwd: w, encoding: "utf8", timeout: 60_000,
    env: { ...ENV, GIT_SSH_COMMAND: stub, FLEET_NET_TIMEOUT: "1" },
  });

  assert.equal(r.error, undefined, `the run did not come back: ${JSON.stringify(r)}`);
  assert.equal(r.status, 2,
    "under the delay the same transport is cut off, and the answer is `could not answer` — never exit 1, which would report a sha that IS on the branch as missing from it");
  assert.match(r.stderr, /did not finish within 1s and was killed/,
    "and it says the budget elapsed rather than blaming the fetch, which is the one thing the exit status alone cannot distinguish");
  assert.equal(r.stdout, "", "no payload: nothing was answered");
});
