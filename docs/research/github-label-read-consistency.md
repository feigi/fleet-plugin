# Does GitHub show a just-added issue label to every other reader?

Research for `feigi/fleet-plugin` issue #4215, a `wayfinder:research` ticket on
the map "Several fleet Instances on one repository: own work only, never
colliding — any machine, any gh user" (#4212). Claim design (a): each Instance
adds its own claim label, re-reads the issue, and backs off if another
Instance's claim label is there.

Sources read 2026-11-02. Only primary sources were used: GitHub Docs (github.com
and GitHub Enterprise Server 3.22), GitHub engineering blog, GitHub's availability
reports and status page, and GitHub's published source (`cli/cli`, `github/freno`).
No request was made against any GitHub repository to measure behaviour. "Documented"
means a GitHub-owned page states it. "Inference" means I derived it and no page
states it.

## TL;DR

**No. Design (a) cannot rely on it, and GitHub documents no read-after-write
guarantee for labels, on any endpoint, on github.com or GHES.** The REST label
endpoints, GraphQL, and the Enterprise Server docs say nothing about
consistency. GitHub's own engineering posts say the opposite of a guarantee:
reads are served from asynchronously replicated MySQL replicas, replication lag
is normally sub-second but "even those few seconds matter", and GitHub's
mitigation is a heuristic that routes a read to the primary only when it falls
shortly after a *write* ("last write"), with no stated scope across clients.
Incident reports from 2026 show replica detachment and replication delays of up
to an hour, and label updates reaching a derived view (Projects) minutes to
hours late.

What the design needs is narrow: a read that *starts after another client's
write has returned* must see that write. GitHub does not promise it. It would
usually hold, since replica lag is normally small. "Usually" is not the
property design (a) needs, because two Instances racing land in exactly the
window where a lagging replica is wrong.

| Question | Answer | Basis |
|---|---|---|
| Documented read-after-write for add/remove label, REST or GraphQL | **None** | §1 |
| Reads come from replicas that can lag | **Yes** (documented by GitHub engineering, 2016–2021, 2026 incidents) | §2, §5 |
| GitHub routes a read to the primary after a write | **Yes, as a heuristic**, keyed on time since "last write", scope across clients not stated | §3 |
| Same store for REST and GraphQL | **Not documented.** GraphQL is documented as an application layer independent of storage | §4 |
| Search-backed reads (`/search/issues`, `gh issue list --label`/`--search`) | **Asynchronously indexed**; documented as "indexed when created or modified", no latency promised | §6 |
| GHES | Single node and HA read from one primary; cluster mode has replicas, reads' routing not documented | §7 |
| `bmw.ghe.com` | GHE.com is hosted by GitHub, **not GHES**. Its database topology is not published | §7 |
| Removal mirror case | Equally undocumented. But a stale remove-read only costs an extra back-off | §8 |
| Measurement still needed | **Yes** if (a) is pursued. It can refute, never prove | §9 |

## 1. What the documentation promises: nothing about consistency

