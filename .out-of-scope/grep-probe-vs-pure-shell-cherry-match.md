# Replacing the Grep Probe With a Pure-Shell Matcher

`reap.sh`'s cherry-merged-commit checks ask one question — *does `git cherry`'s output hold
a line starting with `+`?* — by piping that output through `grep -q '^+'` inside
`grep_probe()`, which reports the scan's own exit status separately from its answer.
Proposals to replace the external scan at those call sites with a POSIX pattern match
(`case "$cherry" in ...`), eliminating the failure mode instead of reporting it, are
refused. Probe-and-report stays.

## Why this is out of scope

The alternative is a legitimate design and arguably the stronger one in isolation: a shell
pattern match cannot fail, so there is no scan-failure status to swallow, and #1419's bug
becomes unreachable at those sites rather than handled. That is not what settles it.

**It trades instrumented coverage for an absent hazard.** #1419 existed because a failed
`grep` was indistinguishable from a `grep` that found nothing, and a scan failure therefore
read as "not merged" — the direction that deletes a branch. Five fixtures shipped with the
fix, and two of them instrument that hazard *at the cherry sites specifically*: `cherry rc
2 should not delete branch/worktree`. Adopt the pure-shell matcher and those two fixtures
no longer test anything, because there is no longer a failure mode at that call site to
test. A third, the registry fixture, shares the pattern and needs rewriting too. So the
change requires rewriting 3 of 5 tests that instrument the defect it must preserve.

This repo has refused that exact trade before. From
`.out-of-scope/stray-skip-predicate-extraction.md`: *a feature-level extraction is refused
when tests already instrument the hazard, because the extraction trades an instrumented
guard for a reshaped path.* And from `.out-of-scope/review-pr-micro-refactors.md`, on the
general bar: *ten lines net, against rewriting the three assertions in `arg.test.mjs` that
pin the import — the pins are the asset here; ten lines are not.*

**The helper survives either way.** The registry re-read is a third `grep_probe` caller and
is not a cherry check, so the helper, its machinery and its comment stay in the file
whatever happens at the two cherry sites. Removing two of three callers does not retire it;
it leaves a helper justified by one use, which is a worse shape than the one being
replaced.

**The choice was deliberate, and nothing has measured it wrong.** PR #1519 shipped
probe-and-report knowingly. No defect in it has been observed since — the review finding
that produced this ticket was a `simplify` suggestion, not a failure report. Re-deciding a
shipped design on preference, at the cost of the tests that prove the old defect gone, is
the trade this record refuses.

## Not covered by this refusal

The helper's own shape. `grep_probe()` used to copy the fd-dup-plus-separator splice
from `git_probe()`, which needs it for three return values; the grep probe discarded
stdout and needed only two, and a command substitution already carries an exit status.
Simplifying that was #1544, now implemented (in the PR that shipped this doc update):
`grep_probe()` captures only `$gq_err` via command substitution and reports its own
exit status directly, with no fd-dup or `$gp_sep` splice left in it. That simplification
was and remains *orthogonal* to this record: it kept probe-and-report and kept all five
fixtures passing unchanged. Refusing the design change here was never a refusal to touch
the helper.

## What would reopen this

A measured defect in the probe-and-report approach at the cherry sites — a real run where
the reported scan status was wrong or the reporting itself caused a bad outcome. At that
point the pure-shell matcher is the obvious remedy and the fixture rewrites are paid for by
a failure rather than by preference.

## Prior requests

- #1545 — "reap.sh cherry checks: consider a pure-shell + line matcher instead of grep_probe (alternative to #1419's fix shape)" (deferred from PR #1519 review, `simplify` dimension)
