# One command per wake: `fleet-event.mjs`, a tick that executes what is idempotent, and a ledger-to-transcript reconcile

Date: 2026-10-13
Status: spec, input to `/to-tickets`. Spec 4 of 6 from the 2026-10-13 determinism review.
Relates to: `run-team/SKILL.md` § Phase 3 "Record, then tick" table; #3047 (duplicate review runners after a controller restart); ADR 0028 (the tick reads no registry or transcript — amended by D4 below); `ledger.mjs row` "replaces the whole line".
Depends on: spec 2 (report files the event command consumes), spec 3 (the session directory and scratch root in the phase-0 receipt).
Base tree: `main` at `bd4afac` (2026-10-13).

## Problem Statement

Every wake is "record, then tick, then act, then beat", and the record half
is one to four separate commands per wake kind: an implementer report is
`verify-sha.sh`, then `ledger.mjs settle`, then the tick; a fix-applier
report is `settle`, `dispositions-check.mjs`, copying refutations to
`ruled`, `ledger.mjs filed` per `unrecorded:` line, then the tick; a
merge-bot report is a `row` per `held-behind`, `settle`, `reap.sh --apply`,
`reclaim-scratch.mjs --apply`, then the tick. A CI event is a `row` rewrite
that must repeat every token already on the line or lose it.

When one of those is forgotten the tick is blind to it. A review launched
but not recorded is a review the tick names again (#3047: duplicate
runners). A reap forgotten after a pass leaves a merged worktree that reads
as a live claim, and the queue shrinks. A tier check not run holds the next
Pull until someone remembers the batch file. The tick already executes one
duty itself, the shortlist refresh, and that duty is never reported
forgotten.

## Solution

Each wake kind is one command, `fleet-event.mjs <kind> …`, which performs
every write the Record-then-tick row lists and ends in the tick. Row tokens
gain an append-only writer so no caller repeats a line to keep it. The tick
gains `--apply`, under which it runs the idempotent follow-ups (reap,
reclaim, tier check, refresh) and prints what it did, and it reconciles
live ledger tokens against the member transcripts omp writes, so a member
dispatched but never recorded, or recorded but never dispatched, prints as
a named line instead of a second dispatch.

## User Stories

- As the controller, I want an implementer report to be
  `fleet-event.mjs impl-report impl-412`, so that the verify, the settle and
  the tick cannot drift apart.
- As the controller, I want `fleet-tick.mjs --apply` to reap and reclaim
  after a merge pass, so that a pass that merged nothing still reaps.
- As the controller, I want `ledger.mjs token #412 ci=<run>:<attempt>:<c>`
  to add a token and keep the rest, so that recording CI never costs me the
  `ports=` or `→ PR#` already on the line.
- As the controller, I want the tick to print `UNRECORDED review-pr-2285
  (transcript exists, no ledger token)`, so that a dispatch I made and did
  not write down is a line, not a duplicate runner.
- As a maintainer, I want the tick to print `NO-TRANSCRIPT impl-412 (live
  12m, no <session>/impl-412.jsonl)`, so that a ledger token with no member
  behind it is found before its p99.

## Implementation Decisions

**D1. `fleet-event.mjs <kind>`.** One kind per row of the Record-then-tick
table; every kind ends by running `fleet-tick.mjs` with the receipt's caps
and `--apply` (D3) and printing its rows. Every kind is idempotent: a
second run finds its writes already made and re-ticks.

| kind | arguments | does |
|---|---|---|
| `impl-report` | `<member>` | `ledger.mjs settle <member> --from-report` (spec 2, which verifies the SHA); on `bailed`, prints the demotion step with the cause filled in from the report and performs the relabel, the comment and `release-ticket.sh --apply` |
| `review-result` | `<pr> <path>` | reads the digest, `ledger.mjs review <pr> reviewed=<head>:<s>/<r>/<u>:<run>` |
| `review-failed` | `<pr> <launch>` | `review <pr> review=<launch>=failed`, names the next free fallback runner |
| `fix-report` | `<member>` | `settle --from-report`; for a review fix-applier `dispositions-check.mjs --member`; `ruled` entries; the `filed` entries the settle did not already record |
| `finisher-report` | `<member>` | `settle --from-report`; on `halted:<cause>` posts the halt report with `gh pr comment`; on a repair finisher whose read-back lacks the label, the one-shot escalation comment |
| `ci` | `<pr>` | `ci-state.mjs --pr` (never `--quiet`), `ledger.mjs token <row> ci=<run>:<attempt>:<conclusion>` |
| `merge-bot-report` | `<member>` | `token` per `held-behind:#<lower>`, `settle --from-report`; the reap and reclaim run under D3 |
| `label` | `<pr>` | no write; the tick |
| `conflict` | `<pr>` | the `CONFLICT` row's hold write (`token <key> conflict-hold:#M`; the tick's `row` form carries the `(conflict: mergeable=CONFLICTING)` note, `token` cannot: it refuses any `conflict-hold` word that is not `conflict-hold:#<number>`) |
| `heartbeat` | — | the tick with `--fold-unchanged` |
| `drain` | `--reason` | `closeout.mjs begin` (spec 3) |
| `member-died` | `<member>` | the session's markers name the outcome: a `.jsonl.tombstone` is `killed`; a `.md` is `failed` for `fix-pr` and `finisher-pr`, `killed` for `merge-bot`, and refused for `impl`; a transcript with no marker, a report on disk or a review runner refuses; no transcript is `killed` once the first-seen stamp is over five minutes old, and refused before that. Then `ledger.mjs settle <member>=<outcome>` |

