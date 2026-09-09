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
session by `/wayfinder`, never an implementation ticket — but the thing keeping it
out of a fleet wave is not its triage role. `scripts/candidates.mjs`'s `EXCLUDE`
negates all five `wayfinder:*` labels as their own clauses, unconditionally, so a
wayfinder ticket never enters a candidate scan whatever role it carries. A
`ready-for-agent` wayfinder ticket is therefore documentation of readiness, not a
dispatch trigger; do not strip the role off one to make it safe, because it already
is. Selection for these runs through the map's frontier query instead — see
`docs/agents/issue-tracker.md` "Wayfinding operations".

That exclusion is `candidates.mjs`'s alone. The cockpit's pool query
(`scripts/board.mjs`, `gh issue list --label ready-for-agent`) carries no
`wayfinder:*` exclusion, so such a ticket still shows as a pool card while never
being dispatchable. Measured 2026-09-09, both directions:

```
node scripts/candidates.mjs --require-label ready-for-agent      # no wayfinder issue
gh issue list --label ready-for-agent --state open --json number,labels \
  --jq '.[] | select([.labels[].name] | any(startswith("wayfinder:")))'
```

`onhold` is **not** a spare label. It marks a ticket that triage has fully specified
but that cannot be actioned in this repo right now — usually because the fix lives
outside it (`skills/*` is gitignored bar `caveman-compress` and `fleet`, and
`~/.agents/skills/` is not in this repo at all), sometimes because its acceptance
criteria are an open blocker's output. It is the fleet's "real, decided, but out of
reach" marker, which is why `scripts/candidates.mjs` excludes it too: an agent
dispatched at one would find nothing it is allowed to edit.

Two properties hold across the whole `onhold` population. Re-run the query rather
than trusting a roster written here — the population moves:

```
gh issue list --search label:onhold --state all --json number,labels
```

- Every issue it returns also carries `ready-for-agent`. So read `onhold` on its own
  as incomplete — pair it with the triage role beside it.
- No `wayfinder:*` issue is among them. `onhold` used to double as the stopgap
  keeping wayfinder issues out of `next-ticket`'s fallback scan; issue #1306 (closed
  2026-09-08) replaced that co-opt with the direct `wayfinder:*` exclusion now in
  `EXCLUDE`, and stripped `onhold` from those issues.

Both held on 2026-09-09.
