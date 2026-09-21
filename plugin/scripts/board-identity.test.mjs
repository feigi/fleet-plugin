// #1584: a board payload names the workspace it describes and the port it was
// served on, and the page names the repo in its tab title and its header.
//
// Before this, two cockpits were two identical windows: `board.html` carried a
// constant `<title>` and a constant header, the model's `repo` field was never
// read by the page at all, and the only identity anywhere near the payload was
// the `workspace` key #1585's launch handshake stamped onto the SERVED copy
// after computeBoard() had already returned — so `board.mjs build` printed a
// snapshot that could not say which of two workspaces it came from.
//
// Driven through the real CLI, out of process: gather() reads process.argv
// directly and resolveCockpitInstance()'s git probe is a spawn, so the join
// under test only exists in a child. The page half is lifted out of
// board.html's source text and called as a pure function — the page is served
// as one self-contained file with no build step and no DOM harness, the same
// seam spend-view.test.mjs and ledger-read-require-file.test.mjs already use.
//
// A separate file rather than more of board.test.mjs, for the reason
// board-prev-shape.test.mjs gives: the fleet runs several implementers at
// once and two PRs appending to one test file conflict, which costs the PR
// its CI entirely.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCockpitInstance } from "./board.mjs";
import { gitEnv } from "./git-env.mjs";

const SCRIPT = fileURLToPath(new URL("./board.mjs", import.meta.url));
const HTML = readFileSync(new URL("./board.html", import.meta.url), "utf8");

// The port this file hardcoded before instance resolution existed, and the one
// the degrade arm still answers with. Spelled out rather than imported because
// board.mjs does not export it — the same copy board.test.mjs's window rows
// keep, and a drift would fail the degrade row below loudly.
const PORT_BASE = 8123;

// A PATH carrying git, a gh stub, and nothing else: every board built here
// stays offline, and `node` is deliberately unreachable so gather()'s ledger
// read fails fast instead of shelling out to a real ledger.mjs. None of these
// tests asserts a ticket.
function shimPath(ghBody) {
  const bin = mkdtempSync(join(tmpdir(), "board-id-bin-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" });
  assert.equal(real.status, 0, "test setup: no git on PATH to shim, so the resolved arm cannot be reached");
  symlinkSync(real.stdout.trim(), join(bin, "git"));
  writeFileSync(join(bin, "gh"), ghBody);
  chmodSync(join(bin, "gh"), 0o755);
  return bin;
}

// Every gh read fails: each one goes through tryRun, which catches and
// degrades, so the board still builds and `repo` stays null.
const GH_FAILS = "#!/bin/sh\nexit 1\n";

// Answers only `gh repo view`, with the identity this instance should render.
const ghNamed = (nameWithOwner) => "#!/bin/sh\ncase \"$1 $2\" in\n\"repo view\") "
  + `echo '{"nameWithOwner":"${nameWithOwner}","url":"https://example.test/${nameWithOwner}"}' ;;\n`
  + "*) exit 1 ;;\nesac\n";

// realpath, not the bare mkdtemp path: on darwin $TMPDIR lives under /var,
// which is a symlink to /private/var, and resolveCockpitInstance canonicalises
// the workspace it derives. Comparing against the unresolved form would fail
// on the symlink rather than on the behaviour.
function gitRepo(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  // GIT_DIR/GIT_WORK_TREE scrubbed off the fixture too: under an ambient one
  // `git init` exits 0 having re-inited whichever directory the variable
  // names, leaving this one silently not a repository.
  const init = spawnSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore", env: gitEnv() });
  assert.equal(init.status, 0, "test setup: git init must succeed");
  return dir;
}

// HOME is redirected at every child: gatherSpend() scans $HOME for this cwd's
// Claude Code transcripts, and pointing it at an empty directory keeps these
// runs off the machine's real session tree.
function runBuild(cwd, bin) {
  const home = mkdtempSync(join(tmpdir(), "board-id-home-"));
  const r = spawnSync(process.execPath, [SCRIPT, "build"], {
    cwd, encoding: "utf8", timeout: 20000,
    env: { ...process.env, PATH: bin, HOME: home },
  });
  rmSync(home, { recursive: true, force: true });
  return r;
}

