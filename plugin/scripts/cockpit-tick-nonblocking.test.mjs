// #1713: the cockpit answers HTTP — `/board.json` included — while a tick is
// computing, and a relaunch that lands mid-tick therefore recognises it and
// reuses it instead of starting a duplicate.
//
// The defect this pins was a TIMING one, not a missing handshake. serve()
// ticked in-process on a timer and gather() read `gh`, `ledger.mjs` and
// `ci-state.mjs` through execFileSync, so for the 4.72–4.91s a board took to
// build (measured, #1713) the process answered nothing at all. A second
// launch's identity probe is PROBE_TIMEOUT_MS with one retry — ~2s in total —
// so a probe that landed inside a tick timed out, read the port as FOREIGN,
// stepped to the next candidate and started a second cockpit on the same
// workspace's `.fleet` directory. That is the duplicate #1585/#1660 exist to
// prevent, reached by a clock rather than by a missing payload, at a rate of
// roughly (4.8 − 2) / 15 relaunches.
//
// A separate file rather than more of board.test.mjs, for the reason
// board-identity.test.mjs and board-prev-shape.test.mjs both give: the fleet
// runs several implementers at once and two PRs appending to one test file
// conflict, which costs the PR its CI entirely.
//
// The DERIVED port, not `--port 0`: the reuse handshake is gated on
// `instance.derived` (an operator-chosen port never handshakes, by design),
// so an ephemeral bind cannot reach the behaviour under test at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, rmSync, realpathSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCockpitInstance, cockpitPorts, probeCockpitWorkspace } from "./board.mjs";
import { gitEnv } from "./git-env.mjs";

const SCRIPT = fileURLToPath(new URL("./board.mjs", import.meta.url));

// Long enough that the whole assertion window below — a probe bounded at 1s
// plus a second `node board.mjs serve` that has to start, resolve its
// workspace, fail a bind and handshake — sits comfortably inside one `gh`
// call, and far past the ~2s a probe spends before it gives up. The ticket
// names 5s for exactly that arithmetic.
const GH_SLEEP_S = 5;

// Only `gh issue list` is slowed, which is gather()'s FIRST gh read: that puts
// the block at a known point in the tick rather than spreading it over three
// calls, so the marker below means "inside gather()" and not merely "somewhere
// in a tick". Everything else fails immediately — tryRun catches and degrades,
// so the board still builds and nothing here touches the network.
//
// `/bin/sleep` by absolute path and `:` (a shell builtin) for the marker: PATH
// is stripped to the shim directory, so a bare `sleep` or a `touch` would fail
// ENOENT and the stub would answer instantly — a green test over a cockpit
// that was never slow.
const slowGh = (mark) => "#!/bin/sh\ncase \"$1 $2\" in\n"
  + `"issue list") : > ${JSON.stringify(mark)}; /bin/sleep ${GH_SLEEP_S}; exit 1 ;;\n`
  + "esac\nexit 1\n";

// git and the stub gh, nothing else. `node` is deliberately unreachable so
// gather()'s ledger read fails fast instead of shelling out to a real
// ledger.mjs — the same shim board-identity.test.mjs uses, and no row here
// asserts a ticket.
function shimPath(mark) {
  const bin = mkdtempSync(join(tmpdir(), "tick-bin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(real.status, 0, "test setup: no git on PATH to shim, so the derived-port arm cannot be reached");
  symlinkSync(real.stdout.trim(), join(bin, "git"));
  writeFileSync(join(bin, "gh"), slowGh(mark));
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

// realpath, not the bare mkdtemp path: on darwin $TMPDIR lives under /var,
// which is a symlink to /private/var, and resolveCockpitInstance canonicalises
// the workspace it derives.
function gitRepo(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  // GIT_DIR/GIT_WORK_TREE scrubbed off the fixture: under an ambient one `git
  // init` exits 0 having re-inited whichever directory the variable names.
  const init = spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore", env: gitEnv() });
  assert.equal(init.status, 0, "test setup: git init must succeed");
  return dir;
}

const withTimeout = (pr, ms, what) => Promise.race([
  pr,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms).unref()),
]);

// HOME is redirected at every child: gatherSpend() scans $HOME for this cwd's
// Claude Code transcripts, and an empty directory keeps these runs off the
// machine's real session tree.
const childEnv = (bin, home) => ({ ...process.env, PATH: bin, HOME: home });

function serveProcess(cwd, bin, home) {
  const p = spawn(process.execPath, [SCRIPT, "serve", "--interval", "3600"],
    { cwd, env: childEnv(bin, home), stdio: ["ignore", "ignore", "pipe"] });
  p.stderr.setEncoding("utf8");
  let buf = "";
  const port = new Promise((res, rej) => {
    p.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/cockpit on http:\/\/localhost:(\d+)/);
      if (m) res(Number(m[1]));
    });
    p.on("exit", (code) => rej(new Error(`serve exited (${code}) before announcing: ${buf}`)));
  });
  return { p, port, stderr: () => buf };
}

