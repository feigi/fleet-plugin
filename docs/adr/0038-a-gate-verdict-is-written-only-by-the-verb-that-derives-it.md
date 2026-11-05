# 0038 — A Gate verdict is written only by the verb that derives it

**Status:** Accepted. Ruled 2026-11-05 on #4211 by the maintainer, from a grilling session. Amends ADR 0022 Decision 8 (see its Status line) and spec `2026-10-13-one-command-per-wake.md` D2 (amended in place). Related: #4359 (`review` takes `reviewed=` only from a result file), #4360 (`row` used as a lookup wipes member tokens).

## Context

On a scratch copy of a ledger holding PR #3724's escalated row, measured at `104bf035` before this change: `ledger.mjs token 3724 dispositions-ok=fix-pr-3724-z:run-B7CP3bIU` exits 0 and writes the verdict, `token … escalation-answer=run-B7CP3bIU:survived[0]:upheld` exits 0, and `row 3692 3724` exits 0 and drops every token of the row, a `reviewed=` and the escalate included. The dispositions gate and the tick read those tokens as the check's own.

Three facts made that open. `token` took `dispositions-*=…` and `escalation-answer=…` as freeform words. `row` refused only adding a review token; a changed or dropped verdict drew a `dropped:` warning. And `dispositions-check.mjs` wrote its verdict by rewriting the whole row through `ledger.mjs row`, after up to a minute of `gh` reads, so a token another writer put on the row in between was dropped. The writer policy, "the controller owns run state", was a comment nothing enforced, and fix-appliers run the check, and so write verdicts, by design.

## Decision

**Threat model.** Members may be goal-seeking: a session refused by a gate, or restoring state it lost, may write the token the gate reads. The controller is trusted to follow the tick and relay the maintainer's answers, though it can make mistakes. The rule is caller-agnostic and binds the controller too.

**The rule.** A **Gate verdict** is written only by the `ledger.mjs` verb that derives it from its evidence. The one input an argument supplies is the maintainer's Escalation answer, accepted only against an escalate the check raised. No verb takes a verdict token as an argument. The Gate verdicts are `dispositions-<ok|mismatch|escalate|unchecked>=…`, `escalation-answer=…` and `reviewed=…`. Not Gate verdicts: review launch tokens, tier-check's `tier-ok=`/`tier-mismatch=` (freeform), `ci=` (nothing reads it), `conflict-hold` (it only blocks) and settle outcomes.

**Mechanisms.**

1. `ledger.mjs dispositions <member> --scratch <dir> [--repo <path>] [--uphold <list>] [--send-back <list>]` is the only writer of a dispositions verdict and an escalation answer. It runs the check's judgement in-process (`dispositions-check.mjs` exports it) against the ledger it loaded, with every git, `gh` and file read before the lock; then it takes the lock, loads again, and writes onto the row that carries the member as it stands, keeping every other token. A verdict judged against a review that stopped being the latest meanwhile is still written and does nothing, since the gate and the tick read only verdicts naming the latest run. Its payload, stderr and exit statuses are the check's ledger mode, unchanged.
2. `dispositions-check.mjs` keeps only its standalone mode (`--no-ledger --review <path>`, or no ledger present). A ledger at the default path without `--no-ledger`, and any `--ledger`, `--uphold` or `--send-back`, exit 2 naming the verb.
3. `token` refuses any word beginning `dispositions-ok=`, `-mismatch=`, `-escalate=`, `-unchecked=` (any case) or `escalation-answer=`, parseable or not.
4. `row` carries Gate verdicts exactly: those in the row, in row order, must equal the rewrite's. A verdict-shaped word no grammar parses may be dropped, never added, so the tick's repair of a runless `reviewed=` and the cleanup of legacy head-named verdicts still work.
5. `ledger.mjs review <pr> --result <path>` is the only writer of `reviewed=` (#4359). It derives the token from the review result file, which must be `<scratch>/pr<pr>/<run>/<file>` with a run-root `<run>` and no `..` segment, whose `pr` is the PR's, and whose `head` and `counts` make a token the grammar parses; a token the PR's rows already carry is skipped. A `reviewed=` word among its arguments is refused, parseable or not. Review launch tokens stay arguments, and may come in the same call.

**No override flag.** Running the writer again is the only restore path. **Writer side only:** the tick's `currentDispositions` and the finisher gate read verdicts as before, with no check against `## Dispatched`; `fix-report`'s skip, taken when the member's own verdict is already on the PR's rows, stays, since a self-named verdict can now come only from the verb.

## Out of the model

- Direct edits of `.fleet/ledger.md`: the member write guard leaves `.fleet/` writable, as ignored run state.
- Forged check inputs: disposition records, refuter verdict files and review result files in scratch. That includes a member that settles itself with a bare `settle` and then passes `--uphold`/`--send-back`, since only a live fix-applier is refused.
- A controller inventing Escalation answers: the maintainer's answers reach the verb only as flags the controller types, and every AI session posts to GitHub as the maintainer's account.
- A controller skipping a review: `dispatch` lets a finisher through on a PR that was never reviewed.
- tier-check's verdicts, which stay freeform.

## Rejected alternatives

- **Careless sessions only, closed `wontfix`:** the realized hand-writes took the forgery's exact path.
- **A goal-seeking controller:** nothing exists that the controller cannot write to prove an answer or require a review.
- **Adversarial members:** that is process isolation, not a ledger fix.
- **A caller-identity guard:** the environment a member's shell sees (`PI_SESSION_FILE`, `PI_SESSION_ID`, `AGENT`, `OMPCODE`) is inherited and settable.
- **A reader-side check against `## Dispatched`:** it misses a fix-applier writing `ok` under its own name, which also makes `fix-report` skip the check.
- **An override flag.**

## Consequences

- `CONTEXT.md` gains **Gate verdict**.
- tier-check's unlocked read-then-`row` write of `tier-ok=` now refuses if a verdict landed in its window; re-running tier-check writes it. The verdict is no longer dropped.
- `.out-of-scope/gate-verdict-provenance.md` records the declined options and what would reopen them.
