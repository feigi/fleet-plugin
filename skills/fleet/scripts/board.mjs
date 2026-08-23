#!/usr/bin/env node
// The cockpit's I/O layer. `build` gathers ledger + gh + CI state, calls the
// pure computeBoard(), and prints board.json. `serve` (below) loops build,
// atomic-writes .fleet/board.json, and serves board.html. The board never
// depends on the controller feeding it.
//
// Pipeline state is a pure function of ledger + GitHub. The spend panel adds a
// THIRD input that is neither — the local Claude Code transcript tree under
// ~/.claude/projects — so the "f(ledger, gh)" property no longer covers the
// whole model. It is telemetry, kept strictly to the side: it can only ever
// populate or omit `spend`, never change a ticket's stage.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync, readdirSync, statSync } from "node:fs";
import { classifyRole, computeSpend, attributeTools, mergeTools } from "./compute-spend.mjs";
import { makeDie, makeArg, makeHas, makeSweep } from "./arg.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";

const NAME = "board";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
// die()/arg()/has() shared with the other fleet scripts — see arg.mjs for
// the fail-open (#61/#169/#364) and pipe-safety (#176/#328/#363) rationale.
const die = makeDie(NAME);
const arg = makeArg(die);
const has = makeHas(die);
const sweep = makeSweep(die);
// `ledger`/`prev`/`spend-since`/`port`/`interval` are all read with `||`/`??`
// fallbacks, so a trailing flag previously substituted a default in total
// silence — `--spend-since` with nothing after it silently widened the spend
// panel to all-time instead of the requested window, and `--ledger` with
// nothing after it silently read the DEFAULT ledger file instead of the one
// asked for.
//
// A guard only fires where the flag is actually READ, and that is not every
// subcommand. `port` and `open` are read in serve() alone, so `build --port`
// (trailing), `build --port abc` and `build --open=1` are all IGNORED at exit
// 0 rather than refused (measured) — the one silent-default shape this list
// does not close. `ledger`/`prev`/`spend-since`/`interval` are read on the
// build path too and do refuse there. Pre-existing and not introduced here;
// said out loud so the list above is not read as "guarded on every path".

// #366: `Number(x) || default` treated a garbage --port/--interval exactly
// like an absent one — "abc" is NaN, NaN is falsy, so it silently became the
// default with no refusal. Same silent-fallback class as arg()'s own comment
// above and #361's --spend-since guard. `interval` is read from argv in two
// places (serve(), and gather()'s build payload); both call argInterval() so
// the check lives once, not as two copies that can drift apart. Neither
// guard runs on an already-typed value a caller passed in-process — arg()
// only fires when the caller falls through to reading raw argv.
function argPort() {
  const raw = arg("port");
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) die(`--port wants an integer 0-65535, got ${raw}`);
  return n; // 0 is a real value — listen(0) binds an ephemeral port
}
// Bounded at BOTH ends, like argPort(). The ceiling is setInterval's 32-bit
// millisecond delay: hand it more and Node clamps the delay to 1ms with only a
// TimeoutOverflowWarning, so `--interval 3000000` (34 days) turns the rebuild
// loop into a spin loop shelling out to gh hundreds of times a second — the
// inverse of what was asked, announced by nothing the board prints (#435
// review). 2147483647ms / 1000, floored, is the last WHOLE second that fits;
// the ceiling is a hair under that in fractional seconds, which nobody types.
function argInterval() {
  const raw = arg("interval");
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 2147483) die(`--interval wants seconds > 0 and <= 2147483, got ${raw}`);
  return n;
}

// Every external read is wrapped: a failure returns null and the caller keeps a
// last-known value. Partial board beats a crashed loop or a false alarm.
function tryRun(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: "utf8" }); }
  catch (e) { console.error(`${NAME}: ${cmd} ${args.join(" ")} failed: ${e.message}`); return null; }
}

