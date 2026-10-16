# Instruments: why they are re-checked

Evidence for the rule SKILL.md states in **Rules that fail silently**, keyed by the rule it justifies.

## Re-check your instruments before every gate decision

**You read your instruments out of a tree every member can write to — re-check
them before every gate decision.** Per-member worktrees and `./agent-test`'s port
derivation protect members from each other; neither protects the main checkout,
which you run every gate probe out of and which any member can edit — except
through a `write`/`edit`/`ast_edit` the `member-write-guard` extension refuses;
a `bash` or `eval` write still lands. Measured: a
member edited two files there instead of in its worktree while the CI monitor was
polling one of them every 120s and a live finisher was using it to decide a
label. It caught itself; nothing in the fleet would have. That is the silent
direction — a modified instrument raises no error, shows in no PR and leaves
nothing in the ledger, and it still returns a verdict, just not necessarily the
right one, so you have no reason to re-check a script you did not know had
changed.
