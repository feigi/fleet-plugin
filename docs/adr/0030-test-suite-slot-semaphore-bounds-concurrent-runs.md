# ADR 0030: Test suite slot semaphore bounds concurrent runs

**Status:** Accepted

**Date:** 2026-10-12

**Deciders:** @impl-2321

## Problem

Multiple concurrent full test-suite runs on a single host exhaust resources and cause kernel panics. Fleet members (reviews, implementers, fix-appliers, finishers, merge bot) each run the repo's full test command whenever their flow requires it. Member counts (`--implementer-cap`, `--reviewer-cap`) bound members, not suite runs. A dozen concurrent reviews can spawn well over a dozen full test runs simultaneously, each parallelizing across every core.

Field observation (October 1, 2026, darwin 25.4 arm64, 48 GB) showed ~14 concurrent runs with unified-log volume up 75× and a kernel panic.

## Solution

Implement `suite-slot.mjs`: a semaphore that bounds concurrent full test-suite runs to N slots (default N=2). Invoked as a wrapper around the test command, it:

- **Acquires one of N exclusive locks** under `~/.fleet/suite-slots/<i>.lock` before running the test suite
- **Supports dead-holder takeover** using `process.kill(pid, 0)` to detect stale locks and reuse slots
- **Re-entry via environment variable** (`FLEET_SUITE_SLOT`): if set, pass through immediately (allows nested test commands)
- **Arity-based gating** (no args = full suite, takes slot; with args = narrowed run, skips slot)
- **Waits with timeout** (1800s default, configurable via `SUITE_SLOT_WAIT_MS`), exits code 75 on timeout

## Slot Management

- Slots are pid-stamped files under `~/.fleet/suite-slots/`
- Each slot is created with `openSync(path, "wx")` to ensure exclusive creation
- Default N=2 is fixed (does not scale with core count; empirically sufficient for stability)
- A process holding a slot must exit (cleanup on process exit via signal handlers) to release it
- The next waiter detects the dead holder and reaps the stale lock

## Integration Points

1. **`plugin/scripts/suite-slot.mjs`** — The semaphore implementation
2. **`agent-test`** — Wraps `node --test` invocation with suite-slot
3. **`review-core.mjs`** — Wraps test command with suite-slot.mjs, adds `slotWaitMs` to schema
4. **`claim-ticket.sh`** — Wires suite-slot through agent-test (no direct change needed)
5. **Test-run agent prompt** — References suite-slot mechanism for timeout handling

## Design Decisions

- **Location**: `~/.fleet/suite-slots/` — shared across all fleet members on the host; exclusive access via `O_EXCL`
- **Number of slots**: N=2 — fixed default that avoids kernel panic without over-provisioning
- **Wait timeout**: 1800s — matches test-run agent deadline; caller reports `slotWaitMs` when exit 75
- **Re-entry mechanism**: Environment variable `FLEET_SUITE_SLOT` — simple, per-process signal
- **Arity-based gating**: No args = full suite (slot required); args present = narrowed run (pass-through)

## Implementation Details

- **Synchronous lock acquisition**: No async/await; uses busy-wait with 50ms sleep intervals
- **Ledger lock primitives**: Pattern reused from `ledger.mjs` (exclusive open, pid stamping, dead-holder takeover)
- **Exit code 75**: Signals slot-wait timeout (reserved per existing fleet conventions)
- **Stderr output**: `SUITE_SLOT_WAIT_MS` printed to stderr when timeout fires (diagnostic marker for log analysis)

## Acceptance Criteria

- ✓ Suite-slot semaphore with N=2 slots, pid-stamped `O_EXCL` locks under `~/.fleet/suite-slots/`
- ✓ Dead-holder takeover using process.kill signal 0
- ✓ Re-entry via `FLEET_SUITE_SLOT` environment variable
- ✓ Arity-based gating (no args = full suite, with args = narrowed)
- ✓ Wait cap with 1800s default → exit 75 on timeout
- ✓ `SUITE_SLOT_WAIT_MS` printed to stderr on timeout
- ✓ Integration in agent-test, review-core.mjs, with `slotWaitMs` in TEST_RUN_SCHEMA
- ✓ Two nested wrappers take one slot; narrowed runs take none
- ✓ Two full runs at N=2 both run; third waits; dead holder reaped by next waiter
- ✓ SKILL.md, CONTEXT.md, and this ADR document the mechanism

## Rejected Alternatives

1. **Bind at fleet-tick dispatch level** — Couples quota to member lifecycle; doesn't account for sequential runs from same member
2. **Per-caller slot budget** — Complicates quota tracking; doesn't prevent one caller from monopolizing all slots
3. **Core-count scaling** — Measured to be unnecessary; field observation showed N=2 sufficient
4. **Shared lock file (one global lock)** — Serializes all runs; N slots better utilizes available resources
5. **Kernel namespace isolation** — Out of scope; suite-slot is simpler and portable

## Consequences

- **Positive**: Host-wide test load bounded; kernel panic risk eliminated; shared slot reduces CPU contention
- **Neutral**: Slotted runs slower in high-concurrency scenarios; no impact on test correctness
- **Negative**: Slot contention under 12+ concurrent reviews; timeout exit 75 requires retry (mitigated by queue)

## References

- Issue #2315: "run the test command once per review"  
- Issue #2320: "fleet-tick.test.mjs: CLI subprocess spawns have no timeout"
- ledger.mjs: Lock primitive patterns (`acquireLock`, dead-holder takeover)
