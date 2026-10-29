// `fleet-event.mjs`: a member's report recorded as one command — the writes
// its wake owes, then `fleet-tick.mjs --apply`.
//
// Every case runs the real script from a throwaway repository whose `.fleet/`
// holds a fixture ledger, a phase-0 receipt naming the scratch root and the
// caps, and the rendered briefs. The scripts directory is a copy of the
// plugin's in which `fleet-tick.mjs`, `dispositions-check.mjs`,
// `dispatch-prompt.mjs`, `release-ticket.sh` and `verify-sha.sh` are stubs that log their call
// to `order.log` and answer from a control file the case writes, and
// `ledger.mjs` is a shim: `settle --from-report` is stubbed — it logs, then
// refuses as the control file says, or prints the control file's own stdout
// and stderr and exits 0, or settles the outcome the control file names
// through the real script's bare form — and every other subcommand
// is the real script's, its writes logged. `gh` is a stub on PATH that keeps
// each issue's and PR's labels, comments and closed state in a state file, so a second run
// reads what the first one wrote. No network, no omp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { seedLabelMap } from "./support/label-map-seed.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { bodyDigest, foldLedger, parkedToken } from "../plugin/scripts/fleet-tick.mjs";
import { BAILS, reportKind } from "../plugin/scripts/fleet-event.mjs";
import { MEMBER_FAMILIES } from "../plugin/scripts/ledger-grammar.mjs";
import { SCHEMAS } from "../plugin/scripts/report-schema.mjs";

const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));
const REAL_SCRIPTS = join(PLUGIN, "scripts");

// The fixture commits, so it supplies the identity a CI runner lacks.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;
delete GIT_ENV.GH_REPO;
delete GIT_ENV.FORCE_COLOR;
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// What every script stub is: log the call, run what the control file asks of
// the real ledger, then answer from `<name>.json` — `{exit, out, err,
// ledger}`, or `by[<args>]` for an answer that turns on the arguments.
const DRIVER = `import { appendFileSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = process.env.EVENT_STUBS;
const control = (name) => {
  try {
    return JSON.parse(readFileSync(join(dir, name + ".json"), "utf8"));
  } catch {
    return {};
  }
};

export function drive(name, args) {
  appendFileSync(join(dir, "order.log"), [name, ...args].join(" ") + "\\n");
  const c = control(name);
  const spec = (c.by && c.by[args.join(" ")]) || c;
  if (spec.ledger) {
    const real = join(dirname(fileURLToPath(import.meta.url)), "ledger-real.mjs");
    const r = spawnSync(process.execPath, [real, ...spec.ledger], { encoding: "utf8" });
    if (r.status !== 0) throw new Error("stub ledger write failed: " + r.stderr);
  }
  process.stdout.write(spec.out ?? "");
  process.stderr.write(spec.err ?? "");
  process.exit(spec.exit ?? 0);
}

if (process.argv[1].endsWith("stub-driver.mjs")) drive(process.argv[2], process.argv.slice(3));
`;

const TREE = tempDir("fleet-event-tree-");
cpSync(PLUGIN, join(TREE, "plugin"), { recursive: true });
const SCRIPTS = join(TREE, "plugin", "scripts");
writeFileSync(join(SCRIPTS, "stub-driver.mjs"), DRIVER);
// Imported by other scripts for their exports (the ledger and this script
// take the tick's), so the real module stays importable behind the stub.
cpSync(join(SCRIPTS, "fleet-tick.mjs"), join(SCRIPTS, "fleet-tick-real.mjs"));
writeFileSync(join(SCRIPTS, "fleet-tick.mjs"), `export * from "./fleet-tick-real.mjs";
import { drive } from "./stub-driver.mjs";
import { isCLI } from "./is-cli.mjs";
import { writeFileSync } from "node:fs";
if (isCLI(import.meta.url) && process.env.TICK_ENV_LOG) writeFileSync(process.env.TICK_ENV_LOG, JSON.stringify({ GIT_DIR: process.env.GIT_DIR ?? null }));
if (isCLI(import.meta.url)) drive("fleet-tick", process.argv.slice(2));
`);
// dispositions-check.mjs is only ever run, never imported, by the scripts.
writeFileSync(join(SCRIPTS, "dispositions-check.mjs"), `import { drive } from "./stub-driver.mjs";\ndrive("dispositions-check", process.argv.slice(2));\n`);
// dispatch-prompt.mjs runs on import, so nothing imports it: a plain stub.
writeFileSync(join(SCRIPTS, "dispatch-prompt.mjs"), `import { drive } from "./stub-driver.mjs";\ndrive("dispatch-prompt", process.argv.slice(2));\n`);
// ci-state.mjs is only ever run, never imported, by the scripts.
writeFileSync(join(SCRIPTS, "ci-state.mjs"), `import { drive } from "./stub-driver.mjs";\ndrive("ci-state", process.argv.slice(2));\n`);
writeFileSync(join(SCRIPTS, "release-ticket.sh"), `#!/bin/sh\nexec node "$(dirname "$0")/stub-driver.mjs" release-ticket "$@"\n`);
writeFileSync(join(SCRIPTS, "verify-sha.sh"), `#!/bin/sh\nexec node "$(dirname "$0")/stub-driver.mjs" verify-sha "$@"\n`);
cpSync(join(SCRIPTS, "ledger.mjs"), join(SCRIPTS, "ledger-real.mjs"));
writeFileSync(join(SCRIPTS, "ledger.mjs"), `import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.env.EVENT_STUBS;
const argv = process.argv.slice(2);
if (argv[0] === "settle" && argv.includes("--from-report")) {
  appendFileSync(join(dir, "order.log"), ["settle", ...argv.slice(1)].join(" ") + "\\n");
  let c = {};
  try {
    c = JSON.parse(readFileSync(join(dir, "settle.json"), "utf8"));
  } catch {
    // No control file: every settle is refused below.
  }
  const spec = c[argv[1]] ?? { exit: 2, err: "no settle control for " + argv[1] + "\\n" };
  if (spec.raw) {
    process.stdout.write(spec.out ?? "");
    process.stderr.write(spec.err ?? "");
    process.exit(0);
  }
  if (spec.exit) {
    process.stderr.write(spec.err ?? "");
    process.exit(spec.exit);
  }
  process.argv.splice(2, process.argv.length - 2, "settle", argv[1] + "=" + spec.outcome);
} else if (argv[0] !== "read") {
  appendFileSync(join(dir, "order.log"), ["ledger", ...argv].join(" ") + "\\n");
}
await import("./ledger-real.mjs");
`);
const SCRIPT = join(SCRIPTS, "fleet-event.mjs");

// Keeps each issue's and PR's labels, comments and closed state in
// gh-state.json; a `<noun> <verb>` listed in gh-fail.json fails.
const GH_STUB = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.EVENT_STUBS;
const args = process.argv.slice(2);
const [noun, verb, n] = args;
fs.appendFileSync(path.join(dir, "order.log"), ["gh", noun, verb, n].join(" ") + "\\n");
fs.appendFileSync(path.join(dir, "gh.calls"), JSON.stringify({ args, GH_REPO: process.env.GH_REPO ?? null, GIT_DIR: process.env.GIT_DIR ?? null }) + "\\n");
const failPath = path.join(dir, "gh-fail.json");
if (fs.existsSync(failPath) && JSON.parse(fs.readFileSync(failPath, "utf8")).includes(noun + " " + verb)) {
  process.stderr.write("gh boom\\n");
  process.exit(1);
}
const statePath = path.join(dir, "gh-state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { issue: {}, pr: {} };
const item = (state[noun][n] ??= { labels: [], comments: [] });
const values = (flag) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));
if (verb === "view") {
  process.stdout.write(JSON.stringify({ labels: item.labels.map((name) => ({ name })), comments: item.comments.map((body) => ({ body })), state: item.state ?? "OPEN" }));
} else if (verb === "close") {
  item.state = "CLOSED";
  for (const body of values("--comment")) item.comments.push(body);
} else if (verb === "edit") {
  item.labels = item.labels.filter((l) => !values("--remove-label").includes(l));
  for (const l of values("--add-label")) if (!item.labels.includes(l)) item.labels.push(l);
} else if (verb === "comment") {
  item.comments.push(values("--body")[0]);
}
fs.writeFileSync(statePath, JSON.stringify(state));
`;

const HEAD = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const RUN = "run-abcdefgh";
const REVIEWED = `reviewed=${HEAD}:1/2/3:${RUN}`;
const ledgerText = ({ rows = [], dispatched = [], retired = [] }) => `# Fleet run ledger\n\n## Rows\n${rows.map((r) => `- ${r}\n`).join("")}\n`
  + `## Dispatched\n${dispatched.map((r) => `- ${r}\n`).join("")}\n## Filed\n\n## Ruled\n`
  + (retired.length === 0 ? "" : `\n## Retired\n${retired.map((r) => `- ${r}\n`).join("")}`);

const implReport = (member, over = {}) => ({
  member, outcome: "pr", pr: 88, head: HEAD, branch: `implementer/412-${member}`,
  sizing: { verdict: "light", signal: "one file", ranBeforePr: true },
  bailCause: null, bailDetail: null, confirmation: [], ...over,
});
const bail = (member, bailCause, bailDetail) => implReport(member, { outcome: "bailed", pr: null, head: null, sizing: null, bailCause, bailDetail });
const finisherReport = (member, over = {}) => ({
  member, outcome: "labelled", cause: null, evidence: null, pin: HEAD, labelsReadBack: ["ready-to-merge", "patch"],
  kill: null, filed: [], unrecorded: [], confirmation: [], ...over,
});
const mergeBotReport = (member, held, refused = []) => ({ member, merged: [], held, conflictHold: [], refused, branchKept: [] });

