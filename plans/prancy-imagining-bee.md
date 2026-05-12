# Dependabot: cluster by update-type + auto-merge patches

## Context

User wants Dependabot PRs across all 11 sc-* repos to:
1. **Cluster** per update-type: patch, minor, major (3 groups per ecosystem)
2. **Auto-merge patch** PRs when required checks pass
3. **Assign minor/major** to user (`feigi`) for review

Audit confirmed current state: all 11 repos have `dependabot.yml` v2 with single "all-patterns" groups, `reviewers: [feigi]`, no auto-merge workflows, no CODEOWNERS. A prior memory claimed auto-merge was rolled out 2026-04-18 — **memory stale**, no such workflows exist on disk. This batch creates them fresh.

## Research summary

- 11 repos. Ecosystems per repo: `github-actions` (all), `pip` (7), `terraform` (9), `npm` (2), `gomod` (1).
- All configs uniform: weekly, `rebase-strategy: auto`, `open-pull-requests-limit: 5`, `reviewers: [feigi]`, groups with `patterns: ["*"]`.
- Two npm repos split prod/dev — collapsing to 3 groups per user choice.
- No existing dependabot-auto-merge workflows. No branch protection or CODEOWNERS.
- `allow_auto_merge` on each repo must be enabled via `gh api --method PATCH /repos/feigi/<repo> -F allow_auto_merge=true` (idempotent).

## Shared spec each worker applies

### 1. `.github/dependabot.yml`

For every ecosystem block in the existing file, replace the single group with 3 update-type groups. Keep everything else (schedule, rebase-strategy, directories, open-pull-requests-limit).

Add `assignees: [feigi]` alongside existing `reviewers: [feigi]` on every ecosystem.

Group naming: `<ecosystem-short>-patch|minor|major`. Short names: `actions`, `python`, `terraform`, `npm`, `go`.

Example (pip ecosystem):
```yaml
- package-ecosystem: "pip"
  directories: [...unchanged...]
  schedule:
    interval: "weekly"
  rebase-strategy: auto
  open-pull-requests-limit: 5
  reviewers:
    - feigi
  assignees:
    - feigi
  groups:
    python-patch:
      patterns: ["*"]
      update-types: ["patch"]
    python-minor:
      patterns: ["*"]
      update-types: ["minor"]
    python-major:
      patterns: ["*"]
      update-types: ["major"]
```

For `sc-e2e-tests` and `sc-expedition-service-ui` npm blocks: **collapse prod/dev** to 3 groups (`npm-patch`, `npm-minor`, `npm-major`), each with `patterns: ["*"]` (no `dependency-type` filter).

### 2. `.github/workflows/dependabot-auto-merge.yml` (new file)

