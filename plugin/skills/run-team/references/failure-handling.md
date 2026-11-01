# Failure handling: the evidence behind its rules

Evidence for the rules SKILL.md states in **Failure handling**, keyed by the rule each justifies.

## A frozen transcript does not establish that a member is dead

**A frozen transcript does not establish that a member is dead — the
discriminator is its scratch dir.** A member wedged on a blocked tool call
emits the whole signature of a dead one: record counts unchanged from one poll
of its transcript to the next. So read the mtimes of the files anywhere under
the scratch directory its own dispatch prompt assigned it, subdirectories
included — `<scratch>/impl-<N>/` for an implementer, that member's own
run-scoped subdirectory under `<scratch>/pr<N>/` on the review side, never
the bare `pr<N>/` tree those siblings share — since a member waiting on a
child it dispatched writes nothing itself while that child writes below it.
Read them at two observations a poll apart — `touch` a marker file outside
that directory at the first, and
`find <dir> -type f -newer <marker>` at the second lists every file that
moved: **mtimes that moved between the two mean BLOCKED, a live member
still holding its claim and its worktree, so the killed row of SKILL.md's Failure handling table does not
apply to it; mtimes unchanged at both are the dead signature.** Only the first
of those two verdicts is conclusive — a member wedged on a call that writes
nothing freezes its scratch dir too — so settle the dead one on the Member unaccounted row of that table, never on the two listings alone. Measured once: a refuter
wedged forever on `until grep -q` for a marker `node --test` never writes, its
transcript's record counts unchanged across two polls while its own scratch
files carried fresh mtimes throughout — alive the entire time it read as dead.
The filenames are not a contract: they are whatever that member happens to be
writing, and they differ by member and by role. That second listing is cheap
at the price, because the cost of the wrong call is asymmetric — a live member
written off gets killed and re-dispatched, which discards the work in flight
and, where it holds a claim or a worktree, collides the fleet with itself,
while one poll spent on a member that had in fact stopped costs only the poll.
The refuter's own observation rule in the fix-applier body stops a
member from creating that state; this one stops you from misreading whoever
reaches it anyway, and neither replaces the other.

## Audit every worktree before dispatching replacements

Audit every worktree before dispatching replacements with
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run worktree-audit.sh` — it reports each worktree's
ahead-count and uncommitted files, the committed-vs-uncommitted distinction that
decides whether a replacement redoes or destroys work.

## A failed review, and verifying a reported SHA

**A throw, an empty return, or a notification whose status is not `completed`
is a failure event, not a clean review.** **Retry once
under the next runner letter, then stop:** the `review-pr-<pr#>` runner
already retried once inside its cell and reports `failed` with both errors, so
the retry is a second runner under the next letter the PR's rows do not carry
yet — `review-pr-<pr#>-b` after a first runner — recorded as
`review=member:<that name>`. A second failure is reported, and the PR stays at
review-due. A
runner member that is killed rather than failed follows **Failure
handling** (fresh name, inherited state stated).

**Verify every reported SHA.** `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run verify-sha.sh
<branch> <sha>` before enqueueing — a member can commit in a nested worktree,
leaving the SHA on a stray branch while its report reads normally. Exit codes as
`inflight.sh`: `# 0 reachable, 1 not reachable, 2 unanswerable`. Not reachable
(exit 1) → flag, do not enqueue, do not return the ticket to the shortlist until the
maintainer rules. **Exit 2 is not a verdict** — the question could not be
answered, and every cause of it reaches you as one shape: no JSON on stdout at
all, the cause on stderr alone. Read that stderr, fix what it names and re-run;
escalate if it repeats. Never read exit 2 as `not reachable`, and never record it
as a stray commit — the flag and the maintainer's ruling above are what exit 1
earns, and spending them on a probe that never answered costs a member its
ticket over a failure a re-run would have cleared.

## Never `--delete-branch`

**Never `--delete-branch` — the merge bot deletes the head branch itself.**
`gh pr merge <n> --merge` alone: the flag's local cleanup errors on a `main`
held by another worktree, or strands the feature worktree on `main`.

## Never force a rebase to start

**Never force a rebase to start.** No `git clean`, `git checkout .`,
`git reset --hard`, `git stash`. Uncommitted changes may exist nowhere else.
Non-empty `git status --porcelain -unormal` → stop and report — the explicit
mode, never bare `--porcelain`, or `status.showUntrackedFiles = no` reads an
empty answer here and licenses the rebase over work this check exists to
protect. Stashing empties it either way, so that check and
`no-undo-audit.sh` both go quiet on work nothing else holds.

