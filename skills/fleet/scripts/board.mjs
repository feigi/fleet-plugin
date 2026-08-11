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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";

const NAME = "board";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const die = (m) => { console.error(`${NAME}: ${m}`); process.exit(2); };
// A flag given with no value must never read as the flag being absent.
// `ledger`/`prev`/`spend-since`/`port`/`interval` are all read with `||`/`??`
// fallbacks, so a trailing flag previously substituted a default in total
// silence — `--spend-since` with nothing after it silently widened the spend
// panel to all-time instead of the requested window, and `--ledger` with
// nothing after it silently read the DEFAULT ledger file instead of the one
// asked for. Same fail-open class as #61 (#169). `--flag=value` is caught
// too: `indexOf` cannot see it.
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i === -1) {
    if (process.argv.some((a) => a.startsWith(`--${n}=`))) die(`--${n} needs a space-separated value, not --${n}=`);
    return null;
  }
  const value = process.argv[i + 1];
  if (value === undefined || value.trim() === "" || value.startsWith("--")) die(`--${n} needs a value`);
  return value;
};
const has = (n) => process.argv.includes(`--${n}`);

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
// exit 1 it has ALREADY printed its verdict JSON to stdout before exiting. So a
// thrown non-zero exit whose stdout is non-empty is a real verdict (feed it to
// mapCi); only an empty stdout (the exit-2 die() path) is a genuine read failure.
// Discarding e.stdout — as a plain tryRun would — makes red/still-running CI
// unreachable: every non-green PR reads as "unknown" and the red-ci flag, the
// top of the attention strip, never fires.
function runCiState(scriptDir, pr) {
  try {
    return execFileSync("node", [join(scriptDir, "ci-state.mjs"), "--pr", String(pr), "--quiet"], { encoding: "utf8" });
  } catch (e) {
    const out = e.stdout ? e.stdout.toString() : "";
    if (out.trim()) return out;
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
function readAgent(file, metaFile) {
  let meta = {};
  try { if (existsSync(metaFile)) meta = JSON.parse(readFileSync(metaFile, "utf8")); } catch { /* unnamed agent */ }

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
        agents.push({
          label: a.meta.description ?? f.replace(/^agent-|\.jsonl$/g, ""),
          role: classifyRole(a.meta),
          cacheWrite: a.cacheWrite, output: a.output, cacheRead: a.cacheRead, maxCtx: a.maxCtx,
        });
        toolTables.push(attributeTools(a.entries));
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
  return { ledger, issues, prs, ci, prev, repo, repoUrl, spend, now: Date.now(), interval: interval ?? (Number(arg("interval")) || 15) };
}

async function main() {
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
  // A --port we cannot use (absent, or not a number) falls back to 8123. Keep
  // which of the two it was: naming the substituted default bare in the bind
  // error below reads as "the port you asked for is taken" and sends a caller
  // who DID pass --port hunting a process on a port they never chose (#169
  // review). Rejecting the bad value outright is #366, not this.
  const portGiven = Number(port ?? arg("port")) || null;
  port = portGiven ?? 8123;
  interval = Number(interval ?? arg("interval")) || 15;
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
    console.error(`${NAME}: cockpit on http://localhost:${port}  (interval ${interval}s)`);
    if (open) tryRun("open", [`http://localhost:${port}/`]);
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
