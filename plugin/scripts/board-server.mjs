// The cockpit's HTTP half: everything downstream of a built model. It owns the
// listener (createBoardServer), the cockpit instance's identity — one workspace,
// one derived port, one state directory — the port scan and the cross-workspace
// handshake that lets a second launch reuse a live cockpit, the `--open`
// browser launcher, and serve() itself, which binds, publishes the identity and
// hands the tick to a callback it is given.
//
// serve() does not read the ledger, does not call `gh` or gather(), and does
// not import compute-board.mjs: what a tick computes is its caller's business.

import { writeFileSync, renameSync, existsSync, readFileSync, mkdirSync, copyFileSync } from "node:fs";
import { NAME, die, warnOnce, execRead } from "./board-common.mjs";
import { fleetFile, FleetDirUnresolvable } from "./fleet-dir.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// `serve --open`'s browser launcher, one per supported platform.
// macOS ships `open`. Linux has no single program, but `xdg-open` is
// the freedesktop one every mainstream desktop provides; WSL usually lacks it
// and has `wslview` (wslu) instead, which hands the URL to the Windows default
// browser. Only a launcher that is NOT ON PATH passes the URL down the list:
// one that ran and failed is the right program meeting a real fault, and the
// next one would not fix that.
//
// Never throws and never exits. A tab that did not open is a warning naming
// the URL — the cockpit is up and serving either way, and the operator can
// open it by hand — so a missing launcher changes nothing about the exit code.
async function openBrowser(url) {
  const tried = [];
  for (const cmd of process.platform === "darwin" ? ["open"] : ["xdg-open", "wslview"]) {
    const r = await execRead(cmd, [url]);
    if (!r.error) return;
    if (r.code === "ENOENT") { tried.push(`${cmd} not found`); continue; }
    tried.push(r.status != null ? `${cmd} exited ${r.status}` : `${cmd} failed: ${r.error.message.split("\n")[0]}`);
    break;
  }
  console.error(`${NAME}: WARNING --open could not open a browser (${tried.join(", ")}) — the cockpit is on ${url}`);
}

// The names a browser on this machine can legitimately put in `Host` to reach
// a loopback-only cockpit. DNS rebinding points an attacker-chosen name at
// 127.0.0.1, and the browser then sends THAT name as `Host`, so the hostname —
// not the peer address, which is loopback either way — is what separates the
// operator's own tab from a rebound page. The port is deliberately not
// compared: an `ssh -L` forward reaches the cockpit under a different local
// port, and the port tells a rebound page nothing it could not scan for.
const COCKPIT_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
// A bracketed IPv6 literal or a bare name, then an optional `:port` — anything
// else (userinfo, a second colon outside brackets, a path) is not a Host value.
const HOST_HEADER = /^(\[[^\]]+\]|[^:[\]]+)(?::\d*)?$/;
function isCockpitHost(host) {
  const m = HOST_HEADER.exec(host ?? "");
  return m !== null && COCKPIT_HOSTNAMES.has(m[1].toLowerCase());
}

