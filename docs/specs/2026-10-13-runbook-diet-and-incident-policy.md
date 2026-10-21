# Runbook diet and incident policy: SKILL.md becomes a wake-to-command table under a CI budget, and an incident closes with code

Date: 2026-10-13
Status: spec, input to `/to-tickets`. Spec 6 of 6 from the 2026-10-13 determinism review; lands last.
Relates to: #2929 (26.6 KB of member text in always-on context; its measurement method), #1416 (war-story ceiling, closed), `.out-of-scope/fleet-prompt-doc-duplication.md` (why duplication was kept: a skimmed file read), ADR 0019 (shipped surface cites nothing).
Depends on: specs 1, 3, 4 and 5 merged. Each deletes the sections this spec rewrites; starting earlier reds the budget on day one.
Base tree: `main` at `bd4afac` (2026-10-13).

## Series

The 2026-10-13 determinism review found that fleet-ctl computes every
transition in scripts and executes them from a 302 KB runbook (about 109k
tokens at the 2.76 B/token #2929 measured; #2929's own 93.2k was for the
257 KB file the runbook was then) read by a model, and that the
"forgets to do things" class of incident lives in that gap. Six specs
close it:

1. #3177 `2026-10-13-rendered-member-briefs.md`: a script renders every brief;
   duties live in agent bodies.
2. #3179 `2026-10-13-structured-member-reports.md`: a report is a JSON file the
   settle reads and verifies.
3. #3178 `2026-10-13-run-boundaries-as-drivers.md`: phase 0 and close-out are
   one command each, with a receipt the tick gates on.
4. #3180 `2026-10-13-one-command-per-wake.md`: `fleet-event.mjs`, `tick --apply`,
   and a ledger-to-transcript reconcile.
5. #3181 `2026-10-13-pull-as-driver.md`: `pull.mjs` with oracle questions.
6. #3182, this one. The external-wake probe is #3183.

Ticketed 2026-10-13, blocker-first, each ticket carrying a `## Blocked by`
list:

| spec | tickets |
|---|---|
| #3177 briefs | #3185 renderer · #3194 bodies · #3195 dispatch brief gate · #3186 finisher-label · #3187 finisher-audit · #3202 SKILL.md blocks out, golden retarget, #2884 |
| #3178 boundaries | #3189 phase0.mjs · #3196 tick gate + session reader · #3190 closeout.mjs · #3203 SKILL.md phase 0 / end of run |
| #3179 reports | #3191 report-schema · #3197 settle --from-report · #3198 tick SETTLE · #3199 readers + reclaim |
| #3180 wake | #3192 ledger token · #3200 tick --apply · #3201 transcript reconcile · #3204 fleet-event report kinds · #3206 fleet-event other kinds + table |
| #3181 pull | #3205 pull.mjs + Q1/Q2 · #3207 collision scan + Q3 · #3208 tick PULL pending + Phase 1/2 |
| #3182 diet | #3193 incident policy (no blockers) · #3209 war stories out · #3210 shape rewrite · #3211 budget test |

Unblocked at filing: #3185, #3186, #3187, #3189, #3190, #3191, #3192, #3193.

Order: 1 and 3 first, in parallel; 2 beside them; 4 after 2 and 3; 5 after
1; 6 after all. Specs 1, 3, 4, 5 and 6 edit SKILL.md heavily. Specs 1 and
3 ran in parallel on it: #3194 and #3196 had SKILL.md PRs open together,
and neither was held `behind-pr`. A seventh item, an external wake for
an idle controller on omp, is a research ticket, not a spec, until it is
measured.

## Problem Statement

`run-team/SKILL.md` is 302 KB and always on. It carries 30 inline
`Measured` war stories (68 counting any case of the word) although its
own third paragraph says the war story behind a rule lives in
`references/`; 342 `must`/`never` words; and, until
spec 1 lands, 453 lines of member-facing prompt text the controller never
reads for itself. It grew 173 → 222 → 257 → 302 KB over six weeks, one
paragraph per incident. The repair pattern is the growth: each forgotten
duty earns a sentence placed "where it is read last", the next incident
earns the next sentence, and 94 of the 218 test files pin that a sentence
exists, not that anything follows it.

Context is the least durable thing in the run; the runbook says so, and
puts run state in the ledger for that reason. Procedure is still in
context, and a compaction parks every in-flight member while it summarises
the procedure away.

## Solution

After specs 1 to 5, the controller's runbook is a dispatch table: wake →
command, with the judgement rules the commands stop for. SKILL.md gets a
token budget enforced in CI, war stories go to `references/`, and a written
policy says how a member-reliability incident is closed from now on: with
a script refusal, a schema field, a tick row or a brief template line, and
with prose only where the action is a judgement.

