# Instruments: why they are re-checked

Evidence for the rule SKILL.md states in **Re-check the instruments before a gate**, keyed by the rule it justifies.

## Re-check your instruments before every gate decision

**You read your instruments out of a tree every member can write to — re-check
them before every gate decision.** Per-member worktrees and `./agent-test`'s port
derivation protect members from each other; neither protects the main checkout,
which you run every gate probe out of and which any member can edit — except
through a `write`/`edit`/`ast_edit` the `member-write-guard` extension refuses;
a `bash` or `eval` write still lands. Measured: a
member edited two files there instead of in its worktree while the CI monitor was
polling one of them every 120s and a live finisher was using it to decide a
label. It caught itself; nothing in the fleet would have. That is the silent
direction — a modified instrument raises no error, shows in no PR and leaves
nothing in the ledger, and it still returns a verdict, just not necessarily the
right one, so you have no reason to re-check a script you did not know had
changed.

**A label gate and a CI verdict are also taken by dispatched members, not
only by you** — the finisher labels, and the merge bot merges on its own
reading — and neither is dispatched to read SKILL.md, so neither can be
reached by stating the rule there. Each carries its own copy: the finisher's
in the instrument re-check block of `agents/fleet-finisher.agent.md`, the merge bot's inside
`merge-gate.mjs`, step 3 of `run-merge-bot.md`.

## What the instrument set covers

It covers every tracked file under this repo's own plugin component directories
— `plugin/commands/`, `plugin/scripts/`, `plugin/skills/`, `plugin/agents/`,
`plugin/workflows/` — the probes, the libraries they source, and these runbooks,
which you also read from that tree. Not the whole repo: `docs/metrics/` is
appended by THIS run, so covering it would refuse on the run's own bookkeeping
every time. It does not cover refs, deliberately: `claim-ticket.sh` creates a
branch per ticket and `reap.sh` deletes them in the ref store every worktree
shares, so ordinary work moves refs several times a run and a per-gate
refusal on that is noise.

## Re-pin first after a mid-run tooling fix

You just changed the instrument set under your own check, and this is the
only edit that legitimately does; skip it and the next gate refuses on your own
fix, which teaches you to ignore the refusal.

## Triggers and shape of a mid-run tooling fix

Fix on an identical failure twice, or on a member doing the wrong thing while
following the text; prefer moving text to adding it, and cut before you append.

## Landing a mid-run tooling fix from the main checkout

**Re-pin first** — `~/.fleet/bin/fleet-run instruments.sh
--pin`. Then the ledger line, save the
rationale, one line to the maintainer. **Then land it from the main checkout,
if the fix was edited in it** — until you do, the next tick reads
`MAIN-CHECKOUT-DIRTY` naming your own paths. Commit the fix on a branch and
switch back to `main` before the next tick, and never `--record` while on that
branch: the switch back restores the tree the baseline recorded, so the hold
clears itself with nothing re-recorded, and the fix leaves the checkout until
its PR merges. A `HEAD …` entry is none of your paths and clears the same way.
Re-baseline only a fix you leave edited in the checkout: run
`~/.fleet/bin/fleet-run main-checkout.mjs --check` first, and only when the
paths it names are exactly the ones you just edited, run `--record` — never
before the commit, because the switch back would then read your own paths
dirty again. Any other path on that line is a stray write — leave the hold for
the maintainer, because `--record` would certify it with yours. Live members
hold the old text — re-brief only if it changes what they do *now*.

## A pinned tree whose HEAD moved is the maintainer's to settle

`instruments.sh --pin` records the pinned tree's HEAD as `commit=<sha>` after
the digest and `root=`, and an exit-1 refusal prints that pin commit and how
HEAD relates to it: `advanced` (the pin commit is an ancestor of HEAD, with the
commits between, at most 20 and then `… N more`), `rewound`, `diverged`, or
`unmoved` (HEAD is the pin commit, so the porcelain lines name the edits). A
baseline with no `commit=` line, or one whose commit is gone from the
repository, prints one line saying so and no relation.

**The measured case.** Another session fast-forwarded the main checkout to
`origin/main` mid-run. The commits that brought in were only this run's own
merged PRs, the controller counted them as its own, re-pinned without asking and
dispatched the next finishers. The tick could not see the move: its
main-checkout guard reads a fast-forward to `origin/main` as clean, and the tick
never runs the instrument check. Only the gate re-checks saw it — a finisher
halting with cause `other`, the merge gate refusing with
`instrument-set-changed`. A refusal cannot tell a move the maintainer would
adopt from one they would not, because only they know whether a session of
theirs is working in that checkout, so the pin stays frozen and the move stays
a refusal even when the commits between are only the run's own.

**Why the reset is the controller's only on a clean tick.** A clean
main-checkout reading means HEAD is still on `main` and every commit since the
baseline is on `origin/main`. So `git reset --keep <pin commit>` moves no other
branch and drops nothing that exists only locally, and `--keep` refuses rather
than overwrite an uncommitted edit that conflicts with the move. On a switched
branch the guard prints `MAIN-CHECKOUT-DIRTY HEAD …`, and a reset there would
move that other branch, so the maintainer restores such a tree by hand.

Measured in a temp clone with the real `main-checkout.mjs` and
`instruments.sh`, the pin 3 commits behind `origin/main` and 4 set paths
different:

| Checkout state | Main-checkout guard | Instrument check |
|---|---|---|
| at the pin commit | clean | 0 |
| fast-forwarded to `origin/main` | clean | 1 |
| after `git reset --keep <pin commit>` | clean | 0 |
| on another branch | `MAIN-CHECKOUT-DIRTY HEAD refs/heads/main@… → refs/heads/other@…` | 1 |

