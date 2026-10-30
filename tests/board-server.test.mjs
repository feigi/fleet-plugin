// board-server.mjs: the HTTP layer and the cockpit instance's identity. It boots
// createBoardServer() against a temp dir and asserts it serves board.json and
// the page, then covers resolveCockpitInstance(), cockpitPorts(),
// probeCockpitWorkspace(), and the CLI launch and reuse rows — a second launch
// on the same workspace, a holder that is another workspace's cockpit, the
// loopback-only bind, and a bind or pre-bind connect that fails.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, symlinkSync, realpathSync } from "node:fs";
import { tempDir } from "./support/temp-dir.mjs";
import { join } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { createBoardServer, renderRefusedHost, resolveCockpitInstance, cockpitPorts, probeCockpitWorkspace } from "../plugin/scripts/board-server.mjs";
import { gitEnv } from "../plugin/scripts/git-env.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { withStderr, serveArgs, serveOpts, withTimeout } from "./support/board-rig.mjs";
import { heldOutside, heldWindowExit, watchWindow } from "./support/cockpit-port.mjs";
import { seedLabelMap } from "./support/label-map-seed.mjs";

test("createBoardServer serves board.json and the page", async () => {
  const dir = tempDir("board-");
  writeFileSync(join(dir, "board.json"), JSON.stringify({ generatedAt: 1, tickets: [], attention: [] }));
  writeFileSync(join(dir, "board.html"), "<!doctype html><title>cockpit</title>");
  const server = createBoardServer(dir);
  await new Promise((res) => server.listen(0, res));
  const port = server.address().port;

  const j = await fetch(`http://127.0.0.1:${port}/board.json`);
  assert.equal(j.status, 200);
  assert.equal((await j.json()).generatedAt, 1);

  const h = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(h.status, 200);
  assert.match(await h.text(), /cockpit/);

  const nf = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(nf.status, 404);

  await new Promise((res) => server.close(res));
});

// The Host-header guard is a socket-level property, so these tests speak raw
// HTTP over a real TCP connection to the loopback bind: a client library would
// normalise or refuse the very headers under test (a missing Host, an
// uppercase name). Every request goes out as HTTP/1.0, the one version where
// Host is optional, so the no-Host case can be sent at all (Node answers an
// HTTP/1.1 request without one 400 itself) and the reply is unchunked.
async function rawStatus(port, path, host) {
  const lines = [`GET ${path} HTTP/1.0`];
  if (host !== undefined) lines.push(`Host: ${host}`);
  lines.push("", "");
  const socket = connect({ host: "127.0.0.1", port });
  let raw = "";
  socket.setEncoding("utf8");
  socket.on("data", (c) => { raw += c; });
  // latin1, so a char in U+0080..U+00FF goes out as the one obs-text byte a
  // header value may carry, which is how Node hands it back to the handler.
  socket.write(lines.join("\r\n"), "latin1");
  await new Promise((res, rej) => { socket.once("close", res); socket.once("error", rej); });
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(raw);
  assert.ok(status, `no HTTP status line in ${JSON.stringify(raw)}`);
  return { status: Number(status[1]), body: raw.slice(raw.indexOf("\r\n\r\n") + 4) };
}

// The server runs in this process, so its refusal log lands on this
// console.error: every Host-guard test captures it, hands the lines to `fn`,
// and keeps them off the test runner's stderr. The once-per-Host gate is
// process-wide, so each test refuses Host values no other test sends.
async function withBoardServer(fn) {
  const dir = tempDir("board-host-");
  writeFileSync(join(dir, "board.json"), JSON.stringify({ generatedAt: 1, tickets: [], attention: [] }));
  writeFileSync(join(dir, "board.html"), "<!doctype html><title>cockpit</title>");
  const server = createBoardServer(dir);
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const logged = [];
  const original = console.error;
  console.error = (...args) => { logged.push(args.join(" ")); };
  try { await fn(server.address().port, logged); } finally {
    console.error = original;
    await new Promise((res) => server.close(res));
  }
}

test("createBoardServer answers 403 to a Host that is not a loopback name, on every path", async () => {
  await withBoardServer(async (port) => {
    const foreign = [`evil.example.com:${port}`, "rebound.attacker.test", `127.0.0.1.evil.test:${port}`, `localhost.evil.test:${port}`, `evil.test:${port}@localhost`, `[::2]:${port}`];
    // Names next to loopback that are not on the allow-list, and a loopback
    // name embedded in a longer value: the allow-list is an exact match on a
    // whole-value hostname, so none of these is a loopback Host.
    const lookalikes = [`0.0.0.0:${port}`, "0.0.0.0", "::1", "evil.test:localhost", "x[::1]"];
    // A loopback name with anything after it: only the end anchor of the Host
    // grammar refuses these, so a regex that stops at the name accepts them.
    const trailing = ["[::1]evil.test", `[::1]:${port}x`, "localhost/x", `localhost:${port}/x`, `localhost:${port} evil`, `127.0.0.1:${port} x`];
    for (const host of [...foreign, ...lookalikes, ...trailing]) {
      for (const path of ["/board.json", "/board.html", "/", "/nope"]) {
        const r = await rawStatus(port, path, host);
        assert.equal(r.status, 403, `${host} ${path}`);
        assert.doesNotMatch(r.body, /generatedAt|cockpit/, `${host} ${path} leaked the board`);
      }
    }
  });
});

test("createBoardServer answers 403 to a request with no Host header, and logs it once under a placeholder", async () => {
  await withBoardServer(async (port, logged) => {
    for (let i = 0; i < 3; i++) {
      const r = await rawStatus(port, "/board.json", undefined);
      assert.equal(r.status, 403);
      assert.equal(r.body, "forbidden");
    }
    assert.deepEqual(logged, ["board: refused a request with no Host header — not a loopback name (127.0.0.1, localhost, [::1]); answered 403"]);
  });
});

test("createBoardServer logs each refused Host once on stderr and still answers 403 forbidden", async () => {
  await withBoardServer(async (port, logged) => {
    const hosts = ["evil.com", "localhost.", `[0:0:0:0:0:0:0:1]:${port}`];
    for (const host of hosts) {
      for (let i = 0; i < 5; i++) {
        const r = await rawStatus(port, i % 2 ? "/nope" : "/board.json", host);
        assert.equal(r.status, 403, host);
        assert.equal(r.body, "forbidden", host);
      }
    }
    assert.deepEqual(logged, hosts.map((h) => `board: refused Host ${JSON.stringify(h)} — not a loopback name (127.0.0.1, localhost, [::1]); answered 403`));
  });
});

