# Plan: Dependabot auto-merge for patch versions across all sc-* repos

## Context

The `beyond-infinity` workspace tracks 11 sibling repos (all submodules of `github.com/feigi/*`). Each repo already has `.github/dependabot.yml` configured (weekly, grouped by ecosystem, 5-PR limit, `feigi` as reviewer). **None** has an auto-merge workflow today, so every patch bump — however trivial — still requires manual merge.

Goal: when Dependabot opens a PR for a **patch** update and CI is green, the PR auto-merges with no human in the loop. Applies to all ecosystems Dependabot already tracks (github-actions, pip, npm, gomod, terraform).

GitHub no longer supports native auto-merge in `dependabot.yml` — the standard pattern is a `.github/workflows/dependabot-auto-merge.yml` using `dependabot/fetch-metadata@v2` + `gh pr merge --auto`.

User decisions:
- Workers **will enable** repo-level `allow_auto_merge` via `gh api`.
- Merge method: **rebase**.
- Workflow **will auto-approve** before merging (`gh pr review --approve`).

## Research summary

| Repo | Default branch | Ecosystems | Existing auto-merge? |
|---|---|---|---|
| sc-common-iac | main | github-actions, terraform | no |
| sc-e2e-tests | main | github-actions, npm | no |
| sc-expedition-service | main | github-actions, pip, terraform | no |
| sc-expedition-service-ui | main | github-actions, npm, terraform | no |
| sc-feedback-service | main | github-actions, pip, terraform | no |
| sc-fleet-service | main | github-actions, pip, terraform | no |
| sc-location-service | main | github-actions, pip, terraform | no |
| sc-shared-workflows | main | github-actions | no |
| sc-template-service | main | github-actions, pip, terraform | no |
| sc-user-service | main | github-actions, gomod, terraform | no |
| sc-vehicle-service | main | github-actions, pip, terraform | no |

All tracked via `.gitmodules` at `git@github.com:feigi/<repo>.git`, branch `main`.

## Approach

**11 independent PRs, one per repo.** Each PR adds the same self-contained workflow file. Per-repo rather than reusable-in-`sc-shared-workflows` because the trigger wrapper (`on: pull_request` + `if: github.actor == 'dependabot[bot]'`) must live in the target repo anyway, and the body is ~15 lines — reusable-workflow indirection adds more yaml than it saves.

### Workflow file content (identical across all 11 repos)

Path: `.github/workflows/dependabot-auto-merge.yml`

```yaml
name: Dependabot auto-merge

on: pull_request

permissions:
  contents: write
  pull-requests: write

jobs:
  auto-merge:
    runs-on: ubuntu-latest
    if: github.actor == 'dependabot[bot]'
    steps:
      - name: Fetch Dependabot metadata
        id: meta
        uses: dependabot/fetch-metadata@v2

      - name: Approve and enable auto-merge for patch updates
        if: steps.meta.outputs.update-type == 'version-update:semver-patch'
        run: |
          gh pr review --approve "$PR_URL"
          gh pr merge --auto --rebase "$PR_URL"
        env:
          PR_URL: ${{ github.event.pull_request.html_url }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

Notes:
- `fetch-metadata@v2` emits `update-type`; `semver-patch` is the exact value for patch bumps (covers all ecosystems).
- Minor / major PRs hit the `if:` false branch → job succeeds without merging (no noise).
- `GITHUB_TOKEN` can approve Dependabot PRs because `dependabot[bot]` is a different actor.
- `--auto` queues the merge; GitHub completes it once all required checks pass.

### Per-repo enable step (one-time, done by the worker)

```bash
gh api --method PATCH /repos/feigi/<repo> -F allow_auto_merge=true
```

Idempotent — returns the updated repo blob whether or not the flag was already set.

## Work units

One unit per repo. Each unit is a fresh worktree of the submodule, independent PR, no shared state.

| # | Unit | Target repo | Files |
|---|---|---|---|
| 1 | sc-common-iac auto-merge | `sc-common-iac` | `.github/workflows/dependabot-auto-merge.yml` |
| 2 | sc-e2e-tests auto-merge | `sc-e2e-tests` | same |
| 3 | sc-expedition-service auto-merge | `sc-expedition-service` | same |
| 4 | sc-expedition-service-ui auto-merge | `sc-expedition-service-ui` | same |
| 5 | sc-feedback-service auto-merge | `sc-feedback-service` | same |
| 6 | sc-fleet-service auto-merge | `sc-fleet-service` | same |
| 7 | sc-location-service auto-merge | `sc-location-service` | same |
| 8 | sc-shared-workflows auto-merge | `sc-shared-workflows` | same |
| 9 | sc-template-service auto-merge | `sc-template-service` | same |
| 10 | sc-user-service auto-merge | `sc-user-service` | same |
| 11 | sc-vehicle-service auto-merge | `sc-vehicle-service` | same |

## E2E test recipe

True e2e requires a real Dependabot PR, which can't be triggered on demand. Workers do the strongest check available:

1. **Validate YAML locally**: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/dependabot-auto-merge.yml'))"` — must exit 0.
2. **Confirm workflow registers on GitHub**: after pushing the branch and opening the PR, run `gh workflow list --repo feigi/<repo> | grep -i "Dependabot auto-merge"`. Workflow should appear.
3. **Confirm repo flag was set**: `gh api /repos/feigi/<repo> --jq .allow_auto_merge` must return `true`.
4. **Skip live-dependabot verification** — documented that the first real Dependabot patch PR after this merges will exercise the path.

