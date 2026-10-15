// `fleet-event.mjs`: a member's report recorded as one command — the writes
// its wake owes, then `fleet-tick.mjs --apply`.
//
// Every case runs the real script from a throwaway repository whose `.fleet/`
// holds a fixture ledger, a phase-0 receipt naming the scratch root and the
// caps, and the rendered briefs. The scripts directory is a copy of the
// plugin's in which `fleet-tick.mjs`, `dispositions-check.mjs`,
// `dispatch-prompt.mjs` and `release-ticket.sh` are stubs that log their call
// to `order.log` and answer from a control file the case writes, and
// `ledger.mjs` is a shim: `settle --from-report` is stubbed — it logs, then
// refuses as the control file says, or prints the control file's own stdout
// and stderr and exits 0, or settles the outcome the control file names
// through the real script's bare form — and every other subcommand
// is the real script's, its writes logged. `gh` is a stub on PATH that keeps
// each issue's and PR's labels and comments in a state file, so a second run
// reads what the first one wrote. No network, no omp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";

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
if (isCLI(import.meta.url)) drive("fleet-tick", process.argv.slice(2));
`);
// dispositions-check.mjs is only ever run, never imported, by the scripts.
writeFileSync(join(SCRIPTS, "dispositions-check.mjs"), `import { drive } from "./stub-driver.mjs";\ndrive("dispositions-check", process.argv.slice(2));\n`);
// dispatch-prompt.mjs runs on import, so nothing imports it: a plain stub.
writeFileSync(join(SCRIPTS, "dispatch-prompt.mjs"), `import { drive } from "./stub-driver.mjs";\ndrive("dispatch-prompt", process.argv.slice(2));\n`);
writeFileSync(join(SCRIPTS, "release-ticket.sh"), `#!/bin/sh\nexec node "$(dirname "$0")/stub-driver.mjs" release-ticket "$@"\n`);
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

// Keeps each issue's and PR's labels and comments in gh-state.json; a
// `<noun> <verb>` listed in gh-fail.json fails.
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
  process.stdout.write(JSON.stringify({ labels: item.labels.map((name) => ({ name })), comments: item.comments.map((body) => ({ body })) }));
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
const mergeBotReport = (member, held) => ({ member, merged: [], held, conflictHold: [], refused: [], branchKept: [] });

// A main checkout with a fixture ledger, a phase-0 receipt naming the scratch
// root and caps 3 and 5, and the gh stub on PATH.
function fixture({ rows = [], dispatched = [], retired = [], caps = { impl: 3, review: 5 } } = {}) {
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
  writeFileSync(join(fleet, "ledger.md"), ledgerText({ rows, dispatched, retired }));
  writeFileSync(join(fleet, "phase0.json"), JSON.stringify({ run: null, session: "", steps: {}, scratch, ...(caps === null ? {} : { caps }) }));
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

const TICK = "fleet-tick --apply --implementer-cap 3 --reviewer-cap 5";
// The calls that write: everything but a ledger read, a gh view and the tick.
const writes = (order) => order.filter((l) => !/^gh \w+ view /.test(l) && !l.startsWith("fleet-tick "));
const eventLine = (r) => r.out.find((l) => l.startsWith("event: "));

// ── impl-report ──────────────────────────────────────────────────────────────

test("impl-report settles from the report under the receipt's scratch, then ticks with --apply and the receipt's caps; a second run only ticks", () => {
  const f = fixture({ rows: ["#412 impl-412"] });
  f.control("settle", { "impl-412": { outcome: "PR#88" } });
  const first = f.run(["impl-report", "impl-412"]);
  assert.equal(first.status, 0, first.err + first.stdout);
  assert.deepEqual(first.order, [`settle impl-412 --from-report --reports ${join(f.scratch, "reports")}`, TICK]);
  assert.match(eventLine(first), /^event: impl-report: settled impl-412=PR#88$/);
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

for (const [cause, label, detail, kindArgs] of [
  ["undecided", "needs-triage", "which flag spelling wins", ["--kind", "needs-triage", "--line", "which flag spelling wins"]],
  ["fork", "ready-for-human", "keep the cache or drop it", ["--kind", "fork", "--options", "keep the cache or drop it"]],
  ["hands", "ready-for-human", "external access: the staging database", ["--kind", "hands", "--hands", "external access", "--line", "the staging database"]],
  ["hands", "ready-for-human", "judgment the rollout order", ["--kind", "hands", "--hands", "judgment during the work", "--line", "the rollout order"]],
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
  f.control("settle", { "impl-412": { raw: true, out: JSON.stringify({ outcome: "PR#88" }), err: "ledger: warning: a note\n" } });
  const r = f.run(["impl-report", "impl-412"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.match(r.err, /^ledger: warning: a note$/m);
  assert.match(eventLine(r), /settled impl-412=PR#88/);
});

// ── caps ─────────────────────────────────────────────────────────────────────

test("the caps are each flag as given, else the receipt's, else none: the tick's own default", () => {
  const f = fixture({ rows: ["#412 impl-412=PR#88"] });
  assert.deepEqual(f.run(["impl-report", "impl-412", "--reviewer-cap", "9"]).order, ["fleet-tick --apply --implementer-cap 3 --reviewer-cap 9"]);
  assert.deepEqual(f.run(["impl-report", "--implementer-cap", "1", "impl-412"]).order, ["fleet-tick --apply --implementer-cap 1 --reviewer-cap 5"]);
  const bare = fixture({ rows: ["#412 impl-412=PR#88"], caps: null });
  assert.deepEqual(bare.run(["impl-report", "impl-412"]).order, ["fleet-tick --apply"]);
  const bad = f.run(["impl-report", "impl-412", "--implementer-cap", "0"]);
  assert.equal(bad.status, 2);
  assert.match(bad.err, /^fleet-event: --implementer-cap must be a whole number of at least 1, got '0'/m);
  assert.deepEqual(bad.order, [], "a usage refusal neither writes nor ticks");
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
    if (receiptIsLink) writeFileSync(join(f.fleet, "phase0.json"), JSON.stringify({ run: null, session: "", steps: {}, scratch: link, caps: { impl: 3, review: 5 } }));
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

// ── usage ────────────────────────────────────────────────────────────────────

test("usage refusals exit 2 before any write or tick: no kind, an unknown kind, a wrong arity, a member of another family, a launch already =failed", () => {
  const f = fixture({ rows: [REVIEW_ROW] });
  for (const [args, why] of [
    [[], /^fleet-event: usage: fleet-event\.mjs <kind>/m],
    [["ci", "88"], /^fleet-event: unknown kind 'ci'/m],
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
  const pin = (...a) => spawnSync("sh", [join(REAL_SCRIPTS, "instruments.sh"), ...a], { cwd: dir, encoding: "utf8", env: GIT_ENV });
  assert.equal(pin("--pin").status, 0);
  assert.equal(pin().status, 0, "unchanged");
  writeFileSync(join(dir, "plugin", "scripts", "scratch.txt"), "untracked\n");
  assert.equal(pin().status, 0, "an untracked file is no instrument");
  writeFileSync(join(dir, "plugin", "scripts", "fleet-event.mjs"), `${readFileSync(join(dir, "plugin", "scripts", "fleet-event.mjs"), "utf8")}\n// edited\n`);
  const changed = pin();
  assert.equal(changed.status, 1);
  assert.match(changed.stdout + changed.stderr, /fleet-event\.mjs/);
});
