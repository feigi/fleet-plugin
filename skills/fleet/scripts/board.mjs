#!/usr/bin/env node
// The cockpit's I/O layer. `build` gathers ledger + gh + CI state, calls the
// pure computeBoard(), and prints board.json. `serve` (below) loops build,
// atomic-writes .fleet/board.json, and serves board.html. The board is a pure
// function of ledger + GitHub — it never depends on the controller feeding it.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer } from "node:http";

const NAME = "board";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const die = (m) => { console.error(`${NAME}: ${m}`); process.exit(2); };
const arg = (n) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? null : process.argv[i + 1]; };
const has = (n) => process.argv.includes(`--${n}`);

// Every external read is wrapped: a failure returns null and the caller keeps a
// last-known value. Partial board beats a crashed loop or a false alarm.
function tryRun(cmd, args) {
  try { return execFileSync(cmd, args, { encoding: "utf8" }); }
  catch (e) { console.error(`${NAME}: ${cmd} ${args.join(" ")} failed: ${e.message}`); return null; }
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

export function gather({ ledgerFile, prevFile, scriptDir = SCRIPT_DIR }) {
  // The one read that must not crash the gather: a corrupt/partial board.json
  // (the fallback safety net itself) is ignored, not fatal.
  let prev = null;
  if (prevFile && existsSync(prevFile)) {
    try { prev = JSON.parse(readFileSync(prevFile, "utf8")); }
    catch (e) { console.error(`${NAME}: ignoring unreadable prev board ${prevFile}: ${e.message}`); }
  }

  const ledgerJson = tryRun("node", [join(scriptDir, "ledger.mjs"), "--file", ledgerFile, "read"]);
  const ledger = ledgerJson ? JSON.parse(ledgerJson) : { rows: [], filed: [], ruled: [] };

  const issuesJson = tryRun("gh", ["issue", "list", "--label", "ready-for-agent",
    "--state", "open", "--limit", "100", "--json", "number,title,labels"]);
  const issues = (issuesJson ? JSON.parse(issuesJson) : []).map((i) => ({
    number: i.number, title: i.title, labels: (i.labels || []).map((l) => l.name),
  }));

  const prsJson = tryRun("gh", ["pr", "list", "--state", "open", "--limit", "100",
    "--json", "number,state,labels,title"]);
  const prs = (prsJson ? JSON.parse(prsJson) : []).map((p) => ({
    number: p.number, state: p.state, title: p.title, labels: (p.labels || []).map((l) => l.name),
  }));

  // CI per open PR. On failure, carry the previous board's value for that PR.
  const prevCi = new Map((prev?.tickets || []).filter((t) => t.pr != null).map((t) => [t.pr, t.ci]));
  const ci = {};
  for (const p of prs) {
    const out = runCiState(scriptDir, p.number);
    ci[p.number] = out === null ? (prevCi.get(p.number) ?? "unknown") : mapCi(out);
  }

  // Repo slug for PR links in the page — from the fleet's cwd, so the board is
  // repo-agnostic. On failure, carry the previous board's value.
  const repoJson = tryRun("gh", ["repo", "view", "--json", "nameWithOwner"]);
  const repo = repoJson ? (JSON.parse(repoJson).nameWithOwner ?? null) : (prev?.repo ?? null);

  return { ledger, issues, prs, ci, prev, repo, now: Date.now(), interval: Number(arg("interval")) || 15 };
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
  die("usage: board.mjs build|serve [--ledger <path>] [--port N] [--interval N] [--open]");
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
  port = Number(port ?? arg("port")) || 8123;
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
    ? `port ${port} in use — pass --port <n>` : e.message));

  const stop = () => { clearInterval(timer); server.close(() => process.exit(0)); };
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