## Worker instructions (copied verbatim into each agent prompt)

```
Goal: Add Dependabot auto-merge workflow to feigi/<REPO> so patch-level Dependabot PRs auto-merge when CI is green.

Your unit: <unit title>
Target repo dir: /Users/chris/dev/beyond-infinity/<REPO> (git submodule, tracks main)

Steps:
1. `cd` into the target repo dir.
2. `git fetch origin && git checkout main && git pull --ff-only origin main`.
3. `git checkout -b chore/dependabot-auto-merge`.
4. Create `.github/workflows/dependabot-auto-merge.yml` with exactly this content:

    ```yaml
    name: Dependabot auto-merge

    on: pull_request

    permissions:
      contents: write
      pull-requests: write

    jobs:
      auto-merge:
        runs-on: ubuntu-latest
        if: github.actor == 'dependabot[bot]'
        steps:
          - name: Fetch Dependabot metadata
            id: meta
            uses: dependabot/fetch-metadata@v2

          - name: Approve and enable auto-merge for patch updates
            if: steps.meta.outputs.update-type == 'version-update:semver-patch'
            run: |
              gh pr review --approve "$PR_URL"
              gh pr merge --auto --rebase "$PR_URL"
            env:
              PR_URL: ${{ github.event.pull_request.html_url }}
              GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    ```

5. Validate YAML: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/dependabot-auto-merge.yml'))"`.
6. Enable the repo-level auto-merge setting: `gh api --method PATCH /repos/feigi/<REPO> -F allow_auto_merge=true`. Then verify: `gh api /repos/feigi/<REPO> --jq .allow_auto_merge` must print `true`.
7. `git add .github/workflows/dependabot-auto-merge.yml`, commit with message:
   `chore: auto-merge Dependabot patch PRs`
8. Push: `git push -u origin chore/dependabot-auto-merge`.
9. Open PR: `gh pr create --base main --title "chore: auto-merge Dependabot patch PRs" --body "Adds \`.github/workflows/dependabot-auto-merge.yml\`. Auto-approves and rebase-merges Dependabot PRs where \`update-type == version-update:semver-patch\` once required checks are green. Minor/major PRs remain manual. Repo setting \`allow_auto_merge\` has been enabled via gh api."`.
10. After PR open: `gh workflow list --repo feigi/<REPO> | grep -i 'Dependabot auto-merge'` — must show the workflow.

After you finish implementing the change:
1. **Simplify** — Invoke the `Skill` tool with `skill: "simplify"` to review and clean up your changes.
2. **Run unit tests** — There are no unit tests for this workflow file. Skip.
3. **Test end-to-end** — Follow the e2e recipe above (YAML validate + `gh workflow list` + `allow_auto_merge` check). Full live-Dependabot verification is out of scope (requires a real Dependabot PR).
4. **Commit and push** — Already done above. If `gh` is unavailable or push fails, note it.
5. **Report** — End with a single line: `PR: <url>`. If no PR, end with `PR: none — <reason>`.
```

## Verification (coordinator side, post-merge)

- After each PR merges into `main` of its repo, `gh api /repos/feigi/<repo> --jq .allow_auto_merge` should return `true`.
- Next Dependabot patch PR in any of these repos should show "Auto-merge enabled by dependabot[bot]" in its timeline and merge itself once checks pass.
- If a patch PR does NOT auto-merge after landing, inspect the `Dependabot auto-merge` workflow run for that PR — most likely cause is branch-protection requiring status checks that the workflow itself isn't listed in (fine) or requiring reviews from CODEOWNERS (no CODEOWNERS exist today, so unlikely).
