# 0010 — The node pin stays exact, and a bot moves it

**Status:** Accepted. Ruled 2026-09-23 on #354, against the measurements below. Amended by #1752: point 3's automerge stays the default for minor and patch bumps only — a major waits for a human — and each bump carries its own release label from `renovate.json`'s `packageRules`, so `release-label.yml`'s blind `patch` fallback stands down once the bot's own label is present rather than being guaranteed never to fire — the write order between Renovate's label and the fallback's read on the same `opened` event is runtime behaviour this repo does not record; `plugin/scripts/renovate-release-contract.test.mjs` pins the config/workflow contract itself, across the bot config and both release workflows. Amended by #1753: point 3's window is now the first three days of the month, all day, in a `timezone` stated as `UTC` rather than inherited, and a release must be three days old before the bot acts on it (`minimumReleaseAge`, with `internalChecksFilter: "strict"` stated so a too-young release opens no PR at all — Renovate's pending `renovate/stability-days` status is not a required check, so `platformAutomerge` could otherwise merge straight past it). A Node release dated the day the window opens therefore cannot be pinned inside that window, and an age equal to the window's width keeps the worst-case drift at about one month. The hour limit went too: Mend schedules a repo whose bot has not yet had a PR merged only daily, so a five-hour slot on one day could miss every run and silently cost the month. Monthly holds in effect, not absolutely — a release dated in the two days before the window opens ages in on its second or third day and, if the first bump has already merged, opens a second PR that month. The window bounds when the bot opens a PR, not when it merges; `ci.yml`'s first `setup-node` comment says so. Points 1–8 otherwise stand.

## Context

`.nvmrc` holds an exact version and is the single source of truth for the target
runtime: `ci.yml` reads it at three `node-version-file` sites (the `check`,
`validate-claude`, and `install-and-smoke` jobs) and nothing else in the repo
reads its contents. #335 pinned it to `26.5.0`
and deliberately deferred the question this ADR answers; #354 re-opened it.

The standing proposal was to replace the exact pin with a partial spec (`26`) so
both `nvm` and `actions/setup-node` would resolve it to the newest matching
release, restoring the auto-patching the old `node-version: 22` literal had.

Measured 2026-09-23, before ruling:

- **The exact pin does not get bumped.** `.nvmrc` sat at `26.5.0` for 43 days
  across 8 releases (latest 26.x was v26.10.0, 2026-09-22). The cost #354
  predicted is demonstrated, not argued: the one-file edit does not happen.
