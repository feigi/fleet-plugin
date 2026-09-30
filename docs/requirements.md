# Requirements: fleet-ctl setup and constraints

**Platform:** macOS, Linux, or Windows via WSL. Native Windows is not
supported ([ADR 0009](adr/0009-supported-platforms-are-macos-linux-wsl.md)). All scripts are POSIX `sh`.
**Evidence trail:** See [`docs/research/external-assumptions.md`](research/external-assumptions.md). 
**Legend:** **HARD** = fleet refuses or silently fails. **SOFT** = degrades or affects one path only.

---

## 1. Your machine

### 1.1 Binaries on `PATH` — HARD

| Binary | Floor | Check |
|---|---|---|
| `node` | `>=20.11.0` | `node -v` |
| `git` | `>= 2.38` | `git --version` |
| `gh` | `>= 2.94.0` | `gh --version` |
| `jq` | any | `jq --version` |
| `python3` | any 3.x | `python3 -c 'import json'` |
| `shasum` | any | `command -v shasum` |

### 1.2 `gh` authentication — HARD
- Logged in (`gh auth status`) with `repo` scope to the GitHub host that owns your repo.
- All members and the controller share this identity; no per-actor attribution.
- GitHub Enterprise: works; `ci-state.mjs` derives `--hostname` from `git remote get-url origin`.

