// `closeout.mjs`: the end of a run as `begin` and `finish`, each a list of
// named steps with a receipt in `.fleet/closeout.json`.
//
// Every case runs the real script against a throwaway repository (a real clone
// of a real bare origin) with a copy of the plugin's scripts directory in
// which the external steps that need a live run (`fleet-tick.mjs`,
// `member-outcomes.mjs`, `metrics-refresh.mjs`, `fleet-heartbeat.mjs`,
// `release-ticket.sh`) are stubs that log their call and answer from a control
// file the case writes. `ledger.mjs` and `tier-outcomes.mjs` stay real, so the
// ledger the release step reads and the warning the tier-outcomes step parses
// are the scripts' own; `gh` is a stub on PATH. No network, no omp.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";
import { encodeProjectDir } from "../plugin/scripts/member-record.mjs";
import { COLUMNS } from "../plugin/scripts/tier-outcomes.mjs";

const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));
const REAL_SCRIPTS = join(PLUGIN, "scripts");
const RUN_AT = 1_700_000_000_000;

// closeout.mjs runs `git commit` itself, so the fixture supplies the identity:
// a CI runner has none configured, and git there cannot guess a name.
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;
delete GIT_ENV.GH_REPO;
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const METRICS = ["docs/metrics/member-outcomes.tsv", "docs/metrics/ticket-features.tsv", "docs/metrics/tier-outcomes.tsv"];
const TICK_OVER = 'ACTION: run over → fleet-heartbeat.mjs --stop "<reason>"\n';
const SESSION = "2026-10-01T10-00-00-000Z_0a1b2c3d-0000-4000-8000-000000000001";
const SESSION_B = "2026-10-02T10-00-00-000Z_0a1b2c3d-0000-4000-8000-000000000002";
const TODAY = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const BRANCH = `chore/run-artifacts-${TODAY}`;

// What every stub is: log the call, write what the control file says to write,
// then answer from `<name>.json` in the case's control directory — `{exit, out,
// err, write}`, or `by[<args>]` for a script whose answer turns on its arguments.
const DRIVER = `import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.CLOSEOUT_STUBS;
const control = (name) => {
  try {
    return JSON.parse(readFileSync(join(dir, name + ".json"), "utf8"));
  } catch {
    return {};
  }
};

export function drive(name, args) {
  appendFileSync(join(dir, "order.log"), name + "\\n");
  appendFileSync(join(dir, name + ".calls"), JSON.stringify({ args, cwd: process.cwd(), GIT_DIR: process.env.GIT_DIR ?? null }) + "\\n");
  const c = control(name);
  const spec = (c.by && c.by[args.join(" ")]) || c;
  for (const w of spec.write ?? []) appendFileSync(join(process.cwd(), w.file), w.text);
  process.stdout.write(spec.out ?? "");
  process.stderr.write(spec.err ?? "");
  process.exit(spec.exit ?? 0);
}

if (process.argv[1].endsWith("stub-driver.mjs")) drive(process.argv[2], process.argv.slice(3));
`;

const MJS_STUBS = ["fleet-tick", "member-outcomes", "metrics-refresh", "fleet-heartbeat"];

// The plugin's scripts directory, copied once, with the external steps
// replaced. `ledger.mjs` becomes a shim: a subcommand the case names in
// `ledger-fail.json` is refused, every other is the real script's.
const TREE = tempDir("closeout-tree-");
cpSync(PLUGIN, join(TREE, "plugin"), { recursive: true });
const SCRIPTS = join(TREE, "plugin", "scripts");
writeFileSync(join(SCRIPTS, "stub-driver.mjs"), DRIVER);
// Other scripts import some of them for their exports (ledger.mjs takes the
// tick's), so the real module stays importable behind the stub and only its
// command line is replaced.
for (const n of MJS_STUBS) {
  cpSync(join(SCRIPTS, `${n}.mjs`), join(SCRIPTS, `${n}-real.mjs`));
  writeFileSync(join(SCRIPTS, `${n}.mjs`), `export * from "./${n}-real.mjs";
import { drive } from "./stub-driver.mjs";
import { isCLI } from "./is-cli.mjs";
if (isCLI(import.meta.url)) drive(${JSON.stringify(n)}, process.argv.slice(2));
`);
}
writeFileSync(join(SCRIPTS, "release-ticket.sh"), `#!/bin/sh\nexec node "$(dirname "$0")/stub-driver.mjs" release-ticket "$@"\n`);
cpSync(join(SCRIPTS, "ledger.mjs"), join(SCRIPTS, "ledger-real.mjs"));
writeFileSync(join(SCRIPTS, "ledger.mjs"), `import { readFileSync } from "node:fs";
import { join } from "node:path";
let fail = {};
try {
  fail = JSON.parse(readFileSync(join(process.env.CLOSEOUT_STUBS, "ledger-fail.json"), "utf8"));
} catch {
  // No control file: nothing is refused.
}
if (fail[process.argv[2]]) {
  process.stderr.write(fail[process.argv[2]]);
  process.exit(2);
}
await import("./ledger-real.mjs");
`);
const SCRIPT = join(SCRIPTS, "closeout.mjs");

const GH_STUB = `#!/bin/sh
printf 'gh\\n' >> "$CLOSEOUT_STUBS/order.log"
printf '%s GH_REPO=[%s] GIT_DIR=[%s]\\n' "$(printf '%s' "$*" | tr '\\n' '|')" "\${GH_REPO-}" "\${GIT_DIR-}" >> "$CLOSEOUT_STUBS/gh.calls"
if [ -f "$CLOSEOUT_STUBS/gh.fail" ]; then echo "gh boom" >&2; exit 1; fi
cat "$CLOSEOUT_STUBS/gh.json"
if [ -f "$CLOSEOUT_STUBS/gh.dirty" ]; then printf 'late\\n' >> docs/metrics/member-outcomes.tsv; fi
`;

const HEADER = `# ${COLUMNS.join("\t")}\n`;
const tierRow = (pr, ticket) => [new Date().toISOString().slice(0, 10), pr, ticket, "routine", "", "", "", "a note", "", "", "", ""].join("\t");
const ledgerText = (rows = []) => `# Fleet run ledger\n\n## Rows\n${rows.map((r) => `- ${r}\n`).join("")}\n## Dispatched\n\n## Filed\n\n## Ruled\n`;

