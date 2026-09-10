---
description: Print the exact command to start the fleet run. Does not start it. Use when `run-team` isn't showing up in your picker.
---

This command only prints instructions — it never starts the fleet itself.

`run-team` is a `disable-model-invocation` skill, invoke-only by design (the
fleet writes to a live repo and must never start unasked). On omp that flag
also hides it from the human `/` picker, not just from the model's own
auto-invoke list (feigi/fleet-plugin#1381) — so there is nothing to browse to
there. Claude Code does not have this problem; `run-team` shows up in its
picker normally.

To start the fleet, type this exactly — don't pick it from a list, type it:

    /fleet-ctl:run-team [implementers] [reviewers]

Both arguments are optional, default 5, capped at 5. Example: `/fleet-ctl:run-team 3 2`.
