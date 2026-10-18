// `pull.mjs`: a Pull as one resumable command that runs the mechanical steps in
// order and stops at each judgement with a question.
//
// Every case runs the real script against a throwaway repository (a real clone
// of a real bare origin) with a copy of the plugin's scripts directory in which
// `inflight.sh`, `staleness.mjs`, `claim-ticket.sh`, `release-ticket.sh`,
// `ticket-router.mjs` and `dispatch-prompt.mjs` are stubs that log their call
// and answer from a control file the case writes. `ledger.mjs` stays real, so a
// row, an exclusion and a dispatch are the ledger's own; `gh` is a stub on PATH.
// No network, no omp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { renderBrief } from "./support/render-brief.mjs";
import { briefPaths, issueMetrics, outOfScope } from "../plugin/scripts/ticket-router.mjs";
import { chainHead, defang, diffHunks, headings, implRow, parseAnswer, pathHits, relabel, sectionsOf } from "../plugin/scripts/pull.mjs";

const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));
const SKILL = readFileSync(join(PLUGIN, "skills", "run-team", "SKILL.md"), "utf8");
// Phase 1's step paragraphs, moved into the reference file phase 1 points at.
const PULL_MD = readFileSync(join(PLUGIN, "skills", "run-team", "references", "pull.md"), "utf8");

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t",
};
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;
delete GIT_ENV.GH_REPO;
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// What every stub is: log the call, then answer from `<name>.json` in the
// case's control directory — `{exit, out, err}`. `dispatch-prompt.mjs render`
// also writes what the real one writes beside the ledger, the brief and its
// sidecar, so the real `ledger.mjs dispatch` can read them.
const DRIVER = `import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const dir = process.env.PULL_STUBS;
const control = (name) => {
  try {
    return JSON.parse(readFileSync(join(dir, name + ".json"), "utf8"));
  } catch {
    return {};
  }
};

export function drive(name, args) {
  appendFileSync(join(dir, "order.log"), name + "\\n");
  appendFileSync(join(dir, name + ".calls"), JSON.stringify({ args, cwd: process.cwd(), GH_REPO: process.env.GH_REPO ?? null }) + "\\n");
  const c = control(name);
  if (c.sleep) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, c.sleep);
  if (name === "dispatch-prompt" && !c.exit) {
    const member = args[args.indexOf("--member") + 1];
    const briefs = join(process.cwd(), ".fleet", "briefs");
    mkdirSync(briefs, { recursive: true });
    const text = args.join("\\n") + "\\n";
    writeFileSync(join(briefs, member + ".md"), text);
    writeFileSync(join(briefs, member + ".json"), JSON.stringify({ role: "implementer", sha256: createHash("sha256").update(text).digest("hex") }));
  }
  process.stdout.write(c.out ?? "");
  process.stderr.write(c.err ?? "");
  process.exit(c.exit ?? 0);
}

if (process.argv[1].endsWith("stub-driver.mjs")) drive(process.argv[2], process.argv.slice(3));
`;

const GH_STUB = `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = process.env.PULL_STUBS;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "order.log"), "gh\\n");
fs.appendFileSync(path.join(dir, "gh.calls"), JSON.stringify({ args, GH_REPO: process.env.GH_REPO ?? null, cwd: process.cwd() }) + "\\n");
let rules = [];
try { rules = JSON.parse(fs.readFileSync(path.join(dir, "gh.json"), "utf8")); } catch {}
const line = args.join(" ");
for (const r of rules) {
  if (new RegExp(r.match).test(line)) {
    process.stdout.write(r.out ?? "");
    process.stderr.write(r.err ?? "");
    process.exit(r.exit ?? 0);
  }
}
process.exit(0);
`;

const TREE = tempDir("pull-tree-");
cpSync(PLUGIN, join(TREE, "plugin"), { recursive: true });
const SCRIPTS = join(TREE, "plugin", "scripts");
writeFileSync(join(SCRIPTS, "stub-driver.mjs"), DRIVER);
for (const n of ["staleness", "dispatch-prompt"]) {
  writeFileSync(join(SCRIPTS, `${n}.mjs`), `import { drive } from "./stub-driver.mjs";\ndrive(${JSON.stringify(n)}, process.argv.slice(2));\n`);
}
// `ticket-router.mjs` is imported by `pull.mjs` for its extractor, so the real
// module stays importable behind the stub and only its command line is replaced.
cpSync(join(SCRIPTS, "ticket-router.mjs"), join(SCRIPTS, "ticket-router-real.mjs"));
writeFileSync(join(SCRIPTS, "ticket-router.mjs"), `export * from "./ticket-router-real.mjs";
import { drive } from "./stub-driver.mjs";
import { isCLI } from "./is-cli.mjs";
if (isCLI(import.meta.url)) drive("ticket-router", process.argv.slice(2));
`);
for (const n of ["inflight", "claim-ticket", "release-ticket"]) {
  writeFileSync(join(SCRIPTS, `${n}.sh`), `#!/bin/sh\nexec node "$(dirname "$0")/stub-driver.mjs" ${n} "$@"\n`);
}
const SCRIPT = join(SCRIPTS, "pull.mjs");

const ISSUE = {
  title: "pull.mjs: the Pull's mechanical steps",
  body: "## What to build\n\nChange `plugin/scripts/pull.mjs` and `tests/pull.test.mjs`.\n\n## Out of scope\n\n- The scan.\n\n## Blocked by\n\n- #1\n",
  comments: [],
  labels: [{ name: "ready-for-agent" }, { name: "enhancement" }],
  createdAt: "2026-10-01T00:00:00Z",
};
const ROUTE_OK = "POLICY=slow-high CELL=slow-high DRAW=- STRATUM=light REASON=ok";
const NOW = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;

// A main checkout cloned from a bare origin, a home directory of its own (the
// scratch root lands under it), a phase-0 receipt naming a session, a shortlist
// and the control files.
function fixture({ issue = ISSUE, shortlist = [12] } = {}) {
  const dir = realpathSync(tempDir("pull-"));
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  const stubs = join(dir, "stubs");
  const bin = join(dir, "bin");
  for (const d of [home, stubs, bin]) mkdirSync(d);
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, repo);
  writeFileSync(join(repo, "README"), "x\n");
  git(repo, "add", "README");
  git(repo, "commit", "-q", "-m", "root");
  git(repo, "push", "-q", "-u", "origin", "main");
  writeExecStub(join(bin, "gh"), GH_STUB);
  const fleet = join(repo, ".fleet");
  mkdirSync(fleet);
  const session = "2026-10-15T09-00-00-000Z_fixture";
  writeFileSync(join(fleet, "phase0.json"), JSON.stringify({ run: null, session, steps: { branch: { status: "ok" } } }));
  writeFileSync(join(fleet, "shortlist.json"), JSON.stringify({ scanned: shortlist.length, shortlist: shortlist.map((n) => ({ n, t: `ticket ${n}` })), dropped: [] }));
  writeFileSync(join(stubs, "ticket-router.json"), JSON.stringify({ out: `${ROUTE_OK}\n` }));

  const f = {
    dir, repo, home, stubs, fleet, session,
    issue,
    control: (name, value) => writeFileSync(join(stubs, `${name}.json`), JSON.stringify(value)),
    // The gh stub's rules, first match wins; the ticket's own read is always the last.
    ghRules: (rules = []) => f.control("gh", [
      ...rules,
      { match: "^issue view \\d+ --json title,body,comments,labels,createdAt$", out: JSON.stringify(f.issue) },
      { match: "^pr list ", out: "[]" },
    ]),
    calls: (name) => (existsSync(join(stubs, `${name}.calls`)) ? readFileSync(join(stubs, `${name}.calls`), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
    order: () => (existsSync(join(stubs, "order.log")) ? readFileSync(join(stubs, "order.log"), "utf8").trim().split("\n") : []),
    ledgerRow: (key, text) => {
      const r = spawnSync(process.execPath, [join(SCRIPTS, "ledger.mjs"), "row", String(key), text], { cwd: repo, encoding: "utf8", env: GIT_ENV });
      assert.equal(r.status, 0, r.stderr);
    },
    ledgerRows: () => {
      const r = spawnSync(process.execPath, [join(SCRIPTS, "ledger.mjs"), "read"], { cwd: repo, encoding: "utf8", env: GIT_ENV });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).rows;
    },
    env: () => ({ ...GIT_ENV, HOME: home, PATH: `${bin}:${process.env.PATH}`, PULL_STUBS: stubs }),
    run: (args, { cwd = repo, timeout, env = {} } = {}) => {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: "utf8", env: { ...f.env(), ...env }, timeout, killSignal: "SIGKILL" });
      return { status: r.status, signal: r.signal, out: r.stdout.split("\n").filter(Boolean), err: r.stderr, stdout: r.stdout };
    },
    next: (...args) => f.run(["next", ...args]),
    answer: (n, qid, ...rest) => f.run(["answer", String(n), qid, ...rest]),
    state: (n = 12) => JSON.parse(readFileSync(f.statePath(n), "utf8")),
    scratch: () => {
      const r = spawnSync(process.execPath, [join(SCRIPTS, "scratch-root.mjs")], { cwd: repo, encoding: "utf8", env: f.env() });
      assert.equal(r.status, 0, r.stderr);
      return r.stdout.trim();
    },
    statePath: (n = 12) => join(f.scratch(), `impl-${n}`, "pull.json"),
  };
  f.ghRules();
  return f;
}

// A Pull as far as Q3, the questions answered with the plainest tokens.
function toCollision(f) {
  const a = f.next("--head", "12");
  assert.equal(a.status, 10, a.stdout + a.err);
  assert.equal(f.answer(12, "staleness", "done").status, 10);
  const c = f.answer(12, "decided", "decided");
  assert.equal(c.status, 10, c.stdout + c.err);
  assert.match(c.stdout, /^QUESTION collision:/m);
  return c;
}

const ghCalls = (f, re) => f.calls("gh").filter((c) => re.test(c.args.join(" ")));

// ── the whole Pull ───────────────────────────────────────────────────────────

