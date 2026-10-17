// The brief a member is dispatched with, rendered the way the controller
// renders it — `dispatch-prompt.mjs render <role> [--kind <kind>] …` — for a
// fixed argument set per role and kind, so a suite can pin what a member
// RECEIVES rather than the file the controller read it from. Not
// `rendered-brief.mjs`, which writes a stand-in brief for the ledger's dispatch
// gate; this one runs the renderer over the shipped templates.
//
// The script resolves its templates and its instrument check relative to
// itself, so it runs as a COPY out of a fixture install: a `scripts/`
// directory holding the script, every module it imports and a stub
// `instruments.sh` that answers with whatever exit the case sets, beside a
// `skills/run-team/briefs/` directory copied from the repository. The cwd is a
// real `git init`-ed repository, since the renderer derives the main checkout
// and the fleet directory from git.
//
// `memberPrompt(role, kind)` is what a member's context holds: its agent body,
// which the harness injects as the system prompt, then its rendered brief,
// which is the `task` call's prompt. A pin against it is a pin on what the
// member reads, whichever of the two files carries the text.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PLUGIN = fileURLToPath(new URL("../../plugin/", import.meta.url));

/** Where the tests' golden fixtures live: a rendered brief per role and kind, and an agent body per agent. */
export const GOLDEN_DIR = fileURLToPath(new URL("../fixtures/briefs/", import.meta.url));

const MODULES = ["dispatch-prompt.mjs", "arg.mjs", "git-env.mjs", "fleet-dir.mjs", "review-core.mjs"];

const INSTRUMENTS_STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$CALL_LOG"
[ -n "\${INSTR_KILL:-}" ] && kill -9 $$
echo "\${INSTR_SAYS:-stub}" >&2
exit "\${INSTR_EXIT:-0}"
`;

export const PIN = "0123456789abcdef0123456789abcdef01234567";

// Every argument each (role, kind) takes, with a value no other argument
// shares so a swapped substitution cannot pass. Spelled out here, never read
// off the templates: a template that gains or loses a required argument
// disagrees with it, and the renderer's own refusal says so.
export const CASES = [
  { role: "implementer", kind: null, args: { ticket: "4120", worktree: "/abs/wt-impl", branch: "impl-branch", scratch: "/abs/scratch-impl", brief: "BRIEF-TEXT-1", staleness: "STALE-NOTE-1" } },
  { role: "fix-applier", kind: "review", args: { worktree: "/abs/wt-fix", branch: "fix-branch", testCmd: "TESTCMD-1", scratch: "/abs/scratch-fix", pr: "3293", run: "run-AbCd1234" } },
  { role: "fix-applier", kind: "conflict", args: { worktree: "/abs/wt-conflict", branch: "conflict-branch", testCmd: "TESTCMD-2", scratch: "/abs/scratch-conflict" } },
  { role: "fix-applier", kind: "dispositions-retry", args: { worktree: "/abs/wt-retry", branch: "retry-branch", testCmd: "TESTCMD-3", scratch: "/abs/scratch-retry", pr: "3294", run: "run-ZyXw9876", "mismatched-record": "/abs/scratch-retry/dispositions-fix-pr-3294.json", violations: "VIOLATION-LIST-1" } },
  { role: "fix-applier", kind: "red-check", args: { worktree: "/abs/wt-red", branch: "red-branch", testCmd: "TESTCMD-7", scratch: "/abs/scratch-red" } },
  { role: "finisher", kind: "fresh", args: { worktree: "/abs/wt-fin", pin: PIN, pr: "3295", testCmd: "TESTCMD-4", scratch: "/abs/scratch-fin" } },
  { role: "finisher", kind: "repair", args: { worktree: "/abs/wt-fin-r", pin: PIN, pr: "3296", testCmd: "TESTCMD-5", scratch: "/abs/scratch-fin-r" } },
  { role: "merge-bot", kind: null, args: { n: "17", scratch: "/abs/scratch-bot" } },
  { role: "review-runner", kind: null, args: { pr: "3297", branch: "rr-branch", worktree: "/abs/wt-rr", testCmd: "TESTCMD-6", scratch: "/abs/scratch-root" } },
  { role: "recipe-deriver", kind: null, args: { repo: "/abs/repo-x", scratch: "/abs/scratch-rd" } },
  { role: "relabel", kind: "needs-triage", args: { line: "LINE-1" } },
  { role: "relabel", kind: "fork", args: { options: "OPTIONS-1" } },
  { role: "relabel", kind: "hands", args: { hands: "HANDS-1", line: "LINE-2" } },
  { role: "relabel", kind: "covered", args: { detail: "DETAIL-1" } },
  { role: "relabel", kind: "fixed", args: { detail: "DETAIL-2" } },
];

/** The agent definition each member role runs as; a relabel comment is no member's brief and has none. */
const AGENT_OF = {
  implementer: "fleet-implementer-slow-high",
  "fix-applier": "fleet-fix-applier",
  finisher: "fleet-finisher",
  "merge-bot": "fleet-merge-bot",
  "review-runner": "fleet-review-runner",
  "recipe-deriver": "fleet-recipe-deriver",
};

export const label = ({ role, kind }) => (kind ? `${role} ${kind}` : role);
export const flagsOf = (args) => Object.entries(args).flatMap(([k, v]) => [`--${k}`, v]);
export const argvOf = ({ role, kind, args }) => ["render", role, ...(kind ? ["--kind", kind] : []), ...flagsOf(args)];

/** The fixture file name of a role's rendered brief for a kind. */
export const briefFixtureName = ({ role, kind }) => [role, kind].filter(Boolean).join("-") + ".md";

/** Every agent definition under plugin/agents/, by name without the `.agent.md`. */
export const agentNames = () =>
  readdirSync(join(PLUGIN, "agents"))
    .filter((f) => f.endsWith(".agent.md"))
    .map((f) => f.slice(0, -".agent.md".length))
    .sort();

/** The fixture file name of an agent's body; the implementer cells carry one byte-identical body, so they share one fixture. */
export const bodyFixtureName = (agent) =>
  `${agent.replace(/^(fleet-implementer)-(slow|task|smol)-(low|medium|high|xhigh|max)$/, "$1")}.md`;

export function cleanEnv() {
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  delete env.FORCE_COLOR;
  return env;
}

/**
 * A fixture install under `root`: the renderer, the modules it imports and a
 * stub instrument check in `scripts/`, the shipped templates in
 * `skills/run-team/briefs/`. `edit(briefsDir)` runs before it is returned, so a
 * mutation control renders a modified copy and the repository is never touched.
 */
export function installRenderer(root, { edit } = {}) {
  const scripts = join(root, "scripts");
  mkdirSync(scripts, { recursive: true });
  for (const m of MODULES) writeFileSync(join(scripts, m), readFileSync(join(PLUGIN, "scripts", m)));
  writeFileSync(join(scripts, "instruments.sh"), INSTRUMENTS_STUB);
  const briefs = join(root, "skills", "run-team", "briefs");
  mkdirSync(dirname(briefs), { recursive: true });
  cpSync(join(PLUGIN, "skills", "run-team", "briefs"), briefs, { recursive: true });
  if (edit) edit(briefs);
  return { root, script: join(scripts, "dispatch-prompt.mjs"), briefs };
}

let work = null;
let counter = 0;
const scratch = (name) => {
  if (work === null) {
    work = realpathSync(mkdtempSync(join(tmpdir(), "render-brief-")));
    process.on("exit", () => rmSync(work, { recursive: true, force: true }));
  }
  const dir = join(work, `${name}-${counter++}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