test("CLI: a built snapshot names the workspace it describes and the port that workspace is served on", () => {
  const bin = shimPath(GH_FAILS), repo = gitRepo("board-id-build-");
  try {
    const r = runBuild(repo, bin);
    assert.equal(r.status, 0, r.stderr);
    const board = JSON.parse(r.stdout);
    assert.ok(Array.isArray(board.tickets), `stdout must still be a board model: ${r.stdout.slice(0, 200)}`);

    assert.equal(board.workspace, repo,
      "a snapshot that cannot name its workspace is the anonymous file this ticket exists to remove");
    // The port is the DERIVED one — the port this workspace's cockpit answers
    // on, which is what makes a stray file self-identifying. Computed through
    // the exported seam rather than hardcoded, so the hash algorithm stays
    // free to be tested where it is defined, but the real CLI reached it
    // through a real `git rev-parse`, which is the join under test.
    const expected = resolveCockpitInstance({ cwd: repo, gitCommonDir: ".git" });
    assert.equal(board.port, expected.port);
    assert.notEqual(board.port, null);
  } finally { for (const d of [bin, repo]) rmSync(d, { recursive: true, force: true }); }
});

// The fallback half of the same claim. A build outside any checkout has no
// workspace to name — but it must still SAY so, with both keys present and
// null where the identity is unknown, rather than dropping the fields and
// leaving a reader unable to tell an old payload from a degraded one.
test("CLI: a build with no resolvable workspace still carries both keys — null workspace, base port", () => {
  const bin = shimPath(GH_FAILS);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "board-id-nogit-")));
  try {
    const r = runBuild(cwd, bin);
    assert.equal(r.status, 0, r.stderr);
    // Without this the row passes vacuously: a cwd that turned out to be
    // inside some repository would take the resolved arm and never reach the
    // degrade this test is about.
    assert.match(r.stderr, /could not resolve --git-common-dir/, r.stderr);
    const board = JSON.parse(r.stdout);
    assert.ok("workspace" in board && "port" in board,
      `both identity keys must be present even when there is no instance: ${r.stdout.slice(0, 200)}`);
    assert.equal(board.workspace, null);
    assert.equal(board.port, PORT_BASE);
  } finally { for (const d of [bin, cwd]) rmSync(d, { recursive: true, force: true }); }
});

const withTimeout = (pr, ms, what) => Promise.race([
  pr,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms).unref()),
]);

function serveProcess(cwd, bin) {
  const home = mkdtempSync(join(tmpdir(), "board-id-home-"));
  const p = spawn(process.execPath, [SCRIPT, "serve", "--port", "0", "--interval", "3600"],
    { cwd, env: { ...process.env, PATH: bin, HOME: home }, stdio: ["ignore", "ignore", "pipe"] });
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
  return { p, port };
}

