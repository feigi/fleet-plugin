# Sweeping Orphaned Per-pid `.tmp` Files

Five scripts write state through a per-pid temp file and rename it into
place: `ledger.mjs` (`save()`), `fleet-state.mjs`, `main-checkout.mjs`,
`recipe-prove.mjs` and `shortlist.mjs`, each as `<file>.<pid>.tmp`. A holder
killed between the write and the rename leaves its temp file behind. We don't
accept a sweep for these leftovers, in the ledger alone or across all five.

## Why this is out of scope

**No leak has been seen.** A leftover needs a SIGKILL inside a write window of
about a millisecond. At triage there were no orphaned `*.tmp` files in this
repo's `.fleet/` or in any other `.fleet/` under `~/dev`.

**Fixing the ledger alone is a one-off.** The same pattern sits at four more
sites, and a ledger-only sweep leaves four identical gaps behind it.

## What would reopen this

An orphaned temp file actually found in a `.fleet/` directory. If it is, do
not add a directory sweep after `acquireLock()`. `save()` only runs under the
write lock (`ledger.mjs:746`), so a crash mid-save leaves
the dead pid in the lock file, and the next writer's reap of that holder
already knows the exact name. Make `reapDeadHolder(deadPid)` delete that one
file, `${file}.${deadPid}.tmp`, ignoring ENOENT. One delete, off the hot path,
with no directory scan.

## Prior requests

- #2085 — "ledger.mjs: crashed lock holders leave orphaned per-pid .tmp files forever"
