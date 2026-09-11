# Stray-Skip Predicate Extraction

A worktree registry entry is classified as a droppable operator stray by one
conditional. **That conditional exists twice, byte-identically**, in
`plugin/scripts/inflight.sh` and `plugin/scripts/release-ticket.sh`:

```sh
if contents=$(ls -A "$entry" 2>/dev/null) && [ -z "$contents" ]; then continue; fi
```

Be precise about what is duplicated, because a reader grepping the wrong term
will conclude this record is wrong: the **conditional** is the shared thing. The
enclosing `count_registry()` *function* now exists in **both** scripts.
`release-ticket.sh` gained its own copy when #694 landed, for the same reason
`inflight.sh`'s own comment already gave — *"A function because the count is
taken twice — see the recount below."* Before #694, `release-ticket.sh` had no
recount and the same loop sat inline under an `if … fi`; needing no function
was a **consequence** of that divergence, not the divergence itself.

Closing #694 made the shapes converge on their own, exactly as this record
predicted: both scripts now count the registry from a named `count_registry()`,
called once up front and again on recount.

The justifying comments above the two copies are near-copies but not identical
either — each names the consequence for its own script.

Proposals to extract this conditional into a named predicate function —
`is_droppable_stray "$entry"` — so the invariant is "independently
re-verifiable as a unit" are refused. The check stays inline in both loops.

## Why this is out of scope

**The premise was measured and is false.** The request rests on one claim: that a
future reformat — splitting the assignment onto its own line, losing the `set -e`
exemption that makes `ls`'s *status* load-bearing — "would silently reintroduce
the pre-#697 bug this PR just fixed, **without any test change flagging why**."
That was tested directly rather than assumed. Applying exactly that reformat:

```sh
contents=$(ls -A "$entry" 2>/dev/null)
if [ -z "$contents" ]; then continue; fi
```

turns `inflight.test.mjs`'s *"probe 3: an entry git cannot fully read is unknown,
not a stray to skip (#697)"* **red**, on the first of its two EACCES shapes:

```
mode 0o000: an entry we could not read is unknown, never the exit 0 that means free
0 !== 2
```

Green before, red after, green again on restore. The failure is not a bare
assertion count — the message names the wrong answer (`exit 0` meaning free) and
the test title names the ticket. A reader who breaks this line is told what they
broke and which defect it is. "Silently, with nothing flagging why" is the one
thing that cannot happen here.

**Extraction in one copy reopens a divergence that was deliberately closed.**
This is the strongest argument against the request and the issue does not
mention it. The two copies of this check are byte-identical on purpose, and
converging them was the *point* of the change that introduced the current form.
`inflight.sh`'s own comment records it:

> That copy's skip reading only `ls`'s output, not its exit STATUS, was the last
> divergence — this change closes it (#697): both copies' skip now reads the exit
> status.

The same comment tracks the drift history in detail: three of four items landed
in one copy first and were ported to the other by #395, with the recount still
open against it under #694. So these two copies have a documented record of
diverging and being re-converged item by item.

A predicate extracted into one script therefore does not merely refactor — it
re-splits a pair whose byte-identity is the invariant. Any serious version of
this request has to land in **both** scripts simultaneously, or into a shared
module that does not exist and that neither script currently sources for this.
That is a materially larger change than the one filed, and it is proposed for
zero behaviour change against a hazard the tests already catch.

**The cheaper answer the KB prescribes already shipped.**
[blockers-accessor-extraction.md](blockers-accessor-extraction.md) refuses the
neighbouring request with: if a non-obvious contract is at risk of being
forgotten, *"the fix is to pin it — not to reshape call sites."* Here the pin
landed first. PR #1281 added the regression test in the same change that fixed
the bug, and the issue acknowledges it while still asking for the refactor. The
protection being requested is the protection already in the tree.

**The rationale is denser than a function name.** `inflight.sh:613-638` carries
twenty-six lines of comment on this one conditional: why emptiness and not a
missing `gitdir` (git drops a `gitdir`-less entry, so keying the skip there waves
a corrupt entry through as "not git's" and the ticket reads free while its
checkout is on disk — measured `rc 0, taken=false`); why `ls`'s status and not
its output (0o000 unsearchable and 0o111 searchable-but-unreadable both print
exactly what an empty stray prints); why no `-x` test (it covers only the 000
half, and a failed `ls` settles both). A predicate named `is_droppable_stray`
carries none of that. Extraction moves the prose away from the loop it
constrains, and the name would restate the *weakest* part of it — the three
measured wrong answers are what the block is for.

**Refactor-only, by the filer's own account.** The finding was raised in review of
PR #1281 as finding 3, labeled by the specialist "Optional, not required for this
PR" and confirmed **not a live bug today**. Trading a re-derived guard for a
readability preference on a behaviour-neutral change is the trade refused in
[arg-factory-collapse.md](arg-factory-collapse.md) and
[cli-guard-test-consolidation.md](cli-guard-test-consolidation.md).

**This is not a refusal on feasibility.** The extraction is easy and would very
likely stay green. It is a refusal on churn against a hazard that is already
instrumented.

Worth knowing if this is ever reopened, because it cuts *against* this record and
is the strongest form of the original instinct: the `set -e` exemption is not the
only thing holding that line up. `count_registry` is invoked as `count_registry ||
return 1`, and a function called on the left of `||` runs with `set -e` suppressed
throughout its body — so the inline-assignment exemption is not actually what
saves it. That makes the mechanism *more* subtle than the issue claims, not less.
It remains an argument for a comment, and the comment is there.

## What would reopen this

A measured defect traced to this conditional — an entry misclassified as a stray,
or as registered, in a shape the #697 test does not reach. Or removal of that
test, which is the thing making the current inline form safe: if the pin goes, the
extraction argument becomes live again and this record should be re-read rather
than re-derived. Note also that the test self-skips as root (`EUID0`,
`inflight.test.mjs:105`) — CI runs `ubuntu-latest` uncontainerised so it executes
there, but a future move to a root container would silently remove the guard this
refusal depends on, and that would reopen it too. An argument from readability
alone has been made and answered.

**A proposal against either copy lands here.** This record covers the check in
both `plugin/scripts/inflight.sh` and `plugin/scripts/release-ticket.sh`; a
request phrased against one script is the same request. A proposal that extracts
into a **shared module sourced by both**, keeping them byte-identical by
construction rather than by convention, is the one form not answered above — it
addresses the divergence argument instead of ignoring it, and would deserve a
fresh ruling rather than a pointer here.

## Prior requests

- #1283 — "inflight.sh: count_registry()'s droppable-stray invariant rides one dense conditional, not a named predicate" (deferred from PR #1281 review, finding 3, `Optional, not required for this PR`)
