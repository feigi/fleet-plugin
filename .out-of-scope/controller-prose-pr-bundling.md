# Bundling in Controller-Authored Rule-Prose PRs

A PR the fleet controller authors for its own rule prose (`run-team/SKILL.md` and
its siblings) may carry more than one independent rule change, and it needs no
ticket or `Closes #`. Proposals for a standing rule of one change and one ticket
per controller prose PR are refused. There is no branch-naming requirement for
these PRs either.

What *is* a rule, and stays one: **data rows and rule-doc prose never share a
PR.** That half of the question was settled by #944 / PR #1434, and it lives in
`plugin/skills/run-team/SKILL.md` (the "Data rows and rule-doc prose never share a
PR" paragraph in phase 3's close-out) and is pinned by
`plugin/scripts/run-artifact-pr-prose.test.mjs`. Nothing here loosens it.

## Why this is out of scope

**The cost the rule would prevent is the one #1434 already priced as low.** The
data/prose split exists because the two halves strand differently: a stranded data
row is lost (the tier guard re-derives its floor from the undercount, and
`member-outcomes.tsv` is regenerated from harness transcripts this repo does not
own), while, in the skill's words, "Stranding a rule change costs the status quo,
which is where it already was." Two prose changes bundled together fail the same
way one does. If the bundle stalls, both stay unshipped, and that is the status
quo for each of them. Nothing is lost that has to be re-derived.

**Revertability is the argument for splitting, and prose doesn't need it.** The
original finding (PR #465 review) was that "none can be reverted without the
others." A rule paragraph is withdrawn by a forward edit that deletes or rewrites
it, not by `git revert` of the merge that introduced it. The fleet already works
this way: its self-correction section edits the prompt mid-run when a defect earns
it. A bundled merge doesn't block that edit.

**Ticketless controller PRs are already a sanctioned shape, and they still get
reviewed.** `run-team/SKILL.md` accommodates a chore PR the run authors that
"closes nothing and is left unlabelled for the maintainer," and phase 0 folds any
such PR a prior run left open into the next run's review queue as ticket work.
That is the safety net a required ticket would provide. Requiring a ticket would
add one issue per controller doc edit and get no extra review in return.

**The bundle in the measured instance was visible without a naming rule.** PR
#465's branch, `docs/run-team-finisher-outbox-rule`, named one of its changes.
But the body's "What lands" section listed all of them, and that's where the
reviewer found the bundle. The PR body is where a reviewer reads scope. A branch
name that has to list every change would get long, or just as lossy.

**The expensive shape hasn't recurred since the split rule landed.** From
2026-09-11 (PR #1434) to 2026-09-24, every `chore/run-artifacts-<date>` PR carried
exactly the two `docs/metrics/` files: #1473, #1481, #1485, #1489, #1500, #1507
and #1515.

## What would reopen it

A concrete incident where bundling cost something the status quo doesn't. For
example, a prose rule that shipped wrong could only be backed out by also backing
out an unrelated sibling rule, or a stalled bundle held back a rule change that a
live failure needed. Argue from that incident. The consistency argument alone is
what this entry refuses.

## Prior requests

- #473: "Fleet policy PRs ship bundled: three unrelated run-team rule changes behind one branch and no ticket"
