# Requirements: what your repo, your machine, and your process need

You want to try `fleet-ctl` on your own repository. This page answers one
question: *what has to be true — about the repo, the machine you run it on, and
the way your team works — for the fleet to behave correctly?*

Every requirement below is something the plugin's code or runbooks actually
depend on. The evidence trail for each row lives in
[`docs/research/external-assumptions.md`](research/external-assumptions.md)
(cited to `path:line`); this page is the checklist derived from it. Where a
requirement is checkable, a command is given. **Run the checks in order** —
most later ones assume the earlier ones hold.

Legend: **HARD** = the fleet refuses, misreads, or silently does nothing when
this is false. **SOFT** = degrades, or only matters for one path.

---

## 1. Your machine

### 1.1 Operating system — HARD

macOS, Linux, or Windows via WSL. Native Windows (PowerShell, Git Bash) is not
supported — the scripts are POSIX `sh` and lean on `awk`, `find`, `sed`, `tr`
in both BSD and GNU flavours
([ADR 0009](adr/0009-supported-platforms-are-macos-linux-wsl.md)).

### 1.2 Binaries on `PATH` — HARD

| Binary | Floor | Why | Check |
|---|---|---|---|
| `node` | `>=20.11.0` (`package.json` `engines`) | every `.mjs` script; `RegExp.escape` and `readdirSync({recursive})` are used | `node -v` |
| `git` | `>= 2.36` | `worktree list --porcelain -z`, `merge-tree --write-tree`, pinned error strings; measured baseline 2.50 / Apple Git-155 | `git --version` |
| `gh` | `>= 2.94.0` | `gh issue list --json blockedBy` — older `gh` exits `Unknown JSON field`, and the admission gate dies rather than run without blockers (`plugin/scripts/candidates.mjs:343-345`) | `gh --version` |
| `jq` | any | runbooks parse `ci-state.mjs` / transcript payloads with `jq -e`, `jq -r` (`plugin/skills/run-team/SKILL.md:1707`) | `jq --version` |
| `python3` | any 3.x | NUL-safe / UTF-8-strict readers in `inflight.sh`, `json.sh`, `no-undo-audit.sh` — several tests `skip` without it, the scripts `die` | `python3 -c 'import json'` |
| `shasum` | any | `instruments.sh` digests tracked files (`shasum -a 256`) | `command -v shasum` |
| `sh` | POSIX | dash on Linux, `/bin/sh` (bash 3.2) on macOS both work; every script pins `LC_ALL=C` and avoids `pipefail` | — |

Not needed: `timeout`/`gtimeout` (`net.sh` hand-rolls a watchdog),
`docker`, any package manager beyond the one your lockfile implies (§2.3).

Node pin note: `.nvmrc` (`26.5.0`) is the dev/CI pin for *this* repo, not your
floor ([ADR 0010](adr/0010-the-node-pin-stays-exact-and-a-bot-moves-it.md)).

### 1.3 `gh` authentication — HARD

- Logged in (`gh auth status`) to the host that owns the repo, with `repo`
  scope. The fleet reads and writes issues, labels, PRs, runs, and (for the
  merge bot) merges — all through this one identity.
- **Every member and the controller share this one identity.** There is no
  per-member attribution; "who claimed #42" means "which worktree", not
  "which user". If you need per-actor audit on GitHub, this is the wrong tool.
- GitHub Enterprise: works, but `ci-state.mjs`'s compare probe needs
  `--hostname`; expect one extra config step. Not exercised in this repo's CI.

### 1.4 Exactly one harness — HARD

The fleet runs inside **Claude Code** or **omp**, never both at once. With
one plugin registry populated it uses that one. With *both* populated it
trusts exactly one environment shape — `CLAUDECODE` set and `OMPCODE` unset
→ Claude (omp always sets both, so `OMPCODE` present proves nothing) — and
otherwise **refuses** unless the two installs are byte-identical or you set
`FLEET_HARNESS=claude|omp` (`plugin/scripts/fleet-run:163-238`). Simplest:
install on one harness only, or export `FLEET_HARNESS` in the shell that
launches the harness.