```yaml
name: Dependabot auto-merge

on: pull_request

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-merge:
    if: github.actor == 'dependabot[bot]'
    runs-on: ubuntu-latest
    steps:
      - name: Fetch metadata
        id: meta
        uses: dependabot/fetch-metadata@v2
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}

      - name: Approve and auto-merge patch updates
        if: steps.meta.outputs.update-type == 'version-update:semver-patch'
        run: |
          gh pr review --approve "$PR_URL"
          gh pr merge --auto --rebase "$PR_URL"
        env:
          PR_URL: ${{ github.event.pull_request.html_url }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Rationale:
- `--rebase` matches existing user preference for linear history (per memory).
- `gh pr review --approve` runs pre-merge so it works even if branch protection later requires approval; `dependabot[bot]` is a distinct actor so `GITHUB_TOKEN` may approve.
- Minor/major PRs: workflow matches `github.actor` but the patch-only `if` on the merge step skips them. They stay open with reviewer + assignee set to `feigi`.

### 3. Enable `allow_auto_merge` on the repo

```bash
gh api --method PATCH /repos/feigi/<repo> -F allow_auto_merge=true
```

Idempotent. Worker runs this as part of its sequence.

## Work units (11)

One PR per repo. Branch: `chore/dependabot-update-type-groups`.

| # | Repo | Ecosystems touched |
|---|---|---|
| 1 | sc-common-iac | github-actions, terraform |
| 2 | sc-e2e-tests | github-actions, npm (collapse prod/dev) |
| 3 | sc-expedition-service | github-actions, pip, terraform |
| 4 | sc-expedition-service-ui | github-actions, npm (collapse prod/dev), terraform |
| 5 | sc-feedback-service | github-actions, pip, terraform |
| 6 | sc-fleet-service | github-actions, pip, terraform |
| 7 | sc-location-service | github-actions, pip, terraform |
| 8 | sc-shared-workflows | github-actions |
| 9 | sc-template-service | github-actions, pip, terraform |
| 10 | sc-user-service | github-actions, gomod, terraform |
| 11 | sc-vehicle-service | github-actions, pip, terraform |

## E2E test recipe

True e2e (Dependabot actually creating grouped PRs) only runs on Dependabot's weekly schedule — cannot execute locally. Use this lightweight verification instead:

1. **YAML validity**: `python3 -c "import yaml; yaml.safe_load(open('.github/dependabot.yml'))"` — exit 0.
2. **Dependabot config semantic check**: `gh api /repos/feigi/<repo>/dependabot/secrets 2>&1 | head -1` (proves auth + repo); then after push: `gh api /repos/feigi/<repo>/contents/.github/dependabot.yml | jq -r .content | base64 -d | python3 -c "import sys,yaml; yaml.safe_load(sys.stdin)"`.
3. **Workflow syntax**: `gh workflow list --repo feigi/<repo>` after push shows "Dependabot auto-merge".
4. **Manual trigger (optional)**: On the PR the worker just opened, confirm `gh pr checks <pr>` shows green.

Skip full e2e of the auto-merge behavior — will observe in next Dependabot run (weekly cadence).

## Worktree / isolation caveat

Memory learning (2026-04-17): **worktree isolation breaks multi-repo work** in this workspace. Each sc-* repo is independent — worktree sandboxes workers into the parent beyond-infinity repo. Also, default subagent permissions deny Bash.

**Mitigation**: spawn each worker with `mode: "bypassPermissions"` and explicit cwd = target sc-* directory via prompt instructions. Do NOT set `isolation: "worktree"`.

## Worker prompt template

```
Goal: Across all 11 sc-* repos, cluster Dependabot PRs by update-type (patch/minor/major) and auto-merge patch PRs.

Your unit: <REPO_NAME>
Target directory: /Users/chris/dev/beyond-infinity/<REPO_NAME>

Ecosystems in this repo's dependabot.yml: <ECOSYSTEMS>

Tasks:

1. `cd /Users/chris/dev/beyond-infinity/<REPO_NAME>`
2. Create branch: `git checkout -b chore/dependabot-update-type-groups`
3. Edit `.github/dependabot.yml`:
   - For each ecosystem block: replace its `groups:` section with THREE groups named `<short>-patch`, `<short>-minor`, `<short>-major`, each with `patterns: ["*"]` and a matching `update-types: ["<type>"]`.
   - Short-name map: github-actions → actions, pip → python, terraform → terraform, npm → npm, gomod → go.
   - For npm blocks that currently split prod/dev: COLLAPSE to 3 groups (no `dependency-type` filter).
   - Add `assignees: [feigi]` alongside existing `reviewers: [feigi]` on every ecosystem.
   - Keep schedule, rebase-strategy, directories, open-pull-requests-limit unchanged.
4. Create `.github/workflows/dependabot-auto-merge.yml` with the exact content from the plan's "Shared spec" section 2.
5. Enable repo auto-merge: `gh api --method PATCH /repos/feigi/<REPO_NAME> -F allow_auto_merge=true`
6. Validate: `python3 -c "import yaml; yaml.safe_load(open('.github/dependabot.yml'))"`
7. Invoke the `Skill` tool with `skill: "simplify"`.
8. Unit tests: run the repo's test suite ONLY if changes touched source code. YAML-only changes = skip.
9. Commit: `git add .github/ && git commit -m "chore: cluster Dependabot PRs by update-type, auto-merge patch"`
10. Push: `git push -u origin chore/dependabot-update-type-groups`
11. PR: `gh pr create --title "chore: cluster Dependabot PRs by update-type, auto-merge patch" --body "..."` — body describes 3-group split, auto-merge for patch, assignees+reviewers on minor/major.
12. Verify: `gh workflow list` shows "Dependabot auto-merge".
13. Report: end with `PR: <url>`. If anything failed, `PR: none — <reason>`.
```

## Verification after all PRs land

- `gh pr list --repo feigi/<repo> --state open` — each repo has one PR.
- Spot-check any repo's next Dependabot run (weekly Monday) to confirm grouped PRs.
- Update stale memory `rCsXBX89gu1EBgamABM-i` with current design.
