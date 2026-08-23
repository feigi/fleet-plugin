# `fleet` plugin — extracting the deterministic spine of `/run-team`

Date: 2026-07-23
Status: Plan 1 (packaging) and Plan 2 (ci-state, pr-overlap) implemented and
pushed; stale references repointed. Plans 2b, 2c and 3 outstanding.
Artifact: `~/.claude/skills/fleet/` (repo `feigi/claude-config`)
Partly supersedes: `docs/specs/2026-07-22-run-team-agent-fleet-design.md`

## Problem

`/run-team` and its dependencies are five prose artifacts totalling ~53KB, in
which a large fraction of the text is *deterministic procedure written as
instructions to a model*. Two costs follow, and both were named as drivers:

- **Context.** `run-team.md` is 535 lines / 28KB, loaded in full on every
  invocation. Members additionally load `review-and-fix.md` and
  `run-merge-bot.md` in full.
- **Correctness.** Members mis-execute the prose. Observed and recorded in the
  files themselves: a false-green CI read on run `165158547`, a "wait for green"
  instruction with no blocking primitive that stalled every CI cycle, a
  `/clean_gone` grep that cannot match and exits 0, retyped shell with subtle
  divergence between three copies of the same rule.

Maintainability was explicitly *not* a driver, but duplication is the mechanism
behind several correctness failures, so it is addressed as a consequence rather
than a goal.

### Measured duplication

Grep-confirmed across the three commands:

| Rule | Files | Notes |
|---|---|---|
| run-binding four-way check | 3 | three different phrasings of one predicate |
| rerun-rewrites-in-place | 3 | |
| `--limit 1` trap | 3 | |
| `git reset --hard` ban | 3 | **4 sites inside `run-team.md` alone** |
| `skipped` ≠ `passed` | 2 | |
| `--delete-branch` ban | 2 | |
| "Distrust negative claims hardest" | 2 | verbatim |
| correction-ticket hunting | 2 | |

`run-team` SKILL.md's `## Fix the tooling mid-run` already forbids this ("a
duplicated rule becomes a contradiction"). The file violates its own rule
because there was nowhere else to put the shared text.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Scope | All five artifacts, one pass | The duplicated rules span all of them; extracting from `run-team` alone leaves the copies in place |
| Callers | Controller **and** members | Member-facing docs cannot shrink otherwise |
| Runtime | Mixed — bash thin, node structured | Matches the repo (`hooks/` bash, `workflows/` JS); jq is where a silent wrong answer hides |
| Verification | Live proof, no test suite | Accepted with mitigations — see below |
| Packaging | Plugin, source tracked in `claude-config` | `${CLAUDE_PLUGIN_ROOT}` + a conventional shared `scripts/` |
| `run-team` form | Invoke-only skill | `disable-model-invocation: true` |
| Other four | All move into the plugin, each keeping its current form — two commands, two skills | `/review-and-fix` and `/run-merge-bot` are invoked standalone, so nothing is forced into skill shape |
| War stories | Assertion in `SKILL.md`, story in `references/` | Keeps the why without the always-loaded bytes |
| Orchestration | Scripts first, one workflow in stage 2 | Stage each so live proof stays attributable |

### No test suite — and what compensates

Shipping without fixtures was chosen deliberately. The risk it accepts is real
and specific: the failure states that matter most (a cancelled run inheriting a
`pass`, a rerun inverting a conclusion under a fixed run id) are rare and cannot
be summoned on demand, so a live proof cannot cover them.

Three design properties compensate, and they are requirements, not style:

1. **Fail closed.** Unknown or unreachable state exits non-zero with a reason.
   No script exits 0 silently. This is the `/clean_gone` failure mode — a silent
   pass indistinguishable from a clean result — and it is inadmissible.
2. **Evidence on stderr.** Every script prints the commands it ran alongside its
   answer. A script that hides its working recreates the blind-obey failure
   `run-merge-bot.md`'s `## Order, and the hold rule` warns about ("Obeying a
   fired signal blindly stalls the queue on a non-conflict").
3. **No caching, no state.** Every invocation re-queries. Rather than detecting
   a stale or inverted conclusion, the design removes the possibility of holding
   one.

### Why a plugin

- `scripts/` at plugin root is the documented home for **shared utilities**
  (`plugin-structure/SKILL.md:431`, vendored outside this repo so its numbers
  do not rot from here), sitting alongside `skills/<name>/scripts/` for
  skill-private ones — the same file's `### Skills` example structure gives
  `api-testing/` its own `scripts/`. This is exactly the distinction three
  callers need, and it already exists as convention. There is no established convention
  for `~/.claude/scripts/` — zero such directories exist anywhere in the
  installed plugin tree.
