#!/usr/bin/env node
// Semaphore for bounded concurrent test-suite runs across fleet members.
//
// Usage: suite-slot.mjs '<entrypoint>' [args...]
//
// If FLEET_SUITE_SLOT is set, this is a re-entrant call — pass through to the
// entrypoint immediately. Otherwise, acquire one of N=2 slots under
// ~/.fleet/suite-slots/, run the entrypoint with the slot held, and release it.
//
// Arity-based gating: if args are present (narrowed run), skip slot acquisition
// and pass through. Only full suite runs (no args) take a slot.
//
// Slot files are created with O_EXCL, pid-stamped, and support dead-holder
// takeover. Wait timeout is configurable via SUITE_SLOT_WAIT_MS env var,
// defaulting to 1800s (1800000ms). Exits with code 75 on timeout.

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  unlinkSync,
  readFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { makeDie } from "./arg.mjs";

const NAME = "suite-slot";
const die = makeDie(NAME);

// Constants
const NUM_SLOTS = 2;
const SLOT_WAIT_MS = parseInt(process.env.SUITE_SLOT_WAIT_MS ?? "1800000", 10);
const SLOT_DIR = resolve(homedir(), ".fleet", "suite-slots");

// Entrypoint and arguments
const [entrypoint, ...args] = process.argv.slice(2);
if (!entrypoint) {
  die("usage: suite-slot.mjs '<entrypoint>' [args...]");
}

// Re-entry check: if FLEET_SUITE_SLOT is already set, pass through immediately
if (process.env.FLEET_SUITE_SLOT) {
  const result = spawnSync(entrypoint, [], {
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  process.exit(result.status ?? 0);
}

// Arity-based gating: if args present, skip slot acquisition (narrowed run)
if (args.length > 0) {
  const result = spawnSync([entrypoint, ...args].join(" "), [], {
    stdio: "inherit",
    shell: true,
    env: process.env,
  });
  process.exit(result.status ?? 0);
}

// Check if a process is dead
function isProcessDead(pid) {
  try {
    // Sending signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return false; // Process is alive
  } catch (e) {
    return true; // Process is dead
  }
}

// Acquire one of N slots
function acquireSlot() {
  // Ensure slot directory exists
  try {
    mkdirSync(SLOT_DIR, { recursive: true });
  } catch (e) {
    if (e.code !== "EEXIST") die(`cannot create ${SLOT_DIR}: ${e.message}`);
  }

  const deadline = Date.now() + SLOT_WAIT_MS;
  let slotIndex = null;

  // Try to acquire a slot
  for (;;) {
    for (let i = 1; i <= NUM_SLOTS; i++) {
      const slotPath = resolve(SLOT_DIR, `${i}.lock`);
      let fd = null;

      try {
        // O_EXCL will fail if file exists
        fd = openSync(slotPath, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        slotIndex = i;
        break;
      } catch (e) {
        if (fd !== null) {
          try {
            closeSync(fd);
          } catch (closeErr) {
            // Ignore close errors
          }
        }

        if (e.code === "EEXIST") {
          // Slot is held; check if holder is dead
          try {
            const holder = readFileSync(slotPath, "utf8").trim();
            const pid = parseInt(holder, 10);
            if (isNaN(pid)) continue;

            // Check if process is dead
            if (isProcessDead(pid)) {
              // Try to reap the dead holder
              try {
                unlinkSync(slotPath);
                // Retry this slot immediately
                fd = openSync(slotPath, "wx");
                writeSync(fd, String(process.pid));
                closeSync(fd);
                slotIndex = i;
                break;
              } catch (reapErr) {
                // Reap failed; continue to next slot
                continue;
              }
            }
          } catch (readErr) {
            // Can't read slot file; continue to next slot
            continue;
          }
        } else if (e.code !== "EEXIST") {
          die(`cannot create slot: ${e.message}`);
        }
      }
    }

    if (slotIndex !== null) break;

    // Check timeout
    if (Date.now() >= deadline) {
      // Timeout waiting for slot
      process.stderr.write(`SUITE_SLOT_WAIT_MS\n`);
      process.exit(75);
    }

    // All slots busy; sleep briefly and retry
    const start = Date.now();
    while (Date.now() - start < 50); // Busy-wait for 50ms
  }

  return slotIndex;
}

// Release slot
function releaseSlot(slotIndex) {
  if (slotIndex === null) return;
  const slotPath = resolve(SLOT_DIR, `${slotIndex}.lock`);
  try {
    const holder = readFileSync(slotPath, "utf8").trim();
    if (holder === String(process.pid)) {
      unlinkSync(slotPath);
    }
  } catch (e) {
    // Ignore errors on cleanup
  }
}

// Main execution
const slotIndex = acquireSlot();

// Set environment variable for re-entrant calls
process.env.FLEET_SUITE_SLOT = String(slotIndex);

// Register cleanup handler
process.on("exit", () => releaseSlot(slotIndex));
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => process.exit(2));
}

// Run the entrypoint
const result = spawnSync(entrypoint, [], {
  stdio: "inherit",
  shell: true,
  env: process.env,
});

process.exit(result.status ?? 0);