- **The partial spec's premise is false for `nvm`.** `nvm use` with `26` selects
  the newest *locally installed* 26.x; only `nvm install` goes remote. A partial
  spec therefore **widens** the dev/CI gap it was meant to close. (Measured
  against this: the maintainer's machine ran v26.8.2 while CI ran v26.5.0.)
- **And it expires for `setup-node`.** Node 26 enters Active LTS on 2026-10-28,
  and the runner images preinstall the three latest LTS lines. Today
  `ubuntu-24.04` caches only 22 and 24, so `26` misses the cache and downloads
  the newest release — a genuine float. Once 26.x enters the toolcache, the
  default `check-latest: false` resolves `26` to **whatever the image ships**.
  Restoring the float then needs `check-latest: true` at all three call sites, a
  knob that cannot live in `.nvmrc` — which splits the single-source-of-truth
  story the file exists for.
- **Security was never the axis.** Exactly one security release (v26.5.1) landed
  in 26.x since the pin, and node here runs `node --check` on tracked files and
  this repo's own suite: no server, no untrusted input, no published artifact.
- **Reproducibility is the real axis.** This suite pins node's *own* behaviour —
  `claim-ticket.test.mjs`'s test "runner: a dash-led argument counts as an
  operand only where it exists" asserts node's argument-classification and
  refusal semantics, and `board-cli.test.mjs:251-255` records a 100-run
  measurement against a named version. A floating runtime lets an unchosen node
  release turn `main` red on a PR that touched nothing.
- **Dependabot cannot do this job.** `.nvmrc` is absent from GitHub's supported
  ecosystems, and the request has been open in `dependabot-core` since 2019
  (#1462, #4808, #14752). Renovate has a built-in `nvm` manager: pattern
  `/(^|/)\.nvmrc$/`, datasource `node-version`, versioning `node`.
- **A self-hosted bot could not be gated.** GitHub does not create workflow runs
  for events authored with the repository's `GITHUB_TOKEN`, so a self-hosted
  Renovate would open PRs that none of the seven required checks ever report on
  — permanently `BLOCKED`, and with the pre-merge proof this ADR depends on
  missing entirely. A GitHub App's PRs do trigger `pull_request` workflows.
- **Every merged PR mints a release.** `release.yml:17` cuts a tag and a GitHub
  release per merged PR, and `release-label.yml:41` already auto-labels
  `renovate[bot]` PRs `patch` while `validate-release-label` is required — so a
  bot PR cannot merge *without* minting a version. `marketplace.json` ships
  `path: "plugin"` at `ref: "main"`, so `.nvmrc` is outside the shipped payload
  and installs track the branch: an unscheduled bot would mint roughly six
  user-invisible releases a month.
- **An unlabelled issue is a fleet candidate.** `candidates.mjs`'s `query()`
  searches `EXCLUDE` (+ an optional label), and `EXCLUDE` negates only
  `in-progress`, `onhold`, `wontfix`, `needs-triage`, `needs-info` and the
  `wayfinder:*` set. Renovate's default Dependency Dashboard issue carries no
  labels, so it would enter the candidate pool on any unfiltered run — including
  the `--allow-fallback` retry, whose `query(null)` drops the label.
- **A precise consumer floor is out of scope here.** Shipped scripts run under
  the user's own node via `#!/usr/bin/env node`; auditing every runtime API
  surface they touch to derive an accurate minimum is not attempted in this
  ADR. Among shipped scripts, `util.parseArgs` (stable since Node 20.0.0) is
  used by `candidates.mjs`, `fleet-tick.mjs`, `fleet-heartbeat.mjs` — `arg.mjs`
  and `staleness.mjs` only reference it in comments contrasting their own
  hand-rolled parsing against it. The two files using `import.meta.dirname` —
  `prompt-renderer.mjs`, `workflow-files.mjs` — are imported only by
  `*.test.mjs` and bind the dev environment, not a user's.

## Decision

1. **`.nvmrc` holds an exact version.** It is the runtime the suite is developed
   and verified against, and a run is replayable from the tree.
2. **A bot moves it, not a human.** Mend-hosted Renovate, `enabledManagers:
   ["nvm"]`. The bump arrives as a PR that must pass all seven required checks —
   so a node regression surfaces as a closeable red PR instead of a red `main`,
   which is the exact inversion of what a floating pin buys.
3. **Monthly, and automerged.** `schedule: ["* * 1-3 * *"]`, read in
   `timezone: "UTC"`, opens the bot's window all day on the first three days of
   each month, and `minimumReleaseAge: "3 days"` with `internalChecksFilter:
   "strict"` filters out any release dated less than three days ago, so the
   bot never proposes one that young — real age can be closer to two days,
   since the `node-version` datasource dates a release by a day-only
   UTC-midnight field that can sit hours to a day before the actual publish.
   That keeps about one PR, one release and one CI burst per month — the
   Status line's #1753 amendment names one case that opens a second — while
   bounding drift at about one month.
   `automerge` + `platformAutomerge` because a PR waiting on a human rots the
   same way the file edit did — and `platformAutomerge` hands the merge to
   GitHub, which fires when checks go green rather than only inside Renovate's
   window.
4. **`rebaseWhen: "behind-base-branch"` is mandatory, not taste.**
   `main.json` sets `strict_required_status_checks_policy: true`, and `ci.yml`'s
   `rebase-check` fails on merge commits above base — so GitHub's "Update
   branch" button would red the gate. The bot must rebase.
5. **`dependencyDashboard: false`.** With one managed dependency the dashboard is
   surface, and left on it would put a bot-owned issue in the fleet's candidate
   pool. Rejected the alternative of widening `EXCLUDE`: that puts a
   Renovate-shaped special case inside the queue logic and still leaves every
   future bot-authored issue exposed.
6. **`renovate.json` is committed before the app is installed**, which suppresses
   the `Configure Renovate` onboarding PR — an extra PR that would mint a release
   and whose defaults are the two things points 5 and 2 rule against.
7. **`.nvmrc` is not hand-bumped in the ruling PR.** Renovate's first PR carries
   the overdue bump, and is the end-to-end proof that app, checks, label,
   automerge and release all work. A hand edit proves nothing and leaves the
   pipeline untested.
8. **A consumer floor is now stated, elsewhere.** At measurement time here,
   nothing declared one: `.nvmrc` carries no compatibility meaning, shipped
   scripts run under the user's own node via `#!/usr/bin/env node`, and
   neither `package.json` (absent) nor `plugin/.claude-plugin/plugin.json`
   named a floor. Deriving and publishing an accurate floor was out of scope
   for this ADR — #1754 did that work, in a root `package.json`'s
   `engines.node`, swept against the shipped tree by
   `node-floor-sweep.test.mjs`.

## Consequences

- `ci.yml`'s comment above the first `setup-node` no longer argues the exact-pin
  tradeoff; it points here. Its old text asserted that a patch bump "is now a
  deliberate one-file edit here", which the 43-day measurement falsified.
- `README.md` no longer carries the version literal. Renovate's `nvm` manager
  matches `.nvmrc` only, so a second copy would be falsified by every bump.
- Node currency for **GitHub Actions** is explicitly out of scope:
  `enabledManagers` excludes it, an action major can break the gate itself, and
  it deserves its own drift measurement.
- Closing a bump PR unmerged is remembered — Renovate will not re-raise that
  version. That is the deliberate-refusal escape hatch; there is no other
  Renovate-driven escape hatch.
- If the app is ever uninstalled, the pin stops moving and the repo is back to
  the measured 43-day behaviour. As ruled, that had no signal: the bot's absence
  was not observable from inside the tree. Point 5 bears on this: the Dependency
  Dashboard it turned off is a standing issue giving the status of every update
  — a passive heartbeat the bot would otherwise have carried between its PRs —
  so turning it off removed that signal as well. #1755 closed that:
  `.github/workflows/pin-drift.yml` runs weekly and goes red once `.nvmrc` has
  not landed a move on `main` for more than 35 days, judged from `git log`
  alone so it keeps reporting with the app gone. A deliberately refused bump
  trips it too if nothing newer lands inside the bound — the pin did not move,
  and that is the thing it reports.
