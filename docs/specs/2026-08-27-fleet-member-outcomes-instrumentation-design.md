# Recording model and effort per fleet member, so tiering can be decided on evidence

Date: 2026-08-27
Status: designed, not implemented. Base `c82c5a5`, branch
`feat-member-outcomes-instrumentation`. No ticket yet — filing is step 1 of the
plan.

Every measurement below was taken at `c82c5a5` on 2026-08-27 and is a snapshot,
not a live count. `tier-outcomes.tsv` is append-only and `member-outcomes.tsv`
is derived-and-rewritable (see "Why two files"), so any figure here is stale the
moment a run appends or the scraper re-runs. Recount before citing:
the commands are in the tsv headers, and the ones used for this document are
inline below so a reader can re-derive rather than trust.

Line references address files as they stood at `c82c5a5`. Resolve one with
`git show "c82c5a5:<path>" | sed -n '<N>p'` — keep the quotes, and brace a ref
held in a variable (`git show "${SHA}:<path>"`), because zsh reads a `:<path>`
suffix as a history modifier inside double quotes as well as outside.

## The problem

The fleet dispatches six kinds of member and records the tier of none of them.

`skills/fleet/skills/run-team/SKILL.md:395` instructs the controller to omit
`model` on every implementer dispatch, so members inherit the session's model
*and* its effort. Verified on a real run (session `97c6b9dd`, 2026-08-25): nine
`impl-*` members, all `claude-opus-5`, all `effort: xhigh`, matching the
controller. `impl-580.meta.json` records `"model": "claude-opus-5[1m]"` — even
the context variant carries through.

Nothing reads that back. `skills/fleet/scripts/implementer-model-tier.test.mjs:20-21` states
the gap plainly: `board.mjs` parses `message.usage` off the subagent JSONL and
drops `message.model` on the same line. The tier a member ran at is written to
disk by the harness and discarded by the fleet.

The consequence is that the one tiering question anyone has asked cannot be
answered. `class=routine` → `sonnet` was reverted 2026-08-16 when the phase-2
guard fired on a criterion chosen in advance — a floor (≥3 `class=routine` PRs
across ≥2 dates) and a trigger (≥2 rows with `closed_own_ticket` `no`). Both were
met. The guard's own text is explicit that this is
"a pre-committed rule being honoured, not a measurement", and the counter-evidence
recorded beside it was n=1 on the control side.

Recounted at `c82c5a5` — 93 rows in `docs/metrics/tier-outcomes.tsv`:

```sh
grep -vc '^#' docs/metrics/tier-outcomes.tsv
awk -F'\t' '!/^#/ && $4=="routine" {t[$5]++; if($6=="no") f[$5]++} \
  END{for(k in t) print k, t[k], f[k]+0}' docs/metrics/tier-outcomes.tsv
```

| routine tier | rows | `closed_own_ticket=no` |
|---|---|---|
| sonnet | 11 | 3 |
| opus | 48 | 3 |

All three sonnet failures fall in `2026-08-13..08-17`; from `08-20` onward sonnet
is 3 rows and 0 failures. That is the confound #864 documents — tier entangled
with calendar date and therefore with prompt evolution — and it is why the raw
split cannot be read as a tier result in either direction.

## What this spec builds

Instrumentation, not policy. Two files, joined on `pr`:

