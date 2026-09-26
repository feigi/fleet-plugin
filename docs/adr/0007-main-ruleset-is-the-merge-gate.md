# 0007 — `main`'s ruleset is the merge gate, ratified field by field

**Status:** Accepted. Ruled 2026-09-18, on the measurements below. Supersedes the
premises of #164, all three of which were stale when it was picked up. Amended by ADR 0012: guard 1's trigger reads "a single pass in which the last PR waits more than 3 h"; threshold unchanged.

## Context

#164 asked for `rebase-check` to become a required status check on `main`, on the
premise that nothing enforced it. Measured 2026-09-18, every premise had inverted:

- **Protection already existed.** Repository ruleset `main` (id 20119969) was
  created 2026-07-31T14:10:14 and last written 2026-07-31T16:37:01 — three
  versions, none since. It already required `rebase-check` *and* `check`.
- **The original false negative was an API confusion.** `gh api
  …/branches/main/protection` returns 404 for a repo governed by a **ruleset**;
  they are different APIs over different objects. Read
  `…/rules/branches/main` or `…/rulesets/<id>` instead. The 404 in #164's body is
  reproducible today and still means nothing.
- **The "needs repo-admin scope, which the agent token may not carry" claim was
  false.** `rulesets`, the ruleset object, and its version history are all
  admin-only reads and all succeeded.

What #164 was actually right about was the prose. `rebase-check-refresh.yml`'s
header asserted *"main is NOT a protected branch today … so nothing blocks the
merge"* — and #164 records that comment as having been corrected by #157. It had
not been; it was still on `main` on 2026-09-18, still citing the wrong endpoint,
still forward-referencing #164 as the pending follow-up. A second false claim sat
at `release.yml:41`, blaming a missing release label on *"branch protection
bypassed?"* when `validate-release-label` was not a required context at all and
so had never gated it.

The settings were, mostly, already correct. Nothing recorded that anyone had
*chosen* them, which is what this ADR fixes — and the two UI edits that silently
failed to save while #164 was being settled are why the choices now live in a file
with an applier rather than in the settings UI alone.

### Measurements

Merge cadence, 2026-09-10→17: **120 merges in 8 days**, peak 33 (09-17), then 29
(09-12), 19 (09-16), 17 (09-11), 13 (09-10), 9 (09-15).

`rebase-check-refresh.yml`, last 40 runs: **26 success, 12 failure, 2 cancelled**.
The failures are structural, not transient. Run 35278014761 (2026-09-17T21:40):

```
#1569: rerun POST denied — {"message":"The workflow run containing this job is
already running", "status":"403"}
GITHUB_TOKEN lacks 'actions: write' here, or a secondary rate limit is active.
```

`POST /actions/jobs/{id}/rerun` is refused while the containing run is active, so
whenever `main` advanced during a PR's in-flight CI the refresh could not fire and
the PR kept a green that no longer held. The error text then misattributed its own
cause to permissions or rate limiting, which is why this ran at a 30% failure rate
unnoticed. At 33 merges/day the triggering window is open almost continuously.

