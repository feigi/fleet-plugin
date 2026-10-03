# Lifting the tier-unchecked hold for a closed ticket

`fleet-tick.mjs` keeps `HOLD (tier unchecked impl-<N>)` for the newest
implementer of a ticket with no tier verdict on its row (`tier-ok=`,
`tier-mismatch=` or `tier-unverifiable=`), even when the ticket's issue is
already CLOSED. That is deliberate. The tick does not probe issue state for
unchecked members and does not drop them.

## Why this is out of scope

The closed-ticket lift for `HOLD (tier mismatch …)` exists because its remedy
no longer makes sense once the issue is closed. A mismatch is cleared by
dispatching `impl-<N>-b`, and a closed ticket has nothing left to replace.
If the definition has been retired, re-checking can never pass either.
Without the lift, that hold would last for the rest of the run.

The unchecked hold is a different kind of hold. Its remedy is to run the
check:

```
~/.fleet/bin/fleet-run tier-check.mjs --batch <file>   # [{"member":"impl-<N>-b","session":"<session>"}]
```

That run always writes a verdict for a member whose session is known.
`tier-ok=` and `tier-unverifiable=` clear the hold directly. `tier-mismatch=`
on a closed ticket is then dropped by the mismatch lift. One run is enough;
the hold never gets stuck.

The check also never mattered only to its own ticket. The dispatch-time tier
check (ADR 0005, layer 2) catches a definition, `modelRoles` or harness
resolution that "could load clean and silently run at the wrong tier". That
fault is in how the fleet dispatches, so the next Pull would repeat it.
run-team's phase 2 says so: dispatching the next member on top of an
unchecked dispatch multiplies whatever silently degraded. A ticket closing
does not make that risk go away.

Lifting on CLOSED would also open a gap. An implementer whose PR merges and
whose issue closes before its check runs would never be checked. That makes
the per-member refusal (ADR 0017's amendment: the tick hold is the check's
code carrier) optional again.

## Prior requests

- #2504 — "fleet-tick: a CLOSED ticket's unverified replacement (impl-N-b) still HOLDs as tier unchecked"
