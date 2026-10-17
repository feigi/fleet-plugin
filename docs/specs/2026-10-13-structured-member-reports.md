# Structured member reports: a report is a JSON file the settle reads and verifies

Date: 2026-10-13
Status: spec, input to `/to-tickets`. Spec 2 of 6 from the 2026-10-13 determinism review.
Relates to: #2331 (a `labelled` settle with no label on the PR), the lost-report and lost-ruling measurements in `run-team/SKILL.md` § Rules that fail silently, the `Sizing:` covariate rules in § Phase 2, ADR 0012 Decision 1 as amended by #2886 (the review result lands as one file).
Depends on: nothing. Spec 1 (rendered briefs) is where the report path is stated to the member; until it lands the brief template line is prose.
Base tree: `main` at `bd4afac` (2026-10-13).

## Problem Statement

Every member reports in free text, and the controller extracts from it by
reading: the PR number and head SHA, when `sizing-a-ticket` ran relative to
`gh pr create`, each `filed: #N <subject>` and `unrecorded: #N <subject>`
line, the apply/defer split, the halt cause and its evidence, the post-add
label read-back. omp's `task` item schema carries `outputSchema` and
`schemaMode`; the runbook names them once and no dispatch uses them.

Three consequences are measured. `ledger.mjs settle finisher-pr-<M>=labelled`
accepts the word `labelled` and nothing else, so #2331's two finishers
settled as labelled with no label on the PR; the fix was a tick row that
re-reads `gh` later, not a settle that checks. The sizing covariate is left
blank whenever the ordering clause is missing from the prose, which is a
transcription failure, not a measurement failure. And the delivery channel
drops and delays in both directions (one finisher's report accepted with a
msg id and never delivered; two controller rulings lost with `success:
true`), so the runbook carries a page of ritual — ask by name, state your
confirmation state, re-send only when asked — to tell a lost report from a
member that never sent one.

The one role that does not have these problems is the review runner. It
writes `review.json` and reports a path and a token.

## Solution

Every member writes its report as a JSON file at a path its brief names,
validated against its family's schema, and its message is a pointer to that
file. The `task` call carries the same schema as `outputSchema`. `ledger.mjs
settle --from-report` reads the file, derives the outcome token, and for any
outcome that asserts a GitHub or git state verifies that state before
writing. The tick notices a report on disk for a token still live, so a
report that never arrived as a message is still consumed.

## User Stories

- As the controller, I want `ledger.mjs settle finisher-pr-2285 --from-report`
  to refuse when the PR does not carry `ready-to-merge`, so that a finisher
  cannot settle as labelled on its own word.
- As the controller, I want the tick to print `SETTLE impl-412 (report on
  disk, token live)`, so that a report whose message was lost is not a
  member I have to ping by name.
- As a member, I want the report schema in my brief and in my `task` call,
  so that a report I cannot write in that shape is a refusal I see before I
  exit.
- As the close-out, I want `tier-outcomes.mjs append` to read `sizing` from
  the implementer's report file, so that the covariate is recorded when it
  was measured and never retyped.
- As a maintainer, I want every `filed:` entry to reach the ledger from the
  report file, so that a filing whose `ledger.mjs filed` failed twice is
  recorded by the settle and never by hand.

## Implementation Decisions

**D1. Schemas.** `plugin/scripts/report-schema.mjs` exports one JSON schema
per member family, and `report-schema.mjs print <family>` prints it for a
brief or a `task` call. Required fields:

