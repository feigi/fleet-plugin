# 0022 — Fix-applier dispositions get a code carrier

**Status:** Accepted. Ruled 2026-10-02 on #2244 by the maintainer, from a
grilling session. The rulings were filed as #2341 (this ADR) and its
implementation tickets #2342–#2346. Amended by #2404 (ruled 2026-10-04 by
the maintainer, from a grilling session): Decision 5's table gains a row — a
`survived` finding out of scope goes open, `ready-for-agent`, whatever reason
its entry gives; the `false-rationale` row holds in-scope survivors only. A
`critical` or `important` survivor on that row does not escalate: filing it
`ready-for-agent` is the whole obligation, since the defect predates the PR.
The `claimKind: shape` row outranks every survivor row, the new one
included. A deferral no row holds is a mismatch naming no filing-table row,
so a gap in the table surfaces as a retry and then an escalation (Decision
9), never as a pass. An open issue labelled `ready-for-agent` also answers a
`needs-triage` row; a weaker label never answers a `ready-for-agent` row. The
body below stands as ruled: read Decision 5's table with that row added, and
the gap the Consequences section records for #2404 as closed by this
amendment. Amended by #2886: a verdict token names the review run, not the
review head — `dispositions-<verdict>=fix-pr-<M>[-x]:<run>`, `<run>` being the
`run-XXXXXXXX` the latest `reviewed=<head>:<s>/<r>/<u>:<run>` names — so a
verdict answers only the review run it names, a re-review at the same head
included; read Decision 8's `<head>` and the Consequences entry for #2405's
`dispositions-*=fix-pr-<M>:<head>` as `<run>`.

## Context

A fix-applier makes three kinds of ruling on a review's findings: whether a
finding is applied or deferred, whether it is in the PR's scope, and where a
deferral is filed. `plugin/commands/review-and-fix.md` already states the
rules for all three:

- **Step 2** splits findings into apply-now and defer. An in-scope finding
  gets a refuter, and the fix-applier applies "only what survives". Every
  `suggestion` arrives with 0 refuters, so an in-scope one gets a refuter
  before anything else happens to it.
- **Step 5** files each deferral. The label follows the finding's state, and
  the bar is whether the **defect** is confirmed, not whether the remedy is
  settled (ADR 0001). A confirmed defect whose remedy is still open is filed
  `ready-for-agent`. A finding below the worth-a-claim bar (ADR 0002) goes to
  the closed `PR #<pr> review: the suggestion band, checked` record, under
  `Below the claim bar`, and is not filed as an open issue.

On PR #2223 the fix-applier broke both steps, and filed three issues saying
"deferred by fix-applier":

- **#2228.** A correctness finding, severity `important`, that **survived
  2/2 refuters**. It was a defect in the tick hold that #2223 itself added,
  so it was in scope. It was deferred anyway, and filed `needs-triage`
  instead of `ready-for-agent`. #2223 was labelled `ready-to-merge` with the
  defect in it, and triage later found that the defect halts supply against
  the production ledger.
- **#2226** and **#2227.** Two in-scope `suggestion`s that no refuter ever
  checked, filed open `needs-triage`. #2226's own body called it "likely
  already moot", and it was. #2227 was a one-line ADR amendment inside the
  PR's scope.

The instructions already said the right thing, so more wording would not
change the outcome. ADR 0017 Decision 3 covers this case: an obligation
that must not soften into advice gets a **code carrier**, a script whose
verdict is consumed as code and never relayed onward by someone reading
prose. This ADR picks that carrier for the fix-applier's dispositions.

## Decision

Each ruling below is listed with the alternative it rejected and the reason.

1. **What is carried.** The carrier enforces three obligations:
   - (a) an in-scope `survived` finding is applied, not deferred, unless one
     of Decision 4's reasons applies;
   - (b) a deferred finding's filed issue has the label and state that
     Decision 5's table gives for that finding's state;
   - (c) an in-scope `suggestion` gets a refuter before anything is filed.
     A refuted one, or one below the claim bar, goes to the closed
     suggestion-band record and never to an open issue.