- `docs/metrics/tier-outcomes.tsv` — **unchanged**. Human-ruled verdicts, one row
  per implementer PR, appended by the controller at ruling time. Never
  regenerated; a wrong row is corrected by appending, never by rewriting (#867).
- `docs/metrics/member-outcomes.tsv` — **new**. Machine-derived facts, one row
  per dispatched member per run, produced by a scraper that is a pure function of
  transcripts already on disk. Regenerated whenever the scraper improves.

### Why two files and not one

The split is not tidiness. It is that the two have **opposite maintenance rules**
and one file can only carry one.

| | facts file | verdicts file |
|---|---|---|
| when the tool improves | regenerate every row | never touch |
| a wrong row | fix by re-running | fix by appending a correction |
| can be deleted | yes | no |

The facts file must be regenerable because its classifier has already been wrong
once: `skills/fleet/scripts/compute-spend.mjs:30-36` records that classifying on `spawnDepth`
alone swept phase-0 sizing agents into `specialist` and moved the review-spend
headline from 83% to 87% — "the one number anyone acts on". When a classifier bug
like that is fixed, every past row is wrong and regeneration is the correct
response.

A verdict cannot be regenerated. `closed_own_ticket=no` on PR #452 exists because
a controller read a review and ruled; nothing on disk recomputes it. Merge the
two and regeneration would destroy 93 hand-ruled verdicts — so regeneration would
stop, and rows would be hand-patched instead. Hand-patching a historical metrics
file is the failure this repo keeps hitting: #864 (figures stale by ~1.6x), #867
(record a correction in the new row, do not rewrite the historical one), and the
review finding that demanded a past-tense record be rewritten as a live count.

Grain is the second reason. 93 ruled PRs against 2,671 members on disk — a run
dispatches ~17 members and produces ~3 ruled PRs. Merged, 2,400+ rows carry
structurally empty verdict columns, because nothing rules a merge-bot and nothing
ever will. Baking 90% blanks into a schema invites reading blank as a value,
which is the specific error the backfill section below forbids.

The join is one `awk` on `pr`.

## Schema

`docs/metrics/member-outcomes.tsv`, tab-separated, `#` header comments. **Derived
and rewritable, not append-only** — a scraper run over a session it has already
seen replaces those rows in place. That is the property the two-file split exists
to protect, and it is why no verdict may ever be stored here: a regeneration
would destroy it.

```
session  run_date  role  member  model  effort  ticket  pr
tokens_cache_create  tokens_out  wall_s  turns  errored
```

**Every column is derivable from transcripts alone.** That is a hard constraint,
not a preference: a column the controller must hand-fill cannot survive a
regeneration, so admitting one would reintroduce the exact coupling the two-file
split exists to prevent. `ticket` and `pr` are parsed from the member name
(`impl-<n>`, `fix-pr-<n>`), not supplied.

Two columns an earlier draft carried are deliberately absent:

- **The difficulty covariates moved.** `sizing`, `profile`, `loc`, and `files`
  are per-PR facts, not per-member ones — the grain of `tier-outcomes.tsv`,
  which the controller already writes by hand at ruling time. They are added
  there as four new columns, where they cost no new ceremony and no
  regenerability.
- **`control` is not stored, because it is discoverable.** A paired comparison is
  any run whose members of one role ran more than one model:
  `group by session, role having count(distinct model) > 1`. Labeling a
  dispatch as a control would be a hand-entered column recording something the
  data already shows — and a label derived against *today's* declared tiers would
  be wrong for every historical row. Nothing needs to be marked; the pairing is
  a query.

- `session` + `member` are the idempotency key. A row is replaced, never
  duplicated, when the scraper re-runs over a session it has already seen.
- `role` comes from `classifyRole` in `compute-spend.mjs`, imported rather than
  re-derived, so the two files cannot fork on what a "reviewer" is.
- `model` is normalized. Raw values on disk today include `claude-opus-5`,
  `claude-haiku-4-5-20251001`, `claude-sonnet-5`, `claude-opus-4-8`,
  `claude-opus-4-7`, bare `opus`/`sonnet`/`haiku`, and `<synthetic>`.
  `<synthetic>` rows are dropped, not mapped — they are not a model.
- `effort` is read from the per-message `"effort"` field in the member's JSONL.
  It is **not** in `meta.json`: across 400 sampled `*.meta.json` the key set is
  `agentType`, `description`, `spawnDepth`, `toolUseId`, `model`,
  `parentAgentId`, `name`, `taskKind`, `teamName`, `color`, `planModeRequired`,
  `permissionMode`, `customAgentType` — and no effort. A future harness change
  that adds it there would be welcome but must not be assumed.
- **Every tier claim is read from the member's JSONL — never from `meta.json`,
  never from what the member replied.** `meta.json` omits `model` entirely when
  the tier came from frontmatter (measured 2026-08-27 on `effort-probe`) and
  never carries `effort` at all, so both halves of a frontmatter-declared tier
  are invisible there. A member answering "probe" proves a dispatch completed and
  nothing more. This binds the scraper, the pins, and every read-out below.
- `errored` is whether the member's transcript ends without a completed final
  turn — a stall or a terminal API failure, not a code defect.
- No verdict columns. Ever. That is the whole point of the split.

### Superseded generations are a separate population

The back catalogue holds `claude-opus-4-8` (23 members) and `claude-opus-4-7`
(16). **These must never be pooled with `claude-opus-5` under an "opus" label,
and never read as a cheaper tier.** Pricing falls with each generation: an older
Opus is not cheaper than the current one, and an older Sonnet is *more* expensive
than the current one. Pooling them would invert the cost ordering the whole
exercise exists to measure.

The rule this implies for every dispatch site in Part 2: **declare the bare alias
(`opus`, `sonnet`, `haiku`), never a pinned versioned id.** An alias tracks the
newest generation; a pinned id silently rots into the slower, dearer option the
day a new one ships. That the scraper records the resolved versioned id is
correct and unaffected — recording what ran is exactly its job.

Model tiering in this repo therefore means *current* Opus against *current*
Sonnet against *current* Haiku. Never current against superseded.

### The four new columns on `tier-outcomes.tsv`

`sizing` (phase 0's light/heavy) and `profile`/`loc`/`files` (from
`diff-stats.mjs` via the review snapshot) are the difficulty covariates. Both are
computed today and discarded at row-write time. They are per-PR facts, so they
append to the existing per-PR verdict row rather than joining a per-member one.

Appending columns to an append-only file leaves every existing row short. Rows
predating the change carry blanks, permanently, and blank means **unknown** — the
header must say so and the read-out rules below must enforce it. That is the same
rule the backfilled member rows live under, for the same reason.

## The scraper

`skills/fleet/scripts/member-outcomes.mjs`. One interface: given a session
directory, emit rows.

```sh
# one session — end of phase 3
node skills/fleet/scripts/member-outcomes.mjs "$SESSION_DIR"

# every session on disk — a loop, not a feature
ls -d ~/.claude/projects/*/*/ | xargs -n1 node skills/fleet/scripts/member-outcomes.mjs
```

There is deliberately **no `--backfill` mode**. Backfill is the same call in a
shell loop, so there is no one-shot code path to delete once the back catalogue
is ingested. The idempotency that backfill needs is the same idempotency a
re-run of phase 3 needs, so it is load-bearing permanently rather than a
backfill artifact.

Pure function of files already written: no clock read, no network, no `gh`.
Tested against fixture session directories, in the style of
`compute-spend.test.mjs`.

### What backfill can and cannot buy

Measured across all sessions on disk at `c82c5a5`: **154 sessions that dispatched
at least one member, 2,671 member transcripts, 2,102 with both `model` and
`effort` recoverable.**

The denominator matters and cost a recount to pin down. `ls -d
~/.claude/projects/*/*/` counts every session directory — 253 of them the next
day — because most sessions dispatch nobody. The figure above counts
`ls -d ~/.claude/projects/*/*/subagents/`, which is the population the scraper
actually walks. Re-verified 2026-08-27 after the probe work: 155 / 2,687 / 2,109,
i.e. one further session and the drift of a single day.

| role | members | | model | members |
|---|---|---|---|---|
| specialist | 1416 | | claude-opus-5 | 1802 |
| reviewer | 376 | | claude-haiku-4-5 | 567 |
| finisher | 289 | | claude-sonnet-5 | 262 |
| implementer | 255 | | claude-opus-4-8 | 23 |
| merge-bot | 255 | | claude-opus-4-7 | 16 |
| other | 80 | | `<synthetic>` (dropped) | 14† |

† Unlike every other row, this one is method-sensitive: counting each member by
the FIRST `"model"` in its transcript yields 2 rather than 14, so `<synthetic>`
evidently also appears on later messages of members that opened under a real
model. Immaterial to the design — the rows are dropped either way — but a
scraper that counts one way and a reader who counts the other will disagree, so
the scraper's rule is: **one model per member, the first one on the transcript.**

Model varies usefully. **Effort does not**: `xhigh` 2039 rows against `high` 67.
So the back catalogue can support a model comparison on day one and **cannot
answer the effort question at all**. Effort only becomes measurable once controls
vary it prospectively. Any read-out that claims otherwise is reading 67 rows
against 2039.

The difficulty covariates are likewise absent for every PR ruled before this
change lands, since they were never recorded. Those PRs can be ranked but cannot
enter a stratified comparison. Blank means **unknown** and must be excluded, never
bucketed as a value — the tsv header says so, and the read-out rules below
enforce it.

## Declaring tiers, and the control rule

### Declare first, change nothing

Give each role an agent definition carrying its *current* effective tier.
Behaviourally a no-op; the point is to make the tier an explicit, readable input
before it becomes a variable. A config change and a measurement change landing in
the same commit is unreadable.

Agent-definition frontmatter carries `model` and `effort` independently — the
official `claude-security` plugin ships exactly the pairing this repo wants, at
`plugins/marketplaces/claude-plugins-official/plugins/claude-security/agents/explore.md`:

```yaml
model: sonnet
effort: xhigh
```

Frontmatter is the only lever that decouples them. The `Agent` tool takes `model`
but has no `effort` parameter, so an Agent-dispatched member always inherits the
session's effort. Workflow `agent()` takes both — `review-pr.js` already uses it
(`verifierEffort: "low"`). And `SKILL.md:398` already documents frontmatter as
the intended precedence: an omitted `model` takes the agent definition's tier
first and the session's only after.

Two hazards, both real:

1. **Omit `tools:` (or set `*`).** A `tools:` list that drops `Agent` costs the
   member its delegation, silently and with no error
   (`references/member-lifecycle.md:7`).
2. **The existing pins will not notice.** `implementer-model-tier.test.mjs` reads
   `SKILL.md` only. A tier changed via frontmatter leaves those pins green while
   the dispatched tier flips — the exact silent-drift class the pins exist to
   prevent, routed around. Extending them to the agent definitions is part of
   this work, not a follow-up.

### Vary one role at a time

**Implementers only, and for now that means implementers alone even get a
declaration.** Maintainer's call, 2026-08-27: the other roles are not declared in
Part 2 at all. An observed effect then has one candidate cause, and three agent
definitions that no experiment is using are three files to keep true for nothing.

**Rows are still recorded for every role**, because the scraper costs nothing per
role. This matters more than it sounds: reviews are the dominant cost —
review-side work has measured at 84% of a run's cache-write tokens, and
specialists are 1416 of the 2,671 members on disk — so the review side is the
larger prize and an acknowledged future target. Deferring it does not mean
flying blind when it comes up: by then there will be months of reviewer,
specialist and finisher rows already accumulated, at no cost and with no decision
made in advance. Recording is cheap and reversible; declaring and varying is
neither.

### The control is within-run

Every wave dispatches 2-5 implementers. **One of them goes at the alternate
tier.**

This is the load-bearing rule. #864's finding is that tier is entangled with
calendar date and therefore with prompt evolution: 8 of 9 sonnet rows in one
week, 23 of 24 opus rows in the next. Within-run pairing makes tier orthogonal to
date by construction, permanently. PR #714 was this done once by hand —
maintainer-authorized, run against current prompts — and it remains the single
most informative row in `tier-outcomes.tsv`.

**Nothing is labeled.** A control is not a flag on a row; it is a run in which one
role ran more than one model, which the data shows on its own:

```sh
awk -F'\t' '!/^#/ {k=$1 FS $3; if (!(k FS $5 in seen)) {seen[k FS $5]; n[k]++}} \
  END{for (k in n) if (n[k] > 1) print k}' docs/metrics/member-outcomes.tsv
```

That is deliberate. A hand-set `control` column would be un-regenerable, and one
derived against today's declared tiers would mislabel every historical row.

The cost is honest and recurring: one member per run executes at a tier the
maintainer may not prefer. That is the price of ever knowing. Accepted
2026-08-27.

**One per wave is a starting rate, not a permanent tax.** The intent is to pair
less often once enough pairs exist — the sampling rate is a dial, and a
comparison does not need one pair per run forever to stay unconfounded. **Do not
build the taper now.** The natural moment to revisit is the read-out gate below
(≥10 within-run pairs across ≥5 run dates): at that point there is data to say
what rate is sufficient, and choosing one before then would be the same mistake
as the last guard — a threshold picked in advance of any evidence. Until then the
rate stays at one per wave.

## Read-out

**No new guard.** The existing tier guard is in its fired state with no further
move, and writing an automatic revert against data that does not exist yet is how
the last one ended up firing with n=1 on the control side. This spec collects;
policy is a later, informed, maintainer call.

The comparison is **pre-registered here** so the read-out is not chosen to fit
whatever the rows happen to say:

- Compare **within stratum**: same `sizing` × same `profile`, both read from
  `tier-outcomes.tsv` after joining on `pr`.
- Compare **within run** where a pair exists — a `session`+`role` carrying more
  than one distinct `model`. Across runs only as a fallback, and flagged as such
  in whatever cites it.
- **Minimum n before reading anything**: ≥10 within-run pairs spanning ≥5
  distinct `run_date`s. Below that, report the count and stop.
- **Blank covariate excludes the row** from a stratified comparison. Rows whose
  PR predates the four new columns can rank models overall; they cannot enter a
  stratified pair.
- The effort question is **not** open for reading until controls have varied
  effort. 67 rows against 2039 is not a comparison.

Read-out is `awk`, documented in the tsv header the way #864's recount commands
are. No report script until the data proves one is needed.

## Testing

- `member-outcomes.test.mjs` — fixture session dirs covering: each role;
  a member whose JSONL is absent; an unreadable transcript skipped without
  losing its siblings; `<synthetic>` dropped; bare `opus` normalized; a member
  with no `effort` field; a member name that yields no `ticket`/`pr`; idempotent
  re-run over an already-scraped session, including that it does not disturb
  rows from other sessions.
- Extend `implementer-model-tier.test.mjs` to the agent definitions, so a tier
  changed in frontmatter fails a pin. Mutation-test both directions — a positive
  regex over a whole section is a vacuous pin, and slice size is what anchors.
- A header pin for `member-outcomes.tsv` against its documented columns. #472 is
  open because `tier-outcomes.tsv` has no such pin; do not repeat it.

## Unknowns, deliberately not closed here

- **Whether frontmatter `effort:` is honoured. SETTLED YES, 2026-08-27, by
  measurement.** Two probes from session `d054b300` (`claude-opus-5`, effort
  `high`), both dispatched unnamed so an unregistered type would have errored
  rather than silently run a teammate:

  | probe | frontmatter | transcript |
  |---|---|---|
  | `effort-probe` | `model: sonnet`, `effort: xhigh` | `claude-sonnet-5`, `xhigh` |
  | `effort-probe-low` | `model: sonnet`, `effort: low` | `claude-sonnet-5`, `low` |

  The first settles `model:` and **only** `model:`. Its `xhigh` has two possible
  causes: the frontmatter, or a re-resolution from `settings.json`, whose
  top-level `effortLevel` is `xhigh` — the session reads `high` only via
  `modelSettings.claude-opus-5.effortLevel`, and sonnet has no per-model entry.
  Differing from the parent session's effort is therefore **not** a sufficient
  control, which is the trap Plan 2 Task 1 originally gated on.

  The second closes it. `low` is reachable from no settings path here — not the
  session's `high`, not the top-level `xhigh`, and there is no `claude-sonnet-5`
  entry to supply it. It can only have come from the frontmatter. **Both halves
  of a declared tier are honoured, and the "cheaper model, higher effort" trade
  Part 2 depends on is real.**

  Both probe definitions were deleted once this was recorded; the transcripts
  under `~/.claude/projects/-Users-chris--claude/d054b300-*/subagents/` are the
  evidence, and re-deriving it costs two throwaway definitions and two dispatches.

- **Agent definitions are picked up by a rescan DURING a session, not only at
  session start — but not instantly.** Corrected 2026-08-27, having been asserted
  the other way twice in this document's own history. `effort-probe-low` was
  written mid-session; a dispatch moments later failed with `Agent type
  'effort-probe-low' not found` listing a registry that held `effort-probe`
  (written earlier) but not it. The registry then picked it up unprompted a short
  time later and the same dispatch succeeded. So a definition written and
  dispatched in one breath races the rescan: **on `not found`, wait and retry
  before concluding anything — do not restart the session, and above all do not
  record the miss as a property of the harness.** The earlier attempt that
  concluded "definitions load at session start" was reading this race.

- **A named dispatch with an unknown `subagent_type` FAILS SILENTLY.** Measured
  2026-08-27, and it is the reason the probe above was nearly misread.
  `Agent({ name: "x", subagent_type: "<unregistered>" })` does not error — it
  runs a plain named teammate at the SESSION's tier. The same dispatch *without*
  `name` errors loudly and lists the registry. The tell is in `meta.json`: a
  resolved definition writes `agentType: <definition-name>` and **no** `model`
  key; a silent fallback writes `agentType: <the name you passed>` **with** a
  `model` key. This is a live hazard for Part 2 — see its Global Constraints.
- **Whether `opts.model` beats `agentType` frontmatter in workflow `agent()`.**
  Open since the #211 spec; `review-pr.js:364-370` still carries the UNVERIFIED
  note. It does not block this work — no fleet dimension is sent both — but the
  same read that settles the item above settles this one.
- **Sizing verdict availability.** Phase 0 computes light/heavy, but nothing
  confirms it survives anywhere durable once the wave moves on. Moving `sizing`
  onto the controller-written `tier-outcomes.tsv` row sidesteps the storage
  question — the controller has the value in hand at ruling time — but not the
  discipline one: it is one more field to fill correctly, every run, and a
  guessed value is worse than a blank. The header must say so.
- **Canonical finisher name.** `skills/fleet/scripts/compute-spend.mjs:14-20` records that both
  `finish-<n>` and `finisher-pr-<n>` are live and `SKILL.md`'s naming list
  mentions neither (#326). The scraper inherits that ambiguity by importing
  `classifyRole`; it does not fix it.
