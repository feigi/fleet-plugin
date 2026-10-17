# A Test That Resolves `path:N` Citations In `docs/research` And `docs/specs`

`docs/research/` and `docs/specs/` quote code as `path:N` cites. Every edit to
a cited file moves lines, so the cites drift. We don't accept a test, gate or
sweep that resolves those cites and fails when one stops landing. The files
are dated records, not maintained docs.

## Why this is out of scope

**A dated record is read at the commit that last changed the row.** Each
row's cites hold against the tree as it was when the row was last written.
To read one, find that commit with `git blame` or `git log -L` and read the
file with `git show <sha>:path`. A single "as of" sha for a whole census file
would be false: many commits re-cited rows one at a time against different
heads, so no one sha resolves every row without re-checking all of them.

**The guard costs more than the drift.** About twenty-five closed point-fix
tickets re-pinned a cite after a `SKILL.md` edit moved it (#2591, #2612,
#2684, #2691 among them). A guard would turn each of those into a red build on
an unrelated PR. A naive checker is red on day one: the cite shapes include
bare basenames, ranges, rows that say `was` or `Retired`, and fragments that
were true only before a later edit.

**The records already say they drift.** The slot-based fleet loop spec states
that its line numbers are against a named `origin/main` sha and "drift;
re-grep". Re-citing a spec marked decided rewrites history.

## What would reopen this

A decision that a specific census becomes a maintained doc whose cites are
read as current. That would be a ruling on that one file, with its own ticket,
not a repo-wide gate.

## Prior requests

- #2732 — "external-assumptions: no test resolves prose.md's path:N cites, so every SKILL.md edit re-drifts them"
- #2153, #2634, #2445, #2709 — the same drift filed against a single row, closed on the records ruling
- #3249 — "harness-node.md rows 39, 40, 44, 45, 59, 60 cite review-core.mjs lines that no longer hold the cited text" — one more single-census drift filing, closed on the records ruling
- #3346 — "ADR 0007 and shell.md cite prove-merge.sh by stale line numbers" — the shell.md half declined on the records ruling; the ADR 0007 half proceeded, since `docs/adr/` is outside this record
- #3078 — "external-assumptions: harness-node rows citing board.mjs carry stale line numbers" — the four rows it measured hold at the commit that last changed each row; closed on the records ruling
