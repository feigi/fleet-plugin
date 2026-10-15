// A member's report is a file at `<scratch>/reports/<member>.json`, in the
// shape report-schema.mjs gives its family, and its final message is one line
// pointing at it — the file `ledger.mjs settle <member> --from-report` reads.
// Both halves of every member's instructions name that path and that line:
// the brief rendered for each dispatch, every kind of it, and the agent body
// the member carries.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));
const RENDER = join(PLUGIN, "scripts", "dispatch-prompt.mjs");
const PIN = "0123456789abcdef0123456789abcdef01234567";

const flagsOf = (args) => Object.entries(args).flatMap(([k, v]) => [`--${k}`, v]);
const render = (role, kind, args) => {
  const r = spawnSync(process.execPath, [RENDER, "render", role, ...(kind ? ["--kind", kind] : []), ...flagsOf(args)], { encoding: "utf8" });
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
      worktree: "/abs/wt", branch: "b", testCmd: "T", scratch: "/abs/scratch",
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