test("createBoardServer renders a refused Host escaped and truncated, on one line", async () => {
  await withBoardServer(async (port, logged) => {
    const quoted = 'q"uo\\te\tx';
    // U+0085 is NEL, a C1 control JSON.stringify leaves bare.
    const c1 = "nel\u0085x";
    const long = `${"a".repeat(300)}.test`;
    for (const host of [quoted, c1, long]) assert.equal((await rawStatus(port, "/", host)).status, 403, host);
    assert.equal(logged.length, 3, logged.join("\n"));
    for (const line of logged) assert.doesNotMatch(line, /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/, line);
    assert.match(logged[0], /^board: refused Host "q\\"uo\\\\te\\tx" — /);
    assert.match(logged[1], /^board: refused Host "nel\\u0085x" — /);
    assert.match(logged[2], new RegExp(`^board: refused Host "${"a".repeat(100)}"… \\(305 chars\\) — `));
  });
});

test("renderRefusedHost escapes DEL, every C1 control and both line separators, and nothing next to them", () => {
  // The bytes of a Host header reach the server one code unit each (latin1),
  // so U+2028/U+2029 and DEL cannot arrive through a raw request: the
  // renderer is the only place the full set is pinned.
  for (const c of ["\u007f", "\u0080", "\u0085", "\u009f", "\u2028", "\u2029"]) {
    const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
    assert.equal(renderRefusedHost(`a${c}b`), `Host "a\\u${hex}b"`, hex);
  }
  for (const c of ["~", "\u00a0"]) assert.equal(renderRefusedHost(`a${c}b`), `Host "a${c}b"`, c.charCodeAt(0).toString(16));
});

test("createBoardServer cuts a refused Host after exactly 100 characters", async () => {
  await withBoardServer(async (port, logged) => {
    const at100 = `${"b".repeat(95)}.test`;
    const at101 = `${"b".repeat(96)}.test`;
    for (const host of [at100, at101]) assert.equal((await rawStatus(port, "/", host)).status, 403, host);
    assert.equal(logged.length, 2, logged.join("\n"));
    assert.match(logged[0], new RegExp(`^board: refused Host "${"b".repeat(95)}\\.test" — `));
    assert.match(logged[1], new RegExp(`^board: refused Host "${"b".repeat(96)}\\.tes"… \\(101 chars\\) — `));
  });
});

test("createBoardServer keys the once-per-Host gate on the cut rendering, so two Hosts alike for 100 characters and in length log one line", async () => {
  await withBoardServer(async (port, logged) => {
    for (const host of [`${"c".repeat(100)}X.test`, `${"c".repeat(100)}Y.test`]) assert.equal((await rawStatus(port, "/", host)).status, 403, host);
    assert.equal(logged.length, 1, logged.join("\n"));
    assert.match(logged[0], new RegExp(`^board: refused Host "${"c".repeat(100)}"… \\(106 chars\\) — `));
  });
});

test("createBoardServer stops logging new refused Hosts at a fixed cap of 16, with one notice", async () => {
  await withBoardServer(async (port, logged) => {
    // A Host repeated past the cap spends one slot, not twenty: it leaves no
    // notice behind, and the distinct Hosts after it are still logged.
    for (let i = 0; i < 20; i++) assert.equal((await rawStatus(port, "/", "cap-repeat.test")).status, 403);
    assert.equal(logged.length, 1, logged.join("\n"));
    for (let i = 0; i < 100; i++) assert.equal((await rawStatus(port, "/", `cap-${i}.test`)).status, 403);
    const line = (h) => `board: refused Host "${h}" — not a loopback name (127.0.0.1, localhost, [::1]); answered 403`;
    const distinct = Array.from({ length: 15 }, (_, i) => `cap-${i}.test`);
    assert.deepEqual(logged, [
      ...["cap-repeat.test", ...distinct].map(line),
      "board: 16 distinct Hosts refused; further refused Hosts are not logged",
    ]);
    // Past the cap, a Host already logged is still not logged again.
    assert.equal((await rawStatus(port, "/", "cap-0.test")).status, 403);
    assert.equal(logged.length, 17);
  });
});

test("createBoardServer serves every loopback Host name, any port, any case, and logs nothing for them", async () => {
  await withBoardServer(async (port, logged) => {
    // The port is deliberately not compared (an ssh -L forward arrives under a
    // different one), so a mismatched port and a missing port must both pass.
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`, `LocalHost:${port}`, `[::1]:1`, "127.0.0.1", "localhost"]) {
      const j = await rawStatus(port, "/board.json", host);
      assert.equal(j.status, 200, host);
      assert.equal(JSON.parse(j.body).generatedAt, 1, host);
      assert.equal((await rawStatus(port, "/board.html", host)).status, 200, host);
      assert.equal((await rawStatus(port, "/nope", host)).status, 404, host);
    }
    assert.deepEqual(logged, []);
  });
});

// #1660 review: the git-enabled reuse/scan CLI rows below (which need a
// real `bin` with git shimmed and a real `repo` cwd, so serveOpts()'s
// offline empty-PATH rig doesn't fit) repeated this option literal
// verbatim across four call sites, differing only in the timeout.
const serveSync = (repo, bin, args, timeout = 20000) =>
  spawnSync(process.execPath, serveArgs(args), { cwd: repo, env: { ...process.env, PATH: bin }, encoding: "utf8", timeout });

// A net server that accepts a connection and then says nothing — the holder
// no HTTP status describes, and the only one the probe's timer alone can
// end. Its sockets are tracked because a socket nobody ever reads from
// never notices the peer hanging up: plain `server.close()` would then wait
// on it forever and keep this whole test process alive past the last test
// (measured — the suite ran to the harness timeout with every test green).
function muteHolder() {
  const conns = [];
  const server = createServer((s) => conns.push(s));
  const close = () => {
    for (const s of conns) s.destroy();
    return new Promise((res) => server.close(res));
  };
  return { server, close };
}

// #1660 review: the row that used to stand here pinned the opposite of what
// #1656 closed. This cwd is not a git checkout, so its workspace is null,
// and a null workspace can never be confirmed against a handshake no
// matter what answers on the other end — there is no identity to scan for.
// Stepping past a held port there re-admits the exact dual-cockpit hazard
// #1656 fixed: two processes sharing one derived window and one state
// directory, neither aware the other exists. A held derived port on the
// degrade arm has to stay fatal, exactly as it was before #1585 introduced
// scanning at all.
//
// The blocker is a bare net server, and it has to be OURS: a port some
// outside process already holds can be let go between this bind and
// board's own, and board then binds 8123 and serves (#2522). The degrade
// arm derives no port but 8123, so there is none to move to: when an
// outside process holds it, the row skips rather than ride that process's
// timing.
test("CLI: a derived port held by anything is fatal on the degrade arm — there is no identity to scan for", async (t) => {
  const blocker = createServer();
  const failure = await new Promise((res) => { blocker.once("error", res); blocker.listen(8123, () => res(null)); });
  if (failure?.code === "EADDRINUSE") return t.skip(heldOutside(8123));
  if (failure) throw failure;
  const nobin = tempDir("board-nobin-");
  const cwd = tempDir("board-serve-");
  try {
    const r = serveSync(cwd, nobin, ["--interval", "3600"]);
    assert.equal(r.status, 2, `a held derived port on the degrade arm must refuse, not scan past it: ${r.stderr}`);
    assert.match(r.stderr, /port 8123 in use/, r.stderr);
    assert.doesNotMatch(r.stderr, /cockpit on http/,
      `a second server was started with no identity it could ever have matched on: ${r.stderr}`);
  } finally {
    blocker.close(() => {});
    for (const d of [nobin, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

// #1656 critical (survived review): tick() used to run and write board.json
// BEFORE listen() confirmed the bind, so a process that loses this exact
// race against another cockpit on the same shared state directory still got
// one full write in before dying on EADDRINUSE — overwriting whatever the
// live cockpit had just written. Binding first (server.listen()'s success
// callback now owns tick()/setInterval()) is what this test pins: the loser
// must leave the state directory exactly as untouched as a process that
// never ran at all.
//
// The blocker names no host, so it holds every interface. On macOS/BSD a
// 127.0.0.1 bind succeeds beside a listener like that rather than failing
// EADDRINUSE, so the refusal pinned here — an explicit port is never scanned
// off, it dies "in use" — has to come from somewhere other than the bind.
test("CLI: a port already in use must not write board.json before the process dies", async () => {
  const blocker = createServer();
  const port = await new Promise((res) => blocker.listen(0, () => res(blocker.address().port)));
  const opts = serveOpts();
  try {
    const r = spawnSync(process.execPath, serveArgs(["--port", String(port)]), opts);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, new RegExp(`port ${port} in use`), r.stderr);
    assert.ok(!existsSync(join(opts.cwd, ".fleet", "board.json")),
      "the bind loser ticked and wrote board.json before dying on EADDRINUSE");
  } finally { blocker.close(() => {}); }
});

// The named case that must NOT be refused: listen(0) binds an ephemeral port,
// a real use, and 0 is falsy — the exact value the old `|| null` idiom lost.
// Once bound, serve() exits only on SIGINT/SIGTERM or on a tick that finds its
// run's recorded controller gone, and this test records no controller, so a
// timeout here is the expected shape of success; the refusal this guards
// against dies with status 2 almost instantly and never reaches listen() at
// all.
//
// Accepting 0 is only half of it: the announced URL has to be one the operator
// can open. Echoing the REQUESTED port printed http://localhost:0 — reachable
// by nothing — while the board sat on the kernel's pick, so pin that the
// number announced is the one bound, not the one asked for (#435 review).
test("CLI: serve accepts --port 0 (ephemeral bind), announces the port it actually bound, and opens nothing unasked", () => {
  const r = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600"]), { ...serveOpts(), timeout: 2000 });
  assert.notEqual(r.status, 2, r.stderr);
  assert.doesNotMatch(r.stderr, /--port wants/);
  const announced = r.stderr.match(/cockpit on http:\/\/127\.0\.0\.1:(\d+)/);
  assert.ok(announced, `no cockpit line: ${r.stderr}`);
  assert.notEqual(announced[1], "0", `announced the requested port, not the bound one: ${r.stderr}`);
  // …and the ABSENT half of #364's has() control rides this spawn rather than
  // paying for a second one byte-identical to it: no --open was passed, so
  // nothing may try to open. The --open test below carries the present half,
  // and explains why a launcher that could not run surfaces on stderr at all.
  assert.doesNotMatch(r.stderr, /could not open a browser/, r.stderr);
});

// ---------------------------------------------------------------------------
// #1582: cockpit instance resolution. A cockpit instance is identified by its
// WORKSPACE — the directory holding the shared git dir, resolved by
// fleet-dir.mjs's fleetFile() exactly as the run's one ledger is — so two
// workspaces get two boards on two ports and one workspace gets the SAME port
// on every run, making the URL bookmarkable across runs, reboots and node
// versions.
//
// resolveCockpitInstance() takes the already-resolved workspace as an
// ARGUMENT rather than resolving it, which is what turns the resolved case
// and the resolution-failed case into plain rows here instead of fixture
// repositories apiece. How a `--git-common-dir` answer becomes a workspace —
// a relative answer, the trailing newline, a linked worktree, a symlinked
// route — is git-env.test.mjs's and fleet-dir.test.mjs's to pin.
//
// Why these rows and not only a live probe: every serve() spawn above runs
// with PATH stripped to an empty dir, so git is unreachable and all of them
// take the DEGRADE arm. A green CLI section above is evidence about that arm
// and no other — the resolved arm is reached in the rows below, and
// end-to-end by the spawns further down, which put a git shim back on PATH on
// purpose.
// ---------------------------------------------------------------------------

test("resolveCockpitInstance: the state directory follows the workspace, never the cwd", () => {
  const r = resolveCockpitInstance({ cwd: "/w/repo/.worktrees/t", workspace: "/w/repo" });
  assert.equal(r.stateDir, "/w/repo/.fleet");
  assert.equal(r.workspace, "/w/repo");
});

// The window is written out literally rather than imported from board.mjs:
// these two numbers ARE the contract. BASE is the port the cockpit served on
// before any of this existed, so a silent change to it breaks every bookmark
// the ticket exists to preserve, and a test that read both from the module
// under test could not notice either one moving.
const PORT_BASE = 8123, PORT_SPAN = 512;

for (const dir of ["/w/one", "/w/two", "/srv/fleet-plugin", "/Users/x/dev/repo"]) {
  test(`resolveCockpitInstance: ${dir} derives one stable port inside [${PORT_BASE}, ${PORT_BASE + PORT_SPAN})`, () => {
    const first = resolveCockpitInstance({ cwd: dir, workspace: dir });
    // Same workspace, different cwd: the port follows the workspace, so a
    // member running from elsewhere in the tree must land on the same board.
    const again = resolveCockpitInstance({ cwd: "/somewhere/else", workspace: dir });
    assert.equal(first.port, again.port, "the port must follow the workspace, not the cwd");
    assert.equal(first.derived, true, "nothing forced this port, so it is a derived one");
    assert.ok(first.port >= PORT_BASE && first.port < PORT_BASE + PORT_SPAN,
      `${dir} derived ${first.port}, outside [${PORT_BASE}, ${PORT_BASE + PORT_SPAN}) — the unsigned coercion on the hash is what keeps it in the window`);
  });
}

// The other half of "two workspaces, two boards": a hash that collapses to a
// constant keeps every row above green while putting every workspace on one
// port — this test catches that. It does NOT reliably catch a precision-
// losing variant (Math.imul replaced by a plain `*`): for these six fixed
// paths that variant still lands on six distinct ports, so this row would
// pass vacuously against it (mutation-verified, #1656 review). The dedicated
// pinned-value test below exists to catch that case. Fixed paths, so both
// tests are deterministic: they cannot flake, they can only be wrong.
test("resolveCockpitInstance: different workspaces derive different ports", () => {
  const seen = new Map();
  for (const dir of ["/w/one", "/w/two", "/w/three", "/w/four", "/w/five", "/w/six"]) {
    const { port } = resolveCockpitInstance({ cwd: dir, workspace: dir });
    assert.ok(!seen.has(port),
      `${dir} and ${seen.get(port)} both derived ${port} — a hash that cannot separate two workspaces cannot give them two boards`);
    seen.set(port, dir);
  }
});

// workspaceHash() is not exported, so this pins the algorithm indirectly
// through resolveCockpitInstance()'s derived port. 8337 was hand-computed by
// re-deriving FNV-1a-with-Math.imul for the key "/fixed/workspace" in two
// independent scripts (JS and Python, the latter with explicit 32-bit
// unsigned-multiply/wrap semantics) and cross-checked against the real
// function — it is NOT copied from this file's own module under test. A
// Math.imul -> `*` mutation changes this key's hash and port (8337 -> 8355),
// so — unlike the uniqueness test above — this one does catch it.
test("resolveCockpitInstance: a fixed workspace pins the FNV-1a-with-Math.imul port exactly", () => {
  const { port } = resolveCockpitInstance({ cwd: "/fixed/workspace", workspace: "/fixed/workspace" });
  assert.equal(port, 8337,
    "port drifted off the hand-computed FNV-1a value for this fixed key — the hash algorithm itself changed");
});

// The false-positive half of this ticket. Deriving is the new behaviour, and
// the way to get it wrong is to derive over the top of a port the caller
// chose. 0 is a row on purpose: it is a legal ephemeral bind (#366/#435) and
// it is FALSY, so any truthiness test in place of `port != null` silently
// replaces it with a derived port and `--port 0` stops meaning anything.
// 8123 is a row for the opposite reason — it is the base, so only `derived`
// can tell a forced one from a derived one there.
for (const port of [0, 8123, 65535]) {
  test(`resolveCockpitInstance: --port ${port} is returned verbatim and marked not derived`, () => {
    const r = resolveCockpitInstance({ cwd: "/w/cwd", workspace: "/w/repo", port });
    assert.equal(r.port, port);
    assert.equal(r.derived, false);
    // Forcing the port forces the port — the state directory still follows
    // the workspace.
    assert.equal(r.stateDir, "/w/repo/.fleet");
  });
}

// No resolved workspace degrades to a cwd-relative state directory with a
// null workspace and says so; a non-git or otherwise unusual checkout never
// dies for it. The wording is the ledger's own — one dialect for one failure,
// so an operator who has seen the ledger's line recognises this one rather
// than learning a second phrasing of it.
for (const [name, workspace] of [
  ["the workspace could not be resolved", null],
  ["no workspace was passed at all", undefined],
  ["the empty string is not an identity", ""],
]) {
  test(`resolveCockpitInstance: ${name} — degrades to cwd, warns, never throws`, () => {
    let r;
    const errs = withStderr(() => { r = resolveCockpitInstance({ cwd: "/w/cwd", workspace }); });
    assert.equal(r.workspace, null, "no workspace was established, so none may be claimed");
    assert.equal(r.stateDir, "/w/cwd/.fleet", "the fallback is cwd-relative — the behaviour this file had before #1582");
    assert.equal(r.port, PORT_BASE, "with no workspace to hash there is nothing to derive from, so the port is the familiar default");
    assert.equal(errs.length, 1, "expected one stderr line, got " + JSON.stringify(errs));
    assert.match(errs[0], /WARNING could not resolve --git-common-dir/,
      "the ledger's existing fail-loud wording, not a second dialect for the same failure");
    assert.match(errs[0], /using cwd-relative/);
  });
}

// The reason fleetFile() gave rides on the warning, as it does on the ledger's.
test("resolveCockpitInstance: the degrade warning carries the reason it was handed", () => {
  const errs = withStderr(() => {
    resolveCockpitInstance({ cwd: "/w/cwd", workspace: null, why: "could not resolve --git-common-dir: spawnSync git ETIMEDOUT" });
  });
  assert.equal(errs.length, 1);
  assert.match(errs[0], /WARNING could not resolve --git-common-dir: spawnSync git ETIMEDOUT; using cwd-relative/);
});

// The degrade arm has its own copy of the forced/derived decision, so a
// mutation that drops it there is invisible to the rows above: a caller who
// passed --port outside a git checkout would silently get 8123 instead.
test("resolveCockpitInstance: an explicit port survives the degrade path too", () => {
  let r;
  const errs = withStderr(() => { r = resolveCockpitInstance({ cwd: "/w/cwd", workspace: null, port: 4242 }); });
  assert.equal(r.port, 4242);
  assert.equal(r.derived, false);
  assert.equal(errs.length, 1, "the state directory still degraded, so the warning still belongs");
});

// A PATH carrying git and nothing else. The resolved arm needs a real
// `git rev-parse`, while gh and node must stay unreachable so these spawns
// remain offline and fast — the same intent serveOpts()'s empty PATH has.
function gitOnlyPath() {
  const bin = tempDir("board-gitbin-");
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(real.status, 0, "test setup: no git on PATH to shim, so the resolved arm cannot be reached");
  symlinkSync(real.stdout.trim(), join(bin, "git"));
  return bin;
}

// Seeded with the identity Label map unless `seed` is false: a repository
// whose `.fleet` must stay absent gets none.
function gitRepo(prefix, { seed = true } = {}) {
  const dir = tempDir(prefix);
  // GIT_DIR/GIT_WORK_TREE scrubbed off the FIXTURE too: under an ambient one
  // `git init` exits 0 having re-inited whichever directory the variable
  // names, leaving this one silently not a repository (ledger.test.mjs hit
  // exactly that) — and the status check alone cannot see it.
  const env = gitEnv();
  const init = spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore", env });
  assert.equal(init.status, 0, "test setup: git init must succeed");
  assert.ok(existsSync(join(dir, ".git")), "test setup: git init must have created a repository HERE");
  if (seed) seedLabelMap(dir);
  return dir;
}

// The behavioural fixture ambient-git-vars-mjs-prose.test.mjs's census
// requires of every file it lists in COVERED_MJS, measured for board.mjs
// rather than copied from another script's reason: GIT_DIR outranks the
// child's cwd, so an ambient one makes `git rev-parse --git-common-dir`
// answer for a DIFFERENT repository — and this cockpit would then serve, and
// write board.json into, someone else's workspace, at exit 0 and in silence.
// gitEnv() on the probe is what prevents it.
test("CLI: an ambient GIT_DIR cannot move the cockpit into another repository's workspace", () => {
  const bin = gitOnlyPath(), mine = gitRepo("board-ws-mine-"), other = gitRepo("board-ws-other-", { seed: false });
  try {
    const r = spawnSync(process.execPath, serveArgs(["--port", "0", "--interval", "3600"]), {
      cwd: mine,
      env: { ...process.env, PATH: bin, GIT_DIR: join(other, ".git") },
      encoding: "utf8",
      timeout: 5000,
    });
    // Without this the test passes vacuously: a probe that FAILED also keeps
    // the board out of `other`, by degrading to the cwd rather than by
    // scrubbing anything.
    assert.doesNotMatch(r.stderr, /could not resolve --git-common-dir/,
      `the probe had to succeed, or this proves nothing about which repo it answered for: ${r.stderr}`);
    assert.match(r.stderr, /cockpit on http/, r.stderr);
    assert.ok(existsSync(join(mine, ".fleet", "board.json")),
      "the board belongs in the caller's own workspace");
    assert.ok(!existsSync(join(other, ".fleet")),
      "an ambient GIT_DIR relocated the whole cockpit into the repository it names");
  } finally { for (const d of [bin, mine, other]) rmSync(d, { recursive: true, force: true }); }
});


function serveProcess(cwd, bin, args = ["--port", "0", "--interval", "3600"], node = [], env = {}) {
  const p = spawn(process.execPath, [...node, ...serveArgs(args)],
    { cwd, env: { ...process.env, ...env, PATH: bin }, stdio: ["ignore", "ignore", "pipe"] });
  p.stderr.setEncoding("utf8");
  let buf = "";
  const url = new Promise((res, rej) => {
    p.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/cockpit on (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) res(m[1]);
    });
    p.on("exit", (code) => rej(new Error(`serve exited (${code}) before announcing: ${buf}`)));
  });
  return { p, url, stderr: () => buf };
}

// #1713: the cockpit now answers HTTP while its first tick is still
// computing, so the first payload on this wire is #1660's identity stub —
// `{workspace, port}`, no `tickets` — and only the tick behind it is a board.
// Before the tick ran asynchronously this process could not answer at all
// until it had finished, which is the only reason a bare fetch here used to
// land on a built board. `generatedAt` is the discriminant because only
// computeBoard() produces it; board-identity.test.mjs polls on the same field
// for the same reason.
async function untilBuiltBoard(url) {
  const ms = 20000, deadline = Date.now() + ms;
  for (;;) {
    try {
      const res = await fetch(`${url}/board.json`);
      if (res.ok) {
        const body = await res.json();
        if (typeof body.generatedAt === "number") return body;
      } else { await res.arrayBuffer(); }
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`no built board at ${url} after ${ms}ms`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

// The `canonicalise` opt-in is this caller's alone: without it a symlinked
// route to one workspace — a symlinked home, /var vs /private/var on this very
// platform — derives a SECOND port and a second state directory for a
// workspace already being served (#1582). How fleetFile() canonicalises is
// fleet-dir.test.mjs's to pin; this pins that the cockpit ASKS for it. git
// resolves a symlinked cwd itself, so the symlinked spelling reaches the
// answer through GIT_COMMON_DIR instead, which git echoes back verbatim — run
// from a plain repository of its own, since that override from inside a
// linked worktree collides with the worktree's own admin files.
test("CLI: a symlinked route to the workspace is served under the canonical workspace's identity", async () => {
  const bin = gitOnlyPath(), real = gitRepo("board-ws-real-"), from = gitRepo("board-ws-from-");
  const link = `${real}-link`;
  symlinkSync(real, link);
  const server = serveProcess(from, bin, undefined, [], { GIT_COMMON_DIR: join(link, ".git") });
  try {
    const body = await untilBuiltBoard(await withTimeout(server.url, 20000, "the cockpit to announce its URL"));
    assert.equal(body.workspace, realpathSync(real),
      `the symlinked route must canonicalise onto the real workspace key: ${server.stderr()}`);
  } finally {
    server.p.kill();
    for (const d of [bin, real, from, link]) rmSync(d, { recursive: true, force: true });
  }
});

// The end-to-end claim, and the one no pure row can make: two workspaces
// served AT ONCE are two live boards, each writing only its own state
// directory — and the one started from a linked worktree writes its MAIN
// checkout's, not the worktree's.
//
// `--port 0` on both, deliberately. What needs two real processes is the
// state-directory separation; that two workspaces derive two DIFFERENT ports
// is already pinned deterministically in the rows above, and binding the
// derived ports here would make the test depend on whether this machine
// happens to hold either of them.
//
// Unlike every other `gitOnlyPath()` consumer, this test also symlinks node
// onto the shim PATH (gh stays unreachable): gather()'s ledger read shells
// out to a `node ledger.mjs` subprocess, and with node unreachable that read
// always fails and every board here would show `tickets: []` regardless of
// which ledger.md — or none at all — actually got read, making the ledger
// fixture below assert nothing (#1656 review).
test("CLI: two workspaces serve two live boards at once, each writing only its own state directory", async () => {
  const bin = gitOnlyPath(), repoA = gitRepo("board-ws-a-"), repoB = gitRepo("board-ws-b-");
  symlinkSync(process.execPath, join(bin, "node"));
  const procs = [];
  try {
    const env = gitEnv();
    const git = (cwd, args) => {
      const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, stdio: "ignore", env });
      assert.equal(r.status, 0, `test setup: git ${args.join(" ")} must succeed`);
    };
    // `worktree add` needs a commit to branch from.
    git(repoA, ["commit", "-q", "--allow-empty", "-m", "init"]);
    const worktree = join(repoA, "wt");
    git(repoA, ["worktree", "add", "-q", worktree, "-b", "side"]);

    // #1656 critical (survived review): the served state directory moved to
    // the workspace, but an unfixed default ledger path stayed cwd-relative
    // — so a cockpit started from this worktree found no ledger there and
    // silently served an EMPTY board into repoA's shared board.json. A row
    // written into repoA's OWN `.fleet/ledger.md` (never the worktree's) is
    // the only way to tell "read the right ledger" apart from "read no
    // ledger and get an empty board either way": both look like `tickets: []`
    // without it.
    mkdirSync(join(repoA, ".fleet"), { recursive: true });
    writeFileSync(join(repoA, ".fleet", "ledger.md"),
      "# Fleet run ledger\n\n## Rows\n\n- #42 impl-1 build the thing\n\n## Filed\n\n## Ruled\n\n");

    const a = serveProcess(worktree, bin), b = serveProcess(repoB, bin);
    procs.push(a.p, b.p);
    const [urlA, urlB] = await withTimeout(Promise.all([a.url, b.url]), 20000, "both cockpits to announce");

    for (const [label, url] of [["worktree-of-A", urlA], ["B", urlB]]) {
      const board = await untilBuiltBoard(url);
      assert.ok(Array.isArray(board.tickets), `${label} served something that is not a board`);
    }
    assert.notEqual(urlA, urlB, "two concurrent boards cannot share one URL");

    const boardA = await (await fetch(`${urlA}/board.json`)).json();
    assert.ok(boardA.tickets.some((t) => t.issue === 42),
      "the worktree's cockpit must read the MAIN checkout's ledger, not a cwd-relative one that does not exist under the worktree");

    assert.ok(existsSync(join(repoA, ".fleet", "board.json")),
      "the worktree's cockpit must write its MAIN checkout's state directory");
    assert.ok(!existsSync(join(worktree, ".fleet")),
      "the worktree got a state directory of its own — one repo, one board, one ledger");
    assert.ok(existsSync(join(repoB, ".fleet", "board.json")),
      "the second workspace must write its own state directory");
  } finally {
    for (const p of procs) p.kill("SIGKILL");
    for (const d of [bin, repoA, repoB]) rmSync(d, { recursive: true, force: true });
  }
});

// ── #1585: the launch is idempotent ─────────────────────────────────────────

// The pure half of the scan, reachable with no socket at all.
test("cockpitPorts: an explicit port is a list of one — there is nothing to scan", () => {
  assert.deepEqual(cockpitPorts({ port: 9000, derived: false }), [9000]);
  // 0 is the row that catches a truthiness test in place of the `derived`
  // flag: it is a legal ephemeral bind (#366) and it is falsy.
  assert.deepEqual(cockpitPorts({ port: 0, derived: false }), [0]);
});

test("cockpitPorts: a derived port leads a bounded, contiguous window inside the range", () => {
  const ports = cockpitPorts({ port: 8200, derived: true });
  assert.equal(ports[0], 8200, "the scan must start at the stable, bookmarkable port, not one past it");
  assert.ok(ports.length > 1, "a derived port with no fallback is the failure this ticket exists to remove");
  // Every attempt can cost a bind plus a probe timeout, so the bound is what
  // keeps an exhausted range a refusal an operator waits seconds for rather
  // than minutes.
  assert.ok(ports.length <= 16, `${ports.length} attempts is not a bounded scan`);
  assert.deepEqual(ports, ports.map((_, i) => 8200 + i), "the window must be contiguous from the derived port");
});

// The top of the range is exactly where a naive `derived + i` walks out of
// the window resolveCockpitInstance() promises — onto ports this scheme
// never claimed, where no other workspace's cockpit could ever be found.
test("cockpitPorts: the window wraps at the top of the range rather than leaving it", () => {
  const top = PORT_BASE + PORT_SPAN - 1;
  const ports = cockpitPorts({ port: top, derived: true });
  assert.equal(ports[0], top);
  assert.equal(ports[1], PORT_BASE, "the port after the last one in the range is the first one");
  for (const p of ports) {
    assert.ok(p >= PORT_BASE && p < PORT_BASE + PORT_SPAN, `${p} escaped [${PORT_BASE}, ${PORT_BASE + PORT_SPAN})`);
  }
});

// A holder serving `dir` on a real ephemeral port, through the same
// server-creation seam the cockpit itself uses — no second I/O surface, in
// the tests either. A port someone else already holds comes back as
// `port: null`; any other bind failure rejects.
async function holderOn(dir, port = 0) {
  const server = createBoardServer(dir);
  const bound = await new Promise((res, rej) => {
    server.once("error", (e) => (e.code === "EADDRINUSE" ? res(null) : rej(e)));
    server.listen(port, () => res(server.address().port));
  });
  return { server, port: bound };
}

const boardDir = (payload) => {
  const dir = tempDir("board-holder-");
  if (payload !== undefined) writeFileSync(join(dir, "board.json"), payload);
  return dir;
};

// holderOn's other half: only EADDRINUSE reads as "someone else holds it". A
// listen() that fails for any other reason must reject, not come back as
// `port: null`, which the rows that skip on a null port would then report as
// a port held from outside. A unix-socket path under a directory that does
// not exist fails through the same 'error' event without privileges; the
// code it fails with differs by platform, and that it is not EADDRINUSE is
// the point.
test("holderOn: a bind failure that is not EADDRINUSE rejects instead of reading as a held port", async () => {
  const dir = boardDir();
  try {
    await assert.rejects(
      holderOn(dir, join(dir, "no-such-dir", "s.sock")),
      (e) => e instanceof Error && e.code !== undefined && e.code !== "EADDRINUSE",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// The half that must ACCEPT: a real board payload naming a workspace is the
// one answer the probe has to believe, and everything below is a way of not
// believing it. A probe that only ever returns null passes every negative
// row and turns the reuse path off entirely.
test("probeCockpitWorkspace: a live board's payload answers with its workspace", async () => {
  const dir = boardDir(JSON.stringify({ tickets: [], workspace: "/w/mine" }));
  const { server, port } = await holderOn(dir);
  try {
    assert.equal(await probeCockpitWorkspace(port), "/w/mine");
  } finally { server.close(() => {}); rmSync(dir, { recursive: true, force: true }); }
});

// Every way of failing to prove "this is my cockpit" is one answer: foreign.
// The 404 row is the live one — an empty state directory is what a cockpit
// whose first tick failed actually serves — and the rest are what a holder
// that is not a cockpit at all returns.
for (const [name, payload] of [
  ["no board.json at all (404)", undefined],
  ["a body that is not JSON", "<html>not a board</html>"],
  ["a payload with no workspace field", JSON.stringify({ tickets: [] })],
  ["a workspace that is not a string", JSON.stringify({ tickets: [], workspace: 42 })],
  ["an empty workspace", JSON.stringify({ tickets: [], workspace: "" })],
  ["a bare null payload", "null"],
]) {
  test(`probeCockpitWorkspace: ${name} reads as foreign`, async () => {
    const dir = boardDir(payload);
    const { server, port } = await holderOn(dir);
    try {
      assert.equal(await probeCockpitWorkspace(port), null);
    } finally { server.close(() => {}); rmSync(dir, { recursive: true, force: true }); }
  });
}

// #1660 review: every foreign row above happens to be a 404, which a
// mutation to `res.statusCode >= 400` would also reject — the guard must
// require exactly 200, not merely "not a client/server error". A non-200
// status carrying an otherwise-valid, matching workspace body is what tells
// the two apart: the real guard has to refuse it on status alone, without
// ever reading a body that would answer "yes" if it got that far.
test("probeCockpitWorkspace: a non-200 status with an otherwise-valid matching body still reads as foreign", async () => {
  const server = createServer((socket) => {
    socket.once("data", () => {
      const body = JSON.stringify({ tickets: [], workspace: "/w/mine" });
      socket.end(`HTTP/1.1 301 Moved Permanently\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
  });
  const port = await new Promise((res) => server.listen(0, () => res(server.address().port)));
  try {
    assert.equal(await probeCockpitWorkspace(port), null,
      "a non-200 status must be refused on the status alone, even carrying a real workspace body");
  } finally { server.close(); }
});

// The case no HTTP status covers: a holder that accepts the connection and
// then says nothing. Only the probe's own timer ends this, and the injected
// timeout is what proves the timer is the thing that ended it — a probe that
// ignored its argument and used the ~1s default would sit here ten times
// longer than the bound below.
test("probeCockpitWorkspace: a holder that never answers is bounded, and a refused connection is immediate", async () => {
  const mute = muteHolder();
  const port = await new Promise((res) => mute.server.listen(0, () => res(mute.server.address().port)));
  try {
    const started = Date.now();
    assert.equal(await probeCockpitWorkspace(port, 100), null);
    const waited = Date.now() - started;
    assert.ok(waited < 700, `the probe waited ${waited}ms past its 100ms budget — the launch's bound is this one`);
  } finally { await mute.close(); }
  // Same answer by the other road: nothing is listening there any more, so
  // the connect is refused rather than hung.
  assert.equal(await probeCockpitWorkspace(port, 100), null);
});

// The first candidate this machine can actually bind — the derived port
// itself unless something outside this suite is sitting on it.
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

async function untilBoardJson(url) {
  const ms = 15000, deadline = Date.now() + ms;
  for (;;) {
    try { if ((await fetch(`${url}/board.json`)).ok) return; } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`no readable board at ${url} after ${ms}ms`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

// #1714: stub browser launchers. Each appends its own name and argv to one
// log and exits with the code it was given, so a row reads which launcher
// ran, at what URL and how many times — and no real browser is ever reached.
// Written into gitOnlyPath()'s directory, so git still resolves beside them.
const ALL_LAUNCHERS = { open: 0, "xdg-open": 0, wslview: 0 };
function launcherBin(launchers) {
  const bin = gitOnlyPath();
  const log = join(bin, "launched.log");
  for (const [name, code] of Object.entries(launchers)) {
    writeExecStub(join(bin, name), `#!/bin/sh\necho "${name} $*" >> '${log}'\nexit ${code}\n`);
  }
  return { bin, launched: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

async function untilLaunched(rig, count) {
  const deadline = Date.now() + 20000;
  while (rig.launched().length < count) {
    if (Date.now() > deadline) throw new Error(`no launcher ran within 20000ms: ${JSON.stringify(rig.launched())}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

// watchWindow's two answers, on ephemeral ports rather than cockpit-range
// ones, so no cockpit this suite runs alongside lands on them. The holder
// arrives after the watch's first round and is gone before the landing is
// read — the shape a probe before the spawn and another after the announce
// both miss — and it still excuses a landing past it.
test("watchWindow: a candidate held and released while the watch is up excuses a landing past it", async (t) => {
  const [held, landed] = [await unheldPort(), await unheldPort()];
  const watch = await watchWindow([held, landed]);
  try {
    const holder = createServer();
    const failure = await new Promise((res) => { holder.once("error", res); holder.listen(held, "127.0.0.1", () => res(null)); });
    if (failure?.code === "EADDRINUSE") return t.skip(heldOutside(held));
    if (failure) throw failure;
    await new Promise((res) => setTimeout(res, 100));
    await new Promise((res) => holder.close(res));
    assert.equal(await watch.blockerBefore(landed), held);
  } finally { await watch.stop(); }
});

// The half that must refuse to excuse: with nothing held, a landing past the
// first candidate is the scan's own doing and the rows have to fail on it,
// and a landing on the first candidate needs no excuse at all.
test("watchWindow: with nothing held, no landing is excused", async () => {
  const window = [await unheldPort(), await unheldPort()];
  const first = await watchWindow(window);
  assert.equal(await first.blockerBefore(window[1]), null, "a landing past a free candidate was excused");
  const second = await watchWindow(window);
  assert.equal(await second.blockerBefore(window[0]), null);
});

// A held candidate excuses only a landing every candidate ahead of it can
// account for: here the first is held for the whole watch and the second is
// free throughout, so a landing past both is the scan's own doing and the
// rows have to fail on it, held first candidate or not.
test("watchWindow: a landing past a candidate nothing held is not excused by an earlier one that was held", async (t) => {
  const [held, free, landed] = [await unheldPort(), await unheldPort(), await unheldPort()];
  const holder = createServer();
  const failure = await new Promise((res) => { holder.once("error", res); holder.listen(held, "127.0.0.1", () => res(null)); });
  if (failure?.code === "EADDRINUSE") return t.skip(heldOutside(held));
  if (failure) throw failure;
  const watch = await watchWindow([held, free, landed]);
  try {
    assert.equal(await watch.blockerBefore(landed), null, "a landing past a free candidate was excused by an earlier held one");
  } finally {
    await watch.stop();
    await new Promise((res) => holder.close(res));
  }
});

// allHeld()'s two answers: a window with one candidate free is not
// exhausted by its holders, and the rows have to fail on a launch that gave up
// on it; a window whose every candidate answered is.
test("watchWindow: allHeld() is true only when every candidate was seen held", async (t) => {
  const [held, free] = [await unheldPort(), await unheldPort()];
  const holder = createServer();
  const failure = await new Promise((res) => { holder.once("error", res); holder.listen(held, "127.0.0.1", () => res(null)); });
  if (failure?.code === "EADDRINUSE") return t.skip(heldOutside(held));
  if (failure) throw failure;
  const partial = await watchWindow([held, free]);
  const whole = await watchWindow([held]);
  try {
    assert.equal(partial.allHeld(), false, "a window with a free candidate was read as exhausted by its holders");
    assert.equal(whole.allHeld(), true, "a window whose every candidate was held was not read as exhausted");
  } finally {
    await partial.stop();
    await whole.stop();
    await new Promise((res) => holder.close(res));
  }
});

// The skip the two CLI rows take when their first launch announces nothing:
// only a launch that exited before announcing, against a window whose every
// candidate was seen held. A window with a candidate free, or a rejection that
// is not that exit (the row's own announce timeout), is the row's failure.
test("heldWindowExit: skips only an exit before announcing against a window seen wholly held", async (t) => {
  const [held, free] = [await unheldPort(), await unheldPort()];
  const holder = createServer();
  const failure = await new Promise((res) => { holder.once("error", res); holder.listen(held, "127.0.0.1", () => res(null)); });
  if (failure?.code === "EADDRINUSE") return t.skip(heldOutside(held));
  if (failure) throw failure;
  const partial = await watchWindow([held, free]);
  const whole = await watchWindow([held]);
  const exitedEarly = new Error("serve exited (2) before announcing: board: no free port for this workspace");
  const timedOut = new Error("timed out waiting for the cockpit to announce");
  try {
    assert.equal(heldWindowExit(exitedEarly, whole), true, "an exit before announcing against a wholly held window was not skipped");
    assert.equal(heldWindowExit(exitedEarly, partial), false, "an exit before announcing against a window with a free candidate was skipped");
    assert.equal(heldWindowExit(timedOut, whole), false, "a rejection other than an exit before announcing was skipped");
  } finally {
    await partial.stop();
    await whole.stop();
    await new Promise((res) => holder.close(res));
  }
});

// The reuse path end to end, and the claim no unit row can make: a second
// launch against a LIVE cockpit for the same workspace starts no server,
// says where the board already is, and exits 0. The exit code is the whole
// point — the documented launch is `serve --open &`, so a backgrounded
// non-zero exit is read by nobody and the operator just waits for a tab.
//
// The first launch's own landing rides this spawn rather than paying for one
// byte-identical to it: nothing is held, so it must take the port its
// workspace DERIVES. Every other row here only asserts where a launch did
// not land, so a scan that skipped the derived port entirely — or probed
// before it tried to bind — would pass all of them and move every
// bookmarked URL by one. The window is watched while the launch picks its
// port (watchWindow): a landing past a candidate something outside this
// test was seen holding is that holder's doing, not the scan's, and skips.
//
// #1714: both launches pass --open, the way run-team's phase 0 relaunches on
// every re-shortlist, with every launcher stubbed on PATH. The first bound
// the port, so it opens exactly one tab; the second found that cockpit
// already running (the held-port arm), so it opens none — before #1714 it
// opened the existing board again, one more tab per pass.
test("CLI: a second launch for the same workspace reuses the live cockpit, opens nothing, and exits 0", async (t) => {
  const rig = launcherBin(ALL_LAUNCHERS), repo = gitRepo("board-ws-reuse-");
  const instance = resolveCockpitInstance({ cwd: repo, workspace: realpathSync(repo) });
  const ports = cockpitPorts(instance);
  const watch = await watchWindow(ports);
  const first = serveProcess(repo, rig.bin, ["--interval", "3600", "--open"]);
  const exited = new Promise((res) => first.p.once("exit", res));
  try {
    let url;
    try {
      url = await withTimeout(first.url, 20000, "the first cockpit to announce");
    } catch (e) {
      // A launch that found something outside this test holding every
      // candidate in its window exits without announcing, and without binding
      // it opens no tab either — the holders' doing, not the scan's.
      if (heldWindowExit(e, watch)) return t.skip(heldOutside(ports[0]));
      throw e;
    }
    const blocker = await watch.blockerBefore(Number(new URL(url).port));
    // The launch that bound still opens its tab, and the stub doing it writes
    // into rig.bin; a skip that removed rig.bin under that write would fail
    // the row on its cleanup instead.
    if (blocker !== null) { await untilLaunched(rig, 1); return t.skip(heldOutside(blocker)); }
    assert.equal(url, `http://127.0.0.1:${ports[0]}`,
      "a launch with nothing in its way must take the port its workspace derives — that URL is the bookmarkable one");
    // The handshake reads the payload, so the first tick has to have landed.
    await untilBoardJson(url);
    assert.equal((await (await fetch(`${url}/board.json`)).json()).workspace, realpathSync(repo),
      "the board payload is what the handshake reads — a cockpit that does not name its workspace cannot be recognised");
    await untilLaunched(rig, 1);

    const second = serveSync(repo, rig.bin, ["--interval", "3600", "--open"]);
    assert.equal(second.status, 0, `the reuse path must exit 0 — a backgrounded launch reports nothing else: ${second.stderr}`);
    assert.match(second.stderr, new RegExp(`already running for this workspace on ${url}/`), second.stderr);
    assert.doesNotMatch(second.stderr, /cockpit on http/, `a second server was started for one workspace: ${second.stderr}`);
    // Read only once the second launch has exited, so anything it launched
    // is already in the log: still the first launch's one line, at its URL.
    const launched = rig.launched();
    assert.equal(launched.length, 1, `the launch that bound opens one tab and the reuse opens none: ${JSON.stringify(launched)}`);
    assert.ok(launched[0].endsWith(` ${url}/`), `the one tab is not the served board: ${launched[0]}`);
    assert.doesNotMatch(second.stderr, /could not open a browser/, second.stderr);
  } finally {
    await watch.stop();
    first.p.kill("SIGKILL");
    await exited;
    for (const d of [rig.bin, repo]) rmSync(d, { recursive: true, force: true });
  }
});

// #1714: the reuse arm the row above cannot reach. That one's cockpit holds
// the derived port, so the second launch's bind fails and it handshakes the
// holder; here the derived port is FREE and this workspace's cockpit sits
// one candidate further along — the shape a departed squatter leaves — so
// the launch binds first and finds the match in its post-bind scan. That arm
// had its own copy of the open, and has to open nothing just the same. The
// stand-in cockpit answers from THIS process, so the launch is spawned
// asynchronously: a spawnSync would block the loop it answers on, and the
// probe would read it as silent rather than as this workspace's.
test("CLI: a launch whose post-bind scan finds this workspace's cockpit further along opens nothing", async () => {
  const rig = launcherBin(ALL_LAUNCHERS), repo = gitRepo("board-ws-scan-reuse-");
  const instance = resolveCockpitInstance({ cwd: repo, workspace: realpathSync(repo) });
  const ports = cockpitPorts(instance);
  const free = await firstFreePort(ports);
  const further = await firstFreePort(ports.slice(ports.indexOf(free) + 1));
  const dir = boardDir(JSON.stringify({ tickets: [], workspace: instance.workspace }));
  const { server, port } = await holderOn(dir, further);
  const p = spawn(process.execPath, serveArgs(["--interval", "3600", "--open"]),
    { cwd: repo, env: { ...process.env, PATH: rig.bin }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  p.stderr.setEncoding("utf8");
  p.stderr.on("data", (d) => { stderr += d; });
  try {
    assert.equal(port, further, "test setup: the stand-in cockpit must hold the later candidate");
    const status = await withTimeout(new Promise((res) => p.on("close", res)), 20000, "the launch to exit");
    assert.equal(status, 0, `the reuse path must exit 0: ${stderr}`);
    assert.match(stderr, new RegExp(`already running for this workspace on http://127\\.0\\.0\\.1:${further}/`), stderr);
    assert.doesNotMatch(stderr, /cockpit on http/, stderr);
    assert.deepEqual(rig.launched(), [], "a launch that found this workspace's cockpit already running opened a tab for it");
  } finally {
    p.kill("SIGKILL");
    server.close(() => {});
    for (const d of [rig.bin, repo, dir]) rmSync(d, { recursive: true, force: true });
  }
});

// #1714: which launcher a launch that bound its port runs, per platform (ADR
// 0009) — `open` on macOS; elsewhere `xdg-open`, then `wslview` (WSL) only
// when `xdg-open` is not on PATH at all, since one that ran and failed is the
// right program meeting a real fault. process.platform is forced in the
// child through a preload, so every platform's order is exercised on
// whichever one runs the suite, and each row's PATH also carries a launcher
// the forced platform must NOT reach for. A launch with no working launcher
// warns with the URL and keeps serving: it still answers after warning and
// exits 0 on the SIGTERM that ends it, exactly like one whose launcher
// worked — the status a missing `open` produced before #1714.
//
// Each row waits on --open's own outcome, not on a clock: read at a fixed
// deadline (the 2s spawnSync timeout this used to be), a launch slowed by a
// loaded machine had not reached its launcher yet and failed a row the code
// passes. openBrowser() warns only once it is done with the launcher list, so
// a warning row is complete the moment that line lands. A launcher that
// worked announces nothing, so a row expecting one waits for its log line and
// then LAUNCHER_SETTLE_MS more: a wrong second launcher, or a warning after
// all, would follow the one that worked within a turn of the loop, and this
// is the time it gets to show up. That wait can only miss a fault, never
// invent one.
const LAUNCHER_SETTLE_MS = 1000;
const WARNED = /could not open a browser.*\n/;
const serveOn = (platform, cwd, bin) => serveProcess(cwd, bin, ["--port", "0", "--interval", "3600", "--open"], [
  "--import", `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });`)}`,
]);

async function untilWarned(launch) {
  const deadline = Date.now() + 20000;
  while (!WARNED.test(launch.stderr())) {
    if (Date.now() > deadline) throw new Error(`no --open warning within 20000ms: ${launch.stderr()}`);
    await new Promise((res) => setTimeout(res, 50));
  }
}

for (const [platform, launchers, ran, warns] of [
  ["darwin", ALL_LAUNCHERS, ["open"], false],
  ["linux", ALL_LAUNCHERS, ["xdg-open"], false],
  ["linux", { open: 0, wslview: 0 }, ["wslview"], false],
  ["linux", { "xdg-open": 3, wslview: 0 }, ["xdg-open"], true],
  ["linux", { open: 0 }, [], true],
  ["darwin", { "xdg-open": 0, wslview: 0 }, [], true],
]) {
  const onPath = Object.entries(launchers).map(([n, c]) => (c ? `${n} (exit ${c})` : n)).join(", ");
  test(`CLI: a fresh --open launch on ${platform} with ${onPath} on PATH runs ${ran.join(" ") || "no launcher"}${warns ? " and warns with the URL" : ""}`, async () => {
    const rig = launcherBin(launchers), cwd = tempDir("board-open-");
    const launch = serveOn(platform, cwd, rig.bin);
    const exited = new Promise((res) => launch.p.on("exit", (code, signal) => res({ code, signal })));
    try {
      const url = await withTimeout(launch.url, 20000, "the cockpit to announce");
      if (warns) {
        await untilWarned(launch);
        assert.match(launch.stderr(), new RegExp(`WARNING --open could not open a browser \\(.*\\) — the cockpit is on ${url}/`), launch.stderr());
      } else {
        await untilLaunched(rig, ran.length);
        await new Promise((res) => setTimeout(res, LAUNCHER_SETTLE_MS));
        assert.doesNotMatch(launch.stderr(), /could not open a browser/, launch.stderr());
      }
      assert.deepEqual(rig.launched(), ran.map((cmd) => `${cmd} ${url}/`), launch.stderr());
      const serving = await fetch(`${url}/board.json`).then((res) => res.ok, () => false);
      assert.ok(serving, `the cockpit stopped serving instead of running until signalled: ${launch.stderr()}`);
      launch.p.kill("SIGTERM");
      assert.deepEqual(await withTimeout(exited, 20000, "the cockpit to exit on SIGTERM"), { code: 0, signal: null }, launch.stderr());
    } finally {
      launch.p.kill("SIGKILL");
      for (const d of [rig.bin, cwd]) rmSync(d, { recursive: true, force: true });
    }
  });
}

// The false-match half. This holder answers, parses, and serves a real board
// payload on the exact port this workspace derives — nothing but the
// workspace field distinguishes it from the cockpit reused above. A
// handshake that asks "did anyone answer" rather than "whose board is this"
// adopts it, and this run gets no board of its own at all.
//
// holderOn() names no host, so this stranger holds every interface — the
// shape of a dev server on the port. On macOS/BSD a 127.0.0.1 bind succeeds
// beside it instead of failing EADDRINUSE, and a launch that took the port
// that way would shadow the stranger on 127.0.0.1 rather than step over it.
// So the stranger has to still be the one answering there afterwards.
test("CLI: a holder reporting a different workspace is not adopted — the launch serves elsewhere", async (t) => {
  const bin = gitOnlyPath(), repo = gitRepo("board-ws-foreign-");
  const { port: derived } = resolveCockpitInstance({ cwd: repo, workspace: realpathSync(repo) });
  const dir = boardDir(JSON.stringify({ tickets: [], workspace: "/some/other/workspace" }));
  const { server, port: held } = await holderOn(dir, derived);
  const launch = held === null ? null : serveProcess(repo, bin, ["--interval", "3600"]);
  try {
    if (!launch) return t.skip(heldOutside(derived));
    const url = await withTimeout(launch.url, 20000, "the launch to step over the foreign holder");
    assert.notEqual(url, `http://127.0.0.1:${derived}`, "the launch adopted a board belonging to another workspace");
    const window = cockpitPorts({ port: derived, derived: true });
    assert.ok(window.includes(Number(url.split(":")[2])), `${url} is outside the bounded scan window ${window.join(", ")}`);
    // …and it is really serving its OWN board there, not merely announcing a
    // port it stepped onto.
    await untilBoardJson(url);
    assert.equal((await (await fetch(`${url}/board.json`)).json()).workspace, realpathSync(repo));
    assert.equal((await (await fetch(`http://127.0.0.1:${derived}/board.json`)).json()).workspace, "/some/other/workspace",
      "the launch bound 127.0.0.1 beside the stranger and took its traffic there");
  } finally {
    launch?.p.kill("SIGKILL");
    server.close(() => {});
    for (const d of [bin, repo, dir]) rmSync(d, { recursive: true, force: true });
  }
});

// The same-workspace half of the row above, with the holder bound the way a
// cockpit from before the loopback-only bind was: no host, every interface.
// A 127.0.0.1 bind beside it succeeds on macOS/BSD, so the bind failing is
// not what reports this cockpit; the launch has to find and reuse it anyway,
// exit 0 and open nothing. The holder answers from THIS process, so the
// launch is spawned asynchronously, for the reason the post-bind-scan row
// above gives.
test("CLI: this workspace's cockpit holding every interface on the derived port is reused, not shadowed", async (t) => {
  const rig = launcherBin(ALL_LAUNCHERS), repo = gitRepo("board-ws-wild-reuse-");
  const instance = resolveCockpitInstance({ cwd: repo, workspace: realpathSync(repo) });
  const dir = boardDir(JSON.stringify({ tickets: [], workspace: instance.workspace }));
  const { server, port: held } = await holderOn(dir, instance.port);
  const p = held === null ? null : spawn(process.execPath, serveArgs(["--interval", "3600", "--open"]),
    { cwd: repo, env: { ...process.env, PATH: rig.bin }, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  p?.stderr.setEncoding("utf8");
  p?.stderr.on("data", (d) => { stderr += d; });
  try {
    if (!p) return t.skip(heldOutside(instance.port));
    const status = await withTimeout(new Promise((res) => p.on("close", res)), 20000, "the launch to exit");
    assert.equal(status, 0, `the reuse path must exit 0: ${stderr}`);
    assert.match(stderr, new RegExp(`already running for this workspace on http://127\\.0\\.0\\.1:${instance.port}/`), stderr);
    assert.doesNotMatch(stderr, /cockpit on http/, `a second server was started beside this workspace's cockpit: ${stderr}`);
    assert.deepEqual(rig.launched(), [], "a launch that found this workspace's cockpit already running opened a tab for it");
  } finally {
    p?.kill("SIGKILL");
    server.close(() => {});
    for (const d of [rig.bin, repo, dir]) rmSync(d, { recursive: true, force: true });
  }
});

// The cockpit binds 127.0.0.1 and nothing else: its board is a read-only
// mirror of the ledger, and no other machine on the network has a reason to
// read it. A listen() with no host binds `::` dual-stack, which answers on
// 127.0.0.1 as well, so the half that tells the two apart is `[::1]`
// refusing. Skipped only on a host with no ::1 to refuse on.
test("CLI: serve binds 127.0.0.1 alone — 127.0.0.1 answers and [::1] refuses", async (t) => {
  const v6 = createServer();
  const noV6 = await new Promise((res) => { v6.once("error", res); v6.listen(0, "::1", () => v6.close(() => res(null))); });
  if (noV6) return t.skip(`this host has no ::1 to refuse on: ${noV6.code}`);
  const bin = gitOnlyPath(), cwd = tempDir("board-bind-");
  const launch = serveProcess(cwd, bin);
  try {
    const url = await withTimeout(launch.url, 20000, "the cockpit to announce");
    const port = Number(url.split(":")[2]);
    await untilBoardJson(`http://127.0.0.1:${port}`);
    const v6Answer = await new Promise((res) => {
      const s = connect({ host: "::1", port });
      s.once("connect", () => { s.destroy(); res("connected"); });
      s.once("error", (e) => res(e.code));
    });
    assert.equal(v6Answer, "ECONNREFUSED", `the cockpit answered on [::1]:${port}, so it is bound beyond 127.0.0.1`);
  } finally {
    launch.p.kill("SIGKILL");
    for (const d of [bin, cwd]) rmSync(d, { recursive: true, force: true });
  }
});

// The two branches of the pre-bind connect check that no real listener can
// produce on demand: a connect that fails with something other than a
// refusal, and one that never completes. A loopback connect to a port
// nobody holds is always refused, and a holder whose accept backlog is full
// drops the SYN only on the kernel's schedule — so the launch runs with
// net.connect replaced, through the CJS exports (a module that imported the
// name picks the replacement up after syncBuiltinESMExports). The stub is
// in the child, so the port never has to be held: a launch that wrongly
// reads the stubbed answer as "free" goes on to bind `port` and serve, and
// the row sees a launch that never exits with 2.
//
// The replacement's answer reaches the assertion through board's own output
// — the EPERM text below, the "in use" line — so a stub that never landed
// reads as a failure of the row, not as a pass.
function serveWithConnect(stubBody, port, extraPreload = "") {
  const preload = `import { createRequire, syncBuiltinESMExports } from "node:module";
const net = createRequire(process.cwd() + "/")("node:net");
net.connect = () => { ${stubBody} };
${extraPreload}
syncBuiltinESMExports();`;
  const opts = serveOpts();
  const r = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, ...serveArgs(["--port", String(port), "--interval", "3600"])], { ...opts, timeout: 10000 });
  return { r, cwd: opts.cwd };
}

// A port nobody holds, for a launch whose connect is stubbed: only a launch
// that wrongly decides the port is free ever binds it.
async function unheldPort() {
  const probe = createServer();
  const port = await new Promise((res) => probe.listen(0, "127.0.0.1", () => res(probe.address().port)));
  await new Promise((res) => probe.close(res));
  return port;
}

// ECONNREFUSED is the one connect error that means "free". Any other —
// EPERM from a sandbox that denies loopback connects, say — is a fault of
// the launch's own, and binding anyway would answer a question the check
// could not ask. It dies naming the check, with the error's own text after
// it, and starts nothing.
test("CLI: a pre-bind connect that fails with anything but a refusal is fatal, not read as a free port", async () => {
  const port = await unheldPort();
  const { r, cwd } = serveWithConnect(
    `const s = new net.Socket(); setImmediate(() => s.emit("error", Object.assign(new Error("connect EPERM 127.0.0.1:${port}"), { code: "EPERM" }))); return s;`,
    port,
  );
  assert.equal(r.status, 2, `a connect fault must refuse, not bind: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`cannot check whether port ${port} is held: connect EPERM 127\\.0\\.0\\.1:${port}`), `the refusal must name the held-check and carry the stubbed error: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /in use/, `a connect fault is not a held port: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /cockpit on http/, `the launch bound after a connect fault: ${r.stderr}`);
  assert.ok(!existsSync(join(cwd, ".fleet")), "the launch created a state directory after a connect fault");
});

// The code a connect error carries does not decide whose fault it is: one
// that says EADDRINUSE — a connect that cannot get a local port — is still
// the check's own failure, not the held-port answer the check resolves for a
// connect that succeeds or times out.
test("CLI: a pre-bind connect error carrying EADDRINUSE dies naming the check, not as a held port", async () => {
  const port = await unheldPort();
  const { r, cwd } = serveWithConnect(
    `const s = new net.Socket(); setImmediate(() => s.emit("error", Object.assign(new Error("connect EADDRINUSE 127.0.0.1:${port}"), { code: "EADDRINUSE" }))); return s;`,
    port,
  );
  assert.equal(r.status, 2, `a connect fault must refuse: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`cannot check whether port ${port} is held: connect EADDRINUSE 127\\.0\\.0\\.1:${port}`), `the refusal must name the held-check and carry the stubbed error: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /in use/, `a connect fault is not a held port: ${r.stderr}`);
  assert.ok(!existsSync(join(cwd, ".fleet")), "the launch created a state directory after a connect fault");
});

// The other side of that wording: a bind that fails with a fault of its own
// — EACCES here, past a connect that was refused — dies with the bind's text
// as it came, never attributed to the held-check that let it through.
test("CLI: a bind fault after a refused pre-bind connect dies with the bind's own message", async () => {
  const port = await unheldPort();
  const { r } = serveWithConnect(
    `const s = new net.Socket(); setImmediate(() => s.emit("error", Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:${port}"), { code: "ECONNREFUSED" }))); return s;`,
    port,
    `net.Server.prototype.listen = function () { setImmediate(() => this.emit("error", Object.assign(new Error("listen EACCES: permission denied 127.0.0.1:${port}"), { code: "EACCES" }))); return this; };`,
  );
  assert.equal(r.status, 2, `a bind fault must refuse: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`listen EACCES: permission denied 127\\.0\\.0\\.1:${port}`), `the stubbed bind error never reached the launch: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /cannot check whether port/, `a bind fault was reported as the held-check's: ${r.stderr}`);
  assert.doesNotMatch(r.stderr, /in use/, `a bind fault is not a held port: ${r.stderr}`);
});

// A holder whose accept backlog is full drops the SYN instead of refusing
// it, so "nothing answered within the timeout" has to count as held — read
// as free, the launch would bind beside a live holder on macOS/BSD. The
// stub's socket never connects and never errors; the check's own timer is
// the only thing that can end it. The keep-alive interval stands in for the
// kernel's pending connect, which keeps a real process alive; without it a
// never-resolving promise lets the process exit 0 with nothing said.
test("CLI: a pre-bind connect that never completes counts as a held port", async () => {
  const port = await unheldPort();
  const { r, cwd } = serveWithConnect(
    `const s = new net.Socket(); const keep = setInterval(() => {}, 100); s.once("close", () => clearInterval(keep)); return s;`,
    port,
  );
  assert.equal(r.status, 2, `an unanswered connect must read as held: ${r.stderr}`);
  assert.match(r.stderr, new RegExp(`port ${port} in use`), r.stderr);
  assert.doesNotMatch(r.stderr, /cockpit on http/, `the launch bound beside a port it could not prove free: ${r.stderr}`);
  assert.ok(!existsSync(join(cwd, ".fleet")), "the launch created a state directory for a port it did not take");
});

// The only hard failure left on a derived port, and the shape it has to
// have. Non-zero, because an exhausted range is a real refusal where reuse
// is not — and a message naming every port tried, because an operator told
// only "no free port" cannot tell a crowded range from a broken derivation.
//
// The blockers serve an empty directory, so each one 404s /board.json — one
// of the foreign shapes no launch may adopt. They cannot actually answer
// during the spawn below, though: spawnSync blocks this runner's event loop,
// so every probe runs out its full timeout, retries once (#1660 — a timeout
// alone does not prove foreign), and the row costs ~16s (measured, up from
// ~8s pre-#1660: PORT_ATTEMPTS candidates times two attempts times
// PROBE_TIMEOUT_MS). That is the bound doing its job rather than a hang,
// and it is why this row is the only slow one here — the rows that need a
// holder to really answer use serveProcess(), which leaves the loop free.
test("CLI: an exhausted derived range exits non-zero and names the ports it tried", async (t) => {
  const bin = gitOnlyPath(), repo = gitRepo("board-ws-full-");
  const instance = resolveCockpitInstance({ cwd: repo, workspace: realpathSync(repo) });
  const ports = cockpitPorts(instance);
  const dir = boardDir(undefined);
  const blockers = [];
  try {
    // The range full of OUR sockets: a port something else already holds
    // can be let go before the launch binds, and the launch then serves.
    for (const p of ports) {
      const holder = await holderOn(dir, p);
      if (holder.port === null) return t.skip(heldOutside(p));
      blockers.push(holder.server);
    }
    const r = serveSync(repo, bin, ["--interval", "3600"], 30000);
    assert.equal(r.status, 2, `an exhausted range must refuse, not hang and not succeed: ${r.stderr}`);
    for (const p of ports) assert.match(r.stderr, new RegExp(`\\b${p}\\b`), `the refusal does not name ${p}: ${r.stderr}`);
    assert.match(r.stderr, /--port/, "the refusal has to point at the way out of it");
    assert.doesNotMatch(r.stderr, /cockpit on http/, r.stderr);
  } finally {
    for (const s of blockers) s.close(() => {});
    for (const d of [bin, repo, dir]) rmSync(d, { recursive: true, force: true });
  }
});

// Neither half of the new behaviour may touch a port the operator named, and
// this replaces the narrower row that pinned only the bind error's wording
// there (its other assertion, the absence of the "(default)" marker, pins a
// string no path can print any more). The holder here is not a stranger: it
// serves a payload naming THIS workspace, the exact thing the derived path
// reuses at exit 0 above. A handshake not gated on `instance.derived` adopts
// it and exits 0, silently serving a board the operator did not ask for on
// the port they did.
test("CLI: an explicit port neither scans nor handshakes — a bind failure on it is fatal", async () => {
  const bin = gitOnlyPath(), repo = gitRepo("board-ws-explicit-");
  const dir = boardDir(JSON.stringify({ tickets: [], workspace: realpathSync(repo) }));
  const { server, port } = await holderOn(dir);
  try {
    const r = serveSync(repo, bin, ["--interval", "3600", "--port", String(port)]);
    assert.equal(r.status, 2, `a bind failure on a chosen port is a hard error: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`port ${port} in use`), r.stderr);
    assert.doesNotMatch(r.stderr, /already running/, "an explicit port was handshaked and reused");
    assert.doesNotMatch(r.stderr, /trying the next port/, "an explicit port was scanned off");
  } finally { server.close(() => {}); for (const d of [bin, repo, dir]) rmSync(d, { recursive: true, force: true }); }
});