// A refused Host is the operator's only clue to why the tab shows a 403 — an
// unlisted spelling of loopback, or a rebound page probing the port — so the
// refusal goes to stderr, once per distinct Host. The value is the client's,
// so it is rendered as a JSON string (quotes, backslashes and C0 controls
// escaped), with DEL, the C1 controls and the U+2028/U+2029 line separators,
// which JSON leaves bare, escaped too, and cut to a bounded length: it cannot
// split or forge a log line. A rebound page can
// send unlimited distinct Hosts, so each server logs at most
// REFUSED_HOST_LOG_CAP of them, then one notice, then nothing new.
const REFUSED_HOST_LOG_CAP = 16;
const REFUSED_HOST_SHOWN = 100;
const COCKPIT_HOST_LIST = [...COCKPIT_HOSTNAMES].join(", ");
export function renderRefusedHost(host) {
  if (host === undefined) return "a request with no Host header";
  const json = JSON.stringify(host.slice(0, REFUSED_HOST_SHOWN))
    .replace(/[\u007f-\u009f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `Host ${json}${host.length > REFUSED_HOST_SHOWN ? `… (${host.length} chars)` : ""}`;
}

export function createBoardServer(dir) {
  let refusedHostsLogged = 0;
  function logRefusedHost(host) {
    if (refusedHostsLogged > REFUSED_HOST_LOG_CAP) return;
    if (refusedHostsLogged === REFUSED_HOST_LOG_CAP) {
      refusedHostsLogged++;
      console.error(`${NAME}: ${REFUSED_HOST_LOG_CAP} distinct Hosts refused; further refused Hosts are not logged`);
      return;
    }
    const shown = renderRefusedHost(host);
    if (warnOnce("host-refused", shown, `refused ${shown} — not a loopback name (${COCKPIT_HOST_LIST}); answered 403`)) refusedHostsLogged++;
  }
  return createServer((req, res) => {
    // Checked before routing, so an unknown path on a foreign Host is as
    // opaque as a known one: 403, never a 404 that tells a rebound page which
    // paths exist.
    if (!isCockpitHost(req.headers.host)) {
      logRefusedHost(req.headers.host);
      res.writeHead(403); res.end("forbidden"); return;
    }
    const url = (req.url || "/").split("?")[0];
    const path = url === "/" || url === "/board.html" ? join(dir, "board.html")
      : url === "/board.json" ? join(dir, "board.json") : null;
    if (!path || !existsSync(path)) { res.writeHead(404); res.end("not found"); return; }
    const type = path.endsWith(".json") ? "application/json" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(readFileSync(path));
  });
}

// A cockpit instance is identified by its WORKSPACE — the directory holding
// the shared git dir — not by the process's cwd and not by the machine. Two
// workspaces therefore get two boards on two ports, both live and neither
// aware of the other, and one workspace derives the SAME port on every run,
// so that URL survives runs, reboots and node versions.
//
// BASE is the port this file hardcoded before any of this existed;
// resolveCockpitInstance()'s degrade arm, with no workspace to hash, still
// defaults to it. SPAN = 512 was kept deliberately: a
// collision between two DIFFERENT workspaces is not priced into the width but
// carried by serve()'s launch loop, which probes whoever holds the derived
// port, reuses that cockpit when it is this workspace's own, and otherwise
// scans on through cockpitPorts()'s PORT_ATTEMPTS candidates. The accepted
// cost is launch order: whichever colliding workspace starts second binds a
// port other than the one its hash derives.
const PORT_BASE = 8123;
const PORT_SPAN = 512;

// FNV-1a, 32-bit, written out inline. Three properties this needs that no
// crypto digest and no Math.random has together: stable across node versions
// and across machines (nothing in here reads the engine, the host or the
// clock), dependency-free, and cheap enough to run on every start. Math.imul
// is the whole reason it is spelled this way — a plain `h * 0x01000193`
// leaves exact integer range after two rounds and silently stops being FNV.
// `>>> 0` is load-bearing, not decoration: without it `h` stays SIGNED, so
// `h % PORT_SPAN` can come back negative and the derived port lands BELOW
// base, outside the window this function's own contract promises.
function workspaceHash(key) {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// The one spelling of "this value is a workspace identity", read by every
// side of the cockpit handshake. The invariant is that null and the
// empty string are never an identity to match on, and it used to be carried
// by two independently-written guards — resolveCockpitInstance()'s
// `workspace === null` below and probeCockpitWorkspace()'s
// `typeof w === "string" && w !== ""` — correct only because both were
// written consistently, not because anything stopped one from moving without
// the other. What a drift buys is silent and cross-workspace: let the
// construction side call the empty string an identity while the parsing side
// still accepts it, and two cockpits in two different workspaces, neither
// with an identity established, match each other's board and one reuses the
// other — a hand-off nothing else in this file would refuse, since the
// degrade arm's "no identity to match on" is the only thing keeping a held
// port fatal there.
//
// A non-empty string, and nothing more: no trim(). A wholly-whitespace
// answer to `--git-common-dir` is already refused one layer down, by
// git-env.mjs's resolveWorkspace() inside fleet-dir.mjs's fleetFile(), so no
// identity reaching either call site can be whitespace —
// the construction side gets the workspace fleetFile() resolved and the
// parsing side gets a payload some process wrote from it. A second whitespace
// rule here would be one more guard of exactly the kind this predicate exists
// to stop writing.
//
// Not exported, for workspaceHash()'s reason above it: nothing outside this
// file asks the question, and every widening of it is already pinned from
// outside through the two call sites — mutation-verified for this extraction
// and each mutant was killed by a test that already existed in the board tests:
// `v != null && v !== ""` by the probe's not-a-string row, `typeof v ===
// "string"` by its empty-workspace row, a degrade arm publishing `""` by
// resolveCockpitInstance's three degrade rows, and dropping it from
// serve()'s `scannable` by the CLI's held-port-on-the-degrade-arm row. So no
// test is added here: sharing the predicate is what makes the construction
// side's rows constrain the parsing side and back, which is a STRONGER suite
// than before, not one with a hole a new row could fill.
function isWorkspaceId(v) {
  return typeof v === "string" && v !== "";
}

/**
 * The cockpit's instance seam, and the only one. Given a cwd, the workspace
 * this cockpit belongs to — INJECTED, already resolved, or null when it could
 * not be — and an explicitly requested port if there was one, decide which
 * state directory this cockpit serves and which port it binds.
 *
 * Pure: it listens to nothing, spawns nothing, reads nothing and writes
 * nothing, so every branch below is reachable from a test with no git repo
 * and no socket.
 *
 * The workspace comes from fleet-dir.mjs's fleetFile(), the same locator the
 * run's ledger and heartbeat are resolved with — so the board, the ledger and
 * the heartbeat cannot disagree about which run they belong to — asked with
 * the `canonicalise` opt-in only this caller takes: a symlinked route to one
 * workspace must derive that workspace's port instead of a second, private
 * one.
 *
 * `why` is fleetFile()'s message when it could not answer — it names what
 * failed, and the degrade warning below carries it, as the ledger's does.
 * Absent, the warning names the failure without a reason.
 */
export function resolveCockpitInstance({ cwd = process.cwd(), workspace, why, port } = {}) {
  // `port != null`, never truthiness: --port 0 is a real request (an
  // ephemeral bind) and reading it as "absent" would derive a port
  // straight over the top of one the caller explicitly asked for.
  const forced = port != null;
  // Asked as `!isWorkspaceId(...)` rather than `=== null`: the question this
  // arm answers is "was an identity established", and what counts as one is
  // the predicate above — the same one the probe parses with, so the two
  // sides cannot answer it differently.
  if (!isWorkspaceId(workspace)) {
    // Degrade, never die: a non-git or otherwise unusual checkout still gets
    // a board. The wording is the ledger's rather than a second dialect for
    // the same failure, trailing parenthetical included — that parenthetical
    // names what is degraded HERE, which is not what is degraded there.
    console.error(`${NAME}: WARNING ${why || "could not resolve --git-common-dir"}; using cwd-relative .fleet (a second cockpit in another workspace may collide on this port and this state directory)`);
    // Absolute, like the resolved arm, but anchored on the cwd — which is
    // what "cwd-relative" resolves to and what this script's fs calls did
    // with the bare `.fleet` they used before. No workspace was established,
    // so there is no key to hash and the port is BASE: today's default,
    // unchanged, for the case that used to be the only case.
    return { stateDir: join(cwd, ".fleet"), workspace: null, port: forced ? port : PORT_BASE, derived: !forced };
  }
  return {
    stateDir: join(workspace, ".fleet"),
    workspace,
    port: forced ? port : PORT_BASE + (workspaceHash(workspace) % PORT_SPAN),
    derived: !forced,
  };
}

// The impure half, deliberately outside the seam above: the `{ workspace }`
// fleetFile() resolves from `cwd`, or `{ workspace: null, why }` when it
// cannot — which takes the degrade arm above, so a non-git checkout, a stalled
// git and git missing entirely all still get a board, with the reason on its
// warning. Spread into resolveCockpitInstance()'s arguments.
export function cockpitWorkspace(cwd) {
  try {
    return { workspace: dirname(fleetFile(null, { cwd, canonicalise: true })) };
  } catch (e) {
    if (!(e instanceof FleetDirUnresolvable)) throw e;
    return { workspace: null, why: e.message };
  }
}

// How many ports one launch may try before it gives up, and the whole cost
// of the scan: the worst case is ATTEMPTS × (a bind plus a probe), so a
// workspace whose derived port sits in a crowded corner of the range still
// fails in seconds rather than walking all 512. It also bounds how far a
// cockpit can land from the stable URL its workspace derives — a board a
// handful of ports from where it is bookmarked is still findable by hand,
// while one hundreds of ports away (where an unbounded scan could leave it)
// typically is not.
const PORT_ATTEMPTS = 8;

/**
 * The ports one launch may try, in order, for a resolved instance — the
 * second half of the instance seam and pure like the first, so every row
 * below is reachable with no socket.
 *
 * An EXPLICIT port collapses to a single candidate: the operator named a
 * port, so there is nothing to scan and (guarded separately in serve()) no
 * holder to handshake with.
 *
 * A DERIVED one starts at the derived port — the stable, bookmarkable one —
 * and walks forward MODULO the span, never out of the window
 * resolveCockpitInstance() promises. Without the wrap a workspace hashing to
 * the top of the range would scan straight past 8634 into ports belonging to
 * nothing in this scheme, and the range this exists to stay inside would be
 * a range in name only.
 */
export function cockpitPorts({ port, derived }) {
  if (!derived) return [port];
  const offset = port - PORT_BASE;
  return Array.from({ length: PORT_ATTEMPTS }, (_, i) => PORT_BASE + ((offset + i) % PORT_SPAN));
}

// One bind attempt, as a value rather than as an event. Resolves with null
// on success and with the error otherwise — never rejects, because every
// caller has to READ the code (EADDRINUSE is negotiable, everything else is
// fatal) and a rejection would make that a try/catch around a control-flow
// decision. The listeners are removed on whichever side loses: a server that
// failed to bind is dropped, and one that bound gets serve()'s own long-
// lived error handler instead of this one-shot.
function bindFailure(server, port) {
  return new Promise((resolve) => {
    const onError = (e) => { server.removeListener("listening", onListening); resolve(e); };
    const onListening = () => { server.removeListener("error", onError); resolve(null); };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, COCKPIT_HOST);
  });
}

// Whether something already answers on COCKPIT_HOST:port, asked BEFORE the
// bind rather than read off it: a 127.0.0.1 bind does not reliably fail when
// the port is taken. On macOS/BSD, SO_REUSEADDR lets it succeed beside a
// listener that holds every interface — a dev server, or a cockpit started
// before the bind was narrowed to loopback — and the launch would then sit
// on that holder's 127.0.0.1 traffic instead of stepping over it or reusing
// it. Linux refuses that bind outright; this check gives both the same answer.
// Resolves in bindFailure()'s vocabulary so the loop reads one shape: null
// when the connection is refused (nothing holds the port), an EADDRINUSE
// error when it connects or times out, and any other error as itself,
// marked `heldCheck` — a fault of its own, like EACCES on a bind, which the
// loop reports as this check's rather than the bind's, whatever code the
// error carries. A timeout counts as held because a live holder whose accept
// backlog is full drops the SYN rather than refusing it. The window between
// this check and the bind is a race the loop accepts, like its others.
function heldFailure(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: COCKPIT_HOST, port });
    const held = () => {
      socket.destroy();
      resolve(Object.assign(new Error(`port ${port} answers on ${COCKPIT_HOST}`), { code: "EADDRINUSE" }));
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, held);
    socket.once("connect", held);
    socket.once("error", (e) => resolve(e.code === "ECONNREFUSED" ? null : Object.assign(e, { heldCheck: true })));
  });
}

