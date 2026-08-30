# Member-Name Convention Enforcement

A fleet member's role is one of five canonical name spellings — `impl-<issue#>`,
`fix-pr-<pr#>`, `review-pr-<pr#>`, `finisher-pr-<pr#>`, `merge-bot-<wave#>`. That
convention is stated as prose in `run-team/SKILL.md` and
`references/member-lifecycle.md`, and independently reconstructed by regex in two
runtime modules: `classifyRole` in `compute-spend.mjs` and `parseMemberName` in
`member-outcomes.mjs`.

Two proposals to harden that arrangement have been refused: a **shared exported
constant** the two modules import instead of each carrying its own regex, and
**validation at dispatch time** so an off-convention name is rejected where it is
created rather than classified as `other` downstream.

## Why the shared constant is out of scope

The two modules do not read the same thing, and the constant would have to pretend
they do.

`classifyRole` answers *"is this member a finisher?"* over an `agentType` string
that may also carry a description; `parseMemberName` answers *"which PR does this
member's name book?"* and has to strip a retry suffix first. They accept the same
four finisher spellings today by deliberate agreement, not by sharing a
derivation — and each carries its own comment explaining why the compatibility
spellings stay matched:

```js
// compute-spend.mjs — `finisher-pr-<n>` is the canonical spelling and the only
// one the naming list authorises; `finish-<n>`, `finish-pr-<n>` and
// `finisher-<n>` are spellings earlier runs actually dispatched. Matching those
// is deliberate compatibility with that history, NOT drift to be cleaned up.
```

Collapsing that into one `FINISHER_SPELLINGS` export makes the *list* shared while
leaving the two *matchers* different, which is the half that would actually drift.
It also runs into a failure this repo has measured directly: a `simplify`/`types`
suggestion to dedupe two call sites into a shared helper can reinstate, inside the
vetted module, the exact defect a `survived` finding had just proved in one of
them. A dedupe argument reads clean on its own terms and carries the bug in on the
argument list. Same objection as `.out-of-scope/arg-factory-collapse.md`: a shared
factory is not free when the consumers are only superficially alike.

The finding that raised this argued against itself — *"not worth adding
speculatively before a second spelling-drift incident actually happens"* — and
recorded no defect.

## Why dispatch-time validation is out of scope

The dispatcher is an LLM controller reading a runbook, not a function with a
parameter to type. There is no call site to guard: the name is chosen in prose and
handed to the `Agent` tool, and a name the tool accepts is by definition
dispatchable. Enforcement would have to live in the harness, which this repo does
not own.

What *is* achievable was built instead. PR #969 added prose pins in
`finisher-name-prose.test.mjs` that red when the documents and the module comments
disagree:

- both documents' naming lists are compared as a **set** against all five names,
  so a list that quietly loses one fails
- the names `compute-spend.mjs` claims run-team fixes are **derived from its own
  comment** and required to appear in the runbook's list — a name added to the
  comment alone reds
- `classifyRole` is pinned against all four finisher spellings plus a retry suffix,
  so documenting one canonical name cannot narrow what the classifier accepts

That closes the drift gap the proposal was aimed at, at the seam where drift is
actually observable, without a shared constant.

## What would reopen this

A **second** spelling-drift incident — a fifth finisher spelling appearing on
disk, or `classifyRole` and `parseMemberName` measurably disagreeing about a name
that exists in `docs/metrics/member-outcomes.tsv`. The first such disagreement is
worth naming precisely because of its cost: matching only the canonical spelling
once cost 120 of 283 finisher members their join key to `tier-outcomes.tsv`.

The narrow guard against that — a test asserting the two functions accept the same
spelling set — is tracked as #1072 and is **not** what this record rejects.

## Prior requests

- #976 — "the five canonical member-name spellings live as prose in two docs and as regex in two modules — no shared list, no error at dispatch time" (deferred from PR #969 review, `types` dimension)
