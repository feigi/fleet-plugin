# Which GitHub writes are documented to refuse the loser of a race?

Research for `feigi/fleet-plugin` issue #4227, under the map #4212 ("Several
fleet Instances on one repository: own work only, never colliding — any
machine, any gh user"). Read-only: git's own documentation and source, GitHub's
REST and GraphQL documentation, GitHub's published OpenAPI description and
GraphQL schema, GitHub engineering blog posts; fetched 2026-11-02. **No
request was made against any GitHub repository** (the only network reads were
of documentation, the public `rest-api-description` files and one `git
ls-remote` of `git/git` to pin the source commit). Claims are marked
**documented** (the owner of the source states it), **reported** (a third
party saw it; never the answer), or **[INFERENCE]**.

## TL;DR

**GitHub documents a create-only, atomic, fail-for-the-loser write in exactly
one place: the GraphQL mutation `updateRefs` with `beforeOid` set to the
all-zero object id.** Its reference says "All updates are performed
atomically" and that a `beforeOid` of `0000…0000` "can be used to verify that
the references should not exist". Nothing else on GitHub's side is documented
to compare an expected value and write as one step. The `git push` route
(design (c) as worded: push the claim branch, create-only) rests on git's
documented semantics plus a GitHub engineering post saying GitHub's own ref
transactions check old values under ref locks; it is **not** documented by
GitHub as a guarantee for pushes, and the client-side half of
`--force-with-lease=<ref>:` is only a check against a ref list the client
fetched moments earlier.

| Candidate | What the loser gets | Check+write one atomic step on GitHub's side? | Basis |
|---|---|---|---|
| **GraphQL `updateRefs`, `beforeOid` = zero id** | The whole call is rejected, no ref modified. Error shape **undocumented**; one community report saw HTTP 200 plus a generic "Something went wrong" error | **Documented**: "performed atomically… if one of them is rejected, no other ref will be modified"; zero `beforeOid` = "the references should not exist". No sentence about two *concurrent calls*, but §4 explains why the underlying ref transaction serialises them | §1 |
| `git push --force-with-lease=<ref>:` (create-only) | Client-side: `! [rejected] … (stale info)` if the ref was already in the advertisement. Server-side race: `[remote rejected]` / `remote failure`. Same-oid push = `[up to date]`, exit 0 | **Not documented by GitHub.** git: the server verifies `old-id` after taking the lock. GitHub's Spokes post: ref transactions verify old values under ref locks | §2, §3 |
| REST `POST /git/refs` on an existing ref | `422` (documented: "Validation failed, or the endpoint has been spammed"); `409` also listed. "Reference already exists" message is **reported** only | **Not documented** | §5 |
| REST `PATCH /git/refs/{ref}` without `force` | Refused only if not a fast-forward. **No expected-value parameter exists.** Not a compare-and-swap | n/a: no compare | §6 |
| GraphQL `createRef` | Not documented (no error codes, no uniqueness sentence) | **Not documented** | §5 |
| GraphQL `updateRef` | No `beforeOid`; `force` only | n/a | §6 |
| `PUT /pulls/{n}/merge` with `sha` | `409` "if sha was provided and pull request head did not match" (documented) | **Not documented** | §7 |
| Contents API `sha` | `sha` "Required if you are updating a file"; `409` listed without detail | **Not documented**; docs say concurrent writes "will conflict" only for put-vs-delete | §7 |
| Any issue/PR field (assignee, label, state, body) | No expected-value input anywhere in REST or GraphQL; conditional requests "not supported" for `POST`/`PUT`/`PATCH`/`DELETE` | n/a | §8 |
| Same on github.com and GHE.com? | Yes: REST OpenAPI for `POST/PATCH git/refs` is byte-identical for github.com and GHEC; GraphQL `CreateRefInput`, `RefUpdate`, `UpdateRefsInput` identical; docs pages identical | documented | §9 |
| Ref create read-after-write visible to `git ls-remote` elsewhere? | **Not documented as a contract.** GitHub states the design intent: after the server accepts a ref update "no client should see an older value afterward" | design statement, not an API guarantee | §10 |