// ~1s per attempt, and the whole reason this is a probe and not a lockfile:
// a launch that cannot get an answer within a second must proceed, not
// wait. A holder that accepts the connection and then says nothing is the
// case that pays for this timer — nothing else in a socket read bounds it.
// One silent window does not settle the question, though: nothing in a socket
// read tells a port nobody holds from one whose holder was busy for that
// second, and a box under load, a process still between its bind and its
// identity write, or a dropped SYN all produce the second shape. The probe
// retries once before it will call a silent port foreign.
//
// Until the tick's reads became asynchronous the commonest producer of that shape was this cockpit itself —
// a same-workspace holder blocked inside its own synchronous gather() when
// the probe arrived, for the 4.72–4.91s a board took to build, which no
// number of retries at this timeout would have covered. That one is gone at
// the source: the tick's reads are asynchronous and the server answers
// throughout. Raising this timeout was
// ruled out as the fix for it — it would have to clear a gather(), which
// charges every launch past a stranger-held port that much per candidate.
const PROBE_TIMEOUT_MS = 1000;
// The one address a cockpit binds, and so the one address the probe and the
// pre-bind check dial: whatever holds a candidate where this launch would
// bind answers here. 127.0.0.1 rather than `localhost` keeps a resolver out
// of the launch path, and loopback alone keeps the board — a read-only
// mirror of the ledger — off every other machine on the network; remote
// viewing goes through an `ssh -L` tunnel. IPv4 only: `::1` is left unbound,
// which is why every URL printed below names 127.0.0.1 too. `localhost`
// resolves `::1` first, and on `::1` a browser can reach some other process
// that holds the same port.
const COCKPIT_HOST = "127.0.0.1";
// A holder is not necessarily a cockpit, and a second of localhost writes is
// a lot of memory to accept from one. The board payload for a real run is
// kilobytes; anything past this is not one, so it is refused as foreign
// rather than buffered.
const PROBE_BODY_CAP = 1024 * 1024;

