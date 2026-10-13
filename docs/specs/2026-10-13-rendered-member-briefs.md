# Rendered member briefs: a script produces every dispatch prompt, and member duties live in agent bodies

Date: 2026-10-13
Status: spec, input to `/to-tickets`. Spec 1 of 6 from the 2026-10-13 determinism review (see `2026-10-13-runbook-diet-and-incident-policy.md` § Series).
Relates to: #2331 (finisher skipped duty 3, reported `labelled`), #2884 (fixer duty list contradicts the controller on the CI wait), #2299 (conflict fix-applier's definition recalled from prose), #2929 (move the verbatim member-prompt blocks out of always-on controller context — this spec supersedes it).
Depends on: nothing. Spec 2 (structured reports) names the report path a brief carries, but the brief can state it in prose until spec 2 lands.
Base tree: `main` at `bd4afac` (2026-10-13). Line numbers drift; re-grep before editing.

## Problem Statement

A fleet member learns its duties from a prompt the controller assembles by
hand. `fleet-finisher.agent.md` and `fleet-merge-bot.agent.md` are one line
each ("Follow the dispatch brief you were given"). The review fix-applier has
no agent definition at all: `ledger.mjs dispatch` prints `agent: null` for it.
Everything those members know arrives as text the controller pastes from
`run-team/SKILL.md`, where it sits as 453 non-blank `>`-quoted lines (33.0 KB
counting the blank `>` separators) spread over the Reviewers section: the
fix-applier prompt (22.8 KB), the finisher duty list,
the instrument re-check block, the test-verdict block, the duty-3 two-step
block, the halt-cause block. Beside those, fourteen separate rules say "say it
in every dispatch prompt", "give it verbatim", "tell every implementer,
fix-applier and finisher in one line".

The failure this produces is measured. #2331: two of five finishers in one
pass confirmed the release label (the precondition) and never added
`ready-to-merge` (the duty), then reported `labelled`; the brief had pointed
them at SKILL.md to self-read rather than restating the duty. #2884: the
fixer's dispatched duty list says "wait for green", the controller section
says members never hold a CI wait; members obeying either reading cost hours.
The `>` blocks are change-controlled by `dispatch-block-golden-prose.test.mjs`,
but that suite pins the source text in SKILL.md, never the prompt a member
actually received, so a block the controller dropped, truncated or filled
with a stale `<testCmd>` passes every test in the tree.

The controller, in other words, is a template engine implemented in
attention. Attention drops lines.

## Solution

A member's brief is rendered by a script from a template, never pasted. What
does not vary between dispatches of a role lives in that role's agent body,
exactly as the five `fleet-implementer-<cell>` bodies already do. What varies
is an argument list. `ledger.mjs dispatch` refuses to record a member whose
brief has not been rendered, and records the rendered brief's hash. Member
duties that are a fixed sequence of `gh` and `git` commands become scripts
the body names, so the member runs one command and reads one exit code. Each
fact about a duty has one owner file.

## User Stories

- As the controller, I want `dispatch-prompt.mjs render finisher --pr 2285
  --pin <sha> …` to print the whole brief, so that I pass one argument list
  and never decide which blocks a finisher needs.
- As the controller, I want `ledger.mjs dispatch` to refuse a member of a
  ledger family (implementer, fix-applier, finisher, merge-bot) with no
  rendered brief, so that a dispatch I half-prepared cannot leave the ledger
  looking complete.
- As a finisher, I want duty 3 to be `finisher-label.mjs --pr <M> --pin
  <sha>`, so that confirming the release label and adding `ready-to-merge`
  cannot be confused for one another.
- As a fix-applier, I want my brief and `review-and-fix.md` to agree on who
  owns the CI wait, so that I neither park for two hours nor stop with duties
  unowned.
- As a maintainer, I want the golden tests to compare rendered briefs, so
  that a block missing from what a member received is red, not only a block
  missing from SKILL.md.
- As a maintainer, I want SKILL.md to lose its 33 KB of member text, so
  that the controller's always-on context stops carrying prompts it never
  reads for itself.

## Implementation Decisions

**D1. The renderer.** `plugin/scripts/dispatch-prompt.mjs render <role>
[--<arg> <value>…] [--json]`. Roles: `implementer`, `fix-applier`
(`--kind review|conflict|dispositions-retry`), `finisher` (`--kind
fresh|repair`), `merge-bot`, `review-runner`, `recipe-deriver`. Every
placeholder a template carries is a named required argument; a missing one
is exit 2 naming it, and nothing prints. After substitution the renderer
scans its own output for any `<…>` token the template declared as a
placeholder and refuses on a leftover (exit 2) — a brief with `<testCmd>`
still in it never leaves the script. Paths are checked absolute; a
review-runner `--scratch` ending in `pr<digits>` is refused here for the
same reason `review-core.mjs` refuses it. Output is the brief on stdout;
`--json` prints `{role, kind, args, sha256, path}` instead.

**D2. Where the text lives.** Two layers, no third:

