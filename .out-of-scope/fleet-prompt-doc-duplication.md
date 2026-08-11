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

The convention lines that appear to contradict this — the pointer-form wording
(`review-and-fix.md` states them; the prompt only has to say they apply) and the "do not
restate it" bullet — are scoped to CI facts and specialist tree isolation, not to the
apply/commit rules. If they read as absolute to someone re-deriving this finding,
narrowing that wording is a fine change on its own. Deleting the duplicated blocks is
not.

Two further lines in `SKILL.md` are the ones a re-derivation will actually reach, and
neither is scoped the way those two are. Its self-correction **Triggers** list names "A
caller has to restate what the callee should say itself" — this duplication, listed as a
trigger to go fix the instruction. And its **Shape — lean, or it rots** paragraph states
the rule flatly: "Prefer moving text to adding it, and delete the copy you superseded; a
duplicated rule becomes a contradiction."

Neither reaches this case on a literal reading. The Trigger fires where a callee fails
to say what it should and the caller compensates; here `review-and-fix.md` states the
rules in full, and the prompt repeats them because the fix-applier's own steps skip the
read — not because the callee is deficient. The Shape rule turns on supersession: "the
copy you superseded" is the one left behind once its replacement landed, and neither
file supersedes the other. Both are read, by different agents, on different paths, and
`review-path-default.test.mjs` reads both and asserts against each. `2c88aa2` is the
worked example — its subject is "the refuter's one instruction that makes it a refuter
was in one file only", and it closed that gap by adding the missing copy to the second
file, in the same commit, rather than by collapsing the two.

Both lines also sit under `## Fix the tooling mid-run`, whose **Scope** paragraph limits
that section to defects *this run produced* in commands and skills *this run invoked*.
That does not exempt these two files — the fleet invokes both — but it does make the
Trigger a prompt to diagnose a live failure, not a standing audit criterion to re-derive
this finding from.

Keep regardless of any future edit here: the `<testCmd>` substitution lead-in, which is
genuinely fleet-only and has no counterpart in `review-and-fix.md`.

The "read your refuter's report yourself" block is a keep for the opposite reason. It is
not fleet-only — it restates `review-and-fix.md`'s **Specialists** rule near-verbatim,
down to the `tail -1 <output-file>` command, "Never read the whole file" and the "~15
pinged in one run, 0 retrieved" measurement. `SKILL.md` says so itself, immediately
after the block: "This is `review-and-fix.md`'s **Specialists** rule; it reaches you
here because the steps that point at it are the ones you skip." The fleet copy narrows
it to the refuters the fix-applier itself dispatches. So it belongs with the deliberate
duplication above, not against it — and editing either copy means editing both.

## Prior requests

- #219 — "run-team/SKILL.md restates review-and-fix.md steps 2-3 in a file that says 'do not restate it' — pick one"