// Parse tool stdout defensively: a tool can exit 0 yet print malformed or
// warning-prefixed stdout. Treat that like a failed read (fall back to the
// caller's empty default), never let it crash the tick.
function tryParse(json, fallback, what) {
  if (json == null) return fallback;
  try { return JSON.parse(json); }
  catch (e) { console.error(`${NAME}: ${what} parse failed: ${e.message}`); return fallback; }
}

// ci-state.mjs exits 0 for green, 1 for not-green, 2 for a hard failure — and on
// exit 1 it has ALREADY printed its verdict JSON to stdout before exiting, so a
// thrown exit 1 carries a real verdict. Feed that to mapCi: discarding e.stdout,
// as a plain tryRun would, makes red/still-running CI unreachable — every
// non-green PR reads as "unknown" and the red-ci flag, the top of the attention
// strip, never fires.
//
// What separates a verdict from a failed read is the EXIT CODE. Emptiness of
// stdout was only ever a proxy for it, and #262 retired the proxy: a quota
// refusal now names its cause on stdout on the way out at exit 2, so "non-empty
// stdout" began reading an outage as a reading. That payload carries no
// `status`, so mapCi answered "unknown" and gather()'s prevCi carry-forward —
// which only a null return reaches — was skipped, overwriting a PR's
// last-known-good CI state during a blip that clears itself. Exit 2 means the
// question could not be answered, whatever the script printed while saying so.
function runCiState(scriptDir, pr) {
  try {
    return execFileSync("node", [join(scriptDir, "ci-state.mjs"), "--pr", String(pr), "--quiet"], { encoding: "utf8" });
  } catch (e) {
    const out = e.stdout ? e.stdout.toString() : "";
    if (e.status !== 2 && out.trim()) return out;
    console.error(`${NAME}: ci-state --pr ${pr} failed: ${e.message}`);
    return null;
  }
}

// ci-state's verdict already excludes behind-count staleness. Map it, and treat
// anything not cleanly green-or-completed-red as unknown — never a false red.
export function mapCi(ciJson) {
  if (!ciJson) return "unknown";
  let d;
  try { d = JSON.parse(ciJson); } catch { return "unknown"; }
  if (d.status !== "completed") return "unknown"; // still running, or no run yet (status null)
  if (d.verdict === "green") return "green";
  if (d.verdict === "not-green") return "red";
  return "unknown";
}