2. **Input: a disposition record the fix-applier writes next to the review
   result file.** It has one entry per finding the fix-applier rules on, and
   each entry declares the finding's scope, its `claimKind`
   (`behavior|shape`), its disposition, its deferral reason and the issue it
   was filed to. A check script reads the record together with the review
   result file and the tracker.
   - *Rejected: reconstructing dispositions from the tracker.* Findings have
     no stable id, so matching a filed issue back to a finding would mean
     matching prose.
   - *Rejected: a `task` `outputSchema`.* It only exists while the
     controller passes it, so standalone `/review-and-fix` would not have
     it.

3. **Scope presumption.** The touched lines are those in
   `git diff <merge-base>...<review head>`.
   - A finding whose `file`+`line` is on a touched line is in scope. The
     record cannot override that.
   - A finding with no `line` is presumed in scope (fail closed).
   - For any other finding, the scope the fix-applier declared stands.
   - *Rejected: trusting the declared scope.* #2228 sat in code the PR
     itself added, and the fix-applier still treated it as deferrable.
   - *Rejected: an override that carries a reason.* It reopens the same
     escape hatch the presumption closes.

4. **Allowed reasons for deferring an in-scope survivor.** There are four,
   and nothing else is accepted:
   - `false-rationale`: the change is behavior-neutral and the finding's
     stated reason is false. This is the rule `review-and-fix.md` already
     has, that behavior-neutral plus a false rationale is a defer.
   - `mutual-exclusion`: the finding lost to another finding it cannot land
     alongside.
   - `remedy-worse`: the remedy would be worse than the finding. Requires an
     in-tree note.
   - `remedy-outside-diff`: a file the remedy names is not in the PR's diff.
     This follows step 2's limit that applying a finding "never licenses
     editing a file the ticket has no business in". Since scope is now
     defined by touched lines, that limit is about where the **remedy**
     goes, not where the finding sits. A `critical` or `important`
     survivor deferred for this reason escalates to a human.

   Rejected alternatives:
   - *Rejected: a free-text reason.* It is prose again, which is the thing
     being replaced.
   - *Rejected: no exceptions.* That contradicts the command's own rule that
     behavior-neutral plus a false rationale is a defer.
   - *Rejected: `outside-ticket-files` as a reason about where the finding
     sits.* Once scope is defined by touched lines, it describes nothing
     that can be true of an in-scope finding, so it would admit #2228's
     exact shape.

5. **Filing table.** A deferred finding's required home depends on its
   state:

   | Finding state | Required home |
   |---|---|
   | `survived`, deferred for an allowed reason other than `false-rationale` | open, `ready-for-agent` |
   | `survived`, deferred `false-rationale` | closed suggestion-band record |
   | `unverified`, `refutersDispatched > 0` (refuters crashed) | open, `needs-triage` |
   | in-scope `suggestion`, refuter refuted it | closed suggestion-band record (`wontfix`) |
   | in-scope `suggestion`, refuter let it survive | applied, or row 1 |
   | out-of-scope `suggestion` alleging wrong behavior | open, `needs-triage` |
   | `claimKind: shape` (below the claim bar) | closed suggestion-band record, under `Below the claim bar` |

   The table applies ADR 0001's label bar and ADR 0002's claim bar. It does
   not change either of them.

6. **`claimKind` is trusted.** The check does not judge whether a claim is
   really about shape. If a finding is wrongly marked `shape`, it lands on a
   closed record. `ledger.mjs check` still reads closed records, and a later
   review that finds the same thing promotes it. That failure is cheap.

7. **Evidence that a suggestion's refuter ran: one verdict file per in-scope
   suggestion**, in the refuter schema `{refuted, reason}`.
   - *Rejected: trusting the record.* The failure seen on #2226 and #2227
     was skipping the refuter, and a missing file catches that.
   - *Rejected: moving step 2's refuters into the review script.* That would
     redesign who owns the suggestion band, which is more than this fix
     needs.

