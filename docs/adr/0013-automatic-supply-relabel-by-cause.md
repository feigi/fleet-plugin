# 0013 — Supply is automatic: one Pull per free slot, and a ticket the controller cannot admit is relabelled by cause

**Status:** Accepted. Ruled 2026-09-24 on #1775 (map #1768), against the measurements below. Retires the invariant "exactly one human decision per wave, zero unilateral grabs" (`docs/specs/2026-07-22-run-team-agent-fleet-design.md` § Central conflict) and reverses `run-team/SKILL.md`'s "an unclaimed ticket is not yours to reclassify".

## Context

- The invariant, quoted verbatim from the 2026-07-22 spec: *"the controller
  runs `next-ticket` steps 1–4 exactly once, in the main thread, and gates
  on the maintainer there. Implementers never run ticket selection at all —
  they enter at step 5 with a ticket already assigned. The rule is
  preserved rather than bent: exactly one human decision per wave, zero
  unilateral grabs."*
- Today's phase 0: "Maintainer ticks what to **stage this wave** — how
  many, what order, what collides" (SKILL.md § phase 0); "Never put two
  sequenced tickets in one wave" (SKILL.md); reclassifying an unclaimed
  ticket is forbidden ("an unclaimed ticket is not yours to reclassify",
  SKILL.md L1527–1528), with phase 0's multi-select carrying the sole
  exception (SKILL.md L1500–1501).
- The 2026-09-21 precedent: the maintainer hand-relabelled 13 forked
  tickets `ready-for-human` outside the fleet's own reclassify prohibition
  — re-examined and re-ruled at #1775's Q5, against the maintainer, in
  favor of the fleet doing the same relabelling itself.
- R1 (#1769): implementer slots sat empty 87–91% of session wall time
  (idle ratio 0.906 full-invocation, 0.867 activity-envelope-bounded), and
  32 of 75 reviews launched within 5 s of another — evidence that staging,
  not supply, idles the fleet.
- `candidates.mjs` already returns oldest-first with a dependency scan and
  drops any body carrying a `## User Stories` heading
  (2026-07-30 spec), so the cheap filters already exist; the collision scan
  and full-body read are the expensive steps a Pull defers to the point of
  actual admission (#1775 §1–§2).

## Decision

**Supply is automatic.** `/run-team` no longer presents a multi-select. The
controller keeps an ordered **Shortlist** and admits one ticket per free
implementer slot — a **Pull** — the moment the slot frees. Selection and
ordering are batched (one scan); admission is never batched.

1. **Shortlist = cheap filters only, no bodies.** A new
   `plugin/scripts/shortlist.mjs` runs `candidates.mjs --require-label
   ready-for-agent` (oldest-first, no re-rank), the dependency scan on the
   `d` array (open blocker → drop), `inflight.sh <N>` per survivor (exit 1
   or 2 → drop, 2 logged by number), and subtracts every ticket with an
   `excluded` ledger row whose premise still holds. It writes the
   survivors, in order, to `.fleet/shortlist.json`, resolved against the
   git common dir exactly as `ledger.mjs` resolves `.fleet/ledger.md`.
   Phase 0 steps 1–3 survive as this script's body; steps 4–6 (full read,
   collision scan, multi-select) are retired from phase 0.
2. **Pull reads one ticket.** In order: take the shortlist head;
   `inflight.sh <N>` again (1 or 2 → drop, next); `gh issue view <N>` full
   read once — judge decided/undecided and class exactly as today's step 4;
   infer target files and check them against every open PR's `gh pr diff
   --name-only` **and** every live worktree's `git diff --name-only
   origin/main...<branch>` (from `git worktree list`); check the brief's
   `Out of scope` for an open ticket it sequences after;
   `claim-ticket.sh <N> <slug> <type> --apply` (exit 2 → treat as taken,
   next); `ledger.mjs row <N> "impl-<N> · class=… [· tier=alt]"`; dispatch.
   A ticket that fails any judgement is relabelled or excluded (3, 4) and
   the Pull takes the next entry. Empty shortlist → refresh once, Pull
   again; still empty → hold idle until the next refresh trigger (5).
3. **Exclusion = ticket row with a premise.** A collision or sequence
   verdict writes `ledger.mjs row <N> "excluded · behind-pr:#M"` or
   `"excluded · behind-issue:#M"` (`#M` = the open PR, or the branch name
   until its PR exists, or the sequenced-after issue). No new ledger
   section. Every refresh probes each premise (`gh pr view M --json state`
   / `gh issue view M --json state`); MERGED **or** CLOSED lifts a
   `behind-pr`, CLOSED lifts a `behind-issue`; a lifted ticket re-enters the
   shortlist in its oldest-first slot and its row is rewritten to
   `impl-<N> …` when pulled. This makes "re-check the deferred list after
   every merge" mechanical.