// Where this session's subagent transcripts live: Claude Code writes them to
// ~/.claude/projects/<encoded-cwd>/<session-uuid>/subagents/.
//
// The encoding replaces every non-alphanumeric character with `-`, so
// /Users/x/.claude encodes to `-Users-x--claude` (double dash), not
// `-Users-x-.claude`. Replacing only slashes silently missed every cwd
// containing a dot — including this repo, which is what the fleet skills
// themselves run out of, so the panel never rendered here at all. The miss is
// invisible by construction: a wrong path just fails existsSync and returns
// null, which looks exactly like "no data".
export function encodeProjectDir(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// The session uuid is not knowable from here, so take the most recently active
// one. Rank on the newest TRANSCRIPT mtime, not on the subagents directory's
// own: a directory's mtime moves when an entry is created or removed, never
// when a file inside it is appended to. Ranking on the directory therefore
// tracked the last agent SPAWN rather than the last agent activity — and since
// the cockpit launches in run-team phase 0, before the first agent spawns, the
// live session has no subagents dir yet and a PREVIOUS session won. The board
// would render a prior run's spend as this run's, then silently switch when the
// first agent landed. That is the one failure mode here that produces
// confidently wrong numbers rather than no numbers.
//
// Returns { error } when the project dir cannot be resolved at all — a bug that
// never fixes itself — and null when it resolves but holds no sessions yet,
// which is normal at run start. Collapsing those two into one bare null is what
// hid the encoding bug above.
export function findSubagentsDir(home = process.env.HOME, cwd = process.cwd()) {
  try {
    const projects = join(home, ".claude", "projects", encodeProjectDir(cwd));
    if (!existsSync(projects)) return { error: `no transcript dir for cwd ${cwd} (looked in ${projects})` };
    const cands = readdirSync(projects)
      .map((s) => join(projects, s, "subagents"))
      .filter((d) => existsSync(d))
      .map((d) => ({ d, m: newestTranscriptMs(d) }))
      .sort((a, b) => b.m - a.m);
    return cands.length ? cands[0].d : null;
  } catch (e) { return { error: `transcript lookup failed: ${e.message}` }; }
}

// Newest *.jsonl mtime in a subagents dir, 0 if it holds none. A dir whose
// transcripts are all unreadable loses to one that is readable, which is the
// behaviour we want when picking "the live session".
//
// The scan is wrapped for the same reason the per-file stat below is. This runs
// once per CANDIDATE, so an uncaught throw here does not just lose one dir — it
// escapes findSubagentsDir's try and turns the whole lookup into { error },
// blacking out every readable session over one bad sibling. Scoring 0 is what
// the comment above already promises: a dir we cannot read simply loses.
function newestTranscriptMs(dir) {
  let names;
  try { names = readdirSync(dir); } catch { return 0; }
  let newest = 0;
  for (const f of names) {
    if (!f.endsWith(".jsonl")) continue;
    try { newest = Math.max(newest, statSync(join(dir, f)).mtimeMs); } catch { /* raced away */ }
  }
  return newest;
}

// Read one agent transcript into the shape the pure module wants. Single pass —
// a long review agent's transcript is megabytes and this runs every tick.
// Malformed lines are skipped rather than fatal: a transcript being appended to
// WHILE we read it will have a torn last line, every tick.
//
// ONE assistant API turn is written as SEVERAL jsonl lines — one per content
// block (thinking, text, each tool_use) — and every one of those lines repeats
// the SAME `message.id` and the SAME `message.usage` object. Summing usage per
// LINE therefore counts each turn's cache_creation once per block: measured
// across 2452 real transcripts, +206% (535M counted vs 175M actual), with
// 2445 of them affected. So fold lines back into turns on `message.id` and take
// each turn's usage exactly once.
//
// `output_tokens` is the one field that genuinely differs across a turn's lines:
// it is a streaming snapshot, so the LARGEST value is the final one. Summing it
// double-counts too, though only by ~1.5%.
//
// The meta read below is guarded by existsSync, so the UNNAMED-AGENT case never
// runs the guarded read — it simply leaves `meta` at {}. Everything that does
// reach the catch is a real fault: a sidecar read torn mid-write,
// EACCES/EISDIR, a delete racing the existsSync, or valid JSON of the wrong
// SHAPE (guard below). Swallowing those booked the agent's whole spend as
// `other` with nothing on stderr, which moves reviewPct — the review headline
// compute-spend.mjs calls the one number anyone acts on. Measured on a
// two-agent fixture: an intact reviewer sidecar gives reviewPct 80, the same
// sidecar truncated gives 0, in silence (#325).
//
// Keep the {} fallback rather than rethrowing. The TRANSCRIPT is still readable,
// so a throw would land in gatherSpend's per-file catch and drop this agent's
// real tokens from the totals — a wrong total in place of a wrong role, and one
// the panel would then also count as `skipped`. Warn-once per PATH, for the
// reason warnedSkips gives below: `serve` rebuilds every ~15s, and a broken
// sidecar is broken on every tick.
const warnedMeta = new Set();
function readAgent(file, metaFile) {
  let meta = {};
  try {
    if (existsSync(metaFile)) {
      // JSON.parse SUCCEEDS on `null`, a bare number, a string, an array — none
      // of which classifyRole or `meta.description` can read. Reject the shape
      // here, so it takes the warn path below like any other sidecar fault. Left
      // to reach `a.meta.description`, it throws into gatherSpend's per-file
      // catch instead, which drops this agent's real tokens, counts it
      // `skipped`, and names the TRANSCRIPT in a fault that is the sidecar's.
      const m = JSON.parse(readFileSync(metaFile, "utf8"));
      if (typeof m !== "object" || m === null || Array.isArray(m))
        throw new TypeError(`expected a JSON object, got ${m === null ? "null" : Array.isArray(m) ? "array" : typeof m}`);
      meta = m;
    }
  }
  catch (e) {
    if (!warnedMeta.has(metaFile)) {
      warnedMeta.add(metaFile);
      console.error(`${NAME}: ${metaFile} unusable, classifying agent as "other": ${e.message}`);
    }
  }

  let cacheWrite = 0, cacheRead = 0, maxCtx = 0;
  const entries = [];
  const turnById = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    // `message.content` is an array of blocks on tool-bearing turns but a plain
    // STRING on ordinary prose turns — the first cut assumed an array and threw
    // on the very first user line, which the catch below turned into a silent
    // null spend panel. Normalise once, here.
    const blocks = Array.isArray(j.message?.content) ? j.message.content : [];
    const u = j.message?.usage;
    if (u) {
      const id = j.message?.id;
      let turn = id == null ? undefined : turnById.get(id);
      if (!turn) {
        // First line of this turn — bill its usage now, once.
        const cw = u.cache_creation_input_tokens ?? 0;
        const cr = u.cache_read_input_tokens ?? 0;
        cacheWrite += cw;
        cacheRead += cr;
        maxCtx = Math.max(maxCtx, (u.input_tokens ?? 0) + cr + cw);
        turn = { kind: "assistant", cacheWrite: cw, tools: [], output: 0 };
        entries.push(turn);
        if (id != null) turnById.set(id, turn);
      }
      turn.output = Math.max(turn.output, u.output_tokens ?? 0);
      for (const c of blocks) if (c?.type === "tool_use") turn.tools.push({ id: c.id, name: c.name });
    } else if (j.type === "user") {
      const results = blocks
        .filter((c) => c?.type === "tool_result")
        .map((c) => ({ id: c.tool_use_id, chars: typeof c.content === "string" ? c.content.length : JSON.stringify(c.content ?? "").length }));
      if (results.length) entries.push({ kind: "result", results });
    }
  }
  const output = entries.reduce((n, e) => n + (e.output ?? 0), 0);
  return { meta, cacheWrite, output, cacheRead, maxCtx, entries };
}

