# `fleet` plugin — extracting the deterministic spine of `/run-team`

Date: 2026-07-23
Status: approved design, not yet implemented
Artifact: `~/.claude/fleet/` (repo `feigi/claude-config`)
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

`run-team.md:424-427` already forbids this ("a duplicated rule becomes a
contradiction"). The file violates its own rule because there was nowhere else
to put the shared text.

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
   `run-merge-bot.md:52` warns about.
3. **No caching, no state.** Every invocation re-queries. Rather than detecting
   a stale or inverted conclusion, the design removes the possibility of holding
   one.

### Why a plugin

- `scripts/` at plugin root is the documented home for **shared utilities**
  (`plugin-structure/SKILL.md:431`), sitting alongside `skills/<name>/scripts/`
  (:429) for skill-private ones. This is exactly the distinction three callers
  need, and it already exists as convention. There is no established convention
  for `~/.claude/scripts/` — zero such directories exist anywhere in the
  installed plugin tree.
- `${CLAUDE_PLUGIN_ROOT}` (`command-development/SKILL.md:564`) gives portable
  path resolution, eliminating hardcoded `/Users/chris/...` paths inside the
  plugin.
- One versioned unit holds commands *and* skills, so `run-merge-bot` and
  `review-and-fix` are not forced into skill shape to be packaged.

**Constraint, and the mechanism that resolves it:** `plugins/` is gitignored in
`claude-config` (`.gitignore:40`; `git ls-files plugins` returns 0), so plugin
source cannot live at `~/.claude/plugins/fleet/` without falling outside the
repo that is the backup and distribution mechanism.

`claude plugin init <name>` scaffolds a plugin at **`~/.claude/skills/<name>/`**,
which auto-loads the next session as `<name>@skills-dir`. This needs no
marketplace manifest, no `--plugin-dir` flag, and no install step. Plugin root
is therefore `~/.claude/skills/fleet/`.

**One gitignore edit is mandatory.** `skills/` is not wholesale tracked either:
`.gitignore:49` ignores `skills/*` and re-includes individual directories by
negation (`!skills/next-ticket/`, `!skills/sizing-a-ticket/`,
`!skills/caveman-compress/`). Without adding `!skills/fleet/`, `git add
skills/fleet` stages nothing and every packaging commit is silently empty — the
same class of failure as `/clean_gone` exiting 0. Verify with `git check-ignore
-v skills/fleet` before and after. The two negations for the moved skills are
retired once `!skills/fleet/` covers them.

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

| Script | In | Out | Non-zero when |
|---|---|---|---|
| `ci-state.mjs` | `--pr --branch` | `{rid, attempt, headSha, branchHead, prHead, status, jobs[], missing[], behind, verdict}` | not bound-green: head mismatch, run incomplete, expected job absent, any job not `success` |
| `pr-overlap.mjs` | `--a --b` | `{files[], modules[], dirs[], signal}` | never — it reports, the model rules |
| `candidates.mjs` | `[--require-label L]` | `[{n,t,l,d}]` | `gh` failure only; empty result is exit 0 with `[]` |
| `inflight.sh` | `<N>` | `{taken, probe, evidence}` | never — reports |
| `verify-sha.sh` | `<branch> <sha>` | `{reachable, log}` | sha not reachable on branch |
| `claim-ticket.sh` | `<N> <slug> <type>` | `{worktree, branch, ports, runner}` | lockfile dirty after install, worktree exists, label write failed |
| `no-undo-audit.sh` | `<worktree> <branch>` | `{clean, stash[], conflicts[], atRisk[]}` | worktree dirty or stash non-empty |
| `prove-merge.sh` | `<pre> <post> <mergeCommit>` | `{preIsAncestor, postIsAncestor, secondParent}` | any leg of the proof fails |
| `reap.sh` | `[--apply]` | `{reaped[], kept[{branch,reason}]}` | never — refusals are findings |
| `worktree-audit.sh` | — | `[{worktree, commits, dirty[]}]` | never |
| `ledger.mjs` | `set/filed/ruled/read` | row or list | ledger unreadable |

### The three carrying real risk

**`claim-ticket.sh`** selects the install command from the lockfile —
`package-lock.json` → `npm ci`, `pnpm-lock.yaml` → `pnpm i --frozen-lockfile`,
`yarn.lock` → `yarn --immutable`. No match → refuse. This converts
`run-team.md:76-86`'s "infer `<install>`, never default to `npm install`" from a
rule the model can forget into a case statement it cannot. It also emits the
`agent-test` runner with ports derived from `<N>` and adds it to
`.git/info/exclude`, so the isolation envelope stops being a step the controller
might skip.

**`reap.sh`** defaults to dry-run; `--apply` deletes. Every precondition is
recomputed inside the same invocation, because a branch list from an earlier
call is already false — `run-team.md:290-292` records 28 gone branches of which
27 had been reaped by a concurrent session two calls later.

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
| `ci-and-staleness.md` | run-binding, rerun-in-place, `skipped`≠`passed`, `--limit 1`, stale-green mechanics, behind-count decay (0→2→7→10) |
| `isolation.md` | filesystem vs stack isolation, `agent-test` rationale, scratchpad namespacing, IDE diagnostics attributing by bare filename |
| `member-lifecycle.md` | the four-cell naming probe, fresh context, killed vs idle vs truncated, grandchild notifications, authorizing the fan-out |
| `reaping.md` | why not `/clean_gone`, `for-each-ref` over `branch\|grep`, the `git cherry` justification for `-D`, per-branch recompute |
| `correction-tickets.md` | the four-for-four finding, why the mechanism is the ticket's framing, the implementer's clause-by-clause duty |

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
| correction-ticket hunting | `references/correction-tickets.md`; both callers point at it |
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
2. `no-undo-audit.sh` → refuse or proceed.
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
be appending where `run-team.md:427` says cut.

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
edit, since `run-team.md:421` bars members from touching `settings.json`.

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

### Stale-reference work list for Plan 3

Packaging invalidated references inside the moved documents. Swept
systematically once namespacing was settled, because that answer widened the
defect class from dead file paths to dead invocation names.

| Site | Currently | Should be | Severity |
|---|---|---|---|
| `run-team` SKILL.md:183 | `~/.claude/commands/review-and-fix.md` | plugin-relative path | **broken** |
| `run-team` SKILL.md:227 | `~/.claude/commands/run-merge-bot.md` | plugin-relative path | **broken** |
| `next-ticket` SKILL.md:80 | "`/review-and-fix` → maintainer adds…" | `/fleet:review-and-fix` | **broken** — instructs the reader to run a command that does not exist |
| `run-merge-bot.md:156` | "(`/run-team`, or any caller…)" | `/fleet:run-team` | minor — identifies a caller, does not invoke |
| `run-team` SKILL.md:257, :531 | `/clean_gone` | `commit-commands:clean_gone` | minor — both are prohibitions ("do not invoke") |

Verified as **not** needing change: `review-and-fix.md:6` already calls
`/pr-review-toolkit:review-pr` in namespaced form; `run-team` SKILL.md:330-337
references `/triage`, which stays bare because `triage` is a personal skill in
`~/.claude/skills/`, not plugin-packaged.

- Whether bare aliases (`/review-and-fix`) still resolve alongside namespaced
  ones (`/fleet:review-and-fix`), or whether the namespaced form is mandatory.
  **Still open after Plan 1 Task 3.** Evidence so far, none of it conclusive:
  `manifest-reference.md` calls command namespacing "optional";
  `command-development/SKILL.md:378` shows a namespaced command invoked as
  `/build` with `(project:ci)` as a display label, but that example is project
  commands, not plugin ones; and `claude plugin details` lists bare component
  names for both `fleet` (`review-and-fix, run-merge-bot`) and `commit-commands`
  (`clean_gone, commit, commit-push-pr`) — which reflects how the inventory
  *names* components, not how they are *invoked*. Settled only by inspecting
  slash-command completion in a session after `/reload-plugins`, which is Plan 1
  Task 6's acceptance step.

  Also learned in Task 3, and worth recording because it misleads: `claude
  plugin details` reports plugin **commands** under `Skills (N)`. There is no
  `Commands` line. `commit-commands` ships only a `commands/` directory and
  reports `Skills (3)`.
- Whether `${CLAUDE_PLUGIN_ROOT}` is interpolated only in plugin component files
  or is also available to a Bash call an agent constructs. The fallback is that
  agents invoke scripts by resolved absolute path, which is what the permission
  allowlist targets either way.
- The expected-job list `ci-state.mjs` checks for absence against. Derive it
  from the workflow definition rather than hardcoding.

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

1. **The byte estimate was low.** 28KB was reasoned to ~7k tokens; the
   instrument says **~10.3k**. Every later claim uses the instrument.
2. **The real number is the member's, not the controller's.** A reviewer reads
   `run-team` *and* `review-and-fix`; a merge bot reads `run-team` *and*
   `run-merge-bot`. The fleet's three core documents total **~19.3k on-invoke**,
   which is the figure the restructure has to move.
3. **Always-on is already cheap (~302 tok) and is not the problem.** Plan 3
   should not spend effort shrinking it. The win is entirely in on-invoke, which
   is exactly what the `references/` split targets — a reference costs nothing
   until something reads it.

## Migration debt

- Invocation names **may** change to `/fleet:run-merge-bot`,
  `/fleet:review-and-fix`, `fleet:next-ticket` — conditional on the open
  namespacing question above, not yet settled. Internal cross-references need
  updating either way if bare names do not survive: `next-ticket:80` names
  `/review-and-fix`, and `run-team`'s body points members at
  `~/.claude/commands/run-merge-bot.md` and `~/.claude/commands/review-and-fix.md`
  — **paths that no longer exist** as of Plan 1 Task 3. Those pointers are stale
  now regardless of how namespacing resolves, and Plan 3 must repoint them at
  `${CLAUDE_PLUGIN_ROOT}`.
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