| family | fields |
|---|---|
| `impl` | `outcome: "pr" \| "bailed"`, `pr`, `head`, `branch`, `sizing: {verdict: "light"\|"heavy", signal, ranBeforePr: bool}`, `bailCause: "undecided"\|"fork"\|"hands"\|"fixed"\|"covered"\|null`, `bailDetail`, `confirmation: [string]` (warnings received and acted on, rulings not received) |
| `fix-pr` | `outcome: "applied" \| "no-op" \| "failed"`, `head`, `branch`, `applied: [{bucket, index}]`, `deferred: [{bucket, index, issue}]`, `filed: [{issue, subject}]`, `unrecorded: [{issue, subject}]`, `dispositionsRecord` (path), `testRun: {cmd, exit, tests, cancelled}`, `confirmation` |
| `finisher` | `outcome: "labelled" \| "halted" \| "failed"`, `cause` (the ledger's `halted:<cause>` vocabulary or null), `evidence`, `pin`, `labelsReadBack: [string]`, `kill: {red, baseline}` or null, `filed`, `unrecorded`, `confirmation` |
| `merge-bot` | `merged: [{pr, sha}]`, `held: [{pr, behind}]`, `conflictHold: [pr]`, `refused: [{pr, reason}]`, `branchKept: [{pr, by}]` |
| `review-pr` | unchanged: `status`, `path`, `ledger`, `attempts`, `errors`, `digest` |

Every schema has `member` (the name dispatched as) and `confirmation`.
`schemaMode` on the `task` call is `strict`: an invalid result is a failed
job, not a nulled field.

**D2. The file.** `<scratch>/reports/<run>/<member>.json`, one per member
name within a run. `<run>` is the controller record's `at`, the epoch
milliseconds `ledger.mjs rotate` writes into the heartbeat state. The
scratch root is per workspace and outlives omp sessions, and a member name
restarts with every run that carries nothing forward (`merge-bot-1` again
after a `dead` or `none` rotate), so the run is part of the key: a previous
run's report is never in this run's directory. The brief states the path
absolute. The member writes the file before its final message, and its
final message is one line: `<member>: <outcome> <path>`. The review runner
keeps its own path and its own line. `reclaim-scratch.mjs --after-rotate`
removes every `reports/<run>/` directory whose `<run>` is not the current
record's `at`, which is also what clears a merge-bot's report, since a
merge-bot names no PR or ticket; within the current run,
`reports/<run>/<member>.json` is removed once its member's PR or ticket is
reclaimed, by the existing rules.

**D3. The settle reads and verifies.** `ledger.mjs settle <member>
--from-report [--reports <dir>]` reads the file, validates it against the
family schema (exit 2 naming the first violation, nothing written), derives
the outcome token, and checks the world before writing:

| token | check before the write |
|---|---|
| `impl-N=PR#M` | `verify-sha.sh <branch> <head>` exit 0; `gh pr view M --json headRefOid,state` reads OPEN; the PR's `closingIssuesReferences` names N |
| `impl-N=bailed` | `bailCause` present; the settle prints the cause so the controller's demotion step takes it from the receipt |
| `fix-pr-M=applied:<head>` | `git ls-remote origin refs/heads/<branch>` equals `head` |
| `fix-pr-M=no-op` | `git ls-remote` equals the review file's `head` (read off the PR's latest `reviewed=`) |
| `finisher-pr-M=labelled` | `gh pr view M --json labels` carries `ready-to-merge`; `labelsReadBack` agrees |
| `finisher-pr-M=halted:<cause>` | `cause` in vocabulary; `evidence` non-empty |
| `merge-bot-n=done` | each `merged[].pr` reads MERGED |

A check that fails is exit 3 naming the mismatch, nothing written: the
member's claim and the world disagree, and the controller rules. A check
that cannot look (`gh` outage) is exit 2 and the settle is retried; it never
falls through to trust. Hand-typed outcomes (`killed`, `released`,
`tier-mismatch`) keep the bare `settle <member> <outcome>` form; they are
the controller's own verdicts.

**D4. Side effects the settle owns.** After a passing check, the settle
runs `ledger.mjs filed <issue> "<subject>"` for every `unrecorded` entry,
and for a fix-applier copies `deferred` entries whose bucket is `refuted` to
`ruled`. The controller's Record-then-tick row shrinks to the settle and the
tick.

**D5. The tick reads the reports directory.** For every live token, if
`<scratch>/reports/<run>/<member>.json` exists for the current run, the tick
prints `SETTLE <member> (report on disk since <age>)` above the rows.
Advisory, like `CHECK-LIVENESS`: it settles nothing. The tick computes
`<scratch>` itself with `scratchRoot()` (`fleet-dir.mjs`), a pure function of
the workspace path, so it needs no flag and no state file; `<run>` it reads
off the controller record it already reads.

**D6. Downstream readers.** `tier-outcomes.mjs append` reads `sizing` from
the implementer's report (the `--sizing` flag stays for a member with no
report file, and the WARNING names which source filled it). `member-
outcomes.mjs` gains a `report` column: `ok`, `invalid`, `absent` — derived,
like every other column, from the file's presence beside the transcript.

**D7. Tests.** Schema fixtures per family with one invalid variant each;
`ledger-settle-report.test.mjs` drives every row of the D3 table against a
throwaway repo with a stubbed `gh` on `PATH`, one case per check proving it
refuses; a tick test for D5.

## Out of Scope

- The review runner's report (already a file and a token).
- The controller's own writes and wake handling (spec 4).
- Changing what a member has to measure; only how it reports it.
- Delivery: the message stays the delivery, the file is the record. No
  polling of the reports directory by the member side.

## Open Questions

- Whether `schemaMode: strict` on omp returns a job `failed` that the
  existing Failure-handling table already covers, or a shape that needs its
  own row. Measure on the first dispatch; the spec assumes `failed`.