let repo = null;
const repoCwd = () => {
  if (repo === null) {
    repo = scratch("repo");
    const r = spawnSync("git", ["init", "-q"], { cwd: repo, encoding: "utf8", env: cleanEnv() });
    if (r.status !== 0) throw new Error(`fixture: git init failed: ${r.stderr}`);
  }
  return repo;
};

let main = null;
const cache = new Map();

/**
 * The brief `dispatch-prompt.mjs render <role> [--kind <kind>]` prints for the
 * fixed argument set of that role and kind in CASES — from the shipped
 * templates, or from the copy `edit` modified. Throws, carrying the renderer's
 * stderr, when the renderer refuses.
 */
export function renderBrief(role, kind = null, { edit } = {}) {
  const c = CASES.find((x) => x.role === role && x.kind === kind);
  if (!c) throw new Error(`render-brief: no fixed argument set for ${label({ role, kind })}`);
  if (!edit && cache.has(label(c))) return cache.get(label(c));
  let inst;
  if (edit) inst = installRenderer(scratch("install-edit"), { edit });
  else inst = main ??= installRenderer(scratch("install-main"));
  const log = join(scratch("log"), "calls.log");
  writeFileSync(log, "");
  const r = spawnSync(process.execPath, [inst.script, ...argvOf(c)], {
    cwd: repoCwd(),
    encoding: "utf8",
    env: { ...cleanEnv(), CALL_LOG: log },
  });
  if (r.status !== 0) throw new Error(`render-brief: ${label(c)} was refused (exit ${r.status}): ${r.stderr}`);
  if (!edit) cache.set(label(c), r.stdout);
  return r.stdout;
}

/** An agent definition's body — everything after the frontmatter's closing `---`. */
export function agentBody(agent) {
  const text = readFileSync(join(PLUGIN, "agents", `${agent}.agent.md`), "utf8");
  return text.slice(text.indexOf("\n---\n", 4) + "\n---\n".length);
}

/** What the member's context holds: its agent body, then the rendered brief. */
export function memberPrompt(role, kind = null) {
  return `${agentBody(AGENT_OF[role])}\n${renderBrief(role, kind)}`;
}
