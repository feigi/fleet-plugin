// `phase0.mjs`: phase 0 as one command that runs the start sequence in order
// and writes `.fleet/phase0.json`.
//
// Every case runs the real script against a throwaway repository (a real
// clone of a real bare origin) with a copy of the plugin's scripts directory in
// which each external step is replaced by a stub that logs its call and answers
// from a control file the case writes. `ledger.mjs` stays real except for
// `rotate` (unless PH0_REAL_ROTATE is set), whose controller record needs an
// `omp` process above the caller and so is written by the stub; `gh` is a stub
// on PATH. No network, no omp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { IN_FLIGHT_DEFAULT, STEP_NAMES } from "../plugin/scripts/phase0-receipt.mjs";

const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));
const REAL_SCRIPTS = join(PLUGIN, "scripts");
const RUN_AT = 1_700_000_000_000;

const GIT_ENV = { ...process.env };
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;
delete GIT_ENV.GH_REPO;
// phase0.mjs falls back to it when --session is absent, and a suite run from
// an omp Python eval cell inherits the real session's.
delete GIT_ENV.PI_ARTIFACTS_DIR;
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

// What every stub is: log the call, then answer from `<name>.json` in the
// case's control directory — `{exit, out, err}`, or `by[<args>]` for a script
// whose answer turns on its arguments, keyed by the whole argv joined, else by
// its first word.
const DRIVER = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.PH0_STUBS;
const control = (name) => {
  try {
    return JSON.parse(readFileSync(join(dir, name + ".json"), "utf8"));
  } catch {
    return {};
  }
};
const log = (name, extra = {}) => {
  appendFileSync(join(dir, "order.log"), name + "\\n");
  appendFileSync(join(dir, name + ".calls"), JSON.stringify(extra) + "\\n");
};

export function drive(name, args) {
  log(name, { args, cwd: process.cwd(), GIT_DIR: process.env.GIT_DIR ?? null });
  const c = control(name);
  const spec = (c.by && (c.by[args.join(" ")] || c.by[args[0]])) || c;
  process.stdout.write(spec.out ?? "");
  process.stderr.write(spec.err ?? "");
  process.exit(spec.exit ?? 0);
}

// What \`ledger.mjs rotate\` leaves behind that phase 0 reads: the controller
// record, with the \`at\` the case chose.
export function rotate() {
  const fleet = join(process.cwd(), ".fleet");
  log("rotate", { args: ["rotate"], sawReceipt: existsSync(join(fleet, "phase0.json")) });
  const c = control("rotate");
  process.stderr.write(c.err ?? "");
  if (c.exit) process.exit(c.exit);
  if (c.noRecord) process.exit(0);
  mkdirSync(fleet, { recursive: true });
  writeFileSync(join(fleet, "heartbeat.json"), JSON.stringify({
    quiet: 0, digest: "", controller: { pid: 4242, lstart: "fixture", prior: "dead", at: c.at ?? ${RUN_AT} },
  }));
  process.exit(0);
}

if (process.argv[1].endsWith("stub-driver.mjs")) drive(process.argv[2], process.argv.slice(3));
`;

const MJS_STUBS = ["main-checkout", "preflight", "tier-roles", "metrics-refresh", "board", "reclaim-scratch", "stranded", "shortlist", "fleet-heartbeat"];
const SH_STUBS = ["instruments", "derive-testcmd"];

// The plugin's scripts directory, copied once, with the external steps
// replaced. `ledger.mjs` becomes a shim: `rotate` is the stub's, every other
// subcommand the real script's.
const TREE = tempDir("phase0-tree-");
cpSync(PLUGIN, join(TREE, "plugin"), { recursive: true });
const SCRIPTS = join(TREE, "plugin", "scripts");
const STUBBED = join(SCRIPTS, "stub-driver.mjs");
writeFileSync(STUBBED, DRIVER);
// Two of them are imported by other scripts for their exports, so the real
// module stays importable behind the stub and only its command line is replaced.
const IMPORTED = ["main-checkout", "tier-roles"];
for (const n of MJS_STUBS) {
  if (IMPORTED.includes(n)) {
    cpSync(join(SCRIPTS, `${n}.mjs`), join(SCRIPTS, `${n}-real.mjs`));
    writeFileSync(join(SCRIPTS, `${n}.mjs`), `export * from "./${n}-real.mjs";
import { drive } from "./stub-driver.mjs";
import { isCLI } from "./is-cli.mjs";
if (isCLI(import.meta.url)) drive(${JSON.stringify(n)}, process.argv.slice(2));
`);
  } else {
    writeFileSync(join(SCRIPTS, `${n}.mjs`), `import { drive } from "./stub-driver.mjs";\ndrive(${JSON.stringify(n)}, process.argv.slice(2));\n`);
  }
}
for (const n of SH_STUBS) writeFileSync(join(SCRIPTS, `${n}.sh`), `#!/bin/sh\nexec node "$(dirname "$0")/stub-driver.mjs" ${n} "$@"\n`);
cpSync(join(SCRIPTS, "ledger.mjs"), join(SCRIPTS, "ledger-real.mjs"));
writeFileSync(join(SCRIPTS, "ledger.mjs"), `if (process.argv[2] === "rotate" && !process.env.PH0_REAL_ROTATE) {
  (await import("./stub-driver.mjs")).rotate();
} else {
  await import("./ledger-real.mjs");
}
`);
const SCRIPT = join(SCRIPTS, "phase0.mjs");

const GH_STUB = `#!/bin/sh
printf 'gh\\n' >> "$PH0_STUBS/order.log"
printf '%s GH_REPO=[%s] GIT_DIR=[%s]\\n' "$*" "\${GH_REPO-}" "\${GIT_DIR-}" >> "$PH0_STUBS/gh.calls"
if [ -f "$PH0_STUBS/gh.fail" ]; then echo "gh boom" >&2; exit 1; fi
cat "$PH0_STUBS/gh.json"
`;

// The omp the controller alarm is armed for. Phase 0 runs as a child of the
// test process, and the test process runs under this omp (see `REAL_TABLE`).
const OMP = 2_000_000_002;
// The proc table: phase 0 is a child of this test process, which runs under
// the omp, so the walk up from phase 0 finds the omp as its controller.
const REAL_TABLE = { [process.pid]: { ppid: OMP, argv: [process.execPath, "--test"], lstart: "runner-start" }, [OMP]: { ppid: 1, argv: ["bun", "/home/u/.bun/bin/omp"], lstart: "omp-start" } };
// Every external step the script reaches, in the order it reaches them, per
// step: the stub names its work shows up under in `order.log`.
const STEPS = [
  ["alarm", []],
  ["branch", []], ["fast-forward", []], ["pin", ["instruments"]], ["baseline", ["main-checkout"]],
  ["preflight", ["preflight"]], ["ruleset", ["ruleset"]], ["tier-roles", ["tier-roles"]],
  ["metrics", ["metrics-refresh"]], ["cockpit", ["board"]], ["rotate", ["rotate"]],
  ["reclaim", ["reclaim-scratch"]], ["recipe", ["derive-testcmd"]], ["fold-in", ["gh"]],
  ["stranded", ["stranded"]], ["shortlist", ["shortlist"]],
];
const NAMES = STEPS.map(([n]) => n);