// Warn at most once per process. Errors reach the browser too (see below), but
// the board gathers every ~15s and a line repeating at that rate just trains the
// eye to ignore it.
let warnedNoSpendDir = false;
// Same rule, per transcript: a file that is broken is broken every tick, and at
// the default 15s interval three of them are 720 lines an hour. Keyed on the
// FULL PATH, not the bare filename — gatherSpend re-resolves its dir on every
// tick, so a bare-filename key would silence a genuinely different broken file
// living under a second session directory. The count still reaches the browser
// every tick via `skipped`, which is the channel that matters here.
const warnedSkips = new Set();

// Scope is the SESSION directory, which is the closest thing to a run boundary
// that actually exists on disk — one Claude Code session, one folder.
//
// `sinceMs` is opt-in and defaults to no filter. An earlier attempt defaulted it
// to the ledger's mtime as a "run start" marker; that is wrong and silently
// reported zero, because the controller rewrites ledger rows continuously, so the
// mtime is always ~now and every transcript sorts as older than it. Kept as an
// explicit option for the one case the session scope cannot cover: a single
// session that spans two fleet runs, where the caller knows the boundary and the
// board does not.
//
// Three returns, deliberately distinct — collapsing them into one bare null is
// what let the path-encoding bug live: `{ error }` is a bug the operator must
// act on and the UI shows it; `null` is the normal "nothing yet" and the UI
// hides the panel; a model object is data.
export function gatherSpend({ dir, sinceMs = null, topN = 8 } = {}) {
  try {
    dir = dir ?? findSubagentsDir();
    if (dir && dir.error) {
      if (!warnedNoSpendDir) {
        warnedNoSpendDir = true;
        console.error(`${NAME}: ${dir.error}`);
      }
      return { error: dir.error };
    }
    if (!dir) return null; // resolved, but this session has spawned no agents yet

    const agents = [];
    const toolTables = [];
    let skipped = 0;
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
      const file = join(dir, f);
      // One unreadable transcript must not take the whole panel down with it.
      // The file-level equivalent of the torn-line skip below: a transcript can
      // vanish between readdir and read while an agent is being cleaned up, and
      // losing every other agent's numbers over it would be a blackout, not
      // degradation.
      try {
        // Filter on the transcript's own mtime, not on any timestamp inside it —
        // an agent that ran before this run is simply not this run's cost.
        if (sinceMs != null && statSync(file).mtimeMs < sinceMs) continue;
        const a = readAgent(file, join(dir, f.replace(/\.jsonl$/, ".meta.json")));
        // Both halves computed before either is recorded, so `skipped++` below
        // always means "this transcript contributed nothing" — which is what the
        // UI's "N transcripts skipped" claims. Pushing the agent first would let
        // a throw from the tool half bill the agent AND count it as skipped.
        // Unreachable today: nothing readAgent emits can make attributeTools
        // throw, and readAgent's own throws land here before anything is pushed.
        // Ordering, not a guard — keep it if this block is edited again.
        const tools = attributeTools(a.entries);
        agents.push({
          label: a.meta.description ?? f.replace(/^agent-|\.jsonl$/g, ""),
          role: classifyRole(a.meta),
          cacheWrite: a.cacheWrite, output: a.output, cacheRead: a.cacheRead, maxCtx: a.maxCtx,
        });
        toolTables.push(tools);
      } catch (e) {
        skipped++;
        if (!warnedSkips.has(file)) {
          warnedSkips.add(file);
          console.error(`${NAME}: skipping ${f}: ${e.message}`);
        }
      }
    }
    if (!agents.length) return skipped ? { error: `all ${skipped} transcripts unreadable` } : null;
    const spend = computeSpend({ agents, topN });
    const tools = mergeTools(toolTables);
    // What fraction of cache_creation the tool table actually explains. It is
    // never 100%: only a turn that FOLLOWS a tool result can be attributed to a
    // tool, and an agent's first turn — usually its largest single write, the
    // system prompt and context — follows nothing. Surfacing the coverage keeps
    // the two columns honest about being different bases; without it the tool
    // percentages silently read as shares of the headline number, which they
    // are not.
    const attributed = tools.reduce((n, t) => n + t.cacheWrite, 0);
    const attributedPct = spend.totals.cacheWrite > 0 ? (attributed / spend.totals.cacheWrite) * 100 : 0;
    return { ...spend, tools, attributedPct, skipped, since: sinceMs };
  } catch (e) {
    // A real bug, not an empty run — say so rather than hiding the panel, which
    // is what turned the last type surprise in here into "no panel appeared".
    console.error(`${NAME}: spend read failed: ${e.message}`);
    return { error: e.message };
  }
}

