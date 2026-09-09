# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --json title,body,labels,comments --jq '.title, (.labels[].name), .body, (.comments[]|.author.login + ": " + .body)'`. `--jq` requires `--json` (`--jq` with `--comments` errors: `cannot use --jq without specifying --json`), and `labels` is a valid `--json` field, so one call covers title, body, labels and comments.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "compose a PR body"

A closing keyword — `close`, `closes`, `closed`, `fix`, `fixes`, `fixed`,
`resolve`, `resolves`, `resolved` — immediately before an issue reference
creates a closing link, and the fix is to insert a word: write
`closed issue #219`, or name the issue without the `#`. Narrative prose about
what a pass already did is otherwise indistinguishable from a deliberate
`Closes #219`, and two triage-authored PRs shipped one before being corrected
in place: #370 now reads `closed issue #270` and #382 reads
`closed issues #219 and #220`, and `gh pr view <N> --json closingIssuesReferences`
comes back empty for each.

One keyword before a list links exactly the first reference, never the rest —
recorded on #382, whose body named #219 and #220 and linked only #219, and no
longer visible there because that body was corrected. Repeating the keyword is
what links each one: #973's body reads `Closes #971, closes #864, closes #472`
and its `closingIssuesReferences` comes back with all three. So a body naming
several issues after a single keyword misfires on all but one and the damage
looks arbitrary.

Write one deliberate `Closes #N` and give every other issue mention a word in
front of it. That is how `next-ticket` has fleet implementers open PRs
(`plugin/skills/next-ticket/SKILL.md` step 7): narrative and `Closes #N`
go into one `--body`, so the single keyword there is the deliberate one, and
their PRs are the model.

After opening a PR, re-query its closing references and compare them against
what you meant to close, surfacing a mismatch rather than accepting it
silently:

```sh
gh pr view <N> --json closingIssuesReferences --jq '[.closingIssuesReferences[].number]'
```

GitHub recomputes closing references lazily, so a query issued immediately
after the create can read falsely clean — re-query after a pause.

A keyword regex over PR bodies over-reports and never settles this on its own:
#1028's body carries the string `fixes #77` inside a code span, and GitHub did
not link #77 — `gh pr view 1028 --json closingIssuesReferences` returns #439,
the issue that PR set out to close. Compare a regex hit against the linked set
before calling it a defect.

Closing keywords bind in PR bodies and commit messages only. An issue comment
may write the adjacency freely — it creates no link, and a rule applied there
over-reaches and will be ignored.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Read the issue with `gh issue view <N> --json title,body,comments --jq '.title, .body, (.comments[]|.author.login + ": " + .body)'`.
Not bare `gh issue view <N> --comments` — non-interactively that prints only the
comments, and nothing at all when there are none, dropping the title and body
either way, exit 0, so the loss is silent. The `## Agent Brief` comment is
authoritative over the issue body. Read the issue **before
touching code**: with the repo in front of you, still undecided or needing
human hands you do not have → bail, name the cause, do not implement.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

The five `wayfinder:*` labels exist in this repo and **must be applied**, per
`/wayfinder`'s `SKILL.md` (`:21`, `:65`, `:113`): `wayfinder:map` on the map, and
one of `wayfinder:research` / `wayfinder:prototype` / `wayfinder:grilling` /
`wayfinder:task` on every child ticket. They were created 2026-09-08; an earlier
revision of this section told you to skip the label step, which was a workaround
for their absence and is no longer correct.

Apply them at create time with `--label`. `gh` resolves label names to ids *before*
the write and fails the whole command with `could not add label: '<name>' not
found`, so a typo aborts the create rather than creating the label on demand —
and a label you invent beyond these five will do the same. Add any new one with
`gh label create` first.

These labels are **not** triage roles; `docs/agents/triage-labels.md` governs those
five separately. A `wayfinder:*` issue belongs to a different pipeline and must stay
out of the fleet's candidate scan — see `plugin/scripts/candidates.mjs`'s `EXCLUDE`.

- **Map**: a single issue holding the Notes / Decisions-so-far / Fog body. `gh issue create --label "wayfinder:map"`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue, carrying its `wayfinder:<type>` label. Create it in one call: `gh issue create --parent <map> --label "wayfinder:<type>" --title ... --body-file ...` (verified on gh 2.100.0; `--parent` takes a number or a URL). `gh api --method POST repos/<owner>/<repo>/issues/<map>/sub_issues -F sub_issue_id=<child-db-id>` is the fallback for linking an issue that already exists — note it wants the child's numeric **database id**, not its `#number`. Where sub-issues aren't enabled at all, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Record the type in the child body as well as the label, so a body read alone still names it. Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