- The agent body (`plugin/agents/<role>.agent.md`) carries everything that
  never varies: duty lists, the instrument re-check, the test-verdict rule,
  the halt-cause block, the claim discipline, the `edit`/`read` absolute-path
  rule, the kill rule, the stash prohibition. New definition:
  `plugin/agents/fleet-fix-applier.agent.md`, used for every fix-applier
  kind (review, conflict, dispositions retry). `ledger.mjs dispatch` prints
  it as `agent` for all three, retiring the `null` and the
  `fleet-implementer-slow-high` special case for conflict holds.
- The brief template (`plugin/skills/run-team/briefs/<role>.md`) carries
  only the lines that vary or are per-dispatch: the identity line with
  `<abs-path>`, `<branch>`, `<scratch>` partition, the distilled brief, the
  `<testCmd>` string, the review-file path, the pin SHA, the report path and
  the three lines **Rules that fail silently** says every dispatch carries
  (report is a message; reports are not acknowledged; the suite runs in the
  foreground), the exit-75 line, and the `staleness.mjs` could-not-check
  note when the Pull got one.

SKILL.md keeps, per role, one paragraph: when to dispatch, the render
command, and what the controller does with the result. Every `>` block in
the Reviewers and finisher sections is deleted in the same change.

**D3. The dispatch records the brief.** The renderer writes the brief to
`<fleet-dir>/briefs/<member>.md` and its sidecar `<member>.json` (D1's
`--json` payload) when given `--member <name>`. `ledger.mjs dispatch <key>
<member>` reads the sidecar, refuses (exit 2, nothing written) when it is
missing or its `role` does not match the member's family, and appends
`brief=<sha256 first 8>` to the `## Dispatched` entry. The controller passes
the file's content as the `task` prompt. The gate covers the four ledger
families (`impl`, `fix-pr`, `finisher-pr`, `merge-bot`), that is the
implementer, fix-applier, finisher and merge-bot roles. `review-runner` and
`recipe-deriver` are not ledger-dispatch families (`ledger.mjs review`
records a review runner; the recipe-deriver has no family), so their briefs
are rendered by D1 but not gated, and D6's golden tests are their only check.
`ledger.mjs rotate` archives the `briefs/` directory beside the ledger.

**D4. Duty scripts.** Member duties that are a fixed command sequence become
scripts under `plugin/scripts/`, each printing one JSON receipt and using
exit codes the body reads:

- `finisher-label.mjs --pr <M> --pin <sha>`: reads labels; zero or more than
  one of `patch`/`minor`/`major` → exit 3 naming what it found, nothing
  written (a repo whose `gh label list` defines none of the three skips the
  count); posts `ready-to-merge-head: <pin>`; adds `ready-to-merge`; reads
  labels back; exit 0 only when the read-back carries the label, else exit 4
  with both reads. The finisher body's duty 3 is "run this; its exit code is
  your verdict".
- `finisher-audit.mjs --worktree <abs> --pin <sha>`: wraps
  `worktree-audit.sh` row lookup by `realpath`, the dirty check, the
  head-equality check and the reflog cause derivation, and prints
  `{cause: null | live-editor | rebase | past-pin | unreadable | missing |
  absent | other, evidence}`. The halt-cause block becomes this script's
  header comment.

Further duty scripts are named by their own tickets; this spec ships these
two because #2331 and the halt-cause block are the measured cases.

**D5. One owner per fact.** The fix-applier's CI wait has one owner: the
controller. `review-and-fix.md` step 4 stays the statement; the fix-applier
body says "push, write your report, exit; never poll a CI run" and nothing
else about CI; the DUTY template #2884 cites is deleted. The pattern
generalises: a rule stated in two member-facing files is a defect, and the
golden suite's coverage test fails on a sentence that appears verbatim in
more than one of agent body, brief template and command doc.

**D6. Tests retarget to rendered output.** `dispatch-block-golden-prose.test.mjs`
renders each role with a fixed argument set and compares the output to a
golden fixture owned by the test. `dispatch-block-pins-prose`,
`member-prompt-prose`, `stash-prohibition-prose` and
`fix-applier-correction-rules-prose` pin fragments against the same rendered
output. A new test renders every role with every required argument omitted
in turn and asserts exit 2 naming the argument. A new test pins that the
agent bodies of `fleet-finisher`, `fleet-merge-bot` and `fleet-fix-applier`
are no longer one line.

**D7. Instruments.** `briefs/` templates sit under `plugin/skills/`, which
`instruments.sh` already covers. The renderer runs the instrument re-check
before rendering and refuses on exit 1 or 2, so a brief is never rendered
from a modified template.

## Out of Scope

- Changing what any duty says. Every sentence moves; none is rewritten
  except the two #2884 names as contradictory.
- The report format and the report path's contents (spec 2).
- The implementer bodies beyond moving their three placeholder blocks into
  `briefs/implementer.md`.
- Member tier for `fleet-fix-applier`: ships at `@slow:high`, the tier the
  conflict fix-applier ran at; a cell for it is a router question.

## Open Questions

- Whether `ledger.mjs dispatch` should also refuse a brief older than N
  minutes, so a brief rendered before a head moved is not dispatched against
  the new head. Lean: no; the pin SHA is an argument, and a stale pin is
  the finisher's `past-pin` halt.