// A main checkout cloned from a bare origin with the three metrics files
// committed, a home directory of its own holding one omp session directory for
// the checkout, and control files that make every stub answer as a run that is
// over and whose metrics refresh grew all three files.
function fixture() {
  const dir = realpathSync(tempDir("closeout-"));
  const origin = join(dir, "origin.git");
  const repo = join(dir, "repo");
  const home = join(dir, "home");
  const stubs = join(dir, "stubs");
  const bin = join(dir, "bin");
  for (const d of [home, stubs, bin]) mkdirSync(d);
  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "clone", "-q", origin, repo);
  mkdirSync(join(repo, "docs", "metrics"), { recursive: true });
  writeFileSync(join(repo, "README"), "x\n");
  writeFileSync(join(repo, ".gitignore"), ".fleet/\n");
  writeFileSync(join(repo, METRICS[0]), "# member facts\n");
  writeFileSync(join(repo, METRICS[1]), "run_date\tsession\n");
  writeFileSync(join(repo, METRICS[2]), HEADER);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "root");
  git(repo, "push", "-q", "-u", "origin", "main");
  writeExecStub(join(bin, "gh"), GH_STUB);
  const sessions = join(home, ".omp", "agent", "sessions", encodeProjectDir(repo, { home }));
  mkdirSync(join(sessions, SESSION), { recursive: true });
  const fleet = join(repo, ".fleet");
  mkdirSync(fleet);
  writeFileSync(join(fleet, "ledger.md"), ledgerText());
  const receiptPath = join(fleet, "closeout.json");
  const f = {
    dir, repo, home, stubs, origin, sessions, fleet, receiptPath,
    control: (name, value) => writeFileSync(join(stubs, `${name}.json`), JSON.stringify(value)),
    calls: (name) => (existsSync(join(stubs, `${name}.calls`)) ? readFileSync(join(stubs, `${name}.calls`), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
    ghCalls: () => (existsSync(join(stubs, "gh.calls")) ? readFileSync(join(stubs, "gh.calls"), "utf8").trim().split("\n") : []),
    order: () => (existsSync(join(stubs, "order.log")) ? readFileSync(join(stubs, "order.log"), "utf8").trim().split("\n") : []),
    receipt: () => JSON.parse(readFileSync(receiptPath, "utf8")),
    setLedger: (rows) => writeFileSync(join(fleet, "ledger.md"), ledgerText(rows)),
    ledgerRead: () => {
      const r = spawnSync(process.execPath, [join(SCRIPTS, "ledger.mjs"), "read"], { cwd: repo, encoding: "utf8", env: { ...GIT_ENV, CLOSEOUT_STUBS: stubs } });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    },
    ledgerRows: () => f.ledgerRead().rows,
    run: (cmd, args = [], { env = {}, cwd = repo, script = SCRIPT } = {}) => {
      const r = spawnSync(process.execPath, [script, ...(cmd === null ? [] : [cmd]), ...args], {
        cwd, encoding: "utf8",
        env: { ...GIT_ENV, HOME: home, PATH: `${bin}:${process.env.PATH}`, CLOSEOUT_STUBS: stubs, ...env },
      });
      return { status: r.status, out: r.stdout.split("\n").filter(Boolean), err: r.stderr, stdout: r.stdout };
    },
  };
  f.control("fleet-tick", { out: `ACTION: dispatch\n${TICK_OVER}` });
  f.control("member-outcomes", { err: "member-outcomes: scraped 3 of 4 members (1 dropped); docs/metrics/member-outcomes.tsv now holds 9 rows\n" });
  f.control("metrics-refresh", { write: METRICS.map((file) => ({ file, text: "a\tb\n" })) });
  f.control("fleet-heartbeat", { out: "stopped\n" });
  f.control("release-ticket", {});
  writeFileSync(join(stubs, "gh.json"), "https://example.test/o/r/pull/7\n");
  return f;
}

const stepLines = (out) => out.filter((l) => l.startsWith("closeout: "));
const FINISH_STEPS = ["tick", "scrape", "tier-outcomes", "metrics", "commit-and-pr", "phase0-receipt", "heartbeat-stop"];
const BEGIN_STEPS = ["drain", "release"];
const statusOf = (receipt, names) => Object.fromEntries(names.map((n) => [n, receipt.steps[n].status]));
const allOk = (names) => Object.fromEntries(names.map((n) => [n, "ok"]));

const releaseReceipt = (blockers) => JSON.stringify({ issue: 1, released: false, applied: true, blockers });

// ── begin ────────────────────────────────────────────────────────────────────

test("begin: drains the ledger, finds nothing to release, writes the receipt in .fleet/ and exits 0", () => {
  const f = fixture();
  const r = f.run("begin", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(stepLines(r.out), ["closeout: drain: ok", "closeout: release: ok"]);
  const receipt = f.receipt();
  assert.deepEqual(statusOf(receipt, BEGIN_STEPS), allOk(BEGIN_STEPS));
  assert.equal(receipt.reason, "wrap up");
  assert.match(receipt.begun, /^\d{4}-\d\d-\d\dT/);
  assert.equal(f.ledgerRead().drain, "wrap up");
  assert.deepEqual(f.order(), [], "no claim, so release-ticket.sh was never asked");
});

test("begin: the receipt lands in the main checkout's .fleet/ whatever directory the command runs from", () => {
  const f = fixture();
  const sub = join(f.repo, "docs");
  const r = f.run("begin", ["--reason", "wrap up"], { cwd: sub });
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(existsSync(f.receiptPath), true);
  assert.equal(existsSync(join(sub, "closeout.json")), false, "no cwd-relative receipt");
  assert.equal(existsSync(join(f.repo, "closeout.json")), false);
});

test("begin: a second drain is the standing marker at exit 0, so the step is ok and the reason stays", () => {
  const f = fixture();
  assert.equal(f.run("begin", ["--reason", "first"]).status, 0);
  writeFileSync(f.receiptPath, "{}\n");
  const r = f.run("begin", ["--reason", "second"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(stepLines(r.out), ["closeout: drain: ok", "closeout: release: ok"]);
  assert.equal(f.ledgerRead().drain, "first");
});

test("begin: a pristine claim is released and settled `released` on the ledger", () => {
  const f = fixture();
  f.setLedger(["#12 impl-12 · some prose", "#13 impl-13=PR#40"]);
  const r = f.run("begin", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(f.calls("release-ticket").map((c) => c.args), [["12", "impl-12", "implementer", "--apply"]], "the claim with a PR is not released");
  assert.deepEqual(f.ledgerRows(), ["#12 impl-12=released · some prose", "#13 impl-13=PR#40"]);
  assert.match(r.stdout, /released #12/);
  assert.equal(f.receipt().steps.release.status, "ok");
});

test("begin: a claim with a commit is a NEED hand-release line and the next claim is still released", () => {
  const f = fixture();
  f.setLedger(["#12 impl-12", "#13 impl-13"]);
  f.control("release-ticket", { by: { "12 impl-12 implementer --apply": { exit: 1, out: releaseReceipt(["1 commit ahead of origin/main", "a worktree with changes"]) } } });
  const r = f.run("begin", ["--reason", "wrap up"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.match(r.stdout, /^NEED hand-release #12 1 commit ahead of origin\/main; a worktree with changes$/m);
  assert.deepEqual(f.calls("release-ticket").map((c) => c.args[0]), ["12", "13"], "the loop went on past the refusal");
  assert.deepEqual(f.ledgerRows(), ["#12 impl-12", "#13 impl-13=released"], "only the released claim is settled");
  const receipt = f.receipt();
  assert.equal(receipt.steps.release.status, "pending");
  assert.match(receipt.steps.release.output, /NEED hand-release #12/);
  assert.match(receipt.begun, /^\d{4}-\d\d-\d\dT/, "begin's steps ran to the end");
});

test("begin: a refusal in prose, before release-ticket.sh could write its receipt, names the first line it printed", () => {
  const f = fixture();
  f.setLedger(["#12 impl-12"]);
  f.control("release-ticket", { exit: 2, err: "release-ticket: cannot read json.sh\nsecond line\n" });
  const r = f.run("begin", ["--reason", "wrap up"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.match(r.stdout, /^NEED hand-release #12 release-ticket: cannot read json\.sh$/m);
});

test("begin: a re-run after the NEED is met skips the ok drain and releases the claim", () => {
  const f = fixture();
  f.setLedger(["#12 impl-12"]);
  f.control("release-ticket", { exit: 1, out: releaseReceipt(["1 commit ahead"]) });
  assert.equal(f.run("begin", ["--reason", "wrap up"]).status, 4);
  f.control("release-ticket", {});
  const r = f.run("begin", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(statusOf(f.receipt(), BEGIN_STEPS), allOk(BEGIN_STEPS));
  assert.deepEqual(f.ledgerRows(), ["#12 impl-12=released"]);
  assert.equal(f.calls("release-ticket").length, 2, "release ran again; drain, being ok, did not");
});

test("begin: a `bailed` token and a retry member are released, a settled `bailed` one is left as it is", () => {
  const f = fixture();
  f.setLedger(["#20 impl-20=bailed", "#21 impl-21=bailed impl-21-b", "#22 impl-22=PR#40", "#23 impl-23=released", "#24 impl-24-c · replacement"]);
  const r = f.run("begin", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(f.calls("release-ticket").map((c) => c.args.slice(0, 2)), [["20", "impl-20"], ["21", "impl-21"], ["24", "impl-24"]], "the claim is the pair impl-<N>, whatever the member that worked it was called");
  assert.deepEqual(f.ledgerRows(), ["#20 impl-20=bailed", "#21 impl-21=bailed impl-21-b=released", "#22 impl-22=PR#40", "#23 impl-23=released", "#24 impl-24-c=released · replacement"]);
});

test("begin: a settle that fails after the release is shown, not dropped", () => {
  const f = fixture();
  f.setLedger(["#12 impl-12"]);
  f.control("ledger-fail", { settle: "ledger: ledger is locked\n" });
  const r = f.run("begin", ["--reason", "wrap up"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.match(r.stdout, /^NEED hand-release #12 released, but ledger\.mjs settle impl-12=released failed: ledger: ledger is locked$/m);
  assert.equal(f.receipt().steps.release.status, "pending");
});

test("begin: a drain the ledger refuses fails the step, exits 3 and never reaches the release", () => {
  const f = fixture();
  f.setLedger(["#12 impl-12"]);
  f.control("ledger-fail", { drain: "ledger: no drain today\n" });
  const r = f.run("begin", ["--reason", "wrap up"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  assert.match(r.stdout, /^closeout: drain: failed$/m);
  assert.match(r.stdout, /no drain today/);
  assert.deepEqual(f.order(), []);
  const receipt = f.receipt();
  assert.deepEqual(statusOf(receipt, BEGIN_STEPS), { drain: "failed", release: "pending" });
  assert.equal(receipt.begun, null);
});

test("begin and finish share one receipt: a finish after a begin runs every step", () => {
  const f = fixture();
  assert.equal(f.run("begin", ["--reason", "wrap up"]).status, 0);
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  const receipt = f.receipt();
  assert.deepEqual(Object.keys(receipt.steps), [...BEGIN_STEPS, ...FINISH_STEPS]);
  assert.deepEqual(statusOf(receipt, [...BEGIN_STEPS, ...FINISH_STEPS]), allOk([...BEGIN_STEPS, ...FINISH_STEPS]));
});

test("finish over a receipt that holds only begin's two steps adds the rest and runs them", () => {
  const f = fixture();
  const at = new Date().toISOString();
  writeFileSync(f.receiptPath, JSON.stringify({ reason: "wrap up", begun: at, steps: { drain: { status: "ok", at, output: "" }, release: { status: "ok", at, output: "" } } }));
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(Object.keys(f.receipt().steps), [...BEGIN_STEPS, ...FINISH_STEPS]);
  assert.deepEqual(statusOf(f.receipt(), [...BEGIN_STEPS, ...FINISH_STEPS]), allOk([...BEGIN_STEPS, ...FINISH_STEPS]));
});

test("a finish before any begin leaves begin's steps pending in the receipt, and a later begin runs them", () => {
  const f = fixture();
  assert.equal(f.run("finish", ["--reason", "wrap up"]).status, 0);
  assert.deepEqual(statusOf(f.receipt(), BEGIN_STEPS), { drain: "pending", release: "pending" });
  const r = f.run("begin", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(statusOf(f.receipt(), BEGIN_STEPS), allOk(BEGIN_STEPS));
});

// ── finish ───────────────────────────────────────────────────────────────────

test("finish: runs the steps in order, one status line each, heartbeat --stop last, and exits 0", () => {
  const f = fixture();
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(stepLines(r.out), FINISH_STEPS.map((n) => `closeout: ${n}: ok`));
  assert.deepEqual(statusOf(f.receipt(), FINISH_STEPS), allOk(FINISH_STEPS));
  assert.deepEqual(f.order(), ["fleet-tick", "member-outcomes", "metrics-refresh", "gh", "fleet-heartbeat"]);
  assert.deepEqual(f.calls("fleet-heartbeat")[0].args, ["--stop", "wrap up"]);
  assert.equal(git(f.repo, "branch", "--show-current"), "main", "the checkout is back on main");
});

test("finish: the tick runs with the In-flight bound phase0.json records, and with none when there is no phase0.json or it records none — the caps play no part", () => {
  const f = fixture();
  writeFileSync(join(f.fleet, "phase0.json"), JSON.stringify({ caps: { impl: 3, review: 5 }, inFlight: 4 }));
  assert.equal(f.run("finish", ["--reason", "wrap up"]).status, 0);
  assert.deepEqual(f.calls("fleet-tick")[0].args, ["--in-flight", "4"]);

  const k = fixture();
  writeFileSync(join(k.fleet, "phase0.json"), JSON.stringify({ caps: { impl: 3, review: 5 } }));
  assert.equal(k.run("finish", ["--reason", "wrap up"]).status, 0);
  assert.deepEqual(k.calls("fleet-tick")[0].args, [], "caps recorded without a bound pass no bound");

  const h = fixture();
  assert.equal(h.run("finish", ["--reason", "wrap up"]).status, 0);
  assert.deepEqual(h.calls("fleet-tick")[0].args, []);

  const bad = fixture();
  writeFileSync(join(bad.fleet, "phase0.json"), "{not json");
  const r = bad.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  assert.match(r.stdout, /closeout: tick: failed\n\s+cannot read .*phase0\.json/);
  assert.deepEqual(bad.order(), []);
});

test("finish: exits 3 and runs nothing after it unless the tick's last line is `ACTION: run over`", () => {
  for (const out of ["ACTION: dispatch\nACTION: HOLD (draining)\n", "ACTION: run over\nACTION: dispatch\n", ""]) {
    const f = fixture();
    f.control("fleet-tick", { out });
    const r = f.run("finish", ["--reason", "wrap up"]);
    assert.equal(r.status, 3, JSON.stringify(out) + r.err + r.stdout);
    assert.match(r.stdout, /^closeout: tick: failed$/m);
    assert.deepEqual(f.order(), ["fleet-tick"]);
    assert.deepEqual(statusOf(f.receipt(), FINISH_STEPS), { tick: "failed", scrape: "pending", "tier-outcomes": "pending", metrics: "pending", "commit-and-pr": "pending", "phase0-receipt": "pending", "heartbeat-stop": "pending" });
  }
  const f = fixture();
  f.control("fleet-tick", { exit: 1, err: "fleet-tick: cannot read the ledger\n" });
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 3);
  assert.match(r.stdout, /fleet-tick: cannot read the ledger/);
});

test("finish: scrapes every session directory for this cwd, prints each yield line, and leaves loose transcripts alone", () => {
  const f = fixture();
  mkdirSync(join(f.sessions, SESSION_B));
  writeFileSync(join(f.sessions, "2026-10-03T10-00-00-000Z_main.jsonl"), "{}\n");
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(f.calls("member-outcomes").map((c) => c.args), [[join(f.sessions, SESSION)], [join(f.sessions, SESSION_B)]]);
  assert.equal(f.calls("member-outcomes")[0].cwd, f.repo);
  assert.match(r.stdout, new RegExp(`${SESSION}: member-outcomes: scraped 3 of 4 members \\(1 dropped\\)`));
  assert.match(r.stdout, new RegExp(`${SESSION_B}: member-outcomes: scraped 3 of 4 members`));
});

test("finish: a scraper that exits non-zero fails the step, and nothing after it runs", () => {
  const f = fixture();
  f.control("member-outcomes", { exit: 2, err: "member-outcomes: cannot read the session directory\n" });
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  assert.match(r.stdout, /closeout: scrape: failed\n\s+member-outcomes\.mjs .* failed: member-outcomes: cannot read the session directory/);
  assert.deepEqual(f.order(), ["fleet-tick", "member-outcomes"]);
});

test("finish: no session directory for this cwd is said so, in the step's output", () => {
  const f = fixture();
  rmSync(f.sessions, { recursive: true });
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.match(r.stdout, /closeout: scrape: ok\n\s+no session directory at /);
  assert.deepEqual(f.calls("member-outcomes"), []);
});

// The ledger rows the real tier-outcomes check --live reads: PR 23 and PR 30
// are reviewed, PR 20 is reviewed and has its row.
const REVIEWED = [
  "#10 impl-10=PR#20 · reviewed=abcdef1:0/0/0:run-abcdef1r",
  "#13 impl-13=PR#23 · reviewed=abcdef2:1/0/0:run-abcdef2r",
  "#30 review=member:review-pr-30 · reviewed=abcdef3:0/1/0:run-abcdef3r",
  "#14 impl-14=PR#24 · review=member:review-pr-24",
];

test("finish: exits 4 naming each reviewed= PR without a tier-outcomes row, and a re-run after the rows are appended proceeds from that step", () => {
  const f = fixture();
  writeFileSync(join(f.repo, METRICS[2]), HEADER + tierRow(20, 10) + "\n");
  git(f.repo, "commit", "-q", "-am", "a row");
  git(f.repo, "push", "-q");
  f.setLedger(REVIEWED);
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 4, r.err + r.stdout);
  assert.deepEqual(r.out.filter((l) => l.startsWith("NEED ")), ["NEED tier-outcomes append 23", "NEED tier-outcomes append 30"]);
  assert.match(r.stdout, /^closeout: tier-outcomes: pending$/m);
  assert.deepEqual(f.order().filter((n) => n !== "gh"), ["fleet-tick", "member-outcomes"], "the metrics refresh and everything after it waits");
  assert.deepEqual(f.ghCalls().filter((l) => !l.startsWith("pr view ")), [], "the step only reads PRs; nothing was created or edited");
  assert.deepEqual(statusOf(f.receipt(), FINISH_STEPS), { tick: "ok", scrape: "ok", "tier-outcomes": "pending", metrics: "pending", "commit-and-pr": "pending", "phase0-receipt": "pending", "heartbeat-stop": "pending" });

  writeFileSync(join(f.repo, METRICS[2]), HEADER + [tierRow(20, 10), tierRow(23, 13), tierRow(30, 30)].join("\n") + "\n");
  const again = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(again.status, 0, again.err + again.stdout);
  assert.deepEqual(statusOf(f.receipt(), FINISH_STEPS), allOk(FINISH_STEPS));
  assert.deepEqual(f.order().filter((n) => n === "fleet-tick" || n === "member-outcomes"), ["fleet-tick", "member-outcomes"], "the ok steps were not run again");
  assert.deepEqual(f.calls("metrics-refresh").length, 1);
});

// #3611: a reviewed PR that closes no issue (a `Refs`-only step) can take no
// tier-outcomes row, so it never holds the close-out up.
test("finish: reviewed= PRs that close no issue need no tier-outcomes row, and the run closes", () => {
  const f = fixture();
  writeFileSync(join(f.repo, METRICS[2]), HEADER + tierRow(20, 10) + "\n");
  git(f.repo, "commit", "-q", "-am", "a row");
  git(f.repo, "push", "-q");
  f.setLedger(REVIEWED);
  writeFileSync(join(f.stubs, "gh.json"), '{"closingIssuesReferences":[]}\n');
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(r.out.filter((l) => l.startsWith("NEED ")), []);
  assert.deepEqual(statusOf(f.receipt(), FINISH_STEPS), allOk(FINISH_STEPS));
  assert.deepEqual(f.ghCalls().filter((l) => l.startsWith("pr view ")).map((l) => l.split(" GH_REPO=")[0]), ["pr view 23 --json closingIssuesReferences", "pr view 30 --json closingIssuesReferences"]);
});

test("finish: a tier-outcomes table the check refuses fails the step and prints what it said", () => {
  const f = fixture();
  writeFileSync(join(f.repo, METRICS[2]), HEADER + "not\ta row\n");
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  assert.match(r.stdout, /closeout: tier-outcomes: failed\n\s+tier-outcomes\.mjs check --live failed: .*malformed row/);
  assert.deepEqual(f.order(), ["fleet-tick", "member-outcomes"]);
});

test("finish: a metrics refresh that exits 1 or 2 fails the step with its own words, and --stop never runs", () => {
  for (const exit of [1, 2]) {
    const f = fixture();
    f.control("metrics-refresh", { exit, err: "metrics-refresh: cost guard failed: pr-cost.mjs --guard exited 1\n" });
    const r = f.run("finish", ["--reason", "wrap up"]);
    assert.equal(r.status, 3, r.err + r.stdout);
    assert.match(r.stdout, /closeout: metrics: failed\n\s+metrics-refresh\.mjs failed: metrics-refresh: cost guard failed: pr-cost\.mjs --guard exited 1/);
    assert.deepEqual(f.calls("fleet-heartbeat"), [], "heartbeat-stop is the last step and is not run after a failed one");
    assert.deepEqual(f.ghCalls(), []);
    assert.equal(git(f.repo, "branch", "--list", "chore/*"), "", "no branch was made");
  }
});

// ── commit and PR ────────────────────────────────────────────────────────────

test("finish: the metrics branch carries one commit of exactly the three metrics files, is pushed, and the PR names the reason and the rows", () => {
  const f = fixture();
  writeFileSync(join(f.repo, "README"), "staged and unrelated\n");
  git(f.repo, "add", "README");
  const r = f.run("finish", ["--reason", "budget exhausted"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(git(f.repo, "show", "--name-only", "--format=", BRANCH).split("\n").sort(), METRICS);
  assert.equal(git(f.repo, "log", "-1", "--format=%s", BRANCH), "Closeout: budget exhausted");
  assert.equal(git(f.repo, "rev-list", "--count", `main..${BRANCH}`), "1");
  assert.match(git(f.dir, "--git-dir", f.origin, "branch", "--list", BRANCH), new RegExp(BRANCH), "pushed to origin");
  assert.equal(git(f.repo, "branch", "--show-current"), "main");
  assert.equal(git(f.repo, "diff", "--cached", "--name-only"), "README", "the unrelated staged file is still staged, in no commit");
  const create = f.ghCalls().filter((l) => l.startsWith("pr create"));
  assert.equal(create.length, 1);
  assert.match(create[0], new RegExp(`--head ${BRANCH} `));
  assert.match(create[0], /--title Closeout: budget exhausted /);
  assert.match(create[0], /--label patch /);
  assert.match(create[0], /Closeout: budget exhausted/);
  for (const file of METRICS) assert.match(create[0], new RegExp(`- ${file.replaceAll(".", "\\.")}: \\+1 -0`), `${file} row count`);
  assert.equal(f.receipt().pr, "https://example.test/o/r/pull/7");
  assert.equal(f.receipt().branch, BRANCH);
});

test("finish: the branch letter suffix increments past a dated name taken locally and one taken only on origin", () => {
  const f = fixture();
  git(f.repo, "branch", BRANCH);
  const other = join(f.dir, "other");
  git(f.dir, "clone", "-q", f.origin, other);
  git(other, "push", "-q", "origin", `main:refs/heads/${BRANCH}b`);
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(f.receipt().branch, `${BRANCH}c`);
  assert.match(f.ghCalls().find((l) => l.startsWith("pr create")), new RegExp(`--head ${BRANCH}c `));
  assert.equal(git(f.repo, "rev-parse", "--verify", `${BRANCH}c`) !== "", true);
  assert.equal(git(f.repo, "rev-parse", "--verify", BRANCH), git(f.repo, "rev-parse", "main"), "the taken names are untouched");
});

test("finish: --branch names the branch as given", () => {
  const f = fixture();
  const r = f.run("finish", ["--reason", "wrap up", "--branch", "chore/mine"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(f.receipt().branch, "chore/mine");
  assert.match(f.ghCalls().find((l) => l.startsWith("pr create")), /--head chore\/mine /);
});

test("finish: an origin that cannot be asked is a failed step, not a name that is free", () => {
  const f = fixture();
  git(f.repo, "remote", "set-url", "origin", join(f.dir, "no-such-origin.git"));
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  assert.match(r.stdout, /closeout: commit-and-pr: failed\n\s+git ls-remote origin chore\/run-artifacts-\d+ failed: .*no-such-origin/);
  assert.equal(git(f.repo, "branch", "--list", "chore/*"), "", "no branch was made");
  assert.deepEqual(f.calls("fleet-heartbeat"), []);
});

test("finish: a failed `gh pr create` shows gh's stderr, leaves the checkout on main, and a re-run resumes the same branch and opens the PR once", () => {
  const f = fixture();
  writeFileSync(join(f.stubs, "gh.fail"), "");
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  assert.match(r.stdout, /closeout: commit-and-pr: failed\n\s+gh pr create failed: gh boom/);
  assert.equal(git(f.repo, "branch", "--show-current"), "main", "the checkout is back on main");
  assert.equal(git(f.repo, "rev-list", "--count", `main..${BRANCH}`), "1", "the metrics commit is on the branch");
  assert.deepEqual(f.calls("fleet-heartbeat"), []);
  assert.equal(f.receipt().branch, BRANCH);
  assert.equal(f.receipt().pr, null);

  rmSync(join(f.stubs, "gh.fail"));
  const again = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(again.status, 0, again.err + again.stdout);
  assert.equal(git(f.repo, "branch", "--list", "chore/*").split("\n").length, 1, "no second branch");
  assert.equal(git(f.repo, "rev-list", "--count", `main..${BRANCH}`), "1", "no second commit");
  assert.equal(f.ghCalls().filter((l) => l.startsWith("pr create")).length, 2, "the failed call and the one that opened it");
  assert.deepEqual(f.calls("fleet-tick").length, 1, "the ok steps were not run again");
  assert.deepEqual(f.calls("fleet-heartbeat").length, 1);
});

test("finish: a checkout that cannot go back to main fails the step with the PR kept in the receipt, and a re-run does not open a second one", () => {
  const f = fixture();
  writeFileSync(join(f.stubs, "gh.dirty"), "");
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  assert.match(r.stdout, /closeout: commit-and-pr: failed\n\s+git switch main failed: /);
  assert.equal(f.receipt().pr, "https://example.test/o/r/pull/7");
  assert.equal(f.ghCalls().filter((l) => l.startsWith("pr create")).length, 1);

  rmSync(join(f.stubs, "gh.dirty"));
  git(f.repo, "checkout", "--", METRICS[0]);
  const again = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(again.status, 0, again.err + again.stdout);
  assert.equal(f.ghCalls().filter((l) => l.startsWith("pr create")).length, 1, "the PR is not opened twice");
  assert.equal(git(f.repo, "branch", "--show-current"), "main");
  assert.equal(f.calls("fleet-heartbeat").length, 1);
});

test("finish: a failed push shows git's stderr, and a re-run pushes the same commit and goes on", () => {
  const f = fixture();
  git(f.repo, "remote", "set-url", "--push", "origin", join(f.dir, "no-such-origin.git"));
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  assert.match(r.stdout, /closeout: commit-and-pr: failed\n\s+git push failed: .*no-such-origin/);
  assert.equal(git(f.repo, "branch", "--show-current"), "main");
  assert.deepEqual(f.ghCalls(), []);

  git(f.repo, "remote", "set-url", "--push", "origin", f.origin);
  const again = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(again.status, 0, again.err + again.stdout);
  assert.equal(git(f.repo, "rev-list", "--count", `main..${BRANCH}`), "1");
  assert.match(git(f.dir, "--git-dir", f.origin, "branch", "--list", BRANCH), new RegExp(BRANCH));
});

test("finish: metrics files that did not change are a failed step, never an empty PR", () => {
  const f = fixture();
  f.control("metrics-refresh", {});
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  assert.match(r.stdout, /closeout: commit-and-pr: failed\n\s+nothing to commit: /);
  assert.deepEqual(f.ghCalls(), []);
  assert.equal(git(f.repo, "branch", "--show-current"), "main");
});

test("finish: a re-run after commit-and-pr succeeded does not open a second PR, and runs only the step that is left", () => {
  const f = fixture();
  f.control("fleet-heartbeat", { exit: 1, err: "fleet-heartbeat: cannot write the state\n" });
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  assert.match(r.stdout, /closeout: heartbeat-stop: failed\n\s+fleet-heartbeat\.mjs --stop failed: fleet-heartbeat: cannot write the state/);
  assert.equal(f.ghCalls().filter((l) => l.startsWith("pr create")).length, 1);

  f.control("fleet-heartbeat", { out: "stopped\n" });
  const again = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(again.status, 0, again.err + again.stdout);
  assert.deepEqual(stepLines(again.out), FINISH_STEPS.map((n) => `closeout: ${n}: ok`));
  assert.equal(f.ghCalls().filter((l) => l.startsWith("pr create")).length, 1, "still one PR");
  assert.equal(f.calls("fleet-tick").length, 1);
  assert.equal(f.calls("metrics-refresh").length, 1);
  assert.equal(f.calls("fleet-heartbeat").length, 2);
});

// ── the phase-0 receipt is set aside ─────────────────────────────────────────

const PHASE0 = '{"run": 1700000000000, "session": "/s", "caps": {"impl": 3, "review": null}, "inFlight": 6}\n';
// Where phase0.mjs holds a previous run's receipt until the next rotation files it.
const HELD = "phase0.previous.json";
// Every phase-0 file beside the ledger but the live receipt.
const aside = (f) => readdirSync(f.fleet).filter((n) => /^phase0\./.test(n) && n !== "phase0.json");

test("finish: moves phase0.json to the name phase0.mjs holds a previous run's receipt under, after the tick and before heartbeat --stop", () => {
  const f = fixture();
  writeFileSync(join(f.fleet, "phase0.json"), PHASE0);
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(existsSync(join(f.fleet, "phase0.json")), false, "no receipt is left for the next run to resume");
  assert.deepEqual(aside(f), [HELD]);
  assert.equal(readFileSync(join(f.fleet, HELD), "utf8"), PHASE0, "kept byte for byte");
  assert.deepEqual(f.calls("fleet-tick")[0].args, ["--in-flight", "6"], "the tick still read the bound from it");
  assert.deepEqual(stepLines(r.out), FINISH_STEPS.map((n) => `closeout: ${n}: ok`));

  // The move is before --stop: a stop that fails finds the receipt already moved.
  const g = fixture();
  writeFileSync(join(g.fleet, "phase0.json"), PHASE0);
  g.control("fleet-heartbeat", { exit: 1, err: "fleet-heartbeat: cannot write the state\n" });
  assert.equal(g.run("finish", ["--reason", "wrap up"]).status, 3);
  assert.equal(existsSync(join(g.fleet, "phase0.json")), false);
  assert.deepEqual(aside(g), [HELD]);
  assert.equal(g.receipt().steps["phase0-receipt"].status, "ok");
});

test("finish: a step that fails or waits before the move leaves phase0.json where it was", () => {
  const arrangements = [
    ["tick", 3, (f) => f.control("fleet-tick", { out: "ACTION: dispatch\n" })],
    ["metrics", 3, (f) => f.control("metrics-refresh", { exit: 1, err: "metrics-refresh: cost guard failed\n" })],
    ["commit-and-pr", 3, (f) => f.control("metrics-refresh", {})],
    ["tier-outcomes", 4, (f) => {
      writeFileSync(join(f.repo, METRICS[2]), HEADER + tierRow(20, 10) + "\n");
      git(f.repo, "commit", "-q", "-am", "a row");
      git(f.repo, "push", "-q");
      f.setLedger(REVIEWED);
    }],
  ];
  for (const [step, status, arrange] of arrangements) {
    const f = fixture();
    writeFileSync(join(f.fleet, "phase0.json"), PHASE0);
    arrange(f);
    const r = f.run("finish", ["--reason", "wrap up"]);
    assert.equal(r.status, status, `${step}: ${r.err}${r.stdout}`);
    assert.equal(readFileSync(join(f.fleet, "phase0.json"), "utf8"), PHASE0, `${step}: the receipt stays`);
    assert.deepEqual(aside(f), [], `${step}: nothing was moved`);
    assert.equal(f.receipt().steps["phase0-receipt"].status, "pending", step);
  }
});

test("finish: a receipt that cannot be parsed is moved all the same, and no phase0.json at all is a step that is ok", () => {
  const f = fixture();
  // The tick refuses to read it, so the step is reached through a receipt whose earlier steps are already ok.
  const at = new Date().toISOString();
  const done = Object.fromEntries(["drain", "release", "tick", "scrape", "tier-outcomes", "metrics", "commit-and-pr"].map((n) => [n, { status: "ok", at, output: "" }]));
  writeFileSync(f.receiptPath, JSON.stringify({ reason: "wrap up", begun: at, steps: done }));
  writeFileSync(join(f.fleet, "phase0.json"), "{not json");
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(existsSync(join(f.fleet, "phase0.json")), false);
  assert.equal(readFileSync(join(f.fleet, HELD), "utf8"), "{not json");

  const g = fixture();
  const none = g.run("finish", ["--reason", "wrap up"]);
  assert.equal(none.status, 0, none.err + none.stdout);
  assert.equal(g.receipt().steps["phase0-receipt"].status, "ok");
  assert.deepEqual(aside(g), [], "nothing to move, nothing made");
});

test("finish: a re-run after the move neither fails nor moves again, including after a crash between the move and the receipt", () => {
  const f = fixture();
  writeFileSync(join(f.fleet, "phase0.json"), PHASE0);
  f.control("fleet-heartbeat", { exit: 1, err: "fleet-heartbeat: cannot write the state\n" });
  assert.equal(f.run("finish", ["--reason", "wrap up"]).status, 3);
  assert.deepEqual(aside(f), [HELD]);
  const at = f.receipt().steps["phase0-receipt"].at;

  f.control("fleet-heartbeat", { out: "stopped\n" });
  const again = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(again.status, 0, again.err + again.stdout);
  assert.deepEqual(aside(f), [HELD], "still the one held receipt");
  assert.equal(f.receipt().steps["phase0-receipt"].at, at, "the step was skipped, not run again");

  // The crash: the file moved, the receipt never said so.
  const receipt = f.receipt();
  receipt.steps["phase0-receipt"] = { status: "pending", at: null, output: "" };
  receipt.steps["heartbeat-stop"] = { status: "pending", at: null, output: "" };
  writeFileSync(f.receiptPath, JSON.stringify(receipt));
  const third = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(third.status, 0, third.err + third.stdout);
  assert.deepEqual(aside(f), [HELD], "an absent phase0.json is not moved a second time");
  assert.equal(readFileSync(join(f.fleet, HELD), "utf8"), PHASE0);
  assert.equal(f.receipt().steps["phase0-receipt"].status, "ok");
});

test("finish: a crash between the link and the unlink leaves one file under two names, and the re-run finishes the move", () => {
  const f = fixture();
  writeFileSync(join(f.fleet, "phase0.json"), PHASE0);
  linkSync(join(f.fleet, "phase0.json"), join(f.fleet, HELD));
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(existsSync(join(f.fleet, "phase0.json")), false);
  assert.equal(readFileSync(join(f.fleet, HELD), "utf8"), PHASE0);
  assert.equal(f.receipt().steps["phase0-receipt"].status, "ok");
});

test("finish: a held receipt that is another file fails the step and leaves phase0.json and the held receipt where they were", () => {
  const f = fixture();
  writeFileSync(join(f.fleet, "phase0.json"), PHASE0);
  writeFileSync(join(f.fleet, HELD), "older receipt\n");
  const r = f.run("finish", ["--reason", "wrap up"]);
  assert.equal(r.status, 3, r.err + r.stdout);
  assert.match(r.stdout, /closeout: phase0-receipt: failed\n\s+.*already holds another receipt/);
  assert.equal(readFileSync(join(f.fleet, "phase0.json"), "utf8"), PHASE0);
  assert.equal(readFileSync(join(f.fleet, HELD), "utf8"), "older receipt\n", "the held receipt was not overwritten");
  assert.deepEqual(f.calls("fleet-heartbeat"), [], "--stop is not run after a failed step");
});

test("an ambient GIT_DIR or GH_REPO naming another repository does not change what any step reads or runs", () => {
  const f = fixture();
  const elsewhere = fixture();
  git(elsewhere.repo, "switch", "-q", "-c", "not-main");
  f.setLedger(["#12 impl-12"]);
  const env = { GIT_DIR: join(elsewhere.repo, ".git"), GH_REPO: "someone/else" };
  const begin = f.run("begin", ["--reason", "wrap up"], { env });
  assert.equal(begin.status, 0, begin.err + begin.stdout);
  const r = f.run("finish", ["--reason", "wrap up"], { env });
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(git(f.repo, "rev-list", "--count", `main..${BRANCH}`), "1", "the branch went on this repository");
  assert.equal(git(elsewhere.repo, "branch", "--list", "chore/*"), "", "and none went on the other");
  for (const call of ["release-ticket", "fleet-tick", "member-outcomes", "metrics-refresh", "fleet-heartbeat"]) {
    assert.equal(f.calls(call)[0].GIT_DIR, null, `${call} inherited GIT_DIR`);
  }
  assert.match(readFileSync(join(f.stubs, "gh.calls"), "utf8"), /GH_REPO=\[\] GIT_DIR=\[\]/);
});

// ── the command line ─────────────────────────────────────────────────────────

const refuses = (f, cmd, args, shows) => {
  const r = f.run(cmd, args);
  assert.equal(r.status, 2, `${cmd} ${args.join(" ")} → ${r.status}\n${r.stdout}${r.err}`);
  assert.match(r.err, shows);
  assert.deepEqual(f.order(), [], "a refused command line ran nothing");
  assert.equal(existsSync(f.receiptPath), false, "nor wrote a receipt");
};

test("usage: every malformed command line exits 2 before a step runs", () => {
  const f = fixture();
  refuses(f, null, [], /usage: closeout\.mjs begin/);
  refuses(f, "start", ["--reason", "r"], /unexpected argument 'start'/);
  refuses(f, "begin", [], /--reason is required/);
  refuses(f, "finish", ["--reason"], /--reason needs a value/);
  refuses(f, "begin", ["--reason", "r", "--bogus"], /--bogus/);
  refuses(f, "begin", ["--reason", "r", "--branch", "x"], /--branch belongs to finish/);
  refuses(f, "finish", ["--reason", "r", "--branch"], /--branch needs a value/);
  refuses(f, "finish", ["--reason", "r", "stray"], /unexpected argument 'stray'/);
});

test("a command run outside a repository refuses naming what git could not resolve", () => {
  const f = fixture();
  const r = f.run("begin", ["--reason", "r"], { cwd: tempDir("closeout-nogit-") });
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.match(r.err, /^closeout: could not resolve --git-common-dir/m);
  assert.deepEqual(f.order(), []);
});

// ── arg.mjs and the instruments pin cover the script ─────────────────────────

test("arg.mjs: the script binds defineFlags and refuses an unknown flag in the shared wording, before it looks at git", () => {
  assert.match(readFileSync(join(REAL_SCRIPTS, "closeout.mjs"), "utf8"), /^import \{[^}]*\bdefineFlags\b[^}]*\} from "\.\/arg\.mjs";$/m);
  const r = spawnSync(process.execPath, [join(REAL_SCRIPTS, "closeout.mjs"), "--bogus"], { cwd: tempDir("closeout-nogit-"), encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^closeout: unknown flag --bogus/m);
});

test("the instruments pin covers closeout.mjs: a rewrite of it is a changed instrument set, and an untracked file beside it is not", () => {
  const dir = realpathSync(tempDir("closeout-pin-"));
  mkdirSync(join(dir, "plugin", "scripts"), { recursive: true });
  cpSync(join(REAL_SCRIPTS, "closeout.mjs"), join(dir, "plugin", "scripts", "closeout.mjs"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "i");
  const pin = (...a) => spawnSync("sh", [join(REAL_SCRIPTS, "instruments.sh"), ...a], { cwd: dir, encoding: "utf8", env: GIT_ENV });
  assert.equal(pin("--pin").status, 0);
  assert.equal(pin().status, 0, "unchanged");
  writeFileSync(join(dir, "plugin", "scripts", "scratch.txt"), "untracked\n");
  assert.equal(pin().status, 0, "an untracked file is no instrument");
  writeFileSync(join(dir, "plugin", "scripts", "closeout.mjs"), `${readFileSync(join(dir, "plugin", "scripts", "closeout.mjs"), "utf8")}\n// edited\n`);
  const changed = pin();
  assert.equal(changed.status, 1);
  assert.match(changed.stdout + changed.stderr, /closeout\.mjs/);
});

// ── the rotation archives the receipt ────────────────────────────────────────

const OMP = 2_000_000_002;
const REAL_TABLE = { [process.pid]: { ppid: OMP, argv: [process.execPath, "--test"], lstart: "runner-start" }, [OMP]: { ppid: 1, argv: ["bun", "/home/u/.bun/bin/omp"], lstart: "omp-start" } };

function rotateFixture() {
  const f = fixture();
  // The recorded controller is this test runner: alive, started when recorded, and an ancestor of the rotation.
  writeFileSync(join(f.fleet, "heartbeat.json"), JSON.stringify({ quiet: 0, digest: "", controller: { pid: process.pid, lstart: "runner-start", prior: "dead", at: RUN_AT } }));
  const table = join(f.dir, "proc-table.json");
  writeFileSync(table, JSON.stringify(REAL_TABLE));
  const rotate = () => spawnSync(process.execPath, [join(REAL_SCRIPTS, "ledger.mjs"), "rotate"], {
    cwd: f.repo, encoding: "utf8", env: { ...GIT_ENV, FLEET_PROC_TABLE: table },
  });
  return { f, rotate };
}

const namesIn = (dir) => readdirSync(dir);

test("ledger.mjs rotate archives closeout.json beside the ledger under the ledger archive's own timestamp", () => {
  const { f, rotate } = rotateFixture();
  writeFileSync(f.receiptPath, '{"reason": "r"}\n');
  const r = rotate();
  assert.equal(r.status, 0, r.stderr);
  const names = namesIn(f.fleet);
  const ledger = names.filter((n) => /^ledger\..+\.md$/.test(n));
  const receipt = names.filter((n) => /^closeout\..+\.json$/.test(n));
  assert.equal(ledger.length, 1, names.join());
  assert.equal(receipt.length, 1, names.join());
  assert.equal(receipt[0], ledger[0].replace(/^ledger\./, "closeout.").replace(/\.md$/, ".json"), "one timestamp names both");
  assert.equal(readFileSync(join(f.fleet, receipt[0]), "utf8"), '{"reason": "r"}\n', "the receipt is archived byte for byte");
  assert.equal(existsSync(f.receiptPath), false, "no receipt is left for the next run to resume");
  assert.match(r.stderr, /archived .*closeout\.json -> .*closeout\..+\.json/);
});

test("ledger.mjs rotate files phase0.json and closeout.json under one stamp together", () => {
  const { f, rotate } = rotateFixture();
  writeFileSync(f.receiptPath, "{}\n");
  writeFileSync(join(f.fleet, "phase0.json"), "{}\n");
  const r = rotate();
  assert.equal(r.status, 0, r.stderr);
  const names = namesIn(f.fleet);
  const stamp = names.find((n) => /^ledger\..+\.md$/.test(n)).slice("ledger.".length, -".md".length);
  assert.deepEqual(names.filter((n) => /^(closeout|phase0)\./.test(n)).sort(), [`closeout.${stamp}.json`, `phase0.${stamp}.json`]);
});

test("ledger.mjs rotate with no closeout.json archives the ledger exactly as before", () => {
  const { f, rotate } = rotateFixture();
  const r = rotate();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(namesIn(f.fleet).filter((n) => /^ledger\..+\.md$/.test(n)).length, 1);
  assert.deepEqual(namesIn(f.fleet).filter((n) => /^closeout\./.test(n)), []);
  assert.doesNotMatch(r.stderr, /could not archive|refusing/);
});

test("ledger.mjs rotate refuses when closeout.json's archive name is taken, moving nothing", () => {
  const { f, rotate } = rotateFixture();
  writeFileSync(f.receiptPath, '{"reason": "r"}\n');
  const ledgerBefore = readFileSync(join(f.fleet, "ledger.md"), "utf8");
  const now = Date.now();
  // Every second this call can plausibly land on is taken.
  for (let s = -2; s < 30; s++) writeFileSync(join(f.fleet, `closeout.${new Date(now + s * 1000).toISOString().replace(/\.\d{3}Z$/, "Z").replaceAll(":", "")}.json`), "older receipt\n");
  const r = rotate();
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refusing to rotate .*closeout\..*\.json already exists/);
  assert.equal(readFileSync(f.receiptPath, "utf8"), '{"reason": "r"}\n', "the receipt stays where it was");
  assert.equal(readFileSync(join(f.fleet, "ledger.md"), "utf8"), ledgerBefore, "the ledger stays where it was");
  assert.deepEqual(namesIn(f.fleet).filter((n) => /^ledger\..+\.md$/.test(n)), [], "no ledger archive was made");
});

test("ledger.mjs rotate that cannot move closeout.json warns and still succeeds", () => {
  const { f } = rotateFixture();
  writeFileSync(f.receiptPath, "{}\n");
  const preload = join(f.dir, "fail-receipt-rename.cjs");
  writeFileSync(preload, `const fs = require("node:fs");
const real = fs.renameSync;
fs.renameSync = (from, to) => {
  if (/closeout\\.json$/.test(String(from))) throw Object.assign(new Error("EXDEV: injected"), { code: "EXDEV" });
  return real(from, to);
};
require("node:module").syncBuiltinESMExports();
`);
  const table = join(f.dir, "proc-table.json");
  const r = spawnSync(process.execPath, ["--require", preload, join(REAL_SCRIPTS, "ledger.mjs"), "rotate"], {
    cwd: f.repo, encoding: "utf8", env: { ...GIT_ENV, FLEET_PROC_TABLE: table },
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /could not archive .*closeout\.json -> .*closeout\..+\.json: EXDEV: injected/);
  assert.equal(existsSync(f.receiptPath), true, "the receipt is left where it was");
});

// ── reopen ───────────────────────────────────────────────────────────────────

test("reopen: refuses with exit 2 once a finish step is ok, and changes neither the receipt nor the marker", () => {
  const f = fixture();
  assert.equal(f.run("begin", ["--reason", "wrap up"]).status, 0);
  const receipt = f.receipt();
  receipt.steps.tick = { status: "ok", at: new Date().toISOString(), output: "" };
  writeFileSync(f.receiptPath, JSON.stringify(receipt));
  const before = readFileSync(f.receiptPath, "utf8");
  const r = f.run("reopen", ["--reason", "mistake"]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.match(r.err, /reopen refused: finish step tick is already ok/);
  assert.equal(readFileSync(f.receiptPath, "utf8"), before);
  assert.equal(f.ledgerRead().drain, "wrap up");
});

test("reopen: a finish whose tick failed blocks nothing; the marker clears and begin's two steps go back to pending", () => {
  const f = fixture();
  f.setLedger(["#12 impl-12"]);
  assert.equal(f.run("begin", ["--reason", "wrap up"]).status, 0);
  f.control("fleet-tick", { out: "" });
  assert.equal(f.run("finish", ["--reason", "wrap up"]).status, 3);
  assert.equal(f.receipt().steps.tick.status, "failed");
  const r = f.run("reopen", ["--reason", "mistake"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.match(r.stdout, /^closeout: reopen: ok$/m);
  assert.equal(f.ledgerRead().drain, null);
  const receipt = f.receipt();
  assert.deepEqual(statusOf(receipt, BEGIN_STEPS), { drain: "pending", release: "pending" });
  assert.equal(receipt.begun, null);
  assert.equal(receipt.steps.tick.status, "failed", "a finish step is left as it was");
});

test("reopen: a second begin drains again and releases the claim a re-dispatched member took under its retry name", () => {
  const f = fixture();
  f.setLedger(["#12 impl-12"]);
  assert.equal(f.run("begin", ["--reason", "first"]).status, 0);
  assert.equal(f.run("reopen", ["--reason", "mistake"]).status, 0);
  f.setLedger(["#12 impl-12-b"]);
  const r = f.run("begin", ["--reason", "second"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.deepEqual(statusOf(f.receipt(), BEGIN_STEPS), allOk(BEGIN_STEPS));
  assert.equal(f.ledgerRead().drain, "second");
  assert.deepEqual(f.ledgerRows(), ["#12 impl-12-b=released"]);
  assert.equal(f.order().filter((l) => l.startsWith("release-ticket")).length, 2);
});

test("reopen: an undrain that fails leaves begin's steps pending under the standing marker, so the next begin drains again", () => {
  const f = fixture();
  assert.equal(f.run("begin", ["--reason", "wrap up"]).status, 0);
  f.control("ledger-fail", { undrain: "ledger: boom\n" });
  const r = f.run("reopen", ["--reason", "mistake"]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.match(r.err, /ledger\.mjs undrain failed: .*boom/);
  assert.doesNotMatch(r.stdout, /reopen: ok/);
  assert.equal(f.ledgerRead().drain, "wrap up");
  assert.deepEqual(statusOf(f.receipt(), BEGIN_STEPS), { drain: "pending", release: "pending" });
  assert.equal(f.receipt().begun, null);
  f.control("ledger-fail", {});
  const again = f.run("begin", ["--reason", "wrap up"]);
  assert.equal(again.status, 0, again.err + again.stdout);
  assert.match(f.receipt().steps.drain.output, /"created":false/, "begin ran ledger.mjs drain again, which answered with the standing marker");
});

test("reopen: a receipt whose drain is ok over a ledger with no marker still goes back before the refusal, so the next begin drains", () => {
  const f = fixture();
  assert.equal(f.run("begin", ["--reason", "wrap up"]).status, 0);
  const byHand = spawnSync(process.execPath, [join(SCRIPTS, "ledger.mjs"), "undrain", "by hand"], { cwd: f.repo, encoding: "utf8", env: { ...GIT_ENV, CLOSEOUT_STUBS: f.stubs } });
  assert.equal(byHand.status, 0, byHand.stderr);
  const r = f.run("reopen", ["--reason", "mistake"]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.match(r.err, /nothing to undrain/);
  assert.deepEqual(statusOf(f.receipt(), BEGIN_STEPS), { drain: "pending", release: "pending" });
  assert.equal(f.receipt().begun, null);
  assert.equal(f.run("begin", ["--reason", "wrap up"]).status, 0);
  assert.equal(f.ledgerRead().drain, "wrap up");
});

test("reopen: with no marker set, refuses with exit 2 and writes no receipt", () => {
  const f = fixture();
  const r = f.run("reopen", ["--reason", "mistake"]);
  assert.equal(r.status, 2, r.err + r.stdout);
  assert.match(r.err, /nothing to undrain/);
  assert.equal(existsSync(f.receiptPath), false);
});

test("reopen: with no closeout receipt, a bare ledger drain is undrained and no receipt is written", () => {
  const f = fixture();
  const drain = spawnSync(process.execPath, [join(SCRIPTS, "ledger.mjs"), "drain", "bare"], { cwd: f.repo, encoding: "utf8", env: { ...GIT_ENV, CLOSEOUT_STUBS: f.stubs } });
  assert.equal(drain.status, 0, drain.stderr);
  const r = f.run("reopen", ["--reason", "mistake"]);
  assert.equal(r.status, 0, r.err + r.stdout);
  assert.equal(f.ledgerRead().drain, null);
  assert.equal(existsSync(f.receiptPath), false);
});