4. **Relabel by cause at Pull.** Reverses SKILL.md L1527–1528 ("an
   unclaimed ticket is not yours to reclassify") and retires L1500–1501's
   "Phase 0's multi-select" permission exception. Three causes, two labels:

   | Cause at Pull | Label |
   |---|---|
   | brief names no *what* | `needs-triage` |
   | genuine fork — options named, none ruled | `ready-for-human` |
   | needs human hands — external access, manual testing, judgment during the work | `ready-for-human` |

   L1521–1522 is rewritten: "`ready-for-human` for hands or a fork;
   `needs-triage` for a brief that names no *what*."
   `gh issue edit <N> --remove-label ready-for-agent --add-label <label>`
   (no `in-progress` to drop — never claimed), preceded by one comment:

   - `needs-triage`: `> *Relabelled by the fleet controller.* Pulled for
     implementation and returned: the brief does not decide what to build.
     Missing decision: <one line>. Returning to /triage; `ready-for-agent`
     restored once decided.`
   - `ready-for-human` (fork): `> *Relabelled by the fleet controller.*
     Pulled for implementation and returned: the brief leaves a decision
     open. Open fork: <options, verbatim from the brief>.`
   - `ready-for-human` (hands): `> *Relabelled by the fleet controller.*
     Pulled for implementation and returned: needs human hands — <external
     access | manual testing | judgment during the work>: <one line>.`

   Neither label invokes anything: `/triage` is maintainer-run; both labels
   only stop the ticket costing a read per scan.
5. **Refresh triggers.** Unclaimed shortlist entries < implementer **cap**
   (not cap − live); every heartbeat tick while the shortlist is empty;
   merge-bot pass done (premises lift). Within a turn, Pull from the
   current list first, refresh second — a refresh never delays a dispatch.
6. **Alt-tier: every 5th Pull by ledger count.** Count = `impl-` rows in
   `.fleet/ledger.md` at Pull time; the Pull that creates row 5k dispatches
   `fleet-implementer-alt` and records `tier=alt` in the row; a replacement
   inherits the row's tier. The assignment rolls to the next Pull when the
   pulled ticket is `class=correction` or another open ticket sequences
   after it. The member is not told. Tier guard query unchanged.
7. **Run lifecycle unchanged.** `/run-team [implementers] [reviewers]`
   starts only when invoked, gains no argument; phase 0 step 0
   (fast-forward, instruments pin, ruleset check, cockpit, fold in
   inherited open PRs) stays once per run; the run ends on maintainer
   drain, budget, or context (ADR 0008 §7).

**Retired invariant:** "exactly one human decision per staging, zero
unilateral grabs" (`docs/specs/2026-07-22-run-team-agent-fleet-design.md`
§ Central conflict). Its replacement: zero human decisions per admission;
every non-admission is a label or a premise the maintainer can read.

## Guard — chosen before any further data

Same guard as ADR 0012, restated so this file stands alone:

**Population:** the first ≥20 merged PRs after the cutover (the last prose
ticket of spec § 9 merged), per harness. Only omp has a baseline today
(`docs/research/baseline-efficiency.md`: n=75, #1600–#1705, one session);
the Claude Code leg is measured at the first Claude `/run-team` run that
merges ≥20 PRs — a scheduling gap, not an instrumentation one. Pre-cutover
rows are never read; stored records (transcripts, `docs/metrics/*.tsv`,
accepted ADRs, dated specs) stay as written.

| # | Signal | Baseline (omp) | Must |
|---|---|---|---|
| 1 | Fleet `cache_creation` per merged PR (Σ `tokens_cache_create` over every dispatched member with `role != memory`, ÷ n) | **1,078,459** | not rise |
| 2 | Controller `cache_creation` per merged PR (Σ `usage.cacheWrite` over the controller kernel's own assistant turns, ÷ n) | **133,720** | not rise |
| 3 | Implementer-slot idle ratio (1 − avg live implementers ÷ cap, time-weighted over the run) | **0.906** (activity-envelope variant 0.867) | fall |
| 4 | Review start latency, PR `createdAt` → review workflow start (the snapshot dispatch on Claude, `review-pr-<n>`'s `session_init` on omp — not the first specialist fan-out, which read 16.5 min / 246.8 min) | median **8.8 min**, p90 **39.1 min** | fall (both) |

**Method:** `python3 docs/research/baseline-efficiency-derive.py` against the
post-cutover session (its docstring names what to change); same events, same
`role` classifier.

**Trigger:** any signal in the wrong direction on that window. **Then:**
revisit the decision that owns the signal, with the measurement in hand —
signal 1: merges per pass first (past 15 min of idle a live bot costs more
than a restart), then the bot's brief size (the gate script is where guard
1 gets its margin); signal 2: the per-Pull prompt (the pool's 14.5 KB
context was the cost being retired); signal 3: the Pull path and refresh
triggers; signal 4: the reviewer cap, `--max-reviews`, and Claude's ≤1-in-
flight bound. Never reopen on fewer than 20 PRs. **Do not** read guard trips
as licence to reintroduce staging: automatic supply is this ADR's own
decision and carries the same guard.

## Consequences

- Phase 0 steps 4–6 are retired; steps 1–3 become `shortlist.mjs` (new
  script + test; `.fleet/shortlist.json`).
- `/run-team [implementers] [reviewers]` gains no argument.
- Ledger rows gain `excluded · behind-pr:#M | behind-issue:#M` and
  `tier=alt` (no new ledger section).
- `fleet-implementer-alt` is every 5th `impl-` row, rolling past
  corrections and chain heads.
- The relabel comment templates are the only writes to a ticket the fleet
  did not claim.
- `docs/specs/2026-07-22-run-team-agent-fleet-design.md` is superseded in
  part (blockquote, spec § 7).
- The cockpit will render `excluded ·` rows as cards until decided (fog,
  map #1768).
- `CONTEXT.md` § Loop defines Shortlist, Pull, Exclusion.

## Rejected alternatives

- **Keeping the multi-select** — the invariant, one human decision per
  staging, is exactly what R1's idle-ratio measurement (0.906/0.867) shows
  costing implementer-slot time.
- **Leaving inadmissible tickets `ready-for-agent`** — costs a read per
  scan, the status quo SKILL.md L1527 already forbids fixing this by
  reclassifying.
- **A model re-rank of the shortlist** — the 2026-07-30 spec already
  settled oldest-first, script sort; no re-rank.
- **A new ledger section for exclusions** — "No new ledger section" (§3);
  the exclusion is a ticket row like any other.
- **Relabelling forks `needs-triage`** — forks are `ready-for-human`, per
  the 2026-09-21 precedent, re-ruled at Q5.
