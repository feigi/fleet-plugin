// The controller's read of the Recipe cache, shared by phase0.mjs's `recipe`
// step and the settle wakes of fleet-event.mjs, so the two never read it
// differently.
//
//   readRecipe(cwd, { timeoutMs }) -> { state, output }
//
// `derive-testcmd.sh . install --at origin/main`, `. check --at origin/main`
// and `. test --at origin/main`, each run from `cwd`, the main checkout — the
// one place the cache is read from — and judged against origin/main's tree,
// the one members' worktrees are cut from, which the main checkout may lag.
// All three always run, so every refused read is named. `timeoutMs`, when
// given, bounds each read; one that outlives it is killed and reads `broken`.
// `state` is:
//
//   valid    all three exited 0; `output` is `Recipe cache valid:` and each
//            read's last line.
//   refused  one or more exited 1, a cache with nothing valid in it, or a
//            command it names that does not resolve; `output` is one
//            `derive-testcmd.sh . <args> refused:` line per read followed by
//            the reader's own words. A refusal naming `--at` is no cache fault:
//            the caller fetches and reads again.
//   broken   one or more exited 3 or failed any other way — a tool the reader
//            could not run, a reader that was killed; the cache's state is
//            unknown, and deriving would not help. `output` names each such
//            read, its exit and the reader's own words. It outranks `refused`.
//
// Zero deps: node builtins and sibling scripts only.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv } from "./git-env.mjs";

const DERIVE = join(dirname(fileURLToPath(import.meta.url)), "derive-testcmd.sh");
const MAX_BUFFER = 64 * 1024 * 1024;

/** The reads, as arguments after the repository `.`. */
const RECIPE_READS = ["install", "check", "test"].map((field) => [field, "--at", "origin/main"]);

const trimmed = (s) => String(s ?? "").trim();
const lines = (s) => trimmed(s).split("\n").filter((l) => l.trim() !== "");

function how(r) {
  if (r.error) return r.error.code ?? r.error.message;
  if (r.signal) return `killed by ${r.signal}`;
  return `exit ${r.status}`;
}

// `head`, then the reader's stdout and stderr when it said anything.
function withText(head, stdout, stderr) {
  const text = [trimmed(stdout), trimmed(stderr)].filter(Boolean).join("\n");
  return text ? `${head}\n${text}` : head;
}

export function readRecipe(cwd, { timeoutMs } = {}) {
  const reads = RECIPE_READS.map((a) => {
    const r = spawnSync("sh", [DERIVE, ".", ...a], { cwd, encoding: "utf8", maxBuffer: MAX_BUFFER, env: gitEnv(), timeout: timeoutMs });
    return { a, r, status: r.error ? null : r.status };
  });
  const broken = reads.filter(({ status }) => status !== 0 && status !== 1);
  if (broken.length > 0) {
    return {
      state: "broken",
      output: broken.map(({ a, r }) => withText(`derive-testcmd.sh . ${a.join(" ")} ${how(r)} — the cache's state is unknown, and deriving would not help`, r.stdout, r.stderr)).join("\n"),
    };
  }
  const refused = reads.filter(({ status }) => status === 1);
  if (refused.length > 0) {
    return { state: "refused", output: refused.map(({ a, r }) => withText(`derive-testcmd.sh . ${a.join(" ")} refused:`, r.stdout, r.stderr)).join("\n") };
  }
  return { state: "valid", output: `Recipe cache valid: ${reads.map(({ r }) => lines(r.stdout).at(-1) ?? "").join(" ; ")}` };
}
