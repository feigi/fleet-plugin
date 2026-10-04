---
description: Print the exact command to start the fleet run. Does not start it. Use when `run-team` isn't showing up in your picker.
---

This command only prints instructions — it never starts the fleet itself.

`run-team` is a `disable-model-invocation` skill, invoke-only by design (the
fleet writes to a live repo and must never start unasked). That flag also
hides it from the human `/` picker, not just from the model's own
auto-invoke list — so there is nothing to browse to
there.

To start the fleet, type this exactly — don't pick it from a list, type it:

    /skill:run-team [implementers] [reviewers]

Both arguments are optional, default 2 implementers and 6 reviewers, with no hard cap. Example: `/skill:run-team 3 2`.
