# SIGKILL Bound on gh Spawns

Proposals to add `killSignal: "SIGKILL"` to the bounded `gh` spawns (`fleet-tick.mjs`,
`shortlist.mjs`, `ledger.mjs`, `board.mjs`), so a `gh` that ignores SIGTERM cannot outlive
its `timeout`, are refused. Those spawns keep the default kill signal.

## Why this is out of scope

The hazard is real only for a `gh` that traps or ignores SIGTERM. The real `gh` is a Go
binary that does not: measured with gh 2.102.0 against an unroutable host and
`timeout: 1500`, the spawn ends with `ETIMEDOUT`, `signal=SIGTERM`, at ~1.5 s, and
`killSignal: "SIGKILL"` gives the same timing. The overrun reproduces only with a stub
that runs `trap '' TERM` (~4.25 s against 1.0 s with SIGKILL). Nothing in the repo's docs
or tests treats a SIGTERM-immune `gh` as a supported case.

The repo already splits the convention by trust: spawns of untrusted or user-supplied
commands (`recipe-prove.mjs`, `net.sh`'s `net_kill_tree`) escalate to SIGKILL; trusted
binaries (`gh`, `git`) keep the default. SIGKILL would also not bound a `gh` stuck in
uninterruptible sleep. Changing every site defends against a caller nobody has shown.

## Re-open trigger

A measured case where a real `gh`, or a `gh` wrapper the docs tell users to install,
outlives its bound. The remedy then is `killSignal: "SIGKILL"` on every bounded spawn in
`fleet-tick.mjs`, with the "every gh spawn passes the shared bound" sweep in
`fleet-tick.test.mjs` extended to require it.

## Prior requests

- #2645 — "fleet-tick: gh spawns do not set killSignal, so a gh that ignores SIGTERM outlives the bound"
