# Does GitHub refuse a duplicate label name when two creates race?

Research for `feigi/fleet-plugin` issue #4216, under the map #4212 ("Several
fleet Instances on one repository: own work only, never colliding — any
machine, any gh user"). Read-only: GitHub documentation, GitHub's published
OpenAPI descriptions and changelog, fetched 2026-11-02. **No request was made
against any GitHub repository.** Claims are marked **documented** (GitHub
owns the source), **reported** (a third party saw it; never the answer), or
**[INFERENCE]**.

## TL;DR

**Design (b), "one repository label per claim, the create is the lock", cannot
rely on GitHub's documentation. GitHub documents that a duplicate label name
is refused with `422` / `already_exists`. It documents nothing about two creates
racing, and nothing about case-insensitivity. A measurement on bmw.ghe.com is
still needed before the design may lean on it.**

| Question | Answer | Basis |
|---|---|---|
| Duplicate label name refused? | Yes, as `422 Validation Failed`, `errors[].code = already_exists`; label names are named as the example of a "unique key" | documented (§1) |
| Exactly one of two simultaneous creates wins? | **Not documented.** No atomicity, isolation or race statement anywhere | gap (§2) |
| Refusal case-insensitive? | **Not documented** for create. The docs say only that owner/repo path names are case-insensitive | gap; reported by third parties (§3) |
| Same on GHES / bmw.ghe.com? | Same endpoint, same response codes in the OpenAPI descriptions of github.com, GHEC and GHES 3.22. No statement about concurrency on any of them. bmw.ghe.com is GHE.com (data residency), not GHES | documented (§4) |
| Max labels per repository | **No documented limit** | gap (§5) |
| Cost per create/delete | 1 primary request each; secondary 5 points each (`POST`/`DELETE` default); content-creation limit (80/min, 500/h) may apply to create, undocumented whether it does | documented + gap (§6) |
| Notifications / webhooks | `label` webhook event, actions `created`/`deleted`; no documented notification for label create/delete | documented (§7) |
| Deleted label in timelines | Label is removed from issues and PRs. Whether `unlabeled` events appear, and how `labeled` events render afterward, is undocumented | documented + gap + reported (§8) |

## 1. What GitHub documents about a duplicate create

- `POST /repos/{owner}/{repo}/labels` ("Create a label") returns `201`,
  `404` or `422`; `422` is described as "Validation failed, or the endpoint
  has been spammed."
  <https://docs.github.com/en/rest/issues/labels#create-a-label>. The same three
  codes appear in GitHub's own OpenAPI descriptions for github.com, GHEC and
  GHES 3.22: `descriptions/api.github.com/api.github.com.json`,
  `descriptions/ghec/ghec.2022-11-28.json`,
  `descriptions/ghes-3.22/ghes-3.22.json` in
  <https://github.com/github/rest-api-description> (all `info.version` 1.1.4;
  `paths["/repos/{owner}/{repo}/labels"].post.responses` = `201`, `404`, `422`).
  The `422` body is `validation-error` (`message`, `documentation_url`,
  `errors[]` with `resource`, `field`, `message`, `code`).
- The error table under "Validation Failed" defines `already_exists`:
  "Another resource has the same value as one of your parameters. This can
  happen in resources that must have some unique key (such as label names)."
  <https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#validation-failed>.
  The GHES copy of the page has the identical row.
  <https://docs.github.com/en/enterprise-server@latest/rest/using-the-rest-api/troubleshooting-the-rest-api>.
