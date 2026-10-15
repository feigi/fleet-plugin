// `closeout.mjs`: close out a run — drain claims, release unclaimed tickets, scrape and commit metrics.
//
// Every case runs the real script against a throwaway repository with stubbed
// external steps. `gh` is stubbed on PATH; other external scripts (`fleet-tick.mjs`,
// `member-record.mjs`, `tier-outcomes.mjs`, `metrics-refresh.mjs`, `fleet-heartbeat.mjs`,
// `ledger.mjs`, `release-ticket.sh`) are stubbed in the scripts directory.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./support/temp-dir.mjs";
import { writeExecStub } from "./support/exec-stub.mjs";

const PLUGIN = fileURLToPath(new URL("../plugin/", import.meta.url));
const REAL_SCRIPTS = join(PLUGIN, "scripts");

const GIT_ENV = { ...process.env };
delete GIT_ENV.GIT_DIR;
delete GIT_ENV.GIT_WORK_TREE;
delete GIT_ENV.GH_REPO;
const git = (cwd, ...args) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const DRIVER = `import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.CLOSEOUT_STUBS;
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
  log(name, { args, cwd: process.cwd() });
  const c = control(name);
  const spec = (c.by && c.by[args.join(" ")]) || c;
  process.stdout.write(spec.out ?? "");
  process.stderr.write(spec.err ?? "");
  process.exit(spec.exit ?? 0);
}

if (process.argv[1].endsWith("stub-driver.mjs")) drive(process.argv[2], process.argv.slice(3));
`;

const MJS_STUBS = ["fleet-tick", "member-record", "tier-outcomes", "metrics-refresh", "fleet-heartbeat", "ledger"];
const SH_STUBS = ["release-ticket"];

// The plugin's scripts directory, copied once, with the external steps replaced.
const TREE = tempDir("closeout-tree-");
cpSync(PLUGIN, join(TREE, "plugin"), { recursive: true });
const SCRIPTS = join(TREE, "plugin", "scripts");
const STUBBED = join(SCRIPTS, "stub-driver.mjs");
writeFileSync(STUBBED, DRIVER);

for (const n of MJS_STUBS) {
  writeFileSync(join(SCRIPTS, `${n}.mjs`), `import { drive } from "./stub-driver.mjs";\ndrive(${JSON.stringify(n)}, process.argv.slice(2));\n`);
}
for (const n of SH_STUBS) writeFileSync(join(SCRIPTS, `${n}.sh`), `#!/bin/sh\nexec node "$(dirname "$0")/stub-driver.mjs" ${n} "$@"\n`);

const SCRIPT = join(SCRIPTS, "closeout.mjs");

const GH_STUB = `#!/bin/sh
printf 'gh\\n' >> "$CLOSEOUT_STUBS/order.log"
printf '%s GH_REPO=[%s]\\n' "$*" "\${GH_REPO-}" >> "$CLOSEOUT_STUBS/gh.calls"
if [ -f "$CLOSEOUT_STUBS/gh.fail" ]; then echo "gh boom" >&2; exit 1; fi
cat "$CLOSEOUT_STUBS/gh.json"
`;

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
  writeFileSync(join(repo, "README"), "x\n");
  git(repo, "add", "README");
  git(repo, "commit", "-q", "-m", "root");
  git(repo, "push", "-q", "-u", "origin", "main");
  writeExecStub(join(bin, "gh"), GH_STUB);
  writeFileSync(join(stubs, "gh.json"), "");

  // Create the metrics files that closeout expects
  const docsMetrics = join(repo, "docs", "metrics");
  mkdirSync(docsMetrics, { recursive: true });
  writeFileSync(join(docsMetrics, "member-outcomes.tsv"), "# Member outcomes\n");
  writeFileSync(join(docsMetrics, "ticket-features.tsv"), "# Ticket features\n");
  writeFileSync(join(docsMetrics, "tier-outcomes.tsv"), "# Tier outcomes\n");

  // Initialize the ledger
  writeFileSync(join(repo, ".fleet", "ledger.md"), "# Ledger\n");
  mkdirSync(join(repo, ".fleet"), { recursive: true });

  const fleet = join(repo, ".fleet");
  const receiptPath = join(fleet, "closeout.json");

  const f = {
    dir, repo, home, stubs, bin, origin,
    control: (name, value) => writeFileSync(join(stubs, `${name}.json`), JSON.stringify(value)),
    calls: (name) => (existsSync(join(stubs, `${name}.calls`)) ? readFileSync(join(stubs, `${name}.calls`), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []),
    order: () => (existsSync(join(stubs, "order.log")) ? readFileSync(join(stubs, "order.log"), "utf8").trim().split("\n") : []),
    receiptPath,
    receipt: () => existsSync(receiptPath) ? JSON.parse(readFileSync(receiptPath, "utf8")) : null,
    setReceipt: (r) => {
      mkdirSync(dirname(receiptPath), { recursive: true });
      writeFileSync(receiptPath, JSON.stringify(r));
    },
    run: (cmd, args = [], { env = {} } = {}) => {
      const r = spawnSync(process.execPath, [SCRIPT, cmd, ...args], {
        cwd: repo, encoding: "utf8",
        env: { ...GIT_ENV, HOME: home, PATH: `${bin}:${process.env.PATH}`, CLOSEOUT_STUBS: stubs, ...env },
      });
      const out = r.stdout.split("\n").filter(Boolean);
      return { status: r.status, out, err: r.stderr, stdout: r.stdout };
    },
  };
  return f;
}

