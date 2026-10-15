#!/usr/bin/env node
// Closeout the run: drain claims, release unclaimed tickets, scrape and commit metrics.
//
//   closeout.mjs begin --reason "<r>"
//   closeout.mjs finish --reason "<r>" [--branch <name>]
//
// Reached through the Resolver and run from the MAIN checkout. The receipt
// `.fleet/closeout.json` is resolved through fleet-dir.mjs, so a worktree and
// the main checkout name one file.
//
// `begin` drains the ledger, releases every claim without a PR, and writes
// the receipt with `begun` status. A re-run skips `ok` steps.
//
// `finish` runs six ordered steps: tick gate, scrape, tier-outcomes check,
// metrics refresh, commit and PR, then heartbeat stop. Exit codes are 0 for
// success, 2 for usage error, 3 for a step refusal, and 4 for a pending NEED.

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { gitEnv } from "./git-env.mjs";
import { isCLI } from "./is-cli.mjs";

const NAME = "closeout";
const SCRIPTS = dirname(fileURLToPath(import.meta.url));

const script = (name) => join(SCRIPTS, name);
const node = (name, args, opts = {}) =>
  spawnSync(process.execPath, [script(name), ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });
const sh = (name, args, opts = {}) =>
  spawnSync("sh", [script(name), ...args], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    ...opts,
  });

// ── receipt ──────────────────────────────────────────────────────────────────

function getFleetDir() {
  const result = node("fleet-dir.mjs");
  if (result.status !== 0) {
    console.error(`fatal: fleet-dir.mjs failed: ${result.stderr}`);
    process.exit(3);
  }
  return result.stdout.trim();
}

function readReceipt(path) {
  try {
    const text = readFileSync(path, "utf8");
    return JSON.parse(text);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    console.error(`fatal: cannot read receipt ${path}: ${e.message}`);
    process.exit(3);
  }
}

function writeReceipt(path, receipt) {
  try {
    const tmp = `${path}.${process.pid}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (e) {
    console.error(`fatal: cannot write receipt ${path}: ${e.message}`);
    process.exit(3);
  }
}

const timestamp = () => new Date().toISOString();

// ── steps ────────────────────────────────────────────────────────────────────

function stepDrain(reason) {
  const result = node("ledger.mjs", ["drain", reason]);
  if (result.status === 0) {
    return { status: "ok", output: result.stdout.trim() };
  }
  // Check if already drained
  if (result.stdout.includes("already drained")) {
    return { status: "ok", output: "already drained" };
  }
  return { status: "failed", output: result.stderr.trim() };
}

function stepRelease(reason) {
  // Read ledger to find tickets with impl- but no PR#
  const ledgerRead = node("ledger.mjs", ["read"]);
  if (ledgerRead.status !== 0) {
    return { status: "failed", output: `ledger read failed: ${ledgerRead.stderr.trim()}` };
  }

  let data;
  try {
    data = JSON.parse(ledgerRead.stdout);
  } catch (e) {
    return { status: "failed", output: `ledger JSON parse failed: ${e.message}` };
  }

  const needRelease = [];
  const released = [];

  // Find all rows with impl- but no PR#
  if (!data.rows) return { status: "ok", output: "no rows to release" };

  for (const row of data.rows) {
    const parts = row.split(/\s+/);
    if (parts.length < 1) continue;

    const ticketKey = parts[0]; // Should be #N
    if (!ticketKey.match(/^#\d+$/)) continue;

    const ticket = ticketKey.slice(1);
    let implToken = null;
    let hasReviewedOrPR = false;

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      // Look for impl-N token (live, not settled)
      if (part.match(/^impl-\d+$/) && !part.includes("=")) {
        implToken = part;
      }
      // Check for PR# or reviewed=
      if (part.includes("PR#") || part.includes("reviewed=")) {
        hasReviewedOrPR = true;
      }
    }

    // If we have impl- but no PR# or reviewed=, try to release
    if (implToken && !hasReviewedOrPR) {
      const release = sh("release-ticket.sh", [ticket, implToken, "implementer", "--apply"]);
      if (release.status === 0) {
        const settle = node("ledger.mjs", ["settle", `${implToken}=released`]);
        if (settle.status === 0) {
          released.push(`${ticket}/${implToken}`);
        } else {
          needRelease.push(`#${ticket}: settle failed`);
        }
      } else {
        // Extract the blocker message from release output
        const output = release.stdout.trim() || release.stderr.trim();
        const blocker = output.split("\n")[0];
        console.log(`NEED hand-release #${ticket} ${blocker}`);
      }
    }
  }

  if (needRelease.length > 0) {
    // Return pending if there are any unreleasable
    return { status: "pending", output: `released: ${released.join(", ")}` };
  }

  return { status: "ok", output: released.length > 0 ? `released: ${released.join(", ")}` : "no claims released" };
}