const wait = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A main checkout cloned from a bare origin, a home directory of its own (the
// scratch root lands under it), a session directory and the control files.
function fixture({ spec = false } = {}) {
  const dir = realpathSync(tempDir("phase0-"));
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  const stubs = join(dir, "stubs");
  const bin = join(dir, "bin");
  const session = join(dir, "session");
  for (const d of [home, stubs, bin, session]) mkdirSync(d);
  writeFileSync(`${session}.jsonl`, "");
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, repo);
  writeFileSync(join(repo, "README"), "x\n");
  git(repo, "add", "README");
  git(repo, "commit", "-q", "-m", "root");
  git(repo, "push", "-q", "-u", "origin", "main");
  writeExecStub(join(bin, "gh"), GH_STUB);
  writeFileSync(join(stubs, "gh.json"), "[]");
  writeFileSync(join(stubs, "stranded.json"), JSON.stringify({ out: JSON.stringify({ prior: "dead", claims: [], carried: [] }) }));
  if (spec) {
    mkdirSync(join(repo, ".github", "rulesets"), { recursive: true });
    mkdirSync(join(repo, ".github", "scripts"), { recursive: true });
    writeFileSync(join(repo, ".github", "rulesets", "main.json"), "{}");
    writeFileSync(join(repo, ".github", "scripts", "apply-ruleset.sh"), `#!/bin/sh\nexec node "${STUBBED}" ruleset "$@"\n`);
  }
  const procTable = join(dir, "proc-table.json");
  writeFileSync(procTable, JSON.stringify(REAL_TABLE));
  const fleet = join(repo, ".fleet");
  const receiptPath = join(fleet, "phase0.json");
  const f = {
    dir, repo, home, stubs, session, origin, procTable,
    control: (name, value) => writeFileSync(join(stubs, `${name}.json`), JSON.stringify(value)),
    calls: (name) => (existsSync(join(stubs, `${name}.calls`)) ? readFileSync(join(stubs, `${name}.calls`), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
    order: () => (existsSync(join(stubs, "order.log")) ? readFileSync(join(stubs, "order.log"), "utf8").trim().split("\n") : []),
    receiptPath,
    receipt: () => JSON.parse(readFileSync(receiptPath, "utf8")),
    setReceipt: (r) => {
      mkdirSync(fleet, { recursive: true });
      writeFileSync(receiptPath, JSON.stringify(r));
    },
    setRecord: (at) => {
      mkdirSync(fleet, { recursive: true });
      writeFileSync(join(fleet, "heartbeat.json"), JSON.stringify({ quiet: 0, digest: "", controller: { pid: 4242, lstart: "fixture", prior: "dead", at } }));
    },
    asides: () => readdirSync(fleet).filter((n) => /^phase0\.\d.+\.json$/.test(n)),
    ledgerRow: (key, text) => {
      const r = spawnSync(process.execPath, [join(SCRIPTS, "ledger.mjs"), "row", String(key), text], { cwd: repo, encoding: "utf8", env: GIT_ENV });
      assert.equal(r.status, 0, r.stderr);
    },
    ledgerRows: () => {
      const r = spawnSync(process.execPath, [join(SCRIPTS, "ledger.mjs"), "read"], { cwd: repo, encoding: "utf8", env: GIT_ENV });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).rows;
    },
    // The matching record by default: this omp's pid and start time, and this `.fleet/`.
    alarm: (value = { pid: OMP, lstart: "omp-start", fleet }) => {
      mkdirSync(join(home, ".fleet", "alarm"), { recursive: true });
      writeFileSync(join(home, ".fleet", "alarm", `${OMP}.json`), typeof value === "string" ? value : JSON.stringify(value));
    },
    disarm: () => rmSync(join(home, ".fleet", "alarm"), { recursive: true, force: true }),
    run: (args = null, { env = {}, cwd = repo, script = SCRIPT } = {}) => {
      const r = spawnSync(process.execPath, [script, ...(args ?? ["--session", session])], {
        cwd, encoding: "utf8",
        env: { ...GIT_ENV, HOME: home, PATH: `${bin}:${process.env.PATH}`, PH0_STUBS: stubs, FLEET_PROC_TABLE: procTable, ...env },
      });
      const out = r.stdout.split("\n").filter(Boolean);
      return { status: r.status, out, err: r.stderr, stdout: r.stdout };
    },
  };
  f.alarm();
  return f;
}

// Every step ran and none failed: the status of each, by name.
const statuses = (receipt) => Object.fromEntries(NAMES.map((n) => [n, receipt.steps[n]?.status]));
const allOk = Object.fromEntries(NAMES.map((n) => [n, "ok"]));
const stepLines = (out) => out.filter((l) => l.startsWith("phase0: "));

test("a clean run passes every step in order, writes one receipt and exits 0", () => {
  const f = fixture({ spec: true });
  const r = f.run();
  assert.equal(r.status, 0, r.err);
  assert.deepEqual(stepLines(r.out).map((l) => l.split(": ")[1]), NAMES, "one line per step, in order");
  assert.ok(stepLines(r.out).every((l) => /^phase0: [a-z-]+: ok\b/.test(l)), r.stdout);
  const receipt = f.receipt();
  assert.deepEqual(statuses(receipt), allOk);
  assert.deepEqual(Object.keys(receipt.steps), NAMES);
  assert.deepEqual(NAMES, [...STEP_NAMES], "the receipt readers name the steps phase0.mjs writes");
  assert.equal(receipt.run, RUN_AT, "run is the at the rotation wrote into the controller record");
  assert.equal(receipt.session, f.session);
  assert.equal(receipt.scratch.startsWith(join(f.home, ".fleet", "scratch")), true, receipt.scratch);
  assert.equal(Object.hasOwn(receipt, "caps"), false, "the retired cap flags leave no field in the receipt");
  assert.equal(receipt.inFlight, 5, "the receipt records the bound the run used: the default, with no --in-flight");
  for (const n of NAMES) {
    assert.match(receipt.steps[n].at, /^\d{4}-\d\d-\d\dT/, `${n} carries a time`);
    assert.ok(receipt.steps[n].output.length > 0, `${n} records its output`);
  }
  // The scripts ran in the runbook's order. The cockpit is detached, so its
  // own line in the log lands whenever it starts.
  const order = f.order().filter((n) => n !== "board");
  assert.deepEqual(order, ["instruments", "main-checkout", "preflight", "ruleset", "tier-roles", "metrics-refresh", "rotate", "reclaim-scratch", "reclaim-scratch", "derive-testcmd", "derive-testcmd", "gh", "stranded", "shortlist"]);
  assert.deepEqual(f.calls("instruments")[0].args, ["--pin"]);
  assert.deepEqual(f.calls("main-checkout")[0].args, ["--record"]);
  assert.deepEqual(f.calls("preflight")[0].args, []);
  assert.deepEqual(f.calls("ruleset")[0].args, ["--check"]);
  assert.deepEqual(f.calls("tier-roles")[0].args, ["--check", "--in-flight", "5"]);
  assert.deepEqual(f.calls("reclaim-scratch")[0].args, ["--root", receipt.scratch, "--after-rotate", "--apply"]);
  assert.deepEqual(f.calls("reclaim-scratch")[1].args, ["--siblings", "--root", receipt.scratch, "--apply"]);
  assert.deepEqual(f.calls("derive-testcmd").map((c) => c.args), [[".", "install"], [".", "test", "--at", "origin/main"]]);
  for (let i = 0; i < 40 && f.calls("board").length === 0; i++) wait(100);
  assert.deepEqual(f.calls("board")[0].args, ["serve", "--open"]);
  assert.equal(f.calls("board")[0].cwd, f.repo);
});

test("every flag reaches the step that owns it", () => {
  const f = fixture();
  const plugin = join(f.dir, "plugin-checkout");
  const spend = join(f.dir, "spend");
  const r = f.run(["--session", f.session, "--in-flight", "3", "--plugin-checkout", plugin, "--spend-dir", spend, "--workflow", "CI"]);
  assert.equal(r.status, 0, r.err);
  const receipt = f.receipt();
  assert.deepEqual(f.calls("instruments")[0].args, ["--pin", "--audit", plugin]);
  assert.deepEqual(f.calls("tier-roles")[0].args, ["--check", "--in-flight", "3"], "--in-flight reaches tier-roles, the step that owns it");
  assert.deepEqual(f.calls("preflight")[0].args, [], "preflight.mjs takes no arguments, so the CI flag is recorded and never passed");
  assert.match(receipt.steps.preflight.output, /CI: workflow CI/);
  for (let i = 0; i < 40 && f.calls("board").length === 0; i++) wait(100);
  assert.deepEqual(f.calls("board")[0].args, ["serve", "--open", "--spend-dir", spend]);

  const g = fixture();
  assert.equal(g.run(["--session", g.session, "--declare-no-ci"]).status, 0);
  assert.match(g.receipt().steps.preflight.output, /CI: declared absent/);
});

test("tier-roles gets the in-flight bound: --in-flight when given, else the default, and the receipt records the bound", () => {
  const cases = [
    [[], "5"],
    [["--in-flight", "7"], "7"],
    [["--in-flight", "11"], "11"],
  ];
  for (const [flags, bound] of cases) {
    const f = fixture();
    const r = f.run(["--session", f.session, ...flags]);
    const why = `flags: ${flags.join(" ") || "none"}`;
    assert.equal(r.status, 0, `${why}: ${r.stdout}${r.err}`);
    assert.deepEqual(f.calls("tier-roles")[0].args, ["--check", "--in-flight", bound], why);
    const receipt = f.receipt();
    assert.equal(receipt.inFlight, Number(bound), `${why}: the receipt records the bound`);
    assert.match(receipt.steps["tier-roles"].output, new RegExp(`\\(in-flight bound ${bound}\\)$`), "the step records the bound it checked");
  }
});

// Behaviour cannot tell an import from a literal of the same value, so the
// single definition is read off the source: both readers of the default name
// the export, and neither carries a value of its own.
test("the default bound has one definition, which phase0.mjs and the tick both import", () => {
  assert.equal(IN_FLIGHT_DEFAULT, 5);
  const phase0 = readFileSync(join(REAL_SCRIPTS, "phase0.mjs"), "utf8");
  assert.match(phase0, /^import \{[^}]*\bIN_FLIGHT_DEFAULT\b[^}]*\} from "\.\/phase0-receipt\.mjs";$/m);
  assert.match(phase0, /positive\("in-flight"\) \?\? IN_FLIGHT_DEFAULT;/);
  const tick = readFileSync(join(REAL_SCRIPTS, "fleet-tick.mjs"), "utf8");
  assert.match(tick, /^import \{[^}]*\bIN_FLIGHT_DEFAULT\b[^}]*\} from "\.\/phase0-receipt\.mjs";$/m);
  assert.match(tick, /"in-flight": \{ type: "string", default: String\(IN_FLIGHT_DEFAULT\) \}/);
});

