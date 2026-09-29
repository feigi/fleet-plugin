# Instruments

## What it is for

Detecting — never preventing — a silent change to the scripts and
runbooks the controller's own gate decisions depend on. The controller
reads its instruments out of the main checkout, and any dispatched member
can write to that same checkout.

## How it works

[`instruments.sh`](../../plugin/scripts/instruments.sh) hashes the
content of every tracked file under the plugin's own component
directories (`plugin/commands/ plugin/scripts/ plugin/skills/
plugin/agents/ plugin/workflows/`) in the working directory's checkout
(or `--repo <path>` for a named worktree); `--pin` writes that digest to
`.fleet/instruments.sha`, and a bare run compares the live digest against
it. Exit 0 means unchanged; exit 1 means the tree changed under the pin
(the finding is named on stderr, with `git status` output for the
uncommitted half); exit 2 means the question couldn't be answered at all
(no baseline pinned, an unreadable baseline or tree). Only exit 0 lets a
gate proceed — exit 1 and 2 both refuse, because a guard that fails open
on "could not look" protects nothing. The controller pins once, at the
start of a run, from the main checkout, and re-checks before every gate
decision that acts on an instrument's own output: a SHA acceptance, a CI
verdict, a reap, a label gate. The [Finisher](finisher.md) and
[Merge bot](merge-bot.md) each carry their own copy of the re-check rule
in their own dispatch briefs, because neither is dispatched to read
[`plugin/skills/run-team/SKILL.md`](../../plugin/skills/run-team/SKILL.md)
itself.

## Opinionated choices

Tracked, content-hashed files only — deliberately not the whole repo, not
`git status`, and not file mode. `docs/metrics/` is appended by the
controller mid-run, so a whole-repo digest would fire the gate on the
run's own bookkeeping every single time, which is exactly the kind of
guard a controller learns to ignore. `git status` answers off the stat
cache, so a same-size, same-mtime content change would pass it silently;
hashing bytes instead accepts a bare `touch` and refuses a rewrite. Refs
are deliberately excluded even though a stray branch matters, because
`claim-ticket.sh` and [`reap.sh`](../../plugin/scripts/reap.sh) move refs
constantly as ordinary work — a per-gate ref check would be pure noise on
the one failure mode this instrument cannot afford.