`ready-to-merge` → `mergedAt`, last 25 merged PRs: **median 48 min**, range 8–95.
`ci.yml` success duration: **5–6 min** (8 runs at 5, 9 at 6). Merge spacing inside
one wave (#1527→#1530): 18:50:02, 18:57:01, 19:03:42, 19:10:07 — **~6.7 min
apart**. So the wait is queue depth × one serialized CI cycle, ~7 PRs deep. The
controller's `sleep 120` poll accounts for at most 4% of it.

## Decision

`main`'s ruleset is the merge gate. Its intended state is checked in at
`.github/rulesets/main.json` and applied by `.github/scripts/apply-ruleset.sh`,
which resolves the ruleset by name, PUTs the file, then re-reads and refuses
unless the live object matches. Every field below is a choice, not a default:

| Field | Value | Why |
|---|---|---|
| `required_status_checks` | `rebase-check`, `check`, `validate-release-label`, `validate-claude`, `smoke-omp`, `npm-name-gate`, `install-and-smoke` | Every context a PR head publishes except `auto-label-bots`. The test is whether a context can *skip*, because a required check that skips strands the PR forever — and `auto-label-bots` is exactly that: `if:`-gated on dependabot/renovate (`release-label.yml:39-41`), so it skips on human PRs and must stay **unrequired**. Nothing else qualifies: the only job-level `if:` in `ci.yml` is `rebase-check`'s `github.event_name == 'pull_request'`, satisfied on every PR, and `validate-release-label` runs `if: always()` (`release-label.yml:68-70`). `check` is the suite, kept unsplit. `validate-claude`, `smoke-omp`, `npm-name-gate` and `install-and-smoke` are separate jobs on purpose (#1314, #1347, #1294) with their own real failure modes, not vestigial steps — the `# Blocking, every PR` comment on the `validate-claude` job in `ci.yml` already calls it that, which only a required context makes true. `validate-release-label` is required because `release.yml` already assumes it |
| `strict_required_status_checks_policy` | `true` | Closes the stale-green hole at the merge button, where it cannot go stale. Free today because `merge-bot` is capped at 1: the bot is the only merger, so the candidate it just rebased is always at `main`'s tip. See guard 1 — this is the field that forecloses parallel merge-bots |
| `allowed_merge_methods` | `["merge"]` | **Forced by code.** `prove-merge.sh:166` dies `has no second parent — not a merge commit` and exits 2; its three-leg proof (`:8-9`) requires the merge commit's second parent to *be* the rebased head. `run-merge-bot.md` already says: *"`--merge` (no-ff) is load-bearing, not stylistic."* Exit 2 means "could not evaluate", not "false", so a squash or fast-forward leaves the bot with no proof at all |
| linear history | **not enabled** | Mutually exclusive with the row above: it forbids merge commits, and merge-only guarantees one per merge. Enabling both rejects every merge |
| `required_approving_review_count` | `0` | 33 merges/day is not a human-review throughput. Review is `review-pr.js`'s six dimensions, which is not GitHub-approval-shaped |
| `required_review_thread_resolution` | `true` | The realistic operator intervention: costs nothing when nobody comments, hard-stops the merge when someone does. Chosen instead of raising the approval floor |
| `require_extra_approval_for_unattributed_changes` | `false` | Was `true`, against a 0-approval floor — so most PRs needed nobody and some agent-authored PRs silently needed one human. A conditional approval requirement on a repo requiring no review is an undiagnosable stall of exactly the shape #111 and #68 describe |
| `bypass_actors` | `[]` | No exemption, including for the maintainer. "I need to push a tooling fix fast" is precisely when the gate is load-bearing; `run-team/SKILL.md`'s `## Fix the tooling mid-run` now says so |
| `deletion`, `pull_request` | on | Unchanged |

`rebase-check` stays required even though `strict: true` subsumes its merge-base
assertion, for two reasons: it also asserts **no merge commits in `base..HEAD`**
(the `MERGE_COMMITS=$(git rev-list --merges --count ...)` check in the
`rebase-check` job of `ci.yml`), which no ruleset field expresses, and it
prints the actionable `git fetch origin && git rebase origin/$BASE_REF` line
that a bare merge-button refusal does not.

`rebase-check-refresh.yml`, `.github/scripts/rerun-rebase-check.sh`, and
`rerun-rebase-check.test.mjs` are **deleted**. Their sole purpose was flipping a
stale green back to red so a behind PR could not merge; `strict: true` refuses
that merge regardless of check colour, so a stale green is now inert. Measured on
this PR's diff, that removes 1105 lines — 315 of workflow YAML, 126 of shell, 664
of test — an `actions: write` grant, a 100-PR pagination cap, the unfixable rerun
race above, and the misdiagnosing error message.

## Why not GitHub's native merge queue

It was considered and rejected; the fleet's own `merge-bot` is the queue of record
(`ready-to-merge` label, `target: 1`, FIFO by PR number via the merge bot's
`held-behind-#<lower>` hold rule — `run-merge-bot.md:34`, which consults
`pr-overlap.mjs` for the overlap signal but owns the rule and the label itself —
and `run-team/SKILL.md`'s *"Each PR rebases exactly once, when it becomes the candidate"*). Three blockers:

1. Required checks **must** report on the `merge_group` event or the merge fails
   for want of a report. No workflow in this repo has a `merge_group` trigger.
2. `validate-release-label` runs on `pull_request_target` and reads
   `github.event.pull_request` — there is no PR in a merge group, so the check you
   just made required has no merge-group path.
3. Entering the queue requires the PR's required checks to be green. A behind PR
   has a red `rebase-check`, so it can never be queued — the native queue and
   requiring `rebase-check` are mutually exclusive. The queue *replaces*
   currency-on-the-PR rather than enforcing it.

Beyond those, `[INFERENCE]` even with `merge_method: merge` the merge commit's
second parent would be the queue's temporary `gh-readonly-queue/main/pr-N-<sha>`
head rather than the PR's rebased head, breaking `prove-merge.sh` leg 3. Not
verified — it needs a live queue to confirm.

## The guards — both chosen before any further data

**Guard 1 — merge latency becomes the binding constraint.** `strict: true` is free
only while `merge-bot` is capped at 1. Raising that cap makes it expensive: two
bots rebase onto tip `T`, one merges producing `T'`, and the other must rebase and
re-run CI, reimposing serialization from the ruleset with wasted CI on top.

- **Input:** median `ready-to-merge` → `mergedAt` over a run of ≥20 merges.
- **Trigger:** median above **90 min**, or a single wave in which the last PR
  waits more than **3 h**. Baseline for comparison: 48 min median, n=25,
  2026-09-17.
- **Then reconsider:** `strict: false` with the **overlap proof** as the currency
  gate — `pr-overlap.mjs` already proves two PRs touch disjoint files, and a green
  computed against `T` is not meaningfully stale at `T'` for a PR that provably
  does not overlap. That permits a merge-bot cap above 1. It is a design project,
  not a ruleset edit: it makes a script the load-bearing safety gate in place of a
  GitHub-enforced invariant, and it needs a currency mechanism for the
  *non*-overlapping case that does not repeat the deleted refresh workflow's
  rerun race.
- **Do not** reach for a `labeled` webhook as the remedy. Measured above: polling
  is ≤4% of the wait. The levers are parallelism and batching.

**Guard 2 — a release step whose failure is not retry-safe.** GitHub-release
creation is not a future event to wait for: `release.yml` tags *and* cuts the
release today (`Create tag (idempotent)`,
`Create GitHub release (idempotent)`), on `pull_request: [closed]` with
`merged == true` — entirely post-merge, so nothing about it is observable on a PR
head and no required context could have gated it. Both steps are guarded by an
existence check (`git ls-remote --tags --exit-code`, `gh release view`), so a
failure costs a rerun rather than a corrupted release, and the job already
comments the failure onto the PR. That is why neither warrants a required context
now. What would: a post-merge step that is *not* idempotent on rerun, or one
whose failure condition a PR head could have been checked against first.

- **Input:** a `release.yml` step that cannot be safely re-run after a partial
  failure, or one whose precondition is observable pre-merge.
- **Trigger:** first such step landing on `main`.
- **Then:** decide whether its precondition becomes a required context, and
  record it here.

## Consequences

- The gate's intended state is reviewable in the tree and provable against the
  live repo by one command. A UI edit that silently fails to save — which happened
  twice while this was being settled — is now detectable rather than believed.
- **Detectable is not detected.** Measured 2026-09-23 (#1710): the spec above
  named seven required contexts and the live ruleset enforced three — the four
  added when this ADR was ratified reached the tree and never reached GitHub,
  because merging the spec is not applying it and nothing read the gate unless
  a person chose to. #1710 opened with that measurement in its body;
  `gh issue view 1710 --json createdAt --jq .createdAt` prints
  `2026-09-23T07:30:07Z`.
  The ruleset version in force across the window below is
  50126119, written 2026-09-18T07:48:21Z; `gh api
  repos/feigi/fleet-plugin/rulesets/20119969/history/50126119 --jq
  '.state.rules[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context'`
  prints `rebase-check`, `check`, `validate-release-label`, the three `git show
  2fac235:.github/rulesets/main.json` names. `5fffb2e`, the second commit of the
  ratifying #1574, added `validate-claude`, `smoke-omp`, `npm-name-gate` and
  `install-and-smoke`. **86 PRs merged through the narrower gate** over the 4d22h
  between the spec's merge and the reconcile, with no symptom anywhere. The
  window runs from #1574's `mergedAt`, 2026-09-18T10:41:45Z, to the ruleset's
  `updated_at` at the reconcile, 2026-09-23T09:08:27Z (readback on #1710); the
  count includes #1574 itself, so 85 merged after it. Reproduce with
  `gh pr list --state merged --limit 1000 --search
  'merged:2026-09-18T10:41:45Z..2026-09-23T09:08:27Z' --json number --jq length`.
  That is the measurement: the gap is neither rare nor self-announcing. Reconciled
  2026-09-23. The remedy is `apply-ruleset.sh --check`, which performs the same
  comparison, writes nothing, and exits 3 on a difference — run at `run-team`
  phase 0, where a controller is about to spend a run depending on the gate. It
  is deliberately NOT a required context: main's ratified spec is the only thing
  the live gate may legitimately match, so a PR-time check demanding
  live-equals-spec would red the very PR proposing a new context and refuse the
  merge that would make it legitimate — this document's own skip test, reached
  from the other side.
- `main` cannot be pushed to directly by anyone. Mid-run tooling fixes go through
  a PR, carry a release label, and face the same required checks the table above
  lists.
  `run-team/SKILL.md`'s `## Fix the tooling mid-run` records this.
- A behind PR is refused at the merge button rather than by a check that may be
  stale. The 30% of `main` advances that the refresh workflow failed to propagate
  no longer let a stale-green PR through.
- Merges stay serialized at one PR per CI cycle. That is the accepted cost of
  guard 1's trade, priced at a 48-min median against a 6-minute CI.
- Squash and rebase merges stay unavailable until `prove-merge.sh` gains a
  proof that does not rest on a two-parent graph.
- #164's stale premises stay on the record rather than being quietly corrected:
  the defect it named was real when filed, closed by someone else without a note,
  and its *ruling* went stale independently of its defect.