/**
 * Ask whoever holds `port` which workspace it is serving. Returns that
 * workspace, or null for every other outcome there is — a refused
 * connection, a non-200, a body that is not JSON, a payload with no usable
 * `workspace`, a body over the cap, or a holder that never answers across
 * two attempts.
 *
 * Null is deliberately one value for all of them: the caller's question is
 * "is this my own cockpit", and every way of failing to prove that is the
 * same answer — foreign. A holder that IS this workspace's cockpit answers
 * with the board payload it already serves, so no endpoint is added for
 * this and the handshake reaches nothing a browser could not. The one
 * consequence to know: a cockpit started from a build older than the identity handshake
 * serves a payload with no `workspace` at all, so it reads as foreign and a
 * launch steps over it rather than reusing it — once, until that process is
 * restarted.
 *
 * A bare timeout gets one retry rather than folding straight into
 * "foreign": nothing in a socket read distinguishes "nobody is there" from
 * "busy for that second", and a loaded box produces the second shape. Only a
 * second silent window calls it, and says so on stderr distinctly from a
 * confirmed non-match — a shrug is not a verdict.
 */
export function probeCockpitWorkspace(port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let attempts = 0;
    const probeOnce = () => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        req.destroy();
        attempts += 1;
        if (attempts < 2) { probeOnce(); return; }
        console.error(`${NAME}: no answer from port ${port} within ${timeoutMs * 2}ms — cannot confirm it is this workspace's cockpit`);
        resolve(null);
      }, timeoutMs);
      function finish(workspace) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // Destroy rather than let it drain: an unread body, or a holder
        // still writing one, would otherwise keep this socket — and the
        // launch — alive well past the answer.
        req.destroy();
        resolve(workspace);
      }
      const req = httpRequest({ host: COCKPIT_HOST, port, path: "/board.json", method: "GET" }, (res) => {
        if (res.statusCode !== 200) { finish(null); return; }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => { body += d; if (body.length > PROBE_BODY_CAP) finish(null); });
        res.on("end", () => {
          let w;
          try { w = JSON.parse(body)?.workspace; } catch { finish(null); return; }
          // Exactly the construction side's rule, because it is literally
          // the same predicate: a non-string, or the empty string,
          // is no identity. `=== ours` would be false for the first anyway,
          // but an empty string could match an empty workspace and there
          // must be no such thing.
          finish(isWorkspaceId(w) ? w : null);
        });
      });
      req.on("error", () => finish(null));
      req.end();
    };
    probeOnce();
  });
}