**Verdict for design (c).** It may rely on *"a create-only ref write is
refused for the second writer"* only if the write is `updateRefs` with a zero
`beforeOid`; that is the one primitive whose documentation states both the
check and the atomicity. A create-only `git push` is *very likely* equally
safe (§3, §4) but GitHub documents neither that it forwards the old-id as a
precondition nor that two racing pushes yield exactly one winner. Either way
the loser must read the ref back to tell "taken" from every other refusal
(§11).

## 1. GraphQL `updateRefs`: the one documented compare-and-write

- The mutation reference (identical on github.com and GHEC pages): "Creates,
  updates and/or deletes multiple refs in a repository. This mutation takes a
  list of `RefUpdate`s and performs these updates on the repository. All
  updates are performed atomically, meaning that if one of them is rejected,
  no other ref will be modified. `RefUpdate.beforeOid` specifies that the given
  reference needs to point to the given value before performing any updates. A
  value of `0000000000000000000000000000000000000000` can be used to verify
  that the references should not exist. `RefUpdate.afterOid` specifies the
  value that the given reference will point to after performing all updates. …
  If `RefUpdate.force` is set to `true`, a non-fast-forward updates for the
  given reference will be allowed."
  <https://docs.github.com/en/graphql/reference/git#updaterefs> and
  <https://docs.github.com/en/enterprise-cloud@latest/graphql/reference/git>
  (same text); also in the schema SDL
  <https://docs.github.com/public/fpt/schema.docs.graphql> and
  <https://docs.github.com/public/ghec/schema.docs.graphql>
  (`mutation updateRefs`, `input RefUpdate`).