// The announcement comes BEFORE the first tick (#1660 publishes identity at
// bind time so a racing launch's probe has something to read), so the first
// payload on the wire can still be that stub. Poll for a real tick rather than
// racing it — `generatedAt` is the field only computeBoard() produces.
async function builtBoard(port) {
  for (let i = 0; i < 100; i++) {
    const res = await fetch(`http://localhost:${port}/board.json`);
    if (res.status === 200) {
      const body = await res.json();
      if (typeof body.generatedAt === "number") return body;
    } else { await res.arrayBuffer(); }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no built board on port ${port}`);
}

// The end-to-end claim the whole ticket is for: two cockpits up at once are
// two DIFFERENT windows — different identity in the payload, and a different
// name in the tab strip and the header, each naming its own repo.
//
// `--port 0` on both, deliberately, and not only to keep the test off this
// machine's derived ports: an ephemeral bind is the one case where the port
// the caller asked for and the port the board is reachable on differ, so the
// payload echoing the REQUEST would say `port: 0` here and nowhere else.
test("CLI: two concurrent cockpits carry two identities, and their titles name two different repos", async () => {
  const binA = shimPath(ghNamed("acme/one")), binB = shimPath(ghNamed("acme/two"));
  const repoA = gitRepo("board-id-a-"), repoB = gitRepo("board-id-b-");
  const procs = [];
  try {
    const a = serveProcess(repoA, binA), b = serveProcess(repoB, binB);
    procs.push(a.p, b.p);
    const [portA, portB] = await withTimeout(Promise.all([a.port, b.port]), 20000, "both cockpits to announce");
    const [boardA, boardB] = await withTimeout(
      Promise.all([builtBoard(portA), builtBoard(portB)]), 20000, "both cockpits to build a board");

    assert.equal(boardA.workspace, repoA);
    assert.equal(boardB.workspace, repoB);
    assert.notEqual(boardA.workspace, boardB.workspace, "two workspaces cannot share one identity");

    // The port SERVED, not the port requested: both asked for 0.
    assert.equal(boardA.port, portA);
    assert.equal(boardB.port, portB);
    assert.notEqual(boardA.port, boardB.port);

    assert.equal(boardA.repo, "acme/one");
    assert.equal(boardB.repo, "acme/two");
    assert.notEqual(boardTitle(boardA.repo), boardTitle(boardB.repo),
      "two boards rendering one title is the defect this ticket names");
    assert.match(boardTitle(boardA.repo), /acme\/one/);
    assert.match(boardTitle(boardB.repo), /acme\/two/);
  } finally {
    for (const p of procs) p.kill("SIGKILL");
    for (const d of [binA, binB, repoA, repoB]) rmSync(d, { recursive: true, force: true });
  }
});

// ── the page ────────────────────────────────────────────────────────────────
//
// A lift reads a COPY, so the guards below keep that copy tied to the page: a
// second top-level declaration would win at runtime by hoisting while the lift
// still read the first.

for (const [name, re] of [
  ["TITLE", /^const TITLE = /gm],
  ["boardTitle", /^function\s+boardTitle\s*\(/gm],
]) {
  test(`board.html declares ${name} exactly once at top level`, () => {
    assert.equal(HTML.match(re)?.length, 1,
      `${name} must be declared exactly once — a second top-level declaration wins at runtime and the lift below would still read the first`);
  });
}

const TITLE_SRC = HTML.match(/^const TITLE = .*$/m);
const BOARD_TITLE_SRC = HTML.match(/^function\s+boardTitle\s*\(.*$/m);

test("board.html still declares TITLE and boardTitle in the shape this file lifts", () => {
  // Named and outside the lift: an assertion thrown during the lift itself
  // runs before node registers any test here, which reports one opaque
  // file-level error instead of naming the claim that stopped holding.
  assert.ok(TITLE_SRC, "board.html no longer declares TITLE as a one-line top-level const — update this test");
  assert.ok(BOARD_TITLE_SRC, "board.html no longer declares boardTitle as a one-line top-level function — update this test");
});

const boardTitle = TITLE_SRC && BOARD_TITLE_SRC
  ? new Function(`${TITLE_SRC[0]}\n${BOARD_TITLE_SRC[0]}\nreturn boardTitle;`)()
  : () => { throw new Error("boardTitle could not be lifted from board.html — see the shape test above"); };

test("boardTitle names the repo when the payload carries one", () => {
  assert.equal(boardTitle("acme/one"), "fleet cockpit — acme/one");
});

// The three ways a payload arrives with no repo to name, all of which used to
// be impossible to get wrong because the page never read the field: `gh repo
// view` failed (null), it answered malformed ("" via gather's `?? repo`
// chain), and the identity stub served before the first tick carries no
// `repo` key at all (undefined). Rendering `fleet cockpit — undefined` on any
// of them is worse than the constant this replaces.
test("boardTitle falls back to the bare constant for every no-repo shape", () => {
  for (const v of [null, undefined, ""]) {
    assert.equal(boardTitle(v), "fleet cockpit", `a ${JSON.stringify(v)} repo must render today's constant`);
  }
});

// Ties the fallback to what the page actually shows before any poll returns —
// a drifting copy in the markup would leave the tab flickering between two
// spellings of the same constant on the first tick.
test("the page's own <title> and header are the constant boardTitle falls back to", () => {
  const title = HTML.match(/<title>([^<]*)<\/title>/);
  assert.ok(title, "board.html no longer carries a <title> — update this test");
  assert.equal(title[1], boardTitle(null));
  const h1 = HTML.match(/<h1[^>]*\sid="heading"[^>]*>([^<]*)<\/h1>/);
  assert.ok(h1, "board.html no longer carries the heading element render writes to — update this test");
  assert.equal(h1[1], "🛰 " + boardTitle(null));
});

// A DOM this page's own script can write to, without a browser: render() is
// lifted out of board.html's source (the same seam boardTitle above uses)
// and run against a document stub just capable enough to hold the writes —
// nothing here reads the stub back except title and the one element this
// test cares about, so append/innerHTML/style are all swallowed no-ops.
class FakeNode {
  constructor() { this.children = []; this.style = {}; }
  set innerHTML(_) { this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
}
function fakeDocument() {
  const byId = new Map();
  return {
    title: "",
    createElement: () => new FakeNode(),
    createTextNode: (text) => ({ text }),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new FakeNode());
      return byId.get(id);
    },
  };
}

// `poll()`'s call at the bottom is the one line this lift must never run —
// it fetches immediately, which a test document has nothing to answer.
const SCRIPT_SRC = HTML.match(/<script>([\s\S]*)<\/script>/)?.[1]
  ?.replace(/\bpoll\(\);\s*$/, "");

test("board.html's <script> still declares render in the shape this file lifts", () => {
  assert.ok(SCRIPT_SRC, "board.html no longer has a lift-able <script> body — update this test");
});

function renderHarness() {
  const document = fakeDocument();
  const render = new Function("document", `${SCRIPT_SRC}\nreturn render;`)(document);
  return { document, render };
}

const baseModel = () => ({
  interval: 15, repoUrl: null, generatedAt: Date.now(),
  attention: [], tickets: [], spend: null, queue: {}, filed: [],
});

// The regression this ticket exists to prevent, pinned on the OBSERVABLE
// rewrite rather than the source text: a board whose repo read fails on a
// later tick must go back to the bare constant. A gate on the repo being
// present — however many tokens of indirection sit between the gate and the
// literal `.repo` — leaves the title pinned from a tick that is no longer
// current, and this catches that by calling render() twice and reading what
// it actually wrote, not how it decided to write it.
test("render rewrites the title and header on every tick, reverting when repo disappears", () => {
  const { document, render } = renderHarness();
  render({ ...baseModel(), repo: "acme/one" });
  assert.equal(document.title, "fleet cockpit — acme/one");
  assert.equal(document.getElementById("heading").textContent, "🛰 fleet cockpit — acme/one");

  render({ ...baseModel(), repo: null });
  assert.equal(document.title, "fleet cockpit",
    "a repo that stops resolving must clear the tab title on the very next render, not leave the prior tick's name showing");
  assert.equal(document.getElementById("heading").textContent, "🛰 fleet cockpit");
});

// #1584 adds a second reader of the model's repo IDENTITY (`acme/one`) beside
// the long-standing reader of its repo URL. A card's PR link must keep
// resolving against the URL — the field that carries the host, so links work
// on GitHub Enterprise — or a card clicked on one board opens nothing, or the
// wrong thing.
test("card still builds its PR link from the model's repoUrl, not from the repo name", () => {
  const card = HTML.match(/^function\s+card\s*\(\w+\)\s*\{[\s\S]*?^\}$/m);
  assert.ok(card, "board.html no longer declares card as a top-level function — update this test");
  assert.match(card[0], /a\.href\s*=\s*\(?\s*repoUrl\s*\)?\s*\?\s*repoUrl\s*\+/,
    "the PR link must be built from repoUrl; the repo name is not a URL");
});