export function gather({ ledgerFile, prevFile, scriptDir = SCRIPT_DIR, interval }) {
  // The one read that must not crash the gather: a corrupt/partial board.json
  // (the fallback safety net itself) is ignored, not fatal.
  let prev = null;
  if (prevFile && existsSync(prevFile)) {
    try { prev = JSON.parse(readFileSync(prevFile, "utf8")); }
    catch (e) { console.error(`${NAME}: ignoring unreadable prev board ${prevFile}: ${e.message}`); }
  }

  const ledgerJson = tryRun("node", [join(scriptDir, "ledger.mjs"), "--file", ledgerFile, "read"]);
  const ledger = tryParse(ledgerJson, { rows: [], filed: [], ruled: [] }, "ledger read");

  const issuesJson = tryRun("gh", ["issue", "list", "--label", "ready-for-agent",
    "--state", "open", "--limit", "100", "--json", "number,title,labels"]);
  const issues = tryParse(issuesJson, [], "gh issue list").map((i) => ({
    number: i.number, title: i.title, labels: (i.labels || []).map((l) => l.name),
  }));

  const prsJson = tryRun("gh", ["pr", "list", "--state", "open", "--limit", "100",
    "--json", "number,state,labels,title"]);
  const prs = tryParse(prsJson, [], "gh pr list").map((p) => ({
    number: p.number, state: p.state, title: p.title, labels: (p.labels || []).map((l) => l.name),
  }));

  // CI per open PR. On failure, carry the previous board's value for that PR.
  const prevCi = new Map((prev?.tickets || []).filter((t) => t.pr != null).map((t) => [t.pr, t.ci]));
  const ci = {};
  for (const p of prs) {
    const out = runCiState(scriptDir, p.number);
    ci[p.number] = out === null ? (prevCi.get(p.number) ?? "unknown") : mapCi(out);
  }

  // Repo identity + web URL for PR links — the url carries the host, so links
  // resolve on GitHub Enterprise, not just github.com. From the fleet's cwd, so
  // the board stays repo-agnostic. On failure, carry the previous board's values.
  const repoJson = tryRun("gh", ["repo", "view", "--json", "nameWithOwner,url"]);
  let repo = prev?.repo ?? null;
  let repoUrl = prev?.repoUrl ?? null;
  if (repoJson) {
    try { const d = JSON.parse(repoJson); repo = d.nameWithOwner ?? repo; repoUrl = d.url ?? repoUrl; }
    catch (e) { console.error(`${NAME}: gh repo view parse failed: ${e.message}`); }
  }

  // Operator input at a trust boundary, so it fails loud. `Number(x) || null`
  // silently turned every bad value into "no filter at all": a typo, or the
  // natural mistake of passing seconds instead of milliseconds, produced a panel
  // that rendered confidently over the WHOLE session while the operator believed
  // it was scoped to one run. That is the same silent-zero failure the comment
  // on gatherSpend describes; an earlier pass removed the `|| null` default but
  // left the footgun, and the guard below is what actually closes it.
  //
  // Gate on PRESENCE, not on the value: `arg()` yields undefined for a trailing
  // `--spend-since`, and `sinceRaw == null` read that as "flag absent", so the
  // guard never fired. And on RANGE, not just finiteness: a seconds-magnitude
  // epoch (~1.7e9) is finite, so the very mistake named above sailed through,
  // counted every agent, and shipped its own bogus value into board.json's
  // `since`. 1e12 ms is 2001-09-09, below any real run; a future boundary
  // matches nothing at all.
  const sinceRaw = arg("spend-since");
  let sinceMs = null;
  if (has("spend-since")) {
    sinceMs = Number(sinceRaw);
    if (!Number.isFinite(sinceMs) || sinceMs < 1e12 || sinceMs > Date.now()) {
      die(`--spend-since wants epoch milliseconds, got ${sinceRaw}`);
    }
  }
  const spend = gatherSpend({ sinceMs });
  return { ledger, issues, prs, ci, prev, repo, repoUrl, spend, now: Date.now(), interval: interval ?? argInterval() ?? 15 };
}

