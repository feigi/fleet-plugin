# Fleet Plugin

The **fleet**: scripts, skills, commands and agents that run parallel agents against
a repo's issue tracker, packaged as a plugin and supported on two harnesses
indefinitely. This glossary covers the vocabulary those artefacts share; it is a
glossary only, not a spec.

## Language

### Harness

**Harness**:
The agent environment the fleet is loaded into — Claude Code or omp.sh. Both are
supported permanently and neither is primary. A fleet artefact that names one
harness's tools without the other's is harness-bound, which is a defect rather than
a variant.
_Avoid_: host, platform, client, runtime

### Platform

**Platform**:
The operating system the fleet's scripts run on — macOS, Linux, or Windows via WSL.
Native Windows is not a platform (ADR 0009). Independent of **Harness**: every
platform runs both harnesses. An artefact that works on only some platforms is a
defect, with the same standing as a harness-bound one.
_Avoid_: OS, host, environment

### Claim lifecycle

**Claim**:
A ticket taken by a fleet member, represented by three artefacts together — a branch, a
worktree, and the in-progress label on the issue.
_Avoid_: lock, reservation, assignment

**Release**:
Returning a claim so the ticket reads as free again: the worktree gone, the branch
deleted, the label dropped.
_Avoid_: unclaim, close, clean up

**Reap**:
Deleting branches whose upstream is gone, and their worktrees, after each merge pass.
Distinct from Release: a reap follows a merged PR, a release follows a claim that never
became one.
_Avoid_: prune, cleanup

**Registration**:
Git's record that a directory is a worktree of this repo. Independent of whether the
directory itself exists — either can outlive the other.
_Avoid_: entry, admin dir

**Orphaned worktree directory**:
A claim's directory still on disk with its registration already cleared. Invisible to
any check that reads git's registry.
_Avoid_: stray, leftover, ghost

**Stray**:
A registered worktree matching this claim's directory name but not on the claim's
branch. A registry-visible condition — never an Orphaned worktree directory, which by
definition has no registration to be seen through.

### Release outcome

The state of a claim's worktree after a release attempt. Named states, because the
distinction between the middle two is what an operator's next action turns on.

**Unreleased**:
Registration and directory both still present. Nothing landed.

**Deregistered**:
Registration cleared, directory still on disk. Something landed; the claim is
Partially released.

**Released**:
Registration and directory both gone.

**Indeterminate**:
The probe could not establish which state holds — typically an unsearchable parent
directory. Distinct from Unreleased: nothing is known, rather than nothing happened.
_Avoid_: unknown, failed

**Partially released**:
A release attempt in which at least one artefact was removed before a later step
refused. Reserved for that case — a run that refuses before removing anything is not
partially released, and neither is one that could not measure what it did.
_Avoid_: half-released, incomplete release

### Merge gate

