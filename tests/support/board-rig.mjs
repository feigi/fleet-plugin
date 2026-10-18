// The rig the board test files share: a one-assistant-turn omp transcript and
// the fixture directory that holds it, a phase-0 receipt recording a session,
// stderr capture for the in-process callers that report through console.error,
// the offline `serve` spawn arguments, and a deadline for an awaited process.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { RECEIPT } from "../../plugin/scripts/ledger-grammar.mjs";
import { tempDir } from "./temp-dir.mjs";

const SCRIPT = fileURLToPath(new URL("../../plugin/scripts/board.mjs", import.meta.url));

// One assistant turn, the omp envelope's own shape (member-record.mjs's
// foldOmpTranscript comment): one usage object per turn, no fold-back needed.
export const TURN = [
  { type: "session", version: 3, id: "s1", timestamp: "2026-09-08T15:11:49.444Z", cwd: "/w" },
  { type: "message", id: "m1", parentId: "s1", timestamp: "2026-09-08T15:12:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: "ok" }], model: "claude-opus-5",
      usage: { input: 2, output: 1, cacheRead: 50, cacheWrite: 1000, totalTokens: 0, cost: { total: 0.01 } } } },
];

export function fixture(lines) {
  const dir = tempDir("spend-");
  writeFileSync(join(dir, "agent-x.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return dir;
}

// The phase-0 receipt the cockpit reads its spend session from, in the state
// directory `stateDir` (a `.fleet` directory), recording `session`.
export function writeReceipt(stateDir, session) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, RECEIPT), JSON.stringify({ run: null, session, scratch: "/scratch", inFlight: 5, steps: {} }));
}

// gatherSpend reports through stderr, so read console.error rather than spawning
// the CLI — the CLI reads its session from a phase-0 receipt, and these
// fixtures write none.
export function withStderr(fn) {
  const lines = [];
  const real = console.error;
  console.error = (...a) => lines.push(a.join(" "));
  try { fn(); } finally { console.error = real; }
  return lines;
}

// The offline rig every serve spawn below shares. PATH is stripped to an
// empty dir so every gh/git/node child fails fast into tryRun's catch: the
// tick degrades, `git rev-parse --git-common-dir` answers nothing, and the
// instance degrades with it to a cwd-relative `.fleet` on PORT_BASE — which
// is what makes 8123 the deterministic derived port for these spawns, and a
// fresh mkdtemp cwd what keeps them from sharing a state directory.
export const serveArgs = (args) => [SCRIPT, "serve", ...args];
export const serveOpts = () => ({
  cwd: tempDir("board-serve-"),
  env: { ...process.env, PATH: tempDir("board-nobin-") },
  encoding: "utf8",
  timeout: 20000,
});

export const withTimeout = (pr, ms, what) => Promise.race([
  pr,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out waiting for ${what}`)), ms).unref()),
]);