- `${CLAUDE_PLUGIN_ROOT}` (`command-development/SKILL.md`'s
  `### CLAUDE_PLUGIN_ROOT Variable`, "an environment variable that resolves to
  the plugin's absolute path", vendored outside this repo) gives portable
  path resolution, eliminating hardcoded `/Users/chris/...` paths inside the
  plugin.
- One versioned unit holds commands *and* skills, so `run-merge-bot` and
  `review-and-fix` are not forced into skill shape to be packaged.

**Constraint, and the mechanism that resolves it:** `plugins/` is gitignored in
`claude-config` (`.gitignore`'s `plugins/` under `# Auto-managed by Claude
Code`; `git ls-files plugins` returns 0), so plugin source cannot live at
`~/.claude/plugins/fleet/` without falling outside the repo that is the backup
and distribution mechanism.

`claude plugin init <name>` scaffolds a plugin at **`~/.claude/skills/<name>/`**,
which auto-loads the next session as `<name>@skills-dir`. This needs no
marketplace manifest, no `--plugin-dir` flag, and no install step. Plugin root
is therefore `~/.claude/skills/fleet/`.

**One gitignore edit is mandatory.** `skills/` is not wholesale tracked either:
`.gitignore`'s `# Skills:` comment block ("Trailing-slash ignore blocks
re-inclusion, so exclude contents and negate") ignores `skills/*` and
re-includes individual directories by negation (`!skills/next-ticket/`,
`!skills/sizing-a-ticket/`, `!skills/caveman-compress/`). Without adding
`!skills/fleet/`, `git add skills/fleet` stages nothing and every packaging
commit is silently empty — the same class of failure as `/clean_gone` exiting 0.
Verify with `git check-ignore -v skills/fleet` before and after. The two
negations for the moved skills are retired once `!skills/fleet/` covers them.

**Measurement instrument:** `claude plugin details fleet` reports a component
inventory plus projected token cost, split always-on vs on-invoke. The context
driver is therefore measurable rather than estimated — which is why packaging
lands before restructuring: install the content unchanged, measure, restructure,
measure again with the same instrument.

**Constraint accepted:** workflows are not a plugin component. Recognized dirs
are `commands/ agents/ skills/ hooks/ scripts/`, and the `Workflow` tool
resolves names from `.claude/workflows/`. Stage 2's `merge-wave.js` therefore
lives outside the plugin and carries one resolved path.

## Layout

```
~/.claude/skills/fleet/              ← tracked; auto-loads as fleet@skills-dir
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   ├── run-merge-bot.md             ← stays a command, slimmed 185 → ~70
│   └── review-and-fix.md            ← stays a command, slimmed 61 → ~30
├── skills/
│   ├── run-team/
│   │   ├── SKILL.md                 ← ~120 lines, disable-model-invocation: true
│   │   └── references/
│   │       ├── ci-and-staleness.md
│   │       ├── isolation.md
│   │       ├── member-lifecycle.md
│   │       ├── reaping.md
│   │       └── correction-tickets.md
│   ├── next-ticket/SKILL.md         ← moved in; query block → candidates.mjs
│   └── sizing-a-ticket/SKILL.md     ← moved in unchanged (25 lines, nothing to extract)
└── scripts/                         ← shared; all callers reach here
    ├── ci-state.mjs    pr-overlap.mjs   ledger.mjs      candidates.mjs
    ├── claim-ticket.sh inflight.sh      verify-sha.sh   reap.sh
    └── worktree-audit.sh  no-undo-audit.sh  prove-merge.sh

~/.claude/workflows/                 ← outside the plugin
├── review-pr.js                     (existing)
└── merge-wave.js                    (stage 2)
```

Everything inside the plugin addresses siblings via `${CLAUDE_PLUGIN_ROOT}`.

## Script surface

All eleven obey the three rules above.

`Non-zero when` states the exits a script can actually produce, verdicts and
preconditions alike: a caller cannot act on a verdict while an operational
failure carries the same code. The codes mean the same thing in every row —
**0** is the answer that was asked for, **1** is a verdict the caller must act
on and never an error, **2** is "the question could not be answered" (bad
argument, no repository, a failed probe or query) and never a finding. A script
with no verdict to report must never exit 1. `ledger.mjs check` mints one further
code, stated in its own row.

| Script | In | Out | Non-zero when |
|---|---|---|---|
| `ci-state.mjs` | `--pr [--base --workflow --workflow-file --declare-no-ci --quiet]` | `{pr, branch, prHead, runId, attempt, runHeadSha, status, conclusion, behind, verdict, reasons[]}`, and `jobs[]`/`missing[]` too unless `--quiet` | exit 1 not bound-green: head mismatch, run incomplete, expected job absent, any job not `success`; also `verdict: no-ci` (no workflow files under `.github/workflows/`) without `--declare-no-ci`, since absence never reads as pass; exit 2 the question could not be answered — bad or missing `--pr`, no such PR, a `gh` query failed, `gh` output that does not parse as JSON, output that parses as JSON but is not the shape the caller is about to read — an error object where an array of runs is expected, a run view missing its jobs, a run-list row or job entry that is not an object (#269) — `git rev-parse --show-toplevel` unable to locate the repo root, `.github/workflows/` present but unreadable, workflow files present under names other than `--workflow` or two sharing it, or a workflow file it cannot derive jobs from (unreadable, a job-level `name:`, or zero jobs). A failed behind-count `git` probe is not one: that probe is deliberately fail-soft, reports `behind: null`, and never changes the exit |
| `pr-overlap.mjs` | `--a --b` | `{a, b, files[], modules[], dirs[], signal}` | exit 2 only — bad usage, or a query failed and the overlap is therefore unknown; every verdict, `none` included, is exit 0: it reports, the model rules |
| `candidates.mjs` | `[--require-label L] [--allow-fallback] [--limit N]` | `[{n,t,l,d}]` | exit 1 the query succeeded and no candidate survived — an empty queue, not an error; exit 2 the query cannot be trusted — malformed invocation, `--allow-fallback` without `--require-label`, `gh` failed, output that is not the shape the `--jq` reduction produces, or a result landing exactly at `--limit` and therefore possibly truncated |
| `inflight.sh` | `<N>` | `{issue, taken, hits[], unknown[], evidence}` | exit 1 the ticket is taken; exit 2 the question could not be answered — a probe that could not look is recorded in `unknown` and the other probes still run, so exit 2 from a probe failure carries the same payload as 0 and 1; a bad argument, no such issue, not a repository, `json.sh` missing or unreadable — the guard fires before any probe, since exit 1 out of this script means `taken` — or the verdict could not be written still exit 2 with no payload at all |
| `verify-sha.sh` | `<branch> <sha>` | `{branch, sha, reachable, tip}` | exit 1 the sha is not reachable on `origin/<branch>`; exit 2 the question could not be answered — bad argument, the fetch failed, `origin/<branch>` does not resolve after it, the sha is not a commit object in this repository, a `merge-base --is-ancestor` that failed rather than answered, `json.sh` missing or unreadable, or a payload field that could not be escaped (#119) |
| `claim-ticket.sh` | `<N> <slug> <type> [--apply]` | `{issue, branch, worktree, install, ports{postgres, ollama}, runner, applied}` | exit 2 only, one code for every refusal — bad argument, not a repository, the worktree or the branch already exists, no lockfile to derive the install command from, no test command to stamp a runner from, `json.sh` missing or unreadable — the guard sits ahead of every mutation — a receipt field that could not be escaped (#119), and under `--apply` a failed label write, worktree add or install, or a lockfile the install mutated |
| `no-undo-audit.sh` | `<worktree> <branch>` | `{worktree, worktreeRewritten, branch, branchRewritten, clean, stash, conflicts[], conflictsRewritten[], atRisk[], atRiskRewritten[]}` | exit 1 the worktree is dirty — the stash count is reported, never gated; `stash` is `null` rather than a number when the list comes back empty and that emptiness is not a genuinely empty stash — either `refs/stash` is not absent (an unreadable ref, an unreadable reflog, or a ref pointing at a missing object) or it is absent while its reflog is not and still names entries no ref points at — which is not the same claim as a genuinely empty stash and is no longer reported as one; exit 2 the question is unanswerable — bad argument, no such worktree, a worktree git does not answer for (its linkage is broken, and git still answers at rc 0 — for the enclosing repo when the `.git` is gone, from another worktree's HEAD and index when it names that worktree's admin dir), a ref that does not resolve, a probe that could not run, a conflicting path no pathspec can name, `json.sh` missing or unreadable, or a payload field that could not be escaped — the conflicts and at-risk arrays included (#119) — and no payload is emitted |
| `prove-merge.sh` | `<pre> <post> <mergeCommit>` | `{proved, preIsAncestor, postIsAncestor, secondParent, firstParent, parentCount, proofPath, headWasCurrent}` | exit 1 any gate fails — the proof is a "no"; exit 2 the question could not be answered — bad argument, the fetch failed, the base does not resolve, an argument is not a commit here, a `merge-base --is-ancestor` that failed rather than answered — which is where a base resolving to a non-commit lands, since only `pre`/`post`/`merge` are commit-checked — the merge is not reachable from the base, it has no second parent and is therefore not a merge, `json.sh` is missing or unreadable, or a proof field could not be escaped (#119) |
| `reap.sh` | `[--apply]` | `{applied, reaped[], kept[{branch, reason}]}` | exit 2 only — more than one argument, an unrecognised argument (the value guard the count guard alone used to let past, so a mistyped `--apply` no longer reads as a clean dry run — #250), not a repository, `json.sh` missing or unreadable (the guard sits above the fetch, so nothing is deleted first), the fetch failed, `${BASE_REF:-origin/main}` does not resolve, or, under `--apply`, `git worktree prune` failed. That last one carries the payload the way `inflight.sh`'s exit 2 does: the record is printed before the prune runs, so it says "the branches were reaped and the housekeeping afterwards failed", never "nothing happened". It is also why no exit 1 remains — that failure used to reach `set -e` and abort mid-run, handing the caller the code reserved for a verdict from a script that has none (#265). A kept branch is a finding at exit 0, refusals included — and a `git cherry` that could not answer is one of them: it lands in `kept[]` as `cherry probe failed — cannot tell if merged: <git's own message>` and is never reaped, since the merged check is the only thing authorizing `-D` and a probe that did not answer authorizes nothing (#264). A refused `git worktree remove` is another, and it says what the refusal actually did: a non-zero exit is no proof the removal had no effect, since git can clear the admin entry and still fail. The registry is re-read and the reason distinguishes `registration intact` from `registration cleared` — the registration is the only thing that read measures, so neither phrase claims anything about what is or is not left on disk; a registry read that itself fails says so rather than guessing either. A failing `git branch -D` likewise names its own step and quotes git's message, newlines collapsed, instead of leaving the cause on the terminal (#391). The sweep continues past both — one refusal must not strand the remaining branches — this script deletes nothing on disk beyond what `git worktree remove` itself does, and the dry run is unchanged, since it prints `would remove worktree` without attempting the removal and so cannot foresee a refusal. Every string in the payload — branch names and reason strings alike — goes through `json.sh`'s `jstr`; a field that could not be rendered is reported as `null` rather than aborting a run that has already deleted branches (#119) |
| `worktree-audit.sh` | — | `[{worktree, branch, ahead, dirty, dirtyFiles[], readable}]` | exit 2 only — not a repository, `${BASE_REF:-origin/main}` does not resolve, `json.sh` is missing or unreadable (that guard fires above the opening `[`, so nothing is emitted), or an entry could not be escaped (#119) — that one fires inside the emitting loop, so stdout carries the array truncated mid-element and unparseable, which the exit 2 and the named stderr line are what distinguish from a complete answer. A worktree that is dirty, missing on disk or unreadable is a finding at exit 0 |
| `ledger.mjs` | `row/filed/ruled/check/read [--file <path>] [--require-file]` | one object per subcommand — `row` `{ticket, line, created}`, `filed` `{issue, subject, total}`, `ruled` `{pr, decision, total}`, `check` `{subject, found, match, ledger, verdict}`, and `near`/`nearTotal`/`tracker` besides unless this subject was already filed in this run, `read` the whole ledger as `{rows[], filed[], ruled[]}`. `ledger.ok` is false when there was no ledger file to read and when what was there did not parse as one, the peer of `tracker.ok` (#231). Both of `check`'s lists are capped, and both caps are named in the payload rather than left inferable (#154): `nearTotal` is how many scoring near-misses there were in all, the ones the top-3 `near` cap withheld included, while `tracker.truncated` only reports that gh returned more rows than `tracker.hits` shows, never how many, since gh reports no total | `check` alone reaches a verdict: exit 1 the subject was already filed in this run, exit 3 this run's ledger is clean but the tracker has matching issues — review before filing. Exit 2 on any subcommand — bad usage, unknown subcommand, `--require-file` with no ledger file, or a ledger that cannot be read or written |

### The three carrying real risk

**`claim-ticket.sh`** selects the install command from the lockfile —
`package-lock.json` → `npm ci`, `pnpm-lock.yaml` → `pnpm i --frozen-lockfile`,
`yarn.lock` → `yarn --immutable`. No match → refuse. This converts
`run-team` SKILL.md's `## Phase 1 — claim and isolate` rule "**Infer `<install>`
— never default to `npm install`.**" from a rule the model can forget into a
case statement it cannot. It also emits the `agent-test` runner with ports
derived from `<N>` and adds it to
`.git/info/exclude`, so the isolation envelope stops being a step the controller
might skip.

**`reap.sh`** defaults to dry-run; `--apply` deletes. Every precondition is
recomputed inside the same invocation, because a branch list from an earlier
call is already false — `run-team`'s `references/reaping.md`, under `## Why the
reap is shaped the way it is`, records "one observed run listed 28 gone branches,
two calls later 27 reaped by concurrent session".

**`no-undo-audit.sh`** refuses rather than repairs. It runs steps 1/2/3/5 of the
existing audit and returns the at-risk commits. Step 4 — resolution strategy —
stays prose, because it is judgement.

## Documentation restructure

`SKILL.md` keeps only the controller loop: the two silent-failure rules (a name
carries the `Agent` tool; fresh context per member), phase 0's seven steps as
script-call + judgement pairs, phase 1 as one script call, the verbatim dispatch
prompt blocks, the event-loop table, queue-depth table, invariants, failure
table. Every rule with a story keeps its one-line assertion and gains a pointer.

| Reference | Carries |
|---|---|
| `ci-and-staleness.md` | run-binding, rerun-in-place, `skipped`≠`passed`, `--limit 1`, stale-green mechanics, why the behind-count is the only honest signal |
| `isolation.md` | filesystem vs stack isolation, `agent-test` rationale, scratchpad namespacing, IDE diagnostics attributing by bare filename |
| `member-lifecycle.md` | why the name carries the `Agent` tool, fresh context, killed vs idle vs truncated, grandchild notifications, authorizing the fan-out |
| `reaping.md` | why not `/clean_gone`, `for-each-ref` over `branch\|grep`, the `git cherry` justification for `-D`, per-branch recompute |
| `correction-tickets.md` | why a correction ticket ships a fresh wrong claim — inherited from the ticket, and minted in prose the ticket never asked for — and why the check belongs on the implementer as much as the reviewer |

Stories live beside the rule they justify. There is no separate war-stories
file: a story separated from its rule needs two lookups, and the rule reads as
arbitrary on its own — which is how rules get deleted.

### Dedup resolution

| Rule | Becomes |
|---|---|
| run-binding four-way check | `ci-state.mjs` enforces · `ci-and-staleness.md` explains |
| rerun rewrites in place | same — the no-caching rule removes the failure mode |
| `--limit 1` trap | `ci-state.mjs` hardcodes `--workflow CI` |
| `skipped` ≠ `passed` | `ci-state.mjs` verdict |
| `git reset --hard` ban | `no-undo-audit.sh` refuses · one invariant line |
| `--delete-branch` ban | one invariant line |
| "Distrust negative claims hardest" | `review-and-fix.md` only — it is reviewer-facing |
| correction-ticket hunting | `references/correction-tickets.md`; cited from `run-team` SKILL.md, restated inline in `review-and-fix.md` |
| behind-count | `ci-state.mjs` returns it |

**Deliberate asymmetry:** `run-merge-bot.md` keeps the full hold-rule prose even
though `pr-overlap.mjs` computes the three signals, because "a fired signal is
not a verdict — disprove it" is the load-bearing part and it is pure judgement.

Target for `run-team`: **~10.3k → ~3k tokens on-invoke**, with references pulled
only when a member needs the why. Measured, not estimated — see the baseline
below. Plan 3's acceptance is a re-run of `claude plugin details fleet`.

## Stage 2 — `merge-wave.js`

Takes `{prs[]}`; owns the sequence per PR in numeric order:

1. `pr-overlap.mjs` against each lower unlabeled PR. When a signal fires, spawn
   an `agent()` to rule related / not-related. Judgement is delegated to an
   agent; **sequencing** belongs to the script.
2. `no-undo-audit.sh` → refuse, proceed, or stop for a human on exit 2.
3. Rebase, push.
4. **The wait loop** —
   `while (!green && attempts < 6) { await agent('gh run watch <rid> --exit-status'); green = await agent('ci-state.mjs …') }`.
   This is the reason stage 2 exists. A JS loop holds across turns, so the wait
   has a mechanism rather than an instruction. The turn-based stall has already
   been patched twice with more prose. Six attempts against a ~5-6 minute CI
   cycle bounds the wait at roughly half an hour before the PR is reported stuck
   rather than silently waited on; `gh run watch` outliving a shell timeout is a
   re-issue, not a failed attempt.
5. Re-check behind-count before **each** merge — deterministic, in JS.
6. `prove-merge.sh`, then confirm the merge landed.

`review-pr.js` established this pattern and its header states the rationale: the
failure being replaced is *delivery, not analysis*.

**`claim-wave.js` was considered and cut.** Once `claim-ticket.sh` exists, a
workflow wrapping it buys nothing — its only purpose was serialization, and one
script invocation per ticket in a shell loop already serializes. Adding it would
be appending where `run-team` SKILL.md's `## Fix the tooling mid-run` says
"Cut before you append."

Parse `args` defensively at the top: the `Workflow` tool can deliver `args` as a
JSON string rather than a value.

## Rollout

Stage 1 splits into three plans, each producing working software on its own.
Plans 2 and 3 are written only after plan 1 lands, because plan 1 resolves the
open items their tasks would otherwise assume.

**Plan 1 — packaging.** Commit the pending working-tree changes first. Scaffold
`fleet` via `claude plugin init`. Move all five artifacts in **unchanged**,
deleting each original in the same commit — rollback is `git revert`, never two
live copies of `/run-team` racing each other. Verify all five resolve and settle
the namespacing question. Record `claude plugin details fleet` as the **baseline
token measurement**.

**Plan 2 — scripts.** Eleven scripts, each proven live before the next is
written: `ci-state` against a green PR *and* one with a missing job;
`pr-overlap` against a known-related and a known-unrelated pair; `reap.sh`
dry-run against the real gone-branch set; `no-undo-audit` against a live
worktree. Proving ground is `/Users/chris/dev/agent-brain`. Ends with the
`settings.json` Bash allowlist for the resolved script prefix — a maintainer
edit, since `run-team` SKILL.md's `## Fix the tooling mid-run` bars members from
touching `settings.json` ("Never `settings.json`, permissions, or CLAUDE.md").

**Plan 3 — restructure.** `SKILL.md` slimmed, five references extracted, dedup
applied, commands pointed at scripts. Acceptance is `claude plugin details
fleet` against plan 1's baseline, plus one live fleet run.

Stage 2 lands only after that run.

## Open items — verify at implementation time, do not assume

**Resolved by Plan 1:** the marketplace directory-source schema — no marketplace
is needed at all, `claude plugin init` puts the plugin under `~/.claude/skills/`
where it auto-loads as `<name>@skills-dir`. Removed from this list.

**Resolved by Plan 1, empirically:** namespacing is **mandatory**. After
`/reload-plugins`, only `/fleet:review-and-fix` resolves — no bare alias. The
reloaded skill listing shows `fleet:review-and-fix`, `fleet:run-merge-bot`,
`fleet:next-ticket`, `fleet:sizing-a-ticket`, every one namespaced. The earlier
"leaning bare-works" reading of `manifest-reference.md` was wrong.

**Resolved by Plan 1, as prep for Plan 2:**

- **`${CLAUDE_PLUGIN_ROOT}` does NOT reach an agent-constructed Bash call.** It is
  unset in the environment (this session exposes ten other `CLAUDE_*` vars, not
  that one), so it is template interpolation inside plugin component files, not
  an exported variable. **Consequence for Plan 2: scripts are invoked by resolved
  absolute path**, and the `settings.json` Bash allowlist targets that path.
  `${CLAUDE_PLUGIN_ROOT}` remains correct *inside* command and skill markdown.
  Residual doubt: the test was run outside a plugin component context; the
  airtight version is a subagent dispatched by a plugin skill. The documented
  usage shape agrees, so Plan 2 proceeds on resolved paths.

- **The expected-job list is five, not four.** `agent-brain`'s `.github/workflows/ci.yml`
  defines `rebase-check`, `check`, `integration`, `integration-docker`, `mutation`,
  no `name:` overrides, so job ids equal the names `gh run view --json jobs`
  reports — verified against real run `166001777`. **`integration-docker` appears
  nowhere in the fleet's prose**, which only ever discusses the other four; an
  expected-job list built from the documents would have silently missed it. This
  is the argument for `ci-state.mjs` deriving the list from the workflow file
  rather than hardcoding it. Run `166001777` is also a live `skipped ≠ passed`
  fixture: `check: success` with the other four `skipped`.

### Stale-reference work list — RESOLVED, not Plan 3's

Packaging invalidated references inside the moved documents. Swept
systematically once namespacing was settled, because that answer widened the
defect class from dead file paths to dead invocation names.

**All of it is done.** It was pulled out of Plan 3 into its own plan
(`docs/plans/2026-07-23-fleet-repoint-stale-references.md`) and landed in
`a03258e` and `d739b0b`, because it depended on no scripts and the two top rows
were why `/fleet:run-team` did not work at all. Plan 3 inherits none of it.

**Citation convention — read this before adding a row.** A citation into another
file names a **quoted fragment and its section**, never a bare line number: a
fragment survives renumbering, a number does not. Every count states the command
that produces it and the ref it was run against, so the next reader re-runs it
instead of trusting it. Deliberately historical rows — describing another
document *as it stood* — keep their numbers and name the ref those numbers were
measured at.

Sweep the whole directory for this class with:

```
$ grep -rnoE '(`|[A-Za-z0-9_./-]+):[0-9]+(-[0-9]+)?' docs/specs/
```

Run at `5cd42be` it returns 161 hits across five of the six specs. The pattern
matches only a citation's **leading** `path:NN` — comma-chained continuations
and bare back-references such as `(:429)` are invisible to it, and a site built
only from those is reported zero times — so pair it with

```
$ grep -rnE '(^|[^A-Za-z0-9_./`-]):[0-9]+' docs/specs/
```

which at `5cd42be` surfaces three sites the first command never reports: this
file's `:84`, and `:149` and `:150` of the read-rules spec. #117 classified all
161 plus those three, and re-anchored this document's nine live ones — the eight
the first command reports, plus the `(:429)` at `:84` it does not. Nine is what
was re-anchored, not what was live: four bare-numbered citations into other files
survived it. Three — `command-development/SKILL.md:564`, `.gitignore:40` and
`.gitignore:49` — resolved but named no section; #282 re-anchored each to a
fragment and its section. `plugin-structure/SKILL.md:431` keeps its number,
exempt above as vendored.

Line numbers in the **Site** column of both tables in this section, and in the
prose between them, are the **pre-fix** ones, measured at `eacc5cf`. They are the
record of what was wrong, not pointers into the current files — resolve them at
the ref they were measured at, where each still lands exactly on the content its
row describes: `git show eacc5cf:<path> | sed -n '<N>p'`.

| Site (pre-fix lines) | Was | Became | Severity |
|---|---|---|---|
| `run-team` SKILL.md:183 | `~/.claude/commands/review-and-fix.md` | `~/.claude/skills/fleet/commands/review-and-fix.md` | **was broken** — fixed |
| `run-team` SKILL.md:227 | `~/.claude/commands/run-merge-bot.md` | `~/.claude/skills/fleet/commands/run-merge-bot.md` | **was broken** — fixed |
| `next-ticket` SKILL.md:80 | `/review-and-fix` **and** `/run-merge-bot` | `/fleet:review-and-fix`, `/fleet:run-merge-bot` | **was broken** — named two dead commands, both fixed |
| `run-merge-bot.md:156` | "(`/run-team`, or any caller…)" | `/fleet:run-team` | minor — fixed |
| `run-team` SKILL.md:257, :531 | `/clean_gone` | `commit-commands:clean_gone` | minor — fixed |

Verified as **not** needing change: `review-and-fix.md:6` already calls
`/pr-review-toolkit:review-pr` in namespaced form; `run-team` SKILL.md:330-337
references `/triage`, which stays bare because `triage` is a personal skill in
`~/.claude/skills/`, not plugin-packaged.

### Sites the first sweep missed — found by the Plan 1 final review

The sweep above was run against the plugin only. Four more sites existed, same
defect class. **Three are fixed**, in the same two commits; the fourth — this
spec's own line-numbered citations into the fleet skill — had only its path half
fixed and is **still open**. Kept as the record of how an incomplete sweep looks
— the first pass found five sites and was confidently reported as complete.

| Site | Problem, and where it stands |
|---|---|
| `next-ticket` SKILL.md:80 | **Fixed.** Named **two** dead commands, not one — the row above quotes only `/review-and-fix`; the same line ended `→ `/run-merge-bot` merges in numeric order`. Fixing the row as written would have repaired half a line. |
| `docs/specs/2026-07-22-run-team-agent-fleet-design.md` | **Fixed.** 4 dead `~/.claude/commands/…` paths and 7 bare `/run-team` references **as measured at `a03258e^`**; both counts are **0** at `origin/main`. **Was not a dead document** — `run-team` SKILL.md still routes the reader to it from the opening prose above `## Rules that fail silently`, on the line beginning "Rationale:", so it was reachable and wrong. **This spec's own** `## Migration debt` entry, saying it "gets a pointer to this document rather than an edit", was written before anyone knew its paths would die. |
| `workflows/review-pr.js:6` | **Fixed.** Its `whenToUse` string read "Called per-PR by `/run-team`" — user- and model-facing, rendered in the skill listing, and named a command that no longer existed in any form. The spec's "Out of scope — rewriting `review-pr.js`" did not shelter it: a one-string description fix is not a rewrite. |
| Every **live** line-numbered citation into `run-team` SKILL.md from **this** spec (the pre-fix ones in the tables of this section are exempt — see the marker above) | **Fixed in #117.** Here only the path half was fixed: `run-team.md:NNN` no longer occurred, but the numbers were never re-resolved and none of them pointed at their claimed content. The offsets are **not uniform** and were never **+2**. The worked example this row used to give — the Plan 2 instruction citing the `settings.json` prohibition at `:423` — is off by **+126**: that rule is the **Scope** paragraph of `## Fix the tooling mid-run`, reading "Never `settings.json`, permissions, or CLAUDE.md — a member asking for those is laundering". The claimed "28 gone branches" figure has **no match in `run-team` SKILL.md at all** — it moved into that skill's `references/reaping.md`, which still carries it verbatim ("one observed run listed 28 gone branches, two calls later 27 reaped by concurrent session"), so this citation lost its target rather than never having had one. The stated cause does not carry the rot either, and not for the reason previously given here. These numbers were measured at `eacc5cf`, where the rule already sat at `:422` under a **5**-line frontmatter — so the 4-line *command* frontmatter (`b915414`, a 232-line file that never had a `:423` at all) is not in this citation's history. Frontmatter accounts for **1** line of the 127-line move from where the rule actually sat (`:422` → `:549`), 5 → 6 between `eacc5cf` and `b1137bd`; the other **126** is body growth above it, the file going 536 → 675 lines. The `+126` above is measured against the cited `:423`, which was already one line below the rule at `eacc5cf`. No single delta repaired these, so #117 re-anchored each to a fragment individually; #282 then re-anchored this file's remaining live citations, into `command-development/SKILL.md` and `.gitignore`. Every live citation in this spec now names a quoted fragment and its section, per the convention marker above — save the vendored `plugin-structure/SKILL.md:431`, exempt where it is cited. |

Every figure in the `2026-07-22` spec row and the line-numbered-citation row,
with the command that produces it (re-derived 2026-07-31, when `origin/main` was
`b1137bd` — the outputs below are pinned to that commit, not to wherever the
branch has since moved):

```
$ git show a03258e^:docs/specs/2026-07-22-run-team-agent-fleet-design.md | grep -c '~/.claude/commands/'
4
$ git show origin/main:docs/specs/2026-07-22-run-team-agent-fleet-design.md | grep -c '~/.claude/commands/'
0
$ git show a03258e^:docs/specs/2026-07-22-run-team-agent-fleet-design.md | grep -cE '/run-team([^/a-zA-Z-]|$)'
7
$ git show origin/main:docs/specs/2026-07-22-run-team-agent-fleet-design.md | grep -cE '/run-team([^/a-zA-Z-]|$)'
0
$ git show origin/main:skills/fleet/skills/run-team/SKILL.md | grep -n 'settings.json'
549:*this run produced*. No speculative polish. Never `settings.json`, permissions, or
$ git show origin/main:skills/fleet/skills/run-team/SKILL.md | grep -c '28 gone'
0
$ git show eacc5cf:skills/fleet/skills/run-team/SKILL.md | grep -n 'settings.json'
422:*this run produced*. No speculative polish. Never `settings.json`, permissions, or
$ git show eacc5cf:skills/fleet/skills/run-team/SKILL.md | grep -n '^---'
1:---
5:---
$ git show origin/main:skills/fleet/skills/run-team/SKILL.md | grep -n '^---'
1:---
6:---
$ git show eacc5cf:skills/fleet/skills/run-team/SKILL.md | grep -c ''
536
$ git show origin/main:skills/fleet/skills/run-team/SKILL.md | grep -c ''
675
$ git show b915414:commands/run-team.md | grep -n '^---'
1:---
4:---
$ git show b915414:commands/run-team.md | grep -c ''
232
```

`549 - 423 = 126`. The two `/run-team` hits remaining at `origin/main` are both
path fragments inside `~/.claude/skills/fleet/skills/run-team/SKILL.md`, which is
why the bare-command count is 0 while the literal substring still appears.

**Also decided here:** every cross-reference to a sibling fleet component inside
`run-team` SKILL.md is a **bare backticked name in running prose**, never a slash
invocation — its opening line naming the three components it runs as one fleet,
and the `next-ticket` / `sizing-a-ticket` mentions in `## Phase 0 — shortlist`
and `## Phase 2 — dispatch implementers`. Measured at `eacc5cf`, where the count
of slash invocations is **0**:

```
$ git show "eacc5cf:skills/fleet/skills/run-team/SKILL.md" \
    | grep -cE '(^|[ (`])/(next-ticket|review-and-fix|run-merge-bot|sizing-a-ticket)'
0
```

`next-ticket` SKILL.md was **not** in that state, and this claim used to include
it: the same command returns **1** there, the `**Session ends here.**` line the
migration table above records as fixed, which invoked `/review-and-fix` and
`/run-merge-bot` in slash form. That is *why* namespacing broke nothing **in
`run-team`**: the model resolves those by description, not by literal name. It
is luck rather than design, and Plan 3 decides deliberately whether to keep
depending on it.

**No open item remains.** All four items this section opened with are answered
above.
The superseded bullets that used to sit here — restating namespacing,
`${CLAUDE_PLUGIN_ROOT}` and the expected-job list as unresolved — were deleted
rather than annotated, because a rule stated twice at two confidence levels is
the contradiction `run-team`'s own text warns about, and a reader who jumps to
"Open items" would have taken three wrong answers away.

Worth keeping from that material, because it misleads on sight: `claude plugin
details` reports plugin **commands** under `Skills (N)`. There is no `Commands`
line. `commit-commands` ships only a `commands/` directory and reports
`Skills (3)`.

## Final measurement (Plan 3, 2026-07-23)

Captured with `claude plugin details fleet` after the restructure — war stories
moved to `references/`, every deterministic block wired to its script.

```
                before (Plan 1)   after (Plan 3)   references (on-demand only)
run-team              ~10.3k           ~8.3k        5 files, ~13.4k chars off the on-invoke path
run-merge-bot          ~5.1k           ~4.7k
review-and-fix         ~3.9k           ~3.8k
always-on              ~302            ~302
```

**The spec's ~3k target for `run-team` was wrong, and this is the honest number.**
The target was a byte-estimate guess, never an analysis of the document. Of
`run-team`'s ~22.8k body chars, only ~110 lines were pure movable war-story;
those went to `references/`. The rest is the 33 pinned assertions plus
operational procedure — the phases, the event-loop and queue-depth tables, the
verbatim dispatch-prompt blocks members receive, the invariants. None of that is
deletable without losing a rule (forbidden by the manifest) or changing
behaviour (forbidden outright). **~8.3k is close to the floor**, and the real
structural win is that ~13.4k chars of rationale now load only when a member
opens a reference, not on every invocation.

`run-merge-bot` and `review-and-fix` shrank little because they are mostly
judgment — the reasoning that must stay prose. Wiring replaced their command
blocks with script calls; it did not and could not remove the judgment those
documents exist to carry.

**A correction to this spec's own dedup plan, made on implementation.** The
earlier "Dedup resolution" table assumed one reader and proposed collapsing
rules like "Distrust negative claims" to a single document. That is wrong: the
three documents have **three reader-isolated audiences** — the controller reads
`run-team` SKILL.md, a merge-bot member reads `run-merge-bot.md`, a reviewer
reads `review-and-fix.md`, and no member ever sees the others. A rule a reader
needs must live in that reader's document; collapsing it away blinds that reader.
So cross-document rule copies were **kept** — they are necessary redundancy
across audiences, not the contradiction risk the "move don't duplicate" rule
targets. That rule applies within one reader's document (assertion in SKILL,
story in its own `references/`), which is the split that was applied. No rule was
lost: every pattern in `docs/fleet-rule-manifest.txt` resolves somewhere under
`skills/fleet/`, swept against that tree at `origin/main` `368dc67`
(2026-08-17). Two pins had drifted off rules that were reworded rather than
dropped, and were repointed to the surviving text — the repair `3db006c` had
already made for a third. The manifest itself was retired in
#241 once this restructure had completed — nothing read it, and its contents
survive in git history.

## Baseline measurement (Plan 1, 2026-07-23)

Captured with `claude plugin details fleet` at commit `eacc5cf` — after
packaging, before any restructuring — so Plan 3's acceptance compares like with
like. Content is byte-identical to the pre-plugin originals, so these numbers
are the true cost of today's prose.

```
Always-on:   ~302 tok   added to every session

component        always-on  on-invoke
next-ticket            ~70      ~1.5k
sizing-a-ticket        ~70       ~450
run-team               ~70     ~10.3k
run-merge-bot          ~50      ~5.1k
review-and-fix         ~30      ~3.9k
```

Three things this measurement changes:

1. **The pre-measurement claim was a size target, not a token estimate.** What
   was on record was "28KB → roughly 6KB". The instrument reports **~10.3k
   tokens on-invoke**, so the target is now stated in the same unit the
   acceptance check reads. (An earlier draft of this section claimed 28KB "was
   reasoned to ~7k tokens" — no such estimate was ever written down; it was
   retrofitted to make the correction look sharper. Deleted.)
2. **The controller pays the on-invoke cost, and no one else does.** Members do
   not invoke `run-team` — SKILL.md dispatches a reviewer with the PR number and
   tells it to *read* `review-and-fix.md` as a file path, explicitly "not a slash
   invocation", and does the same for the merge bot. So the per-actor costs are:
   controller ~10.3k, reviewer ~3.9k, merge bot ~5.1k. Their sum, ~19.3k, is a
   figure **no actor pays**; an earlier draft of this section headlined it as
   "the real number", which was wrong.

   The corrected framing is the stronger one: the controller carries ~10.3k of
   that total single-handed, and the controller is exactly what `references/`
   splits.

   **Consequence Plan 3 must not get wrong:** because members `Read` these files
   rather than invoking them, `claude plugin details`' `on-invoke` column does
   not measure member cost. Moving text into `references/` cuts on-invoke but
   does not cut a `Read` of the whole file. Plan 3 may claim a controller-side
   win from a `details` delta; it may **not** claim a member-side win from one.
3. **Always-on is already cheap (~302 tok) and is not the problem.** Plan 3
   should not spend effort shrinking it. The win is entirely in on-invoke, which
   is exactly what the `references/` split targets — a reference costs nothing
   until something reads it.

## Migration debt

- **Settled and paid.** Invocation names *did* change — namespacing is
  mandatory, so every fleet component is now reached as `/fleet:run-merge-bot`,
  `/fleet:review-and-fix`, `fleet:next-ticket`. Independently, `run-team`'s body
  had pointed members at `~/.claude/commands/run-merge-bot.md` and
  `~/.claude/commands/review-and-fix.md`, paths Plan 1 Task 3 emptied — which is
  why the fleet did not run at all between packaging and the repoint. Both
  classes were fixed in `a03258e` and `d739b0b`.

  Repointed at **resolved absolute paths, not `${CLAUDE_PLUGIN_ROOT}`** as this
  section originally proposed. That variable is confirmed unset in a Bash call,
  and whether it interpolates inside a skill body a member reads as text is
  still untested — repairing a broken path with an unproven one is not a repair.
  Plan 3 may switch after testing it.
- Two memories reference the old command paths (the `/ship-it` → `/review-and-fix`
  replacement record, and the `/run-merge-bot` creation record). Update at the
  end, not before.
- `docs/specs/2026-07-22-run-team-agent-fleet-design.md` gets a pointer to this
  document rather than an edit. Its probe results (the four-cell naming table,
  members lacking `Workflow` and `TaskOutput`) remain valid and are still cited.

## Out of scope

- A test suite. Explicitly declined; see the compensating properties above.
- Changing what the fleet *does* — admission policy, caps, the human multi-select
  gate, and every judgement call are preserved exactly.
- Cross-repo operation.
- Rewriting `review-pr.js`. It already embodies this design and is untouched.