// A main checkout with a fixture ledger, a phase-0 receipt naming the scratch
// root, caps 3 and 5 and In-flight bound 7, the Label map (the identity map
// unless `labels` remaps roles) and the gh stub on PATH.
function fixture({ rows = [], dispatched = [], retired = [], caps = { impl: 3, review: 5 }, inFlight = 7, session = "", labels = {} } = {}) {
  const dir = realpathSync(tempDir("fleet-event-"));
  const repo = join(dir, "repo");
  const stubs = join(dir, "stubs");
  const bin = join(dir, "bin");
  const scratch = join(dir, "scratch");
  for (const d of [repo, stubs, bin, join(scratch, "reports")]) mkdirSync(d, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, ".gitignore"), ".fleet/\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "root");
  writeExecStub(join(bin, "gh"), GH_STUB);
  const fleet = join(repo, ".fleet");
  mkdirSync(join(fleet, "briefs"), { recursive: true });
  seedLabelMap(repo, { roles: labels });
  writeFileSync(join(fleet, "ledger.md"), ledgerText({ rows, dispatched, retired }));
  writeFileSync(join(fleet, "phase0.json"), JSON.stringify({ run: null, session, steps: {}, scratch, ...(caps === null ? {} : { caps }), ...(inFlight === null ? {} : { inFlight }) }));
  const f = {
    dir, repo, stubs, scratch, fleet,
    control: (name, value) => writeFileSync(join(stubs, `${name}.json`), JSON.stringify(value)),
    report: (value) => writeFileSync(join(scratch, "reports", `${value.member}.json`), JSON.stringify(value)),
    brief: (member, kind) => writeFileSync(join(fleet, "briefs", `${member}.json`), JSON.stringify({ role: "fix-applier", kind, args: {}, sha256: "0".repeat(64) })),
    order: () => (existsSync(join(stubs, "order.log")) ? readFileSync(join(stubs, "order.log"), "utf8").trim().split("\n") : []),
    ghCalls: () => (existsSync(join(stubs, "gh.calls")) ? readFileSync(join(stubs, "gh.calls"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
    gh: () => (existsSync(join(stubs, "gh-state.json")) ? JSON.parse(readFileSync(join(stubs, "gh-state.json"), "utf8")) : { issue: {}, pr: {} }),
    setGh: (state) => writeFileSync(join(stubs, "gh-state.json"), JSON.stringify(state)),
    ledger: () => readFileSync(join(fleet, "ledger.md"), "utf8"),
    rows: () => {
      const r = spawnSync(process.execPath, [join(SCRIPTS, "ledger-real.mjs"), "read"], { cwd: repo, encoding: "utf8", env: GIT_ENV });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).rows;
    },
    run: (args, { env = {} } = {}) => {
      const before = f.order().length;
      const r = spawnSync(process.execPath, [SCRIPT, ...args], {
        cwd: repo, encoding: "utf8",
        env: { ...GIT_ENV, HOME: dir, PATH: `${bin}:${process.env.PATH}`, EVENT_STUBS: stubs, ...env },
      });
      return { status: r.status, out: r.stdout.split("\n").filter(Boolean), stdout: r.stdout, err: r.stderr, order: f.order().slice(before) };
    },
  };
  f.control("fleet-tick", { out: "TICK ROWS\n" });
  f.control("release-ticket", { out: JSON.stringify({ issue: 412, released: true, applied: true, blockers: [] }) });
  return f;
}

const TICK = "fleet-tick --apply --in-flight 7";
// The calls that write: everything but a ledger read, a gh view and the tick.
const writes = (order) => order.filter((l) => !/^gh \w+ view /.test(l) && !l.startsWith("fleet-tick "));
const eventLine = (r) => r.out.find((l) => l.startsWith("event: "));

// ── impl-report ──────────────────────────────────────────────────────────────

test("impl-report settles from the report under the receipt's scratch, then ticks with --apply and the receipt's bound; a second run only ticks", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.report(implReport("impl-412"));
  f.control("settle", { "impl-412": { outcome: "PR#88" } });
  const first = f.run(["impl-report", "impl-412"]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.deepEqual(first.order, [`settle impl-412 --from-report --reports ${join(f.scratch, "reports")}`, TICK]);
  assert.match(eventLine(first), /^event: impl-report: settled impl-412=PR#88(; .+)?$/);
  assert.equal(first.out.at(-1), "TICK ROWS", "the tick's output comes after the event line, verbatim");
  assert.equal(first.out.indexOf(eventLine(first)), first.out.length - 2);
  assert.deepEqual(f.rows(), ["#412 impl-412=PR#88"]);

  const ledger = f.ledger();
  const second = f.run(["impl-report", "impl-412"]);
  assert.equal(second.status, 0, second.err);
  assert.deepEqual(second.order, [TICK], "the settled token is found and nothing is written again");
  assert.match(eventLine(second), /impl-412=PR#88 already settled/);
  assert.equal(f.ledger(), ledger);
});

// ── impl-report: the claim branch's upstream ─────────────────────────────────

const CLAIM = "implementer/412-impl-412";
const configOf = (f, key) => {
  const r = spawnSync("git", ["config", "--get", `branch.${CLAIM}.${key}`], { cwd: f.repo, encoding: "utf8", env: GIT_ENV });
  return r.status === 0 ? r.stdout.trim() : null;
};

test("impl-report on a PR outcome sets the claim branch's upstream when none is configured; a second run changes nothing", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  git(f.repo, "branch", CLAIM);
  f.report(implReport("impl-412"));
  f.control("settle", { "impl-412": { outcome: "PR#88" } });
  const first = f.run(["impl-report", "impl-412"]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.equal(configOf(f, "remote"), "origin");
  assert.equal(configOf(f, "merge"), `refs/heads/${CLAIM}`);
  assert.ok(first.stdout.includes(`upstream ${CLAIM} set`), first.stdout);

  const second = f.run(["impl-report", "impl-412"]);
  assert.equal(second.status, 0, second.err);
  assert.equal(configOf(f, "remote"), "origin");
  assert.equal(configOf(f, "merge"), `refs/heads/${CLAIM}`);
  assert.ok(!second.stdout.includes("NEED"), second.stdout);
});

test("impl-report for a member already settled as a PR still sets the claim branch's upstream when none is configured", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88"] });
  git(f.repo, "branch", CLAIM);
  f.report(implReport("impl-412"));
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(r.order, [TICK], "an already-settled member is not settled again");
  assert.match(eventLine(r), /impl-412=PR#88 already settled/);
  assert.equal(configOf(f, "remote"), "origin");
  assert.equal(configOf(f, "merge"), `refs/heads/${CLAIM}`);
});

test("impl-report on a PR outcome leaves a configured upstream as it is", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  git(f.repo, "branch", CLAIM);
  git(f.repo, "config", `branch.${CLAIM}.remote`, "elsewhere");
  git(f.repo, "config", `branch.${CLAIM}.merge`, "refs/heads/other");
  f.report(implReport("impl-412"));
  f.control("settle", { "impl-412": { outcome: "PR#88" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(configOf(f, "remote"), "elsewhere");
  assert.equal(configOf(f, "merge"), "refs/heads/other");
});

test("impl-report on a PR outcome with no local claim branch writes no upstream and refuses nothing", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.report(implReport("impl-412"));
  f.control("settle", { "impl-412": { outcome: "PR#88" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(configOf(f, "remote"), null);
  assert.equal(configOf(f, "merge"), null);
  assert.ok(!r.stdout.includes("NEED"), r.stdout);
});

test("impl-report on a bail writes no upstream for the claim branch", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  git(f.repo, "branch", CLAIM);
  f.setGh({ issue: { 412: { labels: ["ready-for-agent", "in-progress"], comments: [] } }, pr: {} });
  f.report(bail("impl-412", "covered", "PR#77 — its diff adds the same guard"));
  f.control("settle", { "impl-412": { outcome: "bailed" } });
  f.control("dispatch-prompt", { out: "*Relabelled by the fleet controller.* covered\n" });
  f.run(["impl-report", "impl-412"]);
  assert.equal(configOf(f, "remote"), null);
  assert.equal(configOf(f, "merge"), null);
});

test("impl-report on a block settles blocked and takes no relabel, comment, release or upstream action", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  git(f.repo, "branch", CLAIM);
  const issue = { labels: ["ready-for-agent", "in-progress"], comments: [] };
  f.setGh({ issue: { 412: issue }, pr: {} });
  f.report(implReport("impl-412", { outcome: "blocked", pr: null, head: null, sizing: null, bailCause: null, bailDetail: "needs a schema ruling" }));
  f.control("settle", { "impl-412": { outcome: "blocked" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(writes(r.order), [`settle impl-412 --from-report --reports ${join(f.scratch, "reports")}`]);
  assert.match(eventLine(r), /^event: impl-report: settled impl-412=blocked$/);
  assert.ok(!r.stdout.includes("NEED"), r.stdout);
  assert.deepEqual(f.gh().issue[412], issue, "the issue keeps its labels and gets no comment");
  assert.deepEqual(f.rows(), ["#412 impl-412=blocked"]);
  assert.equal(configOf(f, "remote"), null);
});

test("impl-report for a member already settled to an outcome that is neither a PR nor a bail writes no upstream", () => {
  const f = fixture({ rows: ["#412 impl-412=released"] });
  git(f.repo, "branch", CLAIM);
  f.report(implReport("impl-412"));
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(configOf(f, "remote"), null);
  assert.equal(configOf(f, "merge"), null);
});

test("impl-report whose upstream write fails prints a NEED naming the commands, still ticks, and never refuses the event", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  git(f.repo, "branch", CLAIM);
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeExecStub(join(f.dir, "bin", "git"), `#!/bin/sh\ncase "$1 $2" in\n"config branch."*) echo "fatal: injected config failure" >&2; exit 255;;\nesac\nexec ${realGit} "$@"\n`);
  f.report(implReport("impl-412"));
  f.control("settle", { "impl-412": { outcome: "PR#88" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.ok(r.stdout.includes(`NEED upstream ${CLAIM} — `), r.stdout);
  assert.ok(r.stdout.includes(`git config branch.${CLAIM}.remote origin && git config branch.${CLAIM}.merge refs/heads/${CLAIM}`), r.stdout);
  assert.equal(r.order.at(-1), TICK);
  assert.equal(configOf(f, "remote"), null);
});

test("impl-report's NEED hint for a branch carrying shell metacharacters runs as written and sets that branch's upstream", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  const b = "implementer/412-x;touch${IFS}PWNED;'y";
  git(f.repo, "branch", b);
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeExecStub(join(f.dir, "bin", "git"), `#!/bin/sh\ncase "$1 $2" in\n"config branch."*) echo "fatal: injected config failure" >&2; exit 255;;\nesac\nexec ${realGit} "$@"\n`);
  f.report(implReport("impl-412", { branch: b }));
  f.control("settle", { "impl-412": { outcome: "PR#88" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  const hint = r.stdout.split("\n").find((l) => l.includes(`NEED upstream ${b} — `))?.split("; run ").at(-1);
  assert.ok(hint, r.stdout);
  const pasted = spawnSync("sh", ["-c", hint], { cwd: f.repo, encoding: "utf8", env: GIT_ENV });
  assert.equal(pasted.status, 0, pasted.stderr);
  assert.equal(existsSync(join(f.repo, "PWNED")), false, "the pasted hint ran no command the branch name smuggled in");
  const get = (key) => spawnSync("git", ["config", "--get", `branch.${b}.${key}`], { cwd: f.repo, encoding: "utf8", env: GIT_ENV }).stdout.trim();
  assert.equal(get("remote"), "origin");
  assert.equal(get("merge"), `refs/heads/${b}`);
});

test("impl-report whose branch lookup fails with a status other than 1 prints a NEED, writes nothing, and never refuses the event", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  git(f.repo, "branch", CLAIM);
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeExecStub(join(f.dir, "bin", "git"), `#!/bin/sh\ncase "$1" in\nshow-ref) echo "fatal: injected show-ref failure" >&2; exit 128;;\nesac\nexec ${realGit} "$@"\n`);
  f.report(implReport("impl-412"));
  f.control("settle", { "impl-412": { outcome: "PR#88" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.ok(r.stdout.includes(`NEED upstream ${CLAIM} — `), r.stdout);
  assert.ok(r.stdout.includes("injected show-ref failure"), r.stdout);
  assert.equal(r.order.at(-1), TICK);
  assert.equal(configOf(f, "remote"), null);
  assert.equal(configOf(f, "merge"), null);
});

test("impl-report whose remote write fails leaves the merge key unset", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  git(f.repo, "branch", CLAIM);
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeExecStub(join(f.dir, "bin", "git"), `#!/bin/sh\ncase "$1 $2" in\n"config branch."*.remote) echo "fatal: injected remote write failure" >&2; exit 255;;\nesac\nexec ${realGit} "$@"\n`);
  f.report(implReport("impl-412"));
  f.control("settle", { "impl-412": { outcome: "PR#88" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.ok(r.stdout.includes(`NEED upstream ${CLAIM} — `), r.stdout);
  assert.ok(r.stdout.includes("injected remote write failure"), r.stdout);
  assert.equal(configOf(f, "remote"), null);
  assert.equal(configOf(f, "merge"), null);
});

test("impl-report whose merge-key read fails with a status other than 1 prints a NEED, writes nothing, and never refuses the event", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  git(f.repo, "branch", CLAIM);
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeExecStub(join(f.dir, "bin", "git"), `#!/bin/sh\ncase "$1 $2" in\n"config --get") echo "fatal: injected config-read failure" >&2; exit 128;;\nesac\nexec ${realGit} "$@"\n`);
  f.report(implReport("impl-412"));
  f.control("settle", { "impl-412": { outcome: "PR#88" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.ok(r.stdout.includes(`NEED upstream ${CLAIM} — `), r.stdout);
  assert.ok(r.stdout.includes("injected config-read failure"), r.stdout);
  assert.equal(r.order.at(-1), TICK);
  assert.equal(configOf(f, "remote"), null);
  assert.equal(configOf(f, "merge"), null);
});

test("impl-report's git and tick children run with GIT_DIR scrubbed, so an ambient one cannot move the upstream to another repository", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  git(f.repo, "branch", CLAIM);
  const other = join(f.dir, "other");
  mkdirSync(other);
  git(other, "init", "-q", "-b", "main");
  git(other, "commit", "-q", "--allow-empty", "-m", "root");
  git(other, "branch", CLAIM);
  const tickEnv = join(f.stubs, "tick-env.json");
  f.report(implReport("impl-412"));
  f.control("settle", { "impl-412": { outcome: "PR#88" } });
  const r = f.run(["impl-report", "impl-412"], { env: { GIT_DIR: join(other, ".git"), TICK_ENV_LOG: tickEnv } });
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(configOf(f, "merge"), `refs/heads/${CLAIM}`);
  const otherMerge = spawnSync("git", ["config", "--get", `branch.${CLAIM}.merge`], { cwd: other, encoding: "utf8", env: GIT_ENV });
  assert.equal(otherMerge.status, 1, "the repository GIT_DIR names keeps no upstream for the claim branch");
  assert.deepEqual(JSON.parse(readFileSync(tickEnv, "utf8")), { GIT_DIR: null });
});

for (const [cause, label, detail, kindArgs] of [
  ["undecided", "needs-triage", "which flag spelling wins", ["--kind", "needs-triage", "--line", "which flag spelling wins"]],
  ["fork", "ready-for-human", "keep the cache or drop it", ["--kind", "fork", "--options", "keep the cache or drop it"]],
  ["hands", "ready-for-human", "external access: the staging database", ["--kind", "hands", "--hands", "external access", "--line", "the staging database"]],
  ["hands", "ready-for-human", "judgment the rollout order", ["--kind", "hands", "--hands", "judgment during the work", "--line", "the rollout order"]],
  ["covered", "ready-for-human", "PR#77 — its diff adds the same guard", ["--kind", "covered", "--detail", "PR#77 — its diff adds the same guard"]],
]) {
  test(`impl-report on a bail for ${cause} (${detail}) relabels ${label}, comments the rendered relabel brief, releases the claim, then ticks; a second run writes neither label nor comment again`, () => {
    const f = fixture({ rows: ["#412 impl-412"] });
    f.setGh({ issue: { 412: { labels: ["ready-for-agent", "in-progress", "enhancement"], comments: [] } }, pr: {} });
    f.report(bail("impl-412", cause, detail));
    f.control("settle", { "impl-412": { outcome: "bailed" } });
    const render = ["render", "relabel", ...kindArgs].join(" ");
    f.control("dispatch-prompt", { out: `*Relabelled by the fleet controller.* ${cause}\n` });
    const first = f.run(["impl-report", "impl-412"]);
    assert.equal(first.status, 0, first.err + first.stdout);
    assert.deepEqual(first.order, [
      `settle impl-412 --from-report --reports ${join(f.scratch, "reports")}`,
      "gh issue view 412",
      "gh issue edit 412",
      `dispatch-prompt ${render}`,
      "gh issue comment 412",
      "release-ticket 412 impl-412 implementer --apply",
      TICK,
    ]);
    assert.deepEqual(f.gh().issue[412], { labels: ["enhancement", label], comments: [`*Relabelled by the fleet controller.* ${cause}\n`] });
    const edit = f.ghCalls().find((c) => c.args[1] === "edit");
    assert.deepEqual(edit.args, ["issue", "edit", "412", "--remove-label", "ready-for-agent", "--remove-label", "in-progress", "--add-label", label]);
    assert.match(eventLine(first), new RegExp(`relabelled #412 ${label} \\(${cause}\\); relabel comment posted on #412; released #412`));

    const ledger = f.ledger();
    const second = f.run(["impl-report", "impl-412"]);
    assert.equal(second.status, 0, second.err + second.stdout);
    assert.deepEqual(writes(second.order), [`dispatch-prompt ${render}`, "release-ticket 412 impl-412 implementer --apply"],
      "no settle, edit or comment again: only the render to compare against and the release's own re-measure");
    assert.equal(f.gh().issue[412].comments.length, 1);
    assert.equal(f.ledger(), ledger);
    assert.match(eventLine(second), new RegExp(`#412 already ${label}; relabel comment already on #412`));
  });
}

test("every bailCause the impl report schema admits is a cause impl-report acts on, and impl-report acts on no other", () => {
  assert.deepEqual(SCHEMAS.impl.properties.bailCause.enum.filter((c) => c !== null).sort(), Object.keys(BAILS).sort());
});

// ── the Label map: the strings the script compares and writes ───────────────

const REMAP = { "ready-for-agent": "agent-ready", "in-progress": "wip", "needs-triage": "triage", "ready-for-human": "human", "ready-to-merge": "merge-ready" };

test("with a remapped Label map a bail relabel records --remove-label agent-ready --remove-label wip --add-label triage, and a second run finds it in place", () => {
  const f = fixture({ rows: ["#412 impl-412"], labels: REMAP });
  f.setGh({ issue: { 412: { labels: ["agent-ready", "wip", "enhancement"], comments: [] } }, pr: {} });
  f.report(bail("impl-412", "undecided", "which flag spelling wins"));
  f.control("settle", { "impl-412": { outcome: "bailed" } });
  f.control("dispatch-prompt", { out: "*Relabelled by the fleet controller.* undecided\n" });
  const first = f.run(["impl-report", "impl-412"]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.deepEqual(f.ghCalls().find((c) => c.args[1] === "edit").args, ["issue", "edit", "412", "--remove-label", "agent-ready", "--remove-label", "wip", "--add-label", "triage"]);
  assert.deepEqual(f.gh().issue[412].labels, ["enhancement", "triage"]);
  assert.match(eventLine(first), /relabelled #412 triage \(undecided\)/);

  const second = f.run(["impl-report", "impl-412"]);
  assert.equal(second.status, 0, second.err + second.stdout);
  assert.ok(!writes(second.order).includes("gh issue edit 412"), "nothing left to move");
  assert.match(eventLine(second), /#412 already triage/);
});

test("with a remapped Label map every ready-for-human bail adds the mapped string", () => {
  for (const [cause, detail] of [["fork", "keep the cache or drop it"], ["hands", "judgment the rollout order"], ["covered", "PR#77 — its diff adds the same guard"]]) {
    const f = fixture({ rows: ["#412 impl-412"], labels: REMAP });
    f.setGh({ issue: { 412: { labels: ["agent-ready", "wip"], comments: [] } }, pr: {} });
    f.report(bail("impl-412", cause, detail));
    f.control("settle", { "impl-412": { outcome: "bailed" } });
    f.control("dispatch-prompt", { out: `*Relabelled by the fleet controller.* ${cause}\n` });
    const r = f.run(["impl-report", "impl-412"]);
    assert.equal(r.status, 0, `${cause}: ${r.err}${r.stdout}`);
    assert.deepEqual(f.ghCalls().find((c) => c.args[1] === "edit").args, ["issue", "edit", "412", "--remove-label", "agent-ready", "--remove-label", "wip", "--add-label", "human"], cause);
  }
});

test("with a remapped Label map a fixed bail drops the mapped ready-for-agent and in-progress, and demotes to the mapped needs-triage when its sha is not on origin/main", () => {
  const closed = fixture({ rows: ["#412 impl-412"], labels: REMAP });
  closed.setGh({ issue: { 412: { labels: ["agent-ready", "wip", "bug"], comments: [] } }, pr: {} });
  closed.report(bail("impl-412", "fixed", FIXED_DETAIL));
  closed.control("settle", { "impl-412": { outcome: "bailed" } });
  closed.control("verify-sha", { exit: 0, out: JSON.stringify({ branch: "main", sha: SHORT, reachable: true, tip: HEAD }) });
  closed.control("dispatch-prompt", { out: CLOSE_BODY });
  const a = closed.run(["impl-report", "impl-412"]);
  assert.equal(a.status, 0, a.err + a.stdout);
  assert.deepEqual(closed.ghCalls().find((c) => c.args[1] === "edit").args, ["issue", "edit", "412", "--remove-label", "agent-ready", "--remove-label", "wip"]);
  assert.deepEqual(closed.gh().issue[412].labels, ["bug"]);

  const open = fixture({ rows: ["#412 impl-412"], labels: REMAP });
  open.setGh({ issue: { 412: { labels: ["agent-ready", "wip", "bug"], comments: [] } }, pr: {} });
  open.report(bail("impl-412", "fixed", FIXED_DETAIL));
  open.control("settle", { "impl-412": { outcome: "bailed" } });
  open.control("verify-sha", { exit: 1, out: JSON.stringify({ branch: "main", sha: SHORT, reachable: false, tip: HEAD }) });
  const b = open.run(["impl-report", "impl-412"]);
  assert.equal(b.status, 0, b.err + b.stdout);
  assert.deepEqual(open.ghCalls().find((c) => c.args[1] === "edit").args, ["issue", "edit", "412", "--remove-label", "agent-ready", "--remove-label", "wip", "--add-label", "triage"]);
});

for (const [what, damage] of [
  ["no map", (path) => rmSync(path)],
  ["a map that does not parse", (path) => writeFileSync(path, "{")],
]) {
  for (const args of [["impl-report", "impl-412"], ["ci", "88"], ["heartbeat"]]) {
    test(`${what}: \`${args[0]}\` refuses with exit 2 naming ensure, writes nothing and does not tick`, () => {
      const f = fixture({ rows: ["#412 impl-412"] });
      f.report(bail("impl-412", "undecided", "which flag spelling wins"));
      damage(join(f.fleet, "labels.json"));
      const ledger = f.ledger();
      const r = f.run(args);
      assert.equal(r.status, 2, r.err + r.stdout);
      assert.match(r.err, /label-map\.mjs ensure/);
      assert.deepEqual(r.order, [], "no settle, no gh, no tick");
      assert.equal(f.ledger(), ledger);
      assert.equal(r.stdout, "");
    });
  }
}

// ── impl-report: a `fixed` bail ──────────────────────────────────────────────

const SHORT = "abc1234";
const FIXED_DETAIL = `${SHORT} — origin/main's guard already refuses the input`;
const VERIFY = `verify-sha main ${SHORT}`;
const FIXED_RENDER = `dispatch-prompt render relabel --kind fixed --detail ${FIXED_DETAIL}`;
const CLOSE_BODY = "*Closed by the fleet controller.* fixed\n";

function fixedFixture(verify) {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.setGh({ issue: { 412: { labels: ["ready-for-agent", "in-progress", "bug"], comments: [] } }, pr: {} });
  f.report(bail("impl-412", "fixed", FIXED_DETAIL));
  f.control("settle", { "impl-412": { outcome: "bailed" } });
  f.control("verify-sha", verify);
  f.control("dispatch-prompt", { out: CLOSE_BODY });
  return f;
}

test("impl-report on a fixed bail whose sha is on origin/main closes the issue with the rendered fixed comment, drops ready-for-agent and in-progress, releases, then ticks; a second run closes and comments nothing again", () => {
  const f = fixedFixture({ exit: 0, out: JSON.stringify({ branch: "main", sha: SHORT, reachable: true, tip: HEAD }) });
  const first = f.run(["impl-report", "impl-412"]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.deepEqual(first.order, [
    `settle impl-412 --from-report --reports ${join(f.scratch, "reports")}`,
    VERIFY,
    FIXED_RENDER,
    "gh issue view 412",
    "gh issue close 412",
    "gh issue edit 412",
    "release-ticket 412 impl-412 implementer --apply",
    TICK,
  ]);
  assert.deepEqual(f.gh().issue[412], { labels: ["bug"], comments: [CLOSE_BODY], state: "CLOSED" });
  const calls = f.ghCalls();
  assert.deepEqual(calls.find((c) => c.args[1] === "close").args, ["issue", "close", "412", "--comment", CLOSE_BODY]);
  assert.deepEqual(calls.find((c) => c.args[1] === "edit").args, ["issue", "edit", "412", "--remove-label", "ready-for-agent", "--remove-label", "in-progress"]);
  assert.ok(!calls.some((c) => c.args[0] === "issue" && c.args[1] === "edit" && c.args.includes("--add-label")), "a closed ticket takes no label");
  assert.match(eventLine(first), /closed #412: fixed by abc1234; released #412/);

  const second = f.run(["impl-report", "impl-412"]);
  assert.equal(second.status, 0, second.err + second.stdout);
  assert.deepEqual(writes(second.order), [VERIFY, FIXED_RENDER, "release-ticket 412 impl-412 implementer --apply"]);
  assert.deepEqual(f.gh().issue[412].comments, [CLOSE_BODY]);
  assert.match(eventLine(second), /#412 already closed/);
});

test("impl-report on a fixed bail whose sha is not on origin/main relabels needs-triage with a not-on-origin/main comment, releases, and closes nothing", () => {
  const f = fixedFixture({ exit: 1, out: JSON.stringify({ branch: "main", sha: SHORT, reachable: false, tip: HEAD }) });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(r.order, [
    `settle impl-412 --from-report --reports ${join(f.scratch, "reports")}`,
    VERIFY,
    "gh issue view 412",
    "gh issue edit 412",
    "gh issue comment 412",
    "release-ticket 412 impl-412 implementer --apply",
    TICK,
  ]);
  const issue = f.gh().issue[412];
  assert.deepEqual(issue.labels, ["bug", "needs-triage"]);
  assert.equal(issue.state, undefined, "the issue was never closed");
  assert.equal(issue.comments.length, 1);
  assert.match(issue.comments[0], /abc1234 not on origin\/main/);
  assert.deepEqual(f.ghCalls().find((c) => c.args[1] === "edit").args, ["issue", "edit", "412", "--remove-label", "ready-for-agent", "--remove-label", "in-progress", "--add-label", "needs-triage"]);
});

test("impl-report on a fixed bail whose sha verify-sha.sh cannot answer prints NEED, touches no issue, releases nothing, still ticks, exits 4", () => {
  const f = fixedFixture({ exit: 2, err: "verify-sha: cannot fetch origin/main\n" });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.match(r.stdout, /^NEED close #412 — verify-sha\.sh main abc1234 could not answer \(exit 2\): verify-sha: cannot fetch origin\/main/m);
  assert.deepEqual(r.order, [`settle impl-412 --from-report --reports ${join(f.scratch, "reports")}`, VERIFY, TICK]);
  assert.deepEqual(f.gh().issue[412], { labels: ["ready-for-agent", "in-progress", "bug"], comments: [] });
});

test("impl-report on a fixed bail whose bailDetail opens with no sha prints NEED and touches nothing", () => {
  const f = fixedFixture({ exit: 0 });
  f.report(bail("impl-412", "fixed", "already fixed upstream"));
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.match(r.stdout, /^NEED close #412 — the report's bailDetail opens with no commit sha/m);
  assert.deepEqual(r.order, [`settle impl-412 --from-report --reports ${join(f.scratch, "reports")}`, TICK]);
  assert.deepEqual(f.gh().issue[412], { labels: ["ready-for-agent", "in-progress", "bug"], comments: [] });
});

// Each opens with something that is not a whole 7-to-40-character sha: too
// short, glued to the letters after it, and one hex character too long.
for (const [what, detail] of [
  ["too short", "abc12 — origin/main's guard already refuses the input"],
  ["glued to letters", "abc1234zz — origin/main's guard already refuses the input"],
  ["41 hex characters long", `abc1234${"0".repeat(34)} — origin/main's guard already refuses the input`],
]) {
  test(`impl-report on a fixed bail whose bailDetail opens with a sha ${what} prints NEED and never asks verify-sha.sh`, () => {
    const f = fixedFixture({ exit: 0 });
    f.report(bail("impl-412", "fixed", detail));
    const r = f.run(["impl-report", "impl-412"]);
    assert.equal(r.status, 4, r.err + r.stdout);
    assert.match(r.stdout, /^NEED close #412 — the report's bailDetail opens with no commit sha/m);
    assert.deepEqual(r.order, [`settle impl-412 --from-report --reports ${join(f.scratch, "reports")}`, TICK]);
  });
}

test("impl-report on a fixed bail whose close comment landed before its close failed closes the still-open issue without posting the comment twice", () => {
  const f = fixedFixture({ exit: 0, out: JSON.stringify({ branch: "main", sha: SHORT, reachable: true, tip: HEAD }) });
  f.setGh({ issue: { 412: { labels: ["ready-for-agent", "in-progress", "bug"], comments: [CLOSE_BODY] } }, pr: {} });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(f.ghCalls().find((c) => c.args[1] === "close").args, ["issue", "close", "412"]);
  assert.deepEqual(f.gh().issue[412], { labels: ["bug"], comments: [CLOSE_BODY], state: "CLOSED" });
});

test("impl-report on a fixed bail whose close fails prints NEED and leaves the labels and the claim as they were", () => {
  const f = fixedFixture({ exit: 0 });
  writeFileSync(join(f.stubs, "gh-fail.json"), JSON.stringify(["issue close"]));
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.match(r.stdout, /^NEED close #412 — gh issue close failed: gh boom$/m);
  assert.ok(!r.order.some((l) => l === "gh issue edit 412" || l.startsWith("release-ticket")), r.order.join("\n"));
  assert.deepEqual(f.gh().issue[412].labels, ["ready-for-agent", "in-progress", "bug"]);
});

test("impl-report prints NEED hand-release on a release refusal, still ticks, and exits 4 rather than failing before the tick", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.report(bail("impl-412", "undecided", "which flag spelling wins"));
  f.control("settle", { "impl-412": { outcome: "bailed" } });
  f.control("dispatch-prompt", { out: "comment\n" });
  f.control("release-ticket", { exit: 1, out: JSON.stringify({ issue: 412, released: false, applied: true, blockers: ["worktree has uncommitted changes"] }) });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.ok(r.out.includes("NEED hand-release #412 worktree has uncommitted changes"), r.stdout);
  assert.equal(r.order.at(-1), TICK);
  assert.equal(r.out.at(-1), "TICK ROWS");
});

test("impl-report applies the label but leaves the comment as a NEED when a hands detail names no cause", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.report(bail("impl-412", "hands", "someone with the staging password"));
  f.control("settle", { "impl-412": { outcome: "bailed" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.match(r.stdout, /^NEED relabel-comment #412 — the report's bailDetail opens with none of external access, manual testing, judgment/m);
  assert.deepEqual(f.gh().issue[412].labels, ["ready-for-human"]);
  assert.ok(!r.order.some((l) => l.startsWith("dispatch-prompt") || l === "gh issue comment 412"), r.order.join("\n"));
  assert.ok(r.order.includes("release-ticket 412 impl-412 implementer --apply"));
});

test("impl-report never releases a claim whose relabel failed: the release would drop in-progress and leave ready-for-agent", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.setGh({ issue: { 412: { labels: ["ready-for-agent", "in-progress"], comments: [] } }, pr: {} });
  f.report(bail("impl-412", "fork", "a or b"));
  f.control("settle", { "impl-412": { outcome: "bailed" } });
  writeFileSync(join(f.stubs, "gh-fail.json"), JSON.stringify(["issue edit"]));
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.match(r.stdout, /^NEED relabel #412 ready-for-human — gh issue edit failed: gh boom$/m);
  assert.ok(!r.order.some((l) => l.startsWith("release-ticket")), r.order.join("\n"));
  assert.equal(r.order.at(-1), TICK);
});

test("a settle refusal (exit 3) passes its message through, writes nothing after it, still ticks, and exits 3", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.report(bail("impl-412", "undecided", "x"));
  f.control("settle", { "impl-412": { exit: 3, err: "\nledger: settle impl-412 --from-report: the report's claim and the world disagree — failed: bailCause; nothing written\n" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  assert.match(r.err, /^ledger: settle impl-412 --from-report: the report's claim and the world disagree/m);
  assert.deepEqual(r.order, [`settle impl-412 --from-report --reports ${join(f.scratch, "reports")}`, TICK]);
  assert.match(eventLine(r), /settle impl-412 refused \(exit 3\)/);
  assert.equal(r.out.at(-1), "TICK ROWS", "the controller still sees the rows");
});

test("a settle refusal exits 3 even when the tick itself fails after it", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.control("settle", { "impl-412": { exit: 3, err: "disagree\n" } });
  f.control("fleet-tick", { exit: 2, err: "fleet-tick: boom\n" });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 3, r.err + r.stdout);
});

test("the tick's own exit is the event's when every write landed", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.control("settle", { "impl-412": { outcome: "PR#88" } });
  f.control("fleet-tick", { exit: 2, err: "fleet-tick: gh pr list failed\n" });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.match(r.err, /fleet-tick: gh pr list failed/);
});

for (const [why, setup] of [
  ["no report on disk", () => {}],
  ["an unreadable report", (f) => writeFileSync(join(f.scratch, "reports", "impl-412.json"), "{not json")],
  ["a report that names no bail cause", (f) => f.report(implReport("impl-412"))],
]) {
  test(`impl-report on a bail with ${why} prints a NEED to relabel by hand, touches no issue, releases nothing, and still ticks`, () => {
    const f = fixture({ rows: ["#412 impl-412"] });
    setup(f);
    f.control("settle", { "impl-412": { outcome: "bailed" } });
    const r = f.run(["impl-report", "impl-412"]);
    assert.equal(r.status, 4, r.err + r.stdout);
    assert.match(r.stdout, /^NEED relabel #412 — impl-412's report .*impl-412\.json is (absent|invalid|missing a bailCause): relabel by its cause by hand$/m);
    assert.ok(!r.order.some((l) => l.startsWith("gh ") || l.startsWith("release-ticket")), r.order.join("\n"));
    assert.equal(r.order.at(-1), TICK);
  });
}

for (const stale of ["in-progress", "ready-for-agent"]) {
  test(`impl-report still edits an issue that already holds the target label beside a stale ${stale}`, () => {
    const f = fixture({ rows: ["#412 impl-412"] });
    f.setGh({ issue: { 412: { labels: ["ready-for-human", stale], comments: [] } }, pr: {} });
    f.report(bail("impl-412", "fork", "a or b"));
    f.control("settle", { "impl-412": { outcome: "bailed" } });
    f.control("dispatch-prompt", { out: "comment\n" });
    const r = f.run(["impl-report", "impl-412"]);
    assert.equal(r.status, 0, r.err + r.stdout);
    assert.ok(r.order.includes("gh issue edit 412"), r.order.join("\n"));
    assert.deepEqual(f.gh().issue[412].labels, ["ready-for-human"]);
  });
}

test("a settle that exits 0 with no receipt on stdout is refused with exit 2, naming what it printed, and the tick still runs", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.control("settle", { "impl-412": { raw: true, out: "garbage\n" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.match(r.err, /^fleet-event: settle impl-412 exited 0 with no receipt on stdout: garbage$/m);
  assert.equal(r.order.at(-1), TICK);
});

test("a settle's own stderr on success is passed through", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.report(implReport("impl-412"));
  f.control("settle", { "impl-412": { raw: true, out: JSON.stringify({ outcome: "PR#88" }), err: "ledger: warning: a note\n" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.match(r.err, /^ledger: warning: a note$/m);
  assert.match(eventLine(r), /settled impl-412=PR#88/);
});

// ── In-flight bound ──────────────────────────────────────────────────────────

test("the bound is --in-flight as given, else the one the receipt records, else none: the tick's own default; the receipt's caps play no part", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88"] });
  assert.deepEqual(f.run(["impl-report", "impl-412", "--in-flight", "9"]).order, ["fleet-tick --apply --in-flight 9"]);
  assert.deepEqual(f.run(["impl-report", "--in-flight", "1", "impl-412"]).order, ["fleet-tick --apply --in-flight 1"]);
  assert.deepEqual(f.run(["impl-report", "impl-412"]).order, ["fleet-tick --apply --in-flight 7"]);
  const capsOnly = fixture({ rows: ["#412 impl-412=PR#88"], inFlight: null });
  assert.deepEqual(capsOnly.run(["impl-report", "impl-412"]).order, ["fleet-tick --apply"], "caps recorded without a bound pass no bound");
  const bare = fixture({ rows: ["#412 impl-412=PR#88"], caps: null, inFlight: null });
  assert.deepEqual(bare.run(["impl-report", "impl-412"]).order, ["fleet-tick --apply"]);
  const bad = f.run(["impl-report", "impl-412", "--in-flight", "0"]);
  assert.equal(bad.status, 2);
  assert.match(bad.err, /^fleet-event: --in-flight must be a whole number of at least 1, got '0'/m);
  assert.deepEqual(bad.order, [], "a usage refusal neither writes nor ticks");
});

test("the retired cap flags are refused before anything is written or ticked", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88"] });
  for (const flag of ["--implementer-cap", "--reviewer-cap"]) {
    const r = f.run(["impl-report", "impl-412", flag, "3"]);
    assert.equal(r.status, 2, `${flag}: ${r.err}`);
    assert.deepEqual(r.order, [], `${flag}: a usage refusal neither writes nor ticks`);
  }
});

// ── fix-report ───────────────────────────────────────────────────────────────

const FIX_ROW = `#412 impl-412=PR#88 · review=member:review-pr-88 · ${REVIEWED} · fix-pr-88`;

test("fix-report on a review fix-applier settles, runs dispositions-check for that member with the scratch root and prints its stdout, then ticks; a second run only ticks", () => {
  const f = fixture({ rows: [FIX_ROW] });
  f.brief("fix-pr-88", "review");
  f.control("settle", { "fix-pr-88": { outcome: `applied:${HEAD_B}` } });
  f.control("dispositions-check", { out: "dispositions: ok — 3 entries\n", ledger: ["token", "88", `dispositions-ok=fix-pr-88:${RUN}`] });
  const first = f.run(["fix-report", "fix-pr-88"]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.deepEqual(first.order, [
    `settle fix-pr-88 --from-report --reports ${join(f.scratch, "reports")}`,
    `dispositions-check --member fix-pr-88 --scratch ${f.scratch}`,
    TICK,
  ]);
  assert.ok(first.out.includes("dispositions: ok — 3 entries"), first.stdout);
  assert.match(eventLine(first), /settled fix-pr-88=applied:b+; dispositions checked \(exit 0\)/);

  const ledger = f.ledger();
  const second = f.run(["fix-report", "fix-pr-88"]);
  assert.equal(second.status, 0, second.err);
  assert.deepEqual(second.order, [TICK]);
  assert.match(eventLine(second), /dispositions already checked for fix-pr-88/);
  assert.equal(f.ledger(), ledger);
});

test("fix-report's dispositions-check exit 1 is a verdict, its exit 2 a NEED", () => {
  const f = fixture({ rows: [FIX_ROW] });
  f.brief("fix-pr-88", "dispositions-retry");
  f.control("settle", { "fix-pr-88": { outcome: "no-op" } });
  f.control("dispositions-check", { exit: 1, out: "survived[0]: dropped\n" });
  const verdict = f.run(["fix-report", "fix-pr-88"]);
  assert.equal(verdict.status, 0, verdict.err + verdict.stdout);
  assert.ok(verdict.out.includes("survived[0]: dropped"));

  const g = fixture({ rows: [FIX_ROW] });
  g.brief("fix-pr-88", "review");
  g.control("settle", { "fix-pr-88": { outcome: "no-op" } });
  g.control("dispositions-check", { exit: 2, err: "dispositions-check: cannot read review file\n" });
  const fault = g.run(["fix-report", "fix-pr-88"]);
  assert.equal(fault.status, 4, fault.err + fault.stdout);
  assert.match(fault.stdout, /^NEED dispositions-check fix-pr-88 — nothing judged \(exit 2\): dispositions-check: cannot read review file/m);
});

for (const [why, setup] of [
  ["a conflict fix-applier", (f) => f.brief("fix-pr-88", "conflict")],
  ["a red-check fixer", (f) => f.brief("fix-pr-88", "red-check")],
]) {
  test(`fix-report runs no dispositions-check for ${why}`, () => {
    const f = fixture({ rows: [FIX_ROW] });
    setup(f);
    f.control("settle", { "fix-pr-88": { outcome: `applied:${HEAD_B}` } });
    const r = f.run(["fix-report", "fix-pr-88"]);
    assert.equal(r.status, 0, r.err + r.stdout);
    assert.deepEqual(r.order.slice(1), [TICK]);
  });
}

test("fix-report runs no dispositions-check on a PR with no reviewed=, nor for a fix-applier settled failed", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88 · fix-pr-88"] });
  f.brief("fix-pr-88", "review");
  f.control("settle", { "fix-pr-88": { outcome: `applied:${HEAD_B}` } });
  assert.deepEqual(f.run(["fix-report", "fix-pr-88"]).order.slice(1), [TICK]);
  const g = fixture({ rows: [FIX_ROW] });
  g.brief("fix-pr-88", "review");
  g.control("settle", { "fix-pr-88": { outcome: "failed" } });
  assert.deepEqual(g.run(["fix-report", "fix-pr-88"]).order.slice(1), [TICK]);
});

test("fix-report with no brief on disk prints a NEED naming the check to run instead of guessing the fix-applier's job", () => {
  const f = fixture({ rows: [FIX_ROW] });
  f.control("settle", { "fix-pr-88": { outcome: "no-op" } });
  const r = f.run(["fix-report", "fix-pr-88"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.match(r.stdout, new RegExp(`^NEED dispositions-check fix-pr-88 — its brief .*fix-pr-88\\.json is unreadable \\(ENOENT\\).*run dispositions-check\\.mjs --member fix-pr-88 --scratch ${f.scratch}`, "m"));
});

// ── finisher-report ──────────────────────────────────────────────────────────

test("finisher-report on a halt settles, comments the halt's cause and evidence on the PR, then ticks; a second run only ticks", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88 · finisher-pr-88"] });
  f.report(finisherReport("finisher-pr-88", { outcome: "halted", cause: "rebase", evidence: "origin/main moved under the rebase", labelsReadBack: [] }));
  f.control("settle", { "finisher-pr-88": { outcome: "halted:rebase" } });
  const first = f.run(["finisher-report", "finisher-pr-88"]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.deepEqual(first.order, [`settle finisher-pr-88 --from-report --reports ${join(f.scratch, "reports")}`, "gh pr view 88", "gh pr comment 88", TICK]);
  const [comment] = f.gh().pr[88].comments;
  assert.match(comment, /finisher-pr-88 halted: `rebase`/);
  assert.match(comment, /origin\/main moved under the rebase/);

  const second = f.run(["finisher-report", "finisher-pr-88"]);
  assert.equal(second.status, 0, second.err);
  assert.deepEqual(writes(second.order), []);
  assert.equal(f.gh().pr[88].comments.length, 1);
});

test("finisher-report on a repair finisher whose read-back lacks the label posts the one-shot escalation with both read-backs, even though the settle refuses; a second run posts nothing", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88 · finisher-pr-88=labelled · finisher-pr-88-b"] });
  f.report(finisherReport("finisher-pr-88", { labelsReadBack: ["ready-to-merge", "patch"] }));
  f.report(finisherReport("finisher-pr-88-b", { labelsReadBack: ["patch"] }));
  f.control("settle", { "finisher-pr-88-b": { exit: 3, err: "ledger: failed: labelsReadBack carries ready-to-merge\n" } });
  const first = f.run(["finisher-report", "finisher-pr-88-b"]);
  assert.equal(first.status, 3, first.err + first.stdout);
  assert.deepEqual(first.order, [`settle finisher-pr-88-b --from-report --reports ${join(f.scratch, "reports")}`, "gh pr view 88", "gh pr comment 88", TICK]);
  const [comment] = f.gh().pr[88].comments;
  assert.match(comment, /finisher-pr-88-b read back: patch$/m);
  assert.match(comment, /finisher-pr-88 read back: ready-to-merge, patch$/m);

  const second = f.run(["finisher-report", "finisher-pr-88-b"]);
  assert.equal(second.status, 3);
  assert.ok(!second.order.includes("gh pr comment 88"), second.order.join("\n"));
  assert.equal(f.gh().pr[88].comments.length, 1);
});

test("finisher-report posts no escalation for a first finisher, nor for a repair finisher that read the label back", () => {
  for (const [member, rows] of [["finisher-pr-88", "#412 impl-412=PR#88 · finisher-pr-88"], ["finisher-pr-88-b", "#412 impl-412=PR#88 · finisher-pr-88=labelled · finisher-pr-88-b"]]) {
    const f = fixture({ rows: [rows] });
    f.report(finisherReport(member, { labelsReadBack: member.endsWith("-b") ? ["ready-to-merge"] : ["patch"] }));
    f.control("settle", { [member]: { exit: 3, err: "x\n" } });
    const r = f.run(["finisher-report", member]);
    assert.ok(!r.order.some((l) => l.startsWith("gh ")), `${member}: ${r.order.join("\n")}`);
  }
});

test("finisher-report's escalation quotes the latest earlier finisher's read-back, not the first", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88 · finisher-pr-88=labelled · finisher-pr-88-b=labelled · finisher-pr-88-c"] });
  f.report(finisherReport("finisher-pr-88", { labelsReadBack: ["ready-to-merge", "patch"] }));
  f.report(finisherReport("finisher-pr-88-b", { labelsReadBack: ["ready-to-merge", "minor"] }));
  f.report(finisherReport("finisher-pr-88-c", { labelsReadBack: ["patch"] }));
  f.control("settle", { "finisher-pr-88-c": { exit: 3, err: "ledger: failed: labelsReadBack carries ready-to-merge\n" } });
  const r = f.run(["finisher-report", "finisher-pr-88-c"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  const [comment] = f.gh().pr[88].comments;
  assert.match(comment, /finisher-pr-88-c read back: patch$/m);
  assert.match(comment, /finisher-pr-88-b read back: ready-to-merge, minor$/m);
  assert.doesNotMatch(comment, /finisher-pr-88 read back/);
});

test("with a remapped Label map the repair-finisher escalation compares the read-back against the mapped ready-to-merge, and names it", () => {
  const rows = ["#412 impl-412=PR#88 · finisher-pr-88=labelled · finisher-pr-88-b"];
  const lacks = fixture({ rows, labels: REMAP });
  lacks.report(finisherReport("finisher-pr-88", { labelsReadBack: ["merge-ready", "patch"] }));
  lacks.report(finisherReport("finisher-pr-88-b", { labelsReadBack: ["ready-to-merge", "patch"] }));
  lacks.control("settle", { "finisher-pr-88-b": { exit: 3, err: "ledger: failed: labelsReadBack carries merge-ready\n" } });
  const a = lacks.run(["finisher-report", "finisher-pr-88-b"]);
  assert.equal(a.status, 3, a.err + a.stdout);
  const [comment] = lacks.gh().pr[88].comments;
  assert.match(comment, /read back no `merge-ready` on PR #88/);
  assert.match(comment, /finisher-pr-88 read back: merge-ready, patch$/m);

  const has = fixture({ rows, labels: REMAP });
  has.report(finisherReport("finisher-pr-88-b", { labelsReadBack: ["merge-ready", "patch"] }));
  has.control("settle", { "finisher-pr-88-b": { exit: 3, err: "x\n" } });
  const b = has.run(["finisher-report", "finisher-pr-88-b"]);
  assert.ok(!b.order.some((l) => l.startsWith("gh ")), b.order.join("\n"));
});

// ── merge-bot-report ─────────────────────────────────────────────────────────

test("merge-bot-report writes a held-behind token onto each held PR's row, then settles, then ticks; a second run only ticks", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88", "#413 impl-413=PR#89", "#414 impl-414=PR#90"], dispatched: ["merge-bot-1"] });
  f.report(mergeBotReport("merge-bot-1", [{ pr: 89, behind: 88 }, { pr: 90, behind: 88 }]));
  f.control("settle", { "merge-bot-1": { outcome: "done" } });
  const first = f.run(["merge-bot-report", "merge-bot-1"]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.deepEqual(first.order, [
    "ledger token 89 held-behind:#88",
    "ledger token 90 held-behind:#88",
    `settle merge-bot-1 --from-report --reports ${join(f.scratch, "reports")}`,
    TICK,
  ]);
  assert.deepEqual(f.rows(), ["#412 impl-412=PR#88", "#413 impl-413=PR#89 · held-behind:#88", "#414 impl-414=PR#90 · held-behind:#88"]);

  const ledger = f.ledger();
  const second = f.run(["merge-bot-report", "merge-bot-1"]);
  assert.equal(second.status, 0, second.err);
  assert.deepEqual(second.order, [TICK]);
  assert.equal(f.ledger(), ledger);
});

// #3608: a main-gain refusal parks the PR, bound to the head and body digest
// the bot's gate reading records it refused — never to a gh read taken when
// the report is settled; every other refusal reason writes nothing.
const MG = "main-gain-removed:tests/gate.test.mjs";
const BODY = "Closes #413\r\n";
const gateReadingPath = (f) => join(f.scratch, "pr89", "merge-bot-1", "ci.json");
// merge-gate.mjs's `--out` line for its refusal of PR 89, each field of
// `over` replacing its own; a string is written as it stands.
function gateReading(f, over = {}) {
  mkdirSync(join(f.scratch, "pr89", "merge-bot-1"), { recursive: true });
  writeFileSync(gateReadingPath(f), typeof over === "string" ? over
    : JSON.stringify({ pr: 89, verdict: "blocked", reason: MG, head: HEAD, bodyDigest: bodyDigest(BODY), ...over }));
}

test("merge-bot-report parks a main-gain-removed refusal at the head and body digest its gate reading refused, reads no gh, ignores every other reason, then settles and ticks; a second run writes nothing", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88", "#413 impl-413=PR#89", "#414 impl-414=PR#90"], dispatched: ["merge-bot-1"] });
  f.setGh({ issue: {}, pr: { 89: { labels: ["ready-to-merge"], comments: [] } } });
  f.report(mergeBotReport("merge-bot-1", [], [
    { pr: 89, reason: MG },
    // One verdict per PR: each other reason refuses a PR of its own.
    { pr: 90, reason: "behind:2" },
    { pr: 91, reason: "ci:failure" },
    { pr: 92, reason: "instrument-set-changed" },
    { pr: 93, reason: "main-gain-unanswerable" },
  ]));
  gateReading(f);
  f.control("settle", { "merge-bot-1": { outcome: "done" } });
  const park = parkedToken(HEAD, bodyDigest(BODY), MG);
  assert.match(park, /^parked=a{40}:[0-9a-f]{12}:main-gain-removed:tests\/gate\.test\.mjs$/);
  const first = f.run(["merge-bot-report", "merge-bot-1"]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.deepEqual(first.order, [
    `ledger token 89 ${park}`,
    `settle merge-bot-1 --from-report --reports ${join(f.scratch, "reports")}`,
    TICK,
  ]);
  assert.deepEqual(f.rows(), ["#412 impl-412=PR#88", `#413 impl-413=PR#89 · ${park}`, "#414 impl-414=PR#90"]);
  assert.deepEqual(f.gh().pr[89].labels, ["ready-to-merge"], "the park moves no label");
  assert.deepEqual(f.ghCalls(), [], "no gh read: a head pushed or a body edited after the refusal is never what the park binds");

  const ledger = f.ledger();
  const second = f.run(["merge-bot-report", "merge-bot-1"]);
  assert.equal(second.status, 0, second.err);
  assert.deepEqual(writes(second.order), []);
  assert.equal(f.ledger(), ledger);
});

test("merge-bot-report whose gate reading cannot bind a main-gain park prints a NEED naming why, parks nothing, and still settles and ticks", () => {
  for (const [reading, why] of [
    [null, "cannot be read (ENOENT)"],
    ["{", "is not JSON"],
    ["null", "is not a JSON object"],
    [{ pr: 90 }, "is not this refusal"],
    [{ verdict: "mergeable" }, "is not this refusal"],
    [{ reason: "main-gain-removed:other.md" }, "is not this refusal"],
    [{ bodyDigest: null }, "carries no full head and body digest"],
    [{ bodyDigest: "not-a-digest" }, "carries no full head and body digest"],
    [{ head: "abc1234" }, "carries no full head and body digest"],
  ]) {
    const f = fixture({ rows: ["#413 impl-413=PR#89"], dispatched: ["merge-bot-1"] });
    f.report(mergeBotReport("merge-bot-1", [], [{ pr: 89, reason: MG }]));
    if (reading !== null) gateReading(f, reading);
    f.control("settle", { "merge-bot-1": { outcome: "done" } });
    const r = f.run(["merge-bot-report", "merge-bot-1"]);
    assert.equal(r.status, 4, `${why}: ${r.err}${r.stdout}`);
    assert.ok(r.stdout.includes(`NEED park PR #89 ${MG} — the gate reading ${gateReadingPath(f)} ${why}`), r.stdout);
    assert.deepEqual(writes(r.order), [`settle merge-bot-1 --from-report --reports ${join(f.scratch, "reports")}`], why);
    assert.deepEqual(f.rows(), ["#413 impl-413=PR#89"], why);
  }
});

// ── review-result ────────────────────────────────────────────────────────────

const REVIEW_ROW = "#412 impl-412=PR#88 · review=member:review-pr-88";
function reviewFile(f, { pr = 88, run = RUN, body = { pr: 88, head: HEAD, counts: { survived: 1, refuted: 2, unverified: 3 } } } = {}) {
  const dir = join(f.scratch, `pr${pr}`, run);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "review.json"), JSON.stringify(body));
  return join(dir, "review.json");
}

test("review-result records reviewed= off the result file's digest, its run the file's directory, then ticks; a second run only ticks", () => {
  const f = fixture({ rows: [REVIEW_ROW] });
  const path = reviewFile(f);
  const first = f.run(["review-result", "88", path]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.deepEqual(first.order, [`ledger review 88 ${REVIEWED}`, TICK]);
  assert.deepEqual(f.rows(), [`${REVIEW_ROW} · ${REVIEWED}`]);

  const ledger = f.ledger();
  const second = f.run(["review-result", "#88", path]);
  assert.equal(second.status, 0, second.err);
  assert.deepEqual(second.order, [TICK]);
  assert.equal(f.ledger(), ledger);
});

test("review-result refuses a path outside the PR's partition, writing nothing and ticking nothing", () => {
  const f = fixture({ rows: [REVIEW_ROW] });
  const ledger = f.ledger();
  for (const [path, why] of [
    [reviewFile(f, { pr: 89 }), /is not under PR #88's partition .*\/pr88\//],
    [join(f.scratch, "pr88", "nested", RUN, "review.json"), /is not under PR #88's partition/],
    [join(f.dir, "elsewhere", "pr88", RUN, "review.json"), /is not under PR #88's partition/],
    [`${f.scratch}/pr88/${RUN}/../${RUN}/review.json`, /has a "\.\." segment/],
    [reviewFile(f, { run: "not-a-run" }), /is not a review run root/],
  ]) {
    const r = f.run(["review-result", "88", path]);
    assert.equal(r.status, 2, `${path}: ${r.err}`);
    assert.match(r.err, why);
    assert.deepEqual(r.order, [], `${path}: nothing written, no tick`);
  }
  const other = f.run(["review-result", "88", reviewFile(f, { body: { pr: 89, head: HEAD, counts: { survived: 0, refuted: 0, unverified: 0 } } })]);
  assert.equal(other.status, 2);
  assert.match(other.err, /is PR #89's review, not #88's/);
  assert.equal(f.ledger(), ledger);
});

test("review-result passes the ledger's own refusal through, and still ticks", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88"] });
  const r = f.run(["review-result", "88", reviewFile(f)]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.match(r.err, /answers no open launch/);
  assert.equal(r.order.at(-1), TICK);
});

for (const [why, receiptIsLink] of [["the receipt names the symlink and the path the real directory", true], ["the receipt names the real directory and the path the symlink", false]]) {
  test(`review-result accepts a result file inside the PR's partition when ${why}`, () => {
    const f = fixture({ rows: [REVIEW_ROW] });
    const file = reviewFile(f);
    const link = join(f.dir, "scratch-link");
    symlinkSync(f.scratch, link);
    if (receiptIsLink) writeFileSync(join(f.fleet, "phase0.json"), JSON.stringify({ run: null, session: "", steps: {}, scratch: link, caps: { impl: 3, review: 5 }, inFlight: 7 }));
    const path = receiptIsLink ? file : join(link, "pr88", RUN, "review.json");
    const r = f.run(["review-result", "88", path]);
    assert.equal(r.status, 0, r.err + r.stdout);
    assert.deepEqual(r.order, [`ledger review 88 ${REVIEWED}`, TICK]);
    assert.deepEqual(f.rows(), [`${REVIEW_ROW} · ${REVIEWED}`]);
  });
}

// ── review-failed ────────────────────────────────────────────────────────────

test("review-failed settles the launch =failed in place and names the next free runner, then ticks; a second run only ticks and names it again", () => {
  const f = fixture({ rows: [REVIEW_ROW], retired: ["review-pr-88-b"] });
  const first = f.run(["review-failed", "88", "member:review-pr-88"]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.deepEqual(first.order, ["ledger review 88 review=member:review-pr-88=failed", TICK]);
  assert.deepEqual(f.rows(), ["#412 impl-412=PR#88 · review=member:review-pr-88=failed"]);
  assert.match(eventLine(first), /PR #88 review=member:review-pr-88=failed; next free runner review-pr-88-c$/);

  const ledger = f.ledger();
  const second = f.run(["review-failed", "88", "review=member:review-pr-88"]);
  assert.equal(second.status, 0, second.err);
  assert.deepEqual(second.order, [TICK]);
  assert.match(eventLine(second), /already review=member:review-pr-88=failed; next free runner review-pr-88-c$/);
  assert.equal(f.ledger(), ledger);
});

test("review-failed on a launch already =failed names the next free runner past a ## Retired line that carries an outcome", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88 · review=member:review-pr-88=failed"], retired: ["review-pr-88-b=failed"] });
  const r = f.run(["review-failed", "88", "member:review-pr-88"]);
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(r.order, [TICK]);
  assert.match(eventLine(r), /already review=member:review-pr-88=failed; next free runner review-pr-88-c$/);
});

test("review-failed on a launch already =failed refuses a ## Retired line naming no member or reviewer, naming it, and still ticks", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88 · review=member:review-pr-88=failed"], retired: ["garbage-name"] });
  const ledger = f.ledger();
  const r = f.run(["review-failed", "88", "member:review-pr-88"]);
  assert.equal(r.status, 2, r.err);
  assert.match(r.err, /## Retired has a line 'garbage-name' that names no member or reviewer — fix the ledger by hand before review can trust it/);
  assert.deepEqual(r.order, [TICK]);
  assert.match(eventLine(r), /already review=member:review-pr-88=failed; next free runner for PR #88 refused \(exit 2\)$/, "no runner name is offered");
  assert.equal(f.ledger(), ledger);
});

// ── ci ───────────────────────────────────────────────────────────────────────

const ciPayload = (over = {}) => JSON.stringify({ pr: 88, branch: "b", prHead: HEAD, runId: 123, attempt: 2, runHeadSha: HEAD, status: "completed", conclusion: "success", behind: 0, verdict: "green", reasons: [], ...over });
const DEGRADED = "WATCHER DEGRADED: no usable ci-state reading for #88 — silence is NOT green";

test("ci reads ci-state without --quiet and records the run's key on the PR's row, then ticks; a second run with the same key writes nothing, a rerun's key is new", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88 · ports=1"] });
  f.control("ci-state", { out: `${ciPayload({ conclusion: "failure", verdict: "not-green" })}\n`, exit: 1 });
  const first = f.run(["ci", "88"]);
  assert.equal(first.status, 0, "not-green exits 1 from ci-state and is an ordinary reading: " + first.err + first.stdout);
  assert.deepEqual(first.order, ["ci-state --pr 88", "ledger token 88 ci=123:2:failure", TICK]);
  assert.deepEqual(f.rows(), ["#412 impl-412=PR#88 · ports=1 · ci=123:2:failure"]);
  assert.match(eventLine(first), /^event: ci: #88 ci=123:2:failure$/);

  const ledger = f.ledger();
  const second = f.run(["ci", "#88"]);
  assert.equal(second.status, 0, second.err);
  assert.deepEqual(second.order, ["ci-state --pr 88", TICK]);
  assert.equal(f.ledger(), ledger);
  assert.match(eventLine(second), /#88 already ci=123:2:failure$/);

  f.control("ci-state", { out: `${ciPayload({ attempt: 3, conclusion: "success" })}\n` });
  const rerun = f.run(["ci", "88"]);
  assert.deepEqual(rerun.order, ["ci-state --pr 88", "ledger token 88 ci=123:3:success", TICK]);
  assert.deepEqual(f.rows(), ["#412 impl-412=PR#88 · ports=1 · ci=123:2:failure · ci=123:3:success"]);
});

for (const conclusion of ["", null, undefined]) {
  test(`ci keys an in-progress run's ${JSON.stringify(conclusion)} conclusion as -, never as a terminal one, while a real conclusion passes through`, () => {
    const f = fixture({ rows: ["#412 impl-412=PR#88"] });
    f.control("ci-state", { out: `${ciPayload({ status: "in_progress", conclusion, verdict: "not-green" })}\n`, exit: 1 });
    const r = f.run(["ci", "88"]);
    assert.equal(r.status, 0, r.err + r.stdout);
    assert.deepEqual(r.order, ["ci-state --pr 88", "ledger token 88 ci=123:2:-", TICK]);
    assert.deepEqual(f.rows(), ["#412 impl-412=PR#88 · ci=123:2:-"]);
    f.control("ci-state", { out: `${ciPayload({ conclusion: "cancelled", verdict: "not-green" })}\n`, exit: 1 });
    assert.deepEqual(f.run(["ci", "88"]).order.at(1), "ledger token 88 ci=123:2:cancelled", "the real conclusion is a new key beside the in-progress one");
  });
}

for (const [why, control] of [
  ["no verdict", { out: `${JSON.stringify({ pr: 88, runId: 1, attempt: 1, conclusion: "success" })}\n` }],
  ["a rate-limited verdict", { out: `${JSON.stringify({ pr: 88, verdict: "rate-limited" })}\n`, exit: 2 }],
  ["an empty verdict", { out: `${JSON.stringify({ pr: 88, verdict: "", runId: 1, attempt: 1, conclusion: "success" })}\n` }],
  ["output that is no JSON", { out: "garbage\n", exit: 2 }],
  ["no output at all", { exit: 2 }],
]) {
  test(`ci prints WATCHER DEGRADED and writes nothing for ${why}, then still ticks`, () => {
    const f = fixture({ rows: ["#412 impl-412=PR#88"] });
    f.control("ci-state", control);
    const ledger = f.ledger();
    const r = f.run(["ci", "88"]);
    assert.equal(r.status, 0, r.err + r.stdout);
    assert.ok(r.out.includes(DEGRADED), "at the left margin, whole: " + r.stdout);
    assert.deepEqual(r.order, ["ci-state --pr 88", TICK]);
    assert.equal(f.ledger(), ledger);
  });
}

test("ci writes nothing and prints no degraded line for a verdict that binds no run (no-ci)", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88"] });
  f.control("ci-state", { out: `${ciPayload({ verdict: "no-ci", runId: null, attempt: null, conclusion: null })}\n`, exit: 1 });
  const ledger = f.ledger();
  const r = f.run(["ci", "88"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.ok(!r.out.some((l) => l.startsWith("WATCHER")), r.stdout);
  assert.match(eventLine(r), /#88 ci: verdict no-ci binds no run, nothing to record$/);
  assert.deepEqual(r.order, ["ci-state --pr 88", TICK]);
  assert.equal(f.ledger(), ledger);
});

for (const [missing, over] of [["attempt", { attempt: null }], ["runId", { runId: null }]]) {
  test(`ci writes nothing for a payload with no ${missing}, whichever other half of the run key it carries`, () => {
    const f = fixture({ rows: ["#412 impl-412=PR#88"] });
    f.control("ci-state", { out: `${ciPayload(over)}\n` });
    const ledger = f.ledger();
    const r = f.run(["ci", "88"]);
    assert.equal(r.status, 0, r.err + r.stdout);
    assert.match(eventLine(r), /#88 ci: verdict green binds no run, nothing to record$/);
    assert.deepEqual(r.order, ["ci-state --pr 88", TICK]);
    assert.equal(f.ledger(), ledger);
  });
}

test("ci passes a ledger refusal through and still ticks", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88"] });
  f.control("ci-state", { out: `${ciPayload({ conclusion: "a b" })}\n` });
  const r = f.run(["ci", "88"]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.match(r.err, /is not one token/);
  assert.equal(r.order.at(-1), TICK);
});

// ── label ────────────────────────────────────────────────────────────────────

test("label writes nothing and only ticks, with no fold", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88"] });
  const ledger = f.ledger();
  const r = f.run(["label", "88"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(r.order, [TICK]);
  assert.match(eventLine(r), /^event: label: nothing to record$/);
  assert.equal(f.ledger(), ledger);
});

// ── conflict ─────────────────────────────────────────────────────────────────

// Whether the tick's own fold of the fixture ledger reads PR `pr`'s conflict hold as open.
function holdOpen(f, pr) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, "ledger-real.mjs"), "read"], { cwd: f.repo, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, r.stderr);
  return foldLedger(JSON.parse(r.stdout), new Set(), { lenient: true }).byPr.get(pr)?.conflictOpen;
}

test("conflict writes the bare hold token onto the PR's row, then ticks; a second hold is refused with nothing written, and the tick still runs", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88 · ports=1"] });
  const first = f.run(["conflict", "88"]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.deepEqual(first.order, ["ledger token 88 conflict-hold:#88", TICK]);
  assert.deepEqual(f.rows(), ["#412 impl-412=PR#88 · ports=1 · conflict-hold:#88"]);
  assert.equal(holdOpen(f, 88), true);
  assert.match(eventLine(first), /^event: conflict: #88 conflict-hold:#88$/);

  const ledger = f.ledger();
  const second = f.run(["conflict", "88"]);
  assert.equal(second.status, 2, second.err + second.stdout);
  assert.match(second.err, /^fleet-event: conflict: PR #88's row already carries an unresolved conflict hold — nothing written$/m);
  assert.deepEqual(second.order, [TICK]);
  assert.equal(f.ledger(), ledger);
  assert.equal(second.out.at(-1), "TICK ROWS");
});

test("conflict refuses a hold the merge bot wrote, since that one is unresolved too", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88 · conflict-hold:#88"] });
  const ledger = f.ledger();
  const r = f.run(["conflict", "88"]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.deepEqual(r.order, [TICK]);
  assert.equal(f.ledger(), ledger);
});

test("conflict accepts a PR whose one hold a fix-applier has answered: it writes the other spelling, which the tick reads as a fresh hold", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88 · conflict-hold:#88 · fix-pr-88=no-op"] });
  assert.equal(holdOpen(f, 88), false, "the fixture's hold is answered");
  const r = f.run(["conflict", "88"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(r.order, ["ledger token 88 conflict-hold-#88", TICK]);
  assert.equal(holdOpen(f, 88), true);
});

test("conflict refuses a PR whose row carries both spellings, answered or not, rather than repeating a no-op", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88 · conflict-hold:#88 · fix-pr-88=no-op · conflict-hold-#88 · fix-pr-88-b=no-op"] });
  assert.equal(holdOpen(f, 88), false);
  const ledger = f.ledger();
  const r = f.run(["conflict", "88"]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.match(r.err, /already carries every spelling of a conflict hold the tick reads — nothing written/);
  assert.deepEqual(r.order, [TICK]);
  assert.equal(f.ledger(), ledger);
});

test("conflict accepts a row that carries other holds and another PR's conflict row", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88 · held-behind:#80", "#413 impl-413=PR#89 · conflict-hold:#89"] });
  const r = f.run(["conflict", "88"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(f.rows(), ["#412 impl-412=PR#88 · held-behind:#80 · conflict-hold:#88", "#413 impl-413=PR#89 · conflict-hold:#89"]);
});

// ── heartbeat ────────────────────────────────────────────────────────────────

test("heartbeat writes nothing and ticks with --fold-unchanged, which no other kind passes", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88"] });
  const ledger = f.ledger();
  const r = f.run(["heartbeat"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(r.order, [`${TICK} --fold-unchanged`]);
  assert.match(eventLine(r), /^event: heartbeat: nothing to record$/);
  assert.equal(f.ledger(), ledger);
  assert.deepEqual(f.run(["heartbeat", "--in-flight", "4"]).order, ["fleet-tick --apply --in-flight 4 --fold-unchanged"]);
});

// ── drain ────────────────────────────────────────────────────────────────────

test("drain runs closeout.mjs begin with the reason, which drains and releases the claim, then ticks; a second run drains and releases nothing again", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  const first = f.run(["drain", "--reason", "end of the night"]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.deepEqual(first.order, [
    "ledger drain end of the night",
    "release-ticket 412 impl-412 implementer --apply",
    "ledger settle impl-412=released",
    TICK,
  ]);
  assert.match(first.stdout, /^closeout: drain: ok$/m);
  assert.match(first.stdout, /^closeout: release: ok$/m);
  assert.match(eventLine(first), /^event: drain: drain begun$/);
  assert.match(f.ledger(), /end of the night/);
  assert.deepEqual(f.rows(), ["#412 impl-412=released"]);

  const ledger = f.ledger();
  const second = f.run(["drain", "--reason", "end of the night"]);
  assert.equal(second.status, 0, second.err + second.stdout);
  assert.deepEqual(second.order, [TICK], "closeout's receipt holds both steps ok, so begin writes nothing");
  assert.equal(f.ledger(), ledger);
});

test("drain prints a claim closeout could not release as its NEED line, exits 4, and still ticks", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.control("release-ticket", { exit: 1, out: JSON.stringify({ issue: 412, released: false, applied: true, blockers: ["worktree has uncommitted changes"] }) });
  const r = f.run(["drain", "--reason", "stop"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.ok(r.out.includes("NEED hand-release #412 worktree has uncommitted changes"), r.stdout);
  assert.match(eventLine(r), /^event: drain: drain begun, a claim to hand-release$/);
  assert.equal(r.order.at(-1), TICK);
  assert.equal(r.out.at(-1), "TICK ROWS");
});

test("undrain runs closeout.mjs reopen with the reason, prints its output, which clears the marker, then ticks", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  assert.equal(f.run(["drain", "--reason", "end of the night"]).status, 0);
  const r = f.run(["undrain", "--reason", "drained by mistake"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(r.order.at(-1), TICK);
  assert.match(r.stdout, /^closeout: reopen: ok$/m);
  assert.match(r.stdout, /^ {2}\{"undrained":"end of the night","reason":"drained by mistake"\}$/m, "the reason reached ledger.mjs undrain through reopen");
  assert.match(eventLine(r), /^event: undrain: undrain reopened$/);
  assert.doesNotMatch(f.ledger(), /end of the night/);
});

test("undrain with no drain marker refuses with exit 2 and writes nothing", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  const before = f.ledger();
  const r = f.run(["undrain", "--reason", "mistake"]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.match(r.err + r.stdout, /nothing to undrain/);
  assert.equal(f.ledger(), before);
});

// ── usage ────────────────────────────────────────────────────────────────────

test("usage refusals exit 2 before any write or tick: no kind, an unknown kind, a wrong arity, a member of another family, a launch already =failed", () => {
  const f = fixture({ rows: [REVIEW_ROW] });
  for (const [args, why] of [
    [[], /^fleet-event: usage: fleet-event\.mjs <kind>/m],
    [["bogus-kind", "88"], /^fleet-event: unknown kind 'bogus-kind'/m],
    [["ci"], /^fleet-event: ci takes <pr>/m],
    [["ci", "x"], /^fleet-event: ci: 'x' is not a PR number/m],
    [["conflict", "0"], /^fleet-event: conflict: '0' is not a PR number/m],
    [["heartbeat", "88"], /^fleet-event: heartbeat takes no arguments/m],
    [["drain"], /^fleet-event: drain takes --reason/m],
    [["undrain"], /^fleet-event: undrain takes --reason/m],
    [["drain", "--reason", "  "], /^fleet-event: --reason needs a value/m],
    [["drain", "now", "--reason", "r"], /^fleet-event: drain takes no arguments/m],
    [["label", "88", "--reason", "r"], /^fleet-event: --reason belongs to drain and undrain, not label/m],
    [["impl-report"], /^fleet-event: impl-report takes <member>/m],
    [["impl-report", "fix-pr-88"], /^fleet-event: impl-report takes a member of the impl family, not 'fix-pr-88'/m],
    [["review-result", "x", "/p"], /^fleet-event: review-result: 'x' is not a PR number/m],
    [["review-failed", "88", "member:review-pr-88=failed"], /is not a launch/],
  ]) {
    const r = f.run(args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.err}`);
    assert.match(r.err, why);
    assert.deepEqual(r.order, []);
  }
});

test("a retry member is accepted: impl-report impl-412-b settles under its own name", () => {
  const f = fixture({ rows: ["#412 impl-412=bailed · impl-412-b"] });
  f.report(implReport("impl-412-b"));
  f.control("settle", { "impl-412-b": { outcome: "PR#88" } });
  const r = f.run(["impl-report", "impl-412-b"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(r.order[0], `settle impl-412-b --from-report --reports ${join(f.scratch, "reports")}`);
});

test("gh runs with GIT_DIR scrubbed and GH_REPO blank, so an ambient one cannot aim the relabel at another repository", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.report(bail("impl-412", "undecided", "x"));
  f.control("settle", { "impl-412": { outcome: "bailed" } });
  f.control("dispatch-prompt", { out: "c\n" });
  const r = f.run(["impl-report", "impl-412"], { env: { GH_REPO: "other/repo", GIT_DIR: join(f.dir, "nowhere") } });
  assert.notEqual(r.status, null, r.err);
  const calls = f.ghCalls();
  assert.ok(calls.length > 0);
  for (const c of calls) assert.deepEqual([c.GH_REPO, c.GIT_DIR], ["", null], JSON.stringify(c));
});

// ── arg.mjs and the instruments pin cover the script ─────────────────────────

test("arg.mjs: the script binds defineFlags and refuses an unknown flag in the shared wording, before it looks at git", () => {
  assert.match(readFileSync(join(REAL_SCRIPTS, "fleet-event.mjs"), "utf8"), /^import \{[^}]*\bdefineFlags\b[^}]*\} from "\.\/arg\.mjs";$/m);
  const r = spawnSync(process.execPath, [join(REAL_SCRIPTS, "fleet-event.mjs"), "impl-report", "impl-1", "--bogus"], { cwd: tempDir("fleet-event-nogit-"), encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^fleet-event: unknown flag --bogus/m);
});

test("the instruments pin covers fleet-event.mjs: a rewrite of it is a changed instrument set, and an untracked file beside it is not", () => {
  const dir = realpathSync(tempDir("fleet-event-pin-"));
  mkdirSync(join(dir, "plugin", "scripts"), { recursive: true });
  cpSync(join(REAL_SCRIPTS, "fleet-event.mjs"), join(dir, "plugin", "scripts", "fleet-event.mjs"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "i");
  // The pin certifies the Install root: a fixture HOME whose package entry
  // links to this checkout's plugin/, so the real install is never read.
  const home = realpathSync(tempDir("fleet-event-home-"));
  mkdirSync(join(home, ".omp", "plugins", "node_modules", "@feigi"), { recursive: true });
  symlinkSync(join(dir, "plugin"), join(home, ".omp", "plugins", "node_modules", "@feigi", "fleet-ctl"));
  const pin = (...a) => spawnSync("sh", [join(REAL_SCRIPTS, "instruments.sh"), ...a], { cwd: dir, encoding: "utf8", env: { ...GIT_ENV, HOME: home } });
  assert.equal(pin("--pin").status, 0);
  assert.equal(pin().status, 0, "unchanged");
  writeFileSync(join(dir, "plugin", "scripts", "scratch.txt"), "untracked\n");
  assert.equal(pin().status, 0, "an untracked file is no instrument");
  writeFileSync(join(dir, "plugin", "scripts", "fleet-event.mjs"), `${readFileSync(join(dir, "plugin", "scripts", "fleet-event.mjs"), "utf8")}\n// edited\n`);
  const changed = pin();
  assert.equal(changed.status, 1);
  assert.match(changed.stdout + changed.stderr, /fleet-event\.mjs/);
});

// ── member-died ──────────────────────────────────────────────────────────────

// The session directory member-died reads: the transcripts and markers the
// session leaves beside them. `seen` is the tick's heartbeat stamp per member,
// null for no heartbeat file at all.
function sessionDir(f, files = [], seen = null) {
  const dir = join(f.dir, "session");
  mkdirSync(dir, { recursive: true });
  for (const name of files) writeFileSync(join(dir, name), "");
  if (seen !== null) writeFileSync(join(f.fleet, "heartbeat.json"), JSON.stringify({ seen }));
  return dir;
}
const minutesAgo = (m) => Date.now() - m * 60_000;
// The live row each family is settled from: impl on an issue row, the rest dispatched.
const liveFor = (member) => (member.startsWith("impl-") ? { rows: [`#412 ${member}`] } : { dispatched: [member] });

// A refusal names what was found, writes nothing, and never reaches the tick.
function assertRefused(f, args, message) {
  const ledger = f.ledger();
  const r = f.run(["member-died", ...args]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.match(r.err, message);
  assert.deepEqual(writes(r.order), []);
  assert.ok(!r.order.some((l) => l.startsWith("fleet-tick ")), "a refusal is not ticked");
  assert.equal(f.ledger(), ledger, "the ledger is byte-identical");
}

for (const [member, markers, outcome] of [
  ["fix-pr-88", ["fix-pr-88.md"], "failed"],
  ["finisher-pr-88", ["finisher-pr-88.md"], "failed"],
  ["merge-bot-3", ["merge-bot-3.md"], "killed"],
  ["fix-pr-88", ["fix-pr-88.md", "fix-pr-88.jsonl.tombstone", "fix-pr-88.jsonl"], "killed"],
  ["impl-412", ["impl-412.jsonl.tombstone"], "killed"],
  ["finisher-pr-88", ["finisher-pr-88.jsonl.tombstone"], "killed"],
  ["merge-bot-3", ["merge-bot-3.jsonl.tombstone"], "killed"],
]) {
  test(`member-died settles ${member}=${outcome} from ${markers.join(", ")} with no outcome argument, then ticks; a second run only ticks`, () => {
    const f = fixture(liveFor(member));
    const dir = sessionDir(f, markers);
    const first = f.run(["member-died", member, "--session", dir]);
    assert.equal(first.status, 0, first.err + first.stdout);
    assert.deepEqual(first.order, [`ledger settle ${member} ${outcome}`, TICK]);
    assert.match(eventLine(first), new RegExp(`^event: member-died: settled ${member}=${outcome}$`));
    assert.equal(first.out.at(-1), "TICK ROWS");

    const ledger = f.ledger();
    const second = f.run(["member-died", member, "--session", dir]);
    assert.equal(second.status, 0, second.err);
    assert.deepEqual(second.order, [TICK], "the settled token is found and nothing is written again");
    assert.match(eventLine(second), new RegExp(`${member}=${outcome} already settled`));
    assert.equal(f.ledger(), ledger);
  });
}

for (const [member, outcome] of [["impl-412", "killed"], ["fix-pr-88", "killed"], ["finisher-pr-88", "killed"], ["merge-bot-3", "killed"]]) {
  test(`member-died settles ${member}=${outcome} from a stamp older than five minutes with no transcript and no marker: never dispatched or never started`, () => {
    const f = fixture(liveFor(member));
    const dir = sessionDir(f, [], { [member]: minutesAgo(6) });
    const r = f.run(["member-died", member, "--session", dir]);
    assert.equal(r.status, 0, r.err + r.stdout);
    assert.deepEqual(r.order, [`ledger settle ${member} ${outcome}`, TICK]);
  });
}

test("member-died with a stamp under five minutes and no transcript refuses: the transcript may not be written yet", () => {
  const f = fixture(liveFor("fix-pr-88"));
  const dir = sessionDir(f, [], { "fix-pr-88": minutesAgo(2) });
  assertRefused(f, ["fix-pr-88", "--session", dir], /first seen 2 min ago/);
});

test("member-died's five-minute bound is inclusive: a stamp exactly five minutes old refuses, one a millisecond older settles", () => {
  const now = 1_800_000_000_000;
  for (const [age, settles] of [[5 * 60_000, false], [5 * 60_000 + 1, true]]) {
    const f = fixture(liveFor("fix-pr-88"));
    const dir = sessionDir(f, [], { "fix-pr-88": now - age });
    // The child's clock, frozen, so the bound is measured to the millisecond.
    const clock = join(f.dir, "clock.mjs");
    writeFileSync(clock, `Date.now = () => ${now};\n`);
    const ledger = f.ledger();
    const r = f.run(["member-died", "fix-pr-88", "--session", dir], { env: { NODE_OPTIONS: `--import ${pathToFileURL(clock).href}` } });
    if (settles) {
      assert.equal(r.status, 0, r.err + r.stdout);
      assert.deepEqual(r.order, ["ledger settle fix-pr-88 killed", TICK]);
    } else {
      assert.equal(r.status, 2, r.err + r.stdout);
      assert.match(r.err, /first seen 5 min ago, not yet past the 5-minute no-transcript bound/);
      assert.deepEqual(writes(r.order), []);
      assert.equal(f.ledger(), ledger);
    }
  }
});

test("member-died with no first-seen stamp and no transcript refuses: the tick never saw the token live", () => {
  const f = fixture(liveFor("fix-pr-88"));
  const dir = sessionDir(f, [], {});
  assertRefused(f, ["fix-pr-88", "--session", dir], /no first-seen stamp/);
});

test("member-died with no transcript and a heartbeat.json that is not JSON refuses on the file itself: its lost stamps are no missing stamp", () => {
  const f = fixture(liveFor("fix-pr-88"));
  const dir = sessionDir(f);
  writeFileSync(join(f.fleet, "heartbeat.json"), "{not json");
  assertRefused(f, ["fix-pr-88", "--session", dir], /^fleet-event: member-died fix-pr-88: \S*heartbeat\.json is not JSON — nothing written$/m);
});

test("member-died on a member with a transcript and no marker refuses: running or parked, so census, kill, then rerun", () => {
  const f = fixture(liveFor("fix-pr-88"));
  const dir = sessionDir(f, ["fix-pr-88.jsonl"], { "fix-pr-88": minutesAgo(30) });
  assertRefused(f, ["fix-pr-88", "--session", dir], /has a transcript/);
});

test("member-died on an impl with a .md and no tombstone refuses, naming agent://<member>: settle it by hand", () => {
  const f = fixture(liveFor("impl-412"));
  const dir = sessionDir(f, ["impl-412.md"]);
  assertRefused(f, ["impl-412", "--session", dir], /agent:\/\/impl-412/);
});

for (const [member, build, kind] of [
  ["impl-412", implReport, "impl-report"],
  ["finisher-pr-88", finisherReport, "finisher-report"],
]) {
  test(`member-died on ${member} with its report on disk refuses, naming ${kind} ${member}`, () => {
    const f = fixture(liveFor(member));
    const dir = sessionDir(f, [`${member}.md`]);
    f.report(build(member));
    assert.ok(existsSync(join(f.scratch, "reports", `${member}.json`)));
    assertRefused(f, [member, "--session", dir], new RegExp(`${kind} ${member} settles it`));
  });
}

test("every member family the ledger grammar parses has a report kind, so member-died's report-on-disk refusal never names undefined", () => {
  for (const family of MEMBER_FAMILIES) assert.ok(reportKind(family) !== undefined, `no fleet-event.mjs kind settles the ${family} family's report`);
  assert.equal(reportKind("fix-pr"), "fix-report");
});

test("member-died on a member the ledger already holds settled notes it and ticks, even with its report on disk: the settled note runs ahead of the report refusal", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88"] });
  const dir = sessionDir(f, ["impl-412.md"]);
  f.report(implReport("impl-412"));
  const ledger = f.ledger();
  const r = f.run(["member-died", "impl-412", "--session", dir]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(r.order, [TICK]);
  assert.match(eventLine(r), /impl-412=PR#88 already settled/);
  assert.equal(f.ledger(), ledger);
});

test("member-died on a member whose report on disk is invalid refuses, naming the violation: its report kind cannot settle from it either", () => {
  const f = fixture(liveFor("fix-pr-88"));
  const dir = sessionDir(f, ["fix-pr-88.md"]);
  writeFileSync(join(f.scratch, "reports", "fix-pr-88.json"), "{not json");
  assertRefused(f, ["fix-pr-88", "--session", dir], /fix-report cannot settle from it \(\$: not JSON/);
});

test("member-died with its report on disk and no session directory refuses naming the report kind: the report refuses ahead of the session lookup", () => {
  const f = fixture(liveFor("finisher-pr-88"));
  f.report(finisherReport("finisher-pr-88"));
  assertRefused(f, ["finisher-pr-88"], /finisher-report finisher-pr-88 settles it/);
});

test("member-died on a review runner refuses, naming review-failed for its PR and launch", () => {
  const f = fixture();
  const dir = sessionDir(f, ["review-pr-88.md"]);
  assertRefused(f, ["review-pr-88", "--session", dir], /review-failed 88 member:review-pr-88/);
});

test("member-died on a name that is no ledger member refuses as a usage error", () => {
  const f = fixture();
  const dir = sessionDir(f);
  assertRefused(f, ["memory-1", "--session", dir], /not a ledger member/);
});

test("member-died with no session directory from the receipt or --session refuses", () => {
  const f = fixture(liveFor("fix-pr-88"));
  assertRefused(f, ["fix-pr-88"], /needs the session directory/);
});

test("member-died with an outcome argument is a usage error: the outcome comes from the session listing", () => {
  const f = fixture(liveFor("impl-412"));
  const dir = sessionDir(f, ["impl-412.jsonl.tombstone"]);
  const r = f.run(["member-died", "impl-412", "killed", "--session", dir]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.deepEqual(writes(r.order), []);
});

test("member-died takes the receipt's session over --session when the receipt names one, and says on stderr which --session it did not read", () => {
  const receipt = join(tempDir("fleet-event-sess-"), "receipt");
  mkdirSync(receipt, { recursive: true });
  writeFileSync(join(receipt, "impl-412.jsonl.tombstone"), "");
  const f = fixture({ rows: ["#412 impl-412"], session: receipt });
  const unused = join(tempDir("fleet-event-sess-"), "unused");
  const r = f.run(["member-died", "impl-412", "--session", unused]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(r.order, ["ledger settle impl-412 killed", TICK]);
  assert.ok(r.err.includes(`reads ${receipt}, this run's phase-0 receipt's session, not --session ${unused}`), r.err);

  // The same directory both ways is no override, and nothing is said.
  const g = fixture({ rows: ["#412 impl-412"], session: receipt });
  const same = g.run(["member-died", "impl-412", "--session", receipt]);
  assert.equal(same.status, 0, same.err + same.stdout);
  assert.ok(!same.err.includes("not --session"), same.err);
});

test("member-died takes no session from another run's receipt: --session is the directory read, as the tick reads it", () => {
  const stale = join(tempDir("fleet-event-sess-"), "stale");
  mkdirSync(stale, { recursive: true });
  const f = fixture({ rows: ["#412 impl-412"], session: stale });
  // Run 1999's receipt, and no controller record naming that run.
  const receipt = JSON.parse(readFileSync(join(f.fleet, "phase0.json"), "utf8"));
  writeFileSync(join(f.fleet, "phase0.json"), JSON.stringify({ ...receipt, run: 1999 }));
  const dir = sessionDir(f, ["impl-412.jsonl"], { "impl-412": minutesAgo(30) });
  assertRefused(f, ["impl-412", "--session", dir], /has a transcript and no marker/);
});

test("member-died with a receipt session whose directory does not exist yet reads it as empty, as the tick does", () => {
  const receipt = join(tempDir("fleet-event-sess-"), "not-yet");
  const f = fixture({ rows: ["#412 impl-412"], session: receipt });
  writeFileSync(join(f.fleet, "heartbeat.json"), JSON.stringify({ seen: { "impl-412": minutesAgo(9) } }));
  const r = f.run(["member-died", "impl-412"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(r.order, ["ledger settle impl-412 killed", TICK]);
});

test("member-died with --session naming a directory that does not exist, and no receipt session, refuses even with an old stamp: a mistyped path is not an empty session", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  writeFileSync(join(f.fleet, "heartbeat.json"), JSON.stringify({ seen: { "impl-412": minutesAgo(9) } }));
  assertRefused(f, ["impl-412", "--session", join(f.dir, "no-such-session")], /cannot list the session directory .*no-such-session \(ENOENT\)/);
});

test("--session belongs to member-died: another kind refuses it as a usage error", () => {
  const f = fixture();
  const r = f.run(["impl-report", "impl-412", "--session", "/tmp/x"]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.deepEqual(writes(r.order), []);
});

