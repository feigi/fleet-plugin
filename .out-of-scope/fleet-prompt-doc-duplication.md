# Fleet Prompt / Command-Doc Duplication

`run-team/SKILL.md`'s dispatched prompt restates rules that `review-and-fix.md` also
states — the apply/verify split and the commit gate among them — while the same
`SKILL.md` tells the reader elsewhere to use the pointer form and "do not restate it".
Proposals to collapse the restated blocks into pointers are refused. The duplication is
deliberate and stays.

## Why this is out of scope

**It is defence against a skimmed file read, not redundancy.** Prompt text is guaranteed
to be in the agent's context; a file read is an instruction the agent can skip. Every
path that reads the prompt is also told to read `review-and-fix.md`, so the duplication
buys nothing on reachability — it buys the case where the second read does not happen.
That is the failure mode the fleet actually sees.

**It was created on purpose, with the reason recorded in the commit.** `2c88aa2` widened
these blocks precisely to close "gaps between two files that must say the same thing
because different agents read each". Collapsing them re-opens a gap that was closed
deliberately, and does so on the strength of a consistency argument rather than an
observed cost.

**Both copies are pinned.** `review-path-default.test.mjs` asserts against each, so a
collapse is not a prose edit — it is a test change too, and the pins exist because this
text has drifted before. There is a live instance on record of a fix landing in
`review-and-fix.md` and **not** in `run-team/SKILL.md`, which stranded PRs on the fleet
path. That is the direction the drift actually runs, and it argues for keeping both
copies pinned rather than for deleting one.

**What the proposal would save is small and paid once per PR**: roughly 28 lines off a
prompt sent once per reviewed PR. Against that, a skimmed read that misses the apply
policy or the commit gate costs a whole review cycle.

The convention lines that appear to contradict this — the "pointer" wording and the "do
not restate it" bullet — are scoped to CI facts and specialist tree isolation, not to
the apply/commit rules. If they read as absolute to someone re-deriving this finding,
narrowing that wording is a fine change on its own. Deleting the duplicated blocks is
not.

Keep regardless of any future edit here: the `<testCmd>` substitution lead-in and the
"read your refuter's report yourself" block. Both are fleet-only and have no counterpart
in `review-and-fix.md`.

## Prior requests

- #219 — "run-team/SKILL.md restates review-and-fix.md steps 2-3 in a file that says 'do not restate it' — pick one"
