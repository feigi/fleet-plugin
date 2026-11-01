# Reviewers: the evidence behind the review-side rules

Evidence for rules SKILL.md states in **Dispatching the Pull's member**, **Dispatching the members a wake names** and **Reading a review result**, keyed by the rule each justifies.

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

**Phase 0 does not size anything** — it shortlists, a Pull claims, and
the sizing run happens inside the member after both, which is why the verdict
has to travel in the member's report rather than being something you already hold.

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
(measured 2026-09-18, git 2.50.1), so `~/.omp/plugins/node_modules/@feigi/fleet-ctl/scripts/fleet-run push-sync.mjs
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

## The review's scratch is the scratch root, not its partition

**`scratch` is the scratch root itself, the absolute path `scratch-root.mjs` prints, never the review side's `<scratch>/pr<N>` partition:** the review creates `pr<N>/` under it, so a `pr<N>` passed in nests every run root at `pr<N>/pr<N>/`, and the review refuses a `scratch` whose last component is `pr` plus digits before dispatching anything.

## Cross-check what members report, and distrust negative claims hardest

Wrong often enough
to matter, and a confident wrong report from a reviewer flips a verdict.

"Nothing else references this", "the sweep
is clean" — most likely false, least likely checked: a grep that found nothing
looks like a grep never run.

## Reading a review result's digest, field by field

Findings never enter your context —
a result runs 26-61 KB, 7-15k tokens that used to land in yours and then again,
up to ~10k characters, in every fix-applier prompt you wrote. What the digest tells you:

**`testEnvironment` says what the review's shared test run is evidence about**,
and it is present on a healthy run as well as a degraded one, so there is
nothing to notice by its absence. The
fix-applier reads it before acting on any count from the shared test run; you
read it so a degraded review never passes for a clean one.
`unverified` is *not* "checked and cleared" — a `suggestion` skips the pass by
policy, and a finding whose refuters all crashed or abstained lands there too.
All go to the fix-applier with the rest, in the file; never rule on them yourself.
**`refutersDispatched`, carried on every finding, is what tells the skip
apart** — zero is the policy skip, above zero with no deciding vote is a
refuter pass that decided nothing — and `refutersInconclusive` splits that
one: the refuters it counts abstained, every other one dispatched crashed. So
the population is read off those fields rather than off severity,
which records only how much a finding would matter if true. `resume` is
non-null exactly when a specialist or a refuter pair crashed again after the
review's own in-run retry, and **resume beats handing a crash-heavy review
on**: a deferred crash is a finding nobody ever looked at.
No replay exists for a review that ran in a runner's own kernel — `resume` is reported, not acted on, and the fix-applier defers what it names.
`refuted` comes back deliberately as well — a refutation is itself a claim, and
one has been reversed on new evidence. The fix-applier may reverse one; it
records each reversal as a `refuted` entry in its disposition record, the
evidence in `reason`, and you copy those entries to the ledger's `ruled` line by
running `fleet-event.mjs fix-report`, whose `settle --from-report` records each
refutation the report defers.

**`dimensionsRun` is the dispatch; `dimensionsUnrun` is what names a gap.** A
specialist that dies contributes zero findings while its key stays in
`dimensionsRun`. So read the two together. A key
in `dimensionsRun` and NOT in `dimensionsUnrun` returned a review; every
`dimensionsUnrun` entry is `{dimension, reason}` naming a specialist that
returned nothing, its `reason` the crash.
The review already re-dispatched each crashed specialist once, so what
`dimensionsUnrun` still names is residue: the fix-applier names it unrun in its
report and re-runs nothing — an absence of findings is not coverage.

**`suiteVerdict` is the review's one judgement on its shared test run:
`{usable, reason}`, always present.** The review runs the test command once,
and every specialist reads that run instead of running its own. `{usable: true,
reason: null}` says the run executed real tests and its exit status is
explained by its counts; usable is not green, so a usable run can have failing
tests. `usable: false` carries `reason`, including a run that never started
(install skipped, no suite slot). The verdict says nothing about whether a
dimension reviewed: a specialist that returned reviewed, its findings verified
as usual, whatever the suite verdict. With `usable: false` the
fix-applier names `shared test run not usable: <reason>` in its final verdict
and does nothing more — its own `<testCmd>` run and CI cover the suite.
**Exit 75 is not a test result.** In a review it makes
`suiteVerdict` not usable, `suiteVerdict.reason` beginning "no suite slot within
<n> s — the host is at its suite bound; not a test failure", with no retry
inside the run: read that `reason` off the digest and re-review it
under the next runner letter (`review-pr-<pr#>-b` after a first runner), as for
a runner that reported `failed`.

**`cwdAudit` is the specialist's own inherited-checkout audit, one entry per
dispatched dimension: `{dimension, state, line}`, `state` one of**
`clean`/`dirty`/`unrepo`/`missing`. The prompt asks every specialist to run
`git status --porcelain -uall` against the directory it inherited before
returning and fold the result into a `CWD-AUDIT:` line — a convention, not
schema, so a specialist that never emits it or misspells it still validates
clean. This field is the runtime backstop that reads for the line regardless:
`missing` is exactly as loud as `dirty`, and both name a checkout you should
treat as a live scratch write until you have checked it.

## The tier-outcomes row's difficulty fields

The row's last four fields are the ticket's difficulty, and they are what lets a
tier comparison condition on the thing that swamps it. `sizing` is the
**member's** own `light`/`heavy` verdict from its dispatched `sizing-a-ticket`
run, which `append` reads itself off the member's report file
(`<scratch>/reports/impl-<ticket>[-x].json`, its `sizing.verdict`, the highest
retry letter's when there are several), so you pass no `--sizing`; the member
also puts it in the PR body's `Sizing:` line, with the signal it turned on;
`profile`, `loc` and `files` all come from `diff-stats.mjs` over the merged
diff.

## What a shared snapshot did to its readers

`review-and-fix.md`'s **Cut TWO trees, not one** rests on this. Observed with a single shared snapshot: three specialists read two *different* in-flight mutations, one reporting the PR's own bug as still present; elsewhere three watched their file go clean → `M` mid-analysis; twice a reviewer came one step from filing a false finding.

## What an unbounded read costs

`review-and-fix.md`'s **Then bound the read** rests on this. The cost of not bounding is never one-off: a specialist that dumps a 37 KB file carries it in its prefix for every remaining turn, re-billed as cache-read on each. Over one run's 92 subagents the 88 unpiped whole-file calls carried 434 KB (~110k tokens) — the single largest attributed line item in that run — against 319 piped ones. Agents already reach for the bounded form; nothing told them when it is required.
