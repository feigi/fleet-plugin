# Triage Deferral Reconciliation Log

Append-only. Each entry below is one pass of the `needs-triage` review-deferral
sweep #593 defined: probe every open `needs-triage` issue carrying
`Deferred from PR #<n>` against `origin/main` (never the working tree, never
the ticket's own cited line numbers) and route it to one of five outcomes —
already-fixed (close, cite the commit), partly-fixed (comment + relabel),
live-confirmed (`ready-for-agent`), live-not-confirmed (stays
`needs-triage`), or duplicate (comment on the covering ticket + close, never
drop the finding).

Never edit a past entry — this is a durable log the same way `.fleet/ledger.md`
is, not a live count to overwrite. Add a new dated section per sweep.

## 2026-09-27 sweep (#593)

**As-of 2026-09-27**, initial probe against `origin/main`@`6c99ff3c`; final
state below reflects `9fb0f96d` after PR #2091 merged mid-sweep (see the
per-ticket note).

**Before:** 59 open issues; 30 carrying `Deferred from PR #<n>`; 2
`needs-triage` (#2100, #2097), of which 1 (#2100) also carries the deferral
marker — the only ticket in this sweep's scope.

Context for the gap between that and #593's own filing baseline (95
`needs-triage` deferrals, measured 2026-08-18 on `feigi/claude-config`, per
#593's own body — the 2026-09-08 rename to `feigi/fleet-plugin` is a
separate fact, confirmed independently in `docs/agents/triage-labels.md`):
ordinary fleet operation over the intervening ~40 days — filing new
deferrals directly under #239's repriced bar, and closing/relabelling old
ones ticket-by-ticket as ordinary review/implementation work touched them —
had already reconciled all 95 of that baseline by the time this sweep ran;
none were still open and `needs-triage`-plus-deferred at sweep time.
Nothing in this entry re-derives *how* each of those 95 was resolved.
`#2100` — the only ticket in this sweep's scope — was filed 2026-09-27,
after the baseline was measured, so it is not one of the 95: it is a new
deferral this sweep's probe window happened to catch, not a backlog
leftover.

**Probed:**

| # | Central claim | `origin/main` verdict | Outcome |
|---|---|---|---|
| #2100 | `PARAGRAPH_INTERRUPT`'s unbounded `[ \t]*` indent prefix may misread indented code as a heading/fence in a nested list item, inside `bullet()`'s #2077 rewrite | At the first probe (`6c99ff3c`) the construct did not exist on `main` at all — `bullet()` was still the pre-#2077 sibling-indent implementation; `PARAGRAPH_INTERRUPT` existed only on the then-open PR #2091. That PR had in fact already merged (`9fb0f96d`) 2m43s before this probe's own comment was posted, landing the regex verbatim at `plugin/scripts/prose-pin.mjs:272` — corrected same-day once noticed. Either way, the *defect* (not the construct) is what the outcome turns on, and it is unconfirmed by the filer's own words ("reasoned about, not executed"); the merged branch's own last commit (`64a9adbb`) separately defers this same finding to a tracking issue alongside two others (#2098, #2099) without itself characterizing it as confirmed or unconfirmed — it does not independently re-confirm anything about #2100 | live, defect **not confirmed** → stays `needs-triage`. Comments: [initial probe](https://github.com/feigi/fleet-plugin/issues/2100#issuecomment-5859918309), [merge correction](https://github.com/feigi/fleet-plugin/issues/2100#issuecomment-5859932456) |

**After:** 58 open issues (#2077 auto-closed by PR #2091's merge — an
incidental side effect of this sweep's own probe window, not a sweep
action); 30 deferred (unchanged); 2 `needs-triage` (unchanged), 1 of which
still carries the deferral marker (unchanged). No ticket promoted, no ticket
closed by this sweep, no label changed by this sweep: the one live ticket in
scope is genuinely the narrow "defect not confirmed" case the outcome table
names, so it stays exactly where it was.

**Revert:** delete the two linked comments on #2100. No label was changed and
no issue was closed by this sweep, so there is nothing else to undo — this
entry is independent of #239's filing-bar policy change and of PR #2091's
unrelated merge.

## 2026-09-28 addendum to the 2026-09-27 sweep (#2106)

Not a new sweep: nothing below was probed, commented or relabelled by #593's
procedure. It records a state change made *after* the 2026-09-27 entry
closed, so that entry's "stays `needs-triage`" outcome for #2100 is not read
as current. The 2026-09-27 entry itself is left unedited, per the rule above.

