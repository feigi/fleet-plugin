# 0028 — A live token past its p99 points the controller at the registry census

**Status:** Accepted. Ruled 2026-10-11 by the maintainer in a grilling session
on #2890, against the measurements below. Amends ADR 0008 (§8, which gains a
key owner) and ADR 0012 (Decision 4, whose "`read proc://` is reserved for the
Member-killed confirmation, not the tick" stands: the tick prints a pointer
from its own key and the census stays the controller's).

## Context

A live token in the ledger (`impl-412`, `fix-pr-<n>`, `finisher-pr-<n>`,
`merge-bot-<n>`, an in-flight `review=`) holds a slot until the controller
settles it. Nothing settles a member that died without reporting, so its token
holds a fix or review slot and stalls the merge queue without a line anywhere
saying so. #2890 filed this from a run whose merge pipeline sat stalled with
live tokens for members whose transcripts had stopped mid-round.

Two halves. A controller that is itself dead is ADR 0025's: the controller
record, `proc.mjs` `isDead` and phase 0's stranded-claim step close it. This
ADR is the **controller-alive** half: a member that is gone, or no longer
running, under a controller that is still running the loop.

Measured before ruling (the maintainer's probe on 2026-10-11 plus every omp
session directory):

- **The registry already answers.** `read history://` lists every member by
  dispatch name with a status — `running`, `idle`, `parked`, `aborted` — and
  `read agent://<member>` returns its output. Both are controller tools only:
  a shell or node process gets ENOENT. ADR 0012's Decision 4 reserves `read
  proc://` for the Member-killed confirmation, and ADR 0025's phase-0 rule
  already reconciles each carried token against the session's job list; this
  is the in-run form of that rule.
- **Death modes, by what the registry and the filesystem show.**

  | Mode | `history://` row | Result delivered | Marker |
  |---|---|---|---|
  | Controller `write proc://x/kill` | `aborted` | yes (`cancelled`) | `<m>.md` and `<m>.jsonl.tombstone` |
  | Normal yield | `idle` | yes — expires about five minutes unconsumed, the output stays at `agent://` | `<m>.md` |
  | **The controller's own compaction or interrupt parks every in-flight member** | `parked` | no — the transcript ends on `tool_execution_start` | none |
  | Whole-session death | n/a | — | ADR 0025 |
  | A `running` row for a dead member | none observed | — | — |

  Two controller-alive stalls were found among every omp member transcript
  read, both a parked member the controller's own compaction had stranded (one
  parked 4.5 hours before it settled, one 3.5 hours before it was
  re-dispatched). [inference: omp subagents run inside the controller process,
  so compaction parks them and the harness writes their transcripts.] If so,
  the only member death the registry cannot record is the process dying —
  ADR 0025's case — and "row is not `running`" is complete for this half. The
  scratch-mtime rule stays as the backstop either way.
- **A dangling exit.** The Member-killed paragraph said to "settle the dead one
  on the liveness read below", and no such read had a terminal step left: the
  harness line it was written against was removed by the omp-only cutover
  (ADR 0014), leaving a sentence that names states but no read, so the
  `running`-but-frozen arm had no terminal step.
- **The tick cannot know a token's age.** The ledger records that a member was
  dispatched, never when. The tick already owns `quiet`, `digest` and `ticked`
  in `.fleet/heartbeat.json`, so a key of its own gives per-token age with no
  change to the ledger grammar. ADR 0012's Decision 4 says the tick's liveness
  input is ledger-derived; it says nothing about transcripts, and a tick-owned
  key is not one.

## Decision

1. **Scope: the controller-alive half.** Three cases: (i) a member that
   yielded with its result unconsumed, (ii) a member the controller's
   compaction parked mid-tool-call, (iii) a `failed` or wedged member. The
   restart half is ADR 0025's and is closed.
2. **Evidence: the registry census.** When the tick points at a token, read
   `history://` once. A live token whose row is not `running` → read
   `agent://<member>` and the artifacts (PR head, worktree, labels), settle the
   real outcome with the existing vocabulary, and resume a `parked` member with
   `write agent://<member>` when its work is worth continuing. A `running` row →
   the scratch-mtime rule, two polls: mtimes moved means BLOCKED and alive;
   frozen at both polls **and** no artifact movement → `write
   proc://<member>/kill`, `ledger.mjs settle <member> killed`, a fresh name.
   Three independent alive-signals must all be silent before a kill — the
   Member-killed prose's own asymmetry: a live member written off is killed and
   re-dispatched, which discards the work in flight, while one poll spent on a
   member that had in fact stopped costs only the poll. The kill and the settle
   stay controller acts.