### 1.3 omp with fleet plugin — HARD
Install: `omp plugin install fleet-ctl` per [README → Installation](../README.md#installation).
Check: `~/.fleet/bin/fleet-run --root` prints the plugin root or fails naming why.

If that command answers "command not found" instead of one of the
reasons above, the Resolver copy at `~/.fleet/bin/fleet-run` was never
placed — that is not a side effect of `omp plugin install`.

Settings ([ADR 0011](adr/0011-omp-tier-routes-through-roles.md), [ADR 0014](adr/0014-omp-is-the-only-harness.md), [ADR 0021](adr/0021-omp-native-install-route-replaces-the-marketplace.md)):
- `modelRoles.slow`, `.task`, `.smol`: set to real models — the only install-time setting the fleet needs

Check: `~/.fleet/bin/fleet-run tier-roles.mjs --check`

### 1.4 Disk layout — SOFT
- `~/.fleet/bin/fleet-run` — placed once by hand via `fleet-bootstrap` ([ADR 0003](adr/0003-dual-harness-dev-loop-install-is-the-only-path.md))
- `<repo>/.worktrees/<issue>-<slug>/` — one worktree per claimed ticket
- `<repo>/.fleet/` — ledger, heartbeat, shortlist, board, instruments
- `.worktrees/` and `.fleet/` must be writable and git-ignored (§2.5)

---

## 2. Your repository

### 2.1 Hosted on GitHub — HARD
Admission gate: `gh issue list --search`. Merge gate: `gh pr view` + `gh run list`.

### 2.2 `origin` and `main` — HARD
Remote: `origin`. Integration branch: `main` (all rebases, cherry-picks, staleness probes target `origin/main`).
Check: `git remote get-url origin && git rev-parse --verify origin/main`

### 2.3 Installable and testable — HARD
**[ADR 0015](adr/0015-consumer-recipe-by-agent-reasoning-no-technology-table.md):** Any technology. Fleet derives your repo's Recipe (Install + Test entrypoint) by agent reasoning, proves both in a throwaway worktree, caches under `.fleet/`.

**Shipped state (until #2117, #2118 land):** Node-only derivation. `claim-ticket.sh` refuses unless `origin/main` has `package.json` with `scripts.test` or tracked files matching `\.(test|spec)\.[cm]?[jt]sx?$` and an install from `package-lock.json`/`pnpm-lock.yaml`/`yarn.lock` or zero dependencies.

A Maven repo is refused outright (measured 2026-09-28); the interim
workaround is a one-line `package.json`
`{"scripts":{"test":"<your command>"}}` with no dependencies, which
needs `npm` on the fleet machine and is untested.

Hard rules for any technology:
1. Repo is learnable (README or build file documents install + test).
2. Test runs non-vacuously (non-zero count, or deliberate failure turns it red).
3. Install leaves tracked files unchanged (commit a frozen lockfile).
4. Both commands run in a fresh worktree with no ambient environment (no shared databases, compose stacks, or env vars).
5. Binaries the Recipe runs must be on `PATH` on the fleet machine (§1.1 lists only fleet-plugin dependencies).

Check:
```sh
{ node -e 'process.exit(require("./package.json").scripts?.test?0:1)' 2>/dev/null; } || git ls-files | grep -qE '\.(test|spec)\.[cm]?[jt]sx?$'
git ls-tree --name-only origin/main package-lock.json pnpm-lock.yaml yarn.lock | grep -q . || git show origin/main:package.json | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(["dependencies","devDependencies","peerDependencies","optionalDependencies","workspaces"].reduce((n,k)=>n+Object.keys(p[k]||{}).length,0)?1:0)'
```

### 2.4 Labels — HARD
Create these exact strings:

| Label | Role |
|---|---|
| `ready-for-agent` | Shortlist source; only issues with this are considered |
| `in-progress` | Claimed; set by fleet, excluded from Shortlist |
| `ready-to-merge` | Merge-gate approval; set by reviewer once diff-check is green, deferrals are filed, one release label present; a human may add or remove it at any time (§3.4) |
| `needs-triage`, `needs-info`, `ready-for-human`, `wontfix` | Triage roles; excluded from Shortlist |
| `onhold` | Excluded from Shortlist |
| `wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task` | Wayfinder children; excluded |
| `patch`, `minor`, `major` | Release labels (if your repo gates releases on them) |

Check:
```sh
for l in ready-for-agent in-progress ready-to-merge needs-triage needs-info ready-for-human wontfix onhold; do
  gh label list --search "$l" --json name --jq '.[].name' | grep -qx "$l" || echo "missing: $l"
done
```

### 2.5 `.gitignore` — HARD
```
.worktrees/
.fleet/
```
Fleet scripts don't write `.gitignore`; verify with `git check-ignore .worktrees/ .fleet/`. `.fleet/` state lives in main checkout (git common dir), never in a worktree.

### 2.6 GitHub repository settings — HARD

| Setting | Value | Why |
|---|---|---|
| Allow merge commits | on | `gh pr merge --merge` is the only merge method |
| Allow squash / rebase merging | off | Ruleset disables them; maintainer squash breaks audit |
| Auto-delete head branches | on | Fleet never passes `--delete-branch`; without this, branches accumulate |
| Sub-issues and issue dependencies | enabled | `blockedBy` is read; ≤50 blockers per issue (GitHub's cap) |

Branch protection: repository ruleset on `main` ([ADR 0007](adr/0007-main-ruleset-is-the-merge-gate.md)), modelled on [`.github/rulesets/main.json`](../.github/rulesets/main.json):
- `required_status_checks` by job name; `strict_required_status_checks_policy: true`
- `pull_request`: `allowed_merge_methods: ["merge"]`, `required_approving_review_count: 0`
- `bypass_actors: []`
- `integration_id: 15368` (GitHub Actions)

### 2.7 CI shape — HARD if present, SOFT if none
- Exactly one workflow file under `.github/workflows/` with top-level `name: CI` (override per call with `--workflow <name>` / `--workflow-file <path>`)
- Runs on `pull_request` (so a run exists with `headSha` = PR head)
- Every job keyed at two-space indent, no job-level `name:` (API won't match display names)
- Avoid `strategy.matrix` jobs in this workflow
- Full cycle: ~5–6 minutes (wait budgets: 900–1000 s per watch, 15-minute merge-bot grace)
- A pipeline slower than ~20 min reads as stuck and is reported, not merged
- **No CI:** only if caller passes `--declare-no-ci`; merge bot gates on reviewer's suite run
- A `.github/workflows/` with files but none named `CI` is **not** no-CI — it is exit 2 (misconfigured), never pass

Check:
```sh
grep -l '^name: *CI *$' .github/workflows/*.y*ml
awk '/^jobs:/{j=1;next} j&&/^[A-Za-z]/{exit} j&&/^    name:/{print "job-level name"}' .github/workflows/ci.yml
```

---

## 3. Your process

### 3.1 Tickets — HARD
Admitted: open, labelled `ready-for-agent`, no excluded labels (§2.4), unassigned, no open blocker, not already worked.

- **Body is the spec.** A `## Agent Brief` comment outranks the body (see [`agents/issue-tracker.md`](agents/issue-tracker.md)).
- **Blocking:** use GitHub's native *blocked by* dependency, or body line `Blocked by: #12` / `depends on #5`.
- **`## Out of scope`:** record what you deliberately left.
- **One PR per ticket.** Multi-story specs (detected by `## User Stories` heading) are dropped; split first. (`## Acceptance Criteria` alone is not detected as multi-story.)
- **`Part of #<map>` and sub-issue parent/child relations are hierarchy, not blocking.**
- **Sizing & tier** not on issue; member writes into PR body; tier from agent definition ([ADR 0005](adr/0005-tier-declared-per-harness-verified-at-dispatch.md)).
- **Filing bar:** issue reaches `ready-for-agent` only once defect is confirmed and worth a claim ([ADR 0001](adr/0001-filing-label-bar-is-defect-confirmed.md), [ADR 0002](adr/0002-filing-second-bar-worth-a-claim.md)).
- **Triage is a human job:** the fleet never promotes `needs-triage` → `ready-for-agent`.

### 3.2 Claims and branches — HARD
- Fleet marks claim: `in-progress` + assignee + worktree `.worktrees/<issue>-<slug>` on branch `<type>/<issue>-<slug>`.
- Ticket with open PR saying `Closes #N` is treated as worked; name the issue in PR body.
- Don't create branches under `.worktrees/` or delete fleet worktrees mid-run.

### 3.3 PRs — HARD
- Exactly one `Closes #N` per PR (other references: `Refs #N`).
- Head branch pushed to `origin` (fork PRs use `refs/pull/<n>/head`).
- Release-label check: exactly one of `patch` / `minor` / `major` if enabled; zero or more than one halts the finisher before the label, naming what was found.
- `release-label.yml` (if copied) auto-applies `patch` to bot PRs.
- Members write PR bodies; humans may comment or request changes. `CHANGES_REQUESTED` blocks merge bot until re-reviewed.

### 3.4 `ready-to-merge` — HARD
- Applied by reviewer (finisher or `review-and-fix` runner) once diff-check is green, deferrals are filed, exactly one release label present; never by implementer on own work.
- `required_approving_review_count: 0` means this label *is* the approval.
- Binds to head SHA at application time. Any push after (including rebase) makes bot halt with `head-moved-after-label-#<pr>`; bot leaves the label in place — re-review, then re-apply (remove and add) to bind it to the new head.
- A red PR with the label sits until the 15-minute grace ends and is reported, not merged.
- Removing the label is the safe abort; bot re-reads labels immediately before `gh pr merge`.

### 3.5 Running it — SOFT
- One controller per repo at a time (`.fleet/` has no locking).
- Run ends on your decision, budget, or context exhaustion—never because Shortlist is empty.
- Sit near the terminal first run: controller is turn-based ([ADR 0008](adr/0008-a-turn-based-fleet-holds-its-own-turn.md)).
- Rate limits: `gh` calls + one `ci-state` read per in-flight PR; merge bot polls every 60 s. `rate-limited` verdicts count as unknown, never green.

---

## 4. Pre-flight checklist

Run from repo root:

```sh
set -e
node -v; git --version; gh --version | head -1; jq --version; python3 --version; command -v shasum
gh auth status
git remote get-url origin; git rev-parse --verify -q origin/main >/dev/null
{ test -f package.json && node -e 'process.exit(require("./package.json").scripts?.test?0:1)'; } || git ls-files | grep -qE '\.(test|spec)\.[cm]?[jt]sx?$'
git ls-tree --name-only origin/main package-lock.json pnpm-lock.yaml yarn.lock | grep -q . \
  || git show origin/main:package.json | node -e 'const p=JSON.parse(require("fs").readFileSync(0,"utf8"));process.exit(["dependencies","devDependencies","peerDependencies","optionalDependencies","workspaces"].reduce((n,k)=>n+Object.keys(p[k]||{}).length,0)?1:0)'
git check-ignore -q .worktrees/probe
git check-ignore -q .fleet/probe
for l in ready-for-agent in-progress ready-to-merge; do gh label list --search "$l" --json name --jq '.[].name' | grep -qx "$l"; done
gh api "repos/{owner}/{repo}" --jq '[.allow_merge_commit, .delete_branch_on_merge] | @tsv'
gh api "repos/{owner}/{repo}/rulesets" --jq '.[].name'
grep -l '^name: *CI *$' .github/workflows/*.y*ml 2>/dev/null || echo "no CI workflow named CI"
~/.fleet/bin/fleet-run --root
echo PREFLIGHT OK
```

Then: `/fleet-ctl:run-team 1 1` with one `ready-for-agent` ticket, watch a full cycle.

---

## See also
- Cost & tier: [ADR 0005](adr/0005-tier-declared-per-harness-verified-at-dispatch.md), [ADR 0011](adr/0011-omp-tier-routes-through-roles.md)
- Wayfinder: [`agents/issue-tracker.md`](agents/issue-tracker.md)
- Why each requirement exists: [`docs/research/external-assumptions.md`](research/external-assumptions.md) §9