- `RefUpdate` fields: `afterOid: GitObjectID!` ("The value this ref should be
  updated to"), `beforeOid: GitObjectID` ("The value this ref needs to point
  to before the update"), `force: Boolean = false`, `name: GitRefname!` ("The
  fully qualified name of the ref to be update. For example
  `refs/heads/branch-name`"). `UpdateRefsInput` = `refUpdates: [RefUpdate!]!`
  + `repositoryId: ID!`. The payload returns only `clientMutationId`. Same
  SDL files as above.
- So for a claim: `refUpdates: [{name: "refs/heads/<claim>", beforeOid:
  "0000…", afterOid: <commit>, force: false}]`. Note `afterOid` must be a
  commit GitHub already has (the sibling `createRef` says its `oid` "Must
  point to a commit"); the object has to exist in the repository before the
  call. **[INFERENCE]**: creating a commit object without a ref via
  `POST /repos/{o}/{r}/git/commits` (the documented Git Database API) then
  calling `updateRefs` is the way to put the Instance's identity into the
  claim commit; the `updateRefs` docs do not describe this flow.
- **What is not documented** for `updateRefs`: the error shape when
  `beforeOid` does not match; whether two *concurrent* calls are serialised
  (the docs state atomicity of the batch, not isolation between callers); that
  rulesets apply to it. **Reported** (one community post, unanswered): a
  stale-`beforeOid` `updateRefs` returned HTTP 200 with one generic error
  ("Something went wrong while executing your query … Please include <id> when
  reporting this issue"), no `data`, no error type or path; both refs were
  unchanged afterwards; "a rule-blocked pair returned UNPROCESSABLE without
  changing either ref"; the reporter asked how to distinguish a
  stale-precondition rejection from an indeterminate server failure and got
  no answer (<https://github.com/orgs/community/discussions/209699>, Oct
  2026). So the loser cannot tell *why* it lost from the error alone; it must
  read the ref (§11).
- `updateRefs` is part of the standard GraphQL API, reachable on GHE.com at
  that enterprise's API host (see the sibling finding for the host form:
  `https://api.<subdomain>.ghe.com`). Docs for GHEC show the same mutation.

## 2. `git push --force-with-lease=<ref>:` — what git documents

- git-push: "`--force-with-lease=<refname>:<expect>` will protect _<refname>_
  (alone), if it is going to be updated, by requiring its current value to be
  the same as the specified value _<expect>_ … If _<expect>_ is the empty
  string, then the named ref must not already exist." And "all forms other than
  `--force-with-lease=<refname>:<expect>` that specifies the expected current
  value of the ref explicitly are still experimental".
  <https://git-scm.com/docs/git-push#Documentation/git-push.txt---force-with-leaseltrefnamegtltexpectgt>;
  source:
  <https://github.com/git/git/blob/ebdc087dc99d68bb340c282b2ba5f722def28d19/Documentation/git-push.adoc#L265-L271>.
- **Where the check actually runs.** `--force-with-lease=<ref>:` is parsed by
  `parse_push_cas_option` into an empty expected oid (`oidclr`)
  (<https://github.com/git/git/blob/ebdc087dc99d68bb340c282b2ba5f722def28d19/remote.c#L2748-L2753>),
  then `set_ref_status_for_push` compares it to the oid the remote **advertised
  at the start of this push** and marks the ref `REF_STATUS_REJECT_STALE` if
  they differ (`remote.c` L1723-L1725). That is a client-side check against a
  snapshot. It does not itself reach the server.
- **What goes on the wire.** The update command sent is the *advertised* old
  oid, not the lease: `send-pack.c` writes `oid_to_hex(&ref->old_oid)`
  / `new_oid` / name
  (<https://github.com/git/git/blob/ebdc087dc99d68bb340c282b2ba5f722def28d19/send-pack.c#L658-L675>).
  For a ref the client saw as absent, that is the all-zero id: the pack
  protocol's `create = zero-id SP new-id SP name` (`update = old-id SP new-id
  SP name`)
  (<https://github.com/git/git/blob/ebdc087dc99d68bb340c282b2ba5f722def28d19/Documentation/gitprotocol-pack.adoc#L543-L546>).
- **Two silent no-op traps in the client path.**
  1. The same-oid test runs *before* the lease test: if the remote ref already
     equals the new oid, the ref is `REF_STATUS_UPTODATE` and skipped
     (`remote.c` L1704-L1708, before the `expect_old_sha1` branch at L1723).
     `push_had_errors` treats `REF_STATUS_UPTODATE` as not an error
     (`transport.c` L589-L600), so `git push` prints `[up to date]` and exits
     0. **If two Instances push the *same commit* to the same claim branch, the
     loser's push "succeeds" without claiming anything.** The claim commit must
     be unique per Instance (an Instance id/timestamp in the commit).
  2. Without the lease, a plain push to an existing branch is refused only if it
     is not a fast-forward (`git-push`: "Usually, `git push` refuses to update
     a remote ref that is not an ancestor of the local ref", same document
     L235-L236); a descendant commit pushed over an existing claim branch would
     **succeed and steal the claim**. Hence the lease (or a unique,
     non-descending claim commit) is not optional.
- **Status vocabulary the loser sees** (`git push --porcelain`): flag `*` new
  ref, `!` "rejected or failed to push", `=` up to date; reasons `rejected`
  ("Git did not try to send the ref at all"), `remote rejected` ("The remote
  end refused the update"), `remote failure` ("The remote end did not report
  the successful update of the ref, perhaps because of a temporary error…")
  (git-push OUTPUT section,
  <https://github.com/git/git/blob/ebdc087dc99d68bb340c282b2ba5f722def28d19/Documentation/git-push.adoc#L505-L545>).
  `[rejected] (stale info)` is the lease failure message
  (`transport.c` L816-L818). `remote failure` is **indeterminate**: the ref may
  or may not have been created.

## 3. What git's receive-pack does with the old-id (the race window)

- Pack protocol: "The server will receive the packfile, unpack it, then
  validate each reference that is being updated that it hasn't changed while
  the request was being processed (the obj-id is still the same as the
  old-id), and it will run any update hooks … If all of that is fine, the
  server will then update the references."
  <https://github.com/git/git/blob/ebdc087dc99d68bb340c282b2ba5f722def28d19/Documentation/gitprotocol-pack.adoc#L603-L607>.
- Implementation: `receive-pack.c` `update()` takes the command's `old_oid`
  and calls `ref_transaction_update(transaction, name, new_oid, old_oid, …)`
  (L1524, L1675-L1680). The ref-transaction API: `old_oid` "the value that the
  reference must have before the update, or `null_oid` if it must not have
  existed beforehand. The old value is checked after the lock is taken to
  prevent races. If the old value doesn't agree with old_oid, the whole
  transaction fails" (`refs.h` L905-L912, and L818-L822: "`null_oid`, meaning
  that the reference must not exist before the update"). Errors:
  `REF_TRANSACTION_ERROR_CREATE_EXISTS` → "reference already exists",
  `INCORRECT_OLD_VALUE` → "incorrect old value provided", `NAME_CONFLICT` →
  "refname conflict" (`refs.c` L3565-L3585).
  <https://github.com/git/git/blob/ebdc087dc99d68bb340c282b2ba5f722def28d19/refs.h#L905-L912>.
- So in **git's own receive-pack**, two racing creates of one ref name resolve
  under the ref lock: one wins, one is rejected `reference already exists`.
  This is git's documented/implemented behaviour. GitHub does not run stock
  `git receive-pack`; its server code is not public.

## 4. What GitHub says about its own ref updates

- "Stretching Spokes" (GitHub engineering, 2017-10-13): "We use the
  three-phase commit protocol to update the replicas and additionally use the
  replicas as a distributed lock to ensure that the database is updated in the
  correct order." and: "we implemented transactions for Git reference updates
  in the open source Git project (these are exposed, for example, via `git
  update-ref --stdin`) … First Git acquires all necessary local reference
  locks, then it verifies that the old values were as expected and that the new
  values make sense. If everything is OK, the tentative transaction is
  committed; otherwise, it is rolled back in its entirety." It concludes the
  design "improves robustness, speed, and flexibility for both GitHub.com and
  GitHub Enterprise."
  <https://github.blog/2017-10-13-stretching-spokes/>.
- "Building resilience in Spokes" (2016-09-07): "Conflicting writes must be
  serialized … The way Spokes serializes writes is by ensuring that every write
  acquires an exclusive lock on a majority of replicas. It's impossible for two
  writes to acquire a majority at the same time, so Spokes eliminates conflicts
  by eliminating concurrent writes entirely." and "No updates to a repository —
  pushes, renames, edits to a wiki, etc. — are accepted unless a strict
  majority of the replicas can apply the change and get the same result."
  <https://github.blog/engineering/infrastructure/building-resilience-in-spokes/>.
- "The bridge to agent-scale Git infrastructure" (2026-10-21) changes the lock
  scope: "Git's consistency requirements apply to each reference individually
  … With per-reference serialization, only writes that contend on a shared
  reference must wait for each other." Two creates of the *same* claim branch
  contend on one reference and so stay serialised.
  <https://github.blog/engineering/architecture-optimization/the-bridge-to-agent-scale-git-infrastructure/>.
- "Building Git infrastructure for agent-scale development" (2026-10-06):
  "When a push updates a reference, a three-phase commit protocol uses a quorum
  to ensure that CI, the web UI, and API clients see a consistent repository
  state." "The part of a push that truly needs agreement is the reference
  update itself."
  <https://github.blog/engineering/architecture-optimization/building-git-infrastructure-for-agent-scale-development/>.
- Reading these together: **documented** that GitHub's ref updates are
  transactions whose old values are verified after locks are held and that
  conflicting writes to one reference are serialised. **Not documented**: that
  the push protocol's `old-id` is what feeds that old-value check, or what a
  racing create-only push reports to its client. **[INFERENCE, likely]**: it
  does, because GitHub must honour old-id for ordinary non-force pushes to be
  safe; but this is exactly the unverified step.
- These posts describe github.com's Spokes. They do not say whether GHE.com
  (data residency) runs the same code path; the 2017 post only says the design
  also serves "GitHub Enterprise". Treat GHE.com as **same documented
  interface, unconfirmed internals** (§9).

## 5. REST `POST /git/refs` and GraphQL `createRef`

- REST "Create a reference": "Creates a reference for your repository. You are
  unable to create new references for empty repositories, even if the commit
  SHA-1 hash used exists." Body: `ref` ("fully qualified reference … If it
  doesn't start with 'refs' and have at least two slashes, it will be
  rejected"), `sha`. Status codes: `201`, `409` Conflict, `422` "Validation
  failed, or the endpoint has been spammed." No sentence says what happens when
  the ref exists.
  <https://docs.github.com/en/rest/git/refs#create-a-reference>; same in the
  OpenAPI descriptions for github.com and GHEC (`paths["/repos/{owner}/{repo}/git/refs"].post`,
  `info.version` 1.1.4, byte-identical)
  <https://github.com/github/rest-api-description>.
- `422` is the generic validation response; the shared troubleshooting table
  defines `already_exists` as "Another resource has the same value as one of
  your parameters. This can happen in resources that must have some unique key
  (such as label names)" — branches are not named there
  (<https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#validation-failed>,
  cited by the sibling label finding). **Reported** (third party, weak): a
  duplicate branch create yields a `422` whose message is "Reference already
  exists"
  (<https://github.com/ko-508/zenn-content/blob/main/articles/el-github-api-422.md>).
  It is not in GitHub's documentation.
- GraphQL `createRef`: "Create a new Git Ref." `CreateRefInput`: `name`,
  `oid` ("Must point to a commit"), `repositoryId`, `clientMutationId`; returns
  `ref`. No errors, uniqueness rule or concurrency statement.
  <https://docs.github.com/en/graphql/reference/git#createref>.
- Verdict: both are *create* calls that very probably fail on an existing ref,
  but "refuse the second creator" is not stated, the error is not specified,
  and atomicity is not stated. Use `updateRefs` instead; it is the same
  operation with documented semantics.

## 6. Updates without an expected value: `PATCH /git/refs` and `updateRef`

- REST "Update a reference": body `sha` ("The SHA1 value to set this reference
  to") and `force` ("Indicates whether to force the update or to make sure the
  update is a fast-forward update. Leaving this out or setting it to `false`
  will make sure you're not overwriting work."). Codes `200`, `409`, `422`.
  <https://docs.github.com/en/rest/git/refs#update-a-reference>. **There is no
  expected-old-value parameter.** `force: false` is a fast-forward test against
  whatever the ref currently is, not a compare-and-swap. A second claimant whose
  commit descends from the first claimant's succeeds. Unusable as a claim lock.
- GraphQL `updateRef` (`UpdateRefInput`: `clientMutationId`, `force`, `oid`,
  `refId`) has no `beforeOid`/`expectedOid` either. `updateRefs` (§1) is the
  only ref mutation with an expected value.
  <https://docs.github.com/en/graphql/reference/git#updateref>.

## 7. `PUT /pulls/{n}/merge` `sha` and the contents API `sha`

- Merge: body `sha` "SHA that pull request head must match to allow merge."
  Responses: `200` merged, `405` "Method Not Allowed if merge cannot be
  performed", `409` "Conflict if sha was provided and pull request head did not
  match". GraphQL `MergePullRequestInput.expectedHeadOid`: "OID that the pull
  request head ref must match to allow merge; if omitted, no check is
  performed."
  <https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request>;
  <https://docs.github.com/public/fpt/schema.docs.graphql>. So a mismatch is
  refused, but no source says the compare and the merge are one atomic step. It
  guards merging, not claiming; it cannot decide who holds a ticket.
- Contents API "Create or update file contents": `sha` is "**Required if you
  are updating a file**. The blob SHA of the file being replaced." Status codes
  `200`, `201`, `404`, `422`, `409` ("Conflict"). The only concurrency sentence:
  "If you use this endpoint and the 'Delete a file' endpoint in parallel, the
  concurrent requests will conflict and you will receive errors. You must use
  these endpoints serially instead."
  <https://docs.github.com/en/rest/repos/contents#create-or-update-file-contents>.
  The docs do not say what happens when `sha` is omitted for an existing path,
  nor that two creates of one path yield exactly one winner. The write is a
  commit to a branch, so it also moves a ref (§4). Not documented as a lock.
- Both pages are the same on GHEC (the OpenAPI operations differ only in the
  `docs.github.com/enterprise-cloud@latest/…` link prefixes inside the
  description text).

## 8. Conditional writes on issue and PR fields: none

- REST `PATCH /repos/{o}/{r}/issues/{n}` accepts `title`, `body`, `state`,
  `labels`, `assignees`, `milestone`, … and no expected-value field; "Add
  assignees" "Adds up to 10 assignees… Users already assigned to an issue are
  not replaced" (additive, not conditional). `PATCH /pulls/{n}`: `base`, `body`,
  `maintainer_can_modify`, `state`, `title`. GraphQL `UpdateIssueInput` fields
  (`assigneeIds`, `assignees`, `body`, `id`, `issueFieldUpdates`, `issueType`,
  `labelIds`, `labels`, `milestoneId`, `projectIds`, …) and
  `AddAssigneesToAssignableInput` also have none. I searched the full github.com
  OpenAPI description and GraphQL schema for `If-Match`, `expected…`,
  `previous…`, `old…`, `compare-and-swap` and found only
  `MergePullRequestInput.expectedHeadOid` (§7), `CreateCommitOnBranchInput.expectedHeadOid`
  ("The git commit oid expected at the head of the branch prior to the
  commit"), `EnablePullRequestAutoMergeInput.expectedHeadOid`,
  `EnqueuePullRequestInput.expectedHeadOid`,
  `UpdatePullRequestBranchInput.expectedHeadOid` and `RefUpdate.beforeOid`.
  <https://github.com/github/rest-api-description> and
  <https://docs.github.com/public/fpt/schema.docs.graphql>.
- Conditional HTTP: "Most endpoints return an `etag` header… You can use the
  values of these headers to make conditional `GET` requests." and "Conditional
  requests for unsafe methods, such as `POST`, `PUT`, `PATCH`, and `DELETE` are
  not supported unless otherwise noted in the documentation for a specific
  endpoint." <https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests>.
  No endpoint searched notes otherwise for issue/PR fields.
- Consequence: an assignee- or label-based claim stays a write-then-read
  design (see the sibling findings on
  [label read consistency](https://github.com/feigi/fleet-plugin/blob/research/github-label-read-consistency/docs/research/github-label-read-consistency.md)
  and
  [label name uniqueness](https://github.com/feigi/fleet-plugin/blob/research/github-label-name-uniqueness/docs/research/github-label-name-uniqueness.md)).

## 9. github.com versus GHE.com (bmw.ghe.com)

- bmw.ghe.com is GitHub Enterprise Cloud with data residency, not GHES (see the
  sibling label finding, §4, citing
  <https://docs.github.com/en/enterprise-cloud@latest/admin/data-residency/about-github-enterprise-cloud-with-data-residency>).
  The GHEC documentation is the relevant one.
- Verified identical between github.com and GHEC: REST `POST git/refs` and
  `PATCH git/refs/{ref}` operation objects (byte-identical), `merge` and
  `contents` operations (identical apart from link prefixes), GraphQL
  `CreateRefInput`, `RefUpdate`, `UpdateRefsInput` and the `updateRefs`
  description; both OpenAPI descriptions at `info.version` 1.1.4
  (`descriptions/api.github.com/api.github.com.json`,
  `descriptions/ghec/ghec.2022-11-28.json`). The Git-references REST page shows
  `X-GitHub-Api-Version: 2026-03-10` as current.
- Not documented for either platform: any race or atomicity statement beyond §1.
  Whether GHE.com shares github.com's Spokes ref-update path is **not stated**
  by GitHub; the engineering posts discuss github.com (and, in 2017, GitHub
  Enterprise generally).

## 10. Is a ref create visible to `git ls-remote` from another client?

- No documentation promises read-after-write for refs to Git clients. What GitHub
  states, as design intent:
  - "Once the server accepts an update to a reference, no client should see an
    older value afterward, only that value or a newer one. That holds whether
    the update is a fast-forward, a force push, or a delete." (bridge post,
    2026-10-21). For a newly created ref the "older value" is "does not exist";
    the sentence does not spell out creates.
  - "When a push updates a reference, a three-phase commit protocol uses a
    quorum to ensure that CI, the web UI, and API clients see a consistent
    repository state." (2026-10-06).
  - Reads "can be served from any replica" (DGit, 2016-04-05,
    <https://github.blog/engineering/architecture-optimization/introducing-dgit/>)
    while writes commit on a majority; replicas that fail to apply a write are
    "marked as unhealthy — unavailable for reads or writes — until they can be
    repaired" (Spokes 2016). Together: a replica that lacks a committed write
    is meant not to serve reads; this is the *mechanism* behind the intent, not
    an SLA.
- These are blog statements about architecture, not API contracts, and they say
  nothing about GHE.com. Treat "create, then immediately `git ls-remote` from a
  second machine shows it" as **expected, not guaranteed**. The design should
  never depend on it: a refused create already proves the ref exists (§11).

## 11. Refusals that are not "taken", and what the loser must check

Documented causes that can refuse a create for a ref that did **not** already
exist:

| Cause | Source |
|---|---|
| Ruleset **Restrict creations**: "only users with bypass permissions can create branches or tags whose name matches the pattern you specify" | <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#restrict-creations> (identical on the enterprise-cloud page) |
| Ruleset **Metadata restrictions** (Enterprise plans): "control the format of new branch names and tag names"; the push is rejected with a message "telling you the pattern" | same page, #metadata-restrictions; <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/troubleshooting-rules> |
| **Required status checks** ruleset: "Optionally, you can select 'Do not require status checks on creation' if you wish to allow branch creation regardless of the status check result" — so a required-checks rule can gate branch *creation* unless that option is set | same rules page, "Require status checks to pass before merging" |
| Push rulesets: max 1000 ref updates per push; file path, size, extension limits apply to pushes and to the blobs/trees/contents endpoints | troubleshooting-rules page above |
| Ref name conflicts: a ref whose name is a path prefix of an existing ref (or the reverse), e.g. `claim/12` exists so `claim` cannot be created; git refuses as "refname conflict" | `refs.c` L3565-L3585 (git); not GitHub-documented |
| Invalid ref name: REST create "If it doesn't start with 'refs' and have at least two slashes, it will be rejected" | create-ref docs, §5 |
| Empty repository (REST: "You are unable to create new references for empty repositories"); `422` is also "Validation failed, or the endpoint has been spammed" | create-ref docs, §5 |
| Missing permission or access: the create-ref docs list only `201`/`409`/`422`, so the status for a token without write access is **undocumented there** (by pattern `403`/`404` elsewhere in the REST docs) | §5 |
| Indeterminate failures: `remote failure` (push), generic GraphQL error (`updateRefs`), network loss | §2, §1 |

How a ruleset refusal looks is only partly documented. GitHub's migration
troubleshooting page quotes `GH013: Repository rule violations found for
refs/heads/main`
(<https://docs.github.com/en/migrations/using-github-enterprise-importer/completing-your-migration-with-github-enterprise-importer/troubleshooting-your-migration-with-github-enterprise-importer>);
**reported** that a rule-blocked `updateRefs` returns `UNPROCESSABLE` (§1).
Neither says anything about whether a "ref already exists" refusal is worded
differently, so **error text must not be the discriminator.**

**Rule for the loser.** On any refusal or any non-success status (including
`remote failure`, a generic GraphQL error, a timeout), do not infer "taken"
from the text. Read the ref back:

1. `git ls-remote origin refs/heads/<claim-branch>` (or REST `GET
   /git/ref/heads/<claim-branch>`, or GraphQL `repository.ref`). The read must
   be one the Instance did not already issue before the failed write.
2. **Ref exists** and its tip commit is the Instance's own unique claim commit
   (Instance id in the commit message or trailer): the write actually landed
   (a lost response, or a retry). Treat as **won**.
3. **Ref exists**, tip is someone else's: **taken**. Do not retry; pick another
   ticket.
4. **Ref absent**: the refusal was for another reason (ruleset, permission,
   name conflict, rate limit, or a write that lost its quorum). **Not taken.**
   Report it as a hard failure; retrying the create is safe (it is create-only)
   but do not loop on a deterministic rule refusal. After an indeterminate
   failure ("remote failure", generic error) wait and re-read once more before
   concluding the claim did not land, since an in-flight write's fate is
   undocumented (**[INFERENCE]**: Spokes either commits or reverts a write on a
   majority, so absence on a later read means it did not commit, but GitHub does
   not document how long "later" is).
5. If the refusal said "exists" (or `already_exists`/`reference already exists`)
   but the read shows absent, trust the refusal and re-read after a short wait:
   a stale read is the only documented-intent violation here (§10).

Two lifecycle caveats for design (c):

- A claim branch is a lock only while it exists. Deleting it releases the claim
  and the next create wins. GitHub can delete a PR's head branch automatically
  on merge ("Automatically delete head branches", a repository setting that
  admins can enable or disable): <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches>.
  Where a merged claim PR deletes its branch, "has a claim branch" is no longer
  proof a ticket is unclaimed or finished; the claim record has to be the
  ticket state too.
- Repository limits: "Number of branches: 5,000" is a recommended maximum
  ("we recommend staying within the following…"), "Push rate: recommended 6
  pushes per minute per repository"
  (<https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits>).
  Many Instances each pushing claim branches at claim time are far below these
  at the scale of a fleet but they are documented limits.

## 12. Can design (c) rely on it?

**Yes for the claim being exclusive, on one condition about the write used;
no for treating the refusal text or the instant visibility as guarantees.**

- Use GraphQL `updateRefs` with `beforeOid` zero for the claim write: it is the
  only documented create-only write with a stated atomic check. Make the claim
  commit unique per Instance (commit created first via the Git database API,
  **[INFERENCE]** that a ref-less commit is a valid `afterOid`).
- A create-only `git push --force-with-lease=<ref>:` is a reasonable
  *implementation* of the same thing only if the claim commit is unique
  (otherwise the same-oid `[up to date]` trap makes the loser think it won, §2)
  and only on the understanding that GitHub does not document that the server
  honours the old-id atomically. The pieces (git semantics §3, GitHub's
  old-values-under-lock statement §4) point to "yes", but there is no single
  GitHub sentence to cite.
- Loser protocol: read back and decide per §11, never from error text.

## 13. Is a measurement still needed?

Yes, one small one, on bmw.ghe.com, before the map's decision rests on it. The
documentation settles *what is promised*; it does not settle *what the loser
sees* or that GHE.com behaves as github.com's posts describe:

1. N parallel `updateRefs` creates of one ref name with a zero `beforeOid`:
   exactly one succeeds, the rest fail with no ref written; record the loser's
   error shape (does it differ from a ruleset-blocked create?).
2. N parallel `git push --force-with-lease=<ref>:` of **distinct** commits to
   one ref name: exactly one `*` new ref; losers' status lines and exit codes
   (`stale info` versus `remote rejected` versus `remote failure`).
3. The same push with an **identical** commit from two clones: confirm the
   `[up to date]` exit 0.
4. After a successful create on clone A, `git ls-remote` from clone B on another
   machine immediately, repeatedly: any miss.
5. A repository with a "Restrict creations" ruleset: the refusal text for push
   and for `updateRefs`.

No measurement is needed to rule out `PATCH /git/refs`, `PUT /merge` `sha`, the
contents `sha`, and issue/PR fields: they have no create-only/expected-value
compare that fits a claim.

## Sources

Primary, all fetched 2026-11-02:

- git, pinned at `ebdc087dc99d68bb340c282b2ba5f722def28d19` (master at fetch):
  `Documentation/git-push.adoc`, `Documentation/gitprotocol-pack.adoc`,
  `Documentation/gitprotocol-capabilities.adoc`, `remote.c`, `send-pack.c`,
  `transport.c`, `builtin/receive-pack.c`, `refs.h`, `refs.c`.
  <https://github.com/git/git/tree/ebdc087dc99d68bb340c282b2ba5f722def28d19>
- GitHub Docs: REST git refs, pulls, contents, troubleshooting, best practices;
  GraphQL reference "Git"; available rules for rulesets, troubleshooting rules,
  repository limits, managing automatic deletion of branches; GHE.com
  data-residency overview.
- <https://github.com/github/rest-api-description>:
  `descriptions/api.github.com/api.github.com.json`,
  `descriptions/ghec/ghec.2022-11-28.json` (both `info.version` 1.1.4).
- GraphQL schema SDL:
  <https://docs.github.com/public/fpt/schema.docs.graphql>,
  <https://docs.github.com/public/ghec/schema.docs.graphql>.
- GitHub engineering blog: Introducing DGit (2016-04-05), Building resilience
  in Spokes (2016-09-07), Stretching Spokes (2017-10-13), Building Git
  infrastructure for agent-scale development (2026-10-06), The bridge to
  agent-scale Git infrastructure (2026-10-21).

Reported (never the answer):

- Stale-`beforeOid` `updateRefs` generic error and rule-blocked `UNPROCESSABLE`:
  <https://github.com/orgs/community/discussions/209699>.
- "Reference already exists" message on a duplicate branch create:
  <https://github.com/ko-508/zenn-content/blob/main/articles/el-github-api-422.md>.
