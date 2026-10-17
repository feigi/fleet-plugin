# A Tick That Reads The Member Registry To Name A Parked Member

`fleet-tick` reads the ledger, the heartbeat's own `seen` stamps and a
directory listing of the session directory. We don't accept making it read
the member registry, or a heartbeat prompt that asks for a census after a
resume, so that a parked member is named on the first tick that sees it.

## Why this is out of scope

**A script cannot read the registry or detect a compaction.** The registry
and transcripts are reachable through `history://` and `proc://`, which are
controller tools; a shell or node process gets ENOENT. Compaction parks
members with no marker on disk, and the controller record only changes when
the ledger rotates at phase 0. Nothing a tick can read says "resumed".

**The census is the controller's job already.** The carried-token reconcile
at phase 0 and the run ledger's census-first rule put the registry check in
the controller, which is the only place it can run. A parked member with a
transcript is silent to the no-transcript check by design.

**A shorter review threshold amends a ruled measurement.** The liveness
thresholds are measured p99 values. Lowering the review one would still not
name the member on the first tick, and would fire on the rate the ruling was
made against.

## What would reopen this

A harness change that lets a script read the registry, or a durable
compaction marker on disk.

## Prior requests

- #3382 — "fleet-tick: a parked member reads as live — ledger tokens are never checked against the member registry"