## User Stories

- As the controller, I want SKILL.md to fit in a fifth of the context it
  takes today, so that the table I act from survives a compaction.
- As a maintainer, I want CI to red a SKILL.md over budget, so that the
  next incident cannot be closed with a paragraph by default.
- As a maintainer, I want the war story for a rule one `references/` read
  away, so that the evidence is kept and the controller does not pay for it
  every turn.
- As a reviewer of an incident ticket, I want the ticket template to ask
  which mechanism closes it, so that "add a rule to SKILL.md" is a choice
  the filer has to defend.

## Implementation Decisions

**D1. The budget.** `tests/skill-budget.test.mjs` holds
`plugin/skills/run-team/SKILL.md` to a byte ceiling. The target is 75,000
bytes (≈28k tokens at the 2.69 B/token the test header records), because
D2's retained sections plus the wake-time judgement they absorb from the
dropped sections come to about that size; the file measured 186,100 bytes
when the test landed, so the ceiling started at that size rounded up to the
next 1,000 (187,000). The ceiling only ever comes down toward the target,
and it is held tight: the file must be at most the ceiling and less than
1,000 bytes under it, so a change that shrinks the file lowers the constant
in the same change. The ratio was re-measured with `omp -p --mode json`
once D2's rewrite compressed the file to the target: 2.69 B/token again
(74,811 bytes, 27,812 tokens), and the test's header records it.
The test also asserts the file contains no line matching `^\s*>` and no
occurrence of
`Measured` outside a `See references/` pointer. `references/*.md` have no
budget. `review-and-fix.md` and `run-merge-bot.md` get their own ceilings
at their post-spec-1 sizes plus ten percent, so they stop growing too.

**D2. The shape.** SKILL.md after the rewrite, in this order:
frontmatter; the invariants (ten lines); phase 0 as `phase0.mjs` and its
`NEED` lines; the wake table (`fleet-event.mjs <kind>`); the tick's row
vocabulary and what each row asks of the controller (one line per row);
the Pull's three questions and the tables that guide them; the finisher
gate (the outbox test, the ruling-owed test), stated once; the judgement
rules the drivers stop for; the Failure-handling table; Red flags. Each
section's first paragraph is its exit condition. Shell traps move whole to
`references/shell-traps.md`, cited from the merge-bot brief template (spec
1), which is the seat that pastes them.

**D3. War stories out.** Every `Measured` paragraph moves to the
`references/` file for its topic, keyed by the rule it justifies, in the
style `references/member-lifecycle.md` already uses; the rule keeps one
clause and `See references/<file>`. The `.out-of-scope/
fleet-prompt-doc-duplication.md` argument (duplication defends against a
skimmed file read) is honoured by spec 1's mechanism, not by copies: the
member's text is in its body and its brief, both rendered, so nothing is
left for a skimmed read to miss, and the record's reason for keeping the
duplication is addressed.

**D4. The incident policy.** `docs/agents/incident-policy.md`, one page: a
member-reliability incident (a duty skipped, a report lost, a step run out
of order, a brief missing a line) is closed by, in order of preference, a
script that refuses, a schema field the settle checks, a tick row, a brief
template line; prose closes it only when the action is a judgement no
script can take, and then the prose states the judgement and nothing else.
The ticket template gains a `Mechanism:` line the filer fills. `AGENTS.md`
points at the policy under a new heading beside **Shipped surface**.

**D5. Prose pins.** The suites that pinned moved text are retargeted by the
specs that moved it; this spec deletes the pins over the deleted war-story
paragraphs and replaces them with one pin each on the `See references/`
pointer and on the sentence in the reference file, so the evidence cannot
be dropped silently either.

**D6. Measurement.** Before and after: SKILL.md tokens by the #2929 method,
on the same model; controller `cache_creation` per merged PR over the next
20 merged PRs against `docs/research/baseline-efficiency.md`'s 133,720;
and the count of `ready-for-human` tickets filed per run whose title names
a skipped duty, which is the number this whole series exists to move.

## Out of Scope

- Any behavioural change. Everything here is relocation, deletion, a
  budget and a policy.
- The command docs' content (`review-and-fix.md`, `run-merge-bot.md`)
  beyond their ceilings.
- Removing references/ war stories. Evidence is kept; it moves.

## Open Questions

- Whether the budget should be in tokens measured in CI by an omp call
  rather than bytes. Lean: bytes with a recorded ratio; CI has no omp.
