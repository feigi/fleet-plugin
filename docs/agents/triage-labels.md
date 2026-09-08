# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Ready for an AFK agent                   |
| `ready-for-human`          | `ready-for-human`    | Needs a maintainer, not an AFK agent     |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

All five roles resolve — label string equals role name. Verified against
`gh api repos/feigi/fleet-plugin/labels` on 2026-09-08 (re-run after the repo was
renamed from `feigi/claude-config`, where the original 2026-07-30 check was made);
`needs-triage` and `needs-info` were created that day, the other three predate them.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.


## Labels that are not triage roles

`wayfinder:*` carries no triage meaning: do not read it as a state in the transition
graph above. `onhold` is different — it is a **modifier on** a triage role, not a
replacement for one.

| Label                 | Meaning                                                          |
| --------------------- | ---------------------------------------------------------------- |
| `wayfinder:map`       | A `/wayfinder` map issue                                          |
| `wayfinder:research`  | Map child ticket, AFK: a fact outside the working directory       |
| `wayfinder:prototype` | Map child ticket, HITL: settled by building something to react to |
| `wayfinder:grilling`  | Map child ticket, HITL: settled by talking it through             |
| `wayfinder:task`      | Map child ticket: manual work unblocking a decision               |
| `onhold`              | Deferred: specified and agent-ready, but not actionable here yet |

The five `wayfinder:*` labels are mandated by `/wayfinder`'s own `SKILL.md` (`:21`,
`:65`, `:113`) and were created here 2026-09-08. See `docs/agents/issue-tracker.md`
"Wayfinding operations". A wayfinder ticket is a **decision** ticket worked one per
session by `/wayfinder`, never an implementation ticket, so it must never carry
`ready-for-agent` — that label is the fleet's dispatch queue.

`onhold` is **not** a spare label. Measured 2026-09-08: five issues carry it — #49,
#50, #51, #52, #78 — and every one of them carries `ready-for-agent` alongside it.
It marks a ticket that triage has fully specified but that cannot be actioned in
this repo right now, in each of those cases because the fix lives outside it
(`skills/*` is gitignored bar `caveman-compress` and `fleet`, and `~/.agents/skills/`
is not in this repo at all). It is the fleet's "real, decided, but out of reach"
marker, which is why `scripts/candidates.mjs` excludes it: an agent dispatched at
one would find nothing it is allowed to edit.

Read `onhold` on its own as incomplete — pair it with the triage role beside it.

It is **also**, temporarily, the stopgap keeping wayfinder issues out of
`next-ticket`'s fallback scan. That is a co-opt of a label with a real meaning and
those issues carry no `ready-for-agent`, so the pairing rule above does not hold for
them. Issue #1306 replaces it with a proper `wayfinder:*` exclusion and strips
`onhold` from them.