// The suite stubs tier-roles.mjs, so a stub accepts any argv: the one command
// line phase 0 builds is also run through the real script, whose flag parser
// refuses what it does not know and what it requires.
test("the tier-roles command line phase 0 builds is accepted by the real tier-roles.mjs", () => {
  const f = fixture();
  assert.equal(f.run().status, 0, "phase 0 with no --in-flight: the command line its default builds");
  const argv = f.calls("tier-roles")[0].args;
  const agents = join(f.dir, "agents");
  mkdirSync(agents);
  writeFileSync(join(agents, "fleet-a.agent.md"), "---\nname: fleet-a\ndescription: fixture\nmodel: @slow:xhigh\n---\n\nFollow the dispatch brief.\n");
  const json = (name, value) => {
    const p = join(f.dir, name);
    writeFileSync(p, JSON.stringify(value));
    return p;
  };
  const effort = ["low", "medium", "high", "xhigh", "max"];
  const install = [
    "--agents", agents,
    "--overrides", json("overrides.json", {}),
    "--model-roles", json("model-roles.json", { slow: "anthropic/claude-opus-5:auto", task: "anthropic/claude-sonnet-5:auto", smol: "anthropic/claude-haiku-4-5:auto" }),
    "--catalog", json("catalog.json", { models: [
      { provider: "anthropic", id: "claude-opus-5", selector: "anthropic/claude-opus-5", thinking: effort },
      { provider: "anthropic", id: "claude-sonnet-5", selector: "anthropic/claude-sonnet-5", thinking: effort },
      { provider: "anthropic", id: "claude-haiku-4-5", selector: "anthropic/claude-haiku-4-5", thinking: ["minimal", "low", "medium", "high", "xhigh"] },
    ] }),
    "--max-concurrency", json("max-concurrency.json", 32),
  ];
  const r = spawnSync(process.execPath, [join(REAL_SCRIPTS, "tier-roles.mjs"), ...argv, ...install], { cwd: f.repo, encoding: "utf8", env: { ...GIT_ENV, HOME: f.home } });
  assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}, never 2 (a usage refusal): ${argv.join(" ")}\n${r.stdout}${r.stderr}`);
  const bare = spawnSync(process.execPath, [join(REAL_SCRIPTS, "tier-roles.mjs"), "--check", ...install], { cwd: f.repo, encoding: "utf8", env: { ...GIT_ENV, HOME: f.home } });
  assert.equal(bare.status, 2, "the real script refuses --check without --in-flight, so the run above is a control that discriminates");
  assert.match(bare.stderr, /--in-flight is required/);
});

test("tier-roles: a notice printed on a pass reaches the step's output and stdout, and the step stays ok", () => {
  const f = fixture();
  const notice = "tier-roles: notice: task.maxConcurrency is 3, below 2·5+2 = 12 for In-flight bound 5";
  f.control("tier-roles", { out: `${notice}\n` });
  const r = f.run();
  assert.equal(r.status, 0, `${r.stdout}${r.err}`);
  const step = f.receipt().steps["tier-roles"];
  assert.equal(step.status, "ok");
  assert.ok(step.output.includes(notice), step.output);
  assert.ok(r.out.includes(`    ${notice}`), r.stdout);
});

// One case per step: its refusal exits 3, the receipt names it `failed` with the
// step's own output, every step before it is ok and every step after it is
// pending and was never run.
const REFUSALS = [
  ["alarm", (f) => f.disarm(), /controller alarm is not armed.*restart omp$/m],
  ["alarm", (f) => f.alarm("{not json"), /is not JSON.*restart omp$/m],
  ["alarm", (f) => f.alarm("null"), /is not an object.*restart omp$/m],
  ["alarm", (f) => f.alarm({ pid: OMP, lstart: "omp-start" }), /lacks fleet.*restart omp$/m],
  ["alarm", (f) => f.alarm({ pid: OMP + 1, lstart: "omp-start", fleet: join(f.repo, ".fleet") }), /names pid .*restart omp$/m],
  ["alarm", (f) => f.alarm({ pid: OMP, lstart: "a-previous-omp", fleet: join(f.repo, ".fleet") }), /started at .*restart omp$/m],
  ["alarm", (f) => f.alarm({ pid: String(OMP), lstart: "omp-start", fleet: join(f.repo, ".fleet") }), /names pid (\d+), but this omp is pid \1 .*restart omp$/m],
  ["alarm", (f) => f.alarm([]), /\.json is not an object.*restart omp$/m],
  ["alarm", (f) => f.alarm({ pid: OMP, lstart: "omp-start", fleet: join(f.dir, "elsewhere", ".fleet") }), /names fleet .*restart omp$/m],
  ["alarm", (f) => writeFileSync(f.procTable, JSON.stringify({ [process.pid]: { ppid: 1, argv: [process.execPath, "--test"], lstart: "runner-start" } })), /no omp process above phase 0.*restart omp$/m],
  ["alarm", (f) => writeFileSync(f.procTable, "not json"), /cannot read the process table.*restart omp$/m],
  ["branch", (f) => git(f.repo, "switch", "-q", "-c", "other"), /HEAD is refs\/heads\/other, not refs\/heads\/main/],
  ["fast-forward", (f) => git(f.repo, "remote", "set-url", "origin", join(f.dir, "no-such-origin.git")), /git fetch origin failed/],
  ["pin", (f) => f.control("instruments", { exit: 1, err: "instruments: nothing to certify" }), /instruments: nothing to certify/],
  ["baseline", (f) => f.control("main-checkout", { exit: 1, err: "MAIN-CHECKOUT-DIRTY: README" }), /MAIN-CHECKOUT-DIRTY: README/],
  ["preflight", (f) => f.control("preflight", { exit: 1, out: "ok gh-auth\nFAIL label:in-progress: missing\nFAIL ruleset: none\nPREFLIGHT FAILED: label:in-progress, ruleset" }), /FAIL label:in-progress: missing\nFAIL ruleset: none/],
  ["preflight", (f) => f.control("preflight", { exit: 2, err: "preflight: cannot write the marker" }), /preflight: cannot write the marker/],
  ["tier-roles", (f) => f.control("tier-roles", { exit: 1, err: "tier-roles: no modelRoles.slow" }), /tier-roles: no modelRoles\.slow/],
  ["metrics", (f) => f.control("metrics-refresh", { exit: 1, err: "metrics-refresh: drain failed" }), /metrics-refresh: drain failed/],
  ["metrics", (f) => f.control("metrics-refresh", { exit: 2, err: "metrics-refresh: usage" }), /metrics-refresh: usage/],
  ["rotate", (f) => f.control("rotate", { exit: 2, err: "refusing to rotate: the controller that owns it is alive" }), /the controller that owns it is alive/],
  ["recipe", (f) => f.control("derive-testcmd", { by: { ". install": { exit: 3, err: "derive-testcmd: no node" }, ". test --at origin/main": {} } }), /derive-testcmd: no node/],
  ["fold-in", (f) => writeFileSync(join(f.stubs, "gh.fail"), ""), /gh pr list failed: exit 1\ngh boom/],
  ["stranded", (f) => f.control("stranded", { exit: 2, err: "stranded: gh issue list failed" }), /stranded: gh issue list failed/],
  ["shortlist", (f) => f.control("shortlist", { exit: 2, err: "shortlist: the scan did not answer" }), /shortlist: the scan did not answer/],
];
for (const [step, arrange, shows] of REFUSALS) {
  test(`${step}: a refusal exits 3, is failed in the receipt with its output, and nothing after it runs (${shows.source.slice(0, 28)})`, () => {
    const f = fixture();
    arrange(f);
    const r = f.run();
    assert.equal(r.status, 3, `${r.stdout}${r.err}`);
    const receipt = f.receipt();
    const at = NAMES.indexOf(step);
    assert.deepEqual(statuses(receipt), Object.fromEntries(NAMES.map((n, i) => [n, i < at ? "ok" : i === at ? "failed" : "pending"])));
    assert.match(receipt.steps[step].output, shows);
    for (const n of NAMES.slice(at + 1)) assert.equal(receipt.steps[n].output, "not run", `${n} was not run`);
    assert.match(r.stdout, new RegExp(`^phase0: ${step}: failed`, "m"));
    assert.deepEqual(stepLines(r.out).map((l) => l.split(": ")[1]), NAMES.slice(0, at + 1), "the script stops at the failed step");
    const reached = new Set(STEPS.slice(0, at + 1).flatMap(([, names]) => names));
    assert.deepEqual(f.order().filter((n) => n !== "board" && !reached.has(n)), [], "a stub after the failed step ran");
  });
}

test("alarm: a matching file passes, the step is first and ok, and the run goes on to branch", () => {
  const f = fixture();
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  assert.deepEqual(stepLines(r.out).slice(0, 2).map((l) => l.split(": ")[1]), ["alarm", "branch"]);
  assert.match(r.stdout, /^phase0: alarm: ok/m);
  assert.equal(f.receipt().steps.alarm.status, "ok");
  assert.equal(f.receipt().steps.alarm.output, `controller alarm armed: pid ${OMP}, ${join(f.repo, ".fleet")}`);
});

test("alarm: a refusal the file's appearance clears is re-run by the next run, not skipped as ok", () => {
  const f = fixture();
  f.disarm();
  const refused = f.run();
  assert.equal(refused.status, 3, refused.stdout + refused.err);
  assert.equal(f.receipt().steps.alarm.status, "failed");
  f.alarm();
  const again = f.run();
  assert.equal(again.status, 0, again.stdout + again.err);
  assert.match(again.stdout, /^phase0: alarm: ok/m);
  assert.equal(again.stdout.includes("alarm: ok (done earlier in this run)"), false);
  assert.deepEqual(statuses(f.receipt()), allOk);
});

test("alarm: a resumed run re-checks the alarm, an ok one included, and refuses when this omp's file is gone", () => {
  const f = fixture();
  f.control("derive-testcmd", { by: { ". install": { exit: 1, err: "no Recipe cache" }, ". test --at origin/main": {} } });
  assert.equal(f.run().status, 4);
  assert.equal(f.receipt().steps.alarm.status, "ok");
  f.disarm();
  f.control("derive-testcmd", { by: { ". install": { out: "npm ci" }, ". test --at origin/main": { out: "./agent-test" } } });
  const again = f.run();
  assert.equal(again.status, 3, again.stdout + again.err);
  assert.match(again.stdout, /^phase0: alarm: failed — controller alarm is not armed/m);
  assert.equal(f.receipt().steps.alarm.status, "failed");
  assert.equal(f.calls("rotate").length, 1, "the resumed run stopped at the alarm");
});

test("a failed preflight prints every FAIL line on stdout and none of the passing ones", () => {
  const f = fixture();
  f.control("preflight", { exit: 1, out: "ok gh-auth\nFAIL label:in-progress: missing\nFAIL ruleset: none\nPREFLIGHT FAILED: label:in-progress, ruleset" });
  const r = f.run();
  assert.equal(r.status, 3);
  assert.ok(r.out.some((l) => l.includes("FAIL label:in-progress: missing")), r.stdout);
  assert.ok(r.out.some((l) => l.includes("FAIL ruleset: none")), r.stdout);
  assert.ok(!r.stdout.includes("ok gh-auth"), "a passing check line is not part of the report");
});

test("a preflight that exits 1 without a FAIL line reports what it printed", () => {
  const f = fixture();
  f.control("preflight", { exit: 1, out: "some diagnostic that is not FAIL-prefixed", err: "gh: auth required" });
  const r = f.run();
  assert.equal(r.status, 3);
  assert.match(f.receipt().steps.preflight.output, /gh: auth required/);
  assert.match(r.stdout, /some diagnostic that is not FAIL-prefixed/);
});

test("a fast-forward that moves HEAD prints SUPERSEDED, fails, and a re-run starts from the new tree", () => {
  const f = fixture();
  const other = join(f.dir, "other");
  git(f.dir, "clone", "-q", f.origin, other);
  for (const n of ["a", "b"]) {
    writeFileSync(join(other, n), n);
    git(other, "add", n);
    git(other, "commit", "-q", "-m", n);
  }
  git(other, "push", "-q", "origin", "main");
  const before = git(f.repo, "rev-parse", "HEAD");
  const r = f.run();
  assert.equal(r.status, 3, r.stdout + r.err);
  assert.match(r.stdout, /^phase0: fast-forward: failed — SUPERSEDED 2 commits; re-run phase0\.mjs$/m);
  assert.equal(f.receipt().steps["fast-forward"].output, "SUPERSEDED 2 commits; re-run phase0.mjs");
  assert.notEqual(git(f.repo, "rev-parse", "HEAD"), before, "the checkout did fast-forward");
  assert.deepEqual(f.order(), [], "nothing past the fast-forward ran, the pin least of all");
  const again = f.run();
  assert.equal(again.status, 0, again.stdout + again.err);
  assert.deepEqual(statuses(f.receipt()), allOk);
});

test("ruleset: drift and unanswered are recorded and the run goes on; a workspace with no spec skips the check", () => {
  const f = fixture({ spec: true });
  f.control("ruleset", { exit: 3, err: "apply-ruleset: ruleset main does NOT match\n- required: check" });
  let r = f.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  assert.equal(f.receipt().steps.ruleset.status, "drift");
  assert.match(f.receipt().steps.ruleset.output, /- required: check/);
  assert.match(r.stdout, /^phase0: ruleset: drift/m);
  assert.equal(f.receipt().steps.shortlist.status, "ok", "the run went on past the drift");

  const g = fixture({ spec: true });
  g.control("ruleset", { exit: 2, err: "apply-ruleset: no gh" });
  r = g.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  assert.equal(g.receipt().steps.ruleset.status, "unanswered");

  const h = fixture();
  r = h.run();
  assert.equal(r.status, 0);
  assert.equal(h.receipt().steps.ruleset.status, "ok");
  assert.deepEqual(h.calls("ruleset"), [], "no spec checked in, nothing to run");
});

test("cockpit and reclaim are recorded and never stop the run, whatever they answer", () => {
  const f = fixture();
  f.control("reclaim-scratch", { exit: 2, err: "reclaim-scratch: refuses" });
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  const receipt = f.receipt();
  assert.deepEqual(statuses(receipt), allOk);
  assert.match(receipt.steps.reclaim.output, /not enforced\nreclaim-scratch: refuses/, "the step's own words are kept");
  assert.equal(f.calls("reclaim-scratch").length, 2, "the sibling pass did not run after the live sweep failed");
  assert.deepEqual(f.calls("reclaim-scratch")[1].args, ["--siblings", "--root", receipt.scratch, "--apply"]);
  assert.match(receipt.steps.cockpit.output, /launched/);
});

test("reclaim: a sibling pass that fails alone is recorded beside a clean live sweep, and never stops the run", () => {
  const f = fixture();
  f.control("reclaim-scratch", { by: { "--root": { out: JSON.stringify({ failed: [] }) }, "--siblings": { exit: 2, err: "reclaim-scratch: refuses" } } });
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  const receipt = f.receipt();
  assert.deepEqual(statuses(receipt), allOk);
  assert.deepEqual(receipt.steps.reclaim.output.split("\n"), ["scratch reclaimed", "sibling keys: reclaim-scratch.mjs exit 2, not enforced", "reclaim-scratch: refuses"]);
});

test("reclaim: what either pass's receipt lists in failed[] at exit 0 is named, and the step stays ok", () => {
  const f = fixture();
  const receiptOf = (failed) => ({ out: JSON.stringify({ applied: true, ledger: null, removed: [], kept: [], failed }) });
  f.control("reclaim-scratch", {
    by: {
      "--root": receiptOf([{ path: "/s/pr7", error: "exit 1: rm: denied" }]),
      "--siblings": receiptOf([{ path: "/p/other-aaaaaaaa", error: "EACCES" }]),
    },
  });
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  const receipt = f.receipt();
  assert.deepEqual(statuses(receipt), allOk);
  assert.deepEqual(receipt.steps.reclaim.output.split("\n"), [
    "scratch reclaimed",
    "scratch root: could not reclaim /s/pr7 (exit 1: rm: denied)",
    "sibling keys: could not reclaim /p/other-aaaaaaaa (EACCES)",
  ]);

  const g = fixture();
  g.control("reclaim-scratch", { by: { "--root": receiptOf([]), "--siblings": { out: "not json" } } });
  assert.equal(g.run().status, 0);
  assert.match(g.receipt().steps.reclaim.output, /^sibling keys: could not read reclaim-scratch\.mjs's receipt: /m);
});

test("recipe: a cache that refuses is a pending NEED with exit 4, and a re-run after it is met continues from there", () => {
  const f = fixture();
  f.control("derive-testcmd", { by: { ". install": { exit: 1, err: "no Recipe cache" }, ". test --at origin/main": {} } });
  const r = f.run();
  assert.equal(r.status, 4, r.stdout + r.err);
  assert.equal(r.out.at(-1), "NEED derive-recipe", "the NEED lines come last");
  const receipt = f.receipt();
  assert.deepEqual(statuses(receipt), Object.fromEntries(NAMES.map((n, i) => [n, i < NAMES.indexOf("recipe") ? "ok" : "pending"])));
  assert.match(receipt.steps.recipe.output, /NEED derive-recipe/);
  assert.deepEqual(f.order().filter((n) => n === "gh" || n === "stranded" || n === "shortlist"), [], "the fold-in waits for the Recipe");

  f.control("derive-testcmd", { by: { ". install": { out: "npm ci" }, ". test --at origin/main": { out: "./agent-test" } } });
  const again = f.run();
  assert.equal(again.status, 0, again.stdout + again.err);
  assert.deepEqual(statuses(f.receipt()), allOk);
  assert.equal(f.calls("instruments").length, 1, "the steps done earlier in this run are not run again");
  assert.equal(f.calls("rotate").length, 1, "the rotation is never run twice in one run");
  assert.match(again.stdout, /^phase0: pin: ok \(done earlier in this run\)$/m);
  assert.deepEqual(stepLines(again.out).map((l) => l.split(": ")[1]), NAMES);
});

test("recipe: both reads exit 1 at once is one NEED, not two", () => {
  const f = fixture();
  f.control("derive-testcmd", { exit: 1, err: "refused" });
  const r = f.run();
  assert.equal(r.status, 4);
  assert.equal(r.out.filter((l) => l === "NEED derive-recipe").length, 1);
});

test("stranded: a resume entry is a pending NEED with exit 4, a report entry is printed, and a re-run once the row is written continues", () => {
  const f = fixture();
  f.control("stranded", {
    out: JSON.stringify({
      prior: "dead",
      claims: [
        { n: 21, t: "twenty-one", action: "resume", worktree: "/w/21-impl-21", branch: "implementer/21-impl-21", why: "its worktree is in this checkout" },
        { n: 22, t: "twenty-two", action: "report", worktree: null, branch: null, why: "no worktree for it in this checkout" },
      ],
      carried: [],
    }),
  });
  const r = f.run();
  assert.equal(r.status, 4, r.stdout + r.err);
  assert.equal(r.out.at(-1), "NEED resume #21 /w/21-impl-21 implementer/21-impl-21");
  assert.ok(r.out.some((l) => l.includes("report #22 — no worktree for it in this checkout")), r.stdout);
  const receipt = f.receipt();
  assert.equal(receipt.steps.stranded.status, "pending");
  assert.equal(receipt.steps.shortlist.status, "pending");
  assert.equal(f.calls("shortlist").length, 0, "the shortlist waits for the stranded claims");

  f.ledgerRow(21, "impl-21-b");
  const again = f.run();
  assert.equal(again.status, 0, again.stdout + again.err);
  assert.deepEqual(statuses(f.receipt()), allOk);
  assert.equal(f.calls("shortlist").length, 1);
  assert.equal(f.calls("rotate").length, 1);
  assert.ok(again.out.some((l) => l.includes("report #22")), "the report entry is printed again");
  assert.ok(!again.out.some((l) => l.startsWith("NEED")), again.stdout);
});

test("stranded: the live tokens a rotation carried are listed and are no NEED", () => {
  const f = fixture();
  f.control("stranded", {
    out: JSON.stringify({ prior: "ancestor", claims: [], carried: [{ name: "impl-7", token: "impl-7", row: "#7" }, { name: "review-pr-9", token: "review=member:review-pr-9", row: null }] }),
  });
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  assert.ok(r.out.some((l) => l.includes("carried impl-7 impl-7 (row #7)")), r.stdout);
  assert.ok(r.out.some((l) => l.includes("carried review-pr-9 review=member:review-pr-9 (row none)")), r.stdout);
});

test("fold-in: rows only for PRs that close an issue, a PR a carried row already names is skipped, the rest are NEED lines", () => {
  const f = fixture();
  f.ledgerRow(12, "PR#12 · inherited, held by hand");
  f.ledgerRow(7, "impl-7=PR#13 → PR#13");
  writeFileSync(join(f.stubs, "gh.json"), JSON.stringify([
    { number: 10, closingIssuesReferences: [{ number: 3 }] },
    { number: 11, closingIssuesReferences: [] },
    { number: 12, closingIssuesReferences: [{ number: 4 }] },
    { number: 13, closingIssuesReferences: [{ number: 5 }] },
    { number: 14 },
  ]));
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  const rows = f.ledgerRows();
  assert.deepEqual(rows.sort(), ["#10 PR#10 · inherited (closes #3)", "#12 PR#12 · inherited, held by hand", "#7 impl-7=PR#13 → PR#13"].sort(), "no row for a PR closing no issue, none rewritten for a PR a carried row names");
  assert.deepEqual(r.out.filter((l) => l.startsWith("NEED")), ["NEED review PR#11 (closes no issue)", "NEED review PR#14 (closes no issue)"]);
  assert.equal(r.out.at(-1), "NEED review PR#14 (closes no issue)", "the NEED lines come last");
  assert.equal(f.receipt().steps["fold-in"].status, "ok", "a NEED the fold-in prints is advice");
  assert.match(readFileSync(join(f.stubs, "gh.calls"), "utf8"), /^pr list --state open --json number,closingIssuesReferences --limit \d+ GH_REPO=\[\]/);

  // A re-run in the same run does not queue anything twice, and still prints the advice.
  const again = f.run();
  assert.equal(again.status, 0);
  assert.equal(f.ledgerRows().length, 3);
  assert.deepEqual(again.out.filter((l) => l.startsWith("NEED")).length, 2);
});

test("fold-in: a ledger that cannot be read fails the step rather than queueing over a carried row", () => {
  const f = fixture();
  // A ledger path that is not a file: `ledger.mjs read` cannot answer for it.
  mkdirSync(join(f.repo, ".fleet", "ledger.md"), { recursive: true });
  writeFileSync(join(f.stubs, "gh.json"), JSON.stringify([{ number: 10, closingIssuesReferences: [{ number: 3 }] }]));
  const r = f.run();
  assert.equal(r.status, 3, r.stdout + r.err);
  assert.equal(f.receipt().steps["fold-in"].status, "failed");
  assert.equal(f.calls("shortlist").length, 0);
});

// ── the resume rule ───────────────────────────────────────────────────────────

const stale = (f, extra) => ({
  run: RUN_AT, session: f.session, scratch: "/old/scratch",
  steps: Object.fromEntries(NAMES.map((n) => [n, { status: "ok", at: "2026-01-01T00:00:00.000Z", output: "from the previous run" }])),
  ...extra,
});

test("a receipt with a stale run is ignored: every step re-runs and the old receipt is moved aside", () => {
  const f = fixture();
  f.setRecord(RUN_AT);
  f.setReceipt(stale(f, { run: RUN_AT - 5 }));
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  for (const [, names] of STEPS) for (const n of names.filter((x) => x !== "board" && x !== "ruleset")) assert.ok(f.order().includes(n), `${n} ran`);
  assert.equal(f.calls("instruments").length, 1);
  const receipt = f.receipt();
  assert.equal(receipt.run, RUN_AT);
  assert.ok(Object.values(receipt.steps).every((s) => s.output !== "from the previous run"));
  const aside = f.asides();
  assert.equal(aside.length, 1, aside.join());
  assert.match(aside[0], /^phase0\.\d{4}-\d\d-\d\dT\d{6}Z\.json$/, "named under the ledger archive's own stamp format");
  assert.equal(JSON.parse(readFileSync(join(f.repo, ".fleet", aside[0]), "utf8")).run, RUN_AT - 5);
});

test("a receipt whose run matches the record but whose session differs is a previous run's: rotate runs again", () => {
  const f = fixture();
  f.setRecord(RUN_AT);
  f.setReceipt(stale(f, { session: join(f.dir, "another-session") }));
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  assert.equal(f.calls("rotate").length, 1, "the previous run's receipt did not skip rotate");
  assert.equal(f.calls("instruments").length, 1);
  assert.equal(f.asides().length, 1);
  assert.equal(f.receipt().session, f.session);
});

test("a receipt whose run and session both match resumes: its ok steps are skipped, the rest re-run", () => {
  const f = fixture();
  f.setRecord(RUN_AT);
  const receipt = stale(f);
  receipt.steps.recipe = { status: "pending", at: "2026-01-01T00:00:00.000Z", output: "NEED derive-recipe" };
  receipt.steps["fold-in"] = { status: "pending", at: "2026-01-01T00:00:00.000Z", output: "not run" };
  receipt.steps.stranded = { status: "failed", at: "2026-01-01T00:00:00.000Z", output: "old refusal" };
  receipt.steps.shortlist = { status: "pending", at: "2026-01-01T00:00:00.000Z", output: "not run" };
  f.setReceipt(receipt);
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  assert.deepEqual(f.order().filter((n) => n !== "board"), ["derive-testcmd", "derive-testcmd", "gh", "stranded", "shortlist"]);
  assert.deepEqual(statuses(f.receipt()), allOk);
  assert.equal(f.asides().length, 0, "a receipt that resumes is not moved aside");
  assert.equal(f.receipt().steps.pin.output, "from the previous run", "a skipped step keeps what it recorded");
});

test("a same-session run after `closeout.mjs finish` starts at alarm and rotates again, and skips nothing as done earlier", () => {
  const f = fixture({ spec: true });
  assert.equal(f.run().status, 0);
  assert.equal(f.calls("rotate").length, 1);
  assert.equal(f.receipt().run, RUN_AT, "the run the record names is the receipt's, as it still is after the run ends");

  // The end of that run: every closeout step before the receipt's own is done.
  const finished = readFileSync(f.receiptPath, "utf8");
  const at = new Date().toISOString();
  const done = Object.fromEntries(["drain", "release", "tick", "scrape", "tier-outcomes", "metrics", "commit-and-pr"].map((n) => [n, { status: "ok", at, output: "" }]));
  writeFileSync(join(f.repo, ".fleet", "closeout.json"), JSON.stringify({ reason: "wrap up", begun: at, steps: done }));
  const finish = spawnSync(process.execPath, [join(SCRIPTS, "closeout.mjs"), "finish", "--reason", "wrap up"], {
    cwd: f.repo, encoding: "utf8", env: { ...GIT_ENV, HOME: f.home, PATH: `${join(f.dir, "bin")}:${process.env.PATH}`, PH0_STUBS: f.stubs },
  });
  assert.equal(finish.status, 0, finish.stdout + finish.stderr);
  assert.equal(existsSync(f.receiptPath), false, "finish left no receipt for the next run");
  assert.equal(readFileSync(join(f.repo, ".fleet", "phase0.previous.json"), "utf8"), finished, "it is held for the next rotation");

  const again = f.run();
  assert.equal(again.status, 0, again.stdout + again.err);
  assert.doesNotMatch(again.stdout, /done earlier in this run/);
  assert.equal(f.calls("rotate").length, 2, "the second run rotated");
  assert.equal(f.calls("instruments").length, 2, "and ran every step before it");
  assert.deepEqual(statuses(f.receipt()), allOk);
  assert.equal(existsSync(join(f.repo, ".fleet", "phase0.previous.json")), false, "the rotation took the held receipt");
  const filed = readdirSync(join(f.repo, ".fleet")).filter((n) => /^phase0\.\d{4}-\d\d-\d\dT\d{6}Z\.json$/.test(n));
  assert.equal(filed.length, 1, filed.join());
  assert.equal(readFileSync(join(f.repo, ".fleet", filed[0]), "utf8"), finished, "and filed the finished run's receipt under an archive name");
});

// A run that stopped before its rotation: no run to key on, `rotate` and every
// step after it still pending.
const partialReceipt = (f) => {
  const partial = stale(f, { run: null });
  for (const n of NAMES.slice(NAMES.indexOf("rotate"))) partial.steps[n] = { status: "pending", at: "2026-01-01T00:00:00.000Z", output: "not run" };
  return partial;
};

test("a receipt that never reached its rotation is overwritten, and every step before it runs again", () => {
  const f = fixture();
  f.setReceipt(partialReceipt(f));
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  assert.equal(f.calls("instruments").length, 1, "the steps before the rotation are idempotent and run every time");
  assert.equal(f.calls("main-checkout").length, 1);
  assert.equal(f.asides().length, 0, "a partial receipt is not a previous run's record");
  assert.deepEqual(statuses(f.receipt()), allOk);
});

test("the receipt of the run in progress is off disk while the rotation runs, so the rotation cannot file it under the previous run", () => {
  const f = fixture();
  f.setReceipt(partialReceipt(f));
  assert.equal(f.run().status, 0);
  assert.equal(f.calls("rotate")[0].sawReceipt, false);
});

test("a receipt that is there and cannot be used refuses with exit 3, naming the file, and runs no step", () => {
  const f = fixture();
  mkdirSync(join(f.repo, ".fleet"), { recursive: true });
  const damaged = [
    ["{ not json", /is not JSON/],
    ["[]", /has no steps, run and session/],
    [JSON.stringify({ run: null, session: f.session }), /has no steps, run and session/],
  ];
  for (const [text, shows] of damaged) {
    writeFileSync(f.receiptPath, text);
    const r = f.run();
    assert.equal(r.status, 3, r.stdout + r.err);
    assert.match(r.err, shows);
    assert.match(r.err, /phase0\.json/);
    assert.deepEqual(f.order(), [], "a damaged receipt may record a rotation done: nothing runs again");
    assert.equal(readFileSync(f.receiptPath, "utf8"), text, "and it is left where it is for the maintainer");
  }
  rmSync(f.receiptPath);
  mkdirSync(f.receiptPath);
  const unreadable = f.run();
  assert.equal(unreadable.status, 3, unreadable.stdout + unreadable.err);
  assert.match(unreadable.err, /cannot read the receipt/);
  assert.deepEqual(f.order(), []);
});

test("a rotation that writes no controller record leaves the run null: a re-run in the same session resumes past it, a new session starts over", () => {
  const f = fixture();
  f.control("rotate", { noRecord: true });
  f.control("stranded", { out: JSON.stringify({ prior: "dead", claims: [{ n: 21, t: "x", action: "resume", worktree: "/w/21", branch: "b21", why: "w" }], carried: [] }) });
  const first = f.run();
  assert.equal(first.status, 4, first.stdout + first.err);
  assert.equal(f.receipt().run, null);
  assert.equal(f.receipt().steps.rotate.status, "ok");

  f.ledgerRow(21, "impl-21-b");
  const again = f.run();
  assert.equal(again.status, 0, again.stdout + again.err);
  assert.equal(f.calls("rotate").length, 1, "the rotation is not run a second time in the same run");
  assert.equal(f.asides().length, 0);

  const nextSession = join(f.dir, "next-session");
  mkdirSync(nextSession);
  writeFileSync(`${nextSession}.jsonl`, "");
  const next = f.run(["--session", nextSession]);
  assert.equal(next.status, 0, next.stdout + next.err);
  assert.equal(f.calls("rotate").length, 2, "another session's run rotates again");
  assert.equal(f.asides().length, 1, "and the earlier receipt is moved aside");
});

test("rotate's own account of what it skipped or could not archive is in the step output", () => {
  const f = fixture();
  f.control("rotate", { err: "    skipped unparseable line '#7 junk' — not carried: bad grammar\n    could not archive phase0.json -> phase0.x.json: EACCES\n" });
  const r = f.run();
  assert.equal(r.status, 0, r.stdout + r.err);
  assert.match(r.stdout, /^ {4}skipped unparseable line '#7 junk' — not carried: bad grammar$/m);
  assert.match(f.receipt().steps.rotate.output, /could not archive phase0\.json -> phase0\.x\.json: EACCES/);
});

test("a controller record that cannot be read refuses with exit 3 and sets no receipt aside", () => {
  const f = fixture();
  f.setRecord(RUN_AT);
  const receipt = stale(f);
  receipt.steps.shortlist = { status: "pending", at: "2026-01-01T00:00:00.000Z", output: "not run" };
  f.setReceipt(receipt);
  writeFileSync(join(f.repo, ".fleet", "heartbeat.json"), "{bad");
  const r = f.run();
  assert.equal(r.status, 3, r.stdout + r.err);
  assert.match(r.err, /heartbeat\.json/);
  assert.deepEqual(f.order(), [], "no step ran");
  assert.equal(f.asides().length, 0);
  assert.equal(existsSync(join(f.repo, ".fleet", "phase0.previous.json")), false);
  assert.equal(f.receipt().run, RUN_AT, "the receipt is where it was");
});

// ── the previous run's receipt is held until the rotation files it ───────────

const HELD_NAME = "phase0.previous.json";

test("the real rotation files the previous run's receipt under the ledger archive's own stamp, and nothing is left held", () => {
  const f = fixture();
  f.setRecord(RUN_AT);
  f.setReceipt(stale(f, { run: RUN_AT - 5 }));
  f.ledgerRow(5, "impl-5=PR#6");
  // The ledger walks up from phase 0, which the table does not list, so it
  // finds no controller and writes no record, as it did before the alarm step.
  const r = f.run(null, { env: { PH0_REAL_ROTATE: "1" } });
  assert.equal(r.status, 0, r.stdout + r.err);
  const fleet = join(f.repo, ".fleet");
  const names = readdirSync(fleet);
  const ledger = names.filter((n) => /^ledger\.\d.+\.md$/.test(n));
  assert.equal(ledger.length, 1, names.join());
  assert.deepEqual(f.asides(), [ledger[0].replace(/^ledger\./, "phase0.").replace(/\.md$/, ".json")], "one stamp names both");
  assert.equal(JSON.parse(readFileSync(join(fleet, f.asides()[0]), "utf8")).run, RUN_AT - 5, "it is the previous run's receipt");
  assert.equal(existsSync(join(fleet, HELD_NAME)), false);
  assert.equal(f.receipt().session, f.session, "and this run's own receipt is the one at phase0.json");
});

test("a rotation that refuses leaves the previous run's receipt held, and the re-run files it", () => {
  const f = fixture();
  f.setRecord(RUN_AT);
  f.setReceipt(stale(f, { run: RUN_AT - 5 }));
  f.control("rotate", { exit: 2, err: "refusing to rotate: the controller that owns it is alive" });
  const refused = f.run();
  assert.equal(refused.status, 3, refused.stdout + refused.err);
  const held = join(f.repo, ".fleet", HELD_NAME);
  assert.equal(JSON.parse(readFileSync(held, "utf8")).run, RUN_AT - 5, "held, not lost");
  assert.equal(f.asides().length, 0, "and not filed under a stamp the ledger never took");

  f.control("rotate", {});
  const again = f.run();
  assert.equal(again.status, 0, again.stdout + again.err);
  assert.equal(existsSync(held), false);
  assert.equal(f.asides().length, 1, "the rotation that went through filed it");
});

test("a receipt that has to be held while another is still held refuses with exit 3 and moves nothing", () => {
  const f = fixture();
  f.setRecord(RUN_AT);
  f.setReceipt(stale(f, { run: RUN_AT - 5 }));
  const held = join(f.repo, ".fleet", HELD_NAME);
  writeFileSync(held, "an earlier receipt\n");
  const r = f.run();
  assert.equal(r.status, 3, r.stdout + r.err);
  assert.match(r.err, /cannot hold the previous run's receipt/);
  assert.equal(readFileSync(held, "utf8"), "an earlier receipt\n");
  assert.equal(f.receipt().run, RUN_AT - 5, "the receipt stays where it was");
  assert.deepEqual(f.order(), [], "no step ran");
});

test("a receipt the rotation did not archive is filed under a stamp of its own, and under a taken stamp it stays held", () => {
  const f = fixture();
  f.setRecord(RUN_AT);
  f.setReceipt(stale(f, { run: RUN_AT - 5 }));
  assert.equal(f.run().status, 0);
  assert.equal(f.asides().length, 1, "the stub rotation archives nothing, so the script files it");
  assert.equal(existsSync(join(f.repo, ".fleet", HELD_NAME)), false);

  const g = fixture();
  const clock = join(g.dir, "clock.mjs");
  writeFileSync(clock, `const T = Date.parse("2026-03-04T05:06:07Z"); const R = Date;
globalThis.Date = class extends R { constructor(...a) { super(...(a.length ? a : [T])); } static now() { return T; } };\n`);
  g.setRecord(RUN_AT);
  g.setReceipt(stale(g, { run: RUN_AT - 5 }));
  const taken = join(g.repo, ".fleet", "phase0.2026-03-04T050607Z.json");
  writeFileSync(taken, "an earlier aside\n");
  const r = g.run(null, { env: { NODE_OPTIONS: `--import ${clock}` } });
  assert.equal(r.status, 0, r.stdout + r.err);
  assert.equal(readFileSync(taken, "utf8"), "an earlier aside\n", "a filed receipt is never overwritten");
  assert.equal(JSON.parse(readFileSync(join(g.repo, ".fleet", HELD_NAME), "utf8")).run, RUN_AT - 5, "it waits, held");
});

// ── the rotation archives the receipt ────────────────────────────────────────

function rotateFixture() {
  const f = fixture();
  mkdirSync(join(f.repo, ".fleet"), { recursive: true });
  // The recorded controller is this test runner: alive, started when recorded, and an ancestor of the rotation.
  writeFileSync(join(f.repo, ".fleet", "heartbeat.json"), JSON.stringify({ quiet: 0, digest: "", controller: { pid: process.pid, lstart: "runner-start", prior: "dead", at: RUN_AT } }));
  const rotate = () => spawnSync(process.execPath, [join(REAL_SCRIPTS, "ledger.mjs"), "rotate"], {
    cwd: f.repo, encoding: "utf8", env: { ...GIT_ENV, FLEET_PROC_TABLE: f.procTable },
  });
  return { f, rotate };
}

test("ledger.mjs rotate archives phase0.json beside the ledger under the ledger archive's own timestamp", () => {
  const { f, rotate } = rotateFixture();
  f.ledgerRow(5, "impl-5=PR#6");
  writeFileSync(f.receiptPath, '{"run": 1}\n');
  const r = rotate();
  assert.equal(r.status, 0, r.stderr);
  const names = readdirSync(join(f.repo, ".fleet"));
  const ledger = names.filter((n) => /^ledger\..+\.md$/.test(n));
  const receipt = names.filter((n) => /^phase0\..+\.json$/.test(n));
  assert.equal(ledger.length, 1, names.join());
  assert.equal(receipt.length, 1, names.join());
  assert.equal(receipt[0], ledger[0].replace(/^ledger\./, "phase0.").replace(/\.md$/, ".json"), "one timestamp names both");
  assert.equal(readFileSync(join(f.repo, ".fleet", receipt[0]), "utf8"), '{"run": 1}\n', "the receipt is archived byte for byte");
  assert.equal(existsSync(f.receiptPath), false, "no receipt is left for the next run to read");
  assert.equal(r.stdout.trim().startsWith("{"), true);
  assert.deepEqual(Object.keys(JSON.parse(r.stdout)).sort(), ["archive", "carried", "retired", "rotated", "skipped"], "rotate's own answer is unchanged");
});

test("ledger.mjs rotate with no phase0.json archives the ledger exactly as before", () => {
  const { f, rotate } = rotateFixture();
  f.ledgerRow(5, "impl-5=PR#6");
  const r = rotate();
  assert.equal(r.status, 0, r.stderr);
  const names = readdirSync(join(f.repo, ".fleet"));
  assert.equal(names.filter((n) => /^ledger\..+\.md$/.test(n)).length, 1);
  assert.deepEqual(names.filter((n) => /^phase0\./.test(n)), []);
  assert.doesNotMatch(r.stderr, /could not archive/, "no receipt, so nothing to warn about");
});

test("ledger.mjs rotate with no phase0.json is not refused by a taken receipt-archive name", () => {
  const { f, rotate } = rotateFixture();
  f.ledgerRow(5, "impl-5=PR#6");
  const dir = join(f.repo, ".fleet");
  const now = Date.now();
  const taken = [];
  // Every second this call can plausibly land on is taken, and there is no receipt to move there.
  for (let s = -2; s < 30; s++) {
    const n = `phase0.${new Date(now + s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "")}.json`;
    writeFileSync(join(dir, n), "older receipt\n");
    taken.push(n);
  }
  const r = rotate();
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stderr, /refusing|could not archive/);
  assert.equal(readdirSync(dir).filter((n) => /^ledger\..+\.md$/.test(n)).length, 1, "the ledger was archived");
  for (const n of taken) assert.equal(readFileSync(join(dir, n), "utf8"), "older receipt\n", `${n} is untouched`);
});

test("ledger.mjs rotate with a receipt and no ledger still files the receipt", () => {
  const { f, rotate } = rotateFixture();
  writeFileSync(f.receiptPath, "{}\n");
  const r = rotate();
  assert.equal(r.status, 0, r.stderr);
  const names = readdirSync(join(f.repo, ".fleet"));
  assert.equal(names.filter((n) => /^phase0\..+\.json$/.test(n)).length, 1, names.join());
  assert.equal(existsSync(f.receiptPath), false);
});

test("ledger.mjs rotate refuses when the receipt's archive name is taken, moving nothing", () => {
  const { f, rotate } = rotateFixture();
  f.ledgerRow(5, "impl-5=PR#6");
  writeFileSync(f.receiptPath, '{"run": 1}\n');
  const dir = join(f.repo, ".fleet");
  const ledgerBefore = readFileSync(join(dir, "ledger.md"), "utf8");
  // Every second this call can plausibly land on is taken.
  const now = Date.now();
  for (let s = -2; s < 30; s++) writeFileSync(join(dir, `phase0.${new Date(now + s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "")}.json`), "older receipt\n");
  const r = rotate();
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refusing to rotate .*phase0\..*\.json already exists/);
  assert.equal(readFileSync(f.receiptPath, "utf8"), '{"run": 1}\n', "the receipt stays where it was");
  assert.equal(readFileSync(join(dir, "ledger.md"), "utf8"), ledgerBefore, "the ledger stays where it was");
  assert.deepEqual(readdirSync(dir).filter((n) => /^ledger\..+\.md$/.test(n)), [], "no ledger archive was made");
  for (const n of readdirSync(dir).filter((n) => /^phase0\..+\.json$/.test(n))) assert.equal(readFileSync(join(dir, n), "utf8"), "older receipt\n", `${n} is untouched`);
});

test("ledger.mjs rotate that cannot move the receipt warns and still succeeds", () => {
  const { f } = rotateFixture();
  writeFileSync(f.receiptPath, "{}\n");
  const preload = join(f.dir, "fail-receipt-rename.cjs");
  writeFileSync(preload, `const fs = require("node:fs");
const real = fs.renameSync;
fs.renameSync = (from, to) => {
  if (/phase0\\.json$/.test(String(from))) throw Object.assign(new Error("EXDEV: injected"), { code: "EXDEV" });
  return real(from, to);
};
require("node:module").syncBuiltinESMExports();
`);
  const r = spawnSync(process.execPath, ["--require", preload, join(REAL_SCRIPTS, "ledger.mjs"), "rotate"], {
    cwd: f.repo, encoding: "utf8", env: { ...GIT_ENV, FLEET_PROC_TABLE: f.procTable },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /could not archive .*phase0\.json -> .*phase0\..+\.json: EXDEV: injected/);
  assert.equal(existsSync(f.receiptPath), true, "the receipt is left where it was");
});

// ── the command line ─────────────────────────────────────────────────────────

const refuses = (f, args, shows) => {
  const r = f.run(args);
  assert.equal(r.status, 2, `${args.join(" ")} → ${r.status}\n${r.stdout}${r.err}`);
  assert.match(r.err, shows);
  assert.deepEqual(f.order(), [], "a refused command line ran nothing");
  assert.equal(existsSync(f.receiptPath), false, "nor wrote a receipt");
};

test("usage: every malformed command line exits 2 before a step runs", () => {
  const f = fixture();
  const s = ["--session", f.session];
  refuses(f, [], /no session directory: pass --session <dir>, or run phase 0 from a Python eval cell \(PI_ARTIFACTS_DIR\)/);
  refuses(f, [...s, "--bogus"], /--bogus/);
  refuses(f, ["--session"], /--session needs a value/);
  refuses(f, ["--session", join(f.dir, "missing")], /--session .*missing does not exist, and no .*missing\.jsonl beside it/);
  refuses(f, ["--session", join(f.repo, "README")], /not a directory/);
  refuses(f, [...s, "--implementer-cap", "3"], /--implementer-cap/);
  refuses(f, [...s, "--reviewer-cap", "4"], /--reviewer-cap/);
  refuses(f, [...s, "--in-flight", "0"], /positive/);
  refuses(f, [...s, "--in-flight", "many"], /needs a number/);
  refuses(f, [...s, "--in-flight", ""], /--in-flight needs a value/);
  refuses(f, [...s, "--max-reviews", "2"], /--max-reviews/);
  refuses(f, [...s, "--workflow", "CI", "--declare-no-ci"], /alternatives/);
  refuses(f, [...s, "--declare-no-ci=1"], /boolean flag/);
  refuses(f, [...s, "stray"], /unexpected argument 'stray'/);
});

// The session directory: --session, else the PI_ARTIFACTS_DIR omp's Python
// eval kernel exports, else a refusal naming both. Never a guess.
test("session: --session beats PI_ARTIFACTS_DIR, and stdout names the source", () => {
  const f = fixture();
  const other = join(f.dir, "other-session");
  mkdirSync(other);
  const r = f.run(["--session", f.session], { env: { PI_ARTIFACTS_DIR: other } });
  assert.equal(r.status, 0, r.err);
  assert.equal(f.receipt().session, f.session);
  assert.equal(r.out[0], `session ${f.session} (from --session)`);
});

test("session: with no --session, PI_ARTIFACTS_DIR is the session, and stdout names the source", () => {
  const f = fixture();
  const r = f.run([], { env: { PI_ARTIFACTS_DIR: f.session } });
  assert.equal(r.status, 0, r.err);
  assert.equal(f.receipt().session, f.session);
  assert.equal(r.out[0], `session ${f.session} (from PI_ARTIFACTS_DIR)`);
});

test("session: neither --session nor PI_ARTIFACTS_DIR exits 2 naming both, and an empty PI_ARTIFACTS_DIR is no session", () => {
  const f = fixture();
  for (const env of [{}, { PI_ARTIFACTS_DIR: "" }]) {
    const r = f.run([], { env });
    assert.equal(r.status, 2, `${JSON.stringify(env)} → ${r.status}\n${r.stdout}${r.err}`);
    assert.match(r.err, /--session/);
    assert.match(r.err, /PI_ARTIFACTS_DIR/);
    assert.deepEqual(f.order(), [], "a refused command line ran nothing");
    assert.equal(existsSync(f.receiptPath), false, "nor wrote a receipt");
  }
});

test("session: a PI_ARTIFACTS_DIR that does not exist yet is accepted when its .jsonl is beside it", () => {
  // omp creates a session's directory when its first subagent writes there;
  // the session's own transcript, `<dir>.jsonl`, exists from the start.
  const f = fixture();
  const pending = join(f.dir, "pending-session");
  writeFileSync(`${pending}.jsonl`, "");
  const r = f.run([], { env: { PI_ARTIFACTS_DIR: pending } });
  assert.equal(r.status, 0, r.err);
  assert.equal(f.receipt().session, pending);
  assert.equal(r.out[0], `session ${pending} (from PI_ARTIFACTS_DIR)`);
});

test("session: a PI_ARTIFACTS_DIR with neither a directory nor a .jsonl beside it exits 2, naming the variable", () => {
  const f = fixture();
  const gone = join(f.dir, "gone-session");
  const r = f.run([], { env: { PI_ARTIFACTS_DIR: gone } });
  assert.equal(r.status, 2, `${r.stdout}${r.err}`);
  assert.match(r.err, /PI_ARTIFACTS_DIR .*gone-session does not exist, and no .*gone-session\.jsonl beside it/);
  assert.deepEqual(f.order(), [], "a refused session ran nothing");
  assert.equal(existsSync(f.receiptPath), false, "nor wrote a receipt");
});

// The directory holding every session of a checkout exists, and a session
// child sits inside it, but no `<dir>.jsonl` sits beside it: it names no
// session, from either source.
test("session: an existing directory with no .jsonl beside it exits 2 naming the path and its source, from --session and PI_ARTIFACTS_DIR alike", () => {
  const f = fixture();
  const sessions = join(f.dir, "sessions-dir");
  const child = join(sessions, "2026-10-17T06-37-13-170Z_01a14894-2e52-741b-a112-b6f78ae5ac8b");
  mkdirSync(child, { recursive: true });
  writeFileSync(`${child}.jsonl`, "");
  refuses(f, ["--session", sessions], /--session .*sessions-dir has no .*sessions-dir\.jsonl beside it, so it names no session/);
  const r = f.run([], { env: { PI_ARTIFACTS_DIR: sessions } });
  assert.equal(r.status, 2, `${r.stdout}${r.err}`);
  assert.match(r.err, /PI_ARTIFACTS_DIR .*sessions-dir has no .*sessions-dir\.jsonl beside it, so it names no session/);
  assert.deepEqual(f.order(), [], "a refused session ran nothing");
  assert.equal(existsSync(f.receiptPath), false, "nor wrote a receipt");
});

test("session: a --session that does not exist yet is accepted when its .jsonl is beside it", () => {
  const f = fixture();
  const pending = join(f.dir, "pending-session");
  writeFileSync(`${pending}.jsonl`, "");
  const r = f.run(["--session", pending]);
  assert.equal(r.status, 0, r.err);
  assert.equal(f.receipt().session, pending);
  assert.equal(r.out[0], `session ${pending} (from --session)`);
});

test("usage: a linked worktree refuses, because the checks judge the main checkout", () => {
  const f = fixture();
  const tree = join(f.repo, ".worktrees", "t");
  git(f.repo, "worktree", "add", "-q", "-b", "side", tree);
  const r = f.run(null, { cwd: tree });
  assert.equal(r.status, 2, r.stdout + r.err);
  assert.match(r.err, /run this from the main checkout/);
  assert.deepEqual(f.order(), []);
});

test("an ambient GIT_DIR or GH_REPO naming another repository does not change what any step reads or runs", () => {
  const f = fixture();
  const elsewhere = fixture();
  git(elsewhere.repo, "switch", "-q", "-c", "not-main");
  const r = f.run(null, { env: { GIT_DIR: join(elsewhere.repo, ".git"), GH_REPO: "someone/else" } });
  assert.equal(r.status, 0, r.stdout + r.err);
  assert.deepEqual(statuses(f.receipt()), allOk);
  for (const call of ["instruments", "main-checkout", "preflight", "tier-roles", "metrics-refresh", "derive-testcmd", "stranded", "shortlist"]) {
    assert.equal(f.calls(call)[0].GIT_DIR, null, `${call} inherited GIT_DIR`);
  }
  assert.match(readFileSync(join(f.stubs, "gh.calls"), "utf8"), /GH_REPO=\[\] GIT_DIR=\[\]/);
});

// ── arg.mjs consumers and the instruments pin cover the script ────────────────

test("arg.mjs: the script binds defineFlags and refuses an unknown flag in the shared wording, before it looks at git", () => {
  assert.match(readFileSync(join(REAL_SCRIPTS, "phase0.mjs"), "utf8"), /^import \{[^}]*\bdefineFlags\b[^}]*\} from "\.\/arg\.mjs";$/m);
  const r = spawnSync(process.execPath, [join(REAL_SCRIPTS, "phase0.mjs"), "--bogus"], { cwd: tempDir("phase0-nogit-"), encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^phase0: unknown flag --bogus/m);
});

test("the instruments pin covers phase0.mjs: a rewrite of it is a changed instrument set, and an untracked file beside it is not", () => {
  const dir = realpathSync(tempDir("phase0-pin-"));
  mkdirSync(join(dir, "plugin", "scripts"), { recursive: true });
  cpSync(join(REAL_SCRIPTS, "phase0.mjs"), join(dir, "plugin", "scripts", "phase0.mjs"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "i");
  const pin = (...a) => spawnSync("sh", [join(REAL_SCRIPTS, "instruments.sh"), ...a], { cwd: dir, encoding: "utf8", env: GIT_ENV });
  assert.equal(pin("--pin").status, 0);
  assert.equal(pin().status, 0, "unchanged");
  writeFileSync(join(dir, "plugin", "scripts", "scratch.txt"), "untracked\n");
  assert.equal(pin().status, 0, "an untracked file is no instrument");
  writeFileSync(join(dir, "plugin", "scripts", "phase0.mjs"), `${readFileSync(join(dir, "plugin", "scripts", "phase0.mjs"), "utf8")}\n// edited\n`);
  const changed = pin();
  assert.equal(changed.status, 1);
  assert.match(changed.stdout + changed.stderr, /phase0\.mjs/);
});