`member-died` takes no outcome argument: its outcome is read from the
session directory's listing, never passed.

**D2. `ledger.mjs token <key> <token>…`.** Appends tokens to a row and
keeps every token already there; refuses a member token (those are
`dispatch`/`settle`'s), a review token (`review`'s), a word shaped like a
member token that the grammar cannot parse, a `tier=` that is not a cell
or that names a second tier, on the row or earlier in the same call, a
`held-behind` or `conflict-hold` token the tick cannot read, a `label-off=`
naming no
finisher-pr member the ledger knows, the row's ` · ` separator, a lone
`→`, and any argument that is not one word. Every other word (`ci=…`,
`ports=…`, `route=…`, `tier-ok=…`, `dispositions-*=…`) is a freeform
token, written unless it would split one PR across two rows or crowd a PR
with a second open launch (a `PR#<n>` mention can). `row` stays for a full
rewrite and for creating a row, and its stderr `rewrote row #N` becomes a
warning that names every
token the rewrite dropped. `fleet-event.mjs` never calls `row` on an
existing line.

**D3. `fleet-tick.mjs --apply`.** Before computing its rows, the tick runs
the idempotent follow-ups whose trigger it can read off the ledger and its
own state, and prints one `APPLIED <duty>: <receipt summary>` line each:

- `reap.sh --apply` and `reclaim-scratch.mjs --root <scratch> --apply` when
  a `merge-bot-<n>=done` token exists that `applied.reapAfter` in the
  heartbeat state does not yet name; the state is updated after both ran.
  `applied` is stored as `{run: <controller record at>, reapAfter: […]}`.
  The heartbeat state survives rotation, and merge-bot numbering restarts at
  1 with every run that carries no bot forward, so a name alone would match
  the previous run's `merge-bot-1`: an `applied` whose `run` is not the
  current record's `at` counts as empty.
- `tier-check.mjs --batch` for every implementer the tick would otherwise
  print `HOLD (tier unchecked …)` for, with `session` from the phase-0
  receipt (exit 2 cases stay a hold and print the check's line).
- The shortlist refresh, as today.

`--apply` never dispatches, never settles a member and never writes a
member token. Without `--apply` the tick stays read-only. `fleet-event.mjs`
always passes it; the controller's bare tick in prose is retired.

**D4. Reconcile against transcripts.** Advisory lines, printed above the
rows like `CHECK-LIVENESS`, from one `readdir` of the phase-0 receipt's
`session` directory, never a transcript read:

- `UNRECORDED <stem>`: a `<stem>.jsonl` whose stem parses as a member name
  of this run's families and no ledger token, `## Dispatched` entry or
  `## Retired` name names it. An `ancestor` rotate moves every settled
  member of the earlier run into `## Retired` as a bare name while its
  transcript stays in the same session directory.
- `NO-TRANSCRIPT <member> (live <age>)`: a live token whose `<member>.jsonl`
  does not exist after `--no-transcript-after` minutes (default 5).

ADR 0028's "the tick reads no registry or transcript" is amended on its
Status line: the tick reads the session directory's listing, nothing in it.
`member-died` (D1) reads that listing and the markers of the one member it
names, never a transcript body. The registry census stays the controller's.

**D5. SKILL.md.** The Record-then-tick table becomes a two-column table,
wake → `fleet-event.mjs <kind> <args>`. The bullets under it that explain
each wake's writes move to the script's header comment; the ones that state
a judgement (the finisher gate's outbox test, never dispatch while a ruling
is owed) stay. The NO-TRANSCRIPT and finisher-failed bullets name the
`member-died` wake, which is the one place a dead member's settle outcome
is chosen.

**D6. Tests.** A fixture ledger drives every `fleet-event.mjs` kind twice
and asserts the second run writes nothing new; `tests/ledger.test.mjs`
proves `token` keeps every existing token and refuses each refusal D2 lists,
and `tests/ledger-grammar.test.mjs` proves it accepts the freeform tokens;
a tick test proves `--apply` reaps exactly once per `merge-bot-<n>=done`,
and again for a same-numbered bot in a later run, and that without `--apply`
nothing is executed; a reconcile test with a fixture session directory for
both D4 lines, including a retired member's transcript, which is not flagged.

## Out of Scope

- The tick dispatching anything.
- The Pull (spec 5), which stays a separate driver because it asks
  judgement questions.
- Reading transcript contents in the tick. The census and the mtime
  discriminator remain the controller's.

## Open Questions

- Whether `fleet-event.mjs` should take the member's report path or derive
  it from the member name. Lean: derive, so a wrong path cannot be typed.