**Merge gate**:
The repository **ruleset** on the default branch — its required contexts plus
strict currency — and never the CI that feeds it: CI produces signals, the gate
consumes them. Governed by ADR 0007, declared in `.github/rulesets/main.json`,
and applied only by `.github/scripts/apply-ruleset.sh`, which proves the write by
re-reading it. A claim about the gate sourced from anywhere else is unverified.
The spec is the **declared** gate and the live ruleset the **enforced** one, and
they diverge from the moment a spec change merges until someone with repository
admin applies it (#1710) — so a claim about what merging requires is a claim
about the declared gate unless `apply-ruleset.sh --check` has just exited 0.
_Avoid_: branch protection, protection rule, CI gate

**Currency**:
A branch whose merge-base with the base branch *is* the base tip. The property
`rebase-check` measures and `strict_required_status_checks_policy` enforces at the
merge button. Distinct from mergeability, which tolerates being behind.
_Avoid_: up to date, fresh, rebased

**Stale green**:
A required check that passed against an older base tip and still reads green.
Inert since ADR 0007 — the gate refuses the merge on currency directly, rather
than waiting for a workflow to flip the colour back.
_Avoid_: false green, cosmetic green

### Triage

**Review deferral**:
A ticket capturing a follow-up deferred from a prior PR review. Age carries no
signal about tree state; its premises must be verified against `origin/main`
before triage.
_Avoid_: deferred finding, follow-up

**Remedy-open**:
A defect whose existence is verified and whose fix is not yet chosen. The state
the filing-time label bar turns on.
_Avoid_: undecided, unclear

### Install

**Install root**:
The directory a harness actually loaded the plugin from, as recorded in its own
registry. Never the checkout, and never a path any artefact may write down: Claude
Code's is version- or commit-stamped and changes on every install, omp's is named
differently again.
_Avoid_: cache dir, plugin dir, install path

**Resolver**:
The shipped executable that maps a script name to the Install root and execs it there.
The single door between prose and code — a callsite naming any other path is a defect.
Placed once by hand outside the plugin, because it cannot resolve itself. Picks the
running harness from ambient environment signals, falling back to a byte-identical-`scripts/`
shortcut and then to a refusal naming both installs; `FLEET_HARNESS=claude` or
`FLEET_HARNESS=omp` overrides the pick outright when a callsite must be operable
under a genuine misdetection.
_Avoid_: shim, wrapper, launcher

**Provenance check**:
The assertion naming the live Install root, its recorded version or commit, the
Resolver's own drift against the installed copy, and the `enabledProviders`
precondition. Refuses loudly; writes nothing.
_Avoid_: doctor, healthcheck, preflight

**Dev catalog**:
The untracked marketplace outside the repo that pins a local branch of the working
checkout, so pre-merge iteration never edits the tracked catalog. Distinct from the
tracked catalog, which names the shipped branch and nothing else.
_Avoid_: local marketplace, dev source

**Install-time precondition**:
A harness setting the fleet depends on, set once by the operator at install and never
written by a run — a run that wrote one would be changing every other session on the
machine to dispatch its own members. Two exist, both on omp, both session-wide:
`enabledProviders: ["claude-plugins"]`, and `task.agentModelOverrides` carrying
the fleet's Tier routes (ADR 0011). ADR 0003 point 8 carries the first's required
value, its global and project-scoped set paths, and the read that verifies it;
`tier-roles.mjs --check` is the read that verifies the second.
_Avoid_: requirement, dependency, flag

### Coordination

**Dispatch**:
Starting a fleet member — a fresh agent under a new identity, never a resumed
one. The controller-to-member vocabulary fixed on #1316, true on both
harnesses.
_Avoid_: spawn, `Agent(...)`, `task`

**Send**:
Messaging a live member. The channel differs by harness — `SendMessage` to a
named agent on Claude, `hub send` on omp — but the neutral contract only ever
says Send.
_Avoid_: SendMessage, hub send

**Wake**:
A Send that resumes a finished member's transcript. Forbidden for a refill: a
finished member gets a new member under a new name, never a Wake back into
its old one.
_Avoid_: resume, re-task

**Settle**:
A member's job reaching a terminal outcome — `completed`/`failed`/`cancelled`
on omp, the corresponding terminal state on Claude. Distinct from the
member's liveness, which is a separate axis on omp (`running`/`idle`/
`parked`).
_Avoid_: complete, truncated

**Consume**:
The controller deliberately taking a settled result. The discipline holds on
both harnesses even though the hazard behind it does not: an unconsumed
Claude result is lost, an unconsumed omp result auto-delivers or is still
readable in a later `hub jobs`/`wait` snapshot.
_Avoid_: return value, retrieve

**Liveness mark**:
The RUN's liveness, not a member's — `beat` in the heartbeat's shared state
file, written only by `fleet-heartbeat` and carrying when the beat was last
seen, the interval in effect at that moment, and a deliberate stop's reason
when `--stop` recorded one. Deliberately not spelled "liveness" bare: that
word already names a member's process axis under Settle above, and the two
are different subjects — one member can be idle while the run beats, and the
run can be dead while a member's process still exists.
_Avoid_: liveness (bare), heartbeat state, pulse

**Stall report**:
What a reader says about a stale or stopped Liveness mark — when the beat was
last seen, how overdue it is against the interval that mark recorded, how many
tickets are still claimed and in flight, and whether the Shortlist still has
supply. Detection only: naming a stall neither releases the stranded claims
nor restarts anything.
_Avoid_: dead-run warning, stale banner

### Loop

**Shortlist**:
The ordered list of tickets the controller may admit — every open `ready-for-agent`
ticket that survives the cheap filters, oldest first, built in one scan and refreshed
at a low-water mark rather than on empty. Selection is batched here; admission never
is.
_Avoid_: queue, pool, staging, backlog, wave

