# The Pull as a driver: `pull.mjs` runs the mechanical steps and asks the controller only the judgement questions

Date: 2026-10-13
Status: spec, input to `/to-tickets`. Spec 5 of 6 from the 2026-10-13 determinism review.
Relates to: `run-team/SKILL.md` § Phase 1 and § Phase 2; ADR 0013 (automatic supply, relabel by cause, the comment templates); #3129 (collision scan excludes on file overlap); #3086 (no rule for an implementer whose ticket an open sibling PR already covers).
Depends on: spec 1 (the dispatch step renders the brief). Everything before the dispatch step is independent.
Base tree: `main` at `bd4afac` (2026-10-13).

## Problem Statement

A Pull is seven ordered steps. Four are mechanical: the in-flight check,
the full issue read into `issue.json`, the claim, the route-row-dispatch
sequence. Two are judgement: *still live?* (choosing which string settles
the ticket, then `staleness.mjs`) and *decided?* (would two implementers
build different things), plus the collision and sequence scans, which are
half mechanical (which files does each open PR touch) and half judgement
(which files does this un-implemented ticket name). They are interleaved in
prose, with the relabel comment templates, the three-value verdict table,
the "both halves of that command are load-bearing" paragraph and twelve
measured war stories between them.

What goes wrong is that a step is skipped or run out of order: a ticket
pulled from a stale list without the labels re-read, a claim made ahead of
a collision scan, a close citing a commit whose subject nobody read, a
router exit 2 with the claim left standing. Each has a paragraph. The
judgement calls themselves are not the problem; the prose around them is.

## Solution

`pull.mjs` runs the Pull. It performs every mechanical step and stops at
each judgement point with a question the controller answers in one token.
The script owns the comment templates, the relabel, the close, the claim,
the router call, the ledger row and the brief render, and prints one
dispatch spec at the end. The controller's whole contribution to a Pull is
three answers and one `task` call.

## User Stories

- As the controller, I want `pull.mjs next` to take the shortlist head,
  run the in-flight check and read the ticket, and ask me the staleness
  string, so that I never pull from a list older than its relabel.
- As the controller, I want to answer `decided` or `ready-for-human-fork:
  <options>` and have the script post the comment and move the labels, so
  that the comment's wording is never mine to retype.
- As the controller, I want the collision scan to print the overlapping
  paths per open PR and live branch before asking me, so that `behind-pr`
  is an answer to evidence rather than a scan I run by hand.
- As the controller, I want a router exit 2 to release the claim and emit
  the event itself, so that a refused route never leaves a claim behind.
- As a maintainer, I want every Pull's answers recorded with timestamps in
  `<scratch>/impl-<N>/pull.json`, so that a wrong admission is traceable
  to the answer that admitted it.

## Implementation Decisions

**D1. Protocol.** `pull.mjs next [--head <N>]` starts a Pull on the
shortlist head the tick named (or `--head`). The script persists its state
in `<scratch>/impl-<N>/pull.json` and exits 10 with a `QUESTION <id>:`
block whenever it needs the controller; `pull.mjs answer <N> <id> <token>
[<text>]` records the answer and resumes. Other exits: 0 dispatched and the
dispatch spec printed; 1 the ticket left the Pull (dropped, closed,
relabelled, excluded) with the reason, next head; 2 could not look, named;
3 usage.

**D2. Steps and questions, in order.**

1. `inflight.sh <N>`: exit 1 or unknown → exit 1 `taken`.
2. `gh issue view` to `<scratch>/impl-<N>/issue.json`; labels without
   `ready-for-agent` → exit 1 `relabelled elsewhere`. Prints the distilled
   brief (title, the `## Agent Brief` comment or the body, `Out of scope`)
   and the `paths` the router's extractor finds in it.
3. **Q1 `staleness`**: `gone -- '<string>' | present -- '<string>' | none
   <why>`. The script runs `staleness.mjs --path <p> --gone/--present` for
   each answer (Q1 repeats until `done`); exit 1 → the script reads the
   subject of the commit the payload names, prints it, and asks **Q1b
   `close`**: `yes | no <why>`; `yes` closes the ticket citing commit and
   subject, exit 1. Exit 2 is recorded as `could-not-check: <reason>` and
   carried into the brief.
4. **Q2 `decided`**: `decided | needs-triage: <missing decision> |
   ready-for-human-fork: <options verbatim> | ready-for-human-hands:
   <external access|manual testing|judgment>: <line>`. Anything but
   `decided` posts ADR 0013's comment for that cause, moves the labels,
   exit 1.
5. Collision scan, mechanical half: for every open PR `gh pr diff
   --name-only`, for every live worktree branch `git diff --name-only
   origin/main...<branch>`, intersected with the brief's `paths` and with
   paths the controller adds; prints the overlaps per PR and branch. **Q3
   `collision`**: `clear | behind-pr:#M | behind-issue:#M | paths: <p>…`
   (the last adds paths and re-scans). An exclusion writes the `excluded ·`
   row, exit 1.
6. `claim-ticket.sh <N> impl-<N> implementer --apply`; exit 2 → exit 1
   `taken`.
7. `ticket-router.mjs route …` with the arguments phase 2 states, the
   `--impl-row` count read off the ledger, `--chain-head` from Q3's
   `behind-issue` history; exit 2 → `release-ticket.sh --apply`, exit 2
   named.
8. `ledger.mjs row`, `dispatch-prompt.mjs render implementer --member
   impl-<N> …` (spec 1), then `ledger.mjs dispatch`, which reads the
   rendered brief's sidecar and refuses without it (spec 1 D3). Prints
   `DISPATCH {name, agent, brief: <path>}` and exits 0. The controller makes
   the `task` call; the tier check runs under spec 4's `--apply`.

**D3. Answers are the record.** `pull.json` holds every question, answer,
free text and timestamp, plus every command the script ran with its exit
and a bounded stdout. The relabel comment carries nothing the answer did
not supply; the templates are the script's, copied from ADR 0013 § 4 and
pinned by the existing prose tests, retargeted to the script's output.

**D4. The tick names the driver.** `PULL #N …` rows read `PULL #N — pull.mjs
next --head N`. A Pull with a pending question is a Pull in progress: the
tick reads `pull.json` for each shortlist head and prints `PULL #N (Q2
pending)` instead of a fresh `PULL`, so a question never gets asked twice.

**D5. SKILL.md.** Phase 1 and the mechanical half of Phase 2 become the
protocol in D1 and the question vocabulary in D2. The Decided? table, the
three-value verdict table and the "grep for the asked-for change" rule stay
as the guidance for answering Q1 and Q2; the war stories move to
`references/pull.md`.

**D6. Tests.** A fixture repo with a stubbed `gh` drives every exit of
every step: taken, relabelled, each Q2 cause with its comment compared to
ADR 0013's template, exclusion rows, claim exit 2, router exit 2 releasing
the claim, and a full path to `DISPATCH` with the brief rendered; a resume
test proving `answer` after a process restart continues at the right
question; a tick test for D4.

## Out of Scope

- Making any judgement in the script. Q1, Q2 and Q3's verdict are the
  controller's; the script offers evidence and takes a token.
- Hunk-level collision (#3129). The scan is file overlap, as today; the
  question's `paths:` answer is where a finer scan would plug in.
- Extending the driver shape to other wakes. That is the next map, once
  this one has run a few hundred Pulls.

## Open Questions

- Whether Q1 should offer a default string the script derives (the first
  backticked construct in the brief) so the common case is `accept`. Lean:
  print it as a suggestion, never run it unasked; the wrong direction
  answers the opposite verdict with full confidence.