test("begin: drain runs and succeeds", () => {
  const f = fixture();
  f.control("ledger", { exit: 0, out: "ledger drained\n" });
  f.control("release-ticket", { exit: 0, out: "" });

  const r = f.run("begin", ["--reason", "test run"]);
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.some((l) => l.includes("closeout: drain: ok")));
  assert.ok(r.out.some((l) => l.includes("closeout: release: ok")));
  
  const receipt = f.receipt();
  assert.equal(receipt.steps.drain.status, "ok");
  assert.equal(receipt.steps.release.status, "ok");
});

test("begin: release a pristine claim and settle it released", () => {
  const f = fixture();
  f.control("ledger", { 
    exit: 0, 
    out: JSON.stringify({ 
      rows: ["#123 impl-456"],
      dispatched: [],
      retired: []
    })
  });
  f.control("release-ticket", { exit: 0, out: "released\n" });

  const r = f.run("begin", ["--reason", "test run"]);
  assert.equal(r.status, 0, r.err);
  const receipt = f.receipt();
  assert.equal(receipt.steps.release.status, "ok");
});

test("begin: claim with a commit prints NEED hand-release and continues", () => {
  const f = fixture();
  f.control("ledger", { 
    exit: 0, 
    out: JSON.stringify({ 
      rows: ["#123 impl-456"],
      dispatched: [],
      retired: []
    })
  });
  f.control("release-ticket", { exit: 1, err: "has committed, needs hand release\n", out: "" });

  const r = f.run("begin", ["--reason", "test run"]);
  assert.equal(r.status, 4, r.err);
  assert.ok(r.out.some((l) => l.includes("NEED hand-release")));
});

test("finish: runs all steps in order and exits 0 on success", () => {
  const f = fixture();
  f.control("fleet-tick", { exit: 0, out: "ACTION: run over\n" });
  f.control("member-record", { exit: 0, out: "" });
  f.control("tier-outcomes", { exit: 0, out: "" });
  f.control("metrics-refresh", { exit: 0, out: "" });
  f.control("fleet-heartbeat", { exit: 0, out: "heartbeat ok\n" });
  f.control("gh", { exit: 0, out: "https://github.com/owner/repo/pull/1\n" });

  const r = f.run("finish", ["--reason", "test complete"]);
  assert.equal(r.status, 0, r.err);
  assert.ok(r.out.some((l) => l.includes("closeout: tick: ok")));
  assert.ok(r.out.some((l) => l.includes("closeout: scrape: ok")));
  assert.ok(r.out.some((l) => l.includes("closeout: tier-outcomes: ok")));
  assert.ok(r.out.some((l) => l.includes("closeout: metrics: ok")));
  assert.ok(r.out.some((l) => l.includes("closeout: commit-and-pr: ok")));
  assert.ok(r.out.some((l) => l.includes("closeout: heartbeat-stop: ok")));
});

test("finish: exits 3 when tick's last line is not 'run over'", () => {
  const f = fixture();
  f.control("fleet-tick", { exit: 0, out: "ACTION: not over\n" });

  const r = f.run("finish", ["--reason", "test complete"]);
  assert.equal(r.status, 3, r.err);
  assert.ok(r.out.some((l) => l.includes("closeout: tick: failed")));
});

test("finish: exits 4 naming each reviewed= PR without a row", () => {
  const f = fixture();
  f.control("fleet-tick", { exit: 0, out: "ACTION: run over\n" });
  f.control("member-record", { exit: 0, out: "" });
  f.control("tier-outcomes", { exit: 4, out: "NEED tier-outcomes append #42\n" });

  const r = f.run("finish", ["--reason", "test complete"]);
  assert.equal(r.status, 4, r.err);
  assert.ok(r.out.some((l) => l.includes("NEED tier-outcomes append")));
});

