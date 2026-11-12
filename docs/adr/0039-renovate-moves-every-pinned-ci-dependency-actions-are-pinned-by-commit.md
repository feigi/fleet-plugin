# 0039 — Renovate moves every pinned CI dependency, and actions are pinned by commit

**Status:** Accepted. Ruled 2026-11-12 by the maintainer, from a specification session; ticketed as #4468. Amends ADR 0010 (see its Status line).

## Context

The ask: automated dependency updates, where a minor or patch bump merges itself once CI is green and a major waits for a human. Dependabot or Renovate, whichever suits the repo.

Measured on `origin/main` at `24913363`:

- **The repo has no package dependencies.** Neither `package.json` declares one. What CI runs is pinned in three other places:
  - `.nvmrc`, which Renovate already moves (ADR 0010);
  - the actions' `uses:` refs, all major tags: `actions/checkout@v5` (`ci.yml` ×5, `pin-drift.yml`, `release.yml`), `actions/setup-node@v5` (`ci.yml` ×3) and `@v6` (`release.yml`), `actions/setup-go@v6`, `oven-sh/setup-bun@v2` (×2);
  - version literals in `ci.yml`: `renovate@44.115.7` (the config validator), `@oh-my-pi/pi-coding-agent@18.4.4` (×2), `bun-version: "1.4.0"` (×2) and `gojq@v0.12.19`.
- **A major tag is a float.** What `@v5` runs changes when the upstream moves its tag, and no commit here records that. It is the silent drift ADR 0010 and the validator and gojq comments in `ci.yml` exist to refuse. A ref that names only a major also changes only at a major, so a bot reading it could propose majors alone, and under the ask none of them would ever merge unattended.
- **Dependabot cannot do the job alone.** `.nvmrc` is outside its ecosystems (ADR 0010), and it reads no version inside a `run:` line. Renovate reads both: its `nvm` manager, and regex custom managers. Choosing Dependabot means running two bots, two configs, and a second bot inside the release-label contract `tests/renovate-release-contract.test.mjs` pins.
- **Dependabot does not keep a PR current.** The `main` ruleset requires a branch to be up to date (`strict_required_status_checks_policy`), and `rebase-check` refuses merge commits (ADR 0010, point 4), so a bot PR must be rebased onto `main`. Renovate's `rebaseWhen: "behind-base-branch"` does that. Dependabot's documented rebase triggers are its own schedule, a reopen, a `target-branch` change and a conflict after a push ([options reference, `rebase-strategy`](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)), so a PR that is only behind waits for the next scheduled run.
- **The gojq pin follows gh, not gojq.** CI installs gojq so that `candidates.test.mjs` runs its `--jq` programs under the engine gh embeds. `cli/cli`'s trunk `go.mod` carries `github.com/itchyny/gojq v0.12.19`, which is exactly the pin. A bot following gojq's releases would move CI to an engine gh does not ship, and the parity gate would keep passing while it tested the wrong thing.
- **Three workflows run no bumped action before the merge.** `release.yml` runs on the merge, `pin-drift.yml` on a schedule, and `release-label.yml` runs the base branch's copy (`pull_request_target`). An action bump that touches only those files is merged without any check having run it. `setup-node` is that case today: a `v6` patch would change `release.yml` alone, because `ci.yml` is on `v5`.

## Decision

1. **Renovate, not Dependabot.** One bot moves every pinned CI dependency. `enabledManagers: ["nvm", "github-actions", "custom.regex"]`.
2. **Actions are pinned by commit.** Every `uses:` reads `owner/repo@<40-hex SHA> # vX.Y.Z`, and `pinDigests` is on for `github-actions`, so a tag ref added later arrives as a `pinDigest` PR. The existing refs are pinned by hand in the implementing PR, at the newest release within the major each file already names. Bot `pinDigest` PRs would cost one PR and one release per action and prove nothing that the first real update does not.
3. **Version literals are annotated.** Each one Renovate moves carries a `# renovate: datasource=… depName=…` comment on the line directly above it, read by one regex custom manager over `.github/workflows/`. The literals are the validator (`npm`), omp (`npm`) and bun (`github-releases` `oven-sh/bun`). If the `github-actions` manager already extracts `setup-bun`'s `bun-version`, that manager owns it instead: one manager per pin.
4. **gojq stays hand-moved.** It follows gh's `go.mod`, and Renovate does not manage it.
5. **Same-ref rule.** Every action used in a workflow other than `ci.yml` is used in `ci.yml` at the identical SHA, and a contract test holds it. Renovate puts one dependency at one version into one branch across every file, so each such bump also changes `ci.yml` and the required checks run the new ref. `setup-node` in `ci.yml` moves to `release.yml`'s `v6` in the implementing PR; this ruling is the human approval for that major.
6. **ADR 0010's merge policy covers every pin.**
   - `major`: labelled `major`, never automerged.
   - `minor`: labelled `minor`, automerged.
   - `patch`, `digest`, `pinDigest`: labelled `patch`, automerged.
   - Unchanged: schedule, `minimumReleaseAge`, `internalChecksFilter`, `platformAutomerge`, `rebaseWhen`, `dependencyDashboard: false`.
7. **One PR per dependency.** No grouping. Every merged PR still mints a release.
8. **No new drift check.** One Renovate app moves every pin, and `pin-drift.yml`'s `.nvmrc` bound already goes red when that app stops. A per-pin bound would false-red on a pin whose upstream simply ships nothing.

## Consequences

- ADR 0010's Consequences bullet that puts GitHub Actions out of scope is superseded. Its exact `.nvmrc`, its bot and its schedule stand.
- What CI runs changes only by a commit. A moved upstream tag reaches CI as a `digest` PR, labelled `patch`.
- Bot PRs and releases grow with the number of pinned dependencies: eight managed today (`.nvmrc`, four actions, three literals), so at most about eight a month, and fewer in a month where some ship nothing. A major from an actions upstream is the case that still waits for a human.
- Strict currency serialises the monthly burst. Each automerge puts the other open bot PRs behind; Renovate rebases them and CI runs again, one PR after another.
- Bot PRs are not Owned PRs (ADR 0034), so the fleet never claims, reviews or merges them. A waiting major sits in the PR list labelled `major`. Closing one unmerged is the refusal, which Renovate remembers, as under ADR 0010.
- gojq moves when gh's `go.mod` moves, by hand, as before. A gojq release with no gh adoption is correctly no event.
- Rejected: Dependabot for actions beside Renovate for `.nvmrc` (two bots, and a PR that is only behind waits for its schedule); keeping major tags (every update a major, so nothing automerges, and the float stays); full version tags (minor and patch would move, but a tag is still mutable); one grouped monthly PR (fewer releases, but a single bad bump blocks every other one).
