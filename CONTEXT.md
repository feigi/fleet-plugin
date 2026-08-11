# Claude Config

Personal Claude Code configuration — commands, skills, and the **fleet**: scripts and
skills that run parallel agents against this repo's own issue tracker. This glossary
covers the vocabulary those scripts share; it is a glossary only, not a spec.

## Language

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
