# A Green Suite in Place of the Acceptance Mutation

Duty 2 has the finisher re-run the ticket's acceptance mutation and watch a test go red. On a
markdown-only diff there is often no mutant to build. We don't accept proposals to let a
green suite at the pin stand in for the kill there, or to pass duty 2 on a finisher's own
finding that "no mutant can be built". The one skip is `finisher-scope.mjs`'s **Inert diff**
verdict, exit 0.

## Why this is out of scope

**A green suite passes exactly the edit the mutation exists to catch.** A markdown-only diff
that no test reads leaves the suite green with the edit and without it. Under the prompt
surface (a `skills`, `agents` or `commands` directory, a dot-directory, an `AGENTS.md`,
`CLAUDE.md` or `GEMINI.md`) that edit changes what an agent does, and nothing pins it.
Passing duty 2 on the green run would merge it with no kill and no human.

**The verdict is the script's, not a reading of the diff.** "No mutant can be built" is a
finisher's judgement about the diff it is auditing. The Inert diff verdict replaced that
judgement with a fail-closed classification of every path, so the skip never rests on what
the auditing agent decided the diff was. A second, judgement-shaped pass beside it would
reopen the gap the script closed.

A diff the script calls not inert, with no mutant to build, halts the finisher for a human.
The narrow fix for a class of files that halts too often is to change what the script
classifies as prose, as was done for the root `.out-of-scope/` records, not to add a pass
that skips the classification.

## What would reopen this

- A way to show from the diff alone, without the auditing agent's judgement, that an edit
  under the prompt surface cannot change behavior.

## Prior requests

- #3989 — "Reduce fleet halts: docs-only mutation check, rebase after a fix, stale finisher
  worktree, bot holds, dispositions-escalate" (item 1: a named "no mutant constructible"
  verdict plus the green suite)
- #3747 — "finisher: the acceptance mutation cannot go red on a prose-only PR, so every
  docs-only PR halts at the maintainer" (the in-session ruling of 2026-10-24, that a green
  baseline run at the pin satisfies duty 2 for a docs-only PR, which the Inert diff verdict
  replaced)
