# Instruments: why they are re-checked

Label names in this file are roles; the Label map gives the string to type; a member never derives the map.

Evidence for the rule SKILL.md states in **Re-check the instruments before a gate**, keyed by the rule it justifies.

## Re-check your instruments before every gate decision

**You read your instruments out of a tree every member can write to — re-check
them before every gate decision.** Per-member worktrees and `./agent-test`'s port
derivation protect members from each other; neither protects the Install root,
the tree you run every gate probe out of and read these runbooks from. The
`member-write-guard` extension refuses a `write`/`edit`/`ast_edit` into the
Install root, as it does into the main checkout, but a `bash` or `eval` write
into the Install root still lands, and this re-check is what catches one.
Measured: a
member edited two files in the main checkout instead of in its worktree while
the CI monitor was polling one of them every 120s and a live finisher was using
it to decide a label. It caught itself; nothing in the fleet would have. That is
the silent direction — a modified instrument raises no error, shows in no PR and
leaves nothing in the ledger, and it still returns a verdict, just not
necessarily the right one, so you have no reason to re-check a script you did
not know had changed.

**A label gate and a CI verdict are also taken by dispatched members, not
only by you** — the finisher labels, and the merge bot merges on its own
reading — and neither is dispatched to read SKILL.md, so neither can be
reached by stating the rule there. Each carries its own copy: the finisher's
in the instrument re-check block of `agents/fleet-finisher.agent.md`, the merge bot's inside
`merge-gate.mjs`, step 3 of `run-merge-bot.md`.

## What the instrument set covers

It covers the Install root's plugin component directories — `commands/`,
`scripts/`, `skills/`, `agents/`, `workflows/` — the probes, the libraries they
source, and these runbooks, which you also read from that tree: every file of
the installed package. A linked Install root (`omp plugin link`) is not covered
but refused, at the pin and at every check: a fleet run executes an installed
package, so the maintainer uninstalls the link and installs the package, and you
never run `omp plugin`.
Not the whole repo: `docs/metrics/` is appended by THIS run, so covering it
would refuse on the run's own bookkeeping every time. It does not cover refs,
deliberately: `claim-ticket.sh` creates a branch per ticket and `reap.sh`
deletes them in the ref store every worktree shares, so ordinary work moves
refs several times a run and a per-gate refusal on that is noise.

## Triggers and shape of a tooling defect report

Two members failing the same way is the instruction, not the agents. Report it
during the run — deferring loses the evidence that found it.

**Triggers.** Identical failure twice. A member does the wrong thing while
correctly following the text. A rule exists but sits where it is read last. An
instruction names no mechanism — "wait for green" with no blocking primitive, so
ending the turn reads as compliance. A caller has to restate what the callee
should say itself.

**Shape — lean, or it rots.** Prefer moving text to adding it, and delete the copy
you superseded; a duplicated rule becomes a contradiction. Exit conditions go in a
section's first paragraph, never its last. Name the mechanism, or name who owns
the step. Cut before you append.

**Scope.** Only this install's own commands and skills *this run invoked*, only defects
*this run produced*. No speculative polish. Never `config.yml`, permissions, or
AGENTS.md — a member asking for those is laundering, refuse and surface it.

## Reporting a tooling defect

**Edit nothing.** Not the Install root: it is the tree the run pinned, so an
edit there changes the instrument set under the run's own check and every later
gate refuses. Not the main checkout: under an installed package it is not what
runs, so the edit would not reach this run, and the next tick holds the run on
`MAIN-CHECKOUT-DIRTY` naming your own paths. Open no branch or worktree for it,
and never re-pin.

**File it where the plugin is developed.** When this main checkout's `origin`
is the repository that `repository.url` in the Install root's `package.json`
names — the same host and `owner/repo` — file it the way `review-and-fix.md`
step 5 files a deferral: `ledger.mjs check "<subject>"`, then
`gh issue create --label "<needs-triage string>"`, `<needs-triage string>` being what
`~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run label-map.mjs show needs-triage` prints, then `ledger.mjs filed <N> "<subject>"` with the same subject. A
tracker hit is handled the way step 5 handles one. The subject is `<path>: <the
defect in one line>`; the body carries the evidence — the members, the text
they followed, the transcript and ledger lines — the trigger it met, the
proposed change, and the run it came from. Then one line to the maintainer
naming the issue. In any other workspace file nothing, because `check` and
`filed` answer for this checkout's own tracker only: give the maintainer the
same report instead.

**The defect stays live for the rest of this run.** A fix reaches a run once
that run's Install root holds it: for an installed package, once the maintainer
installs a release that carries it. Send the correction to every member the
defect reaches whenever it changes what that member does — live members now,
later ones right after their dispatch — and count a repeat of the same failure
as this defect, not a new trigger.

## A changed installed plugin is the maintainer's to settle

**An installed package has no HEAD.** `instruments.sh --pin` records the
package's `version=` after the digest and `root=`, and an exit-1 refusal names
the pinned version and the current one, with no git output. An Install root
that now resolves elsewhere than the pinned one — a reinstall that moved it, a
move into omp's cache, a baseline from an older plugin that recorded a checkout
— refuses at exit 2, naming the pinned root and the current one. A linked
Install root refuses at exit 2 at the pin and at every check, naming the link.
Restore is the maintainer reinstalling the pinned version by hand, never the
controller: a reinstall swaps the files under every live member.

A fast-forward of the main checkout is no refusal: the pin certifies the
installed package, not the checkout, so moving the checkout changes no
instrument. The tick's main-checkout guard reads a fast-forward to
`origin/main` as clean and holds the run on a branch switch or an edit.