**As-of 2026-09-28**, read from the issue tracker (`gh issue view 2100`, the
#2100 timeline, `gh issue list --state open --label needs-triage --limit 500`);
`origin/main`@`94ce0096`.

**Changed since the 2026-09-27 entry:**

| # | 2026-09-27 outcome | What changed, and by what | State now |
|---|---|---|---|
| #2100 | live, defect **not confirmed** → stays `needs-triage` | At 2026-09-28T07:08:08Z an independent triage-verification pass — not #593's sweep, and not a re-run of it — posted a [triage verification](https://github.com/feigi/fleet-plugin/issues/2100#issuecomment-5865145762) that ran `bullet()` against the reference `commonmark` parser and reported "Defect confirmed, but the premise here is wrong": nesting depth alone does not trigger it; the real trigger is a shallower line 4+ columns past its container's content column with no blank line before it, which CommonMark reads as lazy continuation text of the item but `bullet()` treats as ending the item. One second later (07:08:09Z) the same pass removed `needs-triage` and added `bug` + `ready-for-agent` | open; `bug`, `ready-for-agent`, and `in-progress` (added 2026-09-28T17:31:35Z when a fleet run claimed it for implementation) |

**After:** 0 open `needs-triage` issues repo-wide
(`gh issue list --state open --label needs-triage --limit 500` returns `[]`).
The other `needs-triage` ticket the 2026-09-27 entry counted, #2097 (no
deferral marker, so outside #593's scope), was likewise relabelled
`needs-triage` → `bug` + `ready-for-agent` at 2026-09-28T07:08:12Z, three
seconds after #2100, and closed 2026-09-28T17:31:00Z. With no open
`needs-triage` issue left, the `needs-triage`-plus-deferred backlog #593 set
out to reconcile is empty.

**Revert:** nothing to undo. This entry records changes made elsewhere and
makes none of its own.

## 2026-10-03 sweep

**As-of 2026-10-03**, probed against `origin/main`@`2fb6e68b`. The sweep was a
`/triage` pass over every open `needs-triage` issue. It used #593's procedure
(probe `origin/main`, never the working tree or the ticket's cited line
numbers), but #593 itself was already closed.

**Before:** 101 open issues; 6 `needs-triage` (#2447, #2466, #2467, #2472,
#2473, #2474), all 6 carrying `Deferred from PR #<n>`.

**Probed:**

| # | Central claim | `origin/main` verdict | Outcome |
|---|---|---|---|
| #2447 | ADR 0017's removed tier-check regex sits in an inline code span split across two lines | Live: `awk 'length>80'` reports the span's line at 92 characters, and the span continues on the next line | live-confirmed → `bug` + `ready-for-agent` (brief: whitespace-only rewrap, since the ADR is accepted) |
| #2466 | `external-assumptions.md`'s index bullet calls `task.agentModelOverrides` retired while `prose.md` row 125 is live | Live: `tier-roles.mjs --check` with fixture files (no real omp config) exits 1 on a leftover `fleet-` key, and the bullet ("the only omp settings a run depends on") does not cite row 125 | live-confirmed → `bug` + `ready-for-agent` |
| #2467 | `prose.md` row 125's "measured omp 18.4.10" has no in-tree provenance | Live: 8 of the 9 rows that state a measurement cite a separate in-tree carrier that records it; row 125 is the only exception, and `18.4.10` occurs nowhere else in the tree | live-confirmed → `bug` + `ready-for-agent` (a superseding brief replaced the first one, which made the row cite itself) |
| #2472 | An explicit `--ledger` naming a missing file drops `dispositions-check.mjs` to standalone mode silently | Reproduced: exit 0, `token:null`, empty stderr. Standalone mode is deliberate and pinned by a test, which asserts nothing about stderr; no caller passes `--ledger` | live-confirmed as a diagnosability gap → `enhancement` + `ready-for-agent` (brief: add a stderr note, keep the semantics) |
| #2473 | The standalone-mode tests may let mutant M7 survive | Refuted: baseline 45/45 green; M7 and a GIT_DIR-scrub removal each turn 2 tests red | refuted → `bug` + `wontfix`, closed |
| #2474 | `ledgerFile === null` is tested at two sites | Refuted: `ledgerFile` is a `const` bound once, so the two tests cannot disagree, and the proposed refactor still tests it twice | refuted → `enhancement` + `wontfix`, closed; recorded in `.out-of-scope/dispositions-check-ledger-sentinel.md` (PR #2489) |

Two closures (#2473, #2474) are a sixth outcome that #593's five do not name:
the filer marked each finding refuted, the probe confirmed the refutation, and
there was nothing left to change. They are closed `wontfix` rather than left
in `needs-triage`, because the probe settled them; nothing is left
unconfirmed.

**After:** 100 open issues; 44 carrying `Deferred from PR #<n>`; 0
`needs-triage` (`gh issue list --state open --label needs-triage --limit 500`
returns `[]`). Open-count reconciliation: 101 before − 2 closed by this sweep
(#2473, #2474) − 1 closed by an unrelated merge mid-sweep (#2391,
2026-10-03T08:52:59Z) + 2 filed mid-sweep (#2485, #2490) = 100. The
deferred count was not measured before the sweep, so it has no
before-and-after comparison.

**Revert:** reopen #2473 and #2474; on all six, restore `needs-triage` and drop
the category and state labels this sweep added; delete this sweep's triage
comments on each; close PR #2489 unmerged.

## 2026-10-03 sweep, second pass

**As-of 2026-10-03T22:30Z**, probed against `origin/main`@`5cd8b625`. A
`/triage` pass over every open `needs-triage` issue, run with #593's
procedure (probe `origin/main` in a throwaway worktree, never the working
tree or the ticket's cited line numbers). Each ticket was probed by its own
agent, sized to the ticket: #2550 small, #2571 medium, #2551 medium-high,
#2504 and #2568 high.

**Before:** 5 `needs-triage` (#2504, #2550, #2551, #2568, #2571); 4 carry
`Deferred from PR #<n>` (all but #2568, which was filed from two CI failures).

**Probed:**

| # | Central claim | `origin/main` verdict | Outcome |
|---|---|---|---|
| #2504 | A CLOSED ticket's unchecked replacement (`impl-<N>-b`) still reads `HOLD (tier unchecked …)` | Reproduced, but as designed: one `tier-check.mjs --batch` run always clears it (a `tier-mismatch=` verdict is then lifted by the closed-ticket mismatch lift), and the check guards the next Pull against a definition or `modelRoles` fault, not the closed ticket | refuted → `enhancement` + `wontfix`, closed; recorded in `.out-of-scope/closed-ticket-tier-unchecked-lift.md` (PR #2585) |
| #2550 | `recipe-prove` leaves its log directory in `$TMPDIR` after `PROVEN` | Reproduced. Nothing reads the logs after `PROVEN` (the cache carries the proof); `NOT PROVEN` refusals name a log path | live-confirmed → `bug` + `ready-for-agent` (brief: remove on `PROVEN` and exit 2, keep on `NOT PROVEN`) |
| #2551 | `recipe-prove` runs Install, Test and mutation with no timeout | Reproduced a hang (only an outer alarm ended it). Also found that a SIGTERM-trapping command keeps a `timeout`-only `spawnSync` from ever returning | live-confirmed → `bug` + `ready-for-agent` (brief: 20-minute bound per command, shorten-only `RECIPE_PROVE_TIMEOUT`, `SIGKILL`, `NOT PROVEN` refusal naming the bound) |
| #2568 | `reap.test.mjs`'s `gitdir missing` / `gitdir chmod 000` rows flake in CI | Root-caused: on git ≥ 2.54 the fixture's own `git fetch --prune` starts detached auto-maintenance whose `worktree-prune` task erases the fault before reap.sh reads it. Reproduced locally by enabling that task on git 2.50.1; about 1.4% of CI runs | live-confirmed → `bug` + `ready-for-agent` (brief: `-c maintenance.auto=false` in the test's fixture `git()` helper only) |
| #2571 | `recipe-prove`'s `git()` cannot tell a signal-killed git from a non-zero exit | Reproduced: `kill -9`, `kill -TERM` and an over-`maxBuffer` git each end in a `NOT PROVEN` message with an empty reason | live-confirmed → `bug` + `ready-for-agent` (brief: name the signal and `error.code` in `err`; do not throw) |

**After:** 0 `needs-triage` (`gh issue list --state open --label needs-triage
--limit 500` returns `[]`). The open-issue and deferred counts were not
measured before the sweep, so they have no before-and-after comparison.

**Revert:** reopen #2504; on all five, restore `needs-triage` and drop the
category and state labels this sweep added; delete this sweep's triage
comments on each; close PR #2585 unmerged.