- The error message text (`Label.name already exists`) is not in the docs.
  **Reported**: cli/cli issue 5450 quotes `HTTP 422: Validation Failed
  (…/labels)` / `Label.name already exists`
  (<https://github.com/cli/cli/issues/5450>).
- GraphQL `createLabel` takes `CreateLabelInput` (`repositoryId`, `name`,
  `color`, `description`, `clientMutationId`) and returns `label`. The reference
  states only "Creates a new label." It lists no error codes, uniqueness rule or
  concurrency behaviour.
  <https://docs.github.com/en/graphql/reference/issues#createlabel>. GraphQL
  error shape for a duplicate is therefore **undocumented**; nothing here says
  it matches the REST `already_exists` code. No second source was found.

## 2. Race behaviour: not documented

Searched for a statement that creates are atomic, serialized, unique under
concurrent writers or idempotent:

- The create-label page, the labels REST category, "Managing labels", the
  troubleshooting page, both best-practice pages, the GraphQL `createLabel`
  reference and the OpenAPI descriptions say nothing about concurrent requests
  on one name.
- `already_exists` is described as "another resource has the same value": it
  says a duplicate is refused, not that refusal is race-free. A database-level
  unique index would make exactly-one-wins hold, but GitHub's server code is not
  public and no GitHub engineering post found describes labels storage
  **[INFERENCE]: a unique index is likely, unverified**.
- **Reported** (weak): Dennis-Otto/issue-assistant issue 145 describes two
  workflows creating the same label "a moment earlier"; the loser got `422`
  with `already_exists`
  (<https://github.com/Dennis-Otto/issue-assistant/issues/145>). Both calls
  were started by one push but nothing shows they overlapped in time, so this
  shows refusal after a completed create, not under a true race.

Verdict: **neither "exactly one of N simultaneous creates returns 201" nor "the
loser always gets 422" is a documented guarantee.**

## 3. Case-insensitivity: not documented for label names

- Every REST `{owner}` / `{repo}` parameter says "The name is not case
  sensitive", but the `name` field of Create a label and the `{name}` path
  parameter of Get/Update/Delete a label carry no such note
  (<https://docs.github.com/en/rest/issues/labels>).
- **Reported**: manaflow-ai/cmux issue 16193 (a label-sync script lower-cases
  names because "GitHub label names are case-insensitively unique"; the author
  expects a conflict for `area: cloud` / `Area: Cloud`)
  (<https://github.com/manaflow-ai/cmux/issues/16193>); nichobbs/cloud-agents
  issue 1115 (a create of `agent:blocked` returned `422` while `Agent:Blocked`
  existed; its own text calls this "inferred", not reproduced)
  (<https://github.com/nichobbs/cloud-agents/issues/1115>). Neither is a
  GitHub source, neither tests a race.
- Corollary for design (b): the lock name should be written in one canonical
  case regardless (e.g. lower-case `claim-<n>`), so the question stays
  academic if every Instance writes the same spelling.

## 4. github.com, GHES, bmw.ghe.com

- Docs and OpenAPI say the same on all three (§1). No platform has a documented
  race statement.
- bmw.ghe.com is **GitHub Enterprise Cloud with data residency (GHE.com)**, not
  GitHub Enterprise Server: enterprises are "hosted on a dedicated subdomain of
  GHE.com", API at `https://api.<subdomain>.ghe.com`, and "the content on GitHub
  Docs reflects the user experience on GHE.com. Readers should use the 'GitHub
  Enterprise Cloud' version of the site."
  <https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency>.
  So the GHEC rate-limit and API pages apply, not the GHES ones. GHE.com is run
  by GitHub; whether it shares the github.com code path for label creation is
  **not stated**.
- GHES differs only on rate limits (§6): they are admin-configured.

## 5. Labels per repository

- No maximum is stated on the "Repository limits" page (it lists size, directory
  width/depth, branches, push size/rate, open PRs, merge rate, diff, commit
  listing, rebase and account repository limits; no labels)
  <https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits>.
  "Managing labels", the labels REST page and the GraphQL reference list none.
  **Absent from documentation, not documented as unlimited.**
- Documented field limits: label `description` "must be 100 characters or
  fewer" (create and update).
- **Reported**: a per-issue/PR cap of 100 labels, not a per-repository cap
  (actions/labeler PR 497, <https://github.com/actions/labeler/pull/497>).
- Create-then-delete keeps the repository's label count flat, so a ceiling
  would matter only for claims outstanding at once. Label archiving (changelog
  2026-08-27, `archived` flag on Update a label, "Archived labels cannot be
  added to issues or pull requests") is not a delete: it is not documented
  whether an archived label still reserves its name, so the claim design should
  delete, not archive
  (<https://github.blog/changelog/2026-08-27-label-archiving-is-generally-available/>,
  <https://docs.github.com/en/rest/issues/labels#update-a-label>).

## 6. Rate limits and cost

github.com / GHEC (the bmw.ghe.com case uses the GHEC page, same numbers):

- Primary REST: 5,000 requests/hour for an authenticated user (15,000 for a
  GHEC-owned app or `GITHUB_TOKEN` on GHEC). One create and one delete = 2
  requests. Instances sharing one gh user share the bucket.
  <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>;
  <https://docs.github.com/en/enterprise-cloud@latest/rest/using-the-rest-api/rate-limits-for-the-rest-api>.
- Secondary: "Most REST API `POST`, `PATCH`, `PUT`, or `DELETE` requests" cost 5
  points, GraphQL mutations 5 points, against 900 points/minute per REST
  endpoint and 2,000 points/minute for GraphQL. "Some REST API endpoints have a
  different point cost that is not shared publicly." (same page). The point
  cost of label create/delete is not published; assume the 5-point default.
- Secondary, content creation: "no more than 80 content-generating requests
  per minute and no more than 500 content-generating requests per hour…
  Some endpoints have lower content creation limits. Content creation limits
  include actions taken on the GitHub web interface as well as via the REST API
  and GraphQL API." (same page). Whether Create a label counts as
  content-generating is **not documented**. Create a label's `422` is
  documented as "Validation failed, **or the endpoint has been spammed**": a
  `422` with a code other than `already_exists` is therefore not a lost race
  and must not be read as one. Rate-limit responses proper are `403`/`429`.
- "Pause between mutative requests": wait at least one second between
  `POST`/`PATCH`/`PUT`/`DELETE` requests; make requests serially, not
  concurrently.
  <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>.
  Racing creates from several Instances are not covered by that advice.
- GraphQL primary: points by connection count, "the minimum point value of a
  call … is 1"
  (<https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api>).
  A `createLabel` / `deleteLabel` mutation's cost is not tabulated; the `rateLimit
  { cost }` field reports it per call.
- A create refused with `already_exists` is still a request and spends primary
  budget (**reported**: on-par/software-factory issue 3169 "422 already_exists
  burns rate limit", <https://github.com/on-par/software-factory/issues/3169>).
- GHES: "Rate limits are disabled by default for GitHub Enterprise Server";
  site administrators may enable primary and secondary limits and the
  secondary-limit text above applies when enabled.
  <https://docs.github.com/en/enterprise-server@latest/rest/using-the-rest-api/rate-limits-for-the-rest-api>;
  <https://docs.github.com/en/enterprise-server@latest/admin/configuring-settings/configuring-user-applications-for-your-enterprise/configuring-rate-limits>.

Order of magnitude for one claim = 1 create + 1 delete: 2 of 5,000 primary
requests/hour, 10 secondary points. Stated limits give 250 claim cycles/hour
if both calls count against the 500/hour content-creation limit and 2,500 if
only the create counts **[INFERENCE]**; both are above the rate at which one
fleet claims tickets.

## 7. Webhooks and notifications

- **Documented**: the `label` webhook event "occurs when there is activity
  relating to labels", with action types `archived`, `created`, `deleted`,
  `edited`, `unarchived`; a GitHub App needs read access to "Metadata" to
  subscribe. A label create and a label delete each fire one delivery to every
  repository/organization webhook subscribed to `label`.
  <https://docs.github.com/en/webhooks/webhook-events-and-payloads#label>.
- Applying or removing the label on an issue/PR is separate: `issues` /
  `pull_request` `labeled`/`unlabeled` actions, per the same page. Design (b)
  as stated creates the label only.
- Notifications: GitHub documents notifications as updates for activity you are
  subscribed to (conversations, repository activity, CI)
  (<https://docs.github.com/en/subscriptions-and-notifications/concepts/about-notifications>).
  No documented notification trigger for creating or deleting a repository label
  was found. **[INFERENCE]: none**, since a bare label has no thread to
  subscribe to. Not verified.

## 8. What a deleted label leaves in timelines

- **Documented**: "Deleting a label will remove the label from issues and pull
  requests." <https://docs.github.com/en/issues/using-labels-and-milestones-to-track-work/managing-labels#deleting-a-label>.
- **Documented shape of the events**: REST `labeled` and `unlabeled` issue
  events carry `label` with `name` and `color` (an embedded copy, not a
  reference): <https://docs.github.com/en/rest/using-the-rest-api/issue-event-types#labeled>
  and `#unlabeled`; schema in the Issue Events / Timeline pages
  (`label: {name, color}`).
  GraphQL `LabeledEvent.label` and `UnlabeledEvent.label` are declared `Label!`
  (non-null): <https://docs.github.com/en/graphql/reference/issues#labeledevent>.
  Nothing says what a `LabeledEvent` returns once its `Label` row is deleted.
  **[INFERENCE]**: clients selecting `label { name }` through GraphQL may get an
  error or a dropped event for deleted labels; not verified.
- **Undocumented**: whether deletion writes `unlabeled` events. **Reported**
  (one author, 2023, PyGithub): deleting a label creates an `unlabeled` event
  for each *open* issue/PR that carried it and none for closed ones, and
  `labeled` events keep their `label.name`
  (<https://grueter.dev/blog/restore-deleted-github-label/>). One report is
  not an answer.
- For design (b) this matters only if the claim label is also applied to the
  ticket: then each claim leaves a `labeled` (and possibly `unlabeled`) event on
  the issue timeline, one pair per claim. A bare create/delete leaves nothing
  on any issue timeline, since no issue carries the label.

## 9. Can design (b) rely on it?

**No, not on documentation alone.**

- Can rely on (documented): a duplicate create is refused with `422` +
  `already_exists` by contract of the troubleshooting page, which names label
  names as its example; cost per claim is small; `label` webhooks fire.
- Cannot rely on (undocumented): that exactly one of N concurrent creates
  returns `201`; that the loser sees `already_exists` rather than a transient
  error or a second `201`; that the match is case-insensitive; that
  GraphQL `createLabel` refuses the same way; that GHE.com behaves as
  github.com; that a label create is exempt from or subject to the
  content-creation limit.
- If the create is the lock, a silent double `201` would let two Instances work
  one ticket with no signal. The failure is invisible by design, so the gap is
  not one to leave to the first production collision.

### Measurement still needed

Yes. It must run against **bmw.ghe.com** (a scratch repository or a throwaway
name prefix in the consumer repository; maintainer consent needed), not only
github.com, because §4 shows no source ties them. Minimum:

1. 50 rounds × 8 simultaneous `POST /repos/{o}/{r}/labels` (separate
   connections, same name `claim-probe-<round>`, started behind a barrier) from
   two machines or two gh users, recording status and `errors[].code` of each.
   Pass = exactly one `201` and seven `422 already_exists` in every round.
2. The same with case variants (`claim-probe-1` vs `Claim-Probe-1`) in the same
   round, to confirm case-insensitive refusal under the race.
3. The same through GraphQL `createLabel`, recording the error `type`/message
   of the loser.
4. After each round `GET /repos/{o}/{r}/labels?per_page=100` and count names
   matching case-insensitively: exactly 1. Then delete; confirm a second
   `DELETE` returns `404`, to see whether delete is also single-winner.
5. Read `x-ratelimit-used` before/after one create and one delete (cost per
   call), and note any `403`/`429`/`422`-"spammed" during the burst. The burst
   is about 1,000 requests plus cleanup, so pace the rounds (one second apart
   between rounds) to stay inside the documented pause advice.
6. For timelines: one open and one closed issue each carrying a label, delete
   the label, read `GET .../issues/{n}/events` and GraphQL `timelineItems`
   (`LABELED_EVENT`, `UNLABELED_EVENT`), recording what remains.

A pass on 1–2 on bmw.ghe.com is the only evidence that satisfies "a guaranteed
lock". Even then GitHub does not document it, so the design needs a
verification step, e.g. the winner re-reads the label list after its `201` and
yields if two labels of that name exist, as a belt-and-braces check
**[INFERENCE]**.