async function main() {
  // #365: a misspelled flag was never looked for, so `serve --prot 9000`
  // served on the default 8123 in silence. In main(), not at module scope:
  // board.test.mjs and board-cli.test.mjs both import from this module, so a
  // module-scope sweep would read the TEST RUNNER's argv.
  //
  // One set for both subcommands, deliberately. `--port`/`--open` are read
  // only by serve() and `--prev` only by build, so `build --port 5` is
  // accepted and ignored — the pre-existing gap the block above already
  // names. Narrowing the set per subcommand would close it, but that is a
  // different ticket's fix; refusing a flag this file does accept somewhere
  // is not this ticket's business.
  //
  // Above `cmd`, so `board.mjs --prot 9000` names the stray rather than
  // printing the usage line for a missing subcommand. `build`/`serve` carry
  // no `--` and are never the sweep's business.
  sweep(["ledger", "prev", "port", "interval", "open", "spend-since"]);
  const cmd = process.argv[2];
  const ledgerFile = arg("ledger") || ".fleet/ledger.md";

  if (cmd === "build") {
    const { computeBoard } = await import("./compute-board.mjs");
    const model = computeBoard(gather({ ledgerFile, prevFile: arg("prev") }));
    console.log(JSON.stringify(model, null, 2));
    return;
  }
  if (cmd === "serve") { await serve({ ledgerFile }); return; }
  die("usage: board.mjs build|serve [--ledger <path>] [--port N] [--interval N] [--open] [--spend-since <epoch-ms>]");
}