// The first candidate this machine can actually bind — the derived port itself
// unless something outside this suite is sitting on it.
async function firstFreePort(ports) {
  for (const p of ports) {
    const free = await new Promise((res) => {
      const probe = createServer();
      probe.once("error", () => res(false));
      probe.listen(p, () => probe.close(() => res(true)));
    });
    if (free) return p;
  }
  throw new Error(`test setup: no free port among ${ports.join(", ")}`);
}

async function until(what, ms, pred) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${ms}ms`);
    await new Promise((res) => setTimeout(res, 20));
  }
}

const boardJson = async (port) => {
  const res = await fetch(`http://localhost:${port}/board.json`);
  if (!res.ok) { await res.arrayBuffer().catch(() => {}); return null; }
  return res.json();
};

// The whole ticket, end to end, in the order the defect happened: a cockpit is
// up, a tick is running, and a relaunch arrives while it runs.
//
// Every assertion here fails on the pre-#1713 build, and each for its own
// reason — measured against the synchronous gather(): the probe returns null
// after ~2s rather than the workspace in milliseconds, and the second launch
// reads the port as foreign, announces a cockpit of its own on the next
// candidate and never exits, so spawnSync reports the timeout instead of 0.
test("CLI: a relaunch that lands mid-gather() is answered within 1s and reuses the live cockpit", async () => {
  const repo = gitRepo("tick-block-");
  const mark = join(mkdtempSync(join(tmpdir(), "tick-mark-")), "gathering");
  const bin = shimPath(mark);
  const home = mkdtempSync(join(tmpdir(), "tick-home-"));
  const instance = resolveCockpitInstance({ cwd: repo, gitCommonDir: join(repo, ".git") });
  const expected = await firstFreePort(cockpitPorts(instance));
  const first = serveProcess(repo, bin, home);
  try {
    const port = await withTimeout(first.port, 20000, "the cockpit to announce");
    // Not decoration: the second launch below scans this workspace's window in
    // order, so a first launch that landed somewhere else would leave the
    // reuse assertion passing for a reason this test does not name.
    assert.equal(port, expected, "a launch with nothing in its way must take the port its workspace derives");

    // The tick is now INSIDE `gh issue list`, which will not answer for
    // GH_SLEEP_S. On the pre-#1713 build this is precisely the window in which
    // the process answered nothing at all.
    await until("gather() to reach its first gh read", 20000, async () => existsSync(mark));

    // The launcher's own code path, not a hand-rolled fetch: what #1585's
    // handshake asks is exactly what has to be answered here.
    const started = Date.now();
    const who = await probeCockpitWorkspace(expected);
    const waited = Date.now() - started;
    assert.equal(who, repo,
      `a cockpit that cannot name its workspace mid-tick is read as foreign, which is how the duplicate starts (waited ${waited}ms)`);
    assert.ok(waited < 1000,
      `the identity came back in ${waited}ms; a launch's probe gives it PROBE_TIMEOUT_MS and this cockpit must answer inside that at all times`);

    // AC 2: the second launch reuses the first cockpit — still mid-tick.
    const second = spawnSync(process.execPath, [SCRIPT, "serve", "--interval", "3600"],
      { cwd: repo, encoding: "utf8", env: childEnv(bin, home), timeout: 30000 });
    assert.equal(second.status, 0,
      `the reuse path must exit 0 — a backgrounded launch reports nothing else: ${second.stderr}`);
    assert.match(second.stderr, new RegExp(`already running for this workspace on http://localhost:${expected}/`), second.stderr);
    assert.doesNotMatch(second.stderr, /cockpit on http/,
      `a second cockpit was started for one workspace: ${second.stderr}`);

    // …and all of the above really did happen inside the first tick. Without
    // this the two assertions above would also pass on a build whose tick had
    // simply finished first, which is the ordinary case and not this ticket's.
    const midTick = await boardJson(expected);
    assert.equal(midTick?.generatedAt, undefined,
      "the first tick finished before the assertions above ran — they proved nothing about a mid-tick relaunch");
    assert.equal(midTick?.workspace, repo, "the payload answered mid-tick is #1660's identity stub");

    // The other half, and the one a merely-unblocked server could fail: the
    // tick still LANDS, whole and atomically, once its reads return.
    const built = await until("the first tick to publish a board", 30000, async () => {
      const body = await boardJson(expected);
      return typeof body?.generatedAt === "number" ? body : null;
    });
    assert.ok(Array.isArray(built.tickets), "the tick published something that is not a board");
    assert.equal(built.workspace, repo);
    assert.equal(built.port, expected);
    assert.equal(first.p.exitCode, null, `the cockpit died during its own tick: ${first.stderr()}`);
  } finally {
    first.p.kill("SIGKILL");
    for (const d of [bin, repo, home]) rmSync(d, { recursive: true, force: true });
  }
});
