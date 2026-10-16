# Failure handling: the evidence behind its rules

Evidence for the rules SKILL.md states in **Failure handling**, keyed by the rule each justifies.

## A frozen transcript does not establish that a member is dead

**A frozen transcript does not establish that a member is dead — the
discriminator is its scratch dir.** A member wedged on a blocked tool call
emits the whole signature of a dead one: record counts unchanged from one poll
of its transcript to the next. So read the mtimes of the files anywhere under
the scratch directory its own dispatch prompt assigned it, subdirectories
included — `<scratch>/impl-<N>/` for an implementer, that member's own
run-scoped subdirectory under `<scratch>/pr<N>/` on the review side, never
the bare `pr<N>/` tree those siblings share — since a member waiting on a
child it dispatched writes nothing itself while that child writes below it.
Read them at two observations a poll apart — `touch` a marker file outside
that directory at the first, and
`find <dir> -type f -newer <marker>` at the second lists every file that
moved: **mtimes that moved between the two mean BLOCKED, a live member
still holding its claim and its worktree, so the killed row of SKILL.md's Failure handling table does not
apply to it; mtimes unchanged at both are the dead signature.** Only the first
of those two verdicts is conclusive — a member wedged on a call that writes
nothing freezes its scratch dir too — so settle the dead one on the Member unaccounted row of that table, never on the two listings alone. Measured once: a refuter
wedged forever on `until grep -q` for a marker `node --test` never writes, its
transcript's record counts unchanged across two polls while its own scratch
files carried fresh mtimes throughout — alive the entire time it read as dead.
The filenames are not a contract: they are whatever that member happens to be
writing, and they differ by member and by role. That second listing is cheap
at the price, because the cost of the wrong call is asymmetric — a live member
written off gets killed and re-dispatched, which discards the work in flight
and, where it holds a claim or a worktree, collides the fleet with itself,
while one poll spent on a member that had in fact stopped costs only the poll.
The refuter's own observation rule in the fix-applier body stops a
member from creating that state; this one stops you from misreading whoever
reaches it anyway, and neither replaces the other.
