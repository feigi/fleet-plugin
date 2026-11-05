# Gate verdict provenance against a goal-seeking controller or an adversarial member

A proposal to make a Gate verdict unforgeable by the controller, or by a member that is trying to defeat the guard, has been declined.

## Why this is out of scope

The rule is that a Gate verdict is written only by the `ledger.mjs` verb that derives it from its evidence. It holds against a member that is goal-seeking and a controller that errs.

- **A goal-seeking controller:** nothing exists that the controller cannot write to prove a maintainer's answer or to require a review. The maintainer's answers reach the verb as flags the controller types, and every AI session posts to GitHub as the maintainer's account.
- **Adversarial members:** a member can edit `.fleet/ledger.md` directly, forge the check's inputs in scratch, or overwrite the environment its shell inherited. Closing that is process isolation, not a ledger fix.

## What would reopen this

A caller identity a member cannot set, or members run under their own OS user or sandbox. Today a subagent's shell inherits `PI_SESSION_FILE`, `PI_SESSION_ID`, `AGENT` and `OMPCODE`, and can overwrite them.

## Prior requests

- #4211