- The REST labels page describes `POST /repos/{owner}/{repo}/issues/{issue_number}/labels`
  as "Adds labels to an issue" and `DELETE .../labels/{name}` as "Removes the
  specified label from the issue, and returns the remaining labels on the issue".
  Its documented behaviour is additive ("The labels to add to the issue's
  existing labels"), with status codes 200/301/404/410/422. It makes no
  statement on visibility to other readers, ordering, or atomicity under
  concurrent adds.
  <https://docs.github.com/en/rest/issues/labels>
- The same page's `GET .../labels` ("Lists all labels for an issue") has no
  consistency note either. The same text appears in the Enterprise Server 3.22
  edition: <https://docs.github.com/en/enterprise-server@3.22/rest/issues/labels>.
- The REST best-practices page covers polling, conditional requests, rate
  limits and "avoid concurrent requests" (a rate-limit rule, not a consistency
  rule). It does not mention replicas, lag, or stale reads.
  <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>
- The GraphQL overview describes GraphQL as "An application layer. GraphQL is
  not a storage model or a database query language ... The API traverses and
  returns application data based on the schema definitions, independent of how
  the data is stored." No consistency statement.
  <https://docs.github.com/en/graphql/overview/about-the-graphql-api>
- I read the labels, best-practices, search and GraphQL overview pages in full
  or by section and found no consistency, replica, or read-after-write text. I
  did not read every page of docs.github.com, so the claim is limited to the
  pages cited here.

Absence of a documented guarantee means the contract is "none". Anything beyond
that is behaviour a client can observe but GitHub may change.

A client-side hazard also exists. The REST docs show GET responses carrying
`Cache-Control: private, max-age=60, s-maxage=60` (example response for
`GET /repos/octocat/Spoon-Knife/issues`). Any HTTP cache honouring it would serve
a label list up to 60 s old. `gh` does not cache API reads by default, but a
bare HTTP client or a caching proxy might. [The docs show this header as an
example response, not as a promise for the labels endpoints.]
<https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api>

## 2. GitHub serves reads from asynchronous replicas (documented)

- "We run classic MySQL master-replica setups, where writes go to the master,
  and replicas replay master's changes asynchronously. To be able to serve our
  traffic we read data from the MySQL replicas." "There is a nonzero delay
  between the point in time where changes are made visible on a master and the
  time where those changes are visible on some replica or on all replicas.
  This delay is the replication lag." "Serving traffic off of a lagging replica
  leads to poor user experience, as someone may make a change and then not see
  it reflected." (GitHub Engineering, *Mitigating replication lag and reducing
  read load with freno*, 2017-10-13, updated 2019-03-07.)
  <https://github.blog/engineering/infrastructure/mitigating-replication-lag-and-reducing-read-load-with-freno/>
- "Our automation removes lagging replicas from the serving pool after a few
  seconds, but even those few seconds matter: we commonly expect sub-second
  replication lag." (same post). So the design target is sub-second and the
  remediation threshold is seconds. Neither is a guarantee.
- "Issues, Pull Requests, Comments etc." metadata is stored in MySQL ("While
  repository data lies in git, metadata is stored in MySQL. This includes
  Issues, Pull Requests, Comments etc.") and "we use MySQL replication to scale
  out read load". Lag "typically doesn't exceed 1 second. However sometimes lags
  do happen". (GitHub Engineering, *Context aware MySQL pools via HAProxy*,
  2016-08-17.)
  <https://github.blog/engineering/infrastructure/context-aware-mysql-pools-via-haproxy/>
- The same post describes a deliberate availability-over-freshness fallback: if
  fewer than three replicas are healthy, HAProxy switches to a backup pool that
  re-admits lagging replicas ("We'd rather serve stale data than stop serving
  altogether").
- Replicas carry nearly all read traffic. In 2021, the partitioned database
  clusters "combined answer 1,200,000 queries/s on average (1,125,000 queries/s
  on replicas, 75,000 queries/s on the primaries)". (GitHub Engineering,
  *Partitioning GitHub's relational databases to handle scale*.)
  <https://github.blog/engineering/infrastructure/partitioning-githubs-relational-databases-scale/>