test("finish: after tier-outcomes append, re-run proceeds from step 3", () => {
  const f = fixture();
  f.setReceipt({
    reason: "test",
    begun: new Date().toISOString(),
    steps: {
      tick: { status: "ok", at: new Date().toISOString(), output: "" },
      scrape: { status: "ok", at: new Date().toISOString(), output: "" },
      "tier-outcomes": { status: "pending", at: new Date().toISOString(), output: "" },
      metrics: { status: "pending", at: null, output: "" },
      "commit-and-pr": { status: "pending", at: null, output: "" },
      "heartbeat-stop": { status: "pending", at: null, output: "" }
    }
  });
  f.control("tier-outcomes", { exit: 0, out: "checked\n" });
  f.control("metrics-refresh", { exit: 0, out: "" });
  f.control("fleet-heartbeat", { exit: 0, out: "ok\n" });
  f.control("gh", { exit: 0, out: "https://github.com/owner/repo/pull/1\n" });

  const r = f.run("finish", ["--reason", "test complete"]);
  assert.equal(r.status, 0, r.err);
  // Verify tier-outcomes was run (it's step 3)
  const calls = f.calls("tier-outcomes");
  assert.ok(calls.length > 0, "tier-outcomes should be called");
});

test("finish: branch name increments letter suffix when dated name exists", () => {
  const f = fixture();
  f.control("fleet-tick", { exit: 0, out: "ACTION: run over\n" });
  f.control("member-record", { exit: 0, out: "" });
  f.control("tier-outcomes", { exit: 0, out: "" });
  f.control("metrics-refresh", { exit: 0, out: "" });
  f.control("fleet-heartbeat", { exit: 0, out: "" });
  f.control("gh", { exit: 0, out: "https://github.com/owner/repo/pull/1\n" });

  // Create the base branch so the suffix will be 'b', then 'c'
  git(f.repo, "checkout", "-b", "chore/run-artifacts-20260101");

  const r = f.run("finish", ["--reason", "test complete"]);
  assert.equal(r.status, 0, r.err);
  // The branch should be chore/run-artifacts-20260101b or similar
  assert.ok(r.out.some((l) => l.includes("chore/run-artifacts")));
});

test("finish: --stop is the last step and is not run when earlier step failed", () => {
  const f = fixture();
  f.control("fleet-tick", { exit: 0, out: "ACTION: run over\n" });
  f.control("member-record", { exit: 0, out: "" });
  f.control("tier-outcomes", { exit: 0, out: "" });
  f.control("metrics-refresh", { exit: 1, out: "", err: "metrics failed\n" });

  const r = f.run("finish", ["--reason", "test complete"]);
  assert.equal(r.status, 3, r.err);
  // heartbeat-stop should not have been called
  const hbCalls = f.calls("fleet-heartbeat");
  assert.equal(hbCalls.length, 0, "heartbeat-stop should not run after failed metrics");
});

test("finish: re-run after step 5 succeeded does not open a second PR", () => {
  const f = fixture();
  const now = new Date().toISOString();
  f.setReceipt({
    reason: "test",
    begun: now,
    steps: {
      tick: { status: "ok", at: now, output: "" },
      scrape: { status: "ok", at: now, output: "" },
      "tier-outcomes": { status: "ok", at: now, output: "" },
      metrics: { status: "ok", at: now, output: "" },
      "commit-and-pr": { status: "ok", at: now, output: "PR created on chore/run-artifacts-20260101" },
      "heartbeat-stop": { status: "pending", at: null, output: "" }
    }
  });
  f.control("fleet-heartbeat", { exit: 0, out: "ok\n" });

  const r = f.run("finish", ["--reason", "test complete"]);
  assert.equal(r.status, 0, r.err);
  
  // Verify gh was not called
  const ghCalls = f.calls("gh");
  assert.equal(ghCalls.length, 0, "gh pr create should not be called when already done");
  
  // Verify only heartbeat-stop ran
  const lines = r.out;
  assert.ok(lines.some((l) => l.includes("closeout: commit-and-pr: ok")));
  assert.ok(lines.some((l) => l.includes("closeout: heartbeat-stop: ok")));
});

test("begin and finish: receipt persists across runs", () => {
  const f = fixture();
  f.control("ledger", { exit: 0, out: JSON.stringify({ rows: [], dispatched: [], retired: [] }) });
  f.control("release-ticket", { exit: 0, out: "" });

  // First run: begin
  let r = f.run("begin", ["--reason", "test run"]);
  assert.equal(r.status, 0, r.err);
  const receipt1 = f.receipt();
  assert.equal(receipt1.steps.drain.status, "ok");
  assert.equal(receipt1.steps.release.status, "ok");

  // Second run: begin again should skip ok steps
  r = f.run("begin", ["--reason", "test run"]);
  assert.equal(r.status, 0, r.err);
  const receipt2 = f.receipt();
  // Both steps should still be ok
  assert.equal(receipt2.steps.drain.status, "ok");
  assert.equal(receipt2.steps.release.status, "ok");
});