import { copyFileSync, mkdirSync } from "node:fs";

export function createBoardServer(dir) {
  return createServer((req, res) => {
    const url = (req.url || "/").split("?")[0];
    const path = url === "/" || url === "/board.html" ? join(dir, "board.html")
      : url === "/board.json" ? join(dir, "board.json") : null;
    if (!path || !existsSync(path)) { res.writeHead(404); res.end("not found"); return; }
    const type = path.endsWith(".json") ? "application/json" : "text/html; charset=utf-8";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(readFileSync(path));
  });
}

export async function serve({ ledgerFile, port, interval, open } = {}) {
  // A --port we cannot use (absent) falls back to 8123. Keep which of the two
  // it was: naming the substituted default bare in the bind error below reads
  // as "the port you asked for is taken" and sends a caller who DID pass
  // --port hunting a process on a port they never chose (#169 review). A
  // GIVEN-but-invalid value is refused outright by argPort(), never reaches
  // here. `??` over `||` is shape, not a guarantee: #366 is scoped to the argv
  // path, where `port` is always undefined and the two operators are
  // identical, and the one place that reads portGiven as a yes/no rather than
  // for its value — the bind error below — truthiness-tests it, so a
  // caller-passed 0 would read as the default there regardless. Nothing pins
  // the difference; do not cite it as one.
  const portGiven = port ?? argPort();
  port = portGiven ?? 8123;
  interval = interval ?? argInterval() ?? 15;
  open = open ?? has("open");
  const { computeBoard } = await import("./compute-board.mjs");
  const stateDir = ".fleet";
  const jsonPath = join(stateDir, "board.json");
  // stateDir may not exist yet (e.g. no ledger.md written, fresh repo) — the
  // "read"-only ledger path never creates it, so serve() must.
  mkdirSync(stateDir, { recursive: true });
  // Serve board.html straight from the script dir alongside the state file.
  try { copyFileSync(join(SCRIPT_DIR, "board.html"), join(stateDir, "board.html")); }
  catch (e) { die(`cannot stage board.html into ${stateDir}: ${e.message}`); }

  const tick = () => {
    try {
      const model = computeBoard(gather({ ledgerFile, prevFile: jsonPath, interval }));
      const tmp = `${jsonPath}.tmp`;
      writeFileSync(tmp, JSON.stringify(model));   // atomic: write tmp, rename over target
      renameSync(tmp, jsonPath);
    } catch (e) { console.error(`${NAME}: build tick failed: ${e.message}`); }
  };
  tick();
  const timer = setInterval(tick, interval * 1000);

  const server = createBoardServer(stateDir);
  server.listen(port, () => {
    // Announce the port we GOT, not the one we asked for. They differ for the
    // one value #366 newly permits: listen(0) binds an ephemeral port, so
    // echoing the request prints — and --opens — http://localhost:0, which
    // reaches nothing while the board sits on a port nobody was told (#435
    // review). address() is only populated once listening, hence in here.
    const bound = server.address().port;
    console.error(`${NAME}: cockpit on http://localhost:${bound}  (interval ${interval}s)`);
    if (open) tryRun("open", [`http://localhost:${bound}/`]);
  });
  server.on("error", (e) => die(e.code === "EADDRINUSE"
    ? `port ${port}${portGiven ? "" : " (default)"} in use — pass --port <n>` : e.message));

  const stop = () => {
    clearInterval(timer);
    server.close(() => process.exit(0));
    server.closeAllConnections?.();                  // drop keep-alive sockets so close() resolves promptly
    setTimeout(() => process.exit(0), 1000).unref();  // hard backstop if a socket somehow lingers
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {}); // run until signalled
}

// Only run main() as a CLI, never when imported by a test. realpathSync resolves
// both sides (relative argv, symlinks) so the equality is reliable regardless of
// how node was invoked.
const isCLI = process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isCLI) main().catch((e) => die(e.message));