**Pull**:
Admitting one ticket into one free implementer slot the moment it frees: the Shortlist
head is read, judged, claimed and dispatched — or relabelled by cause, or excluded, and
the next entry tried. The only unit of supply; there is no batch admission and no human
decision per admission.
_Avoid_: refill, stage, batch, wave

**Exclusion**:
A ticket the controller has ruled inadmissible for now, recorded with its premise — the
open PR it collides with or the open issue it sequences after — and skipped until that
premise closes, when it re-enters the Shortlist in its own order.
_Avoid_: demotion, deferral, skip, hold

**Pass**:
One merge bot's lifetime: dispatched on the first `ready-to-merge` label, it merges
every labelled PR one at a time, re-evaluating after each, waits a short grace for late
labels, reports once and exits. A label seen after the exit starts a new Pass under a
fresh name.
_Avoid_: wave, batch, cycle, round

### Dialect

**Marked line**:
A one-line, per-harness statement of a dispatch instruction, adjacent to its
partner and pinned as its own slice — never a section. The marker is the
line's first token once any GUTTER is stripped, `CLAUDE: ` or `OMP: `
(uppercase, colon, space), so a pin addresses exactly one line by
`^\s*(?:>+\s*)?(CLAUDE|OMP): ` in markdown prose — the shape that keeps a
two-dialect rule from becoming the fat slice that let 22 of 33 mutations
survive. Three gutter shapes are recognized, one per carrier: a markdown
blockquote (`>`, prose embedded in a quoted dispatch prompt — the gutter is
a rendering artifact, not part of the marker); a `.js` `//` line comment
(the shape a future single-line comment pair would use); and a bare line
inside a `/* ... */` block comment, no per-line gutter at all — #1361's
`review-pr.js` `resumeFor` cross-reference, the first `.js` marked pair,
uses this third shape, because `.js` files (`workflows/`) cannot `import` a
shared prose module and so carry the pair as a documentary code comment
instead of prose. Scope: `.md` under `skills/`, `commands/`, `agents/`, and
`.js` under `workflows/`; `docs/` is out (read by humans, never dispatched).
A marker written as a markdown code EXAMPLE (inside a ` ``` ` fence) is
scanned and pinned exactly like real prose — fences are not tracked, by
design (#1346): an example is a pair, so write examples clean, rather than
risk a real pair mistakenly indented into a fence going unseen. Neither
token occurs anywhere else in the prose tree (verified 2026-09-09).
_Avoid_: dialect card, shell

**Pair**:
The two adjacent Marked lines for one rule. A same-rule pair differs only in
dialect tokens (tool names, agent-name conventions) once those are stripped;
a does-not-apply pair states the absence explicitly, on the harness where the
rule does not hold, using one of two recognized literal idioms — **"does not
apply"** (the wording `member-lifecycle.md`'s grandchild-recipe and
result-consumption pairs use) or **"has no slot for"** (the Settle/liveness
pair's wording, added after #1346's review found it being misclassified as a
same-rule pair the equality bar could never satisfy) — grepped before fixing
either here, never a translation of the rule that does hold on the other
harness. #1346's divergence check greps for these exact phrases to classify
a pair; a pair carrying a recognized idiom on both lines, or on neither, is
a defect, not a third shape.
_Avoid_: translation, duplicate

### Tier

**Declared tier**:
The agent file's own frontmatter, harness-keyed: `model` as a bare alias (a
vendor alias on Claude, a Tier route's tier name on omp), `effort` for
Claude, `thinking-level` for omp. What the file says, version-controlled,
and the only intent this port records — no dispatch-time ledger entry
duplicates it.
_Avoid_: recorded intent, dispatch-time intent

**Resolved tier**:
What the harness wrote about the member after dispatch: Claude's transcript
`model`/`effort`, omp's `session_init.resolvedModel` identity plus the
`thinking_level_change.thinkingLevel` event — never the `:suffix`, which is
absent when resolution came from an agent's own frontmatter rather than a
`modelRoles` alias.
_Avoid_: effective tier, actual model

**Tier route**:
What turns a Declared tier's alias into a model on omp — the operator's
`task.agentModelOverrides` entry for that definition, `@<role>:<level>`,
derived from the definition and never hand-written, so `opus`/`sonnet`/
`haiku` name the `slow`/`task`/`smol` roles rather than a vendor model.
Claude has no route: the alias is the model.
_Avoid_: mapping, override, translation
