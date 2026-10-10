# What `fleet-ctl` assumes about the world outside itself

Research, 2026-09-28. Question: beyond the label set, what does this plugin
require the surrounding world — tracker, git, CI, OS, harness, consumer repo,
humans — to look like?

Method: four parallel code-and-prose censuses, one per slice, each row citing
`path:line` plus a verbatim fragment. The slices are the evidence; this file is
the map. 484 rows total, deduplicated within slice, not across:

| Slice | File | Rows | Scope |
|---|---|---|---|
| shell | [`external-assumptions/shell.md`](external-assumptions/shell.md) | 129 | `plugin/scripts/*.sh`, `fleet-bootstrap`/`fleet-run`/`fleet-provenance`, all of `.github/` |
| tracker-node | [`external-assumptions/tracker-node.md`](external-assumptions/tracker-node.md) | 72 | `candidates`, `shortlist`, `ci-state`, `merge-gate`, `staleness`, `pr-overlap`, `diff-stats`, `fleet-tick`/`state`/`heartbeat`, `repo-root`, `git-env`, `tier-*`, `arg`, `slow-transport` |
| harness-node | [`external-assumptions/harness-node.md`](external-assumptions/harness-node.md) | 116 | `board.*`, `compute-*`, `ledger*`, `member-*`, `review-*`, `prompt-renderer`, `frontmatter-*`, `prose-pin`, manifests, `package.json`, `.nvmrc`, `renovate.json` |
| prose | [`external-assumptions/prose.md`](external-assumptions/prose.md) | 167 | skills, commands, agents, `docs/agents/*`, `README.md`, `CONTEXT.md` glossary, ADR decisions |

Row references below are `slice#N`. Twelve rows sampled across all four slices
were re-read against source before this summary was written; all twelve held.

## 1. Preconditions a consumer must satisfy

The short list. If any of these is false the plugin does not degrade — it
refuses, misreads, or silently does nothing.

**Tracker**

