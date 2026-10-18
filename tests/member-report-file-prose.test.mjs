// A member's report is a file at `<scratch>/reports/<member>.json`, in the
// shape report-schema.mjs gives its family, and its final message is one line
// pointing at it — the file `ledger.mjs settle <member> --from-report` reads.
// Both halves of every member's instructions name that path and that line:
// the brief rendered for each dispatch, every kind of it, and the agent body
// the member carries.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));
const PIN = "0123456789abcdef0123456789abcdef01234567";

// The renderer resolves its templates and its instrument check relative to
// itself, and derives the fleet directory from the git repository it runs in.
// So it runs as a copy out of a fixture install — its modules, a stub
// instruments.sh that answers clean, the briefs — from a `git init`-ed cwd of
// its own, never the checkout this suite runs from, which holds no pinned
// baseline when it is a fresh clone.
const TMP = realpathSync(mkdtempSync(join(tmpdir(), "member-report-file-")));
after(() => rmSync(TMP, { recursive: true, force: true }));
const MODULES = ["dispatch-prompt.mjs", "arg.mjs", "git-env.mjs", "fleet-dir.mjs", "review-core.mjs"];
const scripts = join(TMP, "install", "scripts");
mkdirSync(scripts, { recursive: true });
for (const m of MODULES) writeFileSync(join(scripts, m), readFileSync(join(PLUGIN, "scripts", m)));
writeFileSync(join(scripts, "instruments.sh"), "#!/bin/sh\nexit 0\n");
cpSync(join(PLUGIN, "skills", "run-team", "briefs"), join(TMP, "install", "skills", "run-team", "briefs"), { recursive: true });
const REPO = join(TMP, "repo");
mkdirSync(REPO);
const env = { ...process.env };
for (const k of ["GIT_DIR", "GIT_WORK_TREE", "FORCE_COLOR"]) delete env[k];
const init = spawnSync("git", ["init", "-q"], { cwd: REPO, encoding: "utf8", env });
assert.equal(init.status, 0, init.stderr);
const RENDER = join(scripts, "dispatch-prompt.mjs");

const flagsOf = (args) => Object.entries(args).flatMap(([k, v]) => [`--${k}`, v]);
const render = (role, kind, args) => {
  const r = spawnSync(process.execPath, [RENDER, "render", role, ...(kind ? ["--kind", kind] : []), ...flagsOf(args)], { cwd: REPO, encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.replace(/\s+/g, " ");
};

// Each dispatch, the schema family its report takes, and the name its file
// and message carry — the member's own name where the brief knows it, the
// `<your name>` it fills in where a retry suffix may follow.
const BRIEFS = [
  { role: "implementer", kind: null, family: "impl", name: "<your name>", outcome: "<outcome>",
    args: { ticket: "4120", worktree: "/abs/wt", branch: "b", scratch: "/abs/scratch", brief: "B", staleness: "S" } },
  ...["review", "dispositions-retry", "conflict", "red-check"].map((kind) => ({
    role: "fix-applier", kind, family: "fix-pr", name: "<your name>", outcome: "<outcome>",
    args: {
      worktree: "/abs/wt", branch: "b", testCmd: "T", checkCmd: "C", scratch: "/abs/scratch",
      ...(kind === "review" || kind === "dispositions-retry" ? { pr: "3293", run: "run-AbCd1234" } : {}),
      ...(kind === "dispositions-retry" ? { "mismatched-record": "/abs/scratch/dispositions-fix-pr-3293.json", violations: "V" } : {}),
    },
  })),
  ...["fresh", "repair"].map((kind) => ({
    role: "finisher", kind, family: "finisher", name: "<your name>", outcome: "<outcome>",
    args: { worktree: "/abs/wt", pin: PIN, pr: "3295", testCmd: "T", scratch: "/abs/scratch" },
  })),
  { role: "merge-bot", kind: null, family: "merge-bot", name: "merge-bot-17", outcome: "done", args: { n: "17", scratch: "/abs/scratch" } },
];

for (const { role, kind, family, name, outcome, args } of BRIEFS) {
  test(`the ${role}${kind ? ` ${kind}` : ""} brief names the report file, its schema and the one-line message`, () => {
    const brief = render(role, kind, args);
    const path = `/abs/scratch/reports/${name}.json`;
    assert.ok(brief.includes(`Your report is a file, \`${path}\``), `the brief no longer names the report file ${path}`);
    assert.ok(brief.includes(`report-schema.mjs print ${family}\``), `the brief no longer names the ${family} schema`);
    assert.ok(brief.includes(`report-schema.mjs validate ${family} ${path}\` answers \`valid\``), "the brief no longer has the member check the file before sending");
    assert.ok(brief.includes(`Your final message is then one line, \`${name}: ${outcome} ${path}\``), "the brief no longer gives the one-line message form");
  });
}

const AGENTS = join(PLUGIN, "agents");
const bodyOf = (file) => {
  const text = readFileSync(join(AGENTS, file), "utf8");
  return text.slice(text.indexOf("\n---\n", 4) + "\n---\n".length).replace(/\s+/g, " ");
};
const IMPLEMENTERS = readdirSync(AGENTS).filter((f) => /^fleet-implementer-.*\.agent\.md$/.test(f));

test("the implementer cells are found, so the body check below has bodies to read", () => {
  assert.ok(IMPLEMENTERS.length > 0);
});

const BODIES = [
  ...IMPLEMENTERS.map((file) => ({ file, path: "`<scratch>/reports/<your name>.json`", line: "`<your name>: <outcome> <path>`" })),
  { file: "fleet-fix-applier.agent.md", path: "`<scratch>/reports/<your name>.json`", line: "`<your name>: <outcome> <path>`" },
  { file: "fleet-finisher.agent.md", path: "`<scratch>/reports/<your name>.json`", line: "`<your name>: <outcome> <path>`" },
  { file: "fleet-merge-bot.agent.md", path: "`<scratch>/reports/merge-bot-<n>.json`", line: "`merge-bot-<n>: done <path>`" },
];

for (const { file, path, line } of BODIES) {
  test(`${file} names the report file and the one-line message`, () => {
    const body = bodyOf(file);
    assert.ok(body.includes(path), `the body no longer names ${path}`);
    assert.ok(body.includes(`the one line your brief gives, ${line}`), `the body no longer gives the one-line message ${line}`);
  });
}