- The MySQL 8.0 upgrade post confirms the topology ("Each cluster is configured
  for high availability with a primary plus replicas cluster setup") and that
  production reads were "served via 8.0 replicas".
  <https://github.blog/engineering/infrastructure/upgrading-github-com-to-mysql-8-0/>
- The primary does not wait for replicas. The HA post describes semi-synchronous
  replication (primary does not acknowledge a commit "until the change is known
  to have shipped to one or more replicas") with a 500 ms timeout after which it
  falls back to asynchronous. "Shipped" is receipt, not application: a replica
  that acknowledged can still serve a read before it has replayed the change.
  This is the inference the freno post makes too: semi-sync "doesn't guarantee
  replication lag to be caught up nor be within reasonable margins".
  <https://github.blog/engineering/infrastructure/mysql-high-availability-at-github/>

These posts are 2016–2021. GitHub has since added Vitess-sharded clusters and an
Azure migration (§5), so the *current* routing is not fully published. Nothing
published says the replica read path went away.

## 3. The consistent-read heuristic: real, but scoped to "last write"

The freno post is the only GitHub text on read-your-writes:

> "Reads from the master are typically due to the consistent-read problem: a
> change has been made, and needs to be immediately visible in the next read. If
> the read goes to a replica, it may hit the replica too soon, before the change
> was replayed there."

> "Before `freno`, web and API `GET` requests were routed to the replicas only
> if the last write happened more than five seconds ago. ... Now, upon a `GET`
> request after a write, the app asks `freno` for the maximum replication lag
> across the cluster, and if the reported value is below the elapsed time since
> the last write (up to some granularity), the read is known to be safe and can
> be routed to a replica."

What this does and does not give design (a):

- It shows GitHub *intends* "web and API GET requests" after a write to see that
  write, by sending them to the primary until replication has caught up. That is
  a design intention (2017), not a documented guarantee.
- It keys on "the last write" and says nothing of whose. The post does not say
  whether "last write" is per user, per session, per request chain or per
  repository. **[INFERENCE]** A per-user or per-session mark is the natural
  implementation, and then it protects the writer's own next read, not a second
  user's read. The post cannot settle this.
- Design (a) needs the *other* Instance's write to be visible to *my* read. If
  the mark is per user, that holds only when both Instances use the same gh user
  and not for two different users. If it is per repository, it holds for both.
  Neither is documented. **The same-gh-user case is the more favourable one
  under the natural reading, but it is only an inference.**
- The rule is time-based: a read is routed to a replica when elapsed time since
  the write exceeds measured max lag "(up to some granularity)". It bounds
  staleness by measurement, not by waiting for the write to be applied. The
  freno service reads lag via heartbeats polled by `freno`, "continuously ...
  asynchronously to any app", so a spike between polls is not covered. Its own
  doc says its read-check, "known to be useful, at least in one common
  scenario", lets a client "read from the replicas and safely expect to find
  the data we wrote 2.5s ago on the master" given elapsed time.
  <https://github.com/github/freno/blob/master/doc/http.md>
- The search-indexing path in the same post shows the opposite pattern: jobs
  "wait until we are sure the data was replicated", which "happens in less than
  600ms 95% of the time". That is a measured tail, not a bound.

## 4. Do REST and GraphQL read the same store?

- Documented: GraphQL is "an application layer ... independent of how the data is
  stored" (§1). The REST docs say nothing about the store.
- Both are served by the github.com application. **[INFERENCE]** Both read the
  same issue/label tables through the same models, so they should show the same
  data after the same replication delay. I found no page that states that, or
  that they share the same replica-routing rule. Do not assume that a read-your-writes
  mark set by a REST write covers a GraphQL read (or the reverse).
- GraphQL has one more route that is *not* a direct read: the `search(...)` field,
  which is backed by the search index (§6).

## 5. Replica lag is not hypothetical in 2026

All first-party, all dated:

- **2026-03-03 (availability report, March 2026):** "The increased load caused
  replication delays that cascaded down to all affected services"; ~43% of API
  requests failed.
  <https://github.blog/news-insights/company-news/github-availability-report-march-2026/>
- **2026-09-13 (availability report, September 2026):** a cleanup job "had a
  safeguard designed to slow its writes when database replicas fell behind". The
  safeguard exists because replica lag is a routine operating concern.
  <https://github.blog/news-insights/company-news/github-availability-report-september-2026/>
- **2026-09-23 (status page incident "Incident across several services"):** "Database
  replicas have detached. We're working to restore the database replicas. ...
  degraded experience with the GitHub API and Projects" (10:20 UTC), replicas
  restored 10:57. Later: "Updates to issue labels may be delayed in being
  reflected in Projects by about ~10 minutes ... it'll likely be a few hours to
  complete processing the full backlog of messages" (17:01 UTC). Full recovery
  04:55 UTC on 2026-09-24. Final summary: "delayed label updates and stale search
  results in Projects".
  <https://www.githubstatus.com/> (incident shortlink <https://stspg.io/m1ps7yrhp4n8>),
  also <https://github.com/orgs/community/discussions/208630>.
  This shows a label write *propagating asynchronously to a derived consumer*
  by minutes to hours. It does not show that `GET .../labels` was stale (the
  report only names Projects). It does show that "label written" does not imply
  "label visible everywhere" in GitHub's architecture.
- **2026-10-27 (status page incident "Elevated 404s for GitHub App s2s tokens"):**
  GitHub moved reads of 7 tables to a new MySQL cluster while "the gh-ost tooling
  used in the migration experienced inter-cluster replication delays (up to 1
  hour at peak)". Reads were cut over onto the lagging cluster and records that
  existed were not found (404s). Remediation: "blocking the cutover of reads
  when replication delays are high". This is GitHub itself confirming that reads
  from a replicated cluster can miss rows that exist on the writer, for up to an
  hour in this incident. It concerns installation records, not labels. Stronger
  evidence that the mechanism is real than that labels are affected.
  <https://stspg.io/4z5lmy7gqjk1>
- The September 2026 report states GitHub is moving production to Azure: "Azure
  also handled 65.4% of read traffic for GitHub's core application", with
  "13 of 51 primary MySQL databases" moved by 2026-10-07, and that during a
  planned failover "an automated emergency process disconnected Central US
  database copies". Reads and primaries are therefore split across data centers
  and regions at present. **[INFERENCE]** Cross-region replication lag is
  plausible, and the heuristic's "last write" scope matters more.
- The 2026-08-26 status incident (a database primary failing over to a replica)
  concerns writes, not reads.

Neither the status page nor the availability reports state a normal-case
staleness bound for REST or GraphQL issue reads.

## 6. Search-backed endpoints are explicitly asynchronous

- "GitHub search uses an ElasticSearch cluster to index projects every time a
  change is pushed to GitHub. Issues and pull requests are indexed when they are
  created or modified." No latency is stated.
  <https://docs.github.com/en/search-github/getting-started-with-searching-on-github/about-searching-on-github>
- The REST search page documents only timeouts ("incomplete_results") and rate
  limits (30 requests per minute authenticated for non-code endpoints), not
  freshness. <https://docs.github.com/en/rest/search/search>
- **`gh issue list --label X` is search-backed.** In `cli/cli` (`pkg/cmd/issue/list/list.go`),
  `issueList` calls `searchIssues` whenever `filters.Search != "" || len(filters.Labels) > 0
  || filters.Milestone != "" || filters.IssueType != ""`, and only the unfiltered
  case calls `listIssues`. `searchIssues` issues a GraphQL `search(type: ISSUE ...)`
  (or `ISSUE_ADVANCED`). `listIssues` uses `repository { issues(...) }`, a direct
  read that cannot filter by label.
  <https://raw.githubusercontent.com/cli/cli/trunk/pkg/cmd/issue/list/list.go>,
  <https://raw.githubusercontent.com/cli/cli/trunk/pkg/cmd/issue/list/http.go>
  So anything in fleet that lists "issues carrying claim label X" through `gh issue
  list --label` goes through the search index, and inherits its lag. A direct
  per-issue read (`gh issue view N --json labels`, GraphQL `repository.issue(number:).labels`,
  REST `GET /issues/N/labels`) does not.
- GHES: the instance "reconciles the state of the search index with data on the
  instance automatically and regularly", via repair jobs when "Missing data needs
  to be backfilled", i.e. the index is a separately maintained copy.
  <https://docs.github.com/en/enterprise-server@3.22/admin/administering-your-instance/administering-your-instance-from-the-web-ui/managing-search-indices-for-your-instance>
- The 2026-09-23 incident confirms stale search for Projects ("Users may
  experience stale Project search results while indexing catches up").
- A third-party test or report that search lags is not needed here. The docs say
  the index is updated on modification, which is asynchronous by construction.

Bottom line for the *list* step: a search-backed list can omit a label that a
direct read would show. It is the wrong place to run the "re-read and check"
step. Use a direct per-issue read.

## 7. GitHub Enterprise Server and GHE.com

- **GHES single node and two-node HA:** HA is "active/passive ... replica
  appliances run as a standby with database services running in replication mode
  but application services stopped". Only the primary serves API requests (a
  passive replica "may return 503 (Service Unavailable) for ... web or API
  requests"). **[INFERENCE]** With one active MySQL there is no replica read path
  for API requests, so read-after-write should hold in practice. Not stated as a
  guarantee.
  <https://docs.github.com/en/enterprise-server@3.22/admin/monitoring-and-managing-your-instance/configuring-high-availability/about-high-availability-configuration>
- **GHES geo-replication:** "Web requests are always routed to the primary"; only
  Git and file-server requests are served by active replicas. API (a web
  request) is therefore on the primary.
  <https://docs.github.com/en/enterprise-server@3.22/admin/monitoring-and-managing-your-instance/configuring-high-availability/about-geo-replication>
- **GHES cluster:** "The exceptions to this distribution are the `mysql-server`
  and `redis-server` services, which operate with a single primary node with one
  or more replica nodes." The docs do not say whether web-server reads go to the
  MySQL replicas. Cluster mode is unsettled.
  <https://docs.github.com/en/enterprise-server@3.22/admin/monitoring-and-managing-your-instance/configuring-clustering/about-cluster-nodes>
- **`bmw.ghe.com` is GHE.com (Enterprise Cloud with data residency), not GHES.**
  It is "hosted on a dedicated subdomain of GHE.com", API at `api.<subdomain>.ghe.com`;
  "the content on GitHub Docs reflects the user experience on GHE.com" using the
  "GitHub Enterprise Cloud" docs version. It is a GitHub-operated service, so the
  GHES single-node argument does not apply to it, and GitHub's published
  database topology for it does not exist. **[INFERENCE]** It runs the same
  application with regional database clusters, so §2–§5 apply, but this is not
  documented.
  <https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency>
- I found no GHES release note stating a read-after-write guarantee or a replica
  stale-read caveat for issues/labels. I did not read every release note. The
  only search-related hit was a 3.18.2 fix: audit-log searches "could
  temporarily miss recent events" right after new index creation, unrelated to
  issue labels (<https://docs.github.com/en/enterprise-server@3.18/admin/release-notes>).

## 8. The removal case, and what actually breaks design (a)

Nothing documents removal differently: "returns the remaining labels" is a
description of the response, not a visibility promise. Treat the guarantee as
absent in both directions.

What each direction costs design (a):

- **Add, stale read (the dangerous one).** Instance A adds `claim-A`. B adds
  `claim-B`. Each re-reads. If a read misses the rival's label, that Instance
  proceeds. Both can proceed: a collision. This is the safety property.
- **Remove, stale read (liveness only).** If a read still shows a label that
  was removed, the reader backs off needlessly. No collision, an extra retry.
  So the *removal* direction is harmless for safety, and a design that only
  needs the add direction to be reliable has a smaller dependency.

What the design actually needs from GitHub, if it relies on label reads: for
any two Instances, *a read that starts after the other's add has returned sees
that add*. With that property alone: if A's add returns before B's add returns,
B's read starts after A's add returned and sees `claim-A`, so B backs off. A may
or may not see B. The rule produces zero or one winner, never two (both
back off is possible, so it also needs jitter or a tie-break). GitHub promises
that property nowhere. It also needs `POST .../labels` to be an atomic add (not
read-modify-write of the whole label set). The docs say "add ... to the issue's
existing labels" but make no concurrency claim, so a lost update (A's add
overwritten by B's) is a second undocumented dependency. **[INFERENCE]** On a
relational store this is almost certainly a row insert per label, but it is not
documented.

Other write-side facts from the docs that bear on a probe or on production
claiming: no more than 100 concurrent requests; "no more than 80
content-generating requests per minute and no more than 500 content-generating
requests per hour"; 422 on `POST .../labels` can mean "the endpoint has been
spammed". <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>.

## 9. Is a measurement still needed? Yes, for the usual case only

A measurement is only worth doing if design (a) is still in contention after the
other designs on the map have been weighed, because the best it can show is
"no failure seen", which GitHub's own incident reports say cannot cover incident
windows (replicas detached 2026-09-23, up to an hour of replication delay
2026-10-27).

**What a measurement would take** (do not run it from this ticket):

- A scratch repository on github.com and a scratch repository on the GHE.com
  tenant (separate infrastructure, different answer possible), each with a
  barrier-capable harness (processes started together, synchronised on a
  timestamp).
- At least two gh identities that are *different users* (or one user and one
  GitHub App) in addition to a same-user variant: the heuristic's scope in §3 is
  the open variable.
- One issue per trial (fresh issue, no labels). Per trial, K = 2 and K = 5 claimers
  in separate OS processes (not goroutines of one client, so connections differ),
  each: add own label; on return, immediately read via (1) REST `GET /issues/N/labels`,
  (2) GraphQL `repository.issue.labels`, (3) for comparison, `search(type: ISSUE)`;
  record whether each read shows every other claimer's label whose add had
  *already returned* before the read began (timestamps taken before send and after
  response). Count a trial as a **violation** if a read started after another
  claimer's add returned yet lacked that label.
- Pace to the documented limits: 80 content-generating requests per minute
  across the identity, so roughly 20 trials per minute at K = 2 with add and
  cleanup. Run it on the order of 10^3–10^4 trials per configuration, spread
  over several hours and across day and night.

**What would and would not settle the question:**

- **One violation settles it**: the guarantee does not hold, design (a) fails on
  that endpoint. That finding is cheap and decisive.
- **Zero violations in n trials does not settle it.** At 95% confidence zero in
  n bounds the per-trial violation rate by about 3/n ("rule of three"): 3,000
  clean trials gives "below 0.1%". That is a rate in calm conditions, not a
  guarantee. It says nothing about replica detachment, a primary failover, a
  data-center cutover or the lag windows that §5 documents, which a scratch
  repo run will not hit on demand.
- Separate results are needed per endpoint (REST, GraphQL direct, search) and
  per host (github.com vs GHE.com), and per identity pairing (same user vs
  different users). A pass on one says nothing about the others.

**Recommendation to the map:** design (a) can only ever be "probably safe".
If the map needs "never both claim", it needs a claim primitive whose
atomicity GitHub *does* document (a conditional write that fails for the
loser, for example a ref create rejected when the ref already exists; that
behaviour is itself unverified here). I did not research that: it is another
ticket's question. Whatever the rest of the design, a label read is a hint, not a lock.

## Sources

GitHub Docs
- REST labels: <https://docs.github.com/en/rest/issues/labels>; GHES 3.22: <https://docs.github.com/en/enterprise-server@3.22/rest/issues/labels>
- REST best practices: <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api>
- REST rate limits: <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>
- REST getting started (response headers): <https://docs.github.com/en/rest/using-the-rest-api/getting-started-with-the-rest-api>
- REST search: <https://docs.github.com/en/rest/search/search>
- About searching on GitHub: <https://docs.github.com/en/search-github/getting-started-with-searching-on-github/about-searching-on-github>
- GraphQL overview: <https://docs.github.com/en/graphql/overview/about-the-graphql-api>
- GHES HA / geo-replication / cluster nodes / search indices (3.22): URLs inline in §7 and §6
- GHE.com data residency: <https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency>

GitHub engineering blog and first-party reports
- freno: <https://github.blog/engineering/infrastructure/mitigating-replication-lag-and-reducing-read-load-with-freno/>
- Context aware MySQL pools: <https://github.blog/engineering/infrastructure/context-aware-mysql-pools-via-haproxy/>
- MySQL high availability: <https://github.blog/engineering/infrastructure/mysql-high-availability-at-github/>
- Partitioning relational databases: <https://github.blog/engineering/infrastructure/partitioning-githubs-relational-databases-scale/>
- MySQL 8.0 upgrade: <https://github.blog/engineering/infrastructure/upgrading-github-com-to-mysql-8-0/>
- Availability reports: <https://github.blog/news-insights/company-news/github-availability-report-march-2026/>, <https://github.blog/news-insights/company-news/github-availability-report-september-2026/>
- Status page incidents (API: <https://www.githubstatus.com/api/v2/incidents.json>): <https://stspg.io/m1ps7yrhp4n8>, <https://stspg.io/4z5lmy7gqjk1>; thread <https://github.com/orgs/community/discussions/208630>

GitHub published source
- `github/freno` HTTP doc: <https://github.com/github/freno/blob/master/doc/http.md>
- `cli/cli` `issue list`: <https://raw.githubusercontent.com/cli/cli/trunk/pkg/cmd/issue/list/list.go>, <https://raw.githubusercontent.com/cli/cli/trunk/pkg/cmd/issue/list/http.go>

## Reported, not relied on

A web search for "eventual consistency" and the GitHub API surfaced community
reports (a `rust-lang/highfive` issue about 404s right after a webhook, a
`python/the-knights-who-say-ni` issue titled "Handle GitHub's eventual
consistency for its API"). They are consistent with §2, and none of them is
GitHub's statement. I saw them only as search snippets and did not open them.
