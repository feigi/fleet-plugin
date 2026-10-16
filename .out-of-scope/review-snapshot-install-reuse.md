# Reusing An Installed Tree For A Review Snapshot

A review run gets a `git archive` snapshot and runs the Install step in it. We
don't accept re-copying, symlinking or cloning an already-installed tree, or
its ignored paths, into the snapshot to save the install, or to cut the
per-run scratch each review leaves behind.

## Why this is out of scope

**The snapshot is deliberately a tracked-files copy.** `git archive` carries
tracked files only. The run then provisions its own dependencies with the
Install step, from the snapshot's root, before anyone measures in it.

**An installed tree is not portable.** An install can record absolute paths
back into the tree it was installed in. A copy, symlink or clone of its
ignored paths points at, or is built for, a different root, and fails
quietly or measures the wrong tree. The shipped review text already says to
never `cp -R` the snapshot and never symlink or clone its ignored paths.

**It would trade a disk cost for a silent-correctness cost.** The scratch a
review run leaves is reclaimed by the age-based sweep. A wrong dependency
tree gives confident review prose that was never measured.

## What would reopen this

A measured install format that is relocatable by construction, with a
ruling that names which ignored paths may be reused.

## Prior requests

- #3317 — "run-team scratch leaks ~1 GB/review-run" — the snapshot re-copy idea in its comments, declined when the ticket was triaged