test("a Pull answered clear runs every step in order and dispatches: DISPATCH printed, exit 0", () => {
  const f = fixture();
  const first = f.next("--head", "12");
  assert.equal(first.status, 10, first.stdout + first.err);
  assert.match(first.stdout, /^QUESTION staleness:/m);

  const present = f.answer(12, "staleness", "present", "--path", "plugin/scripts/pull.mjs", "const NAME");
  assert.equal(present.status, 10, present.stdout + present.err);
  assert.match(present.stdout, /^QUESTION staleness:/m, "Q1 repeats until done");
  assert.equal(f.answer(12, "staleness", "done").status, 10);
  const q3 = f.answer(12, "decided", "decided");
  assert.equal(q3.status, 10);
  assert.match(q3.stdout, /^QUESTION collision:/m);
  const end = f.answer(12, "collision", "clear");
  assert.equal(end.status, 0, end.stdout + end.err);

  const dispatch = end.out.find((l) => l.startsWith("DISPATCH "));
  const spec = JSON.parse(dispatch.slice("DISPATCH ".length));
  assert.deepEqual(Object.keys(spec), ["name", "agent", "brief"]);
  assert.equal(spec.name, "impl-12");
  assert.equal(spec.agent, "fleet-implementer-slow-high", "no tier= on the row: the policy cell's definition");
  assert.equal(spec.brief, join(f.fleet, "briefs", "impl-12.md"));

  // The scripts ran in the Pull's order.
  assert.deepEqual(f.order(), ["inflight", "gh", "staleness", "gh", "claim-ticket", "ticket-router", "dispatch-prompt"]);
  assert.deepEqual(f.calls("inflight")[0].args, ["12"]);
  assert.deepEqual(f.calls("claim-ticket")[0].args, ["12", "impl-12", "implementer", "--apply"]);
  assert.equal(f.calls("claim-ticket")[0].cwd, f.repo, "the claim runs from the main checkout");
  assert.deepEqual(f.calls("staleness")[0].args, ["--path", "plugin/scripts/pull.mjs", "--present", "--", "const NAME"]);
  assert.deepEqual(f.calls("ticket-router")[0].args, [
    "route", "--session", f.session, "--ticket", "12", "--arm", "A", "--impl-row", "1",
    "--issue", join(f.scratch(), "impl-12", "issue.json"), "--guard", join(f.fleet, "cost-guard.json"),
  ]);
  assert.deepEqual(ghCalls(f, /^issue view/)[0].args, ["issue", "view", "12", "--json", "title,body,comments,labels,createdAt"]);
  assert.equal(readFileSync(join(f.scratch(), "impl-12", "issue.json"), "utf8").trim(), JSON.stringify(f.issue), "issue.json holds gh's answer");
  assert.equal(ghCalls(f, /^pr list/)[0].GH_REPO, "", "gh is not retargeted by an ambient GH_REPO");

  // The row, then the dispatch the ledger itself recorded.
  assert.deepEqual(f.ledgerRows().filter((r) => r.startsWith("#12 ")), ["#12 impl-12"]);
  const render = f.calls("dispatch-prompt")[0].args;
  const at = (flag) => render[render.indexOf(flag) + 1];
  assert.deepEqual(render.slice(0, 4), ["render", "implementer", "--member", "impl-12"]);
  assert.equal(at("--ticket"), "12");
  assert.equal(at("--worktree"), join(f.repo, ".worktrees", "12-impl-12"));
  assert.equal(at("--branch"), "implementer/12-impl-12");
  assert.equal(at("--scratch"), f.scratch());
  assert.match(at("--brief"), /^Title: pull\.mjs: the Pull's mechanical steps\n\n## What to build/);
  assert.match(at("--brief"), /## Out of scope\n\n- The scan\./);
  assert.equal(at("--staleness"), "present check at plugin/scripts/pull.mjs: still reproduces");
  const dispatched = readFileSync(join(f.fleet, "ledger.md"), "utf8");
  assert.match(dispatched, /## Dispatched\n\n- impl-12 brief=[0-9a-f]{8}/);
  assert.equal(f.state().status, "dispatched");
});

test("a Pull that is dispatched prints its DISPATCH again on `next --head`, and runs nothing", () => {
  const f = fixture();
  toCollision(f);
  const end = f.answer(12, "collision", "clear");
  assert.equal(end.status, 0);
  const calls = f.order().length;
  const again = f.next("--head", "12");
  assert.equal(again.status, 0, again.stdout + again.err);
  assert.equal(again.out.find((l) => l.startsWith("DISPATCH ")), end.out.find((l) => l.startsWith("DISPATCH ")));
  assert.equal(f.order().length, calls, "no script ran again");
});

// ── step 1: the in-flight check ──────────────────────────────────────────────

test("an in-flight hit exits 1 `taken` before the ticket is read", () => {
  const f = fixture();
  f.control("inflight", { exit: 1, out: '{"taken":true}' });
  const r = f.next("--head", "12");
  assert.equal(r.status, 1, r.stdout + r.err);
  assert.match(r.stdout, /^LEFT #12: taken — next entry$/m);
  assert.deepEqual(f.order(), ["inflight"]);
  assert.equal(f.state().status, "left");
});

test("an in-flight check that could not answer is taken too, and says so", () => {
  const f = fixture();
  f.control("inflight", { exit: 2 });
  const r = f.next("--head", "12");
  assert.equal(r.status, 1, r.stdout + r.err);
  assert.match(r.stdout, /^LEFT #12: taken \(the in-flight check could not answer: exit 2\) — next entry$/m);
  assert.deepEqual(f.order(), ["inflight"]);
});

// ── step 2: the ticket ───────────────────────────────────────────────────────

test("a ticket without `ready-for-agent` exits 1 `relabelled elsewhere`, and the staleness question is never asked", () => {
  const f = fixture({ issue: { ...ISSUE, labels: [{ name: "needs-triage" }] } });
  const r = f.next("--head", "12");
  assert.equal(r.status, 1, r.stdout + r.err);
  assert.match(r.stdout, /^LEFT #12: relabelled elsewhere — next entry$/m);
  assert.doesNotMatch(r.stdout, /QUESTION/);
  assert.deepEqual(f.order(), ["inflight", "gh"]);
});

test("a gh that cannot read the ticket exits 2, names it, and leaves the Pull where it was", () => {
  const f = fixture();
  f.ghRules([{ match: "^issue view", exit: 1, err: "gh: boom" }]);
  const r = f.next("--head", "12");
  assert.equal(r.status, 2, r.stdout + r.err);
  assert.match(r.err, /pull: #12: gh issue view failed \(exit 1\)\ngh: boom/);
  assert.equal(f.state().stage, "issue");
  f.ghRules();
  assert.equal(f.next("--head", "12").status, 10, "run again, it reads the ticket");
  assert.equal(f.calls("inflight").length, 1, "the Pull resumes at the step that failed; the in-flight check is not asked again");
});

test("the distilled brief is printed: title, the LAST Agent Brief comment over the body, its Out of scope, and the paths the router's extractor finds", () => {
  const f = fixture({
    issue: {
      ...ISSUE,
      comments: [
        { author: { login: "a" }, body: "## Agent Brief\n\nold brief about `old/path.mjs`\n" },
        { author: { login: "b" }, body: "not a brief" },
        { author: { login: "a" }, body: "## Agent Brief\n\nnew brief about `plugin/scripts/pull.mjs` and `tests/pull.test.mjs`\n\n### Out of scope\n\n- the scan\n\n### Notes\n\nlater\n" },
      ],
    },
  });
  const r = f.next("--head", "12");
  assert.equal(r.status, 10);
  const lines = r.stdout.split("\n");
  assert.equal(lines.includes("TICKET #12: pull.mjs: the Pull's mechanical steps"), true);
  assert.equal(lines.includes("new brief about `plugin/scripts/pull.mjs` and `tests/pull.test.mjs`"), true);
  assert.equal(r.stdout.includes("old/path.mjs"), false, "an older Agent Brief comment is not the brief");
  assert.equal(r.stdout.includes("What to build"), false, "the body is not the brief when a comment is");
  const oos = lines.indexOf("OUT OF SCOPE:");
  assert.deepEqual(lines.slice(oos + 1, oos + 4), ["### Out of scope", "", "- the scan"]);
  assert.equal(lines.includes("PATHS: plugin/scripts/pull.mjs tests/pull.test.mjs"), true);
  assert.equal(lines.slice(oos + 1, lines.indexOf("PATHS: plugin/scripts/pull.mjs tests/pull.test.mjs")).includes("later"), false, "Out of scope ends at the next heading of its level");
});

test("the paths printed are the router's own extractor's, and it is exported", () => {
  const brief = "see `a/b.mjs`, `c.sh`, `two words.txt`, `plain`, `a/b.mjs`";
  assert.deepEqual(briefPaths(brief), ["a/b.mjs", "c.sh"]);
  const m = issueMetrics({ ...ISSUE, body: brief });
  assert.equal(m.paths, "2", "the router's own metric counts what the extractor finds");
});

test("outOfScope: the section from its heading to the next heading of its level or above; none when absent", () => {
  assert.equal(outOfScope("## A\n\nx\n\n## Out of scope\n\n- y\n\n### sub\n\nz\n\n## B\n\nw"), "## Out of scope\n\n- y\n\n### sub\n\nz");
  assert.equal(outOfScope("# T\n\n## out of scope\n\n- y"), "## out of scope\n\n- y");
  assert.equal(outOfScope("## What\n\nonly this"), null);
});

test("briefPaths skips the Out of scope section, its heading at any level and in any case, through to the next heading of its level or above", () => {
  const brief = [
    "## What to build", "", "Change `a/in.mjs`.", "",
    "### OUT of Scope", "", "- `a/out.mjs`", "", "#### Detail", "", "- `a/deeper.mjs`", "",
    "### Acceptance", "", "- `a/after.mjs`, and `a/out.mjs` again",
  ].join("\n");
  assert.deepEqual(briefPaths(brief), ["a/in.mjs", "a/after.mjs", "a/out.mjs"], "a path the section names is still scanned where the brief names it outside it");
  assert.deepEqual(briefPaths("Change `a/in.mjs`.\n\n# out of scope\n\n- `a/out.mjs`\n"), ["a/in.mjs"], "a section that runs to the end is skipped to the end");
  assert.equal(issueMetrics({ ...ISSUE, body: brief }).paths, "3", "the router's metric counts what the extractor keeps");
});

test("pathHits: a brief path names its file from below the repository root, and with a line reference; a slash command names none", () => {
  const skill = "plugin/skills/run-team/SKILL.md";
  for (const [p, f] of [
    ["run-team/SKILL.md", skill],
    ["briefs/fix-applier.md", "plugin/skills/run-team/briefs/fix-applier.md"],
    ["run-team/SKILL.md:256-263", skill],
    ["plugin/scripts/pull.mjs:12", "plugin/scripts/pull.mjs"],
    ["pull.mjs:12", "plugin/scripts/pull.mjs"],
    ["briefs/", "plugin/skills/run-team/briefs/fix-applier.md"],
    ["skills/run-team", skill],
    [skill, skill],
    ["plugin/", skill],
    ["SKILL.md", skill],
  ]) assert.equal(pathHits(p, f), true, `${p} names ${f}`);
  for (const [p, f] of [
    ["/run-team", skill],
    ["/run-team/SKILL.md", skill],
    ["n/SKILL.md", "run-team/SKILL.md"],
    ["plugin/script", "plugin/scripts/pull.mjs"],
    ["ugin", "plugin/scripts/pull.mjs"],
    ["un-team/SKILL.md", skill],
    [":12", skill],
  ]) assert.equal(pathHits(p, f), false, `${p} names no ${f}`);
});

test("diffHunks reads each file's base-side hunk ranges and the lines their changes touch, counting a hunk's lines so a removed `-- x` line is no header", () => {
  const diff = [
    "diff --git a/x.md b/x.md", "index 1..2 100644", "--- a/x.md", "+++ b/x.md",
    "@@ -3,3 +3,3 @@ ## stale funcname", " a", "--- b", "+--- c", " d",
    "@@ -20 +20,0 @@", "-q",
    "@@ -30,3 +30,4 @@", " k", "+new", " l", " m",
    "diff --git \"a/docs/\\303\\251.md\" \"b/docs/\\303\\251.md\"", "new file mode 100644", "--- /dev/null", "+++ \"b/docs/\\303\\251.md\"", "@@ -0,0 +1 @@", "+x",
    "diff --git a/gone.md b/gone.md", "deleted file mode 100644", "--- a/gone.md", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-a", "-b",
  ].join("\n");
  assert.deepEqual(diffHunks(diff), [
    { old: "x.md", new: "x.md", hunks: [{ a: 3, b: 3, from: 4, to: 4 }, { a: 20, b: 1, from: 20, to: 20 }, { a: 30, b: 3, from: 30, to: 30 }] },
    { old: null, new: "docs/é.md", hunks: [{ a: 0, b: 0, from: 0, to: 0 }] },
    { old: "gone.md", new: null, hunks: [{ a: 1, b: 2, from: 1, to: 2 }] },
  ]);
});

test("diffHunks counts each side alone: a delete-only and an add-only hunk with dashed bodies", () => {
  const diff = [
    "diff --git a/gone b/gone", "deleted file mode 100644", "--- a/gone", "+++ /dev/null", "@@ -1,2 +0,0 @@", "--- x", "-b",
    "diff --git a/added b/added", "new file mode 100644", "--- /dev/null", "+++ b/added", "@@ -0,0 +1,2 @@", "+++ y", "+b",
  ].join("\n");
  assert.deepEqual(diffHunks(diff), [
    { old: "gone", new: null, hunks: [{ a: 1, b: 2, from: 1, to: 2 }] },
    { old: null, new: "added", hunks: [{ a: 0, b: 0, from: 0, to: 0 }] },
  ]);
});

test("headings skips fenced code; sectionsOf names the heading a range starts under and each it crosses", () => {
  const hs = headings("# T\n\n```sh\n# a comment\n```\n## A\nx\n  ### B\ny\n~~~\n## not\n~~~\n");
  assert.deepEqual(hs, [{ line: 1, text: "# T" }, { line: 6, text: "## A" }, { line: 8, text: "### B" }]);
  assert.deepEqual(headings("# Top\n```\nnot\n```js\n# in code\n```\n## Real\ntext"), [{ line: 1, text: "# Top" }, { line: 7, text: "## Real" }], "a fence line with an info string does not close a fence");
  assert.equal(sectionsOf(hs, 7, 7), "## A");
  assert.equal(sectionsOf(hs, 6, 9), "## A → ### B");
  assert.equal(sectionsOf(hs, 0, -1), "(no heading above)");
  assert.equal(sectionsOf([], 5, 9), "(no heading above)");
});

// ── the shortlist head ───────────────────────────────────────────────────────

test("`next` takes the first shortlist entry with no impl row and no live exclusion", () => {
  const f = fixture({ shortlist: [11, 12, 13, 14] });
  f.ledgerRow(11, "impl-11");
  f.ledgerRow(12, "excluded · behind-pr:#90");
  f.ledgerRow(13, "excluded · behind-issue:#91");
  f.ghRules([
    { match: "^pr view 90 --json state$", out: '{"state":"OPEN"}' },
    { match: "^issue view 91 --json state$", out: '{"state":"CLOSED"}' },
  ]);
  const r = f.next();
  assert.equal(r.status, 10, r.stdout + r.err);
  assert.match(r.stdout, /^PULL #13: started/m, "11 has an impl row, 12's premise is open, 13's premise is lifted");
  assert.deepEqual(f.calls("inflight")[0].args, ["13"]);
});

test("an exclusion whose premise cannot be read stands", () => {
  const f = fixture({ shortlist: [12, 14] });
  f.ledgerRow(12, "excluded · behind-pr:#90");
  f.ghRules([{ match: "^pr view 90 ", exit: 1, err: "gh: no network" }]);
  const r = f.next();
  assert.match(r.stdout, /^PULL #14: started/m);
});

test("a shortlist emptied only by exclusions whose premise cannot be read exits 2 naming them, not EMPTY", () => {
  const f = fixture({ shortlist: [12] });
  f.ledgerRow(12, "excluded · behind-pr:#90");
  f.ghRules([{ match: "^pr view 90 ", exit: 1, err: "HTTP 401: bad credentials" }]);
  const r = f.next();
  assert.equal(r.status, 2, r.stdout + r.err);
  assert.match(r.err, /gh could not read the premise of an exclusion, which stands: gh pr view 90 \(exit 1: HTTP 401: bad credentials\)/);
  assert.equal(r.stdout.includes("EMPTY"), false);

  const g = fixture({ shortlist: [12] });
  g.ledgerRow(12, "excluded · behind-pr:#90");
  g.ghRules([{ match: "^pr view 90 --json state$", out: '{"state":"OPEN"}' }]);
  const open = g.next();
  assert.equal(open.status, 1, "a premise that answered and still holds is an empty shortlist");
  assert.match(open.stdout, /^EMPTY:/m);
});

test("a ticket whose Pull already left is skipped by `next` and started over by `next --head`", () => {
  const f = fixture({ shortlist: [12, 14] });
  f.control("inflight", { by: {} });
  f.control("inflight", { exit: 1 });
  assert.equal(f.next().status, 1, "12 is taken");
  f.control("inflight", {});
  const r = f.next();
  assert.match(r.stdout, /^PULL #14: started/m, "the entry that left is not the head again");
  const again = f.next("--head", "12");
  assert.match(again.stdout, /^PULL #12: started/m, "asked for by number, it starts over");
  assert.equal(JSON.parse(readFileSync(join(f.scratch(), "impl-12", "pull.previous.json"), "utf8")).status, "left", "the ended Pull is kept beside it");
});

// ── `next --head` and a standing exclusion ───────────────────────────────────

test("`next --head` for a ticket whose exclusion premise still holds leaves it: exit 1, the record saved, nothing claimed or read", () => {
  const f = fixture({ shortlist: [50] });
  f.ledgerRow(50, "excluded · behind-issue:#9");
  f.ghRules([{ match: "^issue view 9 --json state$", out: '{"state":"OPEN"}' }]);
  const r = f.next("--head", "50");
  assert.equal(r.status, 1, r.stdout + r.err);
  assert.equal(r.stdout, "LEFT #50: excluded · behind-issue:#9 OPEN — next entry\n");
  const st = f.state(50);
  assert.equal(st.status, "left");
  assert.equal(st.session, f.session);
  assert.equal(st.outcome.reason, "excluded · behind-issue:#9 OPEN");
  assert.deepEqual(f.calls("inflight"), []);
  assert.deepEqual(f.calls("claim-ticket"), []);
  assert.deepEqual(ghCalls(f, /^issue view 50 /), []);
  assert.deepEqual(ghCalls(f, /^issue comment|^issue edit/), []);
  assert.deepEqual(f.ledgerRows().filter((x) => x.startsWith("#50 ")), ["#50 excluded · behind-issue:#9"], "the row is untouched");

  // The saved record is what hands the slot on: plain `next` does not take the ticket again, and `--head` asks again.
  assert.match(f.next().stdout, /^EMPTY:/m);
  f.ghRules([{ match: "^issue view 9 --json state$", out: '{"state":"MERGED"}' }]);
  const lifted = f.next("--head", "50");
  assert.match(lifted.stdout, /^PULL #50: started/m, "the premise is lifted: the Pull starts as today");
  assert.equal(JSON.parse(readFileSync(join(f.scratch(), "impl-50", "pull.previous.json"), "utf8")).status, "left", "the ended Pull is kept beside it");
});

test("`next --head` for a branch-named behind-pr premise: OPEN leaves, an unanswered `gh pr view` is exit 2 with no record", () => {
  const f = fixture({ shortlist: [50] });
  f.ledgerRow(50, "excluded · behind-pr:#implementer/2151-impl-2151");
  f.ghRules([{ match: "^pr view implementer/2151-impl-2151 --json state$", out: '{"state":"OPEN"}' }]);
  const open = f.next("--head", "50");
  assert.equal(open.status, 1, open.stdout + open.err);
  assert.equal(open.stdout, "LEFT #50: excluded · behind-pr:#implementer/2151-impl-2151 OPEN — next entry\n");
  assert.equal(f.state(50).status, "left");

  const g = fixture({ shortlist: [50] });
  g.ledgerRow(50, "excluded · behind-pr:#implementer/2151-impl-2151");
  g.ghRules([{ match: "^pr view implementer/2151-impl-2151 ", exit: 1, err: "no pull requests found for branch" }]);
  const none = g.next("--head", "50");
  assert.equal(none.status, 2, none.stdout + none.err);
  assert.match(none.err, /#50: the premise of its exclusion could not be read, so the exclusion stands: gh pr view implementer\/2151-impl-2151 \(exit 1: no pull requests found for branch\)/);
  assert.equal(existsSync(g.statePath(50)), false, "no record: the next tick asks again");
  assert.deepEqual(g.calls("claim-ticket"), []);
  assert.deepEqual(g.calls("inflight"), []);
});

test("`next --head` over an ended record whose premise cannot be read leaves that record where it is", () => {
  const f = fixture({ shortlist: [50] });
  f.control("inflight", { exit: 1 });
  assert.equal(f.next("--head", "50").status, 1, "taken");
  f.ledgerRow(50, "excluded · behind-issue:#9");
  f.ghRules([{ match: "^issue view 9 ", exit: 1, err: "gh: no network" }]);
  assert.equal(f.next("--head", "50").status, 2);
  assert.equal(existsSync(join(f.scratch(), "impl-50", "pull.previous.json")), false);
  assert.equal(f.state(50).outcome.reason, "taken");
});

test("`next --head` for an excluded row naming no premise leaves it with the row's own text as the reason", () => {
  const f = fixture({ shortlist: [50] });
  f.ledgerRow(50, "excluded · needs a human ruling");
  const r = f.next("--head", "50");
  assert.equal(r.status, 1, r.stdout + r.err);
  assert.equal(r.stdout, "LEFT #50: excluded · needs a human ruling — next entry\n");
  assert.equal(f.state(50).status, "left");
  assert.deepEqual(ghCalls(f, /--json state$/), [], "no premise to probe");
  assert.deepEqual(f.calls("inflight"), []);
});

test("`next --head` for a premise whose `gh` answer holds no state is exit 2 with no record", () => {
  for (const out of ["{}", '{"state":null}', '{"state":7}', '{"state":""}']) {
    const f = fixture({ shortlist: [50] });
    f.ledgerRow(50, "excluded · behind-issue:#9");
    f.ghRules([{ match: "^issue view 9 --json state$", out }]);
    const r = f.next("--head", "50");
    assert.equal(r.status, 2, `${out}: ${r.stdout}${r.err}`);
    assert.match(r.err, /#50: the premise of its exclusion could not be read, so the exclusion stands: gh issue view 9 \(printed no JSON state\)/, out);
    assert.equal(existsSync(f.statePath(50)), false, out);
  }
});

test("`next --head` for a ticket whose exclusion premise is lifted or whose row is no exclusion starts the Pull", () => {
  for (const state of ["CLOSED", "MERGED"]) {
    const f = fixture({ shortlist: [50] });
    f.ledgerRow(50, "excluded · behind-issue:#9");
    f.ghRules([{ match: "^issue view 9 --json state$", out: JSON.stringify({ state }) }]);
    const r = f.next("--head", "50");
    assert.match(r.stdout, /^PULL #50: started/m, state);
    assert.deepEqual(f.calls("inflight")[0].args, ["50"]);
  }
  const g = fixture({ shortlist: [50] });
  const none = g.next("--head", "50");
  assert.match(none.stdout, /^PULL #50: started/m, "no row");
  assert.deepEqual(ghCalls(g, /--json state$/), [], "no premise to probe");

  // Plain `next` checked the head it picked on the way there, so it probes that premise once, not twice.
  const h = fixture({ shortlist: [50] });
  h.ledgerRow(50, "excluded · behind-issue:#9");
  h.ghRules([{ match: "^issue view 9 --json state$", out: '{"state":"CLOSED"}' }]);
  assert.match(h.next().stdout, /^PULL #50: started/m);
  assert.equal(ghCalls(h, /--json state$/).length, 1);
});

test("`next --head` for a Pull in progress or dispatched reads no ledger and probes no premise", () => {
  const f = fixture({ shortlist: [12] });
  assert.equal(f.next("--head", "12").status, 10);
  f.ledgerRow(12, "excluded · behind-issue:#9");
  f.ghRules([{ match: "^issue view 9 --json state$", out: '{"state":"OPEN"}' }]);
  const resumed = f.next("--head", "12");
  assert.equal(resumed.status, 10, resumed.stdout + resumed.err);
  assert.match(resumed.stdout, /^PULL #12: resumed at question staleness/m);
  assert.deepEqual(ghCalls(f, /--json state$/), []);

  const g = fixture({ shortlist: [12] });
  assert.equal(g.next("--head", "12").status, 10);
  assert.equal(g.answer(12, "staleness", "done").status, 10);
  assert.equal(g.answer(12, "decided", "decided").status, 10);
  assert.equal(g.answer(12, "collision", "clear").status, 0);
  g.ledgerRow(12, "excluded · behind-issue:#9");
  g.ghRules([{ match: "^issue view 9 --json state$", out: '{"state":"OPEN"}' }]);
  const again = g.next("--head", "12");
  assert.equal(again.status, 0, again.stdout + again.err);
  assert.match(again.stdout, /^DISPATCH /m);
  assert.deepEqual(ghCalls(g, /--json state$/), []);
});

// A new run is a new phase-0 receipt naming a new session, and a new ledger;
// the scratch root, and the Pull records in it, persist.
function newRun(f) {
  writeFileSync(join(f.fleet, "phase0.json"), JSON.stringify({ run: null, session: "2026-10-16T09-00-00-000Z_next", steps: { branch: { status: "ok" } } }));
  rmSync(join(f.fleet, "ledger.md"), { force: true });
}

test("a Pull that left in an earlier run does not hide its ticket from this run's `next`", () => {
  const f = fixture({ shortlist: [12, 14] });
  f.control("inflight", { exit: 1 });
  assert.equal(f.next().status, 1, "12 is taken this run");
  f.control("inflight", {});
  assert.match(f.next().stdout, /^PULL #14: started/m, "within the run, the entry that left is not the head again");
  newRun(f);
  const r = f.next();
  assert.match(r.stdout, /^PULL #12: started/m, "in the next run, 12 is offered again");
  assert.equal(JSON.parse(readFileSync(join(f.scratch(), "impl-12", "pull.previous.json"), "utf8")).status, "left");
});

test("a Pull dispatched in an earlier run is not replayed in this one: the ticket is pulled again, claim and all", () => {
  const f = fixture();
  toCollision(f);
  assert.equal(f.answer(12, "collision", "clear").status, 0);
  assert.equal(f.calls("claim-ticket").length, 1);
  newRun(f);
  const r = f.next();
  assert.equal(r.status, 10, r.stdout + r.err);
  assert.match(r.stdout, /^PULL #12: started/m);
  assert.equal(r.stdout.includes("DISPATCH"), false, "the earlier run's DISPATCH is not printed again");
  assert.equal(f.calls("inflight").length, 2, "the in-flight check ran again");
  assert.equal(JSON.parse(readFileSync(join(f.scratch(), "impl-12", "pull.previous.json"), "utf8")).status, "dispatched");
  assert.equal(f.answer(12, "staleness", "done").status, 10);
  assert.equal(f.answer(12, "decided", "decided").status, 10);
  assert.equal(f.answer(12, "collision", "clear").status, 0);
  assert.equal(f.calls("claim-ticket").length, 2, "this run claims the ticket itself");
});

test("an empty shortlist exits 1 EMPTY; an unreadable one exits 2", () => {
  const f = fixture({ shortlist: [] });
  const r = f.next();
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^EMPTY: /m);
  writeFileSync(join(f.fleet, "shortlist.json"), "not json");
  const bad = f.next();
  assert.equal(bad.status, 2, bad.stdout + bad.err);
  assert.match(bad.err, /cannot read|holds no shortlist/);
});

// ── Q1: staleness ────────────────────────────────────────────────────────────

test("Q1 gone and present reach staleness.mjs with `--` before the needle, a flag-shaped needle included", () => {
  const f = fixture();
  f.next("--head", "12");
  assert.equal(f.answer(12, "staleness", "gone", "--path", "plugin/x.mjs", "--", "--label ready-for-agent").status, 10);
  assert.equal(f.answer(12, "staleness", "present", "--path", "tests/y.test.mjs", "two", "words").status, 10);
  assert.deepEqual(f.calls("staleness").map((c) => c.args), [
    ["--path", "plugin/x.mjs", "--gone", "--", "--label ready-for-agent"],
    ["--path", "tests/y.test.mjs", "--present", "--", "two words"],
  ]);
});

test("Q1: a token that needs --path or text, or takes neither, exits 3 and records nothing", () => {
  const f = fixture();
  f.next("--head", "12");
  const before = JSON.stringify(f.state());
  for (const args of [["gone", "needle"], ["gone", "--path", "p"], ["none"], ["done", "extra"], ["maybe"], ["none", "--path", "p", "why"]]) {
    const r = f.answer(12, "staleness", ...args);
    assert.equal(r.status, 3, `${args.join(" ")}: ${r.stdout}${r.err}`);
    assert.match(r.err, /the tokens staleness takes/);
  }
  assert.equal(JSON.stringify(f.state()), before, "an answer refused is not recorded");
  assert.equal(f.calls("staleness").length, 0);
});

test("Q1: staleness.mjs exit 2 is recorded `could-not-check: <reason>` and reaches the brief; exit 0 is `still reproduces`", () => {
  const f = fixture();
  f.next("--head", "12");
  f.control("staleness", { exit: 2, out: JSON.stringify({ verdict: "unknown", why: "path not tracked" }) });
  assert.equal(f.answer(12, "staleness", "gone", "--path", "p.mjs", "x").status, 10);
  f.control("staleness", { exit: 0, out: JSON.stringify({ verdict: "live" }) });
  assert.equal(f.answer(12, "staleness", "present", "--path", "q.mjs", "y").status, 10);
  assert.equal(f.answer(12, "staleness", "none", "no single string settles the acceptance criteria").status, 10);
  f.answer(12, "decided", "decided");
  f.answer(12, "collision", "clear");
  const render = f.calls("dispatch-prompt")[0].args;
  assert.equal(
    render[render.indexOf("--staleness") + 1],
    "could-not-check: path not tracked; present check at q.mjs: still reproduces; could-not-check: no string settles it — no single string settles the acceptance criteria",
  );
});

test("Q1: a probe that answered 2 with no JSON is could-not-check with its first line; a Pull that ran no probe says so", () => {
  const f = fixture();
  f.next("--head", "12");
  f.control("staleness", { exit: 2, err: "staleness: --gone needs a value\nmore" });
  f.answer(12, "staleness", "gone", "--path", "p.mjs", "x");
  assert.deepEqual(f.state().staleness, ["could-not-check: staleness: --gone needs a value"]);

  const g = fixture();
  toCollision(g);
  g.answer(12, "collision", "clear");
  const render = g.calls("dispatch-prompt")[0].args;
  assert.equal(render[render.indexOf("--staleness") + 1], "no probe was run");
});

function fixedFixture() {
  const f = fixture();
  writeFileSync(join(f.repo, "fix.txt"), "fixed\n");
  git(f.repo, "add", "fix.txt");
  git(f.repo, "commit", "-q", "-m", "the real subject of the fix");
  const sha = git(f.repo, "rev-parse", "HEAD");
  f.control("staleness", { exit: 1, out: JSON.stringify({ verdict: "fixed", commit: sha, subject: "a subject the payload carries" }) });
  f.next("--head", "12");
  return { f, sha };
}

test("Q1b: a probe that read the ticket as fixed asks `close` with the commit and the subject git reads, not the payload's", () => {
  const { f, sha } = fixedFixture();
  const r = f.answer(12, "staleness", "gone", "--path", "p.mjs", "old wording");
  assert.equal(r.status, 10, r.stdout + r.err);
  assert.match(r.stdout, /^QUESTION close:/m);
  assert.equal(r.stdout.includes(sha), true);
  assert.match(r.stdout, /subject: the real subject of the fix$/m);
  assert.equal(r.stdout.includes("a subject the payload carries"), false);
  assert.deepEqual(
    f.state().commands.filter((c) => c.step === "close").map((c) => c.cmd),
    [["git", "log", "-1", "--format=%s", sha]],
  );
});

test("Q1b yes: the issue is closed with a comment citing the commit and its subject, exit 1; the labels are not touched", () => {
  const { f, sha } = fixedFixture();
  f.answer(12, "staleness", "gone", "--path", "p.mjs", "old wording");
  const r = f.answer(12, "close", "yes");
  assert.equal(r.status, 1, r.stdout + r.err);
  assert.match(r.stdout, /^LEFT #12: closed: fixed by [0-9a-f]{40}: the real subject of the fix — next entry$/m);
  const close = ghCalls(f, /^issue close/);
  assert.equal(close.length, 1);
  assert.deepEqual(close[0].args, [
    "issue", "close", "12", "--comment",
    `*Closed by the fleet controller.* Pulled for implementation and found already fixed by ${sha}: the real subject of the fix.`,
  ]);
  assert.equal(ghCalls(f, /^issue edit/).length, 0);
  assert.equal(f.calls("claim-ticket").length, 0);
});

test("Q1b no: the Pull goes on, asks Q1 again, and the brief carries what the controller kept the ticket for", () => {
  const { f, sha } = fixedFixture();
  f.answer(12, "staleness", "gone", "--path", "p.mjs", "old wording");
  const r = f.answer(12, "close", "no", "the", "subject", "is", "about", "something", "else");
  assert.equal(r.status, 10, r.stdout + r.err);
  assert.match(r.stdout, /^QUESTION staleness:/m);
  assert.equal(ghCalls(f, /^issue close/).length, 0);
  assert.deepEqual(f.state().staleness, [`staleness probe read --gone in p.mjs as fixed by ${sha}: the real subject of the fix; kept by the controller: the subject is about something else`]);
});

test("Q1b: a close that gh refuses exits 2 and leaves the question standing; a subject git cannot read is exit 2 too", () => {
  const { f } = fixedFixture();
  f.answer(12, "staleness", "gone", "--path", "p.mjs", "old wording");
  f.ghRules([{ match: "^issue close", exit: 1, err: "gh: forbidden" }]);
  const r = f.answer(12, "close", "yes");
  assert.equal(r.status, 2, r.stdout + r.err);
  assert.match(r.err, /gh issue close failed \(exit 1\)\ngh: forbidden/);
  const st = f.state();
  assert.equal(st.pending.qid, "close");
  assert.equal(st.answers.at(-1).applied, false);
  f.ghRules();
  assert.equal(f.answer(12, "close", "yes").status, 1, "answered again, it closes");

  const g = fixture();
  g.control("staleness", { exit: 1, out: JSON.stringify({ verdict: "fixed", commit: "0".repeat(40) }) });
  g.next("--head", "12");
  const bad = g.answer(12, "staleness", "gone", "--path", "p.mjs", "x");
  assert.equal(bad.status, 2, bad.stdout + bad.err);
  assert.match(bad.err, /could not read the subject of 0{40}/);
  assert.equal(g.state().pending, null, "no question is asked on a subject nobody read");
});

test("Q1: a `fixed` verdict that names no commit is could-not-check, never a close", () => {
  const f = fixture();
  f.control("staleness", { exit: 1, out: JSON.stringify({ verdict: "fixed" }) });
  f.next("--head", "12");
  const r = f.answer(12, "staleness", "gone", "--path", "p.mjs", "x");
  assert.match(r.stdout, /^QUESTION staleness:/m);
  assert.deepEqual(f.state().staleness, ["could-not-check: the probe read the ticket as fixed and named no commit"]);
});

test("Q1: exit 1 with no verdict JSON is a probe that crashed, never a `fixed` verdict, and says so", () => {
  const f = fixture();
  f.control("staleness", { exit: 1, err: "TypeError: x is not a function\n    at probe" });
  f.next("--head", "12");
  const r = f.answer(12, "staleness", "gone", "--path", "p.mjs", "x");
  assert.match(r.stdout, /^QUESTION staleness:/m);
  assert.deepEqual(f.state().staleness, ["could-not-check: the probe exited 1 with no verdict JSON, which is a crash and no verdict: TypeError: x is not a function"]);
  assert.equal(f.state().close, null);
});

// ── Q2: decided ──────────────────────────────────────────────────────────────

// The three relabel comments, as `briefs/relabel.md` words them — rendered
// through the shared fixture, each unwrapped into one line. The fixture's own
// argument values (`LINE-1`, `OPTIONS-1`, `HANDS-1`, `LINE-2`) are what each
// case below swaps for its own text.
const unwrapped = (kind) => renderBrief("relabel", kind).trim().replace(/\n/g, " ");
function skillTemplates() {
  return { triage: unwrapped("needs-triage"), fork: unwrapped("fork"), hands: unwrapped("hands") };
}

const CAUSES = [
  {
    token: "needs-triage", text: ["the", "API", "shape"], label: "needs-triage",
    expect: (t) => t.triage.replace("LINE-1", "the API shape"),
  },
  {
    token: "ready-for-human-fork", text: ["A", "or", "B"], label: "ready-for-human",
    expect: (t) => t.fork.replace("OPTIONS-1", "A or B"),
  },
  {
    token: "ready-for-human-hands", text: ["external access", "needs", "a", "token"], label: "ready-for-human",
    expect: (t) => t.hands.replace("HANDS-1", "external access").replace("LINE-2", "needs a token"),
  },
  {
    token: "ready-for-human-hands", text: ["manual", "testing", "click", "through"], label: "ready-for-human",
    expect: (t) => t.hands.replace("HANDS-1", "manual testing").replace("LINE-2", "click through"),
  },
  {
    token: "ready-for-human-hands", text: ["judgment", "pick", "a", "name"], label: "ready-for-human",
    expect: (t) => t.hands.replace("HANDS-1", "judgment during the work").replace("LINE-2", "pick a name"),
  },
];

for (const c of CAUSES) {
  test(`Q2 ${c.token} (${c.text[0]}): the comment is byte-equal to the rendered relabel brief, the label moves, exit 1, nothing is claimed`, () => {
    const f = fixture();
    f.next("--head", "12");
    f.answer(12, "staleness", "done");
    const r = f.answer(12, "decided", c.token, ...c.text);
    assert.equal(r.status, 1, r.stdout + r.err);
    const comments = ghCalls(f, /^issue comment/);
    assert.equal(comments.length, 1, "exactly one comment");
    assert.deepEqual(comments[0].args.slice(0, 4), ["issue", "comment", "12", "--body"]);
    assert.equal(comments[0].args[4], c.expect(skillTemplates()));
    const edits = ghCalls(f, /^issue edit/);
    assert.equal(edits.length, 1);
    assert.deepEqual(edits[0].args, ["issue", "edit", "12", "--remove-label", "ready-for-agent", "--add-label", c.label]);
    assert.deepEqual(f.order().filter((n) => n !== "gh"), ["inflight", "staleness"].slice(0, 1), "no claim, no router, no row");
    assert.equal(f.ledgerRows().length, 0);
    assert.equal(f.state().status, "left");
  });
}

test("the comment helper is the template: relabel() agrees with the rendered relabel brief for every cause", () => {
  const t = skillTemplates();
  assert.equal(relabel("needs-triage", "X").comment, t.triage.replace("LINE-1", "X"));
  assert.equal(relabel("ready-for-human-fork", "X").comment, t.fork.replace("OPTIONS-1", "X"));
  assert.equal(relabel("ready-for-human-hands", "external access X").comment, t.hands.replace("HANDS-1", "external access").replace("LINE-2", "X"));
});

test("Q2 decided: the Pull goes on to the collision question and posts nothing", () => {
  const f = fixture();
  toCollision(f);
  assert.equal(ghCalls(f, /^issue (comment|edit)/).length, 0);
});

test("Q2: a cause needs its text, hands need a cause from the three then a line, `decided` takes none", () => {
  const f = fixture();
  f.next("--head", "12");
  f.answer(12, "staleness", "done");
  for (const args of [["needs-triage"], ["ready-for-human-fork"], ["ready-for-human-hands"], ["ready-for-human-hands", "somewhere", "else"], ["ready-for-human-hands", "judgment"], ["decided", "yes"], ["ready-for-human"]]) {
    const r = f.answer(12, "decided", ...args);
    assert.equal(r.status, 3, `${args.join(" ")}: ${r.stdout}${r.err}`);
  }
  assert.equal(ghCalls(f, /^issue (comment|edit)/).length, 0, "an answer refused posts nothing");
  assert.equal(f.state().pending.qid, "decided");
});

test("Q2: an edit that fails after its comment landed is answered again without a second comment", () => {
  const f = fixture();
  f.next("--head", "12");
  f.answer(12, "staleness", "done");
  f.ghRules([{ match: "^issue edit", exit: 1, err: "gh: rate limited" }]);
  const r = f.answer(12, "decided", "needs-triage", "the", "scope");
  assert.equal(r.status, 2, r.stdout + r.err);
  assert.match(r.err, /gh issue edit failed \(exit 1\) — the comment is posted/);
  f.ghRules();
  assert.equal(f.answer(12, "decided", "needs-triage", "the", "scope").status, 1);
  assert.equal(ghCalls(f, /^issue comment/).length, 1);
  assert.equal(ghCalls(f, /^issue edit/).length, 2);
});

// ── Q3: collision ────────────────────────────────────────────────────────────

// Two open PRs whose diffs the gh stub answers — #7's failing when asked —
// and two live worktrees: `feature/x`, a branch with no PR, and `fix/31`,
// #31's head, pushed as origin's `pull/31/head`. Each worktree's branch
// carries one commit of its own, every file it writes new.
function scanFixture({ failing = false, issue } = {}) {
  const f = fixture({ issue });
  const branch = (name, files) => {
    const wt = join(f.dir, name.replace("/", "-"));
    git(f.repo, "worktree", "add", "-q", "-b", name, wt);
    for (const p of files) {
      mkdirSync(join(wt, p, ".."), { recursive: true });
      writeFileSync(join(wt, p), `${name}\n`);
    }
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", name);
  };
  branch("feature/x", ["tests/pull.test.mjs", "docs/notes.md"]);
  branch("fix/31", ["plugin/scripts/pull.mjs"]);
  git(f.repo, "push", "-q", "origin", "fix/31:refs/pull/31/head");
  const other = "diff --git a/plugin/scripts/other.mjs b/plugin/scripts/other.mjs\nnew file mode 100644\n--- /dev/null\n+++ b/plugin/scripts/other.mjs\n@@ -0,0 +1 @@\n+feat/7\n";
  f.ghRules([
    { match: "^pr list ", out: JSON.stringify([{ number: 31, headRefName: "fix/31" }, { number: 7, headRefName: "feat/7" }]) },
    { match: "^pr diff 31 --name-only$", out: "plugin/scripts/pull.mjs\nREADME\n" },
    { match: "^pr diff 31$", out: `${git(f.repo, "diff", "--src-prefix=a/", "--dst-prefix=b/", "origin/main...fix/31")}\n` },
    { match: "^pr diff 7 --name-only$", ...(failing ? { exit: 1, err: "boom" } : { out: "plugin/scripts/other.mjs\n" }) },
    { match: "^pr diff 7$", out: other },
  ]);
  return f;
}

// The QUESTION collision block's context lines, the two-space indent dropped.
const collisionLines = (stdout) => {
  const all = stdout.split("\n");
  const at = all.indexOf("QUESTION collision:");
  assert.notEqual(at, -1, stdout);
  const lines = [];
  for (const l of all.slice(at + 1)) {
    if (l.startsWith("  answer with:")) break;
    lines.push(l.replace(/^ {2}/, ""));
  }
  return lines;
};

test("Q3 scans every open PR and live worktree branch against the brief's paths and prints one line per overlap, its shared files' hunks under it", () => {
  const f = scanFixture();
  const r = toCollision(f);
  assert.deepEqual(collisionLines(r.stdout), [
    "paths scanned: plugin/scripts/pull.mjs tests/pull.test.mjs",
    "PR #31: plugin/scripts/pull.mjs",
    "  plugin/scripts/pull.mjs @@ -0,0 @@ (new file)",
    "branch feature/x: tests/pull.test.mjs",
    "  tests/pull.test.mjs @@ -0,0 @@ (new file)",
    "branch fix/31 (PR #31): plugin/scripts/pull.mjs",
    "  plugin/scripts/pull.mjs @@ -0,0 @@ (new file)",
    "behind-issue candidates (Out of scope): (none)",
  ]);
  assert.deepEqual(ghCalls(f, /^pr /).map((c) => c.args), [
    ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName"],
    ["pr", "diff", "7", "--name-only"],
    ["pr", "diff", "31", "--name-only"],
    ["pr", "diff", "31"],
  ], "only a PR sharing a file has its full diff read");
  const diffs = f.state().commands.filter((c) => c.cmd[0] === "git" && c.cmd[1] === "diff").map((c) => c.cmd.slice(1));
  const full = (b) => ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", `origin/main...${b}`, "--"];
  assert.deepEqual(diffs, [
    ["diff", "--name-only", "-z", "origin/main...feature/x", "--"], full("feature/x"),
    ["diff", "--name-only", "-z", "origin/main...fix/31", "--"], full("fix/31"),
  ], "every branch but main is diffed, and one sharing a file in full");
  assert.deepEqual(f.state().commands.filter((c) => c.cmd[0] === "git" && ["fetch", "merge-base", "cat-file"].includes(c.cmd[1])), [], "no base is read for a file new in the diff, nor for one that is not Markdown");
  assert.equal(f.calls("claim-ticket").length, 0, "nothing is claimed before Q3 is answered");
  const [scan] = f.state().scans;
  assert.deepEqual(scan.paths, ["plugin/scripts/pull.mjs", "tests/pull.test.mjs"]);
  assert.deepEqual(scan.overlaps, [
    { pr: 31, paths: ["plugin/scripts/pull.mjs"], evidence: ["  plugin/scripts/pull.mjs @@ -0,0 @@ (new file)"] },
    { branch: "feature/x", pr: null, paths: ["tests/pull.test.mjs"], evidence: ["  tests/pull.test.mjs @@ -0,0 @@ (new file)"] },
    { branch: "fix/31", pr: 31, paths: ["plugin/scripts/pull.mjs"], evidence: ["  plugin/scripts/pull.mjs @@ -0,0 @@ (new file)"] },
  ]);
  assert.deepEqual(scan.lineRefs, []);
  assert.deepEqual(scan.unread, []);
  assert.match(scan.at, NOW);
});

test("Q3 `paths <p>…` adds paths, scans again and asks again: the intersection widens, and pull.json keeps both scans", () => {
  const f = scanFixture();
  toCollision(f);
  const r = f.answer(12, "collision", "paths", "plugin/scripts/other.mjs", "docs/notes.md");
  assert.equal(r.status, 10, r.stdout + r.err);
  assert.deepEqual(collisionLines(r.stdout), [
    "paths scanned: plugin/scripts/pull.mjs tests/pull.test.mjs plugin/scripts/other.mjs docs/notes.md",
    "PR #7: plugin/scripts/other.mjs",
    "  plugin/scripts/other.mjs @@ -0,0 @@ (new file)",
    "PR #31: plugin/scripts/pull.mjs",
    "  plugin/scripts/pull.mjs @@ -0,0 @@ (new file)",
    "branch feature/x: tests/pull.test.mjs docs/notes.md",
    "  docs/notes.md @@ -0,0 @@ (new file)",
    "  tests/pull.test.mjs @@ -0,0 @@ (new file)",
    "branch fix/31 (PR #31): plugin/scripts/pull.mjs",
    "  plugin/scripts/pull.mjs @@ -0,0 @@ (new file)",
    "behind-issue candidates (Out of scope): (none)",
  ]);
  const again = f.answer(12, "collision", "paths", "docs/notes.md", "README");
  assert.equal(again.status, 10, again.stdout + again.err);
  assert.equal(collisionLines(again.stdout)[0], "paths scanned: plugin/scripts/pull.mjs tests/pull.test.mjs plugin/scripts/other.mjs docs/notes.md README", "a path given twice is scanned once");
  assert.deepEqual(collisionLines(again.stdout).slice(3, 6), [
    "PR #31: plugin/scripts/pull.mjs README",
    "  plugin/scripts/pull.mjs @@ -0,0 @@ (new file)",
    "  README: no hunk in the diff",
  ], "a file the name-only listing shares but the full diff holds no hunk for says so");
  const st = f.state();
  assert.equal(st.scans.length, 3);
  assert.deepEqual(st.scans[1].overlaps[0], { pr: 7, paths: ["plugin/scripts/other.mjs"], evidence: ["  plugin/scripts/other.mjs @@ -0,0 @@ (new file)"] });
  assert.deepEqual(st.answers.filter((a) => a.qid === "collision").map((a) => [a.token, a.text]), [["paths", "plugin/scripts/other.mjs docs/notes.md"], ["paths", "docs/notes.md README"]]);
  assert.equal(st.questions.filter((q) => q.qid === "collision").length, 3, "each scan asks again");
  assert.equal(f.answer(12, "collision", "clear").status, 0, "and the question still takes an answer that ends it");
});

test("Q3 with nothing shared prints `no overlap`", () => {
  const f = scanFixture({ issue: { ...ISSUE, body: "## What to build\n\nChange `plugin/scripts/unrelated.mjs`.\n" } });
  const r = toCollision(f);
  assert.deepEqual(collisionLines(r.stdout), [
    "paths scanned: plugin/scripts/unrelated.mjs",
    "no overlap",
    "behind-issue candidates (Out of scope): (none)",
  ]);
  assert.deepEqual(f.state().scans[0].overlaps, []);
});

test("Q3: a `gh pr diff` that fails is `could not look`, the question still arrives, and behind-pr on that PR is taken", () => {
  const f = scanFixture({ failing: true });
  const r = toCollision(f);
  const lines = collisionLines(r.stdout);
  assert.ok(lines.includes("could not look: gh pr diff 7 (exit 1: boom)"), lines.join("\n"));
  assert.ok(lines.includes("PR #31: plugin/scripts/pull.mjs"), "the PRs it could read are still scanned");
  assert.deepEqual(f.state().scans[0].unread, ["gh pr diff 7 (exit 1: boom)"]);
  const end = f.answer(12, "collision", "behind-pr:#7");
  assert.equal(end.status, 1, end.stdout + end.err);
  assert.deepEqual(f.ledgerRows(), ["#12 excluded · behind-pr:#7"]);
});

test("Q3: a `gh pr diff` that prints no file is `could not look`, never `no overlap`", () => {
  const f = scanFixture();
  f.ghRules([
    { match: "^pr list ", out: JSON.stringify([{ number: 7, headRefName: "feat/7" }]) },
    { match: "^pr diff 7 --name-only$", out: "" },
  ]);
  const lines = collisionLines(toCollision(f).stdout);
  assert.ok(lines.includes("could not look: gh pr diff 7 (printed no file)"), lines.join("\n"));
});

test("Q3: a branch git cannot diff against origin/main is `could not look`, and the question still arrives", () => {
  const f = fixture();
  const wt = join(f.dir, "lone");
  git(f.repo, "worktree", "add", "-q", "--detach", wt);
  git(wt, "checkout", "-q", "--orphan", "lone");
  writeFileSync(join(wt, "x.md"), "x\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "lone");
  const r = toCollision(f);
  const lines = collisionLines(r.stdout);
  assert.ok(lines.some((l) => l.startsWith("could not look: git diff --name-only origin/main...lone (exit 128")), lines.join("\n"));
  assert.ok(lines.includes("no overlap"));
});

test("Q3: a worktree list git cannot give is exit 2 and the Pull stays at the collision stage", () => {
  const f = fixture();
  f.next("--head", "12");
  f.answer(12, "staleness", "done");
  // A `git` ahead of the real one on PATH that refuses the listing and passes every other command through.
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const gitBin = join(f.dir, "git-bin");
  mkdirSync(gitBin);
  writeExecStub(join(gitBin, "git"), `#!/bin/sh\nif [ "$1" = worktree ] && [ "$2" = list ]; then echo "fatal: boom" >&2; exit 128; fi\nexec ${JSON.stringify(real)} "$@"\n`);
  const r = f.run(["answer", "12", "decided", "decided"], { env: { PATH: `${gitBin}:${f.env().PATH}` } });
  assert.equal(r.status, 2, r.stdout + r.err);
  assert.match(r.err, /git worktree list failed \(exit 128\)\nfatal: boom/);
  assert.equal(f.state().stage, "collision");
  assert.deepEqual(f.state().scans, []);
});

test("Q3 prints the `#N` refs of the Out of scope section as behind-issue candidates, and no ref from anywhere else", () => {
  const body = [
    "## What to build", "", "Change `plugin/scripts/pull.mjs`, after #6.", "",
    "## Out of scope", "", "- Hunk-level overlap (#5). Then #44, and #5 again.", "- feigi/other#9 lives elsewhere; #12abc is no ref.", "",
    "## Blocked by", "", "- #1", "",
  ].join("\n");
  const f = fixture({ issue: { ...ISSUE, body } });
  const lines = collisionLines(toCollision(f).stdout);
  assert.equal(lines.at(-1), "behind-issue candidates (Out of scope): #5 #44");

  const g = fixture({ issue: { ...ISSUE, body: "## What to build\n\nChange `a.mjs` after #6.\n" } });
  assert.equal(collisionLines(toCollision(g).stdout).at(-1), "behind-issue candidates (Out of scope): (none)", "no Out of scope section, no candidate");
});

test("Q3: the scan is printed again, unchanged, when the pending question is resumed", () => {
  const f = scanFixture();
  const first = collisionLines(toCollision(f).stdout);
  const again = f.next("--head", "12");
  assert.equal(again.status, 10);
  assert.deepEqual(collisionLines(again.stdout), first);
  assert.equal(f.state().scans.length, 1, "resuming scans nothing");
});

test("Q3: a path the brief spells as a bare name or as a directory matches the changed files under it", () => {
  const f = scanFixture({ issue: { ...ISSUE, body: "## What to build\n\nChange `pull.mjs` under `plugin/scripts/`, and `docs/`.\n" } });
  const lines = collisionLines(toCollision(f).stdout);
  assert.deepEqual(lines, [
    "paths scanned: pull.mjs plugin/scripts/ docs/",
    "PR #7: plugin/scripts/",
    "  plugin/scripts/other.mjs @@ -0,0 @@ (new file)",
    "PR #31: pull.mjs plugin/scripts/",
    "  plugin/scripts/pull.mjs @@ -0,0 @@ (new file)",
    "branch feature/x: docs/",
    "  docs/notes.md @@ -0,0 @@ (new file)",
    "branch fix/31 (PR #31): pull.mjs plugin/scripts/",
    "  plugin/scripts/pull.mjs @@ -0,0 @@ (new file)",
    "behind-issue candidates (Out of scope): (none)",
  ]);
  // A directory is a whole path segment, not a prefix of a name: `plugin/script` names no directory here.
  const again = collisionLines(f.answer(12, "collision", "paths", "plugin/script", "ugin").stdout);
  assert.deepEqual(again.slice(1, -1), lines.slice(1, -1));
  assert.equal(again[0], `${lines[0]} plugin/script ugin`);
});

test("Q3: a branch that changes a non-ASCII path is scanned by the path's own name", () => {
  const f = fixture({ issue: { ...ISSUE, body: "## What to build\n\nChange `docs/é.md`.\n" } });
  git(f.repo, "config", "core.quotePath", "true");
  const wt = join(f.dir, "uni");
  git(f.repo, "worktree", "add", "-q", "-b", "uni", wt);
  mkdirSync(join(wt, "docs"));
  writeFileSync(join(wt, "docs", "é.md"), "x\n");
  git(wt, "add", ".");
  git(wt, "commit", "-q", "-m", "uni");
  const lines = collisionLines(toCollision(f).stdout);
  assert.deepEqual(lines, ["paths scanned: docs/é.md", "branch uni: docs/é.md", "  docs/é.md @@ -0,0 @@ (new file)", "behind-issue candidates (Out of scope): (none)"], "the full diff's quoted name is read as the file's own");
});

test("Q3 skips a worktree branch whose upstream is gone and scans one whose upstream stands", () => {
  const f = fixture();
  const pushed = (name) => {
    const wt = join(f.dir, name);
    git(f.repo, "worktree", "add", "-q", "-b", name, wt);
    mkdirSync(join(wt, "plugin", "scripts"), { recursive: true });
    writeFileSync(join(wt, "plugin", "scripts", "pull.mjs"), `${name}\n`);
    git(wt, "add", ".");
    git(wt, "commit", "-q", "-m", name);
    git(wt, "push", "-q", "-u", "origin", name);
  };
  pushed("merged/9");
  pushed("live/1");
  git(f.repo, "push", "-q", "origin", "--delete", "merged/9");
  git(f.repo, "fetch", "-q", "--prune");
  const lines = collisionLines(toCollision(f).stdout);
  assert.deepEqual(lines, [
    "paths scanned: plugin/scripts/pull.mjs tests/pull.test.mjs",
    "branch live/1: plugin/scripts/pull.mjs",
    "  plugin/scripts/pull.mjs @@ -0,0 @@ (new file)",
    "behind-issue candidates (Out of scope): (none)",
  ]);
});

test("Q3: a path the brief names only in its Out of scope section is not scanned", () => {
  const f = scanFixture({ issue: { ...ISSUE, body: "## What to build\n\nChange `docs/notes.md`.\n\n## Out of scope\n\n- `plugin/scripts/pull.mjs` and `tests/pull.test.mjs`.\n" } });
  assert.deepEqual(collisionLines(toCollision(f).stdout), [
    "paths scanned: docs/notes.md",
    "branch feature/x: docs/notes.md",
    "  docs/notes.md @@ -0,0 @@ (new file)",
    "behind-issue candidates (Out of scope): (none)",
  ]);
  assert.deepEqual(ghCalls(f, /^pr diff \d+$/), [], "no PR's full diff is read");
  const g = scanFixture({ issue: { ...ISSUE, body: "## What to build\n\nChange the scan.\n\n## Out of scope\n\n- `plugin/scripts/pull.mjs`\n" } });
  assert.deepEqual(collisionLines(toCollision(g).stdout), ["paths scanned: (none)", "no overlap", "behind-issue candidates (Out of scope): (none)"]);
});

// The shape the scan was ruled on: tickets editing one heavily shared Markdown
// file in far-apart sections. SKILL_MD holds sections A to E, 30 lines each
// (headings at lines 3, 34, 65, 96, 127). PR #40, its head pushed as origin's
// `pull/40/head` and no worktree of its own, edits line 106 in D unless told
// otherwise; `fix/41`, #41's head and a live worktree, edits line 147 in E
// unless told otherwise, and origin has no `pull/41/head`. origin/main has
// since gained 40 lines at the top (headings now at 43, 74, 105, 136, 167), so
// a hunk finds its heading only in the file at the merge-base.
const SKILL_MD = "plugin/skills/run-team/SKILL.md";
function incidentFixture(body, { pr = 106, branch = 147 } = {}) {
  const f = fixture({ issue: { ...ISSUE, body } });
  const lines = ["# Run team", ""];
  for (const s of ["A", "B", "C", "D", "E"]) lines.push(`## ${s}`, ...Array.from({ length: 30 }, (_, i) => `${s.toLowerCase()}${i + 1}`));
  const write = (dir, text) => {
    mkdirSync(join(dir, SKILL_MD, ".."), { recursive: true });
    writeFileSync(join(dir, SKILL_MD), `${text.join("\n")}\n`);
  };
  const commit = (dir, msg) => {
    git(dir, "add", SKILL_MD);
    git(dir, "commit", "-q", "-m", msg);
  };
  write(f.repo, lines);
  commit(f.repo, "skill");
  git(f.repo, "push", "-q", "origin", "main");
  const edit = (name, line) => {
    const wt = join(f.dir, name.replace("/", "-"));
    git(f.repo, "worktree", "add", "-q", "-b", name, wt);
    write(wt, lines.map((l, i) => (i + 1 === line ? `${l} edited` : l)));
    commit(wt, name);
    return wt;
  };
  git(f.repo, "worktree", "remove", "--force", edit("feat/40", pr));
  git(f.repo, "push", "-q", "origin", "feat/40:refs/pull/40/head");
  edit("fix/41", branch);
  write(f.repo, [lines[0], ...Array.from({ length: 40 }, (_, i) => `x${i + 1}`), ...lines.slice(1)]);
  commit(f.repo, "main moves on");
  git(f.repo, "push", "-q", "origin", "main");
  const diff = (b) => `${git(f.repo, "diff", "--src-prefix=a/", "--dst-prefix=b/", `origin/main...${b}`)}\n`;
  f.ghRules([
    { match: "^pr list ", out: JSON.stringify([{ number: 40, headRefName: "feat/40" }, { number: 41, headRefName: "fix/41" }]) },
    { match: "^pr diff 40 --name-only$", out: `${SKILL_MD}\n` },
    { match: "^pr diff 40$", out: diff("feat/40") },
    { match: "^pr diff 41 --name-only$", out: `${SKILL_MD}\n` },
    { match: "^pr diff 41$", out: diff("fix/41") },
  ]);
  return f;
}

// The `base not read` line, its git error text left out.
const baseNotRead = (lines) => lines.map((l) => l.replace(/: base not read \((git fetch origin pull\/\d+\/head): .*\)$/, ": base not read ($1: …)"));

test("Q3 on one shared Markdown file edited in far-apart sections: every hunk and the brief's line reference print their headings, and they share none", () => {
  const f = incidentFixture("## What to build\n\nRewrite the step at `run-team/SKILL.md:80`.\n\n## Out of scope\n\n- Anything else under `plugin/`.\n");
  const lines = baseNotRead(collisionLines(toCollision(f).stdout));
  assert.deepEqual(lines, [
    "paths scanned: run-team/SKILL.md:80",
    "PR #40: run-team/SKILL.md:80",
    `  ${SKILL_MD} @@ -103,7 @@ ## D`,
    "PR #41: run-team/SKILL.md:80",
    `  ${SKILL_MD}: base not read (git fetch origin pull/41/head: …)`,
    `  ${SKILL_MD} @@ -144,7 @@`,
    "branch fix/41 (PR #41): run-team/SKILL.md:80",
    `  ${SKILL_MD} @@ -144,7 @@ ## E`,
    `brief ref run-team/SKILL.md:80 (${SKILL_MD} on origin/main): ## B`,
    "behind-issue candidates (Out of scope): (none)",
  ]);
  const git_ = f.state().commands.filter((c) => c.cmd[0] === "git" && ["fetch", "cat-file"].includes(c.cmd[1])).map((c) => c.cmd.slice(1));
  assert.deepEqual(git_.filter((c) => c[0] === "fetch"), [["fetch", "-q", "origin", "pull/40/head"], ["fetch", "-q", "origin", "pull/41/head"]], "a PR's head is fetched for its base");
  assert.equal(git_.filter((c) => c[0] === "cat-file").at(-1)[2], `origin/main:${SKILL_MD}`, "the brief's reference is read on origin/main");
  const end = f.answer(12, "collision", "clear");
  assert.equal(end.status, 0, end.stdout + end.err);
  assert.deepEqual(f.ledgerRows().filter((r) => /#4[01]|fix\/41/.test(r)), [], "the admitted ticket's row names no overlap partner");
});

test("Q3: a brief line reference inside a colliding hunk's section prints that section beside the hunk's, and behind-pr takes it", () => {
  const f = incidentFixture("## What to build\n\nRewrite the step at `run-team/SKILL.md:80`.\n");
  toCollision(f);
  const r = f.answer(12, "collision", "paths", `${SKILL_MD}:140-141`);
  assert.equal(r.status, 10, r.stdout + r.err);
  const lines = collisionLines(r.stdout);
  assert.ok(lines.includes(`  ${SKILL_MD} @@ -103,7 @@ ## D`), lines.join("\n"));
  assert.deepEqual(lines.filter((l) => l.startsWith("brief ref ")), [
    `brief ref run-team/SKILL.md:80 (${SKILL_MD} on origin/main): ## B`,
    `brief ref ${SKILL_MD}:140-141 (${SKILL_MD} on origin/main): ## D`,
  ]);
  const end = f.answer(12, "collision", "behind-pr:#40");
  assert.equal(end.status, 1, end.stdout + end.err);
  assert.deepEqual(f.ledgerRows(), ["#12 excluded · behind-pr:#40"]);
});

test("Q3: a hunk's headings are the ones its changed lines sit under, never those its context lines cross", () => {
  // Line 126 is D's last and 128 E's first: each hunk's 3 lines of context
  // reach across the `## E` heading at 127, and its change does not.
  const f = incidentFixture("## What to build\n\nRewrite the step at `run-team/SKILL.md:80`.\n", { pr: 126, branch: 128 });
  const lines = collisionLines(toCollision(f).stdout);
  assert.deepEqual(lines.filter((l) => l.includes(" @@ ")), [
    `  ${SKILL_MD} @@ -123,7 @@ ## D`,
    `  ${SKILL_MD} @@ -125,7 @@`,
    `  ${SKILL_MD} @@ -125,7 @@ ## E`,
  ], lines.join("\n"));
});

test("Q3: a pull.json from before the scan resumes and scans, unless a collision question stands on it", () => {
  const old = (f, patch) => {
    const st = f.state();
    delete st.scans;
    delete st.addedPaths;
    writeFileSync(f.statePath(), `${JSON.stringify({ ...st, openPrs: [7, 31], ...patch }, null, 2)}\n`);
  };
  const f = fixture();
  toCollision(f);
  old(f, { pending: null });
  const r = f.next("--head", "12");
  assert.equal(r.status, 10, r.stdout + r.err);
  assert.deepEqual(collisionLines(r.stdout), ["paths scanned: plugin/scripts/pull.mjs tests/pull.test.mjs", "no overlap", "behind-issue candidates (Out of scope): (none)"]);
  assert.equal(f.state().scans.length, 1);

  const g = fixture();
  toCollision(g);
  old(g, {});
  for (const r2 of [g.next("--head", "12"), g.answer(12, "collision", "paths", "x.md")]) {
    assert.equal(r2.status, 2, r2.stdout + r2.err);
    assert.match(r2.err, /pull\.json holds a collision question that no scan of this script asked — move it aside and run again/);
  }

  const h = fixture();
  toCollision(h);
  writeFileSync(h.statePath(), `${JSON.stringify({ ...h.state(), scans: "x" }, null, 2)}\n`);
  const bad = h.next("--head", "12");
  assert.equal(bad.status, 2, bad.stdout + bad.err);
  assert.match(bad.err, /pull\.json is not a Pull record — move it aside and run again/);
});

test("Q3 `paths <p>…` naming a path the brief already names scans it once", () => {
  const f = scanFixture();
  toCollision(f);
  const r = f.answer(12, "collision", "paths", "plugin/scripts/pull.mjs");
  assert.equal(r.status, 10, r.stdout + r.err);
  assert.equal(collisionLines(r.stdout)[0], "paths scanned: plugin/scripts/pull.mjs tests/pull.test.mjs");
  assert.deepEqual(f.state().scans[1].paths, ["plugin/scripts/pull.mjs", "tests/pull.test.mjs"]);
});

test("Q3 behind-pr / behind-issue: the exclusion is a ledger row, exit 1, nothing claimed", () => {
  for (const token of ["behind-pr:#31", "behind-issue:#9"]) {
    const f = fixture();
    toCollision(f);
    const r = f.answer(12, "collision", token);
    assert.equal(r.status, 1, r.stdout + r.err);
    assert.match(r.stdout, new RegExp(`^LEFT #12: excluded · ${token} — next entry$`, "m"));
    assert.deepEqual(f.ledgerRows(), [`#12 excluded · ${token}`]);
    assert.equal(f.calls("claim-ticket").length, 0);
  }
});

test("Q3: a behind-pr naming a branch is taken, behind-issue needs a number, `#` is optional, anything else exits 3", () => {
  assert.equal(parseAnswer("collision", "behind-pr:feature/x", []).token, "behind-pr:#feature/x");
  assert.equal(parseAnswer("collision", "behind-issue:9", []).token, "behind-issue:#9");
  for (const t of ["behind-issue:#abc", "behind-pr:", "behind-pr:#-x", "behind", "clear:"]) {
    assert.throws(() => parseAnswer("collision", t, []), /the tokens collision takes/, t);
  }
  assert.throws(() => parseAnswer("collision", "clear", ["text"]), /takes no text/);
  assert.deepEqual(parseAnswer("collision", "paths", ["a/b.mjs", "c.md"]), { token: "paths", text: "a/b.mjs c.md", path: null });
  assert.throws(() => parseAnswer("collision", "paths", []), /paths needs text/);
  assert.throws(() => parseAnswer("collision", "paths", ["--path", "a"]), /paths takes no --path/);
});

test("--chain-head reaches the router exactly when another ticket's ledger row sequences behind this one", () => {
  const f = fixture();
  f.ledgerRow(40, "excluded · behind-issue:#12");
  toCollision(f);
  f.answer(12, "collision", "clear");
  assert.equal(f.calls("ticket-router")[0].args.includes("--chain-head"), true);

  const g = fixture();
  g.ledgerRow(40, "excluded · behind-issue:#120");
  g.ledgerRow(41, "excluded · behind-pr:#12");
  toCollision(g);
  g.answer(12, "collision", "clear");
  assert.equal(g.calls("ticket-router")[0].args.includes("--chain-head"), false, "#120 and a behind-pr:#12 are not behind issue 12");
});

test("chainHead and implRow read the ledger's own grammar", () => {
  assert.equal(chainHead(["#40 excluded · behind-issue:#12"], 12), true);
  assert.equal(chainHead(["#40 excluded · behind-issue:#12"], 4), false);
  assert.equal(chainHead(["#40 impl-40 · behind-issue:#12"], 12), false, "only an excluded row is an exclusion");
  const impl = (n, tier = "") => `#${n} impl-${n}${tier === "" ? "" : ` · tier=${tier}`}`;
  assert.equal(implRow([]), 1);
  assert.equal(implRow(["#3 excluded · behind-pr:#9", "#4 PR#8 · inherited"]), 1, "only impl rows count");
  assert.equal(implRow([1, 2, 3, 4].map((n) => impl(n))), 5);
  assert.equal(implRow([1, 2, 3, 4, 5].map((n) => impl(n, n === 5 ? "task-max" : ""))), 6, "row 5 explored: the next Pull counts on");
  assert.equal(implRow([1, 2, 3, 4, 5].map((n) => impl(n))), 5, "row 5 carries no tier=: the assignment is rolling, and is row 5's");
  assert.equal(implRow([1, 2, 3, 4, 5, 6, 7].map((n) => impl(n))), 5, "and stays on row 5 while every row after it carries none");
  assert.equal(implRow([1, 2, 3, 4, 5, 6].map((n) => impl(n, n === 6 ? "task-max" : ""))), 7, "a tier= after row 5 ends the rolling");
  assert.equal(implRow([1, 2, 3, 4].map((n) => impl(n, "task-max"))), 5, "below row 5 there is nothing to roll");
});

test("--impl-row is read off the ledger", () => {
  const f = fixture();
  for (const n of [1, 2, 3, 4]) f.ledgerRow(n, `impl-${n}`);
  toCollision(f);
  f.answer(12, "collision", "clear");
  const args = f.calls("ticket-router")[0].args;
  assert.equal(args[args.indexOf("--impl-row") + 1], "5");
});

// ── steps 6 and 7: claim, route ──────────────────────────────────────────────

test("claim-ticket.sh exit 2 is taken, exit 1; any other failure is exit 2; neither routes", () => {
  const f = fixture();
  toCollision(f);
  f.control("claim-ticket", { exit: 2 });
  const r = f.answer(12, "collision", "clear");
  assert.equal(r.status, 1, r.stdout + r.err);
  assert.match(r.stdout, /^LEFT #12: taken \(claim-ticket\.sh refused the claim\) — next entry$/m);
  assert.equal(f.calls("ticket-router").length, 0);

  const g = fixture();
  toCollision(g);
  g.control("claim-ticket", { exit: 5, err: "claim: odd" });
  const bad = g.answer(12, "collision", "clear");
  assert.equal(bad.status, 2, bad.stdout + bad.err);
  assert.match(bad.err, /claim-ticket\.sh could not claim \(exit 5\)\nclaim: odd/);
  assert.equal(g.calls("ticket-router").length, 0);
});

test("a claim refused at exit 2 says why: the child's own words are in the reason and in the record", () => {
  const f = fixture();
  toCollision(f);
  f.control("claim-ticket", { exit: 2, err: "claim-ticket: the Install step did not run in the worktree (exit 1)" });
  const r = f.answer(12, "collision", "clear");
  assert.equal(r.status, 1, r.stdout + r.err);
  assert.match(r.stdout, /^LEFT #12: taken \(claim-ticket\.sh refused the claim: claim-ticket: the Install step did not run in the worktree \(exit 1\)\) — next entry$/m);
  assert.equal(f.state().outcome.reason.includes("the Install step did not run"), true);
});

test("a Pull with no phase-0 session claims nothing and exits 2", () => {
  const f = fixture();
  writeFileSync(join(f.fleet, "phase0.json"), JSON.stringify({ run: null, session: "", steps: { branch: { status: "ok" } } }));
  toCollision(f);
  const r = f.answer(12, "collision", "clear");
  assert.equal(r.status, 2, r.stdout + r.err);
  assert.match(r.err, /no session given and none in the phase-0 receipt/);
  assert.equal(f.calls("claim-ticket").length, 0);
});

test("an odd ticket routes as arm B", () => {
  const f = fixture({ shortlist: [13] });
  f.next("--head", "13");
  f.answer(13, "staleness", "done");
  f.answer(13, "decided", "decided");
  f.answer(13, "collision", "clear");
  const args = f.calls("ticket-router")[0].args;
  assert.equal(args[args.indexOf("--arm") + 1], "B");
});

test("router exit 2 releases the claim, exits 2 with the router's line, writes no row and dispatches nothing", () => {
  const f = fixture();
  toCollision(f);
  f.control("ticket-router", { exit: 2, err: "ticket-router: router table unreadable" });
  const r = f.answer(12, "collision", "clear");
  assert.equal(r.status, 2, r.stdout + r.err);
  assert.match(r.err, /ticket-router\.mjs refused \(exit 2\)\nticket-router: router table unreadable\nits claim is released/);
  assert.deepEqual(f.calls("release-ticket")[0].args, ["12", "impl-12", "implementer", "--apply"]);
  assert.deepEqual(f.order().slice(-3), ["claim-ticket", "ticket-router", "release-ticket"]);
  assert.equal(f.calls("dispatch-prompt").length, 0);
  assert.equal(f.ledgerRows().length, 0, "no row");
  assert.equal(f.state().status, "released");
  // Asked for again, the Pull starts over and claims again.
  f.control("ticket-router", {});
  f.control("ticket-router", { out: ROUTE_OK });
  const again = f.next("--head", "12");
  assert.equal(again.status, 10);
  assert.match(again.stdout, /^PULL #12: started/m);
});

test("router exit 2 whose claim cannot be released says the claim is STILL standing, and the Pull stays to route again", () => {
  const f = fixture();
  toCollision(f);
  f.control("ticket-router", { exit: 2, err: "ticket-router: no table" });
  f.control("release-ticket", { exit: 2, err: "release: carries commits" });
  const r = f.answer(12, "collision", "clear");
  assert.equal(r.status, 2);
  assert.match(r.err, /its claim is STILL STANDING: release-ticket\.sh failed \(exit 2\)\nrelease: carries commits/);
  assert.equal(f.state().status, "running", "the claim stands, so the Pull is not over");
  assert.equal(f.state().stage, "route");

  // Not skipped as an ended Pull: the next entry is this ticket, resumed at the step that failed.
  f.control("ticket-router", { out: ROUTE_OK });
  f.control("release-ticket", {});
  const again = f.next();
  assert.equal(again.status, 0, again.stdout + again.err);
  assert.match(again.stdout, /^PULL #12: resumed at /m, "the Pull is resumed, not started over");
  assert.equal(f.calls("ticket-router").length, 2, "the router is asked again");
  assert.equal(f.calls("claim-ticket").length, 1, "the claim is not made twice");
  assert.equal(f.state().status, "dispatched");
});

test("a router that prints no routing line is a refusal and releases the claim", () => {
  const f = fixture();
  toCollision(f);
  f.control("ticket-router", { out: "something else" });
  const r = f.answer(12, "collision", "clear");
  assert.equal(r.status, 2);
  assert.match(r.err, /ticket-router\.mjs printed no routing line: something else/);
  assert.equal(f.calls("release-ticket").length, 1);
  assert.equal(f.ledgerRows().length, 0);
});

test("the row carries tier=<CELL> exactly when DRAW is not `-`, and route=<REASON> exactly when REASON is not ok", () => {
  const cases = [
    [ROUTE_OK, ["#12 impl-12", "fleet-implementer-slow-high"]],
    ["POLICY=slow-high CELL=task-high DRAW=2/5 STRATUM=heavy REASON=ok", ["#12 impl-12 · tier=task-high", "fleet-implementer-task-high"]],
    ["POLICY=slow-high CELL=slow-high DRAW=- STRATUM=unknown REASON=guard-missing", ["#12 impl-12 · route=guard-missing", "fleet-implementer-slow-high"]],
    ["POLICY=slow-high CELL=smol-high DRAW=1/3 STRATUM=light REASON=table-cell-tripped", ["#12 impl-12 · tier=smol-high · route=table-cell-tripped", "fleet-implementer-smol-high"]],
  ];
  for (const [line, [row, agent]] of cases) {
    const f = fixture();
    f.control("ticket-router", { out: `${line}\n` });
    toCollision(f);
    const r = f.answer(12, "collision", "clear");
    assert.equal(r.status, 0, r.stdout + r.err);
    assert.equal(f.ledgerRows().find((l) => l.startsWith("#12 ")).replace(/ · impl-12$/, ""), row, line);
    assert.equal(JSON.parse(r.out.find((l) => l.startsWith("DISPATCH ")).slice(9)).agent, agent, "the agent comes off the row's tier");
  }
});

test("a render that dispatch-prompt refuses exits 2, names it, leaves the claim and the row, and retries at the render", () => {
  const f = fixture();
  toCollision(f);
  f.control("dispatch-prompt", { exit: 2, err: "dispatch-prompt: the rendered brief still carries <N>" });
  const r = f.answer(12, "collision", "clear");
  assert.equal(r.status, 2, r.stdout + r.err);
  assert.match(r.err, /dispatch-prompt\.mjs render refused \(exit 2\) — the claim stands\ndispatch-prompt: the rendered brief still carries <N>/);
  assert.equal(f.calls("release-ticket").length, 0);
  assert.deepEqual(f.ledgerRows(), ["#12 impl-12"]);
  assert.equal(f.state().stage, "render");
  f.control("dispatch-prompt", {});
  assert.equal(f.next("--head", "12").status, 0);
  assert.equal(f.calls("claim-ticket").length, 1, "the claim was made once");
  assert.equal(f.calls("ticket-router").length, 1, "and the route was read once");
});

test("a dispatch the ledger refuses (no rendered brief) exits 2 and is not printed as DISPATCH", () => {
  const f = fixture();
  toCollision(f);
  // The render stub succeeds without leaving the brief the ledger demands.
  f.control("dispatch-prompt", { exit: 0, out: "" });
  writeFileSync(join(SCRIPTS, "stub-driver.mjs"), DRIVER.replace('if (name === "dispatch-prompt" && !c.exit)', 'if (false)'));
  try {
    const r = f.answer(12, "collision", "clear");
    assert.equal(r.status, 2, r.stdout + r.err);
    assert.match(r.err, /ledger\.mjs dispatch refused \(exit 2\) — the claim stands\n[^]*no rendered brief for impl-12/);
    assert.equal(r.stdout.includes("DISPATCH"), false);
  } finally {
    writeFileSync(join(SCRIPTS, "stub-driver.mjs"), DRIVER);
  }
});

// ── the record, and resuming from it ─────────────────────────────────────────

test("pull.json records every command, question and answer with a time, in the order they happened", () => {
  const f = fixture();
  f.control("staleness", { exit: 0, out: '{"verdict":"live"}' });
  f.next("--head", "12");
  f.answer(12, "staleness", "gone", "--path", "p.mjs", "old");
  f.answer(12, "staleness", "done");
  f.answer(12, "decided", "decided");
  f.answer(12, "collision", "clear");
  const st = f.state();
  assert.equal(st.ticket, 12);
  assert.equal(st.member, "impl-12");
  assert.match(st.started, NOW);
  assert.deepEqual(st.commands.map((c) => [c.step, c.cmd[0], c.exit]), [
    ["inflight", "inflight.sh", 0],
    ["issue", "gh", 0],
    ["staleness", "staleness.mjs", 0],
    ["collision", "gh", 0],
    ["collision", "git", 0],
    ["collision", "git", 0],
    ["claim", "claim-ticket.sh", 0],
    ["ledger", "ledger.mjs", 0],
    ["route", "ticket-router.mjs", 0],
    ["row", "ledger.mjs", 0],
    ["render", "dispatch-prompt.mjs", 0],
    ["dispatch", "ledger.mjs", 0],
  ]);
  assert.deepEqual(st.commands[0].cmd, ["inflight.sh", "12"]);
  assert.deepEqual(st.commands[1].cmd, ["gh", "issue", "view", "12", "--json", "title,body,comments,labels,createdAt"]);
  assert.match(st.commands[1].stdout, /^\d+ bytes, written to .*issue\.json$/, "the issue is on disk, not in the record");
  assert.equal(st.commands[2].stdout, '{"verdict":"live"}');
  assert.deepEqual(st.commands[4].cmd, ["git", "worktree", "list", "--porcelain", "-z"]);
  assert.deepEqual(st.commands[5].cmd, ["git", "for-each-ref", "--format=%(refname:short)%09%(upstream:track)", "refs/heads"]);
  assert.deepEqual(st.commands[9].cmd, ["ledger.mjs", "row", "12", "impl-12"]);
  for (const c of st.commands) assert.match(c.at, NOW);
  assert.deepEqual(st.questions.map((q) => q.qid), ["staleness", "staleness", "decided", "collision"], "Q1 asked once by `next` and once more after the probe");
  assert.deepEqual(st.answers.map((a) => [a.qid, a.token, a.text, a.path ?? null, a.applied]), [
    ["staleness", "gone", "old", "p.mjs", true],
    ["staleness", "done", "", null, true],
    ["decided", "decided", "", null, true],
    ["collision", "clear", "", null, true],
  ]);
  for (const x of [...st.questions, ...st.answers]) assert.match(x.at, NOW);
  const times = [...st.commands, ...st.questions, ...st.answers].map((x) => x.at).sort();
  assert.equal(times[0] >= st.started, true);
  assert.equal(st.status, "dispatched");
  assert.deepEqual(st.outcome.exit, 0);
});

test("a command's stdout and arguments are bounded in the record", () => {
  const f = fixture();
  f.control("staleness", { exit: 0, out: "x".repeat(10_000) });
  f.next("--head", "12");
  f.answer(12, "staleness", "gone", "--path", "p.mjs", "n".repeat(9000));
  const c = f.state().commands.find((x) => x.step === "staleness");
  assert.equal(c.stdout.length <= 4000, true);
  assert.equal(c.cmd.every((a) => a.length <= 4000), true);
  assert.equal(c.stdout.startsWith("…"), true, "the tail is kept");
});

test("a process gone between answers resumes at the pending question with every earlier record intact", () => {
  const f = fixture();
  f.next("--head", "12");
  f.answer(12, "staleness", "present", "--path", "p.mjs", "needle");
  f.answer(12, "staleness", "done");
  const before = f.state();
  const orderBefore = f.order();
  // A new process, with no memory of the last: the question is asked again.
  const resumed = f.next("--head", "12");
  assert.equal(resumed.status, 10, resumed.stdout + resumed.err);
  assert.match(resumed.stdout, /^PULL #12: resumed at question decided$/m);
  assert.match(resumed.stdout, /^QUESTION decided:/m);
  assert.match(resumed.stdout, /^TICKET #12: /m, "the ticket is printed again for a controller that lost it");
  assert.deepEqual(f.order(), orderBefore, "no step ran again");
  assert.deepEqual(f.state(), before, "the record is untouched by resuming");
  // The answer lands in a third process, and the Pull finishes.
  assert.equal(f.answer(12, "decided", "decided").status, 10);
  assert.equal(f.answer(12, "collision", "clear").status, 0);
  const st = f.state();
  assert.deepEqual(st.commands.slice(0, before.commands.length), before.commands, "every earlier command is kept as it was");
  assert.deepEqual(st.answers.slice(0, before.answers.length), before.answers);
});

test("a process killed in the middle of a step resumes at that step, with the claim made once", () => {
  const f = fixture();
  toCollision(f);
  f.control("ticket-router", { out: ROUTE_OK, sleep: 20_000 });
  const killed = f.run(["answer", "12", "collision", "clear"], { timeout: 2500 });
  assert.equal(killed.signal, "SIGKILL");
  const st = f.state();
  assert.equal(st.stage, "route", "the claim is on disk, the route is not");
  assert.equal(st.commands.some((c) => c.step === "claim"), true);
  f.control("ticket-router", { out: ROUTE_OK });
  const r = f.next("--head", "12");
  assert.equal(r.status, 0, r.stdout + r.err);
  assert.equal(f.calls("claim-ticket").length, 1);
  assert.equal(f.calls("inflight").length, 1);
});

test("answers that do not fit the pull are usage: exit 3, nothing recorded", () => {
  const f = fixture();
  assert.equal(f.answer(12, "staleness", "done").status, 3, "no Pull in progress");
  f.next("--head", "12");
  const before = JSON.stringify(f.state());
  for (const args of [[12, "decided", "decided"], [12, "nonsense", "x"], [99, "staleness", "done"]]) {
    const r = f.answer(...args);
    assert.equal(r.status, 3, `${args.join(" ")}: ${r.stdout}${r.err}`);
  }
  assert.equal(f.run(["answer", "12", "staleness"]).status, 3);
  assert.equal(f.run(["answer", "twelve", "staleness", "done"]).status, 3);
  assert.equal(JSON.stringify(f.state()), before);
  toCollision(fixture());
  const g = fixture();
  toCollision(g);
  g.answer(12, "collision", "behind-pr:#4");
  assert.equal(g.answer(12, "collision", "clear").status, 3, "a Pull that left takes no more answers");
});

test("a pull.json that cannot be used exits 2 and is not overwritten", () => {
  const f = fixture();
  f.next("--head", "12");
  writeFileSync(f.statePath(12), "{not json");
  const r = f.next("--head", "12");
  assert.equal(r.status, 2, r.stdout + r.err);
  assert.match(r.err, /is not JSON/);
  assert.equal(readFileSync(f.statePath(12), "utf8"), "{not json");
  const a = f.answer(12, "staleness", "done");
  assert.equal(a.status, 2);
});

test("an unexpected failure is exit 2, never the exit 1 that means the ticket left the Pull", () => {
  const f = fixture();
  f.next("--head", "12");
  rmIssue(f);
  const r = f.next("--head", "12");
  assert.equal(r.status, 2, r.stdout + r.err);
  assert.match(r.err, /pull: unexpected: /);
});

function rmIssue(f) {
  writeFileSync(join(f.scratch(), "impl-12", "issue.json"), "gone");
}

// ── usage ────────────────────────────────────────────────────────────────────

test("a bad command line is exit 3 and names the usage", () => {
  const f = fixture();
  for (const args of [[], ["dispatch"], ["next", "extra"], ["next", "--head"], ["next", "--head", "abc"], ["next", "--head", "0"], ["next", "--head", "12", "extra"], ["answer"], ["answer", "12", "staleness"]]) {
    const r = f.run(args);
    assert.equal(r.status, 3, `${args.join(" ")}: ${r.stdout}${r.err}`);
    assert.match(r.err, /usage: pull\.mjs next/);
  }
});

test("run from a linked worktree it refuses with exit 3: the checks judge the main checkout", () => {
  const f = fixture();
  const wt = join(f.dir, "linked");
  git(f.repo, "worktree", "add", "-q", wt, "-b", "linked");
  const r = f.run(["next", "--head", "12"], { cwd: wt });
  assert.equal(r.status, 3, r.stdout + r.err);
  assert.match(r.err, /run this from the main checkout/);
  assert.deepEqual(f.order(), []);
});

test("an ambient GIT_DIR or GH_REPO naming another repository does not change what any step reads or runs", () => {
  const { f, sha } = fixedFixture();
  const other = join(f.dir, "other");
  git(f.dir, "init", "-q", "-b", "main", other);
  const env = { GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other, GH_REPO: "someone/else" };
  const asked = f.run(["answer", "12", "staleness", "gone", "--path", "p.mjs", "old wording"], { env });
  assert.equal(asked.status, 10, asked.stdout + asked.err);
  assert.match(asked.stdout, /subject: the real subject of the fix$/m, "the subject is read from this repository, not the ambient one");
  assert.equal(asked.stdout.includes(sha), true);
  const closed = f.run(["answer", "12", "close", "yes"], { env });
  assert.equal(closed.status, 1, closed.stdout + closed.err);
  for (const c of f.calls("gh")) assert.equal(c.GH_REPO, "", `gh ${c.args.join(" ")} was given an ambient GH_REPO`);
  assert.equal(f.state().commands.filter((c) => c.step !== "staleness").every((c) => c.exit === 0), true, "the probe's exit 1 is the fixture's own");

  const g = fixture();
  const ran = g.run(["next", "--head", "12"], { env });
  assert.equal(ran.status, 10, "the main-checkout check is not answered for the ambient repository: " + ran.stdout + ran.err);

  const h = scanFixture();
  assert.equal(h.run(["next", "--head", "12"], { env }).status, 10);
  assert.equal(h.run(["answer", "12", "staleness", "done"], { env }).status, 10);
  const scanned = h.run(["answer", "12", "decided", "decided"], { env });
  assert.equal(scanned.status, 10, scanned.stdout + scanned.err);
  assert.ok(collisionLines(scanned.stdout).includes("branch feature/x: tests/pull.test.mjs"), "the scan lists and diffs this repository's worktrees, not the ambient one's");
});

test("an ambient GH_REPO does not reach the steps the Pull runs as scripts either", () => {
  const env = { GH_REPO: "someone/else" };
  const step = (f, ...args) => f.run(args, { env });
  const f = fixture();
  assert.equal(step(f, "next", "--head", "12").status, 10);
  assert.equal(step(f, "answer", "12", "staleness", "done").status, 10);
  assert.equal(step(f, "answer", "12", "decided", "decided").status, 10);
  const end = step(f, "answer", "12", "collision", "clear");
  assert.equal(end.status, 0, end.stdout + end.err);
  for (const name of ["inflight", "claim-ticket", "ticket-router", "dispatch-prompt"]) {
    assert.equal(f.calls(name).length > 0, true, `${name} ran`);
    for (const c of f.calls(name)) assert.equal(c.GH_REPO, "", `${name} was given an ambient GH_REPO`);
  }

  const g = fixture();
  g.control("ticket-router", { exit: 2 });
  step(g, "next", "--head", "12");
  step(g, "answer", "12", "staleness", "done");
  step(g, "answer", "12", "decided", "decided");
  assert.equal(step(g, "answer", "12", "collision", "clear").status, 2);
  assert.equal(g.calls("release-ticket").length, 1);
  assert.equal(g.calls("release-ticket")[0].GH_REPO, "", "release-ticket.sh was given an ambient GH_REPO");
});

test("a `gh pr list` that came back at its cap is exit 2, and the Pull stays at the collision stage", () => {
  const prs = (n) => JSON.stringify(Array.from({ length: n }, (_, i) => ({ number: i + 1, headRefName: `b/${i + 1}` })));
  const f = fixture();
  f.next("--head", "12");
  f.answer(12, "staleness", "done");
  f.ghRules([{ match: "^pr list ", out: prs(200) }]);
  const r = f.answer(12, "decided", "decided");
  assert.equal(r.status, 2, r.stdout + r.err);
  assert.match(r.err, /gh pr list came back at its cap of 200/);
  assert.deepEqual(f.state().scans, []);
  assert.equal(f.state().stage, "collision");
  assert.equal(ghCalls(f, /^pr diff/).length, 0, "no PR is diffed off a list that may be short");

  const g = fixture();
  g.next("--head", "12");
  g.answer(12, "staleness", "done");
  g.ghRules([{ match: "^pr list ", out: prs(199) }, { match: "^pr diff \\d+ --name-only$", out: "README\n" }]);
  const under = g.answer(12, "decided", "decided");
  assert.equal(under.status, 10, "one short of the cap is a whole answer");
  assert.match(under.stdout, /^QUESTION collision:/m);
  assert.equal(ghCalls(g, /^pr diff/).length, 199);
});

test("a `gh pr list` that fails, or prints no list of numbered PRs with their head, is exit 2 at the collision stage", () => {
  for (const [rule, said] of [
    [{ exit: 1, err: "nope" }, /gh pr list failed \(exit 1\)\nnope/],
    [{ out: "not json" }, /could not parse gh pr list/],
    [{ out: JSON.stringify([{ number: 7 }]) }, /gh pr list did not print a JSON array of PRs with their number and head branch/],
  ]) {
    const f = fixture();
    f.next("--head", "12");
    f.answer(12, "staleness", "done");
    f.ghRules([{ match: "^pr list ", ...rule }]);
    const r = f.answer(12, "decided", "decided");
    assert.equal(r.status, 2, r.stdout + r.err);
    assert.match(r.err, said);
    assert.equal(f.state().stage, "collision");
  }
});

test("defang writes the spelling of each declared placeholder `‹name›` and leaves every other `<…>` alone", () => {
  assert.equal(defang("run <N> on <abs-path> with <qid> and <distilled brief>", ["N", "abs-path", "distilled brief"]), "run ‹N› on ‹abs-path› with <qid> and ‹distilled brief›");
  assert.equal(defang("nothing to do", ["N"]), "nothing to do");
});

test("a ticket that spells a placeholder the implementer template declares reaches the renderer without the spelling", () => {
  const template = readFileSync(join(PLUGIN, "skills", "run-team", "briefs", "implementer.md"), "utf8");
  const names = [...template.matchAll(/^arg \S+ (.+)$/gm)].map((m) => m[1]);
  assert.equal(names.includes("N"), true, "the template declares <N>");
  const issue = { ...ISSUE, body: "## What to build\n\nRun `pull.mjs next --head <N>` in <branch>, giving <distilled brief> and <qid>.\n" };
  const f = fixture({ issue });
  f.next("--head", "12");
  f.answer(12, "staleness", "none", "no string settles <scratch>");
  f.answer(12, "decided", "decided");
  const end = f.answer(12, "collision", "clear");
  assert.equal(end.status, 0, end.stdout + end.err);
  const render = f.calls("dispatch-prompt")[0].args;
  for (const flag of ["--brief", "--staleness"]) {
    const value = render[render.indexOf(flag) + 1];
    for (const name of names) assert.equal(value.includes(`<${name}>`), false, `${flag} spells <${name}>`);
  }
  const brief = render[render.indexOf("--brief") + 1];
  assert.equal(brief.includes("‹N›") && brief.includes("‹branch›") && brief.includes("‹distilled brief›"), true);
  assert.equal(brief.includes("<qid>"), true, "a spelling the template does not declare is the ticket's own");
  assert.equal(render[render.indexOf("--staleness") + 1].includes("‹scratch›"), true);
});

test("SKILL.md Phase 1 names `pull.mjs next` as the Pull's entry, and its step paragraphs stay in references/pull.md", () => {
  const phase1 = SKILL.slice(SKILL.indexOf("## Phase 1 — Pull"), SKILL.indexOf("## Phase 2 — dispatch"));
  assert.ok(phase1.length > 1000, "Phase 1 is found");
  const flat = phase1.replace(/\s+/g, " ");
  assert.ok(flat.includes("A Pull's entry is `~/.fleet/bin/fleet-run pull.mjs next --head <N>`"), "Phase 1 names pull.mjs next as the entry");
  assert.ok(flat.includes("`pull.mjs answer <N> <qid> <token> [--path <p>] [--] [<text>…]`"), "and the answer command");
  const steps = PULL_MD.replace(/\s+/g, " ");
  for (const step of ["1. **Take the shortlist head**", "2. **In-flight check, again**", "3. **Read the ticket in full, once**", "4. **Collision scan", "5. **Sequence check**", "6. **Claim**", "7. **Route, row, then dispatch**"]) {
    assert.ok(steps.includes(step), `the step paragraph stays: ${step}`);
  }
});

test("references/pull.md steps 4 and 5 answer Q3 off the printed scan and the Out of scope candidates, and run no scan by hand", () => {
  const at = PULL_MD.indexOf("4. **Collision scan");
  const steps = PULL_MD.slice(at, PULL_MD.indexOf("6. **Claim**", at)).replace(/\s+/g, " ");
  assert.ok(at !== -1 && steps.length > 200, "steps 4 and 5 are found");
  for (const phrase of [
    "`pull.mjs` runs it before Q3",
    "`no overlap` when none, and `could not look: <which>`",
    "Answer Q3 off those lines: `behind-pr:#M`, a branch with no PR yet by its name",
    "`paths <p>…`, which scans again and asks again",
    "`behind-pr` on it is taken",
    "the `#N` refs of the brief's `Out of scope` section are printed beside Q3 as the candidates",
    "→ `behind-issue:#M`",
  ]) {
    assert.ok(steps.includes(phrase), `steps 4 and 5 say: ${phrase}`);
  }
  assert.ok(!steps.includes("git diff --name-only") && !steps.includes("gh pr diff <PR>"), "the controller is no longer told to run the scan's commands");
  const overlap = steps.slice(steps.indexOf("`pr-overlap.mjs` is **PR-vs-PR only**"), steps.indexOf("5. **Sequence check**"));
  assert.ok(overlap.length > 0, "the pr-overlap.mjs sentence stays");
  assert.equal(overlap.match(/\.(\s|$)/g).length, 1, `the pr-overlap.mjs paragraph is one sentence: ${overlap}`);
});

test("an unknown flag is refused at exit 2 naming it, as arg.mjs's own refusal is; the other command-line mistakes are exit 3", () => {
  const f = fixture();
  for (const args of [["--bogus"], ["next", "--bogus"], ["next", "--head", "12", "--bogus"], ["-x"]]) {
    const r = f.run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.err}`);
    assert.match(r.err, new RegExp(`^pull: unknown flag ${args.findLast((a) => a.startsWith("-")).replace(/[-]/g, "\\-")} `, "m"));
  }
  assert.deepEqual(f.order(), [], "nothing ran");
  assert.equal(f.run(["next", "12"]).status, 3, "a word that is no flag is usage");
});