3. **Trigger: a tick-owned `seen` key.** `seen: {<name>: firstSeenAtMs}` in
   `heartbeat.json`, set the first tick a token is live — late by at most one
   beat interval, never early — and pruned to the live set every tick. A live
   name is a member token or `review:PR#<n>` for an in-flight `review=` launch.
   The controller record guards it. On `prior: ancestor` the stamps of
   still-live tokens are kept, because carried tokens are old and their age
   must survive the rotation; on `dead` or `none` a stamp older than the
   record's `at` is the previous run's and is discarded, so a same-name token
   of the new run (`merge-bot-<n>` numbers repeat) starts at zero age. With no
   record, or one with no `at`, nothing can be compared and the stamp stands.
   The line is `CHECK-LIVENESS <member> (<family> > p99 <t>m)`, the age shown
   only as a multiple of the threshold — `> 2×p99 <t>m` from the second
   multiple on — so the digest `--fold-unchanged` compares holds inside one
   bucket. It is **not actionable**: no `quiet` reset, slot arithmetic
   untouched, and it survives a fold as the suffix `; CHECK-LIVENESS <member>
   persists`, the way `HOLD (main checkout dirty) persists` does.
4. **Advisory only.** The tick never settles, kills, writes the ledger or frees
   a slot.
5. **No `lost-report` outcome.** Case (i) is the task tool's result expiry; the
   output is at `agent://` and artifacts settle it. The ledger grammar is
   unchanged.
6. **Thresholds, minutes, one flag per family:** `--liveness-impl 78`,
   `--liveness-fix-pr 56`, `--liveness-finisher 57`, `--liveness-merge-bot 101`,
   `--liveness-review 78`. The four member values are the maintainer's p99
   reading of the omp rows of `docs/metrics/member-outcomes.tsv`, 2026-10-11.
   `review:PR#<n>` launches are not in that file under a family of their own,
   so `--liveness-review` is the nearest-rank p99 of `(last − first entry
   timestamp)` over every `review-pr-*.jsonl` under `~/.omp/agent/sessions`,
   measured at implementation on 2026-10-11: 77.09 minutes over 4,751
   transcripts, rounded up. The derivation is recorded in the source comment
   beside `LIVENESS_DEFAULTS`; no script carries it.
7. **No new script.** A script cannot read `history://`, and the file markers
   (`.md`, `.tombstone`) are absent on the measured death mode.

## Consequences

- ADR 0008 §8 gains an owner: `fleet-tick` owns `seen`, and `fleet-heartbeat`
  and ledger.mjs rotate carry it without writing it. `fleet-state.mjs` reads
  it per entry — a junk stamp costs that one member its age, never the map —
  and `writeState` carries it for every writer.
- ADR 0012's Decision 4 is untouched in what it reserves: the tick still reads
  no registry and no transcript. It prints a pointer from its own key; the
  census is the controller's.
- A token first stamped on a tick is stamped late by up to one beat interval,
  never early. A `review:PR#<n>` that finishes and relaunches between two ticks
  reads as one continuous token and keeps its first stamp; the line is advice,
  and the census it points at is what decides.
- `SKILL.md` gains a **Failure handling** row, *Member unaccounted*, after
  *Member killed* with the ordering in Decision 2; the Member-killed
  paragraph's "settle the dead one on the Member unaccounted row above" points
  at it;
  **Run ledger** gains one sentence — compaction parks every in-flight member
  and nothing reports it, so take the census first on resume — and the
  heartbeat's `--fold-unchanged` prose names the folded suffix.
  `stalled-member-liveness-prose.test.mjs` pins the ordering sentence and the
  asymmetry sentence as the kill precondition.
- Left out: auto-settle, auto-kill and auto-redispatch; the scratch-mtime
  discriminator itself; heartbeat and run-level liveness (ADR 0025); the
  `review=` MERGED/CLOSED dangling rule.