function stepTick() {
  const result = node("fleet-tick.mjs");
  if (result.status !== 0) {
    return { status: "failed", output: `tick failed: ${result.stderr.trim()}` };
  }

  const lines = result.stdout.trim().split("\n");
  const lastLine = lines[lines.length - 1] || "";

  if (!lastLine.includes("ACTION: run over")) {
    return { status: "failed", output: `tick did not complete: ${lastLine}` };
  }

  return { status: "ok", output: "tick completed: run over" };
}

function stepScrape() {
  // Scrape member outcomes for this session
  const result = node("member-record.mjs", ["encodeProjectDir"]);
  if (result.status !== 0) {
    return { status: "ok", output: "no scraper output" };
  }
  return { status: "ok", output: result.stdout.trim() };
}

function stepTierOutcomes() {
  const result = node("tier-outcomes.mjs", ["check", "--live"]);
  if (result.status === 0) {
    return { status: "ok", output: result.stdout.trim() };
  }

  // Exit 4 means there are NEED tier-outcomes append lines
  if (result.status === 4) {
    const lines = result.stdout.trim().split("\n");
    for (const line of lines) {
      if (line.includes("NEED tier-outcomes")) {
        console.log(line);
      }
    }
    return { status: "pending", output: "tier-outcomes missing rows" };
  }

  return { status: "failed", output: result.stderr.trim() };
}

function stepMetrics() {
  const result = node("metrics-refresh.mjs");
  if (result.status === 0) {
    return { status: "ok", output: result.stdout.trim() };
  }
  if (result.status === 1 || result.status === 2) {
    return { status: "failed", output: `metrics-refresh failed` };
  }
  return { status: "failed", output: result.stderr.trim() };
}