export async function serve({ port: portGiven, interval, open, tick }) {
  // Both the served state directory and the port come from
  // resolveCockpitInstance() now, rather than a cwd-relative `.fleet` and a
  // constant 8123. That is what lets two workspaces run two boards at once
  // without either writing into the other's state directory, and it ties the
  // board to the same workspace the ledger resolves itself against.
  //
  // A GIVEN-but-invalid --port is refused outright in main() and never
  // reaches here; an ABSENT one arrives as `portGiven` null, which is how the
  // seam is told to derive rather than obey.
  //
  // A bind failure no longer means one thing, so the two kinds of port part
  // company here. One this script DERIVED is negotiable: the loop below
  // handshakes with whoever holds it and steps over a stranger. One
  // the caller CHOSE is not — the refusal names that port bare and dies,
  // because scanning off it would serve the board somewhere the operator did
  // not ask for and reusing it would hand them someone else's. What tells
  // them apart is `instance.derived` and not truthiness on `portGiven`: an
  // explicit `--port 0` is falsy (a legal ephemeral bind), so the old
  // spelling gave it the derived port's treatment, and nothing pinned that.
  const instance = resolveCockpitInstance({ cwd: process.cwd(), ...cockpitWorkspace(process.cwd()), port: portGiven });
  const stateDir = instance.stateDir;
  const jsonPath = join(stateDir, "board.json");
  // A held port used to mean three different things this loop could
  // only tell apart by binding first and probing whichever candidate
  // happened to refuse — so a live cockpit that landed past a squatter
  // which has since departed was invisible the moment that squatter's port
  // freed (this process would just bind it directly), and a workspace with
  // no identity established (the degrade arm) still scanned past a held
  // port with nothing a handshake could ever match, reopening the
  // dual-cockpit hazard.
  //
  // Bind stays ahead of any handshake per candidate — only heldFailure()'s
  // bare connect precedes it: that is what lets two launches racing at start
  // settle on one winner quickly, the winner's identity published (below)
  // before it can block inside its own first tick.
  // But a successful bind is not the end of the story — once this process
  // holds a candidate, the REST of the window still gets checked for a
  // live cockpit that landed further along, exactly the shape a departed
  // squatter leaves behind, and only when nothing there matches does this
  // process keep what it bound. A held candidate is probed the same way,
  // one at a time as the loop reaches it. Neither check runs at all when
  // this workspace has no identity to match on: an explicit --port
  // (`!instance.derived`) and the degrade arm (no `isWorkspaceId` identity)
  // never had a handshake to reach in the first place, so a held port for
  // either stays fatal, exactly as it was before the handshake existed.
  const candidates = cockpitPorts(instance);
  const scannable = instance.derived && isWorkspaceId(instance.workspace);
  let server = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const attempt = createBoardServer(stateDir);
    // --port 0 asks the kernel for a port nobody holds; there is nothing to dial.
    const failure = (candidate === 0 ? null : await heldFailure(candidate)) ?? await bindFailure(attempt, candidate);
    if (!failure) {
      const rest = scannable ? candidates.slice(i + 1) : [];
      const holders = await Promise.all(rest.map((p) => probeCockpitWorkspace(p)));
      const matchAt = holders.indexOf(instance.workspace);
      if (matchAt === -1) { server = attempt; break; }
      attempt.close();
      const url = `http://${COCKPIT_HOST}:${rest[matchAt]}/`;
      console.error(`${NAME}: cockpit already running for this workspace on ${url}`);
      // Nothing is opened here, --open or not. This cockpit was
      // already running when this launch arrived, so its tab was the business
      // of the launch that started it; run-team's phase 0 relaunches on every
      // re-shortlist, and opening here stacked one more tab for the same
      // board each pass. Only a launch that binds a port and starts the
      // server opens one, below.
      //
      // Exit 0 — and explicitly, not by returning: a backgrounded launch
      // reports nothing but its exit code, and a handle left behind by the
      // probe would otherwise hang this process forever while it holds no
      // port at all.
      process.exit(0);
    }
    // Only a port that is TAKEN is a candidate for any of the below. EACCES
    // on a privileged port, EADDRNOTAVAIL on an unusable address, a pre-bind
    // connect that fails with anything but ECONNREFUSED: those are faults of
    // their own, and scanning past them would bury each one under an
    // exhausted-range message at the end that names the wrong problem. A bind
    // error dies with its own text; a held-check error dies naming the check,
    // which a raw connect message does not, and does so whatever code the
    // connect error carries: only a bare EADDRINUSE from the bind itself, or
    // the held signal heldFailure() resolves, means the port is taken.
    if (failure.heldCheck) die(`cannot check whether port ${candidate} is held: ${failure.message}`);
    if (failure.code !== "EADDRINUSE") die(failure.message);
    if (!scannable) die(`port ${candidate} in use — pass --port <n>`);
    const holder = await probeCockpitWorkspace(candidate);
    if (holder === instance.workspace) {
      const url = `http://${COCKPIT_HOST}:${candidate}/`;
      console.error(`${NAME}: cockpit already running for this workspace on ${url}`);
      // Already running, so nothing opens — the same rule as the arm above.
      process.exit(0);
    }
    console.error(`${NAME}: port ${candidate} is held by something that is not this workspace's cockpit — trying the next port`);
  }
  if (!server) die(`no free port for this workspace — tried ${candidates.join(", ")}; pass --port <n> to choose one`);

  // Only now — with a bind this process is actually keeping — does it need
  // the state directory and board.html. Never for a launch either check
  // above already turned into a no-op: this shares the state directory
  // with whatever this workspace's live cockpit is doing, and touching it
  // before reuse was settled was a defect in the reuse
  // arm (mkdirSync/copyFileSync used to run before the candidate loop).
  mkdirSync(stateDir, { recursive: true });
  try { copyFileSync(join(SCRIPT_DIR, "board.html"), join(stateDir, "board.html")); }
  catch (e) { die(`cannot stage board.html into ${stateDir}: ${e.message}`); }

  // A bind failure is handled above, one candidate at a time; this handler
  // owns everything a LISTENING server can still emit. Without it an 'error'
  // event after the bind has no listener at all and node rethrows it as an
  // uncaught exception — the one regression the loop above would otherwise
  // introduce by taking the old, always-attached handler away with it.
  server.on("error", (e) => die(e.message));

  // Everything below is reached only by a process that HOLDS a port, which is
  // what the listen-callback gating bought and what this loop has to keep
  // paying for by position: tick() writes into stateDir, SHARED by every cwd
  // that resolves to this workspace, so a process that never binds must not
  // reach it. A second cockpit that ticked first would overwrite the live
  // one's board.json and reset every ticket's dwell clock.
  //
  // Announce the port we GOT, not the one we asked for. They differ for the
  // one value `--port 0` newly permits: listen(0) binds an ephemeral port, so
  // echoing the request prints — and --opens — http://127.0.0.1:0, which
  // reaches nothing while the board sits on a port nobody was told.
  // address() is only populated once listening, hence only here.
  const bound = server.address().port;
  console.error(`${NAME}: cockpit on http://${COCKPIT_HOST}:${bound}  (interval ${interval}s)`);

  // Publish identity the instant this port is ours — before the
  // first tick, which is the one that can be slow (its gather shells out to
  // gh and ledger.mjs). A sibling launch races this one by sending its
  // probe as soon as ITS bind attempt refuses, which can be well before
  // this process's first tick ever returns; the answer that probe needs
  // has to already be on disk, not waiting on a compute this process has
  // not started yet.
  // `port` rides along. This stub is a board payload like any other
  // for as long as the first tick takes, and a reader that finds it —
  // the operator, a script, the page — gets the same two identity fields
  // from it that every later tick writes. The handshake above still reads
  // only `workspace`.
  writeFileSync(`${jsonPath}.tmp`, JSON.stringify({ workspace: instance.workspace, port: bound }));
  renameSync(`${jsonPath}.tmp`, jsonPath);
  // Yield once so a connection already arriving — that same sibling's probe —
  // gets a chance to read the identity just written before this process starts
  // the first tick. The tick no longer blocks the loop, but its gather
  // still opens with a synchronous prev-board read before its first await, and
  // a turn of the loop costs nothing.
  await new Promise((resolve) => setImmediate(resolve));

  // Deliberately not awaited: the first tick is the slow one, and everything
  // below it — the timer, and the two signal handlers — must be in place
  // before it returns, not after. Nothing here rejects; tick() catches its own
  // faults and the `ticking` flag it sets is cleared in a finally (see
  // boardTick()).
  //
  // A tick that answers `true` has written its board and found the run's
  // controller gone: the cockpit lives as long as that controller, and stop()
  // below is its way out, the same one a signal takes. Any other answer, a
  // skipped tick's `undefined` included, serves on.
  const tickArgs = { served: bound, stateDir, jsonPath, workspace: instance.workspace };
  const runTick = async () => { if (await tick(tickArgs) === true) stop(); };
  const timer = setInterval(runTick, interval * 1000);

  const stop = () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
    server.closeAllConnections?.();                  // drop keep-alive sockets so close() resolves promptly
    setTimeout(() => process.exit(0), 1000).unref();  // hard backstop if a socket somehow lingers
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  runTick();

  // --open, from this launch alone: it is the one that bound a port and
  // started a server, and the reuse arms above open nothing. Only
  // once the identity is on disk — a launcher running BEFORE that write put a
  // child squarely inside the window the identity stub exists to keep empty, where a
  // racing launch's probe finds no payload and reads this port as foreign —
  // and only after the tick, the timer and both signal handlers are in
  // place: `xdg-open` can run the browser it starts in the foreground and
  // return only when that browser exits, so a launcher awaited any earlier
  // could hold the first tick back for the whole session. openBrowser()
  // never throws; a launcher that is missing or fails is one warning line.
  if (open) await openBrowser(`http://${COCKPIT_HOST}:${bound}/`);
  await new Promise(() => {}); // run until signalled
}
