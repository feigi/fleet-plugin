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
Deleting branches whose upstream is gone, and their worktrees, after a merge wave.
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

### Dialect

**Marked line**:
A one-line, per-harness statement of a dispatch instruction, adjacent to its
partner and pinned as its own slice — never a section. The marker is the
line's first token once any markdown blockquote gutter is stripped,
`CLAUDE: ` or `OMP: ` (uppercase, colon, space), so a pin addresses exactly
one line by `^\s*(?:>+\s*)?(CLAUDE|OMP): ` — the shape that keeps a
two-dialect rule from becoming the fat slice that let 22 of 33 mutations
survive. A pair embedded inside a quoted dispatch prompt (a `>` blockquote)
is still two adjacent Marked lines; the gutter is a rendering artifact, not
part of the marker. Neither token occurs anywhere else in the prose tree
(verified 2026-09-09).
_Avoid_: dialect card, shell

**Pair**:
The two adjacent Marked lines for one rule. A same-rule pair differs only in
dialect tokens (tool names, agent-name conventions) once those are stripped;
a does-not-apply pair states the absence explicitly, on the harness where the
rule does not hold, using the literal phrase **"does not apply"** — the
wording both landed instances (`member-lifecycle.md`'s grandchild-recipe and
result-consumption pairs) actually use, grepped before fixing it here — never
a translation of the rule that does hold on the other harness. #1346's
divergence check greps for this exact phrase to classify a pair; a pair
carrying it on both lines, or on neither, is a defect, not a third shape.
_Avoid_: translation, duplicate

### Tier

**Declared tier**:
The agent file's own frontmatter, harness-keyed: `model` as a bare alias,
`effort` for Claude, `thinking-level` for omp. What the file says,
version-controlled, and the only intent this port records — no dispatch-time
ledger entry duplicates it.
_Avoid_: recorded intent, dispatch-time intent

**Resolved tier**:
What the harness wrote about the member after dispatch: Claude's transcript
`model`/`effort`, omp's `session_init.resolvedModel` identity plus the
`thinking_level_change.thinkingLevel` event — never the `:suffix`, which is
absent when resolution came from an agent's own frontmatter rather than a
`modelRoles` alias.
_Avoid_: effective tier, actual model
