# Review cost tiering, and the apply/verify policy that is filling the ticket backlog

Date: 2026-08-06
Status: implemented on `feat/211-review-cost-and-apply-policy`, base `8a84402`.
Ticket #211, widened during brainstorm. No commit count or head SHA here — a
status line cannot name the commit that writes it, and the last one was stale the
moment it landed. `git log 8a84402..` is the answer that stays true.

All line references below were measured at `8a84402` and address the files as
they stood there — not pointers into the current tree. Resolve one with
`git show "8a84402:<path>" | sed -n '<N>p'`; keep the quotes when you paste that
template — unquoted, zsh reads the literal `<path>` placeholder as a redirection
and dies with a parse error before git ever runs. Once a real path is
substituted in, this literal-ref template behaves identically quoted or
unquoted — and so does a ref held in a variable, identically broken: zsh
reads the `:<path>` suffix as a history modifier inside double quotes as
well as outside, so quoting is not what fixes that one. Brace it —
`git show "${SHA}:<path>"`.

One change and one correction were made after implementation, both recorded
below. The change: the size tier keeps `comments` on any small diff that touches
docs (Change 2). The whole-branch review found that mixed prose PRs — this repo's modal PR, and the category the
`docsOnly` branch exists for — were losing comment-analyzer coverage entirely,
a case this spec's original matrix had no row for. The correction: Change 1's
stated rule never separated the six dimensions it claimed to (#221) — the models
shipped are unchanged, the stated reason for them is not.

Open, deliberately not closed here: whether `opts.model` beats `agentType`
frontmatter in workflow `agent()` (see Unknowns). The new `models …` log line
reports what was **sent**, not what was **used**, so only a subagent-JSONL read
settles it — and no cost saving should be claimed until it does.

Artifacts: `workflows/review-pr.js`,
`skills/fleet/commands/review-and-fix.md`,
`skills/fleet/skills/run-team/SKILL.md`,
`skills/fleet/scripts/diff-stats.mjs`,
`skills/fleet/scripts/review-path-default.test.mjs`,
`skills/fleet/scripts/select-dimensions.test.mjs` (new)
(repo `feigi/claude-config`)

Base: `8a84402`. All line references verified against that commit.

Closes #211 and #118. Coordinates with #113.

## Problem

Ticket #211 named two cost holes. Reading the code surfaced two more problems in
the same path, one of them larger than the cost issue that started it.

### 1. Specialists run top-tier — but not for the reason the ticket says

#211 states "every specialist inherits the session model." That is wrong for two
of six. Frontmatter of the six `pr-review-toolkit` agent definitions, read from the
marketplace checkout under `plugins/marketplaces/` and byte-identical to the
installed copy. (The `plugins/cache/.../<sha>/agents/` path is deliberately not
cited: `plugins/` is gitignored, so that path is machine-local, outside the
"verified against `8a84402`" claim below, and it rotates on every plugin update —
it already has.)

| Dimension | Agent | Frontmatter | Opus session |
|---|---|---|---|
| correctness | `code-reviewer` | `model: opus` | Opus, **pinned** |
| simplify | `code-simplifier` | `model: opus` | Opus, **pinned** |
| silent-failure | `silent-failure-hunter` | `model: inherit` | Opus, inherited |
| tests | `pr-test-analyzer` | `model: inherit` | Opus, inherited |
| comments | `comment-analyzer` | `model: inherit` | Opus, inherited |
| types | `type-design-analyzer` | `model: inherit` | Opus, inherited |

Consequence: dropping the controller to Sonnet moves four specialists and leaves
two on Opus. There is no session-level lever for those two, and the frontmatter
is vendored third-party — outside the orchestration-only constraint from the
2026-07-24 pass, and clobbered on the next plugin update. Passing `model` from
`review-pr.js` is the only durable lever.

### 2. `selectDimensions` never reads the size numbers `diff-stats` computes

`review-pr.js:169` trims by content type only — `docsOnly`, `hasSrc`, `hasTests`.
A single-file five-line source fix pays the same six-dimension fan-out as a
400-line feature. `computeStats` already returns `files`, `loc` and a `profile`
that distinguishes `single-file` and `small`; the selector never reads them.

### 3. 83% of open issues are review deferrals, and none are attributable

Measured 2026-08-06 against `feigi/claude-config`:

```
open issues:                                    107
open issues whose body says "Deferred from PR":  89
    of those, labelled ready-for-agent:          84
    of those, naming a specialist in the body:   15
```

**The last row was first measured as `0`, and that was an instrument failure, not
a result.** It came from `gh issue list --search 'simplif'`, which returns `[]` —
GitHub's search tokenizes and does not substring-match, so a truncated stem
matches nothing. `--search 'simplifier'` returns results immediately. Re-measured
by fetching the 89 deferral bodies and grepping them locally for the six
specialist names: **15** name one outright (#208 #184 #179 #176 #175 #156 #154
#153 #152 #151 #86 #79 #25 #23 #18), two of them explicitly — #156 *"From the
code-simplifier specialist"*, #153 *"the code-simplifier measured that..."*.

The argument below is unchanged: 15 of 89 is still an unattributable backlog, and
recording `dimension` at filing time is still the fix. But the `0` overstated it,
and a server-side substring search is not a measurement — it is the clean answer
this repo's tooling keeps failing toward.

Two rules compose to produce this. `review-and-fix.md:7` (step 2) defers **every**
`suggestion` and **every** `unverified` finding; `review-and-fix.md:10` (step 5)
files **each deferred finding** as its own issue. So anything not `survived`
becomes queued agent work — and queued work produces more PRs, which produce more
reviews, which produce more sub-threshold findings. Fan-out width drives backlog
growth, and nothing throttles it.

The filing step does not record which dimension produced the finding, so the
backlog cannot be attributed. The data exists and is discarded: `FINDINGS_SCHEMA`
requires `dimension` (`review-pr.js:31`) and every returned finding carries it
(`review-pr.js:304`, `:331`).

### 4. Applied fixes are never reviewed, and nothing runs tests before the commit

The review runs **once**, against a snapshot cut at the pre-fix HEAD
(`git archive HEAD`, `review-pr.js:207`). The fix-applier then edits, commits,
pushes and exits. The finisher is "a fresh small agent, not the fix-applier
resumed" (`run-team/SKILL.md`, same quoted words) whose duties are worktree
audit, confirm deferrals filed, add `ready-to-merge`. Nothing re-reviews.

So no reviewer ever reads the fix commit. Two consequences:

- **Verification checks the claim, not the patch.** A refuter answers "is this
  finding real?" It never sees the edit, because the edit does not exist yet.
  Verifying before applying makes the *finding* trustworthy; the *diff the
  fix-applier writes* is unreviewed either way.
- **`review-and-fix.md:8` — step 3 in full — is `3. Commit, push.`** No test run
  before committing. The only gate on agent-authored fix commits is CI, which
  catches test-covered regressions and nothing else.

This repo has no pre-commit hook: no `.git/hooks/pre-commit`, no `core.hooksPath`
local or global, no `init.templateDir`, no `~/.config/git/hooks`, no
husky/lefthook/`.pre-commit-config.yaml`. And the fleet is a **generic plugin** —
it must not depend on a hook existing in the host repo.

## What this changes

Four changes. 1 and 2 are #211 as filed; 3 and 4 were found while reading it.

## Change 1 — per-dimension model tier

**Rule: downgrade only dimensions whose findings face refuters.**

`verifiersBySeverity` gives `critical`/`important` two adversarial refuters and
`suggestion` zero. Where refuters run, a cheaper finder's false positive dies
downstream. Where they do not, nothing checks the finder at all.

This corrects the ticket's stated rationale. #211 argues the refute pass makes a
cheaper finder safe generally. Refuters catch false **positives**. A weaker
finder's real cost is false **negatives** — bugs never found — and nothing
downstream catches those. `verifierEffort: "low"` was safe for a different
reason: verification is a bounded check of one stated claim, whereas finding is
open-ended search.

| Dimension | `model` | Why |
|---|---|---|
| correctness | *(omitted)* | inherits `code-reviewer`'s own `opus` pin; open-ended search |
| silent-failure | *(omitted)* | inherits the session model; open-ended search, misses are silent |
| simplify | *(omitted)* | keeps its `opus` pin — its findings get **0 refuters**, so nothing downstream would catch a weaker finder. Cost is addressed by Change 2 excluding it from small PRs |
| tests | `"sonnet"` | inherits today, and its findings face refuters |
| comments | `"sonnet"` | as above |
| types | `"sonnet"` | as above |

`simplify` is deliberately **not** downgraded. It is the one dimension whose
entire output is unverified by policy, and its own prompt (`review-pr.js:106`)
states that a simplification changing observable behaviour is a defect — a
reasoning-heavy judgement, which is plausibly why the vendor pinned it.

**Corrected after implementation (#221): the rule stated above is not the rule
these six entries follow.** Nothing keys a refuter budget off a dimension —
`verifiersFor` is `(sev) => verifiersBySeverity[sev] ?? verifiers`, a severity and
nothing else — so `silent-failure` findings at `critical`/`important` draw exactly
the refuters `tests` findings do, and "faces refuters" cannot be what puts one on
`sonnet` and the other on the session model. What does: **downgrade only where a
MISS by the cheaper finder is RECOVERABLE.** A weak `tests`/`comments`/`types`
pass leaves something a later run or a reader still catches; `correctness` and
`silent-failure` miss silently and permanently — the same pair, for the same
reason, that `SIZE_TIER_DIMS` keeps. `simplify`'s **0 refuters** are real, but
reach it VIA SEVERITY — its prompt directs every finding to `suggestion`, which
the budget zeroes — so what omits it here is the vendored `opus` pin, with the
size tier paying its cost instead. The table above stays as the dated record of
what was decided at `8a84402`; `review-pr.js`'s comment above `DEFAULT_DIMENSIONS`
carries the rule in force.

Dispatch reads `model: A.specialistModel || d.model`. `undefined` inherits, so
the no-override path is unchanged for the three dimensions that omit it.
`args.specialistModel`, when set, applies to all six — that is what an override
is for. Documented beside `verifierEffort` (`review-pr.js:148`).

## Change 2 — size tier, composed with the content guards

Key on `stats.profile`. `computeStats` assigns it through an else-if chain
(`diff-stats.mjs:76-82`), so the values are mutually exclusive and no ordering
bug against `docsOnly` or `tests-only` is possible.

It composes with the content guards rather than replacing them: the content trim
runs first and the size tier filters what survived.

**Superseded by #236 — the one place this composition was load-bearing was
wrong.** A single `.github/workflows/ci.yml` change is `profile: "single-file"`
with `hasSrc: false`, and this spec originally argued that keeping the tier a
filter was what stopped `silent-failure` running on YAML. That is exactly
backwards: a CI-workflow or shell diff is mostly shell, which is what the
silent-failure hunter is for, and PR #226 reviewed CI's own gating logic with
`dimensionsRun: ["correctness"]`. `silent-failure` is now a FLOOR on any
`single-file`/`small` profile regardless of `hasSrc`; above the size tier the
`hasSrc` guard still drops it. `tests-only` is assigned ahead of both size-tier
profiles, so a no-src diff that also touches a test file never reaches the floor
at all — out of #236's scope, filed as #739. With that settled, the filter no
longer changes any outcome versus a floor over the full set — every dimension the
guards above can remove is one the tier would not have kept anyway — and it is
kept only because that form stays correct without re-proving the equivalence each
time a guard is added above it.

The shipped filter is in `review-pr.js`; it is not copied here, because a copy in
a doc cannot be tested and drifts silently. Read `selectDimensions`.

**Two dimensions are carved out of the size trim.** `comments`, whenever the diff
touches a docs file: the `docsOnly` branch keeps comment-analyzer because the
failure mode of prose is a wrong CLAIM, but `docsOnly` is strict — one config or
src file in the same diff falsifies it, and the size trim then dropped `comments`
outright. That left the mixed prose PR, this repo's modal PR and its most
defect-prone category, with zero comment coverage. And `tests`, whenever the diff
touches a test file: when the diff's substance IS a test, mutation-discrimination
is the check it most needs, and this repo's recurring defect is a vacuous pin
shipping green.

Both carve-outs are **file-kind** tests, not content tests. `classify()` scores
any code extension `src` before it checks `isDocs`, so a comment-only edit to one
`.js` file is `docs: 0` and still loses comment coverage — filed as #218, not
fixed here.

The `comments` guard is `stats.kinds?.docs !== 0`, not `> 0`, matching the
`=== true` guards above it: the blob is relayed by an agent, so a field can go
missing without failing `JSON.parse`, and absence must widen rather than be the
one input that narrows coverage.

`single-file` is `files === 1` at **any** size, so this trims a one-file rewrite,
not only a short diff. Thresholds stay named once, in `diff-stats.mjs` where
`files === 1` and `loc < 30` already live.

Resulting matrix over `DEFAULT_DIMENSIONS` (`[correctness, silent-failure, tests,
comments, types, simplify]`):

| stats | dimensions | n |
|---|---|---|
| `null` / unparseable | all | 6 |
| `profile: "empty"` | all | 6 |
| `docs` | correctness, comments | 2 |
| `tests-only` | correctness, tests, comments | 3 |
| `single-file`, has src | correctness, silent-failure | 2 |
| `single-file`, config only | correctness, silent-failure | 2 |
| `small`, config only | correctness, silent-failure | 2 |
| `small`, has src | correctness, silent-failure | 2 |
| `small`, docs + config (not `docsOnly`) | correctness, silent-failure, comments | 3 |
| `small`, docs + src (not `docsOnly`) | correctness, silent-failure, comments | 3 |
| `small`, src + test | correctness, silent-failure, tests | 3 |
| `small`, `kinds` missing from the blob | correctness, silent-failure, comments | 3 |
| `production`, has tests | all | 6 |
| `production`, no tests | all but tests | 5 |

**The two cost changes barely compound — but "by construction" was too strong.**
The base size tier keeps `correctness` + `silent-failure`, both of which carry no
`model` override, so on a plain small source diff the trim and the tier are
independent: small PRs save by running fewer specialists, large PRs by running
three of six cheaper.

Two things qualify it, both added after this paragraph was first written. Three
dimensions carry no `model` override, not two — `simplify` is the third, and it
is dropped rather than kept. And the carve-outs keep `comments` (on a docs file)
and `tests` (on a test file), both of which DO carry `model: "sonnet"` — so on a
small mixed diff the fan-out is trimmed *and* a survivor is downgraded. Rows
`small, docs+config` and `small, docs+src` in the matrix above are the cases.
Worth knowing when measuring; still not a defect.

`log()` names both trims and the model choice. No silent caps.

## Change 3 — apply/verify policy for the `suggestion` band

Intent: apply a suggestion directly in the PR when it makes sense and is in the
PR's scope; defer only what belongs to a different scope.

`run-team/SKILL.md:350` currently couples the two deferred bands: *"Every
`suggestion` and every `unverified` defers — never apply one."* Split them.

- **`suggestion` in the scope of the PR's ticket** → the fix-applier dispatches
  **one refuter**, biased to refuse; survives → apply, refuted → defer and file.
- **`suggestion` out of scope** → defer and file. Unchanged.
- **`unverified`** → **always defers**, at any severity. Unchanged. An
  `unverified` `critical` is one whose refuters all crashed.

Verification is placed at the fix-applier, not in the workflow.
`verifiersBySeverity.suggestion` stays `0`. Cost then scales with the number of
suggestions **applied**, not the number **found** — moving it into the workflow
would add one agent per suggestion on every PR, including every suggestion nobody
applies, which would partly cancel Changes 1 and 2.

Scope adjudication stays where it already is. The workflow does not know the
ticket; the fix-applier does, and step 2 is already its apply/defer split. "In
scope" means the **ticket's** scope, not merely the same files.

Step 5 additionally records the finding's `dimension` in the issue body, so the
backlog becomes attributable. The workflow already supplies it.

## Change 4 — a commit gate that assumes nothing about the host repo

The fleet is generic. The gate must neither depend on a repo-local hook nor
bypass one.

**Do not depend.** Step 3 becomes run-then-commit, using `testCmd` — already a
workflow arg (`run-team/SKILL.md:287`), already defaulted (`review-pr.js:138`),
already pinned by `review-pr-testcmd.test.mjs`. The fix-applier's prompt
currently carries only the PR number, worktree path and findings
(`run-team/SKILL.md:337-338`); `testCmd` is added to that payload.

A bad run reuses the convention already in the specialist prompt
(`review-pr.js`, the "is a FAILED run, not a pass" rule) rather than inventing
one: **`tests 0` is a FAILED run, not a pass.** Report the test result
alongside the SHA.

**Do not bypass.** `no-verify` and `pre-commit` appear nowhere in
`skills/fleet/` — verified at `8a84402`. A generic plugin instructs agents to
commit in arbitrary repos that may have hooks, and an agent blocked by a failing
hook reaches for `--no-verify` as the obvious unblock. Rule: never
`--no-verify`; a failing hook stops the commit and is reported, it is a finding
and not an obstacle.

This lands on step 3 itself, so it covers **every** applied fix on both the fleet
and standalone paths — not only the suggestions Change 3 newly admits.

## Edits

`workflows/review-pr.js`
- `DEFAULT_DIMENSIONS`: add `model: "sonnet"` to `tests`, `comments`, `types`. Leave `correctness`, `silent-failure`, `simplify` without the field.
- Add `const specialistModel = A.specialistModel || null;` beside `verifierEffort` (`:148`), with the rationale comment.
- Review dispatch (`:291`): add `model: specialistModel || d.model`.
- `selectDimensions` (`:169`): add the two constants and the intersect step.
- `log()` (`:262`): name the size tier when it fires, and the per-dimension models.
- `:173`: correct "drop three dimensions" → four (#118). Note #118 cites this as `:143`, its line at that ticket's base commit.

`skills/fleet/scripts/diff-stats.mjs`
- `:105`: correct the fail-closed comment. An empty profile **widens** to all six (`review-pr.js:175`); it does not "trim a real production PR down to two specialists" (#118). The fail-closed behaviour itself is right and stays.

`skills/fleet/commands/review-and-fix.md`
- `:7` (step 2): split the `suggestion` and `unverified` rules per Change 3.
- `:8` (step 3): run `testCmd` before committing, `tests 0` is a failure, never `--no-verify`, report the result.
- `:10` (step 5): record the finding's `dimension` in the issue body.

`skills/fleet/skills/run-team/SKILL.md`
- `:337-338`: add `testCmd` to the fix-applier's prompt payload.
- `:350-355`: split the two bands; add the one-refuter rule for in-scope suggestions, and how the applier retrieves its own child's report.
- Step 3 gate mirrored into the prompt.

## Testing

**New `skills/fleet/scripts/select-dimensions.test.mjs`.** Lifts
`selectDimensions` and `DEFAULT_DIMENSIONS` out of `review-pr.js` **by source
text**, per the precedent of `review-pr-testcmd.test.mjs`'s
`liftResolveTestCmd`, failing loudly
with "update this test" when the shape moves. Asserts the full matrix above, plus
which dimensions carry a `model` field.

Not extracted to an importable module. That requires `import` to resolve inside
the Workflow sandbox — documented as "no filesystem or Node.js API access", and
nothing in `workflows/` imports anything today. A failed import bricks the
fleet's default review path. Text-lift closes #118's actual harm — unpinned
counts, hand-derived numbers, two wrong comments — at zero risk to that path.
Cost: the test couples to the function's literal spelling.

**Rewrite `review-path-default.test.mjs:87`.** It currently asserts `/suggestion/`
appears in the fix-applier prompt, with the message *"the prompt no longer defers
`suggestion` findings"*. The new rule still contains the word, so **the assertion
stays green while its message becomes false** — a positive regex doing no work,
the defect class recorded on PR #214. Replace it with a pin on the in-scope/
out-of-scope split, mutation-tested both ways: it must go red both when the
split is deleted and when the `unverified` rule is weakened.

**Line references.** `review-path-default.test.mjs` and
`review-pr-testcmd.test.mjs` slice by anchor; Changes 3 and 4 move text in both
edited files. Re-verify every anchor after editing.

## Acceptance criteria

1. `args.specialistModel` overrides all six dimensions; the default is documented beside `verifierEffort`.
2. With no override, `correctness`, `silent-failure` and `simplify` dispatch with no `model` field.
3. Unknown, unparseable or empty profile still returns the full six.
4. ~~A single-file config-only diff returns `correctness` alone, never `silent-failure`.~~ **Reversed by #236:** it returns `correctness` + `silent-failure`. The size-tier floor is unconditional on `hasSrc`; the `hasSrc` guard still gates `silent-failure` above the tier.
5. Thresholds are named once, as constants; `diff-stats.mjs` gains no new fields.
6. `log()` names the size tier when it fires and the models in use.
7. An in-scope `suggestion` is applied only after surviving one refuter; an out-of-scope one is filed.
8. Every `unverified` finding still defers, at every severity.
9. Every filed deferral issue names the dimension that produced it.
10. The fix-applier runs `testCmd` before committing and reports the result with the SHA; `tests 0` blocks the commit.
11. No path uses `--no-verify`.
12. `select-dimensions.test.mjs` pins every matrix row above and the `model` assignments — and pins that `review-pr.js` still CALLS `selectDimensions`, without which every row pins a copy nothing runs. (No count here on purpose: "nine" was hand-derived against an eleven-row table, which is the defect class #118 exists for.)
13. The rewritten fix-applier assertion fails when the apply/defer split is deleted.

## Unknowns to settle during implementation

Neither may be assumed. Both are cheap to measure.

1. **Does `opts.model` beat `agentType` frontmatter in workflow `agent()`?**
   **Largely resolved — expect it to win.** For the **Agent** tool this is
   established: dispatching `memory-housekeeper` with a `model:` param overrides
   its install-time frontmatter pin, which is exactly why the standing rule is to
   dispatch it by `subagent_type` alone. The Agent tool's own docs state the same
   precedence. Residual risk is narrow: workflow `agent()` with `agentType` is a
   different code path, and only `simplify` and `correctness` have a frontmatter
   pin to beat — and this design deliberately sends **no** `model` for either, so
   even a wrong guess there changes nothing. The three dimensions that do receive
   `"sonnet"` are all `model: inherit`, with no pin to lose to. Confirm on the
   first run by reading the dispatched model off the subagent JSONL; treat a
   surprise as a finding, not a blocker.
2. **Fix-applier refuters are grandchildren.** Their reports surface to the
   controller rather than to the member that dispatched them — the delivery
   failure this workflow exists to eliminate. A dispatching member can read its
   own child's report directly rather than wait for a relay; confirm that on the
   first run and state it in the prompt.

## Invariants

- Unknown, unparseable or empty diff stats widen to the full set. Trimming is only ever driven by an affirmatively-reported profile.
- `dimensionsRun` reports the dispatched set, and a trimmed fan-out must never
  read as full coverage. It is not a coverage claim on its own — a dispatched
  specialist can die, or run and never execute the suite — so `dimensionsUnrun`
  names which of those keys did not cover their ground, and why (#137, #138).
- Refuted findings are returned, not dropped.
- `unverified` is never treated as `survived`.
- No dimension is dropped from `DEFAULT_DIMENSIONS`; trims are per-PR and reversible via `args.dimensions`.

## Out of scope

- **#113** — `args.dimensions` key normalization. It touches the same override path (`review-pr.js:145`, `:261`); keep the diffs disjoint.
- Editing `pr-review-toolkit` agent frontmatter. Vendored third-party, and clobbered on plugin update.
- Re-reviewing the fix commit. Change 4 gates it with tests; a second review pass is a separate decision, and the cost case against it is the point of this ticket.
- Whether `suggestion` should auto-file at all when out of scope. Change 3 keeps the current behaviour for the out-of-scope branch; if the backlog stays large after attribution lands (Change 3, step 5), revisit with data.