- GitHub, driven through `gh` (≥ 2.94.0 for `blockedBy`; `--json`/`--jq`, `gh api`, `gh api graphql`). No other tracker, no REST-only path. — tracker#7, prose#37–41
- Labels exist, with these exact strings, created before use (`gh` fails the whole write on an unknown label — tracker#11, prose#39):
  - triage roles: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` — prose#1
  - claim: `in-progress` (bootstrapped by `gh label create`) — shell#1, prose#10
  - merge authority: `ready-to-merge`, applied by a reviewer only — tracker#4, prose#7
  - release: exactly one of `patch` / `minor` / `major` per PR — shell#3, prose#8
  - modifiers/exclusions: `onhold`, `wayfinder:{map,research,prototype,grilling,task}` — tracker#1, prose#3–5
- Issues and PRs share one number space (`#42` may be either). — prose#27
- Native sub-issues and issue dependencies are enabled (`--parent`, `sub_issues`, `dependencies/blocked_by`, `issue_dependencies_summary`); otherwise the body-line fallbacks `Blocked by: #n` / `Part of #n` are used. — prose#16–20
- Merge method is **merge commit only**; squash and fast-forward are disabled at the ruleset and refused by `prove-merge.sh` ("has no second parent"). — shell#18, prose#31, shell#126
- ~~Repo-level "auto-delete head branches" is on; the bot never passes `--delete-branch`.~~ **Retired 2026-10-01: #2196 — the merge bot deletes the head branch from `origin` itself (`delete-merged-branch.sh`), so the setting is no longer required.** — prose#32

**git**

- Remote is `origin`; default/integration branch is `main`; every currency, rebase, cherry, and staleness probe is against `origin/main`. Overridable only by `BASE_REF` in a few shell scripts. — tracker#28, shell#43–46, shell#124, prose#63–64
- Worktrees live under `<repo>/.worktrees/<issue>-<slug>`; branches are `<type>/<issue>-<slug>`. Anything outside that shape is invisible to reap, inflight, and release. — shell#49, prose#65
- git ≥ 2.36 (`worktree list --porcelain -z`), ≥ 2.31 (`--path-format=absolute`); measured baseline 2.50.1 / Apple Git-155 for several pinned error-message strings. — shell#51, shell#57, tracker#35, prose#81
- No ambient `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`: they outrank `-C`, so every script scrubs them; a CI step exporting them retargets the fleet at another repo. — tracker#30, shell#47, harness#59

**CI / merge gate**

- The repository ruleset on the default branch *is* the gate (ADR 0007): `strict_required_status_checks_policy: true`, `required_approving_review_count: 0`, `bypass_actors: []`, required contexts `rebase-check`, `check`, `validate-release-label`, `smoke-omp`, `install-and-smoke`, each pinned to integration id 15368 (GitHub Actions). Renaming a job strands PRs. — shell#13–19, prose#51–55
- A full CI cycle is ~5–6 minutes; every wait-cell timeout in the runbook is sized from that (omp `eval` cells: ≥900 s for the rebase poll, ≥1000 s for the grace, "well above the CI cycle" for the CI wait). — prose#61, prose#158

**Consumer repo**

- ~~Contains `package.json` with a `scripts.test` key, or test files matching `\.(test|spec)\.[cm]?[jt]sx?$`, and a lockfile from `{package-lock.json, pnpm-lock.yaml, yarn.lock}`. Anything else refuses the claim.~~ **Superseded by ADR 0015: the claim reads the Install step and Test entrypoint from the Recipe cache, and nothing checks for a manifest, a test-file name or a lockfile.** — shell#84, shell#87–88
- `node` on PATH (≥ 20.11 per `engines`, dev pin 26.5.0), `python3` on PATH (one NUL-safe reader in `no-undo-audit.sh`), `shasum`, POSIX `sh` (dash/macOS bash 3.2), BSD *or* GNU awk/find/sed. — shell#67–92, harness#104
- `.fleet/` git-ignored and writable at the git common dir; `.worktrees/` likewise. — prose#137, harness#64

**Harness**

- omp alone (ADR 0014); the install is the native extension package (ADR 0021): `node_modules/@feigi/fleet-ctl` + `omp-plugins.lock.json` resolution, install layout `<installPath>/scripts/<script>`; Resolver copy placed at `~/.fleet/bin/fleet-run`. — shell#94–101, prose#144
- The only omp settings a fleet run needs set: `modelRoles.slow|task|smol` set to real models (ADR 0011/0014/0021). The `enabledProviders` gate retired with the marketplace route (18.2.1 origin exemption); `eval.workpool.freshAgents` and the `task.agentModelOverrides` precondition retired earlier (ADR 0012, ADR 0014). ADR 0014 retired `task.agentModelOverrides` as a lever but did not clear it: a leftover `fleet-` key there shadows a definition's own `model:`, so `tier-roles.mjs --check` refuses the run and prints the remedy (`omp config set task.agentModelOverrides '<non-fleet entries as JSON>'`, or `omp config reset task.agentModelOverrides` when none remain), which the operator runs — the fleet never does. — tracker#27, prose#124–125, prose#127–128
- Supported platforms: macOS, Linux, WSL. Native Windows unsupported by ADR 0009. — prose#83

**Humans**

- A maintainer applies `ready-to-merge` (the single human touchpoint; 0 required approvals means the label *is* the approval). — prose#163
- A maintainer runs `/triage`; the fleet only suggests it. — prose#161
- The run ends on maintainer decision, budget, or context exhaustion — never on "queue empty", because new supply emits no event. — prose#165

## 2. Issue shape

What a ticket must look like to be admitted, claimed, and worked.

| Assumption | Where |
|---|---|
| Open, carries `ready-for-agent`, carries none of the ten `EXCLUDE` labels (`in-progress`, `onhold`, `wontfix`, `needs-triage`, `needs-info`, `wayfinder:*`). Search terms are quoted `label:"…"` because an unquoted value ends at the first space. | tracker#1, tracker#11, prose#5 |
| Not a spec: a body whose `##` heading is `User Stories`/`Acceptance Criteria`-style spec structure is dropped by `dropSpecs` (a false admit means "a member implements a whole spec as one ticket"). | tracker (candidates.mjs `dropSpecs`, cited in-slice) |
| Blocking is `blockedBy` (GraphQL, ≤ 50 edges per issue, same-repo numbers only); `parent`/`subIssues` are hierarchy, not blocking, and are never fetched. | tracker#8–10 |
| A comment headed literally `## Agent Brief` overrides the body. Fetch is `gh issue view N --json title,body,comments`; bare `--comments` drops title and body silently. | prose#14, prose#22 |
| `Out of scope` heading/section records sequencing against other open tickets. | prose#15 |
| Fallback blocking line `Blocked by: #n, #n` at the top of the body when native dependencies are off; `Part of #<map>` for wayfinder children. | prose#16–18 |
| Assignee = claimed; the frontier query drops any assigned ticket. | prose#21 |
| Sizing is *not* on the issue: `Sizing: light|heavy` is a literal PR-body line read by the tier scraper. | prose#13 |
| Tier is *not* on the issue either — it is declared per agent file, in one `model: "@<role>:<level>"` key (ADR 0014), and verified at dispatch (ADR 0005). | prose#119–120, harness#24 |
| Whether a ticket is already worked is read from `closedByPullRequestsReferences.url` (URLs, cross-repo safe), then branch-name matching `--search "<n>"` capped at 100. | shell#5–6 |
| Non-admission is recorded as a ledger row (`excluded · behind-pr:#M`), never as a label; relabel-by-cause writes only `needs-triage` or `ready-for-human`. | prose#11–12 |

## 3. PR shape

| Assumption | Where |
|---|---|
| One PR per ticket, one implementer, one fix-applier named `fix-pr-<n>` — the `1:1` row model. | prose#29 |
| Body carries exactly one deliberate `Closes #N`; every other issue mention gets a word in front. Verified after create via `closingIssuesReferences` (recomputed lazily — re-query after a pause). Keyword scans also read commit messages (`gh pr view --json commits`). | prose#23–26, shell#8 |
| Head branch read via `--json headRefName`; head SHA via `headRefOid`, which lags a server-side rebase by up to ~2 min. | prose#33, prose#35, harness#40 |
| Merge state via `--json state` ∈ `OPEN|CLOSED|MERGED`; `mergeStateStatus`, `reviewDecision` (`null` or a string, `CHANGES_REQUESTED` meaningful). | tracker#12–14, shell#10 |
| `--json files` caps at 100 entries silently; `changedFiles` is the true count. | tracker#19, harness#43 |
| Fork PRs: `isCrossRepository` decides whether to read `refs/heads/<branch>` or `refs/pull/<n>/head`. | harness#41 |
| `gh pr update-branch --rebase` is the only rebase (server-side); never retried with `--force`. | prose#44, prose#76 |
| First push is `git push -u origin HEAD`; `--force-with-lease` only on a re-push. Bot-authored PRs (`authorAssociation`/`bot` login) get `patch` auto-applied. | prose#74, shell#4 |
| Release version is the newest `vMAJOR.MINOR.PATCH` tag, else `v0.1.0`; non-semver tags ignored. | shell#21 |

## 4. `gh` and GitHub API surface actually consumed

Field names the code dereferences — a rename in `gh`'s JSON schema breaks these
first. Full list per slice; the union:

- **issue**: `number,title,body,labels[].name,comments[].{author.login,body},blockedBy{nodes[].number,totalCount},closedByPullRequestsReferences[].url,url,state,assignees`
- **pr**: `number,state,labels,headRefName,headRefOid,mergeStateStatus,reviewDecision,isCrossRepository,files[].{path,additions,deletions},changedFiles,commits[].{messageHeadline,messageBody},closingIssuesReferences[].number,author,authorAssociation`
- **run**: `databaseId,headSha,status ∈ {queued,in_progress,completed},conclusion` (empty string, never `null`, for an in-flight run — #1566), `event,createdAt` (whole-second precision), `jobs[].{name,status,conclusion}`
- **repo**: `nameWithOwner,url`
- **api**: `repos/<o>/<r>/compare/<base>...<head>` (`behind_by`; needs `--hostname` on GHE), `…/issues/<n>/timeline?per_page=100` (`labeled`, `head_ref_force_pushed`), `…/issues/<n>/sub_issues`, `…/issues/<n>/dependencies/blocked_by` (database ids, not numbers), `repos/<o>/<r>/rulesets` (by name, `--paginate`), `rate_limit`, `graphql` with aliased `pullRequest(number:)` batches (every alias answered; `null` + `NOT_FOUND` on nonexistent, exit 1 with body still on stdout)
- **process contract**: `gh` exits 1 with `Unknown JSON field` on an unsupported key (the version probe), never prints non-JSON on a normal failure, and its abuse/rate-limit wording is `/rate limit|abuse detection/i`. — tracker#22–27, tracker#70

Also: `gh` is *not* routed through `net.sh`'s watchdog — it is trusted to bound
its own ~20 s network calls. — shell#12, harness#56

## 5. Harness surface

omp is the only harness (ADR 0014). The tool vocabulary the fleet leans on:

| Concept | omp |
|---|---|
| dispatch | `task`, `agent: "fleet-<x>"` (bare name; registry is unnamespaced) — harness#3, #12, #23 |
| wake / message | `hub send` (idle peer → same; name collision → `name-2`) |
| workflow host | `eval` — no replay, `resume` is reporting only; `pipeline()`/`parallel()` are hand-rolled by the shim — harness#6 |
| liveness | two axes: job outcome × peer state (`running/idle/parked`) |
| result | auto-delivered; `hub jobs`/`wait` snapshot |
| shell ceiling | auto-backgrounds at ~60 s (`bash.autoBackground`) — long waits go in Python `eval` |
| transcripts | `~/.omp/agent/sessions/<encoded-cwd>/<ISO>_<uuid>/<member>.jsonl` (home-relative, dots kept) — harness#61, #84 |
| tier | `model: "@<slow\|task\|smol>:<level>"`; role-routed via `modelRoles.{slow,task,smol}`; `session_init.resolvedModelIdentity` is provider-prefixed — harness#21, #24, #76; prose#124 |
| usage | one `usage` per turn, `usage.cost.total` real — harness#75, #88 |
| tool blocks | `toolCall`/`toolResult`, ids `toolu_…` — harness#83 |

Frontmatter (`frontmatter-allowlist.json`, harness#19–26): agent `name` must match
`^fleet-[^:]*$`; agent `model` must match `^@(slow|task|smol):(minimal|low|medium|high|xhigh|max)$`;
`effort`, `thinking-level`/`thinking`, `prewalk`/`advisor` and `isolation` are
forbidden on agents; `alwaysApply` is forbidden on skills and commands, which are
invoked, never injected.

## 6. Controlled-repo filesystem

| Path | Owner | Shape | Where |
|---|---|---|---|
| `.fleet/ledger.md` | `ledger.mjs` only (`row/filed/ruled/check/read/dispatch/settle/drain/rotate`) | five `##` sections `Rows/Dispatched/Filed/Ruled/Drain`; row grammar `impl-<N> · class=… · excluded · behind-pr:#M · review=<agent>:<runId>:<status>`; member tokens `(impl|fix-pr|finisher-pr|merge-bot)-<N>(-[a-z])?`; four historical finisher spellings still parsed; lives one run — phase 0's `rotate` moves it whole to `.fleet/ledger.<UTC YYYY-MM-DDTHHMMSSZ>.md` beside it, never rewritten after | harness#64–70, tracker#64, prose#138–139 |
| `.fleet/heartbeat.json` | `fleet-heartbeat.mjs` (`elapsed`,`beat`) + `fleet-tick.mjs` (`quiet`,`digest`) | one writer per key, no lock, patch-merge; absent file = fresh run; stale = `interval × 2` | tracker#57–59, prose#140 |
| `.fleet/shortlist.json` | `shortlist.mjs` | `{scanned, shortlist:[{n,t}]}`, temp+rename | tracker#56 |
| `.fleet/board.json` / `board.html` | `board.mjs serve` | atomic write; page fetches relative `/board.json` every 15 s — `file://` never works; port `8123 + fnv1a(workspace) % 512` | harness#92–100 |
| `.fleet/instruments.sha` | `instruments.sh` | line 1: 64-hex digest of tracked file *contents* (modes excluded); line 2 (since the cross-workspace pin): `root=<toplevel>` of the audited tree, which may be a different checkout than the state home; state lives in the main checkout, never a worktree | shell#91–92, tracker#62 |
| `.worktrees/<issue>-<slug>/` | `claim-ticket.sh` | fresh from `origin/main` with `--no-track`; `agent-test` runner generated inside; ports `postgres=16000+issue`, `ollama=22000+issue` | shell#43, shell#86 |
| `<scratch>/impl-<N>/`, `pr<N>/run-XXXXXXXX/review.json`, `pr<N>/merge-bot-<n>/ci.json` | members | two-level namespace; root writes collide | prose#143, tracker#61 |
| `docs/metrics/*.tsv`, `chore/run-artifacts-<date>[a-z]` branches | scrapers | regenerated wholesale; date collision gets a letter suffix | prose#148–149 |
| `CONTEXT.md` + `docs/adr/` (single-context) | humans | glossary is normative; `wave`/`queue` are defects | prose#146–147 |

## 7. OS / toolchain hazards the code already defends against

Not preconditions — the scripts carry the workaround — but each is an assumption
about *which* divergence exists (shell#67–92, tracker#41–48):

- `LC_ALL=C` pinned at the top of every script; BSD awk aborts (rc 2) on non-UTF-8 bytes where GNU continues; gawk emits UTF-8 for high bytes, BWK awk raw.
- BSD `find` exits 0 on unreadable start points, GNU exits 1.
- `printf` not `echo` (dash and macOS `/bin/sh` expand `\c`).
- One `EXIT` trap per script (a second silently replaces); macOS bash 3.2 never recovers from an EPIPE on a builtin write; `local` unavailable in POSIX `sh`; `.` on a missing file aborts the shell — hence `[ -r "$lib" ]` guards.
- No `pipefail`: every fallible git call is split out of pipelines.
- `timeout`/`gtimeout` assumed absent → `net.sh` hand-rolls a `sleep`+kill-tree watchdog; `ps -A -o pid=,ppid=` required for the tree walk.
- ssh honours the *first* `-o` for a repeated option; `ConnectTimeout` bounds the banner exchange, not just SYN.
- macOS `/tmp` → `/private/tmp` (`realpath` before compare); macOS `ps` truncates `args` without `-ww`; shebang read is 512 bytes on macOS, 255 on Linux.
- `Atomics.wait` on a `SharedArrayBuffer` blocks the thread; `writeSync` to a full pipe throws `EAGAIN` (retry ≤ 200).
- Node `RegExp.escape` is v24+, above the `>=20.11` floor, so `prose-pin.mjs`, `ledger.mjs` and `node-floor-sweep.test.mjs` hand-roll it; `readdirSync({recursive:true})` needs ≥ 20.
- `.nvmrc` (26.5.0) and `engines.node` (>=20.11.0) drift; Renovate manages only `nvm`. — harness#104–106

## 8. Time, concurrency, network

- Clock is `Date.now()` epoch-ms everywhere; no timezone handling; GitHub `createdAt` whole-second. — tracker#65–66
- Heartbeat: base 300 s, ×2 backoff, ceiling 1200 s, never above 30 min because arriving supply emits no event; `--hold` 240 s per call because omp lets no call block 20 min (auto-background at 60 s, 300 s command deadline). — tracker#41, prose#151–153
- Merge bot grace: fixed 15 min after the last actionable label, polling 60 s. — prose#154
- Rate limits: `gh api rate_limit` is free; secondary-limit outages are seconds long, so retry-and-re-probe, never backoff-and-wait; all pacing lives in the tick tail, never per PR. — prose#155–157
- Concurrency ceilings: `IN_FLIGHT = 4` network probes per tick; `ci-state.mjs` spawned serially per PR; one watcher per PR, armed by the controller not a member. — tracker#69, harness#102, prose#159–160
- Every member and the controller share **one** maintainer `gh` identity; no per-member attribution. — prose#162
- Single writer per `.fleet/` key; two controllers on one repo corrupt state. — tracker#71

## 9. Where the assumptions are already made explicit vs. only implied

Explicit (an ADR or `docs/agents/*` names it): labels (`triage-labels.md`),
tracker operations (`issue-tracker.md`), merge gate (ADR 0007), platforms (ADR
0009), node pin (ADR 0010), tiers (ADR 0005/0011), turn-holding (ADR 0008),
relabel-by-cause (ADR 0013), install path (ADR 0003).

Implied only (lives in code/prose, no doc names it as a requirement):

- `origin`/`main` hardcoded (partial `BASE_REF` escape hatch in shell only).
- Branch/worktree naming `<type>/<issue>-<slug>` / `.worktrees/<issue>-<slug>`.
- Consumer must be a Node project with `scripts.test` and one of three lockfiles. **Ruled 2026-09-28: ADR 0015 — any technology, Recipe by agent reasoning; #2117–#2120.**
- `python3` and `shasum` on PATH.
- Sub-issues/dependencies enabled on the GitHub plan; `blockedBy` ≤ 50 edges.
- ~~Auto-delete head branches on.~~ **Retired 2026-10-01: #2196 — the merge bot deletes merged branches itself.**
- `gh` ≥ 2.94.0; GHE needs `--hostname` in exactly one place (`ci-state.mjs` compare).
- Required-check names and integration id 15368 in `main.json`.
- CI cycle ≈ 5–6 min underpinning every timeout constant.
- omp's transcript directory encoding (spend scraper).

These are the candidates for either a "consumer requirements" doc or for
being lifted into configuration; that decision is outside this research.
