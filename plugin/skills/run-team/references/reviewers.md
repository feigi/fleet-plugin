# Reviewers: the evidence behind the review-side rules

Evidence for rules SKILL.md states in Phase 2 and **Reading a review result**, keyed by the rule each justifies.

## A sizing verdict is a measurement only if it post-dates the run that produced it

**A verdict is a measurement only if it post-dates the run that produced it.** A
`Sizing:` line typed in before the skill ever ran is byte-identical to one the
skill produced, so the body cannot settle this alone, and neither can the
member's prose. The report file carries the second source: `sizing.ranBeforePr`,
whether `sizing-a-ticket` ran before the PR was opened (measured on a member
that wrote the line first, caught itself, and corrected it), and
`sizing.signal`, what the verdict turned on. `append` applies the rule itself:
it records `sizing` only when `ranBeforePr` is true AND `signal` is non-empty.
Any other state — no report file, one that fails its schema, `sizing` null,
`ranBeforePr` not true, an empty `signal` — leaves the field BLANK with a
WARNING naming which, and you say which in `note`. A `--sizing` you do pass
wins over the file, and stderr names the flag as the source: do not use it to
fill that gap, and do not re-derive the verdict from the diff to fill it
either — `sizing-a-ticket` weighs more than file count, and a substituted proxy
reads as measured too. **A value not in hand is left BLANK, never estimated** —
blank reads as unknown and drops the row from a stratified comparison, while a
guess reads as measured and poisons one. Blank still means the field is
WRITTEN and empty: omit the flag (`--sizing`, `--profile`, `--loc`, `--files`)
and the script writes that field empty at full width, because a row of some
in-between width cannot be told apart from a shifted one. The `note` field is
free text and sits before those four, so the script refuses a tab or newline in
it: one tab would shift all four for that row alone.

## Know the trim before you rely on it

**Know the trim before you rely on it — it is wider than `docsOnly` suggests.**
`diff-stats.mjs` calls a PR docs-only only when it touches **no** src, tests *or*
config, but that strictness cuts both ways and the size tier trims again on top.
Measured: a docs PR that also adds one test file is profile `tests-only` and runs
**three** (correctness+tests+comments), not six; a no-src, no-test diff that
carries a config file keeps silent-failure at **any** size, so a docs+config diff
too big for the size tier now runs correctness+silent-failure+comments, not
correctness+comments; and any `single-file` or `small` profile trims to
correctness+silent-failure+comments, keeping tests only when a test file is in
the diff. `comments` is on that floor
unconditionally — it used to need a docs FILE, and `classify()` scores
only a prose extension or a README/CHANGELOG-style name docs, so five production PRs whose whole
substance was prose inside a `.js`/`.mjs`/`.sh` comment scored `docs: 0` and ran
without the one specialist that fit them, `dimensionsUnrun` empty every time.
That floor holds **regardless of `hasSrc`** — a one-file `.yml` or
`.github/` shell change gets silent-failure too, not correctness alone.
It is the size **tier's** floor,
so `tests-only` outranks it when the diff has no config file: that profile is
assigned ahead of `single-file`/`small`, so a no-src, no-config diff that also
touches a test file gets no silent-failure-hunter — a tests-only diff that also
carries a config file keeps it. `single-file` means one file at **any** size, so a
one-file rewrite trims too. An unknown profile widens to the full six, the safe
direction, so a trim is never something to count on in advance — and a full six
is never something to assume.

## A refutation needs its positive control

**A refutation resting on an injection nothing proved landed is not a refutation
— it is a cell that never ran.** A mutation test and a finding reproduction are
both failure injections: break something, read what the child does. When the
break never reaches the child, the child behaves exactly like its baseline, which
is what a genuine no-effect mutation looks like and what a correctly refuted
finding looks like. So a negative result is admitted only together with its
**positive control** — one run proving the injected difference is observable,
either the child's output differing with the injection present versus absent or
the child echoing the injected value back from inside. No control → the cell is
unrun: re-run it, and never record it as a negative. Measured 2026-08-28 and
re-measured on this tree, against a `probe.sh` that echoes both variables back:

```sh
zsh  -c 'cfg="SETB=1 BADJ=1"; env $cfg sh ./probe.sh'   # BADJ=[unset] SETB=[1 BADJ=1]
bash -c 'cfg="SETB=1 BADJ=1"; env $cfg sh ./probe.sh'   # BADJ=[1]     SETB=[1]
```

zsh does not word-split an unquoted parameter expansion, so the whole string
arrives as ONE argument: a variable literally named `SETB` takes the value
`1 BADJ=1`, the injection variable `BADJ` is never set, and the probe still exits
0. It bites in both directions, and the reproduction direction is the worse one —
one fix-applier nearly reported a mutant as behaving identically to its baseline,
while another nearly retired a real review finding as non-reproducing after
the same shape handed both trees a single argv word and drew `exit 2` from each,
which is the signature of a correct refutation with nothing anomalous to notice.
The fix-applier body and every refuter brief carry the rule and the safe
invocation form; the merge bot's brief is the wrong seat, because a bot
reads gates and never injects a fault.

## Where `<branch>` comes from

**Where `<branch>` comes from:** the PR's head branch —
`gh pr view <N> --json headRefName -q .headRefName`, or the same branch you cut
the worktree from. Pass it as `--branch`, because
the member cannot read it off git: references/isolation.md creates an already-open PR's worktree
with `--detach`, and there `git branch --show-current` prints nothing and exits 0
(measured 2026-09-18, git 2.50.1), so `~/.fleet/bin/fleet-run push-sync.mjs
--branch "$(git branch --show-current)"` is handed an empty branch and exits 2
before pushing anything. A brief rendered without it would leave the push no
destination at all, which is why the renderer requires it.

## A review runs off your turn and relays nothing

**`selectDimensions` sizes the fan-out to the diff and the verify budget
follows severity.** It cuts one immutable
snapshot, verifies every critical/important finding adversarially,
re-dispatches each crashed specialist and each crashed refuter pair once before
it assembles the result, and has `agent()` return **into the script**, so no
report can go undelivered and you relay nothing — the delivery failure that
cost one fleet five reports on one PR and four on another. None of it runs on
your turn: a review takes 20-40 minutes, and a controller that held its turn
for each one, one at a time, was what left implementer slots empty.

## `testEnvironment` says what the shared test run is evidence about

The snapshot is `git archive`d and then
`git init`ed with one commit, and the block that cuts it compares that commit's
tree hash against the reviewed commit's: verified, a suite run in the
snapshot collects and runs what a checkout does, and a red is a fact about the
tree. UNVERIFIED, it is not — tests that ask git what ships decline or fail for
the environment, and this field carries which line of the cut failed.

## `dimensionsUnrun` names a gap; an empty dimension does not

The rule this replaces — treat any dimension with nothing in
`survived`/`refuted`/`unverified` as unrun — was the workaround for having no
such field, and it over-refuses in the direction that costs work: a dimension
that ran clean has nothing in those three either.

## A failed review is a failure event, not a clean review

The review throws on missing `args.pr`/`args.worktree` and on a snapshot agent
that returned no tree, and a failure surfaces mid-loop, where "react, never
block" makes it easy to log and carry on — leaving a PR that *reads* as
reviewed and is not.