function stepCommitAndPR(reason, branchNameArg) {
  // Get main checkout
  const mainCheckoutResult = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: "pipe",
    env: gitEnv(),
  });
  if (mainCheckoutResult.status !== 0) {
    return { status: "failed", output: "not in git repository" };
  }
  const cwd = mainCheckoutResult.stdout.trim();

  // Generate or use provided branch name
  let branchName = branchNameArg;
  if (!branchName) {
    const date = new Date().toISOString().split("T")[0].replace(/-/g, "");
    branchName = `chore/run-artifacts-${date}`;

    // Check for unique name
    let suffix = "";
    while (true) {
      const fullName = branchName + suffix;
      const localCheck = spawnSync("git", ["rev-parse", "--verify", fullName], {
        cwd,
        stdio: "pipe",
        env: gitEnv(),
      });
      const remoteCheck = spawnSync("git", ["ls-remote", "origin", `refs/heads/${fullName}`], {
        cwd,
        stdio: "pipe",
        env: gitEnv(),
      });

      if (localCheck.status !== 0 && remoteCheck.stdout.toString().trim() === "") {
        branchName = fullName;
        break;
      }

      suffix = suffix ? String.fromCharCode(suffix.charCodeAt(0) + 1) : "b";
      if (suffix > "z") {
        return { status: "failed", output: "could not find unique branch name" };
      }
    }
  }

  // Create branch
  const switchResult = spawnSync("git", ["switch", "-c", branchName], {
    cwd,
    stdio: "pipe",
    env: gitEnv(),
  });
  if (switchResult.status !== 0) {
    return { status: "failed", output: "git switch failed" };
  }

  // Commit the three metrics files
  const commitResult = spawnSync("git", ["commit", "docs/metrics/member-outcomes.tsv", "docs/metrics/ticket-features.tsv", "docs/metrics/tier-outcomes.tsv", "-m", `Closeout: ${reason}`], {
    cwd,
    stdio: "pipe",
    env: gitEnv(),
  });
  if (commitResult.status !== 0) {
    spawnSync("git", ["switch", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    return { status: "failed", output: "git commit failed" };
  }

  // Push
  const pushResult = spawnSync("git", ["push", "-u", "origin", branchName], {
    cwd,
    stdio: "pipe",
    env: gitEnv(),
  });
  if (pushResult.status !== 0) {
    spawnSync("git", ["switch", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    return { status: "failed", output: "git push failed" };
  }

  // Create PR
  const prResult = spawnSync("gh", ["pr", "create", "--label", "patch", "--body", `Closeout: ${reason}`], {
    cwd,
    stdio: "pipe",
  });
  if (prResult.status !== 0) {
    spawnSync("git", ["switch", "main"], { cwd, stdio: "pipe", env: gitEnv() });
    return { status: "failed", output: "gh pr create failed" };
  }

  // Switch back to main
  spawnSync("git", ["switch", "main"], { cwd, stdio: "pipe", env: gitEnv() });

  return { status: "ok", output: `PR created on ${branchName}` };
}

function stepHeartbeatStop(reason) {
  const result = node("fleet-heartbeat.mjs", ["--stop", reason]);
  if (result.status === 0) {
    return { status: "ok", output: result.stdout.trim() };
  }
  return { status: "failed", output: result.stderr.trim() };
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd) {
    console.error(`usage: ${NAME}.mjs begin|finish --reason <reason> [options]`);
    process.exit(2);
  }

  const reasonIdx = args.indexOf("--reason");
  if (reasonIdx === -1 || reasonIdx + 1 >= args.length) {
    console.error(`usage: ${NAME}.mjs ${cmd} --reason <reason> [options]`);
    process.exit(2);
  }
  const reason = args[reasonIdx + 1];

  const receiptPath = join(getFleetDir(), "closeout.json");

  if (cmd === "begin") {
    const receipt = readReceipt(receiptPath) || {
      reason,
      begun: null,
      steps: {
        drain: { status: "pending", at: null, output: "" },
        release: { status: "pending", at: null, output: "" },
      },
    };

    // drain step
    if (receipt.steps.drain.status !== "ok") {
      const step = stepDrain(reason);
      receipt.steps.drain = { ...step, at: timestamp() };
      console.log(`closeout: drain: ${step.status}`);
      if (step.output) console.log(step.output);

      if (step.status === "failed") {
        writeReceipt(receiptPath, receipt);
        process.exit(3);
      }
    }

    // release step
    if (receipt.steps.release.status !== "ok") {
      const step = stepRelease(reason);
      receipt.steps.release = { ...step, at: timestamp() };
      console.log(`closeout: release: ${step.status}`);
      if (step.output) console.log(step.output);

      if (step.status === "failed") {
        writeReceipt(receiptPath, receipt);
        process.exit(3);
      }

      if (step.status === "pending") {
        receipt.begun = timestamp();
        writeReceipt(receiptPath, receipt);
        process.exit(4);
      }
    }

    receipt.begun = timestamp();
    writeReceipt(receiptPath, receipt);
    process.exit(0);
  } else if (cmd === "finish") {
    const branchIdx = args.indexOf("--branch");
    const branchName = branchIdx !== -1 && branchIdx + 1 < args.length ? args[branchIdx + 1] : null;

    const receipt = readReceipt(receiptPath) || {
      reason,
      begun: null,
      steps: {
        tick: { status: "pending", at: null, output: "" },
        scrape: { status: "pending", at: null, output: "" },
        "tier-outcomes": { status: "pending", at: null, output: "" },
        metrics: { status: "pending", at: null, output: "" },
        "commit-and-pr": { status: "pending", at: null, output: "" },
        "heartbeat-stop": { status: "pending", at: null, output: "" },
      },
    };

    const stepNames = ["tick", "scrape", "tier-outcomes", "metrics", "commit-and-pr", "heartbeat-stop"];
    const stepFuncs = {
      tick: stepTick,
      scrape: stepScrape,
      "tier-outcomes": stepTierOutcomes,
      metrics: stepMetrics,
      "commit-and-pr": () => stepCommitAndPR(reason, branchName),
      "heartbeat-stop": () => stepHeartbeatStop(reason),
    };

    let failureFound = false;

    for (const stepName of stepNames) {
      if (receipt.steps[stepName].status === "ok") {
        console.log(`closeout: ${stepName}: ok`);
        continue;
      }

      if (failureFound) {
        receipt.steps[stepName].status = "pending";
        console.log(`closeout: ${stepName}: pending`);
        continue;
      }

      const step = stepFuncs[stepName]();
      receipt.steps[stepName] = { ...step, at: timestamp() };
      console.log(`closeout: ${stepName}: ${step.status}`);
      if (step.output) console.log(step.output);

      if (step.status === "failed") {
        failureFound = true;
        writeReceipt(receiptPath, receipt);
        process.exit(3);
      }

      if (step.status === "pending") {
        writeReceipt(receiptPath, receipt);
        process.exit(4);
      }
    }

    writeReceipt(receiptPath, receipt);
    process.exit(0);
  } else {
    console.error(`usage: ${NAME}.mjs begin|finish --reason <reason> [options]`);
    process.exit(2);
  }
}

if (isCLI(import.meta.url)) main();