8. **Gate: the state is read at dispatch.**
   - The check writes its verdict to the ledger as a self-describing token.
     The token names the fix-applier it checked and the review head its
     record answers: `dispositions-ok=fix-pr-<M>:<head>`, and likewise
     `dispositions-mismatch=`, `dispositions-escalate=` and
     `dispositions-unchecked=`.
   - `ledger.mjs dispatch <pr> finisher-pr-<M>` refuses, with a non-zero
     exit and the cause named, unless the PR's current verdict is `ok`.
   - The current verdict is chosen like this: among tokens whose head
     matches the latest `reviewed=<head>`, take the one from the
     fix-applier with the highest retry suffix. Position in the row text is
     never used, because a `row` rewrite can reorder tokens.
   - The gate applies to every PR whose latest `reviewed=` counts a
     survived or unverified finding. If no token matches, `dispatch`
     refuses it as `unchecked`.
   - The controller already runs that command before every finisher call,
     and dispatches with the agent definition it prints. So no
     `fleet-tick.mjs` row carries `acts: true` for this gate. Under ADR
     0017 a row acts only when the row itself is the thing acted on, and
     here the refusal has already fired upstream.

   Rejected alternatives:
   - *Rejected: a `fleet-tick.mjs` HOLD row.* The tick has no finisher
     role. Finishers are dispatched from the controller's CI-terminal and
     fix-applier-report edges, so a row in the tick would hold nothing.
   - *Rejected: a finisher role in the tick.* It would have to read CI
     state and duplicate the controller's edge logic.
   - *Rejected: a finisher halt cause.* It fires only after a finisher has
     already been spent, and it depends on a low-tier member reading an
     exit code.
   - *Rejected: picking "the verdict since the latest review" by text
     position.* That is unreliable once rows are rewritten.

9. **Mismatch.**
   - On a first mismatch, the PR goes back to `fixDue`, the same way a
     conflict hold does. The existing `reviewers` row then prints
     `DISPATCH fix-pr PR#<M>`, which leads to one automatic
     `fix-pr-<M>-b` carrying the violation list.
   - A second mismatch escalates: `dispatch` refuses, and the controller
     comments on the PR and flags it for a human.

10. **Tracker unreachable.** The verdict is `unchecked`, so `dispatch`
    refuses. This fails closed.

11. **Standalone `/review-and-fix`.** Step 6 requires the check to exit 0
    before `ready-to-merge` is applied. With no controller and no tick, the
    exit code is the carrier.

12. **A new ADR, not a Status amendment.** ADR 0017 never mentions the
    fix-applier or deferral. Nothing in ADR 0001 or 0002 is made false: the
    carrier applies their rules and does not change them. Their Status
    lines, and ADR 0017's, stay as they are.

## Consequences

- This ADR chooses a mechanism and implements none of it. The work is
  tracked as:
  - #2342: the record, the scope presumption, the in-scope-survivor check
    and the dispatch refusal;
  - #2343: the filing table and the suggestion verdict files;
  - #2344: `remedy-outside-diff` and its escalation;
  - #2345: the mismatch retry and the escalation after it;
  - #2346: the standalone step-6 condition.
- Until #2342 lands, the #2228 shape still ships. That is a recorded gap,
  not one nobody noticed. No change to prose closes it in the meantime,
  which is the same position ADR 0017 records for the tier guard.
- Review of this ADR found two cases the ruling does not cover. They are
  gaps in the ruling, not in how it is recorded here, so no ruling is
  invented for them. Each waits on the maintainer:
  - #2404: Decision 5's table has no row for an out-of-scope `survived`
    finding. Row 1 needs one of Decision 4's reasons, which apply only to
    in-scope survivors, and row 6 covers only `suggestion`s. So obligation
    1(b) has nothing to check for that finding. Step 5 still files it today
    (a confirmed defect goes `ready-for-agent`), but the carrier does not
    enforce that.
  - #2405: Decision 8 does not cover the fallback reviewer. That member
    makes the fix-applier's rulings itself and records
    `reviewed=<head>:0/<refuted>/<deferred>`, so a deferral puts the PR
    under the gate. But no `dispositions-*=fix-pr-<M>:<head>` token can
    name that member, so as written its finisher is refused as `unchecked`
    on every attempt.
- #2226, #2227 and #2228 themselves are not re-opened here. Each was
  triaged separately.
- The prose that implementation adds to `review-and-fix.md` and the
  run-team skill follows ADR 0017: pins pin the record's content, its field
  names and the script's exit contract, never the modality of the sentences
  around them.