Install exactly as [README → Installation](../README.md#installation) says,
using the **qualified** id `fleet-ctl@fleet-plugin`. Then:

```
~/.fleet/bin/fleet-run --root        # prints the installed plugin root, or dies naming which registry is missing / that both are present
```

**omp only — two settings are session-wide preconditions**
([ADR 0003](adr/0003-dual-harness-dev-loop-install-is-the-only-path.md),
[ADR 0011](adr/0011-omp-tier-routes-through-roles.md)):

| Setting | Must be | Or else |
|---|---|---|
| `enabledProviders` | contains `"claude-plugins"` | plugin agents are invisible; `task` dispatch of `fleet-*` fails |
| `task.agentModelOverrides` | routes `fleet-*` agents → `modelRoles.{slow,task,smol}` (`fleet-run tier-roles.mjs --json --merge`) | `opus`/`sonnet`/`haiku` tiers resolve to nothing |
| `modelRoles.slow` / `.task` / `.smol` | set to real models on this install | same |

Check: `~/.fleet/bin/fleet-run tier-roles.mjs --check`.

### 1.5 Disk layout the fleet will create — SOFT

- `~/.fleet/bin/fleet-run` — the Resolver copy (installed by the plugin).
- `<repo>/.worktrees/<issue>-<slug>/` — one worktree per claimed ticket.
- `<repo>/.fleet/` — ledger, heartbeat, shortlist, board, instruments (§2.5).
- `<scratch>/impl-<N>/`, `review-<pr>.json`, `pr<N>/merge-bot-<n>/ci.json`.

Both `.worktrees/` and `.fleet/` must be writable and git-ignored (§2.5).

---

## 2. Your repository

### 2.1 Hosted on GitHub, driven by `gh` — HARD

There is no other tracker and no REST-only path. GitLab, Jira, Linear, a local
`git` remote with no forge: none of it works. The admission gate is
`gh issue list --search`, the merge gate is `gh pr view` + `gh run list`.

### 2.2 `origin` and `main` — HARD

- The remote is literally named `origin`.
- The integration branch is literally named `main`. Every currency check,
  rebase, cherry-pick, staleness probe, and the merge bot target `origin/main`.
- A handful of shell scripts honour `BASE_REF`; the Node scripts and every
  runbook do not. Treat `main` as non-negotiable today.

```
git remote get-url origin && git rev-parse --verify origin/main
```

### 2.3 A repository the fleet can install and test — HARD

**Ruling ([ADR 0014](adr/0014-consumer-recipe-by-agent-reasoning-no-technology-table.md)):
any technology.** The fleet derives your repo's *Recipe* — an Install step and
a Test entrypoint — by agent reasoning over the repository (README, build
files, CI workflow), proves both in a throwaway worktree, and caches the
result under `.fleet/`. fleet-ctl keeps no table of supported languages.

**Shipped state today (until #2117, #2118 land):** the derivation is Node-only
shell code. `claim-ticket.sh` **refuses the claim** unless `origin/main` has a
`package.json` with `scripts.test` or a tracked file matching
`\.(test|spec)\.[cm]?[jt]sx?$` (`plugin/scripts/derive-testcmd.sh:141-194`),
and an install it can derive from `package-lock.json`/`pnpm-lock.yaml`/`yarn.lock`
— or no lockfile with zero declared dependencies (`claim-ticket.sh:226-271`).
A Maven repo is refused outright (measured 2026-09-28); the interim workaround
is a one-line `package.json` `{"scripts":{"test":"<your command>"}}` with no
dependencies, which needs `npm` on the fleet machine and is untested.

What holds under either state:

1. **The repo must be learnable.** A README or build file that says how to
   install and run the tests is what the agent reads; a repo where a new
   engineer could not find the test command is a repo the agent cannot
   prove, and an unproven Recipe is a refusal, never a guess.
2. **The test run must not pass vacuously.** The proof requires evidence of
   real tests (a non-zero count, or a deliberate failing mutation turning it
   red); `tests 0` is a failed run (`plugin/skills/run-team/SKILL.md:2181`).
3. **The install must leave the tree clean.** An Install step that modifies
   any tracked file (a lockfile it rewrites, generated sources it commits) is
   rejected — commit a frozen lockfile.
4. **Both commands must run inside a fresh worktree with no ambient
   environment**: no reliance on a shared database, a compose stack keyed off
   the working directory, or env vars only your shell has. Reviewers run the
   suite in parallel across several worktrees; a `globalSetup` that tears
   down shared state will fight its siblings
   (`plugin/commands/review-and-fix.md:83`).
5. **The binaries the Recipe runs must be on `PATH`** on the fleet machine
   (`mvn`, `go`, `cargo`, `pytest`, `npm`, …) — §1.2 lists only what the
   plugin itself needs.

```
# until #2117/#2118: the Node-only derivation, run as the claim would
{ node -e 'process.exit(require("./package.json").scripts?.test?0:1)' 2>/dev/null; } || git ls-files | grep -qE '\.(test|spec)\.[cm]?[jt]sx?$'
git ls-tree --name-only origin/main package-lock.json pnpm-lock.yaml yarn.lock   # one line, or none if package.json has no deps
```

### 2.4 Labels — HARD

Create these **exact** strings before the first run. `gh` fails the whole
`issue list` on an unknown label name, and the fleet never creates a label
except `in-progress` on first claim. See
[`docs/agents/triage-labels.md`](agents/triage-labels.md).

| Label | Meaning to the fleet |
|---|---|
| `ready-for-agent` | the Shortlist source. Only issues carrying this are ever considered |
| `in-progress` | claimed; set by the fleet, excluded from the Shortlist |
| `ready-to-merge` | **the human's merge approval** on a PR (§3.4) |
| `needs-triage`, `needs-info`, `ready-for-human`, `wontfix` | triage roles; excluded from the Shortlist; written back by relabel-by-cause ([ADR 0013](adr/0013-automatic-supply-relabel-by-cause.md)) |
| `onhold` | excluded from the Shortlist |
| `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task` | wayfinder children; excluded |
| `patch`, `minor`, `major` | release labels — only if your repo gates releases on them (§3.3) |

```
for l in ready-for-agent in-progress ready-to-merge needs-triage needs-info ready-for-human wontfix onhold; do
  gh label list --search "$l" --json name --jq '.[].name' | grep -qx "$l" || echo "missing: $l"
done
```

### 2.5 `.gitignore` — HARD

```
.worktrees/
.fleet/
```

`.fleet/` state lives in the **main checkout** (git common dir), never in a
worktree; if it is tracked, every member's ledger write shows up as a dirty
tree and the instrument digest (`instruments.sh`) changes under the merge bot.

### 2.6 GitHub repository settings — HARD

| Setting | Required value | Why |
|---|---|---|
| Pull Requests → **Allow merge commits** | on | the merge bot runs `gh pr merge --merge`; `prove-merge.sh` verifies the result "has no second parent" and refuses otherwise |
| **Allow squash / rebase merging** | off (recommended) | the ruleset below disables them; a maintainer clicking squash produces a history the bot cannot audit |
| **Automatically delete head branches** | on | the bot never passes `--delete-branch`; with this off, merged branches accumulate and `reap.sh` sees them as live |
| **Sub-issues** and **issue dependencies** | enabled (default on github.com) | `blockedBy` is read via GraphQL; ≤ 50 blockers per issue (GitHub's cap — the gate refuses rather than truncates) |

Branch protection on `main` — the fleet expects a **repository ruleset** to be
the merge gate ([ADR 0007](adr/0007-main-ruleset-is-the-merge-gate.md)),
modelled on [`.github/rulesets/main.json`](../.github/rulesets/main.json):

- `required_status_checks` listing your CI jobs by their **reported name**,
  `strict_required_status_checks_policy: true` (out-of-date branches must
  rebase — this is what makes "green" mean "green on top of `main`").
- `pull_request` with `allowed_merge_methods: ["merge"]` and
  `required_approving_review_count: 0` — the `ready-to-merge` label *is* the
  approval; a required-reviewer count the fleet cannot satisfy stalls the bot
  forever.
- `bypass_actors: []` — nobody bypasses, including the bot's identity.

You can adapt the shipped JSON: change the `context` names to your jobs, keep
`integration_id: 15368` (GitHub Actions).

### 2.7 CI shape — HARD if you have CI, SOFT if you have none

`ci-state.mjs` decides "green" by binding one workflow run to the PR head and
comparing its jobs to the jobs declared in the workflow file. It assumes:

- Exactly one workflow file under `.github/workflows/` whose top-level
  `name:` is **`CI`** (override per call with `--workflow <name>` or
  `--workflow-file <path>`; the runbooks use the default).
- It runs on `pull_request` (or `push` to PR branches) so a run exists whose
  `headSha` equals the PR head.
- Every job under `jobs:` is keyed at two-space indent and has **no job-level
  `name:`** — the expected-job set is derived from the YAML keys, and a
  display-name override makes the API report a name the derivation cannot
  match (`plugin/scripts/ci-state.mjs:441-485`; it dies rather than guess).
  `strategy.matrix` jobs are the known blind spot: avoid them in this workflow.
- A full cycle completes in **~5–6 minutes**. Every wait budget in the runbook
  (600 s Claude / 900–1000 s omp per watch, 15-minute merge-bot grace) is
  sized from that. A 20-minute pipeline will read as "stuck" and be reported,
  not merged.
- **No CI at all** is a supported verdict (`no-ci`), but only when the caller
  passes `--declare-no-ci`; the merge bot does, gating on the reviewer's own
  suite run instead. A `.github/workflows/` directory with files in it but
  none named `CI` is *not* "no CI" — it is exit 2 ("misconfigured", never
  "pass").

```
grep -l '^name: *CI *$' .github/workflows/*.y*ml           # exactly one line expected
awk '/^jobs:/{j=1;next} j&&/^[A-Za-z]/{exit} j&&/^    name:/{print "job-level name: found: " $0}' .github/workflows/ci.yml
```

---

## 3. Your process

The fleet is a state machine over labels, issues, and PRs. It works only if
humans feed it the states it reads and never fake the ones it writes.

### 3.1 Tickets: what a claimable issue looks like — HARD

An issue is admitted when it is open, labelled `ready-for-agent`, carries
none of the excluded labels (§2.4), is unassigned, has no open blocker, and
is not already worked (§3.2).

Write tickets so the member can act without you:

- **Body is the spec.** A `## Agent Brief` **comment** on the issue, if
  present, *outranks* the body — use it to redirect a ticket without editing
  history (`docs/agents/issue-tracker.md:84-85`).
- **Blocking**: use GitHub's native *blocked by* dependency (UI or
  `gh api …/dependencies/blocked_by`). Where that is unavailable, a body line
  `Blocked by: #12` (also `depends on #5`) is read as a fallback
  (`plugin/scripts/candidates.mjs:179-202`). `Part of #<map>` is hierarchy, not
  blocking. Sub-issue parent/child relations are **not** blocking either.
- **`## Out of scope`** section: the member records what it deliberately left,
  and the reviewer holds it to that. Write it if you have opinions.
- **One ticket = one PR.** A ticket whose body is a multi-story spec
  (`## User Stories`, `## Acceptance Criteria` headings) is dropped as a
  spec, not a ticket — split it first.
- Sizing (`Sizing: light|heavy`) and tier are **not** on the issue; the member
  decides sizing and writes it into the PR body, the tier comes from the agent
  definition ([ADR 0005](adr/0005-tier-declared-per-harness-verified-at-dispatch.md)).
- Filing bar: an issue reaches `ready-for-agent` only once the defect is
  confirmed and worth a claim ([ADR 0001](adr/0001-filing-label-bar-is-defect-confirmed.md),
  [ADR 0002](adr/0002-filing-second-bar-worth-a-claim.md)). Triage is a human
  job: the fleet never promotes `needs-triage` → `ready-for-agent`.

### 3.2 Claims and branches — HARD

- The fleet marks a claim by `in-progress` + assignee + a worktree at
  `.worktrees/<issue>-<slug>` on branch `<type>/<issue>-<slug>`. A human who
  starts the same ticket **by hand** must set `in-progress` or an assignee, or
  the fleet will claim it too.
- A ticket already having an open PR whose body says `Closes #N` is treated
  as worked. **Name the issue in the PR body** when you open PRs by hand.
- Do not create branches under `.worktrees/` or delete the fleet's worktrees
  mid-run; `inflight.sh`/`reap.sh` read them to decide what is live.

### 3.3 PRs: what the fleet produces and what it expects of yours — HARD

- Exactly one `Closes #N` per PR (other issue references get a word in front:
  `Refs #N`). Two `Closes` lines or a PR with none confuses the 1 : 1 model.
- Head branch pushed to `origin`; fork PRs are read via `refs/pull/<n>/head`
  and work, but the tested path is same-repo branches.
- If your repo runs a release-label check: exactly **one** of
  `patch` / `minor` / `major` on every PR; the finisher applies `patch` when
  none is present and halts on more than one. If your repo has no such check,
  none of this applies — the fleet reads whether the check exists, it does
  not impose it.
- The shipped `release-label.yml` (if you copy it) auto-applies `patch` to
  bot-authored PRs.
- PR bodies are written by members; humans **may** comment or request
  changes. A `CHANGES_REQUESTED` review blocks the merge bot (`merge-gate.mjs:205`)
  until re-reviewed — that is the intended way to veto.

### 3.4 The one human touchpoint: `ready-to-merge` — HARD

- Only a **maintainer** applies `ready-to-merge`, after reading the fleet's
  review. `required_approving_review_count: 0` means the label *is* the
  approval — treat it with that weight. The fleet never adds it and refuses
  to if asked; it only reports "this PR looks ready".
- The label binds to the **head SHA at the time it was applied**. Any push
  after that — including your own rebase — makes the bot stop with
  `head-moved-after-label-#<pr>` and leave the label in place. Re-review, then
  re-apply (remove and add) to bind it to the new head.
- Never apply it to a red PR and expect the bot to wait: it does wait, but a
  PR that is red for a reason nobody fixes sits there until the 15-minute
  grace ends and the run reports it.
- Removing the label is the safe abort; the bot re-reads labels immediately
  before `gh pr merge`.

### 3.5 Running it — SOFT

- One controller per repo at a time. `.fleet/` has no locking: two
  `run-team` sessions on the same checkout corrupt the ledger.
- The run ends on **your** decision, budget, or context exhaustion — never
  because "the Shortlist is empty". Expect to stop it.
- Sit near the terminal for the first run: the controller is turn-based
  ([ADR 0008](adr/0008-a-turn-based-fleet-holds-its-own-turn.md)) — if it
  yields, nothing progresses until the next turn.
- Rate limits: each controller tick spends a handful of `gh` calls plus one
  `ci-state` read per in-flight PR; the merge bot polls every 60 s. Many open
  PRs on a low secondary rate limit produce `rate-limited` verdicts, which are
  treated as "unknown", never as green.

---

## 4. Quick pre-flight

Run from the repo root of the project you want to try it on:

```sh
set -e
node -v; git --version; gh --version | head -1; jq --version; python3 --version; command -v shasum
gh auth status
git remote get-url origin; git rev-parse --verify -q origin/main >/dev/null
{ test -f package.json && node -e 'process.exit(require("./package.json").scripts?.test?0:1)'; } || git ls-files | grep -qE '\.(test|spec)\.[cm]?[jt]sx?$'
git ls-tree --name-only origin/main package-lock.json pnpm-lock.yaml yarn.lock | grep -q . \
  || git show origin/main:package.json | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(["dependencies","devDependencies","peerDependencies","optionalDependencies","workspaces"].reduce((n,k)=>n+Object.keys(p[k]||{}).length,0)?1:0)'
grep -qE '^\.worktrees/?$' .gitignore && grep -qE '^\.fleet/?$' .gitignore
for l in ready-for-agent in-progress ready-to-merge; do gh label list --search "$l" --json name --jq '.[].name' | grep -qx "$l"; done
gh api "repos/{owner}/{repo}" --jq '[.allow_merge_commit, .delete_branch_on_merge] | @tsv'   # expect: true  true
gh api "repos/{owner}/{repo}/rulesets" --jq '.[].name'                                        # expect your main ruleset
grep -l '^name: *CI *$' .github/workflows/*.y*ml 2>/dev/null || echo "no CI workflow named CI — merge bot will use --declare-no-ci"
~/.fleet/bin/fleet-run --root
echo PREFLIGHT OK
```

Then `/fleet-ctl:run-team 1 1` with one `ready-for-agent` ticket you would
be happy to see merged, and watch a full cycle before scaling up.

## What this page does not cover

- Cost and model tiers — see [ADR 0005](adr/0005-tier-declared-per-harness-verified-at-dispatch.md), [ADR 0011](adr/0011-omp-tier-routes-through-roles.md).
- Wayfinder maps (research/prototype tickets) — [`docs/agents/issue-tracker.md`](agents/issue-tracker.md).
- Why each assumption exists — [`docs/research/external-assumptions.md`](research/external-assumptions.md) §9 lists which of the above are ADR-backed and which are implied only by code.